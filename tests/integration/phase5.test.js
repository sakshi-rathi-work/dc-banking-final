// tests/integration/phase5.test.js: Phase 5 Integration Tests for Replication and Consistency Modes
// Specification: PROJECT.md Section 19, Section 24.5, Section 29 (T16-T20)

const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const { callRpc } = require('../../src/shared/rpc/client');
const { ERROR_CODES } = require('../../src/contracts/errors');

const URLS = {
  a: 'http://localhost:3001',
  b: 'http://localhost:3002',
  c: 'http://localhost:3003',
  d: 'http://localhost:3004',
  coordinator: 'http://localhost:8080'
};

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

test('Phase 5: Replication & Consistency Modes (Experiment 5)', async (t) => {
  // Ensure all faults cleared before starting
  for (const node of ['a', 'b', 'c', 'd']) {
    try {
      await callRpc(URLS[node], 'cluster.clearFaults', {});
    } catch (_) {}
  }

  // Set mode to ASYNC initially
  await callRpc(URLS.a, 'replication.setMode', { mode: 'ASYNC', syncAcks: 2 }, { timeoutMs: 5000 });

  let testAccountId;

  await t.test('1. Transaction replication: writes on leader A replicate to B, C, D with matching checksums', async () => {
    // Create an account
    const createRes = await callRpc(URLS.a, 'bank.createAccount', {
      holderName: 'Replication Test User',
      openingDeposit: '1000.00',
      idempotencyKey: `repl-create-${Date.now()}`
    });

    assert.ok(createRes.accountId, 'Account must be created');
    testAccountId = createRes.accountId;

    // Wait for replication convergence across all 4 nodes
    let converged = false;
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      try {
        const [stA, stB, stC, stD] = await Promise.all([
          callRpc(URLS.a, 'replication.status', {}),
          callRpc(URLS.b, 'replication.status', {}),
          callRpc(URLS.c, 'replication.status', {}),
          callRpc(URLS.d, 'replication.status', {})
        ]);

        if (stA.appliedLsn === stB.appliedLsn &&
            stB.appliedLsn === stC.appliedLsn &&
            stC.appliedLsn === stD.appliedLsn &&
            stA.stateChecksum === stB.stateChecksum &&
            stB.stateChecksum === stC.stateChecksum &&
            stC.stateChecksum === stD.stateChecksum) {
          converged = true;
          break;
        }
      } catch (_) {}
    }

    assert.ok(converged, 'All 4 nodes must converge to equal appliedLsn and stateChecksum');

    // Query balance with eventual consistency on all 4 nodes
    const [balA, balB, balC, balD] = await Promise.all([
      callRpc(URLS.a, 'bank.getBalance', { accountId: testAccountId, consistency: 'eventual' }),
      callRpc(URLS.b, 'bank.getBalance', { accountId: testAccountId, consistency: 'eventual' }),
      callRpc(URLS.c, 'bank.getBalance', { accountId: testAccountId, consistency: 'eventual' }),
      callRpc(URLS.d, 'bank.getBalance', { accountId: testAccountId, consistency: 'eventual' })
    ]);

    assert.equal(balA.balance, '1000.00');
    assert.equal(balB.balance, '1000.00');
    assert.equal(balC.balance, '1000.00');
    assert.equal(balD.balance, '1000.00');
    assert.equal(balA.version, 1);
    assert.equal(balB.version, 1);
    assert.equal(balC.version, 1);
    assert.equal(balD.version, 1);
  });

  await t.test('2. T16: ASYNC mode lag and convergence with replicationDelayMs on Node D', async () => {
    // Inject replication delay of 2000ms to Node D
    await callRpc(URLS.a, 'cluster.setFault', {
      knob: 'replicationDelayMs_d',
      value: 2000
    });

    const t0 = Date.now();
    const depRes = await callRpc(URLS.a, 'bank.deposit', {
      accountId: testAccountId,
      amount: '250.00',
      idempotencyKey: `repl-async-${Date.now()}`
    });

    const writeElapsed = Date.now() - t0;
    // ASYNC mode returns immediately upon local commit (durability: LOCAL)
    assert.equal(depRes.durability, 'LOCAL');
    assert.ok(writeElapsed < 500, `ASYNC write should complete fast, took ${writeElapsed}ms`);

    // Immediately inspect Node D: should lag behind leader
    const statusD = await callRpc(URLS.d, 'replication.status', {});
    const leaderStatus = await callRpc(URLS.a, 'replication.leaderStatus', {});

    assert.ok(statusD.appliedLsn < depRes.lsn, `Node D appliedLsn (${statusD.appliedLsn}) should lag behind leader LSN (${depRes.lsn})`);
    assert.ok(leaderStatus.peers.d.lagLsn >= 1, `Leader must report lag for peer D (lagLsn=${leaderStatus.peers.d.lagLsn})`);

    // Node B (backup) is served first and receives entry without delay (unlike Node D which is delayed by 2000ms)
    let bCaughtUp = false;
    for (let i = 0; i < 20; i++) {
      const statusB = await callRpc(URLS.b, 'replication.status', {});
      if (statusB.appliedLsn === depRes.lsn) {
        bCaughtUp = true;
        break;
      }
      await sleep(50);
    }
    assert.ok(bCaughtUp, 'Node B (backup) should receive the entry quickly without delay');

    // Wait for Node D to catch up after 2000ms delay expires
    let dConverged = false;
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      const curD = await callRpc(URLS.d, 'replication.status', {});
      if (curD.appliedLsn === depRes.lsn) {
        dConverged = true;
        break;
      }
    }

    assert.ok(dConverged, 'Node D must converge to leader LSN after replication delay expires');

    // Check balance on Node D is now updated
    const balD = await callRpc(URLS.d, 'bank.getBalance', { accountId: testAccountId, consistency: 'eventual' });
    assert.equal(balD.balance, '1250.00');

    // Clear fault
    await callRpc(URLS.a, 'cluster.clearFaults', {});
  });

  await t.test('3. T17: SYNC mode acknowledgement latency and quorum durability', async () => {
    // Switch to SYNC mode
    const modeRes = await callRpc(URLS.a, 'replication.setMode', {
      mode: 'SYNC',
      syncAcks: 2
    }, { timeoutMs: 5000 });
    assert.equal(modeRes.mode, 'SYNC');

    // Inject delay to designated backup B (1200ms)
    await callRpc(URLS.a, 'cluster.setFault', {
      knob: 'replicationDelayMs_b',
      value: 1200
    });

    const t0 = Date.now();
    const depRes = await callRpc(URLS.a, 'bank.deposit', {
      accountId: testAccountId,
      amount: '100.00',
      idempotencyKey: `repl-sync-${Date.now()}`
    }, { timeoutMs: 5000 });
    const syncElapsed = Date.now() - t0;

    // SYNC mode guarantees QUORUM durability
    assert.equal(depRes.durability, 'QUORUM');
    // Latency must include the injected delay to backup B (>= 1100ms)
    assert.ok(syncElapsed >= 1100, `SYNC latency (${syncElapsed}ms) must be >= backup delay (1200ms)`);

    // Verify backup B has the entry immediately
    const statusB = await callRpc(URLS.b, 'replication.status', {});
    assert.equal(statusB.appliedLsn, depRes.lsn);

    // Clear fault
    await callRpc(URLS.a, 'cluster.clearFaults', {});
  });

  await t.test('4. T18: SYNC mode rejects write when insufficient replicas are available', async () => {
    // Verify currently in SYNC mode
    const statusA = await callRpc(URLS.a, 'replication.status', {});
    assert.equal(statusA.replicationMode, 'SYNC');
    const initialLsn = statusA.appliedLsn;

    // Stop 2 followers: bank-node-c and bank-node-d
    execSync('docker stop bank-node-c bank-node-d');

    // Wait for failure detector to detect suspicion (> 4s) or simulate suspicion
    await sleep(4500);

    // Attempt deposit in SYNC mode
    let caughtErr = null;
    try {
      await callRpc(URLS.a, 'bank.deposit', {
        accountId: testAccountId,
        amount: '50.00',
        idempotencyKey: `repl-failfast-${Date.now()}`
      });
    } catch (err) {
      caughtErr = err;
    }

    // Restart containers first to maintain cluster availability
    execSync('docker start bank-node-c bank-node-d');
    await sleep(2500);

    assert.ok(caughtErr, 'SYNC write must be rejected when insufficient replicas exist');
    assert.equal(caughtErr.code, ERROR_CODES.INSUFFICIENT_REPLICAS);

    // Verify NO state change: LSN unchanged on Node A
    const postStatusA = await callRpc(URLS.a, 'replication.status', {});
    assert.equal(postStatusA.appliedLsn, initialLsn, 'No new LSN must be allocated on pre-check failure');
  });

  await t.test('5. T19: Duplicate delivery skipping and GAP rewind recovery', async () => {
    // Switch to ASYNC
    await callRpc(URLS.a, 'replication.setMode', { mode: 'ASYNC', syncAcks: 2 }, { timeoutMs: 5000 });
    await sleep(500);

    const stA = await callRpc(URLS.a, 'replication.status', {});
    const curLsn = stA.appliedLsn;

    // Resend already-applied entries to Node C (from curLsn to curLsn)
    const resendRes = await callRpc(URLS.a, 'replication.resend', {
      toPeer: 'c',
      fromLsn: curLsn,
      toLsn: curLsn
    });
    assert.ok(resendRes.ok);

    // Query Node C status: duplicates count should be incremented
    const stC = await callRpc(URLS.c, 'replication.status', {});
    assert.ok(stC.duplicates >= 1, `Node C must report duplicates > 0 (got ${stC.duplicates})`);

    // Test GAP recovery: inject dropNextAppend on Node D
    await callRpc(URLS.d, 'cluster.setFault', {
      knob: 'dropNextAppend',
      value: 2
    });

    // Perform deposit
    const depRes = await callRpc(URLS.a, 'bank.deposit', {
      accountId: testAccountId,
      amount: '50.00',
      idempotencyKey: `repl-gap-${Date.now()}`
    });

    // Node D will drop appends, leader will encounter gap and rewind next_lsn, and eventually catch up
    let convergedD = false;
    for (let i = 0; i < 25; i++) {
      await sleep(300);
      const dStatus = await callRpc(URLS.d, 'replication.status', {});
      if (dStatus.appliedLsn === depRes.lsn) {
        convergedD = true;
        break;
      }
    }

    assert.ok(convergedD, 'Node D must automatically recover from GAP and converge to leader LSN');

    // Clean up faults
    await callRpc(URLS.d, 'cluster.clearFaults', {});
    await callRpc(URLS.a, 'cluster.clearFaults', {});
  });

  await t.test('6. Read Consistency options: strong, bounded, eventual, minLsn', async () => {
    // strong consistency: fails on replica (Node B) with NOT_PRIMARY
    await assert.rejects(
      async () => {
        await callRpc(URLS.b, 'bank.getBalance', {
          accountId: testAccountId,
          consistency: 'strong'
        });
      },
      (err) => {
        assert.equal(err.code, ERROR_CODES.NOT_PRIMARY);
        return true;
      }
    );

    // strong consistency: succeeds on primary (Node A)
    const strongRes = await callRpc(URLS.a, 'bank.getBalance', {
      accountId: testAccountId,
      consistency: 'strong'
    });
    assert.equal(strongRes.servedBy, 'a');

    // minLsn: read on replica with minLsn <= current LSN succeeds
    const curLsn = strongRes.appliedLsn;
    const minLsnRes = await callRpc(URLS.b, 'bank.getBalance', {
      accountId: testAccountId,
      minLsn: curLsn
    });
    assert.ok(minLsnRes.appliedLsn >= curLsn);

    // minLsn: asking for an impossibly high minLsn times out with READ_TOO_STALE
    await assert.rejects(
      async () => {
        await callRpc(URLS.b, 'bank.getBalance', {
          accountId: testAccountId,
          minLsn: curLsn + 999
        });
      },
      (err) => {
        assert.equal(err.code, ERROR_CODES.READ_TOO_STALE);
        return true;
      }
    );
  });
});
