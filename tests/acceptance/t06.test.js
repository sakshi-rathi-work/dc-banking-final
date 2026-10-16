// tests/acceptance/t06.test.js: T06 — Overdraft and atomic rollback
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { COORDINATOR_URL } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');
const { ERROR_CODES } = require('../../src/contracts/errors');

describe('T06: Overdraft and atomic rollback', () => {
  it('account with 1000 attempting withdraw 5000 fails with INSUFFICIENT_FUNDS and leaves balance unchanged', async () => {
    const acc = await callRpc(COORDINATOR_URL, 'bank.createAccount', {
      holderName: 'Overdraft Account',
      openingDeposit: '1000.00',
      idempotencyKey: `t06-acc-${Date.now()}`
    });

    let failed = false;
    const overdraftKey = `t06-od-${Date.now()}`;
    try {
      await callRpc(COORDINATOR_URL, 'bank.withdraw', {
        accountId: acc.accountId,
        amount: '5000.00',
        idempotencyKey: overdraftKey
      });
    } catch (err) {
      failed = true;
      assert.equal(err.code, ERROR_CODES.INSUFFICIENT_FUNDS);
      assert.equal(err.data.status, 'REJECTED');
      assert.equal(err.data.balance, '1000.00');
    }

    assert.ok(failed, 'Withdrawal beyond balance must be rejected');

    const bal = await callRpc(COORDINATOR_URL, 'bank.getBalance', {
      accountId: acc.accountId,
      consistency: 'strong'
    });
    assert.equal(bal.balance, '1000.00');
  });
});
