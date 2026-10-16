// src/cli/menu.js: Main Interactive Terminal Menu and Dispatcher
// Specification: PROJECT.md Section 23.2

const readline = require('readline/promises');
const { callRpc } = require('../shared/rpc/client');
const { renderBanner } = require('./render');
const { handleRpcMenu } = require('./experiments/rpc');
const { handleMultithreadingMenu } = require('./experiments/multithreading');
const { handleClocksMenu } = require('./experiments/clocks');
const { handleElectionMenu } = require('./experiments/election');
const { handleReplicationMenu } = require('./experiments/replication');
const { handleLoadBalancingMenu } = require('./experiments/loadBalancing');
const { handleFaultToleranceMenu } = require('./experiments/faultTolerance');
const {
  handleViewClusterStatus,
  handleViewHistory,
  handleVerifyInvariants,
  handleFaultPanel,
  handleResetDemoData
} = require('./experiments/cluster');

const URLS = {
  a: 'http://localhost:3001',
  b: 'http://localhost:3002',
  c: 'http://localhost:3003',
  d: 'http://localhost:3004'
};

async function fetchBannerInfo(config) {
  let leaderId = null;
  let epoch = 1;
  let replicationMode = 'ASYNC';
  let upCount = 0;

  for (const nid of ['a', 'b', 'c', 'd']) {
    try {
      const st = await callRpc(URLS[nid], 'cluster.getState', {}, { timeoutMs: 1000 });
      if (st) {
        upCount++;
        if (st.role === 'primary') {
          leaderId = nid;
          epoch = st.epoch;
          replicationMode = st.replicationMode || replicationMode;
        }
      }
    } catch (_) {}
  }

  return {
    leaderId: leaderId || 'a',
    epoch,
    replicationMode,
    nodesUp: `${upCount}/4`
  };
}

async function runInteractiveMenu(config, raw = false) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const prompt = (query) => rl.question(query);

  try {
    while (true) {
      const bannerInfo = await fetchBannerInfo(config);
      console.log('\n' + renderBanner(bannerInfo));
      console.log('\n1. Client-Server Communication (RPC)');
      console.log('2. Multithreading');
      console.log('3. Clock Synchronization');
      console.log('4. Leader Election');
      console.log('5. Data Consistency and Replication');
      console.log('6. Load Balancing');
      console.log('7. Primary-Backup Fault Tolerance');
      console.log('\n8. View Cluster Status');
      console.log('9. View Transaction History');
      console.log('10. Verify Banking Invariants');
      console.log('11. Fault Injection and Node Control');
      console.log('12. Reset Demo Data');
      console.log('0. Exit');

      const choice = await prompt('\nSelect an option: ');
      const cleanChoice = choice.trim();

      if (cleanChoice === '0') {
        console.log('Exiting Distributed Banking CLI.');
        break;
      }

      switch (cleanChoice) {
        case '1':
          await handleRpcMenu(prompt, config, raw);
          break;
        case '2':
          await handleMultithreadingMenu(prompt, config, raw);
          break;
        case '3':
          await handleClocksMenu(prompt, config, raw);
          break;
        case '4':
          await handleElectionMenu(prompt, config, raw);
          break;
        case '5':
          await handleReplicationMenu(prompt, config, raw);
          break;
        case '6':
          await handleLoadBalancingMenu(prompt, config, raw);
          break;
        case '7':
          await handleFaultToleranceMenu(prompt, config, raw);
          break;
        case '8':
          await handleViewClusterStatus(config);
          break;
        case '9':
          await handleViewHistory(prompt, config);
          break;
        case '10':
          await handleVerifyInvariants();
          break;
        case '11':
          await handleFaultPanel(prompt);
          break;
        case '12':
          await handleResetDemoData(prompt);
          break;
        default:
          console.log('Invalid option. Please select 0 to 12.');
      }
    }
  } finally {
    rl.close();
  }
}

module.exports = { runInteractiveMenu, fetchBannerInfo };
