// src/cli/experiments/loadBalancing.js: Experiment 6 - Load Balancing
// Specification: PROJECT.md Section 20, Section 23.3, Section 24.6

const crypto = require('crypto');
const { callRpc } = require('../../shared/rpc/client');
const { renderLoadBalancerStats } = require('../render');
const { executeRpc } = require('./rpc');

async function handleLoadBalancingMenu(prompt, config, raw = false) {
  while (true) {
    console.log('\n--- 6. Load Balancing ---');
    console.log('1. Set Balancing Algorithm (round-robin / least-connections)');
    console.log('2. Run Read Load Test (40 requests, 8 concurrency)');
    console.log('3. Inject Latency Skew on Node B (rpcDelayMs = 80)');
    console.log('4. View Load Balancer Stats');
    console.log('5. Check Balance (Routed via Load Balancer)');
    console.log('6. Deposit / Transfer (Routed Strictly to Leader)');
    console.log('0. Back to Main Menu');

    const choice = await prompt('\nSelect an option: ');
    if (choice === '0') break;

    switch (choice) {
      case '1': {
        const alg = (await prompt('Algorithm (round-robin or least-connections) [round-robin]: ')) || 'round-robin';
        try {
          const res = await callRpc(config.coordinatorUrl, 'lb.setAlgorithm', { algorithm: alg });
          console.log(`Load balancer algorithm set to: ${res.algorithm}`);
        } catch (err) {
          console.error('Set algorithm error:', err.message);
        }
        break;
      }
      case '2': {
        const requests = Number((await prompt('Requests count [40]: ')) || 40);
        const concurrency = Number((await prompt('Concurrency [8]: ')) || 8);
        const consistency = (await prompt('Consistency (eventual / bounded / strong) [eventual]: ')) || 'eventual';
        console.log(`Running read load test (${requests} requests, concurrency ${concurrency}, consistency ${consistency})...`);

        try {
          const stats = await callRpc(config.coordinatorUrl, 'lb.run', {
            requests,
            concurrency,
            consistency,
            accountId: 'ACC-0001'
          }, { timeoutMs: 25000 });
          console.log('\nLOAD BALANCER > Test Results');
          console.log(renderLoadBalancerStats(stats));
        } catch (err) {
          console.error('Load test error:', err.message);
        }
        break;
      }
      case '3': {
        const delay = Number((await prompt('Delay ms on Node B [80]: ')) || 80);
        try {
          await callRpc('http://localhost:3002', 'cluster.setFault', { knob: 'rpcDelayMs', value: delay });
          console.log(`Injected rpcDelayMs = ${delay}ms on Node B. Run least-connections test to observe traffic shifting.`);
        } catch (err) {
          console.error('Fault error:', err.message);
        }
        break;
      }
      case '4': {
        try {
          const stats = await callRpc(config.coordinatorUrl, 'lb.stats', {});
          console.log('\nLOAD BALANCER > Current Cumulative Stats');
          console.log(renderLoadBalancerStats(stats));
        } catch (err) {
          console.error('Stats error:', err.message);
        }
        break;
      }
      case '5': {
        const accountId = (await prompt('Account ID [ACC-0001]: ')) || 'ACC-0001';
        const consistency = (await prompt('Consistency [eventual]: ')) || 'eventual';
        try {
          const res = await callRpc(config.coordinatorUrl, 'bank.getBalance', { accountId, consistency });
          console.log(`Balance: ₹${res.balance} (servedBy: ${res.servedBy}, appliedLsn: ${res.appliedLsn})`);
        } catch (err) {
          console.error('Balance error:', err.message);
        }
        break;
      }
      case '6': {
        const key = `idem-lb-wr-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
        console.log('Sending write (writes are always routed strictly to leader):');
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

module.exports = { handleLoadBalancingMenu };
