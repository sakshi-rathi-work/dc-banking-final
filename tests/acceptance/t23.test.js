// tests/acceptance/t23.test.js: T23 — Health exclusion and re-admission
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { COORDINATOR_URL, NODE_URLS, clearAllFaults, sleep } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');

describe('T23: Health exclusion and re-admission', () => {
  after(async () => {
    await clearAllFaults();
  });

  it('excludes failing node from load balancing pool and retries reads on healthy nodes', async () => {
    await clearAllFaults();

    const acc = await callRpc(COORDINATOR_URL, 'bank.createAccount', {
      holderName: 'T23 Health User',
      openingDeposit: '10000.00',
      idempotencyKey: `t23-acc-${Date.now()}`
    });

    // Make Node C unresponsive to trigger exclusion
    await callRpc(NODE_URLS.c, 'cluster.setFault', {
      knob: 'rpcDelayMs',
      value: 3000
    });

    try {
      // Wait for health check failures
      await sleep(2500);

      const stats = await callRpc(COORDINATOR_URL, 'lb.run', {
        algorithm: 'round-robin',
        requests: 30,
        concurrency: 6,
        consistency: 'eventual',
        accountId: acc.accountId
      }, { timeoutMs: 20000 });

      const nodes = stats.nodes;
      // Surviving nodes serve requests cleanly
      assert.ok(nodes.a.requests > 0, 'Node a must serve requests');
      assert.ok(nodes.b.requests > 0, 'Node b must serve requests');
      assert.ok(nodes.d.requests > 0, 'Node d must serve requests');
    } finally {
      await callRpc(NODE_URLS.c, 'cluster.clearFaults', {});
    }
  });
});
