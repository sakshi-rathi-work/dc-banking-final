// tests/acceptance/t09.test.js: T09 — Worker threads are real
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { findCurrentLeader } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');

describe('T09: Worker threads are real', () => {
  it('worker pool executes tasks with distinct threadId, distinct pg_backend_pid, and overlapping intervals', async () => {
    const leader = await findCurrentLeader();
    const res = await callRpc(leader.url, 'worker.runBatch', {
      scenario: 'parallel-withdrawals'
    }, { timeoutMs: 30000 });

    assert.ok(res.tasks && res.tasks.length >= 4);

    const threadIds = new Set(res.tasks.map(t => t.threadId));
    const pgPids = new Set(res.tasks.map(t => t.pgPid));

    assert.equal(threadIds.size, 4, 'Must have 4 distinct worker thread IDs');
    assert.equal(pgPids.size, 4, 'Must have 4 distinct PostgreSQL backend PIDs');

    // Overlapping check
    const starts = res.tasks.map(t => t.tStartNs);
    const ends = res.tasks.map(t => t.tEndNs);
    const maxStart = Math.max(...starts);
    const maxEnd = Math.max(...ends);
    assert.ok(maxStart < maxEnd, 'Worker intervals must overlap');
  });
});
