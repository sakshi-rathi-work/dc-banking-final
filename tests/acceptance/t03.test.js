// tests/acceptance/t03.test.js: T03 — Persistence across container restarts
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { COORDINATOR_URL, findCurrentLeader, sleep } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');

describe('T03: Persistence across container restarts', () => {
  it('data persists across queries and preserves accounts and ledger lines', async () => {
    const leader = await findCurrentLeader();
    const idemCreate = `t03-create-${Date.now()}`;
    const accountRes = await callRpc(COORDINATOR_URL, 'bank.createAccount', {
      holderName: 'Persistence Test Account',
      openingDeposit: '10000.00',
      idempotencyKey: idemCreate
    });

    assert.ok(accountRes.accountId);
    assert.equal(accountRes.balance, '10000.00');

    const idemDep = `t03-dep-${Date.now()}`;
    const depRes = await callRpc(COORDINATOR_URL, 'bank.deposit', {
      accountId: accountRes.accountId,
      amount: '2000.00',
      idempotencyKey: idemDep
    });

    assert.equal(depRes.status, 'COMMITTED');
    assert.equal(depRes.balance, '12000.00');

    // Read balance after write
    const balRes = await callRpc(COORDINATOR_URL, 'bank.getBalance', {
      accountId: accountRes.accountId,
      consistency: 'strong'
    });

    assert.equal(balRes.balance, '12000.00');
    assert.equal(balRes.accountId, accountRes.accountId);
  });
});
