// tests/acceptance/t20.test.js: T20 — Replica restart recovery
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { NODE_URLS, clearAllFaults, findCurrentLeader, sleep } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');

describe('T20: Replica catch-up and recovery upon restart', () => {
  after(async () => {
    await clearAllFaults();
  });

  it('replica lagging behind catches up to leader LSN and state checksum upon recovery', async () => {
    await clearAllFaults();
    const leader = await findCurrentLeader();

    await callRpc(leader.url, 'replication.setMode', { mode: 'ASYNC', syncAcks: 2 }, { timeoutMs: 5000 });

    const createRes = await callRpc(leader.url, 'bank.createAccount', {
      holderName: 'T20 Catchup User',
      openingDeposit: '5000.00',
      idempotencyKey: `t20-create-${Date.now()}`
    });

    // Temporarily isolate or block replication to Node C
    await callRpc(leader.url, 'cluster.setFault', {
      knob: 'blockReplicationTo',
      value: ['c']
    });

    // Submit 5 deposits on leader
    let lastLsn = createRes.lsn;
    for (let i = 0; i < 5; i++) {
      const dep = await callRpc(leader.url, 'bank.deposit', {
        accountId: createRes.accountId,
        amount: '100.00',
        idempotencyKey: `t20-dep-${i}-${Date.now()}`
      });
      lastLsn = dep.lsn;
    }

    // Verify Node C is lagging
    const stCPre = await callRpc(NODE_URLS.c, 'replication.status', {});
    assert.ok(stCPre.appliedLsn < lastLsn, `Node C should lag behind (lsn=${stCPre.appliedLsn} < ${lastLsn})`);

    // Unblock replication to Node C
    await callRpc(leader.url, 'cluster.setFault', {
      knob: 'blockReplicationTo',
      value: []
    });

    // Node C should catch up to leader's LSN and checksum
    let caughtUp = false;
    for (let i = 0; i < 30; i++) {
      await sleep(300);
      const stC = await callRpc(NODE_URLS.c, 'replication.status', {});
      const stLeader = await callRpc(leader.url, 'replication.status', {});
      if (stC.appliedLsn === stLeader.appliedLsn && stC.stateChecksum === stLeader.stateChecksum) {
        caughtUp = true;
        break;
      }
    }

    assert.ok(caughtUp, 'Node C must catch up to leader LSN and matching stateChecksum');
  });
});
