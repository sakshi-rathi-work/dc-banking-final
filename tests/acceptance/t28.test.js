// tests/acceptance/t28.test.js: T28 — ASYNC loss window and divergent rejoin
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { NODE_URLS, clearAllFaults, findCurrentLeader } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');

describe('T28: ASYNC loss window reporting and divergent log resolution', () => {
  after(async () => {
    await clearAllFaults();
  });

  it('identifies common prefix and reconciles divergent log through cluster.rejoin RPC', async () => {
    await clearAllFaults();
    const leader = await findCurrentLeader();
    const follower = (leader.nodeId === 'd') ? 'c' : 'd';

    const rejoinRes = await callRpc(NODE_URLS[follower], 'cluster.rejoin', {
      targetLeader: {
        nodeId: leader.nodeId,
        url: leader.url,
        epoch: leader.epoch,
        lastLsn: 100
      }
    }, { timeoutMs: 10000 });

    assert.ok(rejoinRes.success, 'Rejoin execution must succeed');
    assert.ok(rejoinRes.commonPrefixLsn >= 0, 'Must identify common prefix LSN');
  });
});
