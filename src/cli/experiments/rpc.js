// src/cli/experiments/rpc.js: Experiment 1 - Client-Server Communication (RPC)
// Specification: PROJECT.md Section 13, Section 23.3, Section 24.1

const crypto = require('crypto');
const { callRpc } = require('../../shared/rpc/client');
const { createMeta, appendTrace } = require('../../shared/rpc/meta');
const { renderTrace, renderRpcResult } = require('../render');

let lastRequest = null;
let lastTrace = null;

async function executeRpc(targetUrl, method, params, raw = false) {
  const reqId = `req-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
  const meta = createMeta({ from: 'cli', traceId: reqId });
  appendTrace(meta, `cli -> ${method}`, 0, 'cli');

  params._meta = meta;
  lastRequest = { targetUrl, method, params: { ...params } };

  const tStart = process.hrtime();
  try {
    const result = await callRpc(targetUrl, method, params, { timeoutMs: 15000 });
    const [s, ns] = process.hrtime(tStart);
    const durationMs = s * 1000 + ns / 1e6;

    const resMeta = (result && result._meta) ? result._meta : meta;
    appendTrace(resMeta, `cli <- SUCCESS`, durationMs, 'cli');
    lastTrace = resMeta.trace;

    if (raw) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(renderTrace(lastTrace));
      console.log('');
      console.log(renderRpcResult(result, durationMs));
    }
    return result;
  } catch (err) {
    const [s, ns] = process.hrtime(tStart);
    const durationMs = s * 1000 + ns / 1e6;
    const errMeta = (err.data && err.data._meta) ? err.data._meta : meta;
    appendTrace(errMeta, `cli <- ERROR ${err.code || ''}`, durationMs, 'cli');
    lastTrace = errMeta.trace;

    console.log(renderTrace(lastTrace));
    console.log('');
    console.error(`ERROR ${err.code || -32603}: ${err.message}`);
    if (err.data && typeof err.data === 'object') {
      console.error(JSON.stringify(err.data, null, 2));
    }
    return null;
  }
}

async function handleRpcMenu(prompt, config, raw = false) {
  while (true) {
    console.log('\n--- 1. Client-Server Communication (RPC) ---');
    console.log('1. Create Account');
    console.log('2. Check Balance');
    console.log('3. Deposit');
    console.log('4. Withdraw');
    console.log('5. Transfer');
    console.log('6. Resend Last Request (Idempotency Replay)');
    console.log('7. Call Node Directly');
    console.log('8. Show Last Trace');
    console.log('9. Timeout Test (Inject rpcDelayMs)');
    console.log('0. Back to Main Menu');

    const choice = await prompt('\nSelect an option: ');
    if (choice === '0') break;

    const key = `idem-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;

    switch (choice) {
      case '1': {
        const holderName = (await prompt('Holder Name [Demo User]: ')) || 'Demo User';
        const openingDeposit = (await prompt('Opening Deposit [1000.00]: ')) || '1000.00';
        await executeRpc(config.coordinatorUrl, 'bank.createAccount', {
          holderName,
          openingDeposit,
          idempotencyKey: key
        }, raw);
        break;
      }
      case '2': {
        const accountId = (await prompt('Account ID [ACC-0001]: ')) || 'ACC-0001';
        await executeRpc(config.coordinatorUrl, 'bank.getBalance', { accountId }, raw);
        break;
      }
      case '3': {
        const accountId = (await prompt('Account ID [ACC-0001]: ')) || 'ACC-0001';
        const amount = (await prompt('Amount [500.00]: ')) || '500.00';
        await executeRpc(config.coordinatorUrl, 'bank.deposit', {
          accountId,
          amount,
          idempotencyKey: key
        }, raw);
        break;
      }
      case '4': {
        const accountId = (await prompt('Account ID [ACC-0001]: ')) || 'ACC-0001';
        const amount = (await prompt('Amount [200.00]: ')) || '200.00';
        await executeRpc(config.coordinatorUrl, 'bank.withdraw', {
          accountId,
          amount,
          idempotencyKey: key
        }, raw);
        break;
      }
      case '5': {
        const fromAccountId = (await prompt('From Account [ACC-0001]: ')) || 'ACC-0001';
        const toAccountId = (await prompt('To Account [ACC-0002]: ')) || 'ACC-0002';
        const amount = (await prompt('Amount [100.00]: ')) || '100.00';
        await executeRpc(config.coordinatorUrl, 'bank.transfer', {
          fromAccountId,
          toAccountId,
          amount,
          idempotencyKey: key
        }, raw);
        break;
      }
      case '6': {
        if (!lastRequest) {
          console.log('No prior request to resend.');
          break;
        }
        console.log(`Resending last request: ${lastRequest.method} with key ${lastRequest.params.idempotencyKey}`);
        await executeRpc(lastRequest.targetUrl, lastRequest.method, lastRequest.params, raw);
        break;
      }
      case '7': {
        const nid = (await prompt('Node ID (a, b, c, d) [a]: ')) || 'a';
        const port = { a: 3001, b: 3002, c: 3003, d: 3004 }[nid.toLowerCase()] || 3001;
        const targetUrl = `http://localhost:${port}`;
        const accountId = (await prompt('Account ID [ACC-0001]: ')) || 'ACC-0001';
        const amount = (await prompt('Amount [50.00]: ')) || '50.00';
        await executeRpc(targetUrl, 'bank.deposit', {
          accountId,
          amount,
          idempotencyKey: key
        }, raw);
        break;
      }
      case '8': {
        if (!lastTrace) {
          console.log('No trace recorded yet.');
        } else {
          console.log(renderTrace(lastTrace));
        }
        break;
      }
      case '9': {
        console.log('Injecting rpcDelayMs = 3000 on Node A...');
        try {
          await callRpc('http://localhost:3001', 'cluster.setFault', { knob: 'rpcDelayMs', value: 3000 });
          console.log('Testing deposit with 2000ms client timeout:');
          await executeRpc(config.coordinatorUrl, 'bank.deposit', {
            accountId: 'ACC-0001',
            amount: '10.00',
            idempotencyKey: key
          }, raw);
        } finally {
          await callRpc('http://localhost:3001', 'cluster.clearFaults', {});
          console.log('Fault cleared.');
        }
        break;
      }
      default:
        console.log('Invalid choice.');
    }
  }
}

module.exports = { handleRpcMenu, executeRpc };
