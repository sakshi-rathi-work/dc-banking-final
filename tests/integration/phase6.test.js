// tests/integration/phase6.test.js: Phase 6 Integration Tests for Leader Election & Epochs (Experiment 4)
// Specification: PROJECT.md Section 18, Section 21.3, Section 28 (Phase 6 Exit Criteria), Section 29 (T13, T14, T15)

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

test('Phase 6: Leader Election & Epochs (Experiment 4)', async (t) => {
  // Ensure all faults cleared before starting
  for (const node of ['a', 'b', 'c', 'd']) {
    try {
      await callRpc(URLS[node], 'cluster.clearFaults', {});
    } catch (_) {}
  }

  await t.test('1. Bully election: starting Bully from B with D excluded/stopped elects C', async () => {
    // T13: Bully election with D stopped/excluded
    const bullyRes = await callRpc(URLS.b, 'election.start', {
      algorithm: 'bully',
      excluded: ['d']
    }, { timeoutMs: 15000 });

    assert.ok(bullyRes.electionId, 'Must return electionId');
    assert.equal(bullyRes.winner, 'c', 'Winner of Bully with D excluded must be C');

    // Wait for promotion announcement propagation
    await sleep(500);

    // Verify cluster state across nodes
    const [stA, stB, stC] = await Promise.all([
      callRpc(URLS.a, 'cluster.getState', {}),
      callRpc(URLS.b, 'cluster.getState', {}),
      callRpc(URLS.c, 'cluster.getState', {})
    ]);

    assert.equal(stC.role, 'primary', 'Node C must be promoted to primary');
    assert.ok(stC.epoch >= 2, `Epoch must be >= 2, got ${stC.epoch}`);
    assert.equal(stA.leaderId, 'c', 'Node A must recognize C as leader');
    assert.equal(stB.leaderId, 'c', 'Node B must recognize C as leader');
    assert.equal(stA.role, 'replica', 'Old primary Node A must have stepped down to replica');
  });

  await t.test('2. Ring election: starting Ring from A with C excluded/stopped skips C and elects D', async () => {
    // T14: Ring election skipping stopped node C
    const ringRes = await callRpc(URLS.a, 'election.start', {
      algorithm: 'ring',
      excluded: ['c']
    }, { timeoutMs: 15000 });

    assert.ok(ringRes.electionId, 'Must return electionId');
    assert.equal(ringRes.winner, 'd', 'Winner of Ring with C excluded must be D');

    // Wait for promotion announcement propagation
    await sleep(500);

    const stD = await callRpc(URLS.d, 'cluster.getState', {});
    assert.equal(stD.role, 'primary', 'Node D must be promoted to primary');
    assert.ok(stD.epoch >= 3, `Epoch must increment, got ${stD.epoch}`);
  });

  await t.test('3. Promotion writes EPOCH_START to replication_log and new leader accepts writes', async () => {
    // Fetch last replication log entry on new leader D
    const statusD = await callRpc(URLS.d, 'replication.status', {});
    assert.ok(statusD.appliedLsn > 0, 'Node D must have applied LSNs');

    // Fetch entries including latest LSN
    const fetchRes = await callRpc(URLS.d, 'replication.fetch', {
      fromLsn: statusD.appliedLsn,
      limit: 1
    });

    assert.ok(fetchRes.entries && fetchRes.entries.length > 0, 'Must have log entries');
    const lastEntry = fetchRes.entries[0];
    assert.equal(lastEntry.entryType, 'EPOCH_START', 'Latest entry from promotion must be EPOCH_START');
    assert.equal(lastEntry.payload.epochStart.leaderId, 'd', 'EPOCH_START leaderId must be d');

    // Test write directly on new leader D
    const createRes = await callRpc(URLS.d, 'bank.createAccount', {
      holderName: 'Phase 6 Test Holder',
      openingDeposit: '500.00',
      idempotencyKey: `p6-idem-${Date.now()}`
    });

    assert.ok(createRes.accountId, 'Write on new leader D must succeed');
  });

  await t.test('4. Old primary rejects mutating writes with NOT_PRIMARY', async () => {
    // Attempt deposit on Node A (old primary)
    try {
      await callRpc(URLS.a, 'bank.deposit', {
        accountId: 'ACC-0001',
        amount: '100.00',
        idempotencyKey: `p6-fail-${Date.now()}`
      });
      assert.fail('Old primary must reject mutating writes');
    } catch (err) {
      assert.equal(err.code, ERROR_CODES.NOT_PRIMARY, 'Must return NOT_PRIMARY error code (-32005)');
      assert.ok(err.data && err.data.leaderHint, 'Must include leaderHint in error data');
    }
  });

  await t.test('5. Coordinator detects new leader and routes writes to it', async () => {
    // Ensure coordinator refreshes leader
    await sleep(600);

    const coordRes = await callRpc(URLS.coordinator, 'bank.createAccount', {
      holderName: 'Coordinator Route Test',
      openingDeposit: '1000.00',
      idempotencyKey: `p6-coord-${Date.now()}`
    }, { timeoutMs: 5000 });

    assert.ok(coordRes.accountId, 'Coordinator write must succeed via routed leader');
  });

  await t.test('6. Competing simultaneous elections converge on a single winner', async () => {
    // T15: Start Bully from A and B simultaneously
    const [resA, resB] = await Promise.all([
      callRpc(URLS.a, 'election.start', { algorithm: 'bully' }),
      callRpc(URLS.b, 'election.start', { algorithm: 'bully' })
    ]);

    assert.equal(resA.winner, resB.winner, 'Simultaneous elections must converge on the exact same winner');

    // Check that cluster states agree on leader and epoch
    const [stA, stB, stC, stD] = await Promise.all([
      callRpc(URLS.a, 'cluster.getState', {}),
      callRpc(URLS.b, 'cluster.getState', {}),
      callRpc(URLS.c, 'cluster.getState', {}),
      callRpc(URLS.d, 'cluster.getState', {})
    ]);

    assert.equal(stA.leaderId, resA.winner);
    assert.equal(stB.leaderId, resA.winner);
    assert.equal(stC.leaderId, resA.winner);
    assert.equal(stD.leaderId, resA.winner);
  });

  await t.test('7. Election messages appear in election_log on both ends with Lamport timestamps', async () => {
    const logA = await callRpc(URLS.a, 'election.getLog', { limit: 20 });
    const logD = await callRpc(URLS.d, 'election.getLog', { limit: 20 });

    assert.ok(logA.logs && logA.logs.length > 0, 'Node A must have recorded election logs');
    assert.ok(logD.logs && logD.logs.length > 0, 'Node D must have recorded election logs');

    // Verify Lamport timestamps exist and are positive
    assert.ok(Number(logA.logs[0].lamport) > 0, 'Lamport timestamp must be positive');
    assert.ok(['SENT', 'RECEIVED', 'LOCAL'].includes(logA.logs[0].direction), 'Direction must be valid');
  });
});
