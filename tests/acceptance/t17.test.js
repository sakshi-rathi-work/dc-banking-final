// tests/acceptance/t17.test.js: T17 — Sync vs async acknowledgement
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { NODE_URLS, clearAllFaults, findCurrentLeader } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');

describe('T17: Sync vs async acknowledgement latency', () => {
  after(async () => {
    await clearAllFaults();
  });

  it('measures durability and latency differences between SYNC and ASYNC modes under replication delay', async () => {
    await clearAllFaults();
    const leader = await findCurrentLeader();

    const createRes = await callRpc(leader.url, 'bank.createAccount', {
      holderName: 'T17 Latency User',
      openingDeposit: '1000.00',
      idempotencyKey: `t17-create-${Date.now()}`
    });

    // 1. ASYNC deposit
    await callRpc(leader.url, 'replication.setMode', { mode: 'ASYNC', syncAcks: 2 }, { timeoutMs: 5000 });
    const t0Async = Date.now();
    const asyncRes = await callRpc(leader.url, 'bank.deposit', {
      accountId: createRes.accountId,
      amount: '50.00',
      idempotencyKey: `t17-async-${Date.now()}`
    });
    const asyncDuration = Date.now() - t0Async;

    assert.equal(asyncRes.durability, 'LOCAL');
    assert.ok(asyncDuration < 400, `ASYNC duration should be fast (<400ms), got ${asyncDuration}ms`);

    // 2. SYNC deposit with delay to backup
    await callRpc(leader.url, 'replication.setMode', { mode: 'SYNC', syncAcks: 2 }, { timeoutMs: 5000 });
    await callRpc(leader.url, 'cluster.setFault', {
      knob: 'replicationDelayMs_b',
      value: 1200
    });

    const t0Sync = Date.now();
    const syncRes = await callRpc(leader.url, 'bank.deposit', {
      accountId: createRes.accountId,
      amount: '50.00',
      idempotencyKey: `t17-sync-${Date.now()}`
    }, { timeoutMs: 5000 });
    const syncDuration = Date.now() - t0Sync;

    assert.equal(syncRes.durability, 'QUORUM');
    assert.ok(syncDuration >= 1100, `SYNC duration must include backup delay (>=1100ms), got ${syncDuration}ms`);
  });
});
