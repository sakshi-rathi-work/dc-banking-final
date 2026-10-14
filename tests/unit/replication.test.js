// tests/unit/replication.test.js: Unit tests for Phase 5 replication logic
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeEntryHash } = require('../../src/domain/invariants');
const { AckTracker } = require('../../src/replication/ackTracker');
const { ERROR_CODES } = require('../../src/contracts/errors');

test('Replication Unit Tests', async (t) => {
  await t.test('computeEntryHash produces deterministic sha256 with canonical JSON', () => {
    const prevHash = '0000000000000000000000000000000000000000000000000000000000000000';
    const lsn = 1;
    const epoch = 1;
    const payload1 = {
      txn: { txnId: 'uuid-1', amount: '100.00' },
      accounts: [{ accountId: 'ACC-0001', balance: '100.00' }]
    };
    // Reverse key order in payload2 to test canonical sorting
    const payload2 = {
      accounts: [{ accountId: 'ACC-0001', balance: '100.00' }],
      txn: { amount: '100.00', txnId: 'uuid-1' }
    };

    const hash1 = computeEntryHash(prevHash, lsn, epoch, payload1);
    const hash2 = computeEntryHash(prevHash, lsn, epoch, payload2);

    assert.equal(typeof hash1, 'string');
    assert.equal(hash1.length, 64);
    assert.equal(hash1, hash2, 'Canonical key ordering must result in identical hash');

    // Tampering changes hash
    const payloadTampered = {
      ...payload1,
      txn: { ...payload1.txn, amount: '100.01' }
    };
    const hashTampered = computeEntryHash(prevHash, lsn, epoch, payloadTampered);
    assert.notEqual(hash1, hashTampered, 'Tampered amount must yield different hash');
  });

  await t.test('AckTracker enforces quorum rule: backup + (syncAcks - 1) other followers', () => {
    // Leader is 'a', designated backup is 'b', syncAcks = 2 (requires b + 1 other follower)
    const tracker = new AckTracker('a', 'b', 2);
    tracker.setLeaderLastLsn(50);

    // Initial durable LSN is 0
    assert.equal(tracker.durableLsn, 0);

    // Node c acknowledges LSN 40 (backup b hasn't acknowledged yet)
    tracker.peerMatches.set('c', 40);
    tracker.recomputeDurableLsn();
    assert.equal(tracker.durableLsn, 0, 'Backup b has not acked, durableLsn must remain 0');

    // Backup b acknowledges LSN 35
    tracker.peerMatches.set('b', 35);
    tracker.recomputeDurableLsn();
    // Min of b (35) and highest other follower c (40) is 35
    assert.equal(tracker.durableLsn, 35, 'Durable LSN should advance to 35');

    // Backup b advances to 50
    tracker.peerMatches.set('b', 50);
    tracker.recomputeDurableLsn();
    // Min of b (50) and c (40) is 40
    assert.equal(tracker.durableLsn, 40, 'Durable LSN should advance to 40');

    // Node d acknowledges LSN 45
    tracker.peerMatches.set('d', 45);
    tracker.recomputeDurableLsn();
    // Highest other follower is now d (45)
    assert.equal(tracker.durableLsn, 45, 'Durable LSN should advance to 45');

    // Node c advances to 50
    tracker.peerMatches.set('c', 50);
    tracker.recomputeDurableLsn();
    assert.equal(tracker.durableLsn, 50, 'Durable LSN should advance to 50');
  });

  await t.test('AckTracker awaitDurability resolves when durableLsn reaches target', async () => {
    const tracker = new AckTracker('a', 'b', 2);
    tracker.setLeaderLastLsn(10);
    tracker.durableLsn = 5;

    // Immediately resolved if already durable
    const res = await tracker.awaitDurability(5, 500);
    assert.equal(res, 5);

    // Waiting for LSN 8
    const waitPromise = tracker.awaitDurability(8, 1000);

    // Simulate backup and follower acknowledging LSN 8
    setTimeout(() => {
      tracker.peerMatches.set('b', 8);
      tracker.peerMatches.set('c', 8);
      tracker.recomputeDurableLsn();
    }, 50);

    const resultLsn = await waitPromise;
    assert.equal(resultLsn, 8);
  });

  await t.test('AckTracker awaitDurability times out with REPLICATION_QUORUM_TIMEOUT', async () => {
    const tracker = new AckTracker('a', 'b', 2);
    tracker.setLeaderLastLsn(10);
    tracker.durableLsn = 2;

    await assert.rejects(
      async () => {
        await tracker.awaitDurability(10, 100, 'test-txn-1');
      },
      (err) => {
        assert.equal(err.code, ERROR_CODES.REPLICATION_QUORUM_TIMEOUT);
        assert.equal(err.data.outcome, 'INDETERMINATE');
        assert.equal(err.data.lsn, 10);
        assert.equal(err.data.txnId, 'test-txn-1');
        return true;
      }
    );
  });
});
