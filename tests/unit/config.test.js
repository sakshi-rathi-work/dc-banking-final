// tests/unit/config.test.js: Unit tests for configuration and DB isolation
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parsePeers, validateDbIsolation, loadConfig } = require('../../src/shared/config');

describe('Config and DB Isolation', () => {
  it('parses peer strings correctly with ranks', () => {
    const peersStr = 'a=http://bank-node-a:3000,b=http://bank-node-b:3000,c=http://bank-node-c:3000,d=http://bank-node-d:3000';
    const peers = parsePeers(peersStr);

    assert.equal(peers.a.nodeId, 'a');
    assert.equal(peers.a.rank, 1);
    assert.equal(peers.a.url, 'http://bank-node-a:3000');

    assert.equal(peers.b.nodeId, 'b');
    assert.equal(peers.b.rank, 2);

    assert.equal(peers.d.rank, 4);
  });

  it('rejects invalid peer string format', () => {
    assert.throws(() => {
      parsePeers('invalid_peer_without_equals');
    }, /Invalid peer specification/);
  });

  it('enforces database isolation: node A cannot connect to postgres-b', () => {
    delete process.env.ALLOW_ANY_DB_HOST;
    assert.throws(() => {
      validateDbIsolation('a', 'postgres://bank_a:pw_a@postgres-b:5432/bank');
    }, /Database isolation violation/);
  });

  it('enforces database credential isolation: node A cannot connect as user bank_b', () => {
    delete process.env.ALLOW_ANY_DB_HOST;
    assert.throws(() => {
      validateDbIsolation('a', 'postgres://bank_b:pw_a@postgres-a:5432/bank');
    }, /Database credential violation/);
  });

  it('allows matching node ID and postgres host', () => {
    delete process.env.ALLOW_ANY_DB_HOST;
    assert.doesNotThrow(() => {
      validateDbIsolation('a', 'postgres://bank_a:pw_a@postgres-a:5432/bank');
      validateDbIsolation('b', 'postgres://bank_b:pw_b@postgres-b:5432/bank');
    });
  });

  it('enforces LEADER_LEASE_MS < FAILURE_TIMEOUT_MS invariant', () => {
    const origLease = process.env.LEADER_LEASE_MS;
    const origTimeout = process.env.FAILURE_TIMEOUT_MS;
    const origNodeId = process.env.NODE_ID;
    const origDb = process.env.DATABASE_URL;

    try {
      process.env.NODE_ID = 'a';
      process.env.DATABASE_URL = 'postgres://bank_a:pw_a@postgres-a:5432/bank';
      process.env.LEADER_LEASE_MS = '5000';
      process.env.FAILURE_TIMEOUT_MS = '4000';

      assert.throws(() => {
        loadConfig();
      }, /LEADER_LEASE_MS.*must be < FAILURE_TIMEOUT_MS/);
    } finally {
      process.env.LEADER_LEASE_MS = origLease || '';
      process.env.FAILURE_TIMEOUT_MS = origTimeout || '';
      process.env.NODE_ID = origNodeId || '';
      process.env.DATABASE_URL = origDb || '';
    }
  });
});
