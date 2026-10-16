// tests/acceptance/t13.test.js: T13 — Bully election
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { NODE_URLS, clearAllFaults, sleep } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');

describe('T13: Bully election', () => {
  after(async () => {
    await clearAllFaults();
  });

  it('starting Bully election from B with D excluded elects C and establishes leadership epoch', async () => {
    await clearAllFaults();

    const bullyRes = await callRpc(NODE_URLS.b, 'election.start', {
      algorithm: 'bully',
      excluded: ['d']
    }, { timeoutMs: 15000 });

    assert.ok(bullyRes.electionId);
    assert.equal(bullyRes.winner, 'c', 'Winner of Bully with D excluded must be C');

    await sleep(500);

    const [stA, stB, stC] = await Promise.all([
      callRpc(NODE_URLS.a, 'cluster.getState', {}),
      callRpc(NODE_URLS.b, 'cluster.getState', {}),
      callRpc(NODE_URLS.c, 'cluster.getState', {})
    ]);

    assert.equal(stC.role, 'primary', 'Node C must be promoted to primary');
    assert.ok(stC.epoch >= 2, `Epoch must be >= 2, got ${stC.epoch}`);
    assert.equal(stA.leaderId, 'c', 'Node A recognizes C as leader');
    assert.equal(stB.leaderId, 'c', 'Node B recognizes C as leader');
  });
});
