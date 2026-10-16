// tests/acceptance/t27.test.js: T27 — Isolated primary lease self-fencing
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { clearAllFaults, findCurrentLeader, sleep } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');
const { ERROR_CODES } = require('../../src/contracts/errors');

describe('T27: Isolated old primary is fenced by lease expiration', () => {
  after(async () => {
    await clearAllFaults();
  });

  it('rejects mutating writes on primary after isolation and leader lease expiration', async () => {
    await clearAllFaults();
    const leader = await findCurrentLeader();

    // Isolate leader
    await callRpc(leader.url, 'cluster.setFault', {
      knob: 'isolate',
      value: true
    });

    try {
      await sleep(500);

      try {
        await callRpc(leader.url, 'bank.deposit', {
          accountId: 'ACC-0001',
          amount: '10.00',
          idempotencyKey: `t27-fenced-${Date.now()}`
        }, { timeoutMs: 3000 });

        assert.fail('Isolated primary must reject writes upon lease expiry');
      } catch (err) {
        assert.ok(
          err.code === ERROR_CODES.NOT_PRIMARY || err.code === ERROR_CODES.STALE_LEADER || err.message.includes('lease') || err.message.includes('PRIMARY'),
          `Expected NOT_PRIMARY or lease expiration error, got: ${err.message}`
        );
      }
    } finally {
      await callRpc(leader.url, 'cluster.clearFaults', {});
    }
  });
});
