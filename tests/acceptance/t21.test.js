// tests/acceptance/t21.test.js: T21 — Round Robin
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { COORDINATOR_URL, clearAllFaults, sleep } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');

describe('T21: Round Robin load distribution', () => {
  after(async () => {
    await clearAllFaults();
  });

  it('distributes 40 eventual consistency read requests evenly (10/10/10/10) across four healthy nodes', async () => {
    await clearAllFaults();

    const acc = await callRpc(COORDINATOR_URL, 'bank.createAccount', {
      holderName: 'T21 RR User',
      openingDeposit: '10000.00',
      idempotencyKey: `t21-acc-${Date.now()}`
    });

    await sleep(1500);

    const stats = await callRpc(COORDINATOR_URL, 'lb.run', {
      algorithm: 'round-robin',
      requests: 40,
      concurrency: 8,
      consistency: 'eventual',
      accountId: acc.accountId
    }, { timeoutMs: 15000 });

    assert.equal(stats.algorithm, 'round-robin');
    assert.equal(stats.totalRequests, 40);

    const nodes = stats.nodes;
    assert.equal(nodes.a.requests, 10, 'Node a must serve 10 requests');
    assert.equal(nodes.b.requests, 10, 'Node b must serve 10 requests');
    assert.equal(nodes.c.requests, 10, 'Node c must serve 10 requests');
    assert.equal(nodes.d.requests, 10, 'Node d must serve 10 requests');
  });
});
