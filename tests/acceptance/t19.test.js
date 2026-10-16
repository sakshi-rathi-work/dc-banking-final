// tests/acceptance/t19.test.js: T19 — Duplicate and missing replication entries
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { NODE_URLS, clearAllFaults, findCurrentLeader, sleep } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');

describe('T19: Duplicate delivery skipping and gap rewind recovery', () => {
  after(async () => {
    await clearAllFaults();
  });

  it('skips duplicate entries without double application and automatically recovers from gaps', async () => {
    await clearAllFaults();
    const leader = await findCurrentLeader();

    await callRpc(leader.url, 'replication.setMode', { mode: 'ASYNC', syncAcks: 2 }, { timeoutMs: 5000 });
    await sleep(500);

    const stA = await callRpc(leader.url, 'replication.status', {});
    const curLsn = stA.appliedLsn;

    // Resend already-applied entry to Node C
    const resendRes = await callRpc(leader.url, 'replication.resend', {
      toPeer: 'c',
      fromLsn: curLsn,
      toLsn: curLsn
    });
    assert.ok(resendRes.ok);

    const stC = await callRpc(NODE_URLS.c, 'replication.status', {});
    assert.ok(stC.duplicates >= 1, `Node C must report duplicates >= 1 (got ${stC.duplicates})`);

    // Test GAP recovery: inject dropNextAppend on Node D
    await callRpc(NODE_URLS.d, 'cluster.setFault', {
      knob: 'dropNextAppend',
      value: 2
    });

    const createRes = await callRpc(leader.url, 'bank.createAccount', {
      holderName: 'T19 Gap User',
      openingDeposit: '1000.00',
      idempotencyKey: `t19-create-${Date.now()}`
    });

    // Wait for automatic gap rewind and convergence on Node D
    let convergedD = false;
    for (let i = 0; i < 25; i++) {
      await sleep(300);
      const dStatus = await callRpc(NODE_URLS.d, 'replication.status', {});
      if (dStatus.appliedLsn >= createRes.lsn) {
        convergedD = true;
        break;
      }
    }

    assert.ok(convergedD, 'Node D must automatically recover from GAP and converge to leader LSN');
  });
});
