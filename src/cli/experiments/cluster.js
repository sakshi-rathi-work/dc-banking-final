// src/cli/experiments/cluster.js: Menus 8 to 12 - Cluster, History, Invariants, Faults, Reset
// Specification: PROJECT.md Section 23.2, Section 24

const { callRpc } = require('../../shared/rpc/client');
const {
  renderClusterTable,
  renderTransactionHistory,
  renderInvariantsReport,
  renderFaultsTable
} = require('../render');
const { runReset } = require('../../../scripts/demo-reset');

const URLS = {
  a: 'http://localhost:3001',
  b: 'http://localhost:3002',
  c: 'http://localhost:3003',
  d: 'http://localhost:3004'
};

async function handleViewClusterStatus(config) {
  const nodes = [];
  for (const nid of ['a', 'b', 'c', 'd']) {
    try {
      const st = await callRpc(URLS[nid], 'cluster.getState', {}, { timeoutMs: 1500 });
      nodes.push(st);
    } catch (err) {
      nodes.push({ nodeId: nid, role: 'down', dbHealthy: false, leaseValid: false });
    }
  }

  console.log('\nCLUSTER STATUS:');
  console.log(renderClusterTable(nodes));
}

async function handleViewHistory(prompt, config) {
  const accountId = await prompt('Filter by Account ID (leave blank for all): ');
  const limit = Number((await prompt('Limit [20]: ')) || 20);

  try {
    const res = await callRpc(config.coordinatorUrl, 'bank.getHistory', {
      accountId: accountId || undefined,
      limit
    });
    console.log(`\nTRANSACTION HISTORY ${accountId ? `(${accountId})` : '(GLOBAL)'}:`);
    console.log(renderTransactionHistory(res.transactions || []));
  } catch (err) {
    console.error('History error:', err.message);
  }
}

async function handleVerifyInvariants() {
  const reports = [];
  for (const nid of ['a', 'b', 'c', 'd']) {
    try {
      const rep = await callRpc(URLS[nid], 'admin.verifyInvariants', {}, { timeoutMs: 3000 });
      reports.push(rep);
    } catch (err) {
      reports.push({ nodeId: nid, passed: false, checksum: null, invariants: {} });
    }
  }

  console.log('\nBANKING INVARIANTS (I1-I12):');
  console.log(renderInvariantsReport(reports));

  const allPassed = reports.length === 4 && reports.every(r => r.passed);
  const checksums = reports.map(r => r.checksum).filter(Boolean);
  const allChecksumsEqual = checksums.length === 4 && checksums.every(c => c === checksums[0]);

  console.log(`\nAll invariants pass: ${allPassed ? 'PASS' : 'FAIL'}   Cross-node checksum equal: ${allChecksumsEqual ? 'PASS' : 'FAIL'}`);
}

async function handleFaultPanel(prompt) {
  while (true) {
    console.log('\n--- 11. Fault Injection & Node Control ---');
    console.log('1. View Active Fault Knobs (All Nodes)');
    console.log('2. Set Fault Knob');
    console.log('3. Clear Faults on a Node');
    console.log('4. Clear Faults on ALL Nodes');
    console.log('0. Back to Main Menu');

    const choice = await prompt('\nSelect an option: ');
    if (choice === '0') break;

    switch (choice) {
      case '1': {
        const faultsList = [];
        for (const nid of ['a', 'b', 'c', 'd']) {
          try {
            const res = await callRpc(URLS[nid], 'cluster.getFaults', {}, { timeoutMs: 1500 });
            for (const [knob, value] of Object.entries(res.faults || {})) {
              faultsList.push({ nodeId: nid, knob, value });
            }
          } catch (_) {}
        }
        console.log('\nACTIVE FAULT KNOBS:');
        console.log(renderFaultsTable(faultsList));
        break;
      }
      case '2': {
        const nid = (await prompt('Node (a, b, c, d) [a]: ')) || 'a';
        console.log('Common knobs: rpcDelayMs, isolate, blockFetch, replicationDelayMs_b, blockReplicationTo');
        const knob = await prompt('Knob name: ');
        const rawVal = await prompt('Value (number, boolean, or string): ');
        let value = rawVal;
        if (rawVal === 'true') value = true;
        else if (rawVal === 'false') value = false;
        else if (!isNaN(Number(rawVal))) value = Number(rawVal);

        try {
          await callRpc(URLS[nid.toLowerCase()] || URLS.a, 'cluster.setFault', { knob, value });
          console.log(`Fault set on Node ${nid}: ${knob} = ${JSON.stringify(value)}`);
        } catch (err) {
          console.error('Fault error:', err.message);
        }
        break;
      }
      case '3': {
        const nid = (await prompt('Node (a, b, c, d) [a]: ')) || 'a';
        try {
          await callRpc(URLS[nid.toLowerCase()] || URLS.a, 'cluster.clearFaults', {});
          console.log(`Cleared faults on Node ${nid}.`);
        } catch (err) {
          console.error('Clear error:', err.message);
        }
        break;
      }
      case '4': {
        for (const nid of ['a', 'b', 'c', 'd']) {
          try {
            await callRpc(URLS[nid], 'cluster.clearFaults', {});
          } catch (_) {}
        }
        console.log('Cleared all faults on all nodes.');
        break;
      }
      default:
        console.log('Invalid choice.');
    }
  }
}

async function handleResetDemoData(prompt) {
  console.log('\n--- 12. Reset Demo Data ---');
  console.log('WARNING: This will reset all 4 nodes, clear existing history, and re-seed demo accounts.');
  const confirm = await prompt('Type RESET in capital letters to confirm: ');

  if (confirm !== 'RESET') {
    console.log('Reset cancelled.');
    return;
  }

  try {
    await runReset(true);
  } catch (err) {
    console.error('Reset failed:', err.message);
  }
}

module.exports = {
  handleViewClusterStatus,
  handleViewHistory,
  handleVerifyInvariants,
  handleFaultPanel,
  handleResetDemoData
};
