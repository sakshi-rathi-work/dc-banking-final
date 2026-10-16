// src/cli/experiments/faultTolerance.js: Experiment 7 - Primary-Backup Fault Tolerance
// Specification: PROJECT.md Section 21, Section 22, Section 23.3, Section 24.7

const crypto = require('crypto');
const { callRpc } = require('../../shared/rpc/client');
const { renderClusterTable } = require('../render');
const { executeRpc } = require('./rpc');

const URLS = {
  a: 'http://localhost:3001',
  b: 'http://localhost:3002',
  c: 'http://localhost:3003',
  d: 'http://localhost:3004'
};

async function handleFaultToleranceMenu(prompt, config, raw = false) {
  while (true) {
    console.log('\n--- 7. Primary-Backup Fault Tolerance ---');
    console.log('1. View Cluster Roles & Leases');
    console.log('2. Test Primary Lease Fencing (Isolate Primary)');
    console.log('3. Trigger Failover / Backup Promotion');
    console.log('4. Refusal Scenario: NO_QUORUM (< 3 grants)');
    console.log('5. Refusal Scenario: STALE_CANDIDATE (blockFetch)');
    console.log('6. Rejoin Node (Binary Search Common Prefix)');
    console.log('7. Clear All Faults');
    console.log('8. Deposit / Transfer (Test Writing on Active Leader)');
    console.log('0. Back to Main Menu');

    const choice = await prompt('\nSelect an option: ');
    if (choice === '0') break;

    switch (choice) {
      case '1': {
        const nodes = [];
        for (const nid of ['a', 'b', 'c', 'd']) {
          try {
            const st = await callRpc(URLS[nid], 'cluster.getState', {}, { timeoutMs: 1500 });
            nodes.push(st);
          } catch (_) {
            nodes.push({ nodeId: nid, role: 'down', dbHealthy: false, leaseValid: false });
          }
        }
        console.log('\nFAULT TOLERANCE > Cluster Overview');
        console.log(renderClusterTable(nodes));
        break;
      }
      case '2': {
        // T27: Isolate Primary
        console.log('Injecting isolate fault on Node A (simulating network partition / lease loss)...');
        try {
          await callRpc(URLS.a, 'cluster.setFault', { knob: 'isolate', value: true });
          console.log('Lease expiring within 3s. Attempting write to isolated primary:');
          await executeRpc(URLS.a, 'bank.deposit', {
            accountId: 'ACC-0001',
            amount: '10.00',
            idempotencyKey: `iso-${Date.now()}`
          }, raw);
        } catch (err) {
          console.log(`Write successfully fenced: ${err.message}`);
        } finally {
          await callRpc(URLS.a, 'cluster.clearFaults', {});
          console.log('Cleared isolation fault on Node A.');
        }
        break;
      }
      case '3': {
        // T24: Promote backup
        const target = (await prompt('Promote successor node (b, c, d) [b]: ')) || 'b';
        console.log(`Starting Bully promotion on Node ${target}...`);
        try {
          const res = await callRpc(URLS[target.toLowerCase()] || URLS.b, 'election.start', {
            algorithm: 'bully',
            excluded: ['a']
          }, { timeoutMs: 15000 });
          console.log(`Promotion complete: winner=${res.winner}   promoted=${res.promoted}   epoch=${res.promotionResult ? res.promotionResult.epoch : '-'}`);
        } catch (err) {
          console.error('Promotion error:', err.message);
        }
        break;
      }
      case '4': {
        // T25: NO_QUORUM
        console.log('Testing promotion refusal with NO_QUORUM (excluding 2 of 4 nodes)...');
        try {
          await callRpc(URLS.c, 'election.start', {
            algorithm: 'bully',
            excluded: ['a', 'b']
          }, { timeoutMs: 10000 });
          console.log('Unexpected: promotion succeeded without quorum.');
        } catch (err) {
          console.log(`Correctly refused: code=${err.code}   reason=${err.data ? err.data.reason : err.message}`);
        }
        break;
      }
      case '5': {
        // T26: STALE_CANDIDATE
        console.log('Injecting blockFetch on Node D to force stale candidate refusal...');
        try {
          await callRpc(URLS.d, 'cluster.setFault', { knob: 'blockFetch', value: true });
          await callRpc(URLS.d, 'election.start', { algorithm: 'ring', excluded: ['a'] }, { timeoutMs: 10000 });
        } catch (err) {
          console.log(`Correctly refused stale candidate: ${err.message}`);
        } finally {
          await callRpc(URLS.d, 'cluster.clearFaults', {});
        }
        break;
      }
      case '6': {
        const nid = (await prompt('Node to rejoin (a, b, c, d) [a]: ')) || 'a';
        console.log(`Initiating rejoin for Node ${nid}...`);
        try {
          const res = await callRpc(URLS[nid.toLowerCase()] || URLS.a, 'cluster.rejoin', {});
          console.log(`Rejoin complete: success=${res.success}   commonPrefixLsn=${res.commonPrefixLsn}   divergentArchived=${res.divergentCount}   caughtUp=${res.caughtUpCount}`);
        } catch (err) {
          console.error('Rejoin error:', err.message);
        }
        break;
      }
      case '7': {
        for (const nid of ['a', 'b', 'c', 'd']) {
          try {
            await callRpc(URLS[nid], 'cluster.clearFaults', {});
          } catch (_) {}
        }
        console.log('Cleared all faults on all nodes.');
        break;
      }
      case '8': {
        const key = `idem-ft-wr-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
        await executeRpc(config.coordinatorUrl, 'bank.deposit', {
          accountId: 'ACC-0001',
          amount: '50.00',
          idempotencyKey: key
        }, raw);
        break;
      }
      default:
        console.log('Invalid choice.');
    }
  }
}

module.exports = { handleFaultToleranceMenu };
