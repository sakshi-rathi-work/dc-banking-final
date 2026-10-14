// tests/integration/phase2.test.js: Phase 2 Client-Server RPC Integration Tests
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const { callRpc } = require('../../src/shared/rpc/client');
const { createMeta, appendTrace } = require('../../src/shared/rpc/meta');
const { RpcError, ERROR_CODES } = require('../../src/contracts/errors');

describe('Phase 2: Client-Server RPC, Gateway, and Distributed Tracing', () => {
  const coordinatorUrl = 'http://localhost:8080';
  const nodeA = 'http://localhost:3001';
  const nodeB = 'http://localhost:3002';

  let testAccountId = null;

  before(async () => {
    // Ensure clean faults on node A and node B
    await callRpc(nodeA, 'cluster.clearFaults', {});
    await callRpc(nodeB, 'cluster.clearFaults', {});

    // Create a dedicated test account on primary node A via coordinator
    const res = await callRpc(coordinatorUrl, 'bank.createAccount', {
      holderName: 'Phase 2 Test User',
      openingDeposit: '1000.00',
      idempotencyKey: `idem-p2-init-${Date.now()}`
    });
    assert.ok(res.accountId);
    testAccountId = res.accountId;
  });

  after(async () => {
    // Ensure faults are cleared after tests
    await callRpc(nodeA, 'cluster.clearFaults', {}).catch(() => {});
  });

  it('verifies CLI -> coordinator -> node-a trace events originate in all three services', async () => {
    const meta = createMeta({ from: 'cli' });
    appendTrace(meta, 'cli -> coordinator (bank.deposit)', 0, 'cli');

    const depositKey = `idem-p2-trace-${Date.now()}`;
    const result = await callRpc(coordinatorUrl, 'bank.deposit', {
      accountId: testAccountId,
      amount: '250.00',
      idempotencyKey: depositKey,
      _meta: meta
    }, { timeoutMs: 15000 });

    assert.equal(result.status, 'COMMITTED');
    assert.ok(result._meta, 'Response must include _meta');
    assert.ok(Array.isArray(result._meta.trace), 'Trace must be an array');

    // Extract all unique node identities from trace
    const nodesInTrace = new Set(result._meta.trace.map(t => t.node));

    // Must show events from all three services: cli, coordinator, node-a
    assert.ok(nodesInTrace.has('cli'), 'Trace must include cli events');
    assert.ok(nodesInTrace.has('coordinator'), 'Trace must include coordinator events');
    assert.ok(nodesInTrace.has('node-a'), 'Trace must include node-a events');

    // Verify key trace events
    const events = result._meta.trace.map(t => t.event);
    assert.ok(events.some(e => e.includes('forwarding -> node-a')), 'Trace must include coordinator forwarding');
    assert.ok(events.some(e => e.includes('db.commit')), 'Trace must include node-a db.commit');
    assert.ok(events.some(e => e.includes('received_reply <- node-a')), 'Trace must include coordinator receiving reply');
  });

  it('rejects invalid parameters with -32602 before reaching database', async () => {
    // 1. Invalid account ID format
    let failedBadId = false;
    try {
      await callRpc(coordinatorUrl, 'bank.deposit', {
        accountId: 'INVALID_ID_FORMAT',
        amount: '100.00',
        idempotencyKey: `idem-p2-bad-${Date.now()}`
      });
    } catch (err) {
      failedBadId = true;
      assert.equal(err instanceof RpcError, true);
      assert.equal(err.code, ERROR_CODES.INVALID_PARAMS);
      assert.ok(err.message.includes('Invalid accountId'));
    }
    assert.ok(failedBadId, 'Must reject invalid account ID format');

    // 2. Negative amount
    let failedNegative = false;
    try {
      await callRpc(coordinatorUrl, 'bank.deposit', {
        accountId: testAccountId,
        amount: '-50.00',
        idempotencyKey: `idem-p2-neg-${Date.now()}`
      });
    } catch (err) {
      failedNegative = true;
      assert.equal(err instanceof RpcError, true);
      assert.equal(err.code, ERROR_CODES.INVALID_PARAMS);
      assert.ok(err.message.includes('positive decimal'));
    }
    assert.ok(failedNegative, 'Must reject negative amount with -32602');

    // 3. More than 2 decimal places
    let failedDecimals = false;
    try {
      await callRpc(coordinatorUrl, 'bank.withdraw', {
        accountId: testAccountId,
        amount: '10.555',
        idempotencyKey: `idem-p2-dec-${Date.now()}`
      });
    } catch (err) {
      failedDecimals = true;
      assert.equal(err instanceof RpcError, true);
      assert.equal(err.code, ERROR_CODES.INVALID_PARAMS);
    }
    assert.ok(failedDecimals, 'Must reject invalid decimal places with -32602');
  });

  it('rejects mutating write sent to non-primary node B with NOT_PRIMARY and leaderHint', async () => {
    let failed = false;
    try {
      await callRpc(nodeB, 'bank.deposit', {
        accountId: testAccountId,
        amount: '100.00',
        idempotencyKey: `idem-p2-node-b-${Date.now()}`
      });
    } catch (err) {
      failed = true;
      assert.equal(err instanceof RpcError, true);
      assert.equal(err.code, ERROR_CODES.NOT_PRIMARY);
      assert.equal(err.data.leaderHint, 'a', 'Leader hint must point to node a');
      assert.equal(err.data.epoch, 1);
    }
    assert.ok(failed, 'Direct mutating call to node B must fail with NOT_PRIMARY');
  });

  it('injecting rpcDelayMs = 2500 triggers coordinator RPC timeout and automatic idempotent retry', async () => {
    // Balance before test
    const balBefore = await callRpc(coordinatorUrl, 'bank.getBalance', { accountId: testAccountId });
    const initialBalance = parseFloat(balBefore.balance);

    // 1. Inject fault: 2500ms delay on node A for bank.* calls
    await callRpc(nodeA, 'cluster.setFault', { knob: 'rpcDelayMs', value: 2500 });

    // Verify fault is set
    const faults = await callRpc(nodeA, 'cluster.getFaults', {});
    assert.equal(faults.faults.rpcDelayMs, 2500);

    // 2. Schedule fault clear after coordinator's first attempt times out (2000ms < 2100ms)
    setTimeout(async () => {
      try {
        await callRpc(nodeA, 'cluster.clearFaults', {});
      } catch (e) {
        // Ignore
      }
    }, 2100);

    // 3. Send deposit with 15s client timeout
    const depositKey = `idem-p2-timeout-retry-${Date.now()}`;
    const t0 = Date.now();
    const result = await callRpc(coordinatorUrl, 'bank.deposit', {
      accountId: testAccountId,
      amount: '300.00',
      idempotencyKey: depositKey
    }, { timeoutMs: 15000 });
    const elapsed = Date.now() - t0;

    // Elapsed time must exceed coordinator timeout (2000ms)
    assert.ok(elapsed >= 2000, `Elapsed time (${elapsed}ms) must be >= 2000ms due to timeout & retry`);
    assert.equal(result.status, 'COMMITTED');

    // Verify trace includes coordinator timeout and retry
    const traceEvents = result._meta.trace.map(t => t.event);
    assert.ok(
      traceEvents.some(e => e.includes('timeout <- node-a')),
      'Trace must include coordinator timeout waiting for node-a'
    );
    assert.ok(
      traceEvents.some(e => e.includes('retry_attempt_1')),
      'Trace must include coordinator retry attempt 1'
    );

    // Verify bank balance was credited exactly once (no duplicate credit)
    const balAfter = await callRpc(coordinatorUrl, 'bank.getBalance', { accountId: testAccountId });
    const expectedBalance = (initialBalance + 300.00).toFixed(2);
    assert.equal(balAfter.balance, expectedBalance, 'Balance must be credited exactly once');
  });

  it('runs non-interactive CLI commands directly and via docker', () => {
    // CLI deposit on host
    const cliOutput = execSync(
      `node src/cli/index.js rpc deposit ${testAccountId} 50.00`,
      { encoding: 'utf-8' }
    );
    assert.ok(cliOutput.includes('COMMITTED'), 'CLI output must show COMMITTED');
    assert.ok(cliOutput.includes('cli -> coordinator'), 'CLI output must show trace');

    // CLI balance check
    const balOutput = execSync(
      `node src/cli/index.js rpc balance ${testAccountId}`,
      { encoding: 'utf-8' }
    );
    assert.ok(balOutput.includes(testAccountId), 'CLI balance must show account ID');

    // CLI direct node mode to node B should exit with code 1 (NOT_PRIMARY)
    let cliFailed = false;
    try {
      execSync(`node src/cli/index.js rpc --node=b deposit ${testAccountId} 10.00`, {
        encoding: 'utf-8',
        stdio: 'pipe'
      });
    } catch (err) {
      cliFailed = true;
      const combinedOutput = (err.stdout || '') + (err.stderr || '');
      assert.ok(combinedOutput.includes('ERROR -32005'), 'CLI must print ERROR -32005');
      assert.ok(combinedOutput.includes('Node b is not primary'), 'CLI must print not primary');
    }
    assert.ok(cliFailed, 'Direct write to node B via CLI must fail');
  });

  it('verifies banking invariants I1-I12 pass on primary node A', async () => {
    const invRes = await callRpc(nodeA, 'admin.verifyInvariants', {});
    assert.equal(invRes.pass, true, 'All banking invariants must pass');
    assert.equal(invRes.nodeId, 'a');
  });
});
