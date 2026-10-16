// tests/acceptance/t22.test.js: T22 — Least Connections
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { COORDINATOR_URL, NODE_URLS, clearAllFaults, sleep } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');

describe('T22: Least Connections load distribution under latency skew', () => {
  after(async () => {
    await clearAllFaults();
  });

  it('routes requests away from slow node with elevated active connections under Least Connections', async () => {
    await clearAllFaults();

    const acc = await callRpc(COORDINATOR_URL, 'bank.createAccount', {
      holderName: 'T22 LC User',
      openingDeposit: '10000.00',
      idempotencyKey: `t22-acc-${Date.now()}`
    });

    // Inject delay on Node B
    await callRpc(NODE_URLS.b, 'cluster.setFault', {
      knob: 'rpcDelayMs',
      value: 80
    });

    await sleep(1500);

    const stats = await callRpc(COORDINATOR_URL, 'lb.run', {
      algorithm: 'least-connections',
      requests: 40,
      concurrency: 8,
      consistency: 'eventual',
      accountId: acc.accountId
    }, { timeoutMs: 25000 });

    assert.equal(stats.algorithm, 'least-connections');
    assert.equal(stats.totalRequests, 40);

    const nodes = stats.nodes;
    // Node B with injected latency must serve fewer requests than the fast nodes
    assert.ok(
      nodes.b.requests < 10,
      `Node b (${nodes.b.requests}) should receive fewer requests than fair share 10`
    );
    assert.ok(
      nodes.a.requests > 10 || nodes.c.requests > 10 || nodes.d.requests > 10,
      'Faster nodes must absorb more requests'
    );
  });
});
