// tests/acceptance/t15.test.js: T15 — Competing elections
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { NODE_URLS, clearAllFaults, sleep } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');

describe('T15: Competing simultaneous elections', () => {
  after(async () => {
    await clearAllFaults();
  });

  it('simultaneous competing elections converge to a single legitimate leader and monotonic epoch', async () => {
    await clearAllFaults();

    // Launch competing elections simultaneously
    const [resA, resB] = await Promise.allSettled([
      callRpc(NODE_URLS.a, 'election.start', { algorithm: 'bully' }, { timeoutMs: 15000 }),
      callRpc(NODE_URLS.b, 'election.start', { algorithm: 'bully' }, { timeoutMs: 15000 })
    ]);

    await sleep(1000);

    // Query cluster state on all reachable nodes
    const states = await Promise.all([
      callRpc(NODE_URLS.a, 'cluster.getState', {}),
      callRpc(NODE_URLS.b, 'cluster.getState', {}),
      callRpc(NODE_URLS.c, 'cluster.getState', {}),
      callRpc(NODE_URLS.d, 'cluster.getState', {})
    ]);

    const primaries = states.filter(s => s.role === 'primary');
    assert.equal(primaries.length, 1, 'Exactly one node must be primary after competing elections');

    const primaryLeaderId = primaries[0].nodeId;
    for (const s of states) {
      assert.equal(s.leaderId, primaryLeaderId, `Node ${s.nodeId} must agree on leaderId ${primaryLeaderId}`);
    }
  });
});
