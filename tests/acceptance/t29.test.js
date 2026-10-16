// tests/acceptance/t29.test.js: T29 — Invariants and cross-node consistency
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { NODE_URLS } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');

describe('T29: Banking invariants (I1–I12) verification across all nodes', () => {
  it('verifies all 12 invariants pass on every cluster node', async () => {
    for (const [nodeId, url] of Object.entries(NODE_URLS)) {
      const invRes = await callRpc(url, 'admin.verifyInvariants', {});
      assert.equal(invRes.pass, true, `All invariants I1-I12 must pass on node ${nodeId}`);
      assert.equal(invRes.nodeId, nodeId);

      // Verify individual check details
      assert.ok(invRes.checks.I1_noNegativeBalance.pass, 'I1: no negative balances');
      assert.ok(invRes.checks.I8_ledgerBalanceAgreement.pass, 'I8: ledger balance agreement');
      assert.ok(invRes.checks.I9_moneyConservation.pass, 'I9: money conservation');
      assert.ok(invRes.checks.I10_gapFreeHashChain.pass, 'I10: gap-free hash chain');
      assert.ok(invRes.checks.I11_epochFencing.pass, 'I11: epoch fencing');
    }
  });
});
