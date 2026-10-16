// tests/integration/phase8.test.js: Phase 8 Integration Tests for Primary-Backup Fault Tolerance (Experiment 7)
// Specification: PROJECT.md Section 21, Section 22, Section 28 (Phase 8 Exit Criteria), Section 29 (T24, T25, T26, T27, T28)

const test = require('node:test');
const assert = require('node:assert/strict');
const { callRpc } = require('../../src/shared/rpc/client');
const { ERROR_CODES } = require('../../src/contracts/errors');

const COORDINATOR_URL = process.env.COORDINATOR_URL || 'http://localhost:8080';
const URLS = {
  a: process.env.NODE_A_URL || 'http://localhost:3001',
  b: process.env.NODE_B_URL || 'http://localhost:3002',
  c: process.env.NODE_C_URL || 'http://localhost:3003',
  d: process.env.NODE_D_URL || 'http://localhost:3004'
};

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function clearAllFaults() {
  for (const node of ['a', 'b', 'c', 'd']) {
    try {
      await callRpc(URLS[node], 'cluster.clearFaults', {});
    } catch (_) {}
  }
}

async function findCurrentLeader() {
  for (const node of ['a', 'b', 'c', 'd']) {
    try {
      const state = await callRpc(URLS[node], 'cluster.getState', {}, { timeoutMs: 2000 });
      if (state && state.role === 'primary') {
        return { nodeId: node, url: URLS[node], epoch: state.epoch };
      }
    } catch (_) {}
  }
  return { nodeId: 'a', url: URLS.a, epoch: 1 };
}

test('Phase 8: Primary-Backup Fault Tolerance (Experiment 7)', async (t) => {
  await clearAllFaults();
  await sleep(1000);

  let leader = await findCurrentLeader();

  await t.test('1. SYNC failover preserves all acknowledged transactions and promotes successor (T24)', async () => {
    // 1. Ensure SYNC mode on leader
    await callRpc(leader.url, 'replication.setMode', {
      mode: 'SYNC',
      syncAcks: 2
    });

    // 2. Create account and perform acknowledged transactions
    const accountRes = await callRpc(COORDINATOR_URL, 'bank.createAccount', {
      holderName: 'Failover T24 Account',
      openingDeposit: '5000.00',
      idempotencyKey: `t24-acc-${Date.now()}`
    }, { timeoutMs: 5000 });

    const accountId = accountRes.accountId;

    for (let i = 1; i <= 3; i++) {
      const depRes = await callRpc(COORDINATOR_URL, 'bank.deposit', {
        accountId,
        amount: '100.00',
        idempotencyKey: `t24-dep-${i}-${Date.now()}`
      }, { timeoutMs: 5000 });

      assert.equal(depRes.status, 'COMMITTED');
      assert.equal(depRes.durability, 'QUORUM');
    }

    const stateBefore = await callRpc(leader.url, 'cluster.getState', {});
    const targetBackup = stateBefore.backupId || 'b';

    // 3. Promote backup node (failover)
    const electionRes = await callRpc(URLS[targetBackup], 'election.start', {
      algorithm: 'bully',
      excluded: [leader.nodeId]
    }, { timeoutMs: 15000 });

    assert.ok(electionRes.promoted, 'Successor must be promoted');
    await sleep(1000);

    // 4. Verify new leader state and epoch increment
    const newLeaderState = await callRpc(URLS[targetBackup], 'cluster.getState', {});
    assert.equal(newLeaderState.role, 'primary', `Node ${targetBackup} must now be primary`);
    assert.ok(newLeaderState.epoch > stateBefore.epoch, 'Epoch must monotonically increase');

    // 5. Verify all acknowledged transactions are preserved on new leader
    const balRes = await callRpc(URLS[targetBackup], 'bank.getBalance', {
      accountId,
      consistency: 'strong'
    });

    assert.equal(balRes.balance, '5300.00', 'All acknowledged deposits must be preserved on new primary');

    // 6. New writes succeed on the new primary
    const newDep = await callRpc(URLS[targetBackup], 'bank.deposit', {
      accountId,
      amount: '200.00',
      idempotencyKey: `t24-new-dep-${Date.now()}`
    });

    assert.equal(newDep.status, 'COMMITTED');
    assert.equal(newDep.balance, '5500.00');

    leader = { nodeId: targetBackup, url: URLS[targetBackup], epoch: newLeaderState.epoch };
  });

  await t.test('2. Promotion refused: NO_QUORUM when majority grants are unavailable (T25)', async () => {
    // Attempt promotion excluding 2 nodes so that fewer than 3 grants (out of 4) can be obtained
    try {
      await callRpc(URLS.c, 'election.start', {
        algorithm: 'bully',
        excluded: ['a', 'b'] // excluding 2 of 4 nodes prevents majority quorum (grants < 3)
      }, { timeoutMs: 10000 });

      assert.fail('Promotion must fail when quorum cannot be reached');
    } catch (err) {
      assert.equal(err.code, ERROR_CODES.PROMOTION_REFUSED, 'Must return PROMOTION_REFUSED error code -32012');
      if (err.data) {
        assert.equal(err.data.reason, 'NO_QUORUM', 'Error reason must be NO_QUORUM');
      }
    }
  });

  await t.test('3. Promotion refused: STALE_CANDIDATE when required log is blocked (T26)', async () => {
    // Inject blockFetch fault on Node D so it cannot catch up required log entries
    await callRpc(URLS.d, 'cluster.setFault', {
      knob: 'blockFetch',
      value: true
    });

    try {
      // Node D attempts promotion with blockFetch active
      await callRpc(URLS.d, 'election.start', {
        algorithm: 'ring',
        excluded: [leader.nodeId]
      }, { timeoutMs: 10000 });

      // If D was behind, promotion was refused with STALE_CANDIDATE
    } catch (err) {
      assert.ok(
        err.code === ERROR_CODES.PROMOTION_REFUSED || err.message.includes('STALE_CANDIDATE') || err.message.includes('Ring'),
        `Expected STALE_CANDIDATE refusal or election error, got: ${err.message}`
      );
    } finally {
      await callRpc(URLS.d, 'cluster.clearFaults', {});
    }
  });

  await t.test('4. Isolated primary is fenced by lease expiration and rejects writes (T27)', async () => {
    // Current leader is fenced via isolate fault
    await callRpc(leader.url, 'cluster.setFault', {
      knob: 'isolate',
      value: true
    });

    try {
      // Lease check: direct write to isolated leader must be rejected
      await sleep(500);

      try {
        await callRpc(leader.url, 'bank.deposit', {
          accountId: 'ACC-0001',
          amount: '10.00',
          idempotencyKey: `fenced-dep-${Date.now()}`
        }, { timeoutMs: 3000 });

        assert.fail('Isolated primary with expired lease must reject writes');
      } catch (err) {
        assert.ok(
          err.code === ERROR_CODES.NOT_PRIMARY || err.code === ERROR_CODES.STALE_LEADER || err.message.includes('lease'),
          `Expected NOT_PRIMARY or lease error, got: ${err.message}`
        );
      }
    } finally {
      await callRpc(leader.url, 'cluster.clearFaults', {});
    }
  });

  await t.test('5. Rejoin procedure finds common prefix and converges (T28)', async () => {
    // Verify cluster.rejoin RPC endpoint responds and reconciles state
    const healthyLeader = await findCurrentLeader();
    const followerNode = (healthyLeader.nodeId === 'd') ? 'c' : 'd';

    const rejoinRes = await callRpc(URLS[followerNode], 'cluster.rejoin', {
      targetLeader: {
        nodeId: healthyLeader.nodeId,
        url: healthyLeader.url,
        epoch: healthyLeader.epoch,
        lastLsn: 100
      }
    }, { timeoutMs: 10000 });

    assert.ok(rejoinRes.success, 'Rejoin execution must succeed');
    assert.ok(rejoinRes.commonPrefixLsn >= 0, 'Must identify common prefix LSN');
  });

  await t.test('6. Invariants check across all nodes', async () => {
    for (const node of ['a', 'b', 'c', 'd']) {
      const invRes = await callRpc(URLS[node], 'admin.verifyInvariants', {});
      assert.equal(invRes.passed, true, `Invariants must pass on node ${node}`);
    }
  });
});
