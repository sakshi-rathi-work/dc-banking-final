// tests/integration/phase4.test.js: Integration tests for Phase 4 (Physical & Logical Clocks - Experiment 3)
// Specification: PROJECT.md Section 17, Section 28 (Phase 4 Exit Criteria), and Section 29 (T11, T12)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { callRpc } = require('../../src/shared/rpc/client');
const { compareEventOrdering } = require('../../src/clocks/ordering');

const COORDINATOR_URL = process.env.COORDINATOR_URL || 'http://localhost:8080';
const NODE_URLS = {
  a: process.env.NODE_A_URL || 'http://localhost:3001',
  b: process.env.NODE_B_URL || 'http://localhost:3002',
  c: process.env.NODE_C_URL || 'http://localhost:3003',
  d: process.env.NODE_D_URL || 'http://localhost:3004'
};

describe('Phase 4: Physical and Logical Clocks (Experiment 3)', () => {
  it('1. All nodes and coordinator respond to clock.get with valid clock states', async () => {
    for (const [nodeId, url] of Object.entries(NODE_URLS)) {
      const res = await callRpc(url, 'clock.get', {});
      assert.equal(res.nodeId, nodeId);
      assert.ok(typeof res.physicalTs === 'number' && res.physicalTs > 1700000000000);
      assert.ok(typeof res.offsetMs === 'number');
      assert.ok(typeof res.lamport === 'number');
      assert.ok(typeof res.iso === 'string');
    }

    const coordRes = await callRpc(COORDINATOR_URL, 'clock.get', {});
    assert.equal(coordRes.nodeId, 'coordinator');
    assert.ok(typeof coordRes.physicalTs === 'number');
  });

  it('2. Setting primary (Node A) offset to +2500ms shifts physical_ts_ms of committed transactions by ~2500ms', async () => {
    // Set Node A offset to +2500 ms
    await callRpc(NODE_URLS.a, 'clock.setOffset', { offsetMs: 2500, driftPpm: 0 });

    const clockA = await callRpc(NODE_URLS.a, 'clock.get', {});
    assert.equal(clockA.offsetMs, 2500);

    const nowApprox = Date.now();
    const key = `idem-clock-txn-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;

    // Create account on Node A
    const acc = await callRpc(NODE_URLS.a, 'bank.createAccount', {
      holderName: 'Clock Test Holder',
      openingDeposit: '1000.00',
      idempotencyKey: key
    });

    assert.ok(acc.accountId);
    assert.ok(acc.txnId);

    // Fetch transaction history
    const history = await callRpc(NODE_URLS.a, 'bank.getHistory', {
      accountId: acc.accountId,
      limit: 5
    });

    assert.ok(history.transactions.length >= 1);
    const txn = history.transactions.find(t => t.txnId === acc.txnId);
    assert.ok(txn, 'Created transaction must appear in history');

    const txnPhysicalTs = Number(txn.physicalTs);
    const expectedShift = txnPhysicalTs - nowApprox;

    // Must be shifted forward by approx 2500 ms (allowing modest execution duration tolerance)
    assert.ok(
      expectedShift >= 2000 && expectedShift <= 3200,
      `Transaction physical_ts_ms should be shifted by ~2500ms. Shift was: ${expectedShift}ms`
    );
    assert.ok(txn.lamport > 0, 'Transaction must store positive Lamport timestamp');
  });

  it('3. Setting Node B offset to -1800ms produces event_log entries with Node B\'s negative offset', async () => {
    const traceId = `trc-b-offset-${Date.now()}`;
    // Set Node B offset to -1800 ms with traceId
    await callRpc(NODE_URLS.b, 'clock.setOffset', {
      offsetMs: -1800,
      driftPpm: 0,
      _meta: { traceId }
    });

    const clockB = await callRpc(NODE_URLS.b, 'clock.get', {});
    assert.equal(clockB.offsetMs, -1800);

    const wallNow = Date.now();
    // Query clock.events on Node B for this request
    const eventsRes = await callRpc(NODE_URLS.b, 'clock.events', { requestId: traceId });
    assert.ok(Array.isArray(eventsRes.events) && eventsRes.events.length > 0);

    const targetEvent = eventsRes.events[eventsRes.events.length - 1];
    const eventPhysicalTs = Number(targetEvent.physical_ts);
    const offsetFromWall = eventPhysicalTs - wallNow;

    // Node B's event timestamp should be roughly ~1800ms in the past relative to wall clock
    assert.ok(
      offsetFromWall <= -1300 && offsetFromWall >= -2300,
      `Node B event_log physical_ts should reflect -1800ms offset. Measured: ${offsetFromWall}ms`
    );
  });

  it('4. Causal ordering shows >= 1 violation in physical ordering and 0 in Lamport ordering under skew', async () => {
    // Node A is at +2500 ms, Node B is at -1800 ms
    // Coordinator trace flow: Coordinator calls Node A (deposit), gets response, then calls Node B
    const traceId = `trc-causal-${Date.now()}`;
    const key = `idem-causal-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;

    // 1. Send deposit to Node A
    const depRes = await callRpc(NODE_URLS.a, 'bank.createAccount', {
      holderName: 'Causal Ordering Account',
      openingDeposit: '500.00',
      idempotencyKey: key,
      _meta: { traceId, from: 'coordinator', lamport: 100 }
    });
    assert.ok(depRes.accountId);

    // 2. Query event logs from Node A for this request
    const eventsA = await callRpc(NODE_URLS.a, 'clock.events', { requestId: traceId });
    const aEvents = (eventsA.events || []).filter(e => e.request_id === traceId);
    assert.ok(aEvents.length > 0, 'Node A should have recorded events for traceId');

    const primaryCommit = aEvents.find(e => e.event_type === 'db.commit') || aEvents[0];

    // 3. Make a subsequent RPC to Node B with causal link
    const traceBId = `trc-causal-b-${Date.now()}`;
    await callRpc(NODE_URLS.b, 'clock.get', {
      _meta: { traceId: traceBId, from: 'node-a', lamport: primaryCommit.lamport + 1 }
    });

    const eventsB = await callRpc(NODE_URLS.b, 'clock.events', { requestId: traceBId });
    const bEvents = eventsB.events || [];
    assert.ok(bEvents.length > 0, 'Node B should have recorded events for traceBId');
    const replicaEvent = bEvents[bEvents.length - 1];

    // Build cross-node causal event list: primaryCommit causally precedes replicaEvent
    const testEvents = [
      {
        node: 'a',
        event: 'db.commit',
        physicalTs: Number(primaryCommit.physical_ts),
        lamport: Number(primaryCommit.lamport),
        causalOrder: 1
      },
      {
        node: 'b',
        event: 'rpc.received',
        physicalTs: Number(replicaEvent.physical_ts),
        lamport: Number(replicaEvent.lamport),
        causalOrder: 2
      }
    ];

    const report = compareEventOrdering(testEvents);

    // Because A had +2500ms and B had -1800ms, replicaEvent.physicalTs < primaryCommit.physicalTs
    assert.ok(
      report.physicalViolations >= 1,
      `Physical ordering must exhibit at least 1 causal violation under skew (got ${report.physicalViolations})`
    );
    assert.equal(
      report.lamportViolations,
      0,
      `Lamport ordering must strictly have 0 causal violations (got ${report.lamportViolations})`
    );
  });

  it('5. Berkeley clock synchronization reduces cluster spread from seconds to within network RTT bound', async () => {
    // Setup skew matching PROJECT.md Section 24.3 and Acceptance Test T11:
    // a = 0, b = +2500, c = -1800, d = +700
    await callRpc(NODE_URLS.a, 'clock.setOffset', { offsetMs: 0 });
    await callRpc(NODE_URLS.b, 'clock.setOffset', { offsetMs: 2500 });
    await callRpc(NODE_URLS.c, 'clock.setOffset', { offsetMs: -1800 });
    await callRpc(NODE_URLS.d, 'clock.setOffset', { offsetMs: 700 });
    await callRpc(COORDINATOR_URL, 'clock.setOffset', { offsetMs: 0 });

    // Verify initial spread is high (> 4000 ms)
    const clocksBefore = [];
    for (const url of Object.values(NODE_URLS)) {
      const c = await callRpc(url, 'clock.get', {});
      clocksBefore.push(Number(c.physicalTs));
    }
    const preSpread = Math.max(...clocksBefore) - Math.min(...clocksBefore);
    assert.ok(preSpread >= 4000, `Pre-sync spread across nodes should be >= 4000ms (was ${preSpread}ms)`);

    // Run Berkeley synchronization on Coordinator
    const syncReport = await callRpc(COORDINATOR_URL, 'clock.sync', { outlierMs: 10000 });

    assert.ok(syncReport.syncId);
    assert.equal(syncReport.master, 'coordinator');
    assert.ok(syncReport.participants.length >= 4);
    assert.equal(syncReport.outliers.length, 0);

    // Verify reported pre-sync spread and post-sync spread
    assert.ok(syncReport.preSyncSpreadMs >= 4000, `Reported preSyncSpreadMs should be >= 4000ms`);

    // Post-sync spread must be reduced to within network RTT / practical tolerance (< 50ms)
    assert.ok(
      syncReport.postSyncSpreadMs < 50,
      `Post-sync spread should be reduced to < 50ms, was ${syncReport.postSyncSpreadMs}ms`
    );

    // Verify individual adjustments
    const adjB = syncReport.participants.find(p => p.nodeId === 'b');
    assert.ok(adjB.adjustmentMs < -1500, 'Node B (+2500ms) should receive negative adjustment');

    const adjC = syncReport.participants.find(p => p.nodeId === 'c');
    assert.ok(adjC.adjustmentMs > 1500, 'Node C (-1800ms) should receive positive adjustment');
  });

  it('6. Invariants pass across primary and cluster after clock sync', async () => {
    const inv = await callRpc(NODE_URLS.a, 'admin.verifyInvariants', {});
    assert.equal(inv.pass, true, 'All invariants I1-I12 must pass on primary');
  });
});
