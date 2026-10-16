// tests/unit/cli.test.js: Unit Tests for CLI Rendering and Menu Formatting
// Specification: PROJECT.md Section 23, Section 28 (Phase 9)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  renderBanner,
  renderClusterTable,
  renderTransactionHistory,
  renderInvariantsReport,
  renderWorkerReport,
  renderLoadBalancerStats,
  renderFaultsTable,
  renderTrace,
  renderRpcResult
} = require('../../src/cli/render');

test('CLI: Banner and Header Formatting (PROJECT.md Section 23.2)', async (t) => {
  await t.test('1. renderBanner formats one-line status banner correctly', () => {
    const banner = renderBanner({
      leaderId: 'a',
      epoch: 1,
      replicationMode: 'ASYNC',
      nodesUp: '4/4'
    });

    assert.ok(banner.includes('DISTRIBUTED BANKING SYSTEM'));
    assert.ok(banner.includes('leader: node-a'));
    assert.ok(banner.includes('epoch: 1'));
    assert.ok(banner.includes('mode: ASYNC'));
    assert.ok(banner.includes('nodes up: 4/4'));
  });

  await t.test('2. renderBanner handles missing/fallback values', () => {
    const banner = renderBanner({});
    assert.ok(banner.includes('leader: none'));
    assert.ok(banner.includes('epoch: -'));
    assert.ok(banner.includes('mode: ASYNC'));
  });
});

test('CLI: Table Rendering (PROJECT.md Section 23.1, Section 23.3)', async (t) => {
  await t.test('1. renderClusterTable formats all node columns', () => {
    const nodes = [
      { nodeId: 'a', role: 'primary', epoch: 1, leaderId: 'a', backupId: 'b', lastLsn: 42, durableLsn: 42, replicationMode: 'SYNC', dbHealthy: true, leaseValid: true },
      { nodeId: 'b', role: 'backup', epoch: 1, leaderId: 'a', backupId: 'b', lastLsn: 42, durableLsn: 42, replicationMode: 'SYNC', dbHealthy: true, leaseValid: true },
      { nodeId: 'c', role: 'replica', epoch: 1, leaderId: 'a', backupId: 'b', lastLsn: 42, durableLsn: 42, replicationMode: 'SYNC', dbHealthy: true, leaseValid: true },
      { nodeId: 'd', role: 'replica', epoch: 1, leaderId: 'a', backupId: 'b', lastLsn: 42, durableLsn: 42, replicationMode: 'SYNC', dbHealthy: true, leaseValid: true }
    ];

    const out = renderClusterTable(nodes);
    assert.ok(out.includes('node  role     epoch  leader  backup  lastLsn  durableLsn  mode   health   lease'));
    assert.ok(out.includes('a     primary  1      a       b       42       42          SYNC   healthy  valid'));
    assert.ok(out.includes('b     backup   1      a       b       42       42          SYNC   healthy  valid'));
  });

  await t.test('2. renderTransactionHistory formats transactions table', () => {
    const txns = [
      {
        txn_id: '9c1e4b52-1111-2222-3333-444455556666',
        type: 'DEPOSIT',
        source_account_id: null,
        destination_account_id: 'ACC-0001',
        amount: '500.00',
        status: 'COMMITTED',
        lsn: 42,
        epoch: 1,
        lamport_ts: 60,
        committed_at: new Date('2026-10-15T12:00:00Z')
      }
    ];

    const out = renderTransactionHistory(txns);
    assert.ok(out.includes('txnId     type        source    dest      amount       status     lsn  epoch  lamport  committed'));
    assert.ok(out.includes('9c1e4b52'));
    assert.ok(out.includes('DEPOSIT'));
    assert.ok(out.includes('ACC-0001'));
    assert.ok(out.includes('500.00'));
    assert.ok(out.includes('COMMITTED'));

    const empty = renderTransactionHistory([]);
    assert.equal(empty, 'No transactions found.');
  });

  await t.test('3. renderInvariantsReport formats I1-I12 and checksums', () => {
    const invMap = {};
    for (let i = 1; i <= 12; i++) invMap[`I${i}`] = true;

    const reports = [
      { nodeId: 'a', passed: true, checksum: '7c93bb1234', invariants: invMap },
      { nodeId: 'b', passed: true, checksum: '7c93bb1234', invariants: invMap }
    ];

    const out = renderInvariantsReport(reports);
    assert.ok(out.includes('node  I1  I2  I3  I4  I5  I6  I7  I8  I9  I10 I11 I12  checksum  verdict'));
    assert.ok(out.includes('a     OK  OK  OK  OK  OK  OK  OK  OK  OK  OK  OK  OK   7c93bb    PASS'));
  });

  await t.test('4. renderWorkerReport formats thread activity and batch summary', () => {
    const report = {
      batchId: 'batch-test-1',
      durationMs: 145,
      totalTasks: 4,
      committed: 4,
      rejected: 0,
      workerStats: [
        { threadId: '1', pgBackendPid: '1001', tasksExecuted: 2, committed: 2, rejected: 0 },
        { threadId: '2', pgBackendPid: '1002', tasksExecuted: 2, committed: 2, rejected: 0 }
      ]
    };

    const out = renderWorkerReport(report);
    assert.ok(out.includes('batchId: batch-test-1   duration: 145 ms'));
    assert.ok(out.includes('threadId  pgBackendPid  tasksExecuted  committed  rejected'));
    assert.ok(out.includes('1         1001          2              2          0'));
  });

  await t.test('5. renderLoadBalancerStats formats traffic distribution and latency', () => {
    const stats = {
      algorithm: 'round-robin',
      totalRequests: 40,
      nodes: {
        a: { requests: 10, share: '25%', peakActive: 2, p50Ms: 12, p95Ms: 18 },
        b: { requests: 10, share: '25%', peakActive: 2, p50Ms: 11, p95Ms: 17 }
      }
    };

    const out = renderLoadBalancerStats(stats);
    assert.ok(out.includes('algorithm: round-robin   totalRequests: 40'));
    assert.ok(out.includes('node  requests  share  peakActive  p50(ms)  p95(ms)'));
    assert.ok(out.includes('a     10        25%    2           12       18'));
  });

  await t.test('6. renderFaultsTable formats active and empty fault lists', () => {
    const empty = renderFaultsTable([]);
    assert.ok(empty.includes('none  (all fault knobs inactive)'));

    const active = renderFaultsTable([
      { nodeId: 'b', knob: 'rpcDelayMs', value: 80 }
    ]);
    assert.ok(active.includes('b     rpcDelayMs            80'));
  });
});

test('CLI: Section 23.1 Anti-Hardcoding Audit (No Theory in CLI sources)', async (t) => {
  await t.test('1. cli directory files contain zero banned theoretical explanations', () => {
    const banned = [
      'is an algorithm that',
      'the theoretical foundation',
      'in this experiment we simulate',
      'this proves that',
      'split brain means'
    ];

    const cliDir = path.join(__dirname, '../../src/cli');
    function checkDir(dir) {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        const full = path.join(dir, f);
        if (fs.statSync(full).isDirectory()) {
          checkDir(full);
        } else if (f.endsWith('.js')) {
          const content = fs.readFileSync(full, 'utf8').toLowerCase();
          for (const b of banned) {
            assert.equal(
              content.includes(b),
              false,
              `Found banned theoretical phrase "${b}" in ${full}`
            );
          }
        }
      }
    }
    checkDir(cliDir);
  });
});

test('CLI: Docker Container Allow-List (PROJECT.md Section 22.2)', async (t) => {
  const { isAllowedContainer } = require('../../src/cli/dockerControl');

  await t.test('1. allows bank-node and postgres containers only', () => {
    assert.equal(isAllowedContainer('bank-node-a'), true);
    assert.equal(isAllowedContainer('bank-node-b'), true);
    assert.equal(isAllowedContainer('postgres-a'), true);
    assert.equal(isAllowedContainer('postgres-d'), true);
    assert.equal(isAllowedContainer('/bank-node-c'), true);

    // Forbidden containers
    assert.equal(isAllowedContainer('bank-coordinator'), false, 'Coordinator is not in the allow-list');
    assert.equal(isAllowedContainer('bank-cli'), false, 'CLI is not in the allow-list');
    assert.equal(isAllowedContainer('other-service'), false);
  });
});
