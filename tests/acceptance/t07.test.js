// tests/acceptance/t07.test.js: T07 — Parallel withdrawals
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { COORDINATOR_URL, findCurrentLeader } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');

describe('T07: Parallel withdrawals', () => {
  it('runs parallel-withdrawals scenario with workers debiting concurrently', async () => {
    const leader = await findCurrentLeader();
    const res = await callRpc(leader.url, 'worker.runBatch', {
      scenario: 'parallel-withdrawals'
    }, { timeoutMs: 30000 });

    assert.equal(res.summary.requests, 4);
    assert.equal(res.summary.succeeded, 4);
    assert.equal(res.summary.rejected, 0);
    assert.equal(res.actualFinalBalance, '2000.00');
    assert.equal(res.invariants.pass, true);
  });
});
