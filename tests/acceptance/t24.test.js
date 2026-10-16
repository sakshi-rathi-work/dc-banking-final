// tests/acceptance/t24.test.js: T24 — SYNC failover, no acknowledged loss
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { COORDINATOR_URL, NODE_URLS, clearAllFaults, findCurrentLeader, sleep } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');

describe('T24: SYNC failover preserves all acknowledged transactions without data loss', () => {
  after(async () => {
    await clearAllFaults();
  });

  it('promotes backup to new epoch after primary failure, preserving all acknowledged deposits', async () => {
    await clearAllFaults();
    let leader = await findCurrentLeader();

    // 1. SYNC mode on leader
    await callRpc(leader.url, 'replication.setMode', {
      mode: 'SYNC',
      syncAcks: 2
    });

    // 2. Create account
    const accountRes = await callRpc(COORDINATOR_URL, 'bank.createAccount', {
      holderName: 'T24 Failover User',
      openingDeposit: '5000.00',
      idempotencyKey: `t24-acc-${Date.now()}`
    }, { timeoutMs: 5000 });

    const accountId = accountRes.accountId;

    // Perform acknowledged deposits
    for (let i = 1; i <= 5; i++) {
      const depRes = await callRpc(COORDINATOR_URL, 'bank.deposit', {
        accountId,
        amount: '100.00',
        idempotencyKey: `t24-dep-${i}-${Date.now()}`
      }, { timeoutMs: 5000 });

      assert.equal(depRes.status, 'COMMITTED');
      assert.equal(depRes.durability, 'QUORUM');
    }

    const stateBefore = await callRpc(leader.url, 'cluster.getState', {});
    const targetBackup = stateBefore.backupId || (leader.nodeId === 'a' ? 'b' : 'a');

    // 3. Initiate failover / promote backup
    const electionRes = await callRpc(NODE_URLS[targetBackup], 'election.start', {
      algorithm: 'bully',
      excluded: [leader.nodeId]
    }, { timeoutMs: 15000 });

    assert.ok(electionRes.promoted, 'Successor must be promoted');
    await sleep(1000);

    // 4. Verify new leader has higher epoch
    const newLeaderState = await callRpc(NODE_URLS[targetBackup], 'cluster.getState', {});
    assert.equal(newLeaderState.role, 'primary', `Node ${targetBackup} must now be primary`);
    assert.ok(newLeaderState.epoch > stateBefore.epoch, 'Epoch must monotonically increase');

    // 5. Verify all acknowledged transactions are preserved
    const balRes = await callRpc(NODE_URLS[targetBackup], 'bank.getBalance', {
      accountId,
      consistency: 'strong'
    });
    assert.equal(balRes.balance, '5500.00', 'All acknowledged deposits must be preserved on new primary');

    // 6. New writes succeed on the new primary
    const newDep = await callRpc(NODE_URLS[targetBackup], 'bank.deposit', {
      accountId,
      amount: '200.00',
      idempotencyKey: `t24-new-dep-${Date.now()}`
    });
    assert.equal(newDep.status, 'COMMITTED');
    assert.equal(newDep.balance, '5700.00');
  });
});
