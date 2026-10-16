// tests/acceptance/t04.test.js: T04 — RPC crosses container boundaries
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { COORDINATOR_URL } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');

describe('T04: RPC crosses container boundaries', () => {
  it('coordinator routes requests to node and records trace across boundaries', async () => {
    const acc = await callRpc(COORDINATOR_URL, 'bank.createAccount', {
      holderName: 'Trace Account',
      openingDeposit: '1000.00',
      idempotencyKey: `t04-create-${Date.now()}`
    });

    assert.ok(acc.accountId);
    assert.ok(acc.traceId, 'Response must contain traceId');

    const dep = await callRpc(COORDINATOR_URL, 'bank.deposit', {
      accountId: acc.accountId,
      amount: '500.00',
      idempotencyKey: `t04-dep-${Date.now()}`
    });

    assert.equal(dep.status, 'COMMITTED');
    assert.ok(dep.traceId, 'Deposit must contain traceId');
  });
});
