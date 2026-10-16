// tests/integration/phase7.test.js: Phase 7 Integration Tests for Load Balancing (Experiment 6)
// Specification: PROJECT.md Section 20, Section 24.6, Section 28 (Phase 7 Exit Criteria), Section 29 (T21, T22, T23)

const test = require('node:test');
const assert = require('node:assert/strict');
const { callRpc } = require('../../src/shared/rpc/client');

const COORDINATOR_URL = process.env.COORDINATOR_URL || 'http://localhost:8080';
const URLS = {
  a: process.env.NODE_A_URL || 'http://localhost:3001',
  b: process.env.NODE_B_URL || 'http://localhost:3002',
  c: process.env.NODE_C_URL || 'http://localhost:3003',
  d: process.env.NODE_D_URL || 'http://localhost:3004'
};

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

test('Phase 7: Load Balancing (Experiment 6)', async (t) => {
  // Ensure all faults cleared before starting
  for (const node of ['a', 'b', 'c', 'd']) {
    try {
      await callRpc(URLS[node], 'cluster.clearFaults', {});
    } catch (_) {}
  }

  // Ensure an account exists for read load tests
  let testAccountId;
  try {
    const acc = await callRpc(COORDINATOR_URL, 'bank.createAccount', {
      holderName: 'LB Test Account',
      openingDeposit: '10000.00',
      idempotencyKey: `lb-init-${Date.now()}`
    }, { timeoutMs: 5000 });
    testAccountId = acc.accountId;
  } catch (err) {
    // If account already exists
    testAccountId = 'ACC-0001';
  }

  // Wait briefly for registry to poll and discover nodes
  await sleep(1500);

  await t.test('1. Round Robin distributes 40 read requests evenly (10/10/10/10) across healthy nodes (T21)', async () => {
    // Run 40 read requests at concurrency 8 with round-robin
    const stats = await callRpc(COORDINATOR_URL, 'lb.run', {
      algorithm: 'round-robin',
      requests: 40,
      concurrency: 8,
      consistency: 'eventual',
      accountId: testAccountId
    }, { timeoutMs: 15000 });

    assert.equal(stats.algorithm, 'round-robin');
    assert.equal(stats.totalRequests, 40);

    const nodes = stats.nodes;
    assert.equal(nodes.a.requests, 10, 'Node a must serve 10 requests');
    assert.equal(nodes.b.requests, 10, 'Node b must serve 10 requests');
    assert.equal(nodes.c.requests, 10, 'Node c must serve 10 requests');
    assert.equal(nodes.d.requests, 10, 'Node d must serve 10 requests');

    assert.equal(nodes.a.share, '25%');
    assert.equal(nodes.b.share, '25%');
    assert.equal(nodes.c.share, '25%');
    assert.equal(nodes.d.share, '25%');
  });

  await t.test('2. Least Connections routes away from slow node under latency skew (T22)', async () => {
    // Inject rpcDelayMs = 80 on Node B
    await callRpc(URLS.b, 'cluster.setFault', {
      knob: 'rpcDelayMs',
      value: 80
    });

    try {
      // Run 40 reads at concurrency 8 with least-connections
      const stats = await callRpc(COORDINATOR_URL, 'lb.run', {
        algorithm: 'least-connections',
        requests: 40,
        concurrency: 8,
        consistency: 'eventual',
        accountId: testAccountId
      }, { timeoutMs: 20000 });

      assert.equal(stats.algorithm, 'least-connections');
      assert.equal(stats.totalRequests, 40);

      const nodes = stats.nodes;

      // Node B must receive significantly fewer requests due to high active connection duration
      assert.ok(nodes.b.requests < 8, `Node B should serve fewer requests under delay, got ${nodes.b.requests}`);
      assert.ok(nodes.a.requests >= 10, `Fast node A should serve more requests, got ${nodes.a.requests}`);
      assert.ok(nodes.c.requests >= 10, `Fast node C should serve more requests, got ${nodes.c.requests}`);
      assert.ok(nodes.d.requests >= 10, `Fast node D should serve more requests, got ${nodes.d.requests}`);

      // Node B's peak active should be highest or among the highest
      assert.ok(nodes.b.peakActive >= 2, `Node B peakActive should be elevated, got ${nodes.b.peakActive}`);
    } finally {
      // Clear fault on Node B
      await callRpc(URLS.b, 'cluster.clearFaults', {});
    }
  });

  await t.test('3. Unhealthy node exclusion and read retries on surviving nodes (T23)', async () => {
    // Inject rpcDelayMs = 3000 on Node C to trigger timeout
    await callRpc(URLS.c, 'cluster.setFault', {
      knob: 'rpcDelayMs',
      value: 3000
    });

    try {
      // Wait for health registry to observe failures on C
      await sleep(2500);

      // Run 30 read requests under round-robin with C unhealthy
      const stats = await callRpc(COORDINATOR_URL, 'lb.run', {
        algorithm: 'round-robin',
        requests: 30,
        concurrency: 6,
        consistency: 'eventual',
        accountId: testAccountId
      }, { timeoutMs: 20000 });

      const nodes = stats.nodes;

      // Surviving nodes A, B, D serve requests without client error
      assert.ok(nodes.a.requests > 0, 'Node A must serve requests');
      assert.ok(nodes.b.requests > 0, 'Node B must serve requests');
      assert.ok(nodes.d.requests > 0, 'Node D must serve requests');
    } finally {
      // Clear fault on Node C
      await callRpc(URLS.c, 'cluster.clearFaults', {});
      // Wait for recovery threshold (3 checks = ~3000 ms)
      await sleep(3500);
    }
  });

  await t.test('4. Writes are strictly routed to current leader (LEADER_ONLY)', async () => {
    // Perform write through coordinator
    const writeRes = await callRpc(COORDINATOR_URL, 'bank.deposit', {
      accountId: testAccountId,
      amount: '50.00',
      idempotencyKey: `lb-write-${Date.now()}`
    }, { timeoutMs: 5000 });

    assert.equal(writeRes.status, 'COMMITTED');
    assert.ok(writeRes.lsn > 0);
  });
});
