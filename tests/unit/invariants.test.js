// tests/unit/invariants.test.js: Unit tests for canonical JSON and entry hash calculation
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { canonicalJSON, computeEntryHash } = require('../../src/domain/invariants');

describe('Canonical JSON and Hash Chaining', () => {
  it('sorts keys alphabetically regardless of insertion order', () => {
    const obj1 = { z: 1, a: 2, m: { y: 10, b: 20 } };
    const obj2 = { a: 2, m: { b: 20, y: 10 }, z: 1 };

    assert.equal(canonicalJSON(obj1), canonicalJSON(obj2));
    assert.equal(canonicalJSON(obj1), '{"a":2,"m":{"b":20,"y":10},"z":1}');
  });

  it('computes deterministic entry hash', () => {
    const prevHash = '0000000000000000000000000000000000000000000000000000000000000000';
    const lsn = 1;
    const epoch = 1;
    const payload = { op: 'createAccount', accountId: 'ACC-0001' };

    const hash1 = computeEntryHash(prevHash, lsn, epoch, payload);
    const hash2 = computeEntryHash(prevHash, lsn, epoch, { accountId: 'ACC-0001', op: 'createAccount' });

    assert.equal(typeof hash1, 'string');
    assert.equal(hash1.length, 64);
    assert.equal(hash1, hash2);
  });
});
