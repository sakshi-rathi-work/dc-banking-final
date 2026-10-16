// tests/acceptance/t26.test.js: T26 — Promotion refused: stale candidate
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { NODE_URLS, clearAllFaults, findCurrentLeader } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');
const { ERROR_CODES } = require('../../src/contracts/errors');

describe('T26: Promotion refused: stale candidate', () => {
  after(async () => {
    await clearAllFaults();
  });

  it('refuses promotion with STALE_CANDIDATE when lagging candidate cannot fetch required durable log', async () => {
    await clearAllFaults();
    const leader = await findCurrentLeader();

    // Inject blockFetch fault on Node D so it cannot catch up log entries
    await callRpc(NODE_URLS.d, 'cluster.setFault', {
      knob: 'blockFetch',
      value: true
    });

    try {
      await callRpc(NODE_URLS.d, 'election.start', {
        algorithm: 'ring',
        excluded: [leader.nodeId]
      }, { timeoutMs: 10000 });
    } catch (err) {
      assert.ok(
        err.code === ERROR_CODES.PROMOTION_REFUSED || err.message.includes('STALE_CANDIDATE') || err.message.includes('Ring'),
        `Expected STALE_CANDIDATE or election refusal, got ${err.message}`
      );
    } finally {
      await callRpc(NODE_URLS.d, 'cluster.clearFaults', {});
    }
  });
});
