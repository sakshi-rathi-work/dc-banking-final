// tests/integration/phase3.test.js: Phase 3 Multithreading Integration Tests (Experiment 2)
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { callRpc } = require('../../src/shared/rpc/client');
const { RpcError, ERROR_CODES } = require('../../src/contracts/errors');

describe('Phase 3: Multithreading and Concurrency (worker_threads)', () => {
  const coordinatorUrl = 'http://localhost:8080';
  const nodeA = 'http://localhost:3001';
  const nodeB = 'http://localhost:3002';

  before(async () => {
    await callRpc(nodeA, 'cluster.clearFaults', {}).catch(() => {});
    await callRpc(nodeB, 'cluster.clearFaults', {}).catch(() => {});
  });

  after(async () => {
    await callRpc(nodeA, 'cluster.clearFaults', {}).catch(() => {});
  });

  it('rejects worker.runBatch on non-primary node B with NOT_PRIMARY', async () => {
    let failed = false;
    try {
      await callRpc(nodeB, 'worker.runBatch', { scenario: 'parallel-withdrawals' });
    } catch (err) {
      failed = true;
      assert.equal(err instanceof RpcError, true);
      assert.equal(err.code, ERROR_CODES.NOT_PRIMARY);
      assert.equal(err.data.leaderHint, 'a');
    }
    assert.ok(failed, 'worker.runBatch on non-primary node B must fail');
  });

  it('parallel-withdrawals: 4 workers withdraw simultaneously with distinct threads and PIDs', async () => {
    const res = await callRpc(nodeA, 'worker.runBatch', {
      scenario: 'parallel-withdrawals'
    }, { timeoutMs: 30000 });

    assert.equal(res.summary.requests, 4);
    assert.equal(res.summary.succeeded, 4);
    assert.equal(res.summary.rejected, 0);
    assert.equal(res.summary.failed, 0);
    assert.equal(res.actualFinalBalance, '2000.00');

    // Evidence of real multithreading:
    const threadIds = new Set(res.tasks.map(t => t.threadId));
    const pgPids = new Set(res.tasks.map(t => t.pgPid));

    assert.equal(threadIds.size, 4, 'Must report 4 distinct thread IDs');
    assert.equal(pgPids.size, 4, 'Must report 4 distinct PostgreSQL backend PIDs');

    // Evidence of overlapping intervals
    const starts = res.tasks.map(t => t.tStartNs);
    const ends = res.tasks.map(t => t.tEndNs);
    const maxStart = Math.max(...starts);
    const minEnd = Math.min(...ends);

    // Because tasks start simultaneously via the barrier, maxStart is well before the last task finishes
    assert.ok(maxStart < Math.max(...ends), 'Execution intervals must overlap across worker threads');
    assert.equal(res.invariants.pass, true, 'All banking invariants must pass');
  });

  it('conflicting-withdrawals: exactly 1 succeeds and 1 rejected consistently', async () => {
    for (let run = 0; run < 5; run++) {
      const res = await callRpc(nodeA, 'worker.runBatch', {
        scenario: 'conflicting-withdrawals'
      }, { timeoutMs: 30000 });

      assert.equal(res.summary.requests, 2);
      assert.equal(res.summary.succeeded, 1, 'Exactly 1 withdrawal must succeed');
      assert.equal(res.summary.rejected, 1, 'Exactly 1 withdrawal must be rejected');
      assert.equal(res.actualFinalBalance, '1000.00', 'Final balance must be exactly ₹1,000.00');

      const comm = res.tasks.find(t => t.status === 'COMMITTED');
      const rej = res.tasks.find(t => t.status === 'REJECTED');

      assert.ok(comm, 'Must have a COMMITTED task');
      assert.ok(rej, 'Must have a REJECTED task');
      assert.equal(rej.errorCode, ERROR_CODES.INSUFFICIENT_FUNDS);
      assert.equal(res.invariants.pass, true);
    }
  });

  it('proves row-lock contention via holdAfterLockMs', async () => {
    const holdMs = 150;
    const res = await callRpc(nodeA, 'worker.runBatch', {
      scenario: 'conflicting-withdrawals',
      holdAfterLockMs: holdMs
    }, { timeoutMs: 30000 });

    const loser = res.tasks.find(t => t.status === 'REJECTED');
    assert.ok(loser, 'Must have a rejected task that waited on the row lock');
    assert.ok(
      loser.lockWaitMs >= holdMs - 20,
      `Loser lockWaitMs (${loser.lockWaitMs}ms) must reflect holdAfterLockMs (${holdMs}ms)`
    );
  });

  it('duplicate-flood: 10 concurrent tasks with same idempotency key execute once and replay 9 duplicates', async () => {
    const res = await callRpc(nodeA, 'worker.runBatch', {
      scenario: 'duplicate-flood'
    }, { timeoutMs: 30000 });

    assert.equal(res.summary.requests, 10);
    assert.equal(res.summary.succeeded, 10);
    assert.equal(res.actualFinalBalance, '9000.00', 'Only one debit of ₹1,000 must occur');

    const uniqueEffects = res.tasks.filter(t => t.duplicate === false);
    const replayedDuplicates = res.tasks.filter(t => t.duplicate === true);

    assert.equal(uniqueEffects.length, 1, 'Exactly 1 task must produce a new effect');
    assert.equal(replayedDuplicates.length, 9, 'Exactly 9 tasks must be duplicate replays');
    assert.equal(res.invariants.pass, true);
  });

  it('worker-crash: crashed worker rolls back open transaction cleanly and retries safely', async () => {
    const res = await callRpc(nodeA, 'worker.runBatch', {
      scenario: 'worker-crash'
    }, { timeoutMs: 30000 });

    assert.equal(res.summary.requests, 4);
    assert.equal(res.summary.succeeded, 4);
    assert.equal(res.actualFinalBalance, '2000.00', 'Final balance must be ₹2,000 without lost or phantom debits');

    // The crashed task was executed and committed by the replacement worker
    const retriedTask = res.tasks.find(t => t.taskId === 'task-0');
    assert.ok(retriedTask, 'Retried task must be present');
    assert.equal(retriedTask.status, 'COMMITTED');
    assert.equal(res.invariants.pass, true);
  });

  it('stress test: dynamically distributed operations conserve total money and pass invariants', async () => {
    const res = await callRpc(nodeA, 'worker.runBatch', {
      scenario: 'stress',
      requests: 60,
      workers: 4
    }, { timeoutMs: 30000 });

    assert.equal(res.summary.requests, 60);
    assert.ok(res.summary.succeeded > 0);
    assert.equal(res.invariants.pass, true, 'Invariants must pass under stress load');

    // Verify money conservation: sum of balances = initial (₹40,000) + net changes
    const totalBalances = parseFloat(res.invariants.checks.I9_moneyConservation.totalBalances);
    const totalDeposits = parseFloat(res.invariants.checks.I9_moneyConservation.totalDeposits);
    const totalWithdrawals = parseFloat(res.invariants.checks.I9_moneyConservation.totalWithdrawals);

    const diff = Math.abs(totalBalances - (totalDeposits - totalWithdrawals));
    assert.ok(diff < 0.01, `Money conservation violated: ${totalBalances} != ${totalDeposits} - ${totalWithdrawals}`);
  });

  it('worker.getActivity reports live pool statistics', async () => {
    const act = await callRpc(nodeA, 'worker.getActivity', {});
    assert.equal(act.nodeId, 'a');
    assert.ok(act.poolSize >= 4);
    assert.ok(Array.isArray(act.activeWorkers));
    assert.ok(act.activeWorkers.length >= 4);
    assert.ok(act.totalTasksExecuted > 0, 'Must record executed tasks');
  });
});
