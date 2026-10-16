// src/cli/experiments/clocks.js: Experiment 3 - Clock Synchronization
// Specification: PROJECT.md Section 17, Section 23.3, Section 24.3

const crypto = require('crypto');
const { callRpc } = require('../../shared/rpc/client');
const { renderClocksTable, renderBerkeleySync, renderEventOrdering } = require('../render');
const { compareEventOrdering } = require('../../clocks/ordering');
const { executeRpc } = require('./rpc');

const URLS = {
  a: 'http://localhost:3001',
  b: 'http://localhost:3002',
  c: 'http://localhost:3003',
  d: 'http://localhost:3004'
};

async function handleClocksMenu(prompt, config, raw = false) {
  while (true) {
    console.log('\n--- 3. Clock Synchronization ---');
    console.log('1. View Clocks (Offsets & Lamport)');
    console.log('2. Set Clock Offset');
    console.log('3. Synchronize Clocks (Berkeley Algorithm)');
    console.log('4. Compare Event Ordering (Lamport vs Physical)');
    console.log('5. View Event Log');
    console.log('6. Deposit / Transfer (Generate Timestamps)');
    console.log('0. Back to Main Menu');

    const choice = await prompt('\nSelect an option: ');
    if (choice === '0') break;

    switch (choice) {
      case '1': {
        const clocks = [];
        for (const nid of ['a', 'b', 'c', 'd']) {
          try {
            const c = await callRpc(URLS[nid], 'clock.get', {}, { timeoutMs: 1500 });
            clocks.push(c);
          } catch (_) {
            clocks.push({ nodeId: nid, offsetMs: 'ERR', physicalTs: 0, iso: 'DOWN', lamport: '?' });
          }
        }
        try {
          const coord = await callRpc(config.coordinatorUrl, 'clock.get', {}, { timeoutMs: 1500 });
          clocks.push({ nodeId: 'coord', ...coord });
        } catch (_) {}

        console.log('\nCLOCKS > View Clocks');
        console.log(renderClocksTable(clocks));
        break;
      }
      case '2': {
        const targetNode = (await prompt('Node (a, b, c, d, coord) [b]: ')) || 'b';
        const offsetMs = Number((await prompt('Offset ms [+2500]: ')) || 2500);
        const driftPpm = Number((await prompt('Drift ppm [0]: ')) || 0);

        const url = (targetNode.toLowerCase() === 'coord' || targetNode.toLowerCase() === 'coordinator')
          ? config.coordinatorUrl
          : URLS[targetNode.toLowerCase()] || URLS.b;

        try {
          const res = await callRpc(url, 'clock.setOffset', { offsetMs, driftPpm }, { timeoutMs: 2000 });
          console.log(`Node ${targetNode} clock offset set to ${offsetMs} ms (drift: ${driftPpm} ppm)`);
          console.log(`Current physicalTs: ${res.physicalTs} (${res.iso})`);
        } catch (err) {
          console.error('Set offset error:', err.message);
        }
        break;
      }
      case '3': {
        try {
          const report = await callRpc(config.coordinatorUrl, 'clock.sync', {}, { timeoutMs: 5000 });
          console.log('\nCLOCKS > Synchronize (Berkeley)');
          console.log(renderBerkeleySync(report));
        } catch (err) {
          console.error('Berkeley sync error:', err.message);
        }
        break;
      }
      case '4': {
        const reqId = await prompt('Request ID (leave blank for all recent): ');
        const events = [];
        for (const nid of ['a', 'b', 'c', 'd']) {
          try {
            const res = await callRpc(URLS[nid], 'clock.events', { requestId: reqId || undefined, limit: 50 }, { timeoutMs: 1500 });
            for (const ev of (res.events || [])) {
              events.push({
                node: nid,
                event: ev.event_type,
                physicalTs: ev.physical_ts,
                lamport: ev.lamport,
                id: ev.id
              });
            }
          } catch (_) {}
        }
        const orderingReport = compareEventOrdering(events);
        console.log(renderEventOrdering(orderingReport, reqId || 'All Recent Events'));
        break;
      }
      case '5': {
        const nid = (await prompt('Node ID (a, b, c, d) [a]: ')) || 'a';
        try {
          const res = await callRpc(URLS[nid.toLowerCase()] || URLS.a, 'admin.getEvents', { limit: 15 });
          console.log(`Recent events on Node ${nid}:`);
          for (const ev of (res.events || [])) {
            console.log(`  [id=${ev.id}] ${ev.event_type} L=${ev.lamport} ts=${ev.physical_ts} txn=${ev.txn_id || '-'}`);
          }
        } catch (err) {
          console.error('Event log error:', err.message);
        }
        break;
      }
      case '6': {
        const key = `idem-clock-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
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

module.exports = { handleClocksMenu };
