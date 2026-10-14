// tests/unit/clocks.test.js: Unit tests for PhysicalClock, LamportClock, Berkeley math, and Causal Ordering
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { PhysicalClock } = require('../../src/clocks/physicalClock');
const { LamportClock } = require('../../src/clocks/lamportClock');
const { computeBerkeleySync, calculateSpread } = require('../../src/clocks/berkeley');
const { compareEventOrdering } = require('../../src/clocks/ordering');

describe('PhysicalClock (PROJECT.md Section 17.1)', () => {
  it('initializes and returns monotonic timestamps', () => {
    const clock = new PhysicalClock({ offsetMs: 0, driftPpm: 0, nodeId: 'test-node' });
    const t1 = clock.now();
    assert.ok(typeof t1 === 'number' && t1 > 1700000000000);
    const t2 = clock.now();
    assert.ok(t2 >= t1, 'Physical clock must be non-decreasing');
  });

  it('shifts timestamps by injected offset', () => {
    const clock = new PhysicalClock({ offsetMs: 0 });
    const base = Date.now();
    clock.setOffset(2500);
    const tPos = clock.now();
    assert.ok(tPos >= base + 2400 && tPos <= base + 3000, 'Timestamp should reflect +2500 ms offset');

    const clockNeg = new PhysicalClock({ offsetMs: 0 });
    clockNeg.setOffset(-1800);
    const tNeg = clockNeg.now();
    assert.ok(tNeg <= base - 1500, 'Timestamp should reflect -1800 ms offset');
  });

  it('monotonic guard prevents clock from going backward on negative adjustment', () => {
    const clock = new PhysicalClock({ offsetMs: 5000 });
    const beforeAdj = clock.now();
    // Backward adjustment of -4000ms
    clock.adjust(-4000);
    const afterAdj = clock.now();
    assert.ok(afterAdj >= beforeAdj, 'Monotonic guard must prevent backward jump');
  });

  it('accurately incorporates drift formula', () => {
    const clock = new PhysicalClock({ offsetMs: 0, driftPpm: 100000 }); // large drift for testing
    // Override t0 to simulate 10 seconds elapsed
    clock.t0 = Date.now() - 10000;
    // 100,000 ppm * 1e-6 * 10,000 ms = +1000 ms drift
    const t = clock.now();
    const expectedDrift = 1000;
    assert.ok(t >= Date.now() + expectedDrift - 50, 'Drift calculation should shift time by expected ppm');
  });
});

describe('LamportClock (PROJECT.md Section 17.3)', () => {
  it('increments on local tick()', () => {
    const lc = new LamportClock(0);
    assert.equal(lc.get(), 0);
    assert.equal(lc.tick(), 1);
    assert.equal(lc.tick(), 2);
    assert.equal(lc.get(), 2);
  });

  it('updates to max(local, remote) + 1 on message receipt', () => {
    const lc = new LamportClock(5);
    // Remote is higher (12)
    assert.equal(lc.update(12), 13);
    assert.equal(lc.get(), 13);

    // Remote is lower (8)
    assert.equal(lc.update(8), 14);
    assert.equal(lc.get(), 14);
  });
});

describe('Berkeley Algorithm Math (PROJECT.md Section 17.2)', () => {
  it('correctly calculates offsets, averages, and adjustments', () => {
    // Reference scenario from PROJECT.md Section 24.3
    // Master is coordinator (offset = 0)
    const masterTimeAtResponse = 1000000;
    const nodeReadings = [
      {
        nodeId: 'a',
        rttMs: 2.0,
        reportedTimeMs: masterTimeAtResponse + 1, // estOffset = +2.0
        masterTimeAtResponseMs: masterTimeAtResponse,
        injectedOffsetMs: 0
      },
      {
        nodeId: 'b',
        rttMs: 2.0,
        reportedTimeMs: masterTimeAtResponse + 2502, // estOffset = +2503.0
        masterTimeAtResponseMs: masterTimeAtResponse,
        injectedOffsetMs: 2500
      },
      {
        nodeId: 'c',
        rttMs: 2.0,
        reportedTimeMs: masterTimeAtResponse - 1799, // estOffset = -1798.0
        masterTimeAtResponseMs: masterTimeAtResponse,
        injectedOffsetMs: -1800
      },
      {
        nodeId: 'd',
        rttMs: 2.0,
        reportedTimeMs: masterTimeAtResponse + 700, // estOffset = +701.0
        masterTimeAtResponseMs: masterTimeAtResponse,
        injectedOffsetMs: 700
      }
    ];

    const result = computeBerkeleySync({
      nodeReadings,
      outlierThresholdMs: 10000,
      masterId: 'coordinator'
    });

    assert.equal(result.participants.length, 5); // 4 nodes + coordinator
    assert.equal(result.outliers.length, 0);

    // Sum of offsets: 0 (coord) + 2 + 2503 - 1798 + 701 = 1408 / 5 = 281.6
    assert.ok(result.averageOffsetMs > 280 && result.averageOffsetMs < 283);

    const b = result.participants.find(p => p.nodeId === 'b');
    assert.ok(b.adjustmentMs < -2000, 'Node B (+2500) should receive negative adjustment');

    const c = result.participants.find(p => p.nodeId === 'c');
    assert.ok(c.adjustmentMs > 2000, 'Node C (-1800) should receive positive adjustment');
  });

  it('identifies and excludes outliers exceeding threshold', () => {
    const masterTimeAtResponse = 1000000;
    const nodeReadings = [
      {
        nodeId: 'a',
        rttMs: 2.0,
        reportedTimeMs: masterTimeAtResponse + 10,
        masterTimeAtResponseMs: masterTimeAtResponse,
        injectedOffsetMs: 10
      },
      {
        nodeId: 'b', // Extreme outlier: +50,000ms
        rttMs: 2.0,
        reportedTimeMs: masterTimeAtResponse + 50000,
        masterTimeAtResponseMs: masterTimeAtResponse,
        injectedOffsetMs: 50000
      }
    ];

    const result = computeBerkeleySync({
      nodeReadings,
      outlierThresholdMs: 10000,
      masterId: 'coordinator'
    });

    assert.equal(result.outliers.length, 1);
    assert.equal(result.outliers[0].nodeId, 'b');
    assert.equal(result.keptCount, 2); // coordinator + node a
    assert.equal(result.participants.find(p => p.nodeId === 'b').adjustmentMs, 0);
  });

  it('calculates spread accurately', () => {
    assert.equal(calculateSpread([1000, 1020, 995]), 25);
    assert.equal(calculateSpread([1000]), 0);
    assert.equal(calculateSpread([]), 0);
  });
});

describe('Causal Event Ordering (PROJECT.md Section 17.3, Section 24.3)', () => {
  it('detects causal violations in skewed physical order while Lamport order has 0 violations', () => {
    // Sequence of causal events:
    // 1. rpc.received on Node A (A has physical offset +2500)
    // 2. db.commit on Node A
    // 3. replication.send on Node A -> B
    // 4. replication.apply on Node B (B has physical offset -1800)
    const baseRealTime = 1700000000000;

    const events = [
      {
        node: 'a',
        event: 'rpc.received',
        physicalTs: baseRealTime + 0 + 2500, // 2500
        lamport: 201,
        causalOrder: 1
      },
      {
        node: 'a',
        event: 'db.commit',
        physicalTs: baseRealTime + 5 + 2500, // 2505
        lamport: 202,
        causalOrder: 2
      },
      {
        node: 'a',
        event: 'replication.send',
        physicalTs: baseRealTime + 10 + 2500, // 2510
        lamport: 203,
        causalOrder: 3
      },
      {
        node: 'b',
        event: 'replication.apply',
        physicalTs: baseRealTime + 15 - 1800, // -1785 (much earlier physical timestamp!)
        lamport: 204,
        causalOrder: 4
      }
    ];

    const report = compareEventOrdering(events);

    // In physical order, node b:replication.apply (rank 1) appears before all node a events!
    assert.ok(report.physicalViolations >= 1, `Expected physical violations, got ${report.physicalViolations}`);
    assert.equal(report.lamportViolations, 0, 'Lamport order must have 0 causal violations');

    const replApplyRow = report.rows.find(r => r.event === 'replication.apply');
    assert.equal(replApplyRow.physicalRank, 1, 'In physical order, skewed replica event is ranked first (anomaly)');
    assert.equal(replApplyRow.lamportRank, 4, 'In Lamport order, replica event is ranked last (correct)');
  });
});
