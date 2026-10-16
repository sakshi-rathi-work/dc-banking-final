// tests/acceptance/t25.test.js: T25 — Promotion refused: no quorum
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { NODE_URLS, clearAllFaults } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');
const { ERROR_CODES } = require('../../src/contracts/errors');

describe('T25: Promotion refusal on missing quorum', () => {
  after(async () => {
    await clearAllFaults();
  });

  it('aborts candidate promotion with NO_QUORUM when fewer than 3 grants can be obtained', async () => {
    await clearAllFaults();

    // Attempt promotion excluding 2 nodes so majority quorum (>= 3 out of 4) is impossible
    try {
      await callRpc(NODE_URLS.c, 'election.start', {
        algorithm: 'bully',
        excluded: ['a', 'b']
      }, { timeoutMs: 10000 });

      assert.fail('Promotion must fail when quorum cannot be reached');
    } catch (err) {
      assert.equal(err.code, ERROR_CODES.PROMOTION_REFUSED, 'Must return PROMOTION_REFUSED error code -32012');
      if (err.data && err.data.reason) {
        assert.equal(err.data.reason, 'NO_QUORUM', 'Error reason must be NO_QUORUM');
      }
    }
  });
});
