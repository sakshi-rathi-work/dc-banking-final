// tests/acceptance/t16.test.js: T16 — Async replication, lag and convergence
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { NODE_URLS, clearAllFaults, findCurrentLeader, sleep } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');

describe('T16: Async replication, lag and convergence', () => {
  after(async () => {
    await clearAllFaults();
  });

  it('in ASYNC mode with delayed replica, write acks fast, replica exhibits lag, then converges', async () => {
    await clearAllFaults();
    const leader = await findCurrentLeader();

    await callRpc(leader.url, 'replication.setMode', { mode: 'ASYNC', syncAcks: 2 }, { timeoutMs: 5000 });

    const createRes = await callRpc(leader.url, 'bank.createAccount', {
      holderName: 'T16 Async User',
      openingDeposit: '1000.00',
      idempotencyKey: `t16-create-${Date.now()}`
    });

    // Inject 2000ms delay to replica D
    await callRpc(leader.url, 'cluster.setFault', {
      knob: 'replicationDelayMs_d',
      value: 2000
    });

    const t0 = Date.now();
    const depRes = await callRpc(leader.url, 'bank.deposit', {
      accountId: createRes.accountId,
      amount: '200.00',
      idempotencyKey: `t16-dep-${Date.now()}`
    });
    const writeDuration = Date.now() - t0;

    // ASYNC returns with LOCAL durability quickly
    assert.equal(depRes.durability, 'LOCAL');
    assert.ok(writeDuration < 500, `ASYNC write should complete fast, took ${writeDuration}ms`);

    // D should lag behind
    const statusD = await callRpc(NODE_URLS.d, 'replication.status', {});
    assert.ok(statusD.appliedLsn < depRes.lsn, `Replica D appliedLsn (${statusD.appliedLsn}) should lag behind leader LSN (${depRes.lsn})`);

    // Wait for D to catch up
    let converged = false;
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      const curD = await callRpc(NODE_URLS.d, 'replication.status', {});
      if (curD.appliedLsn === depRes.lsn) {
        converged = true;
        break;
      }
    }
    assert.ok(converged, 'Replica D must converge after replication delay expires');
  });
});
