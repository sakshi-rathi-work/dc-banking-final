// tests/unit/faultTolerance.test.js: Unit Tests for Primary-Backup Fault Tolerance (Phase 8)
// Specification: PROJECT.md Section 13.4, Section 18.5, Section 21, Section 28 (Phase 8)

const test = require('node:test');
const assert = require('node:assert/strict');
const { FencingManager } = require('../../src/faulttolerance/fencing');
const { FailoverController } = require('../../src/faulttolerance/failoverController');
const { calculateNextEpoch, compareLogPositions } = require('../../src/faulttolerance/epochs');
const { ERROR_CODES, RpcError } = require('../../src/contracts/errors');
const { faults } = require('../../src/shared/faults');

test('Fault Tolerance: FencingManager (PROJECT.md Section 21.5, Section 22.1 F8)', async (t) => {
  const config = {
    nodeId: 'a',
    leaderLeaseMs: 1000
  };

  await t.test('1. FencingManager requires >= 2 distinct peer acks within lease window', () => {
    const fencing = new FencingManager(config);
    fencing.bootGraceUntil = 0; // Disable boot grace for deterministic test

    assert.equal(fencing.isLeaseValid(), false, 'Lease invalid with 0 peer acks');

    // Ack from node b only
    fencing.recordPeerAck('b');
    assert.equal(fencing.isLeaseValid(), false, 'Lease invalid with only 1 peer ack (b)');

    // Recording self must not count as a peer ack
    fencing.recordPeerAck('a');
    assert.equal(fencing.isLeaseValid(), false, 'Self ack does not count towards peer quorum');

    // Ack from node c
    fencing.recordPeerAck('c');
    assert.equal(fencing.isLeaseValid(), true, 'Lease valid with 2 distinct peer acks (b, c)');

    // Ack from node d
    fencing.recordPeerAck('d');
    assert.equal(fencing.isLeaseValid(), true, 'Lease valid with 3 peer acks (b, c, d)');
  });

  await t.test('2. FencingManager lease expires after leaderLeaseMs without acks', async () => {
    const fencing = new FencingManager({ nodeId: 'a', leaderLeaseMs: 50 });
    fencing.bootGraceUntil = 0;

    fencing.recordPeerAck('b');
    fencing.recordPeerAck('c');
    assert.equal(fencing.isLeaseValid(), true);

    // Wait for lease window to elapse
    await new Promise(r => setTimeout(r, 70));
    assert.equal(fencing.isLeaseValid(), false, 'Lease must expire when acks are older than lease window');
  });

  await t.test('3. isolate fault immediately invalidates leader lease', () => {
    process.env.ENABLE_FAULT_INJECTION = 'true';
    const fencing = new FencingManager(config);
    fencing.bootGraceUntil = Date.now() + 100000;
    fencing.recordPeerAck('b');
    fencing.recordPeerAck('c');

    try {
      faults.setFault('isolate', true);
      assert.equal(fencing.isLeaseValid(), false, 'Lease must be immediately invalid when isolated');
    } finally {
      faults.clearFaults();
    }
  });

  await t.test('4. write gate open/close controls', () => {
    const fencing = new FencingManager(config);
    assert.equal(fencing.writeGateOpen, true);
    fencing.closeWriteGate();
    assert.equal(fencing.writeGateOpen, false);
    fencing.openWriteGate();
    assert.equal(fencing.writeGateOpen, true);
  });
});

test('Fault Tolerance: FailoverController Candidate Exclusion (PROJECT.md Section 21.2, 21.4)', async (t) => {
  const config = {
    nodeId: 'b',
    backupGraceMs: 5000,
    electionAlgorithm: 'bully'
  };

  await t.test('1. excludes candidates with TTL and expires them', async () => {
    const controller = new FailoverController(config, null);
    assert.deepEqual(controller.getExcludedNodes(), []);

    controller.excludeCandidate('d', 50); // 50ms TTL
    assert.deepEqual(controller.getExcludedNodes(), ['d']);

    await new Promise(r => setTimeout(r, 70));
    assert.deepEqual(controller.getExcludedNodes(), [], 'Candidate exclusion must expire after TTL');
  });
});

test('Fault Tolerance: Binary Search Common Prefix Simulation (PROJECT.md Section 21.7)', async (t) => {
  // Pure algorithm test matching findCommonPrefixLsn logic
  async function simulateBinarySearch(localHashes, leaderHashes) {
    let low = 1;
    let high = Math.min(localHashes.length, leaderHashes.length);
    let highestCommon = 0;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const localHash = localHashes[mid - 1];
      const leaderHash = leaderHashes[mid - 1];

      if (localHash && leaderHash && localHash === leaderHash) {
        highestCommon = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return highestCommon;
  }

  await t.test('1. Identical logs match fully', async () => {
    const local = ['h1', 'h2', 'h3', 'h4', 'h5'];
    const leader = ['h1', 'h2', 'h3', 'h4', 'h5'];
    const k = await simulateBinarySearch(local, leader);
    assert.equal(k, 5);
  });

  await t.test('2. Diverged tail finds exact divergence point', async () => {
    // Node diverged after LSN 3
    const local = ['h1', 'h2', 'h3', 'divergent-4', 'divergent-5'];
    const leader = ['h1', 'h2', 'h3', 'leader-4', 'leader-5', 'leader-6'];
    const k = await simulateBinarySearch(local, leader);
    assert.equal(k, 3, 'Highest common prefix must be LSN 3');
  });

  await t.test('3. Completely divergent logs have common prefix 0', async () => {
    const local = ['d1', 'd2', 'd3'];
    const leader = ['l1', 'l2', 'l3'];
    const k = await simulateBinarySearch(local, leader);
    assert.equal(k, 0, 'Completely diverged logs must match at 0');
  });
});

test('Fault Tolerance: Error Codes and Promotion Refusal Contract (PROJECT.md Section 13.4, 21.4)', async (t) => {
  await t.test('1. Error codes match specification', () => {
    assert.equal(ERROR_CODES.NOT_PRIMARY, -32005);
    assert.equal(ERROR_CODES.STALE_LEADER, -32006);
    assert.equal(ERROR_CODES.NO_LEADER, -32007);
    assert.equal(ERROR_CODES.INSUFFICIENT_REPLICAS, -32008);
    assert.equal(ERROR_CODES.REPLICATION_QUORUM_TIMEOUT, -32009);
    assert.equal(ERROR_CODES.DB_UNAVAILABLE, -32010);
    assert.equal(ERROR_CODES.NODE_RECOVERING, -32011);
    assert.equal(ERROR_CODES.PROMOTION_REFUSED, -32012);
    assert.equal(ERROR_CODES.REPLICATION_GAP, -32013);
    assert.equal(ERROR_CODES.REPLICATION_DIVERGED, -32014);
  });

  await t.test('2. RpcError formats PROMOTION_REFUSED with structured reasons', () => {
    const quorumErr = new RpcError(ERROR_CODES.PROMOTION_REFUSED, 'PROMOTION_REFUSED: NO_QUORUM', {
      reason: 'NO_QUORUM',
      grantsCount: 2,
      required: 3
    });
    assert.equal(quorumErr.code, -32012);
    assert.equal(quorumErr.data.reason, 'NO_QUORUM');
    assert.equal(quorumErr.data.grantsCount, 2);

    const staleErr = new RpcError(ERROR_CODES.PROMOTION_REFUSED, 'PROMOTION_REFUSED: STALE_CANDIDATE', {
      reason: 'STALE_CANDIDATE',
      detail: 'last_lsn < requiredDurable'
    });
    assert.equal(staleErr.code, -32012);
    assert.equal(staleErr.data.reason, 'STALE_CANDIDATE');
  });
});
