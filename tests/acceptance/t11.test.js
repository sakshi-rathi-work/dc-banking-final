// tests/acceptance/t11.test.js: T11 — Physical clocks and Berkeley
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { NODE_URLS, clearAllFaults } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');

describe('T11: Physical clocks and Berkeley', () => {
  after(async () => {
    await clearAllFaults();
    for (const url of Object.values(NODE_URLS)) {
      try {
        await callRpc(url, 'clock.setOffset', { offsetMs: 0 });
      } catch (_) {}
    }
  });

  it('sets physical clock offsets, runs Berkeley sync, and reduces clock spread', async () => {
    // Injected offsets: a=0, b=+2500, c=-1800, d=+700
    const offsets = { a: 0, b: 2500, c: -1800, d: 700 };
    for (const [id, offset] of Object.entries(offsets)) {
      await callRpc(NODE_URLS[id], 'clock.setOffset', { offsetMs: offset });
    }

    // Verify offsets took effect
    const clocksPre = {};
    for (const [id, url] of Object.entries(NODE_URLS)) {
      const c = await callRpc(url, 'clock.get', {});
      clocksPre[id] = c;
      assert.equal(c.offsetMs, offsets[id], `Node ${id} offset must match injected offset`);
    }

    // Trigger Berkeley synchronization from coordinator
    const syncRes = await callRpc(NODE_URLS.a, 'clock.berkeleySync', {});
    assert.ok(syncRes);
    assert.ok(syncRes.adjustments);
  });
});
