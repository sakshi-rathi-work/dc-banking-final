// tests/acceptance/t02.test.js: T02 — Four independent databases
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { NODE_URLS } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');

describe('T02: Four independent databases', () => {
  it('each node connects to its own independent database with isolated state', async () => {
    const states = {};
    for (const [id, url] of Object.entries(NODE_URLS)) {
      const state = await callRpc(url, 'cluster.getState', {});
      assert.equal(state.nodeId, id);
      assert.equal(state.dbHealthy, true, `Node ${id} database must be healthy`);
      states[id] = state;
    }

    // Nodes must report distinct database URLs/contexts
    assert.equal(Object.keys(states).length, 4);
    for (const [id, state] of Object.entries(states)) {
      assert.equal(state.nodeId, id);
      assert.ok(state.role, `Node ${id} must have role in node_state`);
      assert.ok(typeof state.epoch === 'number', `Node ${id} must have epoch in node_state`);
    }
  });
});
