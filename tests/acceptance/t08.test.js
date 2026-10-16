// tests/acceptance/t08.test.js: T08 — Conflicting withdrawals
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { findCurrentLeader } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');
const { ERROR_CODES } = require('../../src/contracts/errors');

describe('T08: Conflicting withdrawals', () => {
  it('conflicting-withdrawals: exactly one COMMITTED and one REJECTED per run', async () => {
    const leader = await findCurrentLeader();
    // Run 5 iterations to test conflicting withdrawals
    for (let i = 0; i < 5; i++) {
      const res = await callRpc(leader.url, 'worker.runBatch', {
        scenario: 'conflicting-withdrawals'
      }, { timeoutMs: 30000 });

      assert.equal(res.summary.requests, 2);
      assert.equal(res.summary.succeeded, 1, 'Exactly one withdrawal must succeed');
      assert.equal(res.summary.rejected, 1, 'Exactly one withdrawal must be rejected');
      assert.equal(res.actualFinalBalance, '1000.00');

      const comm = res.tasks.find(t => t.status === 'COMMITTED');
      const rej = res.tasks.find(t => t.status === 'REJECTED');
      assert.ok(comm);
      assert.ok(rej);
      assert.equal(rej.errorCode, ERROR_CODES.INSUFFICIENT_FUNDS);
      assert.equal(res.invariants.pass, true);
    }
  });
});
