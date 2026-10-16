// tests/acceptance/t05.test.js: T05 — Idempotent retry
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { COORDINATOR_URL } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');

describe('T05: Idempotent retry', () => {
  it('deposit 5000 with key K, repeated 5 times serially and 5 times concurrently yields exact same result and single effect', async () => {
    const acc = await callRpc(COORDINATOR_URL, 'bank.createAccount', {
      holderName: 'Idempotency Account',
      openingDeposit: '1000.00',
      idempotencyKey: `t05-acc-${Date.now()}`
    });

    const key = `t05-deposit-key-${Date.now()}`;
    const firstRes = await callRpc(COORDINATOR_URL, 'bank.deposit', {
      accountId: acc.accountId,
      amount: '5000.00',
      idempotencyKey: key
    });

    assert.equal(firstRes.status, 'COMMITTED');
    assert.equal(firstRes.balance, '6000.00');
    assert.equal(firstRes.duplicate, false);

    // 5 serial retries
    for (let i = 0; i < 5; i++) {
      const serialRes = await callRpc(COORDINATOR_URL, 'bank.deposit', {
        accountId: acc.accountId,
        amount: '5000.00',
        idempotencyKey: key
      });
      assert.equal(serialRes.status, 'COMMITTED');
      assert.equal(serialRes.balance, '6000.00');
      assert.equal(serialRes.duplicate, true);
    }

    // 5 concurrent retries
    const concurrentPromises = Array.from({ length: 5 }, () =>
      callRpc(COORDINATOR_URL, 'bank.deposit', {
        accountId: acc.accountId,
        amount: '5000.00',
        idempotencyKey: key
      })
    );
    const concurrentResults = await Promise.all(concurrentPromises);
    for (const cRes of concurrentResults) {
      assert.equal(cRes.status, 'COMMITTED');
      assert.equal(cRes.balance, '6000.00');
      assert.equal(cRes.duplicate, true);
    }

    // Final balance must still be exactly 6000.00
    const finalBal = await callRpc(COORDINATOR_URL, 'bank.getBalance', {
      accountId: acc.accountId,
      consistency: 'strong'
    });
    assert.equal(finalBal.balance, '6000.00');
  });
});
