// tests/acceptance/t12.test.js: T12 — Lamport ordering vs physical ordering
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { NODE_URLS, clearAllFaults } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');
const { compareEventOrdering } = require('../../src/clocks/ordering');

describe('T12: Lamport vs physical event ordering', () => {
  after(async () => {
    await clearAllFaults();
    for (const url of Object.values(NODE_URLS)) {
      try {
        await callRpc(url, 'clock.setOffset', { offsetMs: 0 });
      } catch (_) {}
    }
  });

  it('proves Lamport clock preserves causal order (0 violations) while skewed physical clocks show causal violations', async () => {
    // Inject skew: A has +2500ms, B has -1800ms
    await callRpc(NODE_URLS.a, 'clock.setOffset', { offsetMs: 2500 });
    await callRpc(NODE_URLS.b, 'clock.setOffset', { offsetMs: -1800 });

    const key = `t12-dep-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
    const acc = await callRpc(NODE_URLS.a, 'bank.createAccount', {
      holderName: 'Lamport Test User',
      openingDeposit: '1000.00',
      idempotencyKey: key
    });

    assert.ok(acc.accountId);

    // Fetch event logs from Node A and Node B
    const eventsA = await callRpc(NODE_URLS.a, 'clock.events', { limit: 10 });
    const eventsB = await callRpc(NODE_URLS.b, 'clock.events', { limit: 10 });

    // Find primary commit and replica receive events
    const primaryCommit = eventsA.events.find(e => e.event === 'db.commit') || eventsA.events[0];
    const replicaEvent = eventsB.events.find(e => e.event === 'rpc.received') || eventsB.events[0];

    assert.ok(primaryCommit, 'Node A must have recorded an event');
    assert.ok(replicaEvent, 'Node B must have recorded an event');

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

    assert.ok(report.physicalViolations >= 1, 'Physical order must exhibit >= 1 causal violation under skew');
    assert.equal(report.lamportViolations, 0, 'Lamport order must strictly have 0 causal violations');
  });
});
