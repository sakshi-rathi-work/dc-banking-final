// src/cli/experiments/election.js: Experiment 4 - Leader Election (Bully & Ring)
// Specification: PROJECT.md Section 18, Section 23.3, Section 24.4

const crypto = require('crypto');
const { callRpc } = require('../../shared/rpc/client');
const { executeRpc } = require('./rpc');

const URLS = {
  a: 'http://localhost:3001',
  b: 'http://localhost:3002',
  c: 'http://localhost:3003',
  d: 'http://localhost:3004'
};

async function handleElectionMenu(prompt, config, raw = false) {
  while (true) {
    console.log('\n--- 4. Leader Election ---');
    console.log('1. Run Bully Election');
    console.log('2. Run Ring Election');
    console.log('3. Competing Simultaneous Elections');
    console.log('4. View Election Messages');
    console.log('5. View Leader & Epoch on All Nodes');
    console.log('6. Deposit / Transfer (Verify New Leader)');
    console.log('0. Back to Main Menu');

    const choice = await prompt('\nSelect an option: ');
    if (choice === '0') break;

    switch (choice) {
      case '1': {
        const initiator = (await prompt('Initiator Node (a, b, c, d) [b]: ')) || 'b';
        const excludedStr = await prompt('Excluded Nodes comma-separated (e.g. d): ');
        const excluded = excludedStr ? excludedStr.split(',').map(s => s.trim().toLowerCase()) : [];

        console.log(`Starting Bully Election from Node ${initiator} (excluded: [${excluded.join(', ')}])...`);
        const url = URLS[initiator.toLowerCase()] || URLS.b;
        try {
          const res = await callRpc(url, 'election.start', { algorithm: 'bully', excluded }, { timeoutMs: 15000 });
          console.log(`\nBully complete: winner=${res.winner}   promoted=${res.promoted}   electionId=${res.electionId}`);
          if (res.promotionResult) {
            console.log(`New Epoch: ${res.promotionResult.epoch}   backupId: ${res.promotionResult.backupId}`);
          }
        } catch (err) {
          console.error('Election error:', err.message);
        }
        break;
      }
      case '2': {
        const initiator = (await prompt('Initiator Node (a, b, c, d) [a]: ')) || 'a';
        const excludedStr = await prompt('Excluded Nodes comma-separated (e.g. c): ');
        const excluded = excludedStr ? excludedStr.split(',').map(s => s.trim().toLowerCase()) : [];

        console.log(`Starting Ring Election from Node ${initiator} (excluded: [${excluded.join(', ')}])...`);
        const url = URLS[initiator.toLowerCase()] || URLS.a;
        try {
          const res = await callRpc(url, 'election.start', { algorithm: 'ring', excluded }, { timeoutMs: 15000 });
          console.log(`\nRing complete: winner=${res.winner}   promoted=${res.promoted}   candidates=[${(res.candidates || []).join(',')}]`);
        } catch (err) {
          console.error('Election error:', err.message);
        }
        break;
      }
      case '3': {
        console.log('Starting simultaneous competing Bully elections from A and B...');
        try {
          const [resA, resB] = await Promise.all([
            callRpc(URLS.a, 'election.start', { algorithm: 'bully' }, { timeoutMs: 15000 }),
            callRpc(URLS.b, 'election.start', { algorithm: 'bully' }, { timeoutMs: 15000 })
          ]);
          console.log(`From A: winner=${resA.winner}   promoted=${resA.promoted}`);
          console.log(`From B: winner=${resB.winner}   promoted=${resB.promoted}`);
          console.log(`Convergence: winner agreed = ${resA.winner === resB.winner ? 'PASS' : 'FAIL'}`);
        } catch (err) {
          console.error('Competing elections error:', err.message);
        }
        break;
      }
      case '4': {
        const nid = (await prompt('Node ID (a, b, c, d) [b]: ')) || 'b';
        try {
          const res = await callRpc(URLS[nid.toLowerCase()] || URLS.b, 'election.getLog', { limit: 15 });
          console.log(`\nElection messages on Node ${nid}:`);
          console.log('id   dir       msgType             peer   lamport  ts');
          for (const m of (res.messages || [])) {
            const id = String(m.id).padEnd(4);
            const dir = String(m.direction).padEnd(9);
            const type = String(m.message_type).padEnd(19);
            const peer = String(m.peer_id || '-').padEnd(6);
            const lamp = String(m.lamport).padEnd(8);
            const ts = m.physical_ts;
            console.log(`${id} ${dir} ${type} ${peer} ${lamp} ${ts}`);
          }
        } catch (err) {
          console.error('Log error:', err.message);
        }
        break;
      }
      case '5': {
        console.log('\nCluster Leadership Overview:');
        for (const nid of ['a', 'b', 'c', 'd']) {
          try {
            const st = await callRpc(URLS[nid], 'cluster.getState', {}, { timeoutMs: 1500 });
            console.log(`  Node ${nid.toUpperCase()}: role=${st.role.padEnd(8)} epoch=${st.epoch} leader=${st.leaderId} backup=${st.backupId}`);
          } catch (_) {
            console.log(`  Node ${nid.toUpperCase()}: UNREACHABLE`);
          }
        }
        break;
      }
      case '6': {
        const key = `idem-elec-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
        await executeRpc(config.coordinatorUrl, 'bank.deposit', {
          accountId: 'ACC-0001',
          amount: '100.00',
          idempotencyKey: key
        }, raw);
        break;
      }
      default:
        console.log('Invalid choice.');
    }
  }
}

module.exports = { handleElectionMenu };
