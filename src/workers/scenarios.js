// src/workers/scenarios.js: Built-in multithreading experiment scenarios (Section 16.5)
const crypto = require('crypto');
const { executeBankOperation } = require('../txn/executor');
const { RpcError, ERROR_CODES } = require('../contracts/errors');

async function runScenario(scenarioName, workerPool, options = {}) {
  switch (scenarioName) {
    case 'parallel-withdrawals':
      return runParallelWithdrawals(workerPool, options);
    case 'conflicting-withdrawals':
      return runConflictingWithdrawals(workerPool, options);
    case 'stress':
      return runStress(workerPool, options);
    case 'duplicate-flood':
      return runDuplicateFlood(workerPool, options);
    case 'worker-crash':
      return runWorkerCrash(workerPool, options);
    default:
      throw new RpcError(ERROR_CODES.INVALID_PARAMS, `Unknown scenario: "${scenarioName}"`);
  }
}

async function runParallelWithdrawals(workerPool, options = {}) {
  // Setup: create account with ₹10,000
  const accRes = await executeBankOperation('createAccount', {
    holderName: 'Scenario Parallel Withdrawals',
    openingDeposit: '10000.00',
    idempotencyKey: `idem-pw-acc-${Date.now()}`
  });
  const accountId = accRes.accountId;

  // 4 workers each withdraw ₹2,000
  const operations = Array.from({ length: 4 }, (_, i) => ({
    type: 'withdraw',
    accountId,
    amount: '2000.00',
    taskId: `task-${i}`,
    idempotencyKey: `idem-pw-w-${i}-${Date.now()}`
  }));

  const result = await workerPool.runBatch({
    operations,
    workers: 4,
    distribution: 'static',
    holdAfterLockMs: options.holdAfterLockMs || 0
  });

  return {
    scenario: 'parallel-withdrawals',
    accountId,
    initialBalance: '10000.00',
    expectedFinalBalance: '2000.00',
    actualFinalBalance: result.balancesAfter[accountId]?.balance || null,
    ...result
  };
}

async function runConflictingWithdrawals(workerPool, options = {}) {
  // Setup: create account with ₹5,000
  const accRes = await executeBankOperation('createAccount', {
    holderName: 'Scenario Conflicting Withdrawals',
    openingDeposit: '5000.00',
    idempotencyKey: `idem-cw-acc-${Date.now()}`
  });
  const accountId = accRes.accountId;

  // 2 workers simultaneously attempt to withdraw ₹4,000
  const operations = [
    {
      type: 'withdraw',
      accountId,
      amount: '4000.00',
      taskId: 'task-0',
      idempotencyKey: `idem-cw-0-${Date.now()}`
    },
    {
      type: 'withdraw',
      accountId,
      amount: '4000.00',
      taskId: 'task-1',
      idempotencyKey: `idem-cw-1-${Date.now()}`
    }
  ];

  const result = await workerPool.runBatch({
    operations,
    workers: 2,
    distribution: 'static',
    holdAfterLockMs: options.holdAfterLockMs || 0
  });

  return {
    scenario: 'conflicting-withdrawals',
    accountId,
    initialBalance: '5000.00',
    expectedFinalBalance: '1000.00',
    actualFinalBalance: result.balancesAfter[accountId]?.balance || null,
    ...result
  };
}

async function runStress(workerPool, options = {}) {
  const requestCount = options.requests || 100;
  const workerCount = options.workers || 4;

  // Setup: create 4 accounts with ₹10,000 each
  const accounts = [];
  for (let i = 0; i < 4; i++) {
    const acc = await executeBankOperation('createAccount', {
      holderName: `Stress User ${i}`,
      openingDeposit: '10000.00',
      idempotencyKey: `idem-stress-acc-${i}-${Date.now()}`
    });
    accounts.push(acc.accountId);
  }

  const initialTotal = 40000;
  const operations = [];

  for (let i = 0; i < requestCount; i++) {
    const r = i % 3;
    const accIdx = i % accounts.length;
    const otherIdx = (i + 1) % accounts.length;

    if (r === 0) {
      operations.push({
        type: 'deposit',
        accountId: accounts[accIdx],
        amount: '100.00',
        taskId: `task-${i}`
      });
    } else if (r === 1) {
      operations.push({
        type: 'withdraw',
        accountId: accounts[accIdx],
        amount: '50.00',
        taskId: `task-${i}`
      });
    } else {
      operations.push({
        type: 'transfer',
        fromAccountId: accounts[accIdx],
        toAccountId: accounts[otherIdx],
        amount: '100.00',
        taskId: `task-${i}`
      });
    }
  }

  const result = await workerPool.runBatch({
    operations,
    workers: workerCount,
    distribution: 'dynamic'
  });

  return {
    scenario: 'stress',
    accounts,
    initialTotal: '40000.00',
    requestCount,
    ...result
  };
}

async function runDuplicateFlood(workerPool, options = {}) {
  // Setup: create account with ₹10,000
  const accRes = await executeBankOperation('createAccount', {
    holderName: 'Scenario Duplicate Flood',
    openingDeposit: '10000.00',
    idempotencyKey: `idem-df-acc-${Date.now()}`
  });
  const accountId = accRes.accountId;

  // 10 concurrent tasks with the EXACT SAME idempotency key
  const sharedKey = `idem-df-shared-${Date.now()}`;
  const operations = Array.from({ length: 10 }, (_, i) => ({
    type: 'withdraw',
    accountId,
    amount: '1000.00',
    taskId: `task-${i}`,
    idempotencyKey: sharedKey
  }));

  const result = await workerPool.runBatch({
    operations,
    workers: 4,
    distribution: 'static'
  });

  return {
    scenario: 'duplicate-flood',
    accountId,
    sharedKey,
    initialBalance: '10000.00',
    expectedFinalBalance: '9000.00',
    actualFinalBalance: result.balancesAfter[accountId]?.balance || null,
    ...result
  };
}

async function runWorkerCrash(workerPool, options = {}) {
  // Setup: create account with ₹10,000
  const accRes = await executeBankOperation('createAccount', {
    holderName: 'Scenario Worker Crash',
    openingDeposit: '10000.00',
    idempotencyKey: `idem-wc-acc-${Date.now()}`
  });
  const accountId = accRes.accountId;

  // 4 tasks × withdraw ₹2,000 with workerCrashOnTask = 'task-0'
  const operations = Array.from({ length: 4 }, (_, i) => ({
    type: 'withdraw',
    accountId,
    amount: '2000.00',
    taskId: `task-${i}`,
    idempotencyKey: `idem-wc-w-${i}-${Date.now()}`
  }));

  const result = await workerPool.runBatch({
    operations,
    workers: 4,
    distribution: 'static',
    workerCrashOnTask: 'task-0'
  });

  return {
    scenario: 'worker-crash',
    accountId,
    crashedTaskId: 'task-0',
    initialBalance: '10000.00',
    expectedFinalBalance: '2000.00',
    actualFinalBalance: result.balancesAfter[accountId]?.balance || null,
    ...result
  };
}

module.exports = {
  runScenario
};
