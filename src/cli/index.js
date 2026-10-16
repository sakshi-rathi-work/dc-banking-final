// src/cli/index.js: Terminal CLI supporting interactive and non-interactive RPC commands
const crypto = require('crypto');
const { callRpc } = require('../shared/rpc/client');
const { loadConfig } = require('../shared/config');
const { createMeta, appendTrace } = require('../shared/rpc/meta');
const {
  renderTrace,
  renderRpcResult,
  renderClocksTable,
  renderBerkeleySync,
  renderEventOrdering,
  renderReplicationStatus
} = require('./render');
const { compareEventOrdering } = require('../clocks/ordering');

function resolveNodeUrl(nodeId, config) {
  const peers = Object.keys(config.peers).length > 0 ? config.peers : {
    a: { nodeId: 'a', url: 'http://localhost:3001' },
    b: { nodeId: 'b', url: 'http://localhost:3002' },
    c: { nodeId: 'c', url: 'http://localhost:3003' },
    d: { nodeId: 'd', url: 'http://localhost:3004' }
  };
  const peer = peers[nodeId.toLowerCase()];
  if (!peer) return null;
  let targetUrl = peer.url;
  if (targetUrl.includes('bank-node-') && !process.env.HOSTNAME?.startsWith('bank-')) {
    const portMap = { a: 3001, b: 3002, c: 3003, d: 3004 };
    targetUrl = `http://localhost:${portMap[nodeId.toLowerCase()] || 3001}`;
  }
  return targetUrl;
}

async function handleClocksCommand(args, config) {
  const sub = args[0] || 'view';

  if (sub === 'view') {
    const clocks = [];
    const nodeIds = ['a', 'b', 'c', 'd'];

    for (const nid of nodeIds) {
      const url = resolveNodeUrl(nid, config);
      try {
        const c = await callRpc(url, 'clock.get', {}, { timeoutMs: 1500 });
        clocks.push(c);
      } catch (err) {
        clocks.push({ nodeId: nid, offsetMs: 'ERR', physicalTs: 0, iso: 'UNREACHABLE', lamport: '?' });
      }
    }

    try {
      const coordClock = await callRpc(config.coordinatorUrl, 'clock.get', {}, { timeoutMs: 1500 });
      clocks.push({ nodeId: 'coord', ...coordClock });
    } catch (err) {
      clocks.push({ nodeId: 'coord', offsetMs: 'ERR', physicalTs: 0, iso: 'UNREACHABLE', lamport: '?' });
    }

    console.log('CLOCKS > View Clocks');
    console.log(renderClocksTable(clocks));
  } else if (sub === 'sync') {
    const outlierMs = args[1] ? Number(args[1]) : undefined;
    try {
      const report = await callRpc(config.coordinatorUrl, 'clock.sync', { outlierMs }, { timeoutMs: 5000 });
      console.log('CLOCKS > Synchronize (Berkeley)');
      console.log(renderBerkeleySync(report));
    } catch (err) {
      console.error('Berkeley sync failed:', err.message);
      process.exit(1);
    }
  } else if (sub === 'set') {
    const targetNode = args[1];
    const offsetMs = Number(args[2]);
    const driftPpm = args[3] ? Number(args[3]) : 0;

    if (!targetNode || isNaN(offsetMs)) {
      console.error('Usage: cli clocks set <nodeId> <offsetMs> [driftPpm]');
      process.exit(1);
    }

    const url = targetNode.toLowerCase() === 'coordinator' || targetNode.toLowerCase() === 'coord'
      ? config.coordinatorUrl
      : resolveNodeUrl(targetNode, config);

    try {
      const res = await callRpc(url, 'clock.setOffset', { offsetMs, driftPpm }, { timeoutMs: 2000 });
      console.log(`Node ${targetNode} clock offset set to ${offsetMs} ms (drift: ${driftPpm} ppm)`);
      console.log(`Current physicalTs: ${res.physicalTs} (${res.iso})`);
    } catch (err) {
      console.error(`Failed to set offset on ${targetNode}:`, err.message);
      process.exit(1);
    }
  } else if (sub === 'order') {
    const reqId = args[1];
    const events = [];
    const nodeIds = ['a', 'b', 'c', 'd'];

    for (const nid of nodeIds) {
      const url = resolveNodeUrl(nid, config);
      try {
        const res = await callRpc(url, 'clock.events', { requestId: reqId, limit: 50 }, { timeoutMs: 1500 });
        for (const ev of (res.events || [])) {
          events.push({
            node: nid,
            event: ev.event_type,
            physicalTs: ev.physical_ts,
            lamport: ev.lamport,
            id: ev.id
          });
        }
      } catch (err) {
        // ignore
      }
    }

    const orderingReport = compareEventOrdering(events);
    console.log(renderEventOrdering(orderingReport, reqId || 'All Recent Events'));
  } else {
    console.error(`Unknown clocks subcommand: ${sub}. Use: view, sync, set, order`);
    process.exit(1);
  }
}

async function handleRpcCommand(args, config) {
  let targetUrl = config.coordinatorUrl;
  let directNode = null;

  // Check for --node=a flag
  const remainingArgs = [];
  for (const arg of args) {
    if (arg.startsWith('--node=')) {
      directNode = arg.split('=')[1].toLowerCase();
      targetUrl = resolveNodeUrl(directNode, config);
      if (!targetUrl) {
        console.error(`Unknown node "${directNode}".`);
        process.exit(1);
      }
    } else {
      remainingArgs.push(arg);
    }
  }

  const sub = remainingArgs[0];
  let method;
  let params = {};

  if (!sub) {
    console.error('Usage: cli rpc [--node=<id>] <method|operation> [args...]');
    process.exit(1);
  }

  const idempotencyKey = `idem-cli-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

  if (sub.includes('.')) {
    // Direct method name e.g. bank.deposit
    method = sub;
    if (remainingArgs[1]) {
      try {
        params = JSON.parse(remainingArgs[1]);
      } catch (e) {
        console.error('Failed to parse params JSON:', e.message);
        process.exit(1);
      }
    }
  } else if (sub === 'createAccount') {
    method = 'bank.createAccount';
    params = {
      holderName: remainingArgs[1] || 'Demo Account',
      openingDeposit: remainingArgs[2] || '0.00',
      idempotencyKey
    };
  } else if (sub === 'deposit') {
    method = 'bank.deposit';
    params = {
      accountId: remainingArgs[1],
      amount: remainingArgs[2],
      idempotencyKey: remainingArgs[3] || idempotencyKey
    };
  } else if (sub === 'withdraw') {
    method = 'bank.withdraw';
    params = {
      accountId: remainingArgs[1],
      amount: remainingArgs[2],
      idempotencyKey: remainingArgs[3] || idempotencyKey
    };
  } else if (sub === 'transfer') {
    method = 'bank.transfer';
    params = {
      fromAccountId: remainingArgs[1],
      toAccountId: remainingArgs[2],
      amount: remainingArgs[3],
      idempotencyKey: remainingArgs[4] || idempotencyKey
    };
  } else if (sub === 'balance') {
    method = 'bank.getBalance';
    params = { accountId: remainingArgs[1] };
  } else if (sub === 'history') {
    method = 'bank.getHistory';
    params = { accountId: remainingArgs[1] || undefined, limit: remainingArgs[2] || 10 };
  } else {
    method = sub;
  }

  const meta = createMeta({ from: 'cli' });
  const targetLabel = directNode ? `node-${directNode}` : 'coordinator';
  appendTrace(meta, `cli -> ${targetLabel} (${method})`, 0, 'cli');

  const tStart = process.hrtime();
  params._meta = meta;

  try {
    const result = await callRpc(targetUrl, method, params, { timeoutMs: 15000 });
    const [s, ns] = process.hrtime(tStart);
    const durationMs = s * 1000 + ns / 1e6;

    const resMeta = (result && result._meta) ? result._meta : meta;
    appendTrace(resMeta, `cli <- ${targetLabel} (SUCCESS)`, durationMs, 'cli');

    console.log(renderTrace(resMeta.trace));
    console.log('');
    console.log(renderRpcResult(result, durationMs));
  } catch (err) {
    const [s, ns] = process.hrtime(tStart);
    const durationMs = s * 1000 + ns / 1e6;
    const errMeta = (err.data && err.data._meta) ? err.data._meta : meta;
    appendTrace(errMeta, `cli <- ${targetLabel} (ERROR ${err.code || ''})`, durationMs, 'cli');

    console.log(renderTrace(errMeta.trace));
    console.log('');
    console.error(`ERROR ${err.code || -32603} ${err.message || ''}`);
    if (err.data) {
      console.error(JSON.stringify(err.data, null, 2));
    }
    process.exit(1);
  }
}

async function handleReplicationCommand(args, config) {
  const sub = args[0] || 'status';

  if (sub === 'status') {
    const accountId = args[1] || 'ACC-0001';
    const nodeIds = ['a', 'b', 'c', 'd'];
    const statusList = [];

    // First fetch leader status to get peer lastAckMs
    let peerAcks = {};
    for (const nid of nodeIds) {
      const url = resolveNodeUrl(nid, config);
      try {
        const ls = await callRpc(url, 'replication.leaderStatus', {}, { timeoutMs: 1500 });
        if (ls && ls.peers) {
          peerAcks = ls.peers;
          break;
        }
      } catch (_) {}
    }

    for (const nid of nodeIds) {
      const url = resolveNodeUrl(nid, config);
      try {
        const st = await callRpc(url, 'replication.status', {}, { timeoutMs: 1500 });
        let balance = '-';
        try {
          const balRes = await callRpc(url, 'bank.getBalance', { accountId, consistency: 'eventual' }, { timeoutMs: 1500 });
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
      } catch (err) {
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

    console.log('REPLICATION > Replication Status');
    console.log(renderReplicationStatus(statusList, accountId));
  } else if (sub === 'mode') {
    const mode = (args[1] || 'ASYNC').toUpperCase();
    const syncAcks = args[2] ? Number(args[2]) : 2;
    const leaderUrl = resolveNodeUrl('a', config);

    try {
      const res = await callRpc(leaderUrl, 'replication.setMode', { mode, syncAcks }, { timeoutMs: 5000 });
      console.log(`REPLICATION > Set Mode: ${mode}${syncAcks ? `   syncAcks=${syncAcks}` : ''}`);
      console.log(`Committed mode change at LSN ${res.lsn}`);
    } catch (err) {
      console.error('Failed to set replication mode:', err.message);
      process.exit(1);
    }
  } else if (sub === 'wait-convergence') {
    const timeoutSec = args[1] ? Number(args[1]) : 10;
    const tStart = Date.now();
    const nodeIds = ['a', 'b', 'c', 'd'];

    while (Date.now() - tStart < timeoutSec * 1000) {
      const statuses = [];
      for (const nid of nodeIds) {
        const url = resolveNodeUrl(nid, config);
        try {
          const s = await callRpc(url, 'replication.status', {}, { timeoutMs: 1000 });
          statuses.push(s);
        } catch (_) {}
      }

      if (statuses.length === 4) {
        const firstLsn = statuses[0].appliedLsn;
        const firstChecksum = statuses[0].stateChecksum;
        const allEqualLsn = statuses.every(s => s.appliedLsn === firstLsn);
        const allEqualChecksum = statuses.every(s => s.stateChecksum === firstChecksum);

        if (allEqualLsn && allEqualChecksum) {
          const elapsedSec = ((Date.now() - tStart) / 1000).toFixed(2);
          console.log(`REPLICATION > Wait for Convergence`);
          console.log(`t+${elapsedSec} s   converged   lsn ${firstLsn} on a,b,c,d   checksum ${firstChecksum.slice(0, 6)} equal   PASS`);
          return;
        }
      }
      await new Promise(r => setTimeout(r, 200));
    }

    console.error(`REPLICATION > Wait for Convergence   FAILED (timed out after ${timeoutSec}s)`);
    process.exit(1);
  } else if (sub === 'resend') {
    const toPeer = args[1];
    const fromLsn = Number(args[2]);
    const toLsn = Number(args[3]);
    const leaderUrl = resolveNodeUrl('a', config);

    try {
      const res = await callRpc(leaderUrl, 'replication.resend', { toPeer, fromLsn, toLsn }, { timeoutMs: 5000 });
      console.log(`REPLICATION > Resend to ${toPeer} lsn ${fromLsn}..${toLsn}: sent ${res.sentCount} entries`);
    } catch (err) {
      console.error('Resend failed:', err.message);
      process.exit(1);
    }
  } else {
    console.error(`Unknown repl subcommand: ${sub}`);
    process.exit(1);
  }
}

async function main() {
  const config = loadConfig();
  const rawArgs = process.argv.slice(2);
  const raw = rawArgs.includes('--raw');
  const args = rawArgs.filter(a => a !== '--raw');

  if (args[0] === 'rpc') {
    await handleRpcCommand(args.slice(1), config);
    return;
  }

  if (args[0] === 'clocks') {
    await handleClocksCommand(args.slice(1), config);
    return;
  }

  if (args[0] === 'repl' || args[0] === 'replication') {
    await handleReplicationCommand(args.slice(1), config);
    return;
  }

  if (args[0] === 'history') {
    const { handleViewHistory } = require('./experiments/cluster');
    const dummyPrompt = async () => '';
    await handleViewHistory(dummyPrompt, config);
    return;
  }

  if (args[0] === 'invariants') {
    const { handleVerifyInvariants } = require('./experiments/cluster');
    await handleVerifyInvariants();
    return;
  }

  if (args[0] === 'status') {
    const { handleViewClusterStatus } = require('./experiments/cluster');
    await handleViewClusterStatus(config);
    return;
  }

  // If no subcommand is specified, start the interactive terminal menu (Section 23.2)
  const { runInteractiveMenu } = require('./menu');
  await runInteractiveMenu(config, raw);
}

if (require.main === module) {
  main().catch(err => {
    console.error('CLI error:', err);
    process.exit(1);
  });
}

module.exports = { main, handleRpcCommand, handleClocksCommand, handleReplicationCommand };

