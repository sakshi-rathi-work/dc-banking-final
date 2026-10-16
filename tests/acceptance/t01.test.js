// tests/acceptance/t01.test.js: T01 — Four independent node processes
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { NODE_URLS } = require('./acceptanceHelper');

describe('T01: Four independent node processes', () => {
  it('GET /health returns distinct pid, distinct hostname, and nodeId in {a, b, c, d}', async () => {
    const healths = {};
    for (const [id, url] of Object.entries(NODE_URLS)) {
      const res = await fetch(`${url}/health`);
      assert.equal(res.status, 200, `Node ${id} /health returned HTTP ${res.status}`);
      const body = await res.json();
      assert.equal(body.nodeId, id);
      assert.equal(body.dbHealthy, true);
      assert.ok(body.pid > 0);
      assert.ok(body.hostname && body.hostname.length > 0);
      healths[id] = body;
    }

    const pids = new Set(Object.values(healths).map(h => h.pid));
    const hostnames = new Set(Object.values(healths).map(h => h.hostname));

    // In Docker, each container has its own hostname and PID namespace
    assert.equal(hostnames.size, 4, 'All four nodes must report distinct container hostnames');
    assert.ok(Object.values(healths).every(h => h.pid > 0), 'Every node must report a valid PID > 0');
  });
});
