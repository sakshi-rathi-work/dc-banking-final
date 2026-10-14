// src/cli/index.js: Terminal CLI supporting interactive and non-interactive RPC commands
const crypto = require('crypto');
const { callRpc } = require('../shared/rpc/client');
const { loadConfig } = require('../shared/config');
const { createMeta, appendTrace } = require('../shared/rpc/meta');
const { renderTrace, renderRpcResult } = require('./render');

async function handleRpcCommand(args, config) {
  let targetUrl = config.coordinatorUrl;
  let directNode = null;
  const peers = Object.keys(config.peers).length > 0 ? config.peers : {
    a: { nodeId: 'a', url: 'http://localhost:3001' },
    b: { nodeId: 'b', url: 'http://localhost:3002' },
    c: { nodeId: 'c', url: 'http://localhost:3003' },
    d: { nodeId: 'd', url: 'http://localhost:3004' }
  };

  // Check for --node=a flag
  const remainingArgs = [];
  for (const arg of args) {
    if (arg.startsWith('--node=')) {
      directNode = arg.split('=')[1].toLowerCase();
      if (peers[directNode]) {
        targetUrl = peers[directNode].url;
        // When running on host outside Docker network, map to host port (3001..3004)
        if (targetUrl.includes('bank-node-') && !process.env.HOSTNAME?.startsWith('bank-')) {
          const portMap = { a: 3001, b: 3002, c: 3003, d: 3004 };
          targetUrl = `http://localhost:${portMap[directNode] || 3001}`;
        }
      } else {
        console.error(`Unknown node "${directNode}". Available: ${Object.keys(peers).join(', ')}`);
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

async function main() {
  const config = loadConfig();
  const args = process.argv.slice(2);

  if (args[0] === 'rpc') {
    await handleRpcCommand(args.slice(1), config);
    return;
  }

  // Default status dump
  console.log('=========================================');
  console.log('       DISTRIBUTED BANKING SYSTEM        ');
  console.log('=========================================');

  try {
    const status = await callRpc(config.coordinatorUrl, 'gateway.clusterStatus', {});
    console.log('Coordinator status:', status.coordinator.status);
    console.log('Nodes detected:');
    for (const [nodeId, info] of Object.entries(status.nodes)) {
      console.log(`  Node ${nodeId.toUpperCase()}: ${info.online ? `ONLINE (role=${info.role}, epoch=${info.epoch})` : `OFFLINE (${info.error})`}`);
    }
  } catch (err) {
    console.log(`Unable to reach coordinator at ${config.coordinatorUrl}: ${err.message}`);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('CLI error:', err);
    process.exit(1);
  });
}

module.exports = { main, handleRpcCommand };
