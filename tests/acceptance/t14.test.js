// tests/acceptance/t14.test.js: T14 — Ring election
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { NODE_URLS, clearAllFaults, sleep } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');

describe('T14: Ring election', () => {
  after(async () => {
    await clearAllFaults();
  });

  it('starting Ring from A with C excluded skips C and elects D as coordinator', async () => {
    await clearAllFaults();

    const ringRes = await callRpc(NODE_URLS.a, 'election.start', {
      algorithm: 'ring',
      excluded: ['c']
    }, { timeoutMs: 15000 });

    assert.ok(ringRes.electionId);
    assert.equal(ringRes.winner, 'd', 'Winner of Ring with C excluded must be D');

    await sleep(500);

    const stD = await callRpc(NODE_URLS.d, 'cluster.getState', {});
    assert.equal(stD.role, 'primary', 'Node D must be promoted to primary');
    assert.ok(stD.epoch >= 2);
  });
});
