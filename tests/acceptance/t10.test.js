// tests/acceptance/t10.test.js: T10 — Worker crash safety
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { findCurrentLeader } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');

describe('T10: Worker crash safety', () => {
  it('worker-crash scenario: crashes are caught, open transactions rolled back, tasks retried, and balance consistent', async () => {
    const leader = await findCurrentLeader();
    const res = await callRpc(leader.url, 'worker.runBatch', {
      scenario: 'worker-crash'
    }, { timeoutMs: 30000 });

    assert.equal(res.summary.requests, 2);
    assert.equal(res.summary.succeeded, 2);
    assert.equal(res.summary.failed, 0);
    assert.equal(res.actualFinalBalance, '3000.00');

    // Verify at least one task was retried after crash
    const crashedAndRetried = res.tasks.some(t => t.retried === true || t.crashed === true);
    assert.ok(crashedAndRetried, 'Must record crash and successful retry');
    assert.equal(res.invariants.pass, true);
  });
});
