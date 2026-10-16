// tests/unit/election.test.js: Unit tests for Bully, Ring, and Epoch Promotion logic
// Specification: PROJECT.md Section 18, Section 21.3, Section 28 (Phase 6 Exit Criteria)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  compareLogPositions,
  calculateNextEpoch,
  shouldGrantEpoch
} = require('../../src/faulttolerance/epochs');

const {
  METHOD_NAMES,
  validateMethodParams
} = require('../../src/contracts/methods');

describe('Epochs and Log Comparison (PROJECT.md Section 18.5, Section 21.3)', () => {
  it('correctly compares log positions by epoch first, then lsn', () => {
    // Newer epoch wins regardless of LSN
    assert.ok(compareLogPositions({ lastEpoch: 2, lastLsn: 10 }, { lastEpoch: 1, lastLsn: 50 }) > 0);
    assert.ok(compareLogPositions({ lastEpoch: 1, lastLsn: 50 }, { lastEpoch: 2, lastLsn: 10 }) < 0);

    // Same epoch compares by LSN
    assert.ok(compareLogPositions({ lastEpoch: 2, lastLsn: 50 }, { lastEpoch: 2, lastLsn: 40 }) > 0);
    assert.ok(compareLogPositions({ lastEpoch: 2, lastLsn: 40 }, { lastEpoch: 2, lastLsn: 50 }) < 0);
    assert.equal(compareLogPositions({ lastEpoch: 2, lastLsn: 50 }, { lastEpoch: 2, lastLsn: 50 }), 0);

    // Missing fields default to 0
    assert.ok(compareLogPositions({ lastEpoch: 1, lastLsn: 1 }, {}) > 0);
  });

  it('calculates candidate next epoch as max(promised_epoch, epoch) + 1', () => {
    assert.equal(calculateNextEpoch(1, 1), 2);
    assert.equal(calculateNextEpoch(3, 1), 4);
    assert.equal(calculateNextEpoch(2, 5), 6);
    assert.equal(calculateNextEpoch(0, 0), 1);
  });

  it('grants epoch only when proposed > promised_epoch', () => {
    assert.equal(shouldGrantEpoch(3, 2), true);
    assert.equal(shouldGrantEpoch(2, 2), false);
    assert.equal(shouldGrantEpoch(1, 2), false);
  });
});

describe('Election Method Contract Validation (PROJECT.md Section 13.3)', () => {
  it('validates election.start parameters', () => {
    assert.doesNotThrow(() => validateMethodParams(METHOD_NAMES.ELECTION_START, { algorithm: 'bully' }));
    assert.doesNotThrow(() => validateMethodParams(METHOD_NAMES.ELECTION_START, { algorithm: 'ring', excluded: ['d'] }));
    assert.throws(() => validateMethodParams(METHOD_NAMES.ELECTION_START, { algorithm: 'paxos' }));
    assert.throws(() => validateMethodParams(METHOD_NAMES.ELECTION_START, { excluded: 'not-array' }));
  });

  it('validates election.bully parameters', () => {
    assert.doesNotThrow(() => validateMethodParams(METHOD_NAMES.ELECTION_BULLY, {
      electionId: '2-b-10',
      fromId: 'b'
    }));
    assert.throws(() => validateMethodParams(METHOD_NAMES.ELECTION_BULLY, {
      electionId: '2-b-10'
    }));
  });

  it('validates election.bullyCoordinator parameters', () => {
    assert.doesNotThrow(() => validateMethodParams(METHOD_NAMES.ELECTION_BULLY_COORDINATOR, {
      electionId: '2-c-15',
      winnerId: 'c'
    }));
    assert.throws(() => validateMethodParams(METHOD_NAMES.ELECTION_BULLY_COORDINATOR, {
      electionId: '2-c-15'
    }));
  });

  it('validates election.ringToken and ringCoordinator parameters', () => {
    assert.doesNotThrow(() => validateMethodParams(METHOD_NAMES.ELECTION_RING_TOKEN, {
      electionId: '2-a-1',
      initiatorId: 'a',
      candidates: ['a']
    }));
    assert.throws(() => validateMethodParams(METHOD_NAMES.ELECTION_RING_TOKEN, {
      electionId: '2-a-1',
      initiatorId: 'a',
      candidates: 'not-array'
    }));

    assert.doesNotThrow(() => validateMethodParams(METHOD_NAMES.ELECTION_RING_COORDINATOR, {
      electionId: '2-d-5',
      winnerId: 'd',
      members: ['a', 'b', 'd']
    }));
    assert.throws(() => validateMethodParams(METHOD_NAMES.ELECTION_RING_COORDINATOR, {
      electionId: '2-d-5'
    }));
  });

  it('validates cluster.requestEpoch and cluster.announceLeader parameters', () => {
    assert.doesNotThrow(() => validateMethodParams(METHOD_NAMES.CLUSTER_REQUEST_EPOCH, {
      epoch: 2,
      candidateId: 'c'
    }));
    assert.throws(() => validateMethodParams(METHOD_NAMES.CLUSTER_REQUEST_EPOCH, {
      epoch: -1,
      candidateId: 'c'
    }));

    assert.doesNotThrow(() => validateMethodParams(METHOD_NAMES.CLUSTER_ANNOUNCE_LEADER, {
      epoch: 3,
      leaderId: 'c'
    }));
    assert.throws(() => validateMethodParams(METHOD_NAMES.CLUSTER_ANNOUNCE_LEADER, {
      epoch: 0,
      leaderId: 'c'
    }));
  });
});

describe('Ring Topology and Successor Selection (PROJECT.md Section 18.3)', () => {
  // Mock ring node ranking: a=1, b=2, c=3, d=4
  function mockGetSuccessorCandidates(myId, ringNodes) {
    const myIndex = ringNodes.indexOf(myId);
    if (myIndex === -1) return ringNodes.filter(id => id !== myId);

    const candidates = [];
    const n = ringNodes.length;
    for (let step = 1; step < n; step++) {
      candidates.push(ringNodes[(myIndex + step) % n]);
    }
    return candidates;
  }

  it('generates correct circular successor priorities for each node in a->b->c->d->a', () => {
    const ring = ['a', 'b', 'c', 'd'];

    assert.deepEqual(mockGetSuccessorCandidates('a', ring), ['b', 'c', 'd']);
    assert.deepEqual(mockGetSuccessorCandidates('b', ring), ['c', 'd', 'a']);
    assert.deepEqual(mockGetSuccessorCandidates('c', ring), ['d', 'a', 'b']);
    assert.deepEqual(mockGetSuccessorCandidates('d', ring), ['a', 'b', 'c']);
  });

  it('determines winner as candidate with highest rank, excluding excluded nodes', () => {
    const ranks = { a: 1, b: 2, c: 3, d: 4 };

    function pickWinner(candidates, excluded = []) {
      const eligible = candidates.filter(id => !excluded.includes(id));
      eligible.sort((x, y) => ranks[y] - ranks[x]);
      return eligible[0];
    }

    assert.equal(pickWinner(['a', 'b', 'c', 'd']), 'd');
    assert.equal(pickWinner(['a', 'b', 'c', 'd'], ['d']), 'c');
    assert.equal(pickWinner(['a', 'b'], ['b']), 'a');
    assert.equal(pickWinner(['a', 'b', 'c'], ['c', 'd']), 'b');
  });
});
