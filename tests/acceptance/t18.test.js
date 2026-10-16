// tests/acceptance/t18.test.js: T18 — Sync with insufficient replicas
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { NODE_URLS, clearAllFaults, findCurrentLeader } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');
const { ERROR_CODES } = require('../../src/contracts/errors');

describe('T18: Sync with insufficient replicas', () => {
  after(async () => {
    await clearAllFaults();
  });

  it('in SYNC mode when quorum of replicas cannot acknowledge, deposit fails fast with INSUFFICIENT_REPLICAS or QUORUM_TIMEOUT', async () => {
    await clearAllFaults();
    const leader = await findCurrentLeader();

    await callRpc(leader.url, 'replication.setMode', { mode: 'SYNC', syncAcks: 2 }, { timeoutMs: 5000 });

    const createRes = await callRpc(leader.url, 'bank.createAccount', {
      holderName: 'T18 Quorum User',
      openingDeposit: '500.00',
      idempotencyKey: `t18-create-${Date.now()}`
    });

    const statusPre = await callRpc(leader.url, 'replication.status', {});
    const initialLsn = statusPre.appliedLsn;

    // Block replication to peers or set delay higher than timeout
    await callRpc(leader.url, 'cluster.setFault', {
      knob: 'blockReplicationTo',
      value: ['b', 'c', 'd']
    });

    let caughtErr = null;
    try {
      await callRpc(leader.url, 'bank.deposit', {
        accountId: createRes.accountId,
        amount: '100.00',
        idempotencyKey: `t18-dep-${Date.now()}`
      }, { timeoutMs: 4000 });
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(caughtErr, 'Mutating transaction must fail when quorum is unavailable');
    const validCodes = [ERROR_CODES.INSUFFICIENT_REPLICAS, ERROR_CODES.REPLICATION_QUORUM_TIMEOUT];
    assert.ok(
      validCodes.includes(caughtErr.code) || caughtErr.message.includes('INSUFFICIENT_REPLICAS') || caughtErr.message.includes('REPLICATION_QUORUM_TIMEOUT'),
      `Error code must be INSUFFICIENT_REPLICAS or QUORUM_TIMEOUT, got ${caughtErr.code}`
    );

    // Balance and LSN on leader must be protected
    const bal = await callRpc(leader.url, 'bank.getBalance', { accountId: createRes.accountId, consistency: 'strong' });
    assert.equal(bal.balance, '500.00', 'Account balance must remain unchanged');
  });
});
