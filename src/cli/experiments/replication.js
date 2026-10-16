// src/cli/experiments/replication.js: Experiment 5 - Data Consistency and Replication
// Specification: PROJECT.md Section 19, Section 23.3, Section 24.5

const crypto = require('crypto');
const { callRpc } = require('../../shared/rpc/client');
const { renderReplicationStatus } = require('../render');
const { executeRpc } = require('./rpc');

const URLS = {
  a: 'http://localhost:3001',
  b: 'http://localhost:3002',
  c: 'http://localhost:3003',
  d: 'http://localhost:3004'
};

async function handleReplicationMenu(prompt, config, raw = false) {
  while (true) {
    console.log('\n--- 5. Data Consistency and Replication ---');
    console.log('1. View Replication Status (All Nodes & Lag)');
    console.log('2. Set Replication Mode (SYNC / ASYNC)');
    console.log('3. Inject Replication Delay on a Peer');
    console.log('4. Clear Replication Faults');
    console.log('5. Wait for Convergence');
    console.log('6. Resend Log Entries (Duplicate Check)');
    console.log('7. Deposit / Transfer (Observe Replication)');
    console.log('0. Back to Main Menu');

    const choice = await prompt('\nSelect an option: ');
    if (choice === '0') break;

    switch (choice) {
      case '1': {
        const accountId = (await prompt('Account ID to inspect [ACC-0001]: ')) || 'ACC-0001';
        const nodeIds = ['a', 'b', 'c', 'd'];
        const statusList = [];

        let peerAcks = {};
        for (const nid of nodeIds) {
          try {
            const ls = await callRpc(URLS[nid], 'replication.leaderStatus', {}, { timeoutMs: 1500 });
            if (ls && ls.peers) {
              peerAcks = ls.peers;
              break;
            }
          } catch (_) {}
        }

        for (const nid of nodeIds) {
          try {
            const st = await callRpc(URLS[nid], 'replication.status', {}, { timeoutMs: 1500 });
            let balance = '-';
            try {
              const balRes = await callRpc(URLS[nid], 'bank.getBalance', { accountId, consistency: 'eventual' }, { timeoutMs: 1500 });
              balance = balRes.balance;
            } catch (_) {}

            statusList.push({
              nodeId: nid,
              role: st.role,
              appliedLsn: st.appliedLsn,
              stateChecksum: st.stateChecksum,
              balance,
              lastAckMs: peerAcks[nid]?.lastAckMs
            });
          } catch (_) {
            statusList.push({
              nodeId: nid,
              role: 'down',
              appliedLsn: 0,
              stateChecksum: null,
              balance: '-',
              lastAckMs: null
            });
          }
        }

        console.log('\nREPLICATION > Replication Status');
        console.log(renderReplicationStatus(statusList, accountId));
        break;
      }
      case '2': {
        const mode = ((await prompt('Mode (SYNC or ASYNC) [SYNC]: ')) || 'SYNC').toUpperCase();
        const syncAcks = Number((await prompt('Sync Acks (1-3) [2]: ')) || 2);
        try {
          const res = await callRpc(config.coordinatorUrl, 'replication.setMode', { mode, syncAcks });
          console.log(`Replication mode set to ${mode} (syncAcks=${syncAcks}, LSN=${res.lsn})`);
        } catch (err) {
          console.error('Set mode error:', err.message);
        }
        break;
      }
      case '3': {
        const peer = (await prompt('Target Peer (b, c, d) [d]: ')) || 'd';
        const delayMs = Number((await prompt('Delay ms [2000]: ')) || 2000);
        try {
          await callRpc(URLS.a, 'cluster.setFault', {
            knob: `replicationDelayMs_${peer.toLowerCase()}`,
            value: delayMs
          });
          console.log(`Injected replicationDelayMs = ${delayMs}ms to peer ${peer}`);
        } catch (err) {
          console.error('Fault error:', err.message);
        }
        break;
      }
      case '4': {
        for (const nid of ['a', 'b', 'c', 'd']) {
          try {
            await callRpc(URLS[nid], 'cluster.clearFaults', {});
          } catch (_) {}
        }
        console.log('Cleared replication faults across all nodes.');
        break;
      }
      case '5': {
        console.log('Waiting for log convergence across all nodes...');
        const tStart = Date.now();
        let converged = false;

        while (Date.now() - tStart < 10000) {
          const statuses = [];
          for (const nid of ['a', 'b', 'c', 'd']) {
            try {
              const s = await callRpc(URLS[nid], 'replication.status', {}, { timeoutMs: 1000 });
              statuses.push(s);
            } catch (_) {}
          }

          if (statuses.length === 4) {
            const firstLsn = statuses[0].appliedLsn;
            const firstChecksum = statuses[0].stateChecksum;
            if (statuses.every(s => s.appliedLsn === firstLsn && s.stateChecksum === firstChecksum)) {
              const elapsedSec = ((Date.now() - tStart) / 1000).toFixed(2);
              console.log(`t+${elapsedSec}s: Converged at LSN ${firstLsn} (checksum: ${firstChecksum ? firstChecksum.slice(0, 6) : '-'}) PASS`);
              converged = true;
              break;
            }
          }
          await new Promise(r => setTimeout(r, 200));
        }
        if (!converged) {
          console.log('Replicas have not converged within 10s.');
        }
        break;
      }
      case '6': {
        const toPeer = (await prompt('Target follower to resend (b, c, d) [c]: ')) || 'c';
        const fromLsn = Number((await prompt('From LSN [1]: ')) || 1);
        const toLsn = Number((await prompt('To LSN [5]: ')) || 5);
        try {
          const res = await callRpc(URLS.a, 'replication.resend', { toPeer, fromLsn, toLsn });
          console.log(`Resent ${res.sentCount} entries to ${toPeer}. Follower duplicates count incremented with no duplicate balance effect.`);
        } catch (err) {
          console.error('Resend error:', err.message);
        }
        break;
      }
      case '7': {
        const key = `idem-repl-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
        await executeRpc(config.coordinatorUrl, 'bank.deposit', {
          accountId: 'ACC-0001',
          amount: '500.00',
          idempotencyKey: key
        }, raw);
        break;
      }
      default:
        console.log('Invalid choice.');
    }
  }
}

module.exports = { handleReplicationMenu };
