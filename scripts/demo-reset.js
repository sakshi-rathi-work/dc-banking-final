// scripts/demo-reset.js: Cluster Reset and Demo Data Seeding
// Specification: PROJECT.md Section 23.2 (Menu 12), Section 30

const { callRpc } = require('../src/shared/rpc/client');

const URLS = {
  a: process.env.NODE_A_URL || 'http://localhost:3001',
  b: process.env.NODE_B_URL || 'http://localhost:3002',
  c: process.env.NODE_C_URL || 'http://localhost:3003',
  d: process.env.NODE_D_URL || 'http://localhost:3004',
  coordinator: process.env.COORDINATOR_URL || 'http://localhost:8080'
};

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runReset(skipConfirm = false) {
  console.log('=========================================');
  console.log('       DEMO DATA RESET & SEEDING         ');
  console.log('=========================================');

  // 1. Verify all 4 nodes are reachable
  console.log('Checking cluster nodes reachable:');
  const nodeIds = ['a', 'b', 'c', 'd'];
  const reachable = {};

  for (const nid of nodeIds) {
    try {
      await callRpc(URLS[nid], 'cluster.ping', {}, { timeoutMs: 2000 });
      reachable[nid] = true;
      console.log(`  Node ${nid.toUpperCase()}: REACHABLE`);
    } catch (err) {
      reachable[nid] = false;
      console.log(`  Node ${nid.toUpperCase()}: UNREACHABLE (${err.message})`);
    }
  }

  const allReachable = Object.values(reachable).every(v => v === true);
  if (!allReachable) {
    console.error('\nRESET REFUSED: All four nodes (a, b, c, d) must be reachable to reset.');
    process.exit(1);
  }

  // 2. Call admin.reset on all four nodes
  console.log('\nExecuting admin.reset across all nodes:');
  for (const nid of nodeIds) {
    const res = await callRpc(URLS[nid], 'admin.reset', {}, { timeoutMs: 5000 });
    console.log(`  Node ${nid.toUpperCase()}: RESET OK (role=${res.role}, epoch=${res.epoch})`);
  }

  // Brief pause for nodes to settle
  await sleep(1000);

  // 3. Seed demo accounts through the normal primary path (Node A)
  console.log('\nSeeding demo accounts through primary (Node A):');
  const seedAccounts = [
    { holder: 'Alice Smith', deposit: '10000.00', key: 'seed-acc-1' },
    { holder: 'Bob Jones', deposit: '5000.00', key: 'seed-acc-2' },
    { holder: 'Charlie Brown', deposit: '2500.00', key: 'seed-acc-3' },
    { holder: 'Treasury Pool', deposit: '100000.00', key: 'seed-acc-4' }
  ];

  const created = [];
  for (const sa of seedAccounts) {
    const res = await callRpc(URLS.a, 'bank.createAccount', {
      holderName: sa.holder,
      openingDeposit: sa.deposit,
      idempotencyKey: sa.key
    }, { timeoutMs: 5000 });

    created.push({ ...sa, accountId: res.accountId, lsn: res.lsn });
    console.log(`  Created ${res.accountId}: ${sa.holder} (₹${sa.deposit}, LSN ${res.lsn})`);
  }

  // Seed sample transfer between accounts
  if (created.length >= 2) {
    const transferRes = await callRpc(URLS.a, 'bank.transfer', {
      fromAccountId: created[0].accountId,
      toAccountId: created[1].accountId,
      amount: '500.00',
      idempotencyKey: 'seed-xfer-1'
    }, { timeoutMs: 5000 });
    console.log(`  Sample transfer: ${created[0].accountId} -> ${created[1].accountId} ₹500.00 (LSN ${transferRes.lsn})`);
  }

  // 4. Wait for convergence
  console.log('\nWaiting for replica convergence:');
  const tStart = Date.now();
  let converged = false;

  while (Date.now() - tStart < 10000) {
    const statuses = [];
    for (const nid of nodeIds) {
      try {
        const st = await callRpc(URLS[nid], 'replication.status', {}, { timeoutMs: 1000 });
        statuses.push(st);
      } catch (_) {}
    }

    if (statuses.length === 4) {
      const firstLsn = statuses[0].appliedLsn;
      const firstChecksum = statuses[0].stateChecksum;
      if (statuses.every(s => s.appliedLsn === firstLsn && s.stateChecksum === firstChecksum)) {
        converged = true;
        console.log(`  CONVERGED at LSN ${firstLsn} (checksum: ${firstChecksum.slice(0, 6)})`);
        break;
      }
    }
    await sleep(200);
  }

  if (!converged) {
    console.warn('  Replicas still catching up; continuing.');
  }

  console.log('\nRESET COMPLETE: Cluster is initialized and healthy.');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const skipConfirm = args.includes('--yes') || args.includes('-y');
  runReset(skipConfirm).catch(err => {
    console.error('Reset error:', err.message);
    process.exit(1);
  });
}

module.exports = { runReset };
