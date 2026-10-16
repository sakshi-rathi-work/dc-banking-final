// src/cli/experiments/multithreading.js: Experiment 2 - Multithreading
// Specification: PROJECT.md Section 16, Section 23.3, Section 24.2

const crypto = require('crypto');
const { callRpc } = require('../../shared/rpc/client');
const { renderWorkerReport } = require('../render');
const { executeRpc } = require('./rpc');

async function handleMultithreadingMenu(prompt, config, raw = false) {
  while (true) {
    console.log('\n--- 2. Multithreading ---');
    console.log('1. Deposit');
    console.log('2. Withdraw');
    console.log('3. Transfer');
    console.log('4. Run Concurrent Test (parallel-withdrawals)');
    console.log('5. Run Conflicting Test (conflicting-withdrawals)');
    console.log('6. Stress Test (N tasks, W workers)');
    console.log('7. Worker Crash Test');
    console.log('8. View Worker Activity');
    console.log('0. Back to Main Menu');

    const choice = await prompt('\nSelect an option: ');
    if (choice === '0') break;

    const key = `idem-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;

    switch (choice) {
      case '1': {
        const accountId = (await prompt('Account ID [ACC-0001]: ')) || 'ACC-0001';
        const amount = (await prompt('Amount [500.00]: ')) || '500.00';
        await executeRpc(config.coordinatorUrl, 'bank.deposit', { accountId, amount, idempotencyKey: key }, raw);
        break;
      }
      case '2': {
        const accountId = (await prompt('Account ID [ACC-0001]: ')) || 'ACC-0001';
        const amount = (await prompt('Amount [200.00]: ')) || '200.00';
        await executeRpc(config.coordinatorUrl, 'bank.withdraw', { accountId, amount, idempotencyKey: key }, raw);
        break;
      }
      case '3': {
        const fromAccountId = (await prompt('From Account [ACC-0001]: ')) || 'ACC-0001';
        const toAccountId = (await prompt('To Account [ACC-0002]: ')) || 'ACC-0002';
        const amount = (await prompt('Amount [100.00]: ')) || '100.00';
        await executeRpc(config.coordinatorUrl, 'bank.transfer', { fromAccountId, toAccountId, amount, idempotencyKey: key }, raw);
        break;
      }
      case '4': {
        // T07: Parallel withdrawals (4 x 2000 from 10000 balance)
        console.log('Running scenario parallel-withdrawals (4 workers, 4 withdrawals of 2000.00):');
        const tasks = [
          { operation: 'withdraw', params: { accountId: 'ACC-0001', amount: '2000.00', idempotencyKey: `pw-1-${Date.now()}` } },
          { operation: 'withdraw', params: { accountId: 'ACC-0001', amount: '2000.00', idempotencyKey: `pw-2-${Date.now()}` } },
          { operation: 'withdraw', params: { accountId: 'ACC-0001', amount: '2000.00', idempotencyKey: `pw-3-${Date.now()}` } },
          { operation: 'withdraw', params: { accountId: 'ACC-0001', amount: '2000.00', idempotencyKey: `pw-4-${Date.now()}` } }
        ];

        try {
          const report = await callRpc(config.coordinatorUrl, 'worker.runBatch', { tasks, concurrency: 4 });
          console.log(renderWorkerReport(report));
          const bal = await callRpc(config.coordinatorUrl, 'bank.getBalance', { accountId: 'ACC-0001' });
          console.log(`Final ACC-0001 balance: ₹${bal.balance}   verdict: ${report.committed === 4 ? 'PASS' : 'FAIL'}`);
        } catch (err) {
          console.error('Batch error:', err.message);
        }
        break;
      }
      case '5': {
        // T08: Conflicting withdrawals (2 x 4000 from 5000 balance -> 1 committed, 1 rejected)
        console.log('Running scenario conflicting-withdrawals (2 concurrent withdrawals of 4000.00 from 5000.00):');
        const tasks = [
          { operation: 'withdraw', params: { accountId: 'ACC-0002', amount: '4000.00', idempotencyKey: `cw-1-${Date.now()}` } },
          { operation: 'withdraw', params: { accountId: 'ACC-0002', amount: '4000.00', idempotencyKey: `cw-2-${Date.now()}` } }
        ];

        try {
          const report = await callRpc(config.coordinatorUrl, 'worker.runBatch', { tasks, concurrency: 2 });
          console.log(renderWorkerReport(report));
          const bal = await callRpc(config.coordinatorUrl, 'bank.getBalance', { accountId: 'ACC-0002' });
          const pass = report.committed === 1 && report.rejected === 1;
          console.log(`Final ACC-0002 balance: ₹${bal.balance}   verdict: ${pass ? 'PASS' : 'FAIL'}`);
        } catch (err) {
          console.error('Batch error:', err.message);
        }
        break;
      }
      case '6': {
        const count = Number((await prompt('Total requests [20]: ')) || 20);
        const workers = Number((await prompt('Worker threads [4]: ')) || 4);
        console.log(`Executing stress test (${count} tasks across ${workers} worker threads)...`);

        const tasks = [];
        for (let i = 0; i < count; i++) {
          tasks.push({
            operation: 'deposit',
            params: {
              accountId: 'ACC-0001',
              amount: '10.00',
              idempotencyKey: `stress-${i}-${Date.now()}`
            }
          });
        }

        try {
          const report = await callRpc(config.coordinatorUrl, 'worker.runBatch', { tasks, concurrency: workers });
          console.log(renderWorkerReport(report));
        } catch (err) {
          console.error('Stress test error:', err.message);
        }
        break;
      }
      case '7': {
        console.log('Testing worker crash recovery with fault knob workerCrashOnTask...');
        try {
          await callRpc('http://localhost:3001', 'cluster.setFault', { knob: 'workerCrashOnTask', value: true });
          const tasks = [
            { operation: 'deposit', params: { accountId: 'ACC-0001', amount: '50.00', idempotencyKey: `crash-${Date.now()}` } }
          ];
          const report = await callRpc(config.coordinatorUrl, 'worker.runBatch', { tasks, concurrency: 2 });
          console.log(renderWorkerReport(report));
        } catch (err) {
          console.log(`Worker crash handled gracefully: ${err.message}`);
        } finally {
          await callRpc('http://localhost:3001', 'cluster.clearFaults', {});
        }
        break;
      }
      case '8': {
        try {
          const act = await callRpc(config.coordinatorUrl, 'worker.getActivity', {});
          console.log(JSON.stringify(act, null, 2));
        } catch (err) {
          console.error('Activity error:', err.message);
        }
        break;
      }
      default:
        console.log('Invalid choice.');
    }
  }
}

module.exports = { handleMultithreadingMenu };
