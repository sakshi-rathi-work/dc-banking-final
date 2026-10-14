// src/txn/executor.js: The single authoritative banking execution engine
// Rule: Deposit/withdraw/transfer logic exists ONLY in this file.

const crypto = require('crypto');
const { getPool } = require('../shared/db/pool');
const { writeLogEntry } = require('./logWriter');
const { claimIdempotencyKey, storeIdempotencyResult } = require('./idempotency');
const { validateAccountId, validateHolderName, validateAmount, validateIdempotencyKey } = require('../domain/validators');
const { compareMoney } = require('../domain/money');
const { RpcError, ERROR_CODES } = require('../contracts/errors');
const { appendTrace } = require('../shared/rpc/meta');

async function executeBankOperation(operation, params, meta = {}, customClient = null) {
  const pool = getPool();
  const client = customClient || await pool.connect();
  const shouldRelease = !customClient;

  try {
    const key = validateIdempotencyKey(params.idempotencyKey);

    await client.query('BEGIN');

    // Step 1: Claim idempotency key inside the SQL transaction
    const claim = await claimIdempotencyKey(client, key, operation, params);
    if (!claim.claimed) {
      await client.query('COMMIT');
      if (meta && meta.trace) {
        appendTrace(meta, 'idempotency.hit');
      }
      const stored = claim.result;
      if (stored && stored.status === 'REJECTED') {
        throw new RpcError(
          ERROR_CODES.INSUFFICIENT_FUNDS,
          stored.rejectReason || 'Transaction previously rejected',
          { ...stored, duplicate: true }
        );
      }
      return {
        ...stored,
        duplicate: true
      };
    }

    const safeMeta = meta || {};
    let result;

    switch (operation) {
      case 'createAccount':
        result = await handleCreateAccount(client, params, safeMeta, key);
        break;
      case 'deposit':
        result = await handleDeposit(client, params, safeMeta, key);
        break;
      case 'withdraw':
        result = await handleWithdraw(client, params, safeMeta, key);
        break;
      case 'transfer':
        result = await handleTransfer(client, params, safeMeta, key);
        break;
      default:
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, `Unsupported operation: ${operation}`);
    }

    await client.query('COMMIT');
    if (meta && meta.trace) {
      appendTrace(meta, 'db.commit');
    }

    if (result && result.status === 'REJECTED') {
      throw new RpcError(
        ERROR_CODES.INSUFFICIENT_FUNDS,
        result.rejectReason || 'Transaction rejected: INSUFFICIENT_FUNDS',
        result
      );
    }

    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rbErr) {
      // Ignore rollback errors if already aborted
    }
    throw err;
  } finally {
    if (shouldRelease) {
      client.release();
    }
  }
}

async function handleCreateAccount(client, params, meta, idempotencyKey) {
  const holderName = validateHolderName(params.holderName);
  const openingDeposit = params.openingDeposit ? validateAmount(params.openingDeposit) : null;

  // Allocate next account ID under table-level row lock
  const nextRes = await client.query(`
    SELECT COALESCE(MAX(SUBSTRING(account_id FROM 5)::INT), 0) + 1 AS next_num
    FROM accounts;
  `);
  const nextNum = nextRes.rows[0].next_num;
  const accountId = `ACC-${String(nextNum).padStart(4, '0')}`;

  const payload = {
    account: {
      accountId,
      holderName,
      status: 'ACTIVE',
      balance: '0.00',
      currency: 'INR',
      version: 0
    }
  };

  // Write replication log for ACCOUNT_CREATED
  const log = await writeLogEntry(client, {
    entryType: 'ACCOUNT_CREATED',
    payload,
    meta
  });

  await client.query(`
    INSERT INTO accounts (
      account_id, holder_name, status, balance, currency, version,
      created_at, updated_at, created_lsn, updated_lsn
    ) VALUES ($1, $2, 'ACTIVE', 0.00, 'INR', 0, now(), now(), $3, $3);
  `, [accountId, holderName, log.lsn]);

  let finalBalance = '0.00';
  let finalLsn = log.lsn;
  let txnId = null;

  // If opening deposit provided, execute it as sequential TXN_COMMITTED entry
  if (openingDeposit && compareMoney(openingDeposit, '0.00') > 0) {
    txnId = crypto.randomUUID();
    const requestId = meta.traceId || `req-${Date.now()}`;

    const depUpdate = await client.query(`
      UPDATE accounts
      SET balance = balance + $1::NUMERIC(14,2), version = version + 1, updated_at = now()
      WHERE account_id = $2
      RETURNING balance, version;
    `, [openingDeposit, accountId]);

    finalBalance = depUpdate.rows[0].balance;
    const newVersion = Number(depUpdate.rows[0].version);

    const depPayload = {
      txn: {
        txnId,
        type: 'DEPOSIT',
        destinationAccountId: accountId,
        amount: openingDeposit,
        status: 'COMMITTED',
        requestId
      },
      ledger: [
        {
          lineNo: 1,
          accountId,
          direction: 'CREDIT',
          amount: openingDeposit,
          balanceAfter: finalBalance
        }
      ],
      accounts: [
        {
          accountId,
          balance: finalBalance,
          version: newVersion
        }
      ]
    };

    const depLog = await writeLogEntry(client, {
      entryType: 'TXN_COMMITTED',
      txnId,
      payload: depPayload,
      meta
    });

    finalLsn = depLog.lsn;

    await client.query(`
      INSERT INTO transactions (
        txn_id, idempotency_key, type, destination_account_id, amount,
        currency, status, request_id, origin_node, leader_id, epoch,
        lsn, lamport_ts, physical_ts_ms, committed_at
      ) VALUES ($1, $2, 'DEPOSIT', $3, $4, 'INR', 'COMMITTED', $5, $6, $6, $7, $8, $9, $10, now());
    `, [
      txnId,
      idempotencyKey,
      accountId,
      openingDeposit,
      requestId,
      depLog.originNode,
      depLog.epoch,
      depLog.lsn,
      depLog.lamport,
      depLog.physicalTs
    ]);

    await client.query(`
      INSERT INTO ledger_entries (lsn, line_no, txn_id, account_id, direction, amount, balance_after)
      VALUES ($1, 1, $2, $3, 'CREDIT', $4, $5);
    `, [depLog.lsn, txnId, accountId, openingDeposit, finalBalance]);

    await client.query(`
      UPDATE accounts SET updated_lsn = $1 WHERE account_id = $2;
    `, [depLog.lsn, accountId]);
  }

  const result = {
    accountId,
    holderName,
    balance: finalBalance,
    lsn: finalLsn,
    epoch: log.epoch,
    txnId,
    duplicate: false
  };

  await storeIdempotencyResult(client, idempotencyKey, result, finalLsn);
  return result;
}

async function handleDeposit(client, params, meta, idempotencyKey) {
  const accountId = validateAccountId(params.accountId);
  const amount = validateAmount(params.amount);
  const txnId = crypto.randomUUID();
  const requestId = meta.traceId || `req-${Date.now()}`;

  // Lock account FOR UPDATE with contention timing
  const tLock0 = process.hrtime();
  const accRes = await client.query(`
    SELECT account_id, holder_name, status, balance, version
    FROM accounts
    WHERE account_id = $1
    FOR UPDATE;
  `, [accountId]);
  const [sLock, nsLock] = process.hrtime(tLock0);
  const lockWaitMs = Math.round((sLock * 1000 + nsLock / 1e6) * 100) / 100;

  if (meta && meta.holdAfterLockMs && meta.holdAfterLockMs > 0) {
    await new Promise(r => setTimeout(r, meta.holdAfterLockMs));
  }

  if (meta && meta.workerCrashOnTask && meta.taskId === meta.workerCrashOnTask) {
    process.exit(1);
  }

  if (accRes.rows.length === 0) {
    throw new RpcError(ERROR_CODES.ACCOUNT_NOT_FOUND, `Account not found: ${accountId}`);
  }

  const account = accRes.rows[0];
  if (account.status !== 'ACTIVE') {
    throw new RpcError(ERROR_CODES.ACCOUNT_NOT_ACTIVE, `Account ${accountId} is ${account.status}`);
  }

  // Update balance
  const updateRes = await client.query(`
    UPDATE accounts
    SET balance = balance + $1::NUMERIC(14,2), version = version + 1, updated_at = now()
    WHERE account_id = $2
    RETURNING balance, version;
  `, [amount, accountId]);

  const newBalance = updateRes.rows[0].balance;
  const newVersion = Number(updateRes.rows[0].version);

  const payload = {
    txn: {
      txnId,
      type: 'DEPOSIT',
      destinationAccountId: accountId,
      amount,
      status: 'COMMITTED',
      requestId
    },
    ledger: [
      {
        lineNo: 1,
        accountId,
        direction: 'CREDIT',
        amount,
        balanceAfter: newBalance
      }
    ],
    accounts: [
      {
        accountId,
        balance: newBalance,
        version: newVersion
      }
    ]
  };

  // Write replication log
  const log = await writeLogEntry(client, {
    entryType: 'TXN_COMMITTED',
    txnId,
    payload,
    meta
  });

  // Insert transaction
  await client.query(`
    INSERT INTO transactions (
      txn_id, idempotency_key, type, destination_account_id, amount,
      currency, status, request_id, origin_node, leader_id, epoch,
      lsn, lamport_ts, physical_ts_ms, committed_at
    ) VALUES ($1, $2, 'DEPOSIT', $3, $4, 'INR', 'COMMITTED', $5, $6, $6, $7, $8, $9, $10, now());
  `, [
    txnId,
    idempotencyKey,
    accountId,
    amount,
    requestId,
    log.originNode,
    log.epoch,
    log.lsn,
    log.lamport,
    log.physicalTs
  ]);

  // Insert ledger entry
  await client.query(`
    INSERT INTO ledger_entries (lsn, line_no, txn_id, account_id, direction, amount, balance_after)
    VALUES ($1, 1, $2, $3, 'CREDIT', $4, $5);
  `, [log.lsn, txnId, accountId, amount, newBalance]);

  await client.query('UPDATE accounts SET updated_lsn = $1 WHERE account_id = $2', [log.lsn, accountId]);

  const result = {
    txnId,
    status: 'COMMITTED',
    lsn: log.lsn,
    epoch: log.epoch,
    balance: newBalance,
    durability: 'LOCAL',
    duplicate: false,
    lockWaitMs
  };

  await storeIdempotencyResult(client, idempotencyKey, result, log.lsn);
  return result;
}

async function handleWithdraw(client, params, meta, idempotencyKey) {
  const accountId = validateAccountId(params.accountId);
  const amount = validateAmount(params.amount);
  const txnId = crypto.randomUUID();
  const requestId = meta.traceId || `req-${Date.now()}`;

  // Lock account FOR UPDATE with contention timing
  const tLock0 = process.hrtime();
  const accRes = await client.query(`
    SELECT account_id, holder_name, status, balance, version
    FROM accounts
    WHERE account_id = $1
    FOR UPDATE;
  `, [accountId]);
  const [sLock, nsLock] = process.hrtime(tLock0);
  const lockWaitMs = Math.round((sLock * 1000 + nsLock / 1e6) * 100) / 100;

  if (meta && meta.holdAfterLockMs && meta.holdAfterLockMs > 0) {
    await new Promise(r => setTimeout(r, meta.holdAfterLockMs));
  }

  if (meta && meta.workerCrashOnTask && meta.taskId === meta.workerCrashOnTask) {
    process.exit(1);
  }

  if (accRes.rows.length === 0) {
    throw new RpcError(ERROR_CODES.ACCOUNT_NOT_FOUND, `Account not found: ${accountId}`);
  }

  const account = accRes.rows[0];
  if (account.status !== 'ACTIVE') {
    throw new RpcError(ERROR_CODES.ACCOUNT_NOT_ACTIVE, `Account ${accountId} is ${account.status}`);
  }

  // Check funds
  if (compareMoney(account.balance, amount) < 0) {
    // Insufficient funds: proceed as REJECTED
    const rejectPayload = {
      txn: {
        txnId,
        type: 'WITHDRAWAL',
        sourceAccountId: accountId,
        amount,
        status: 'REJECTED',
        rejectReason: 'INSUFFICIENT_FUNDS',
        requestId
      }
    };

    const log = await writeLogEntry(client, {
      entryType: 'TXN_REJECTED',
      txnId,
      payload: rejectPayload,
      meta
    });

    await client.query(`
      INSERT INTO transactions (
        txn_id, idempotency_key, type, source_account_id, amount,
        currency, status, reject_reason, request_id, origin_node, leader_id, epoch,
        lsn, lamport_ts, physical_ts_ms, committed_at
      ) VALUES ($1, $2, 'WITHDRAWAL', $3, $4, 'INR', 'REJECTED', 'INSUFFICIENT_FUNDS', $5, $6, $6, $7, $8, $9, $10, now());
    `, [
      txnId,
      idempotencyKey,
      accountId,
      amount,
      requestId,
      log.originNode,
      log.epoch,
      log.lsn,
      log.lamport,
      log.physicalTs
    ]);

    const rejectResult = {
      txnId,
      status: 'REJECTED',
      rejectReason: 'INSUFFICIENT_FUNDS',
      lsn: log.lsn,
      epoch: log.epoch,
      balance: account.balance,
      durability: 'LOCAL',
      duplicate: false,
      lockWaitMs
    };

    await storeIdempotencyResult(client, idempotencyKey, rejectResult, log.lsn);
    return rejectResult;
  }

  // Sufficient funds: apply withdrawal
  const updateRes = await client.query(`
    UPDATE accounts
    SET balance = balance - $1::NUMERIC(14,2), version = version + 1, updated_at = now()
    WHERE account_id = $2
    RETURNING balance, version;
  `, [amount, accountId]);

  const newBalance = updateRes.rows[0].balance;
  const newVersion = Number(updateRes.rows[0].version);

  const payload = {
    txn: {
      txnId,
      type: 'WITHDRAWAL',
      sourceAccountId: accountId,
      amount,
      status: 'COMMITTED',
      requestId
    },
    ledger: [
      {
        lineNo: 1,
        accountId,
        direction: 'DEBIT',
        amount,
        balanceAfter: newBalance
      }
    ],
    accounts: [
      {
        accountId,
        balance: newBalance,
        version: newVersion
      }
    ]
  };

  const log = await writeLogEntry(client, {
    entryType: 'TXN_COMMITTED',
    txnId,
    payload,
    meta
  });

  await client.query(`
    INSERT INTO transactions (
      txn_id, idempotency_key, type, source_account_id, amount,
      currency, status, request_id, origin_node, leader_id, epoch,
      lsn, lamport_ts, physical_ts_ms, committed_at
    ) VALUES ($1, $2, 'WITHDRAWAL', $3, $4, 'INR', 'COMMITTED', $5, $6, $6, $7, $8, $9, $10, now());
  `, [
    txnId,
    idempotencyKey,
    accountId,
    amount,
    requestId,
    log.originNode,
    log.epoch,
    log.lsn,
    log.lamport,
    log.physicalTs
  ]);

  await client.query(`
    INSERT INTO ledger_entries (lsn, line_no, txn_id, account_id, direction, amount, balance_after)
    VALUES ($1, 1, $2, $3, 'DEBIT', $4, $5);
  `, [log.lsn, txnId, accountId, amount, newBalance]);

  await client.query('UPDATE accounts SET updated_lsn = $1 WHERE account_id = $2', [log.lsn, accountId]);

  const result = {
    txnId,
    status: 'COMMITTED',
    lsn: log.lsn,
    epoch: log.epoch,
    balance: newBalance,
    durability: 'LOCAL',
    duplicate: false,
    lockWaitMs
  };

  await storeIdempotencyResult(client, idempotencyKey, result, log.lsn);
  return result;
}

async function handleTransfer(client, params, meta, idempotencyKey) {
  const fromAccountId = validateAccountId(params.fromAccountId, 'fromAccountId');
  const toAccountId = validateAccountId(params.toAccountId, 'toAccountId');
  const amount = validateAmount(params.amount);

  if (fromAccountId === toAccountId) {
    throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'Source and destination accounts must be distinct');
  }

  const txnId = crypto.randomUUID();
  const requestId = meta.traceId || `req-${Date.now()}`;

  // Lock both accounts in strictly ascending account_id order to prevent deadlocks
  const sortedIds = [fromAccountId, toAccountId].sort();
  const tLock0 = process.hrtime();
  const accRes = await client.query(`
    SELECT account_id, holder_name, status, balance, version
    FROM accounts
    WHERE account_id = ANY($1)
    ORDER BY account_id ASC
    FOR UPDATE;
  `, [sortedIds]);
  const [sLock, nsLock] = process.hrtime(tLock0);
  const lockWaitMs = Math.round((sLock * 1000 + nsLock / 1e6) * 100) / 100;

  if (meta && meta.holdAfterLockMs && meta.holdAfterLockMs > 0) {
    await new Promise(r => setTimeout(r, meta.holdAfterLockMs));
  }

  if (meta && meta.workerCrashOnTask && meta.taskId === meta.workerCrashOnTask) {
    process.exit(1);
  }

  if (accRes.rows.length < 2) {
    throw new RpcError(ERROR_CODES.ACCOUNT_NOT_FOUND, 'One or both transfer accounts do not exist');
  }

  const fromAcc = accRes.rows.find(a => a.account_id === fromAccountId);
  const toAcc = accRes.rows.find(a => a.account_id === toAccountId);

  if (fromAcc.status !== 'ACTIVE') {
    throw new RpcError(ERROR_CODES.ACCOUNT_NOT_ACTIVE, `Source account ${fromAccountId} is ${fromAcc.status}`);
  }
  if (toAcc.status !== 'ACTIVE') {
    throw new RpcError(ERROR_CODES.ACCOUNT_NOT_ACTIVE, `Destination account ${toAccountId} is ${toAcc.status}`);
  }

  // Check fromAccount funds
  if (compareMoney(fromAcc.balance, amount) < 0) {
    const rejectPayload = {
      txn: {
        txnId,
        type: 'TRANSFER',
        sourceAccountId: fromAccountId,
        destinationAccountId: toAccountId,
        amount,
        status: 'REJECTED',
        rejectReason: 'INSUFFICIENT_FUNDS',
        requestId
      }
    };

    const log = await writeLogEntry(client, {
      entryType: 'TXN_REJECTED',
      txnId,
      payload: rejectPayload,
      meta
    });

    await client.query(`
      INSERT INTO transactions (
        txn_id, idempotency_key, type, source_account_id, destination_account_id,
        amount, currency, status, reject_reason, request_id, origin_node,
        leader_id, epoch, lsn, lamport_ts, physical_ts_ms, committed_at
      ) VALUES ($1, $2, 'TRANSFER', $3, $4, $5, 'INR', 'REJECTED', 'INSUFFICIENT_FUNDS', $6, $7, $7, $8, $9, $10, $11, now());
    `, [
      txnId,
      idempotencyKey,
      fromAccountId,
      toAccountId,
      amount,
      requestId,
      log.originNode,
      log.epoch,
      log.lsn,
      log.lamport,
      log.physicalTs
    ]);

    const rejectResult = {
      txnId,
      status: 'REJECTED',
      rejectReason: 'INSUFFICIENT_FUNDS',
      lsn: log.lsn,
      epoch: log.epoch,
      balance: fromAcc.balance,
      durability: 'LOCAL',
      duplicate: false,
      lockWaitMs
    };

    await storeIdempotencyResult(client, idempotencyKey, rejectResult, log.lsn);
    return rejectResult;
  }

  // Sufficient funds: update both balances
  const updateFrom = await client.query(`
    UPDATE accounts
    SET balance = balance - $1::NUMERIC(14,2), version = version + 1, updated_at = now()
    WHERE account_id = $2
    RETURNING balance, version;
  `, [amount, fromAccountId]);

  const updateTo = await client.query(`
    UPDATE accounts
    SET balance = balance + $1::NUMERIC(14,2), version = version + 1, updated_at = now()
    WHERE account_id = $2
    RETURNING balance, version;
  `, [amount, toAccountId]);

  const fromBalanceAfter = updateFrom.rows[0].balance;
  const fromVersionAfter = Number(updateFrom.rows[0].version);
  const toBalanceAfter = updateTo.rows[0].balance;
  const toVersionAfter = Number(updateTo.rows[0].version);

  const payload = {
    txn: {
      txnId,
      type: 'TRANSFER',
      sourceAccountId: fromAccountId,
      destinationAccountId: toAccountId,
      amount,
      status: 'COMMITTED',
      requestId
    },
    ledger: [
      {
        lineNo: 1,
        accountId: fromAccountId,
        direction: 'DEBIT',
        amount,
        balanceAfter: fromBalanceAfter
      },
      {
        lineNo: 2,
        accountId: toAccountId,
        direction: 'CREDIT',
        amount,
        balanceAfter: toBalanceAfter
      }
    ],
    accounts: [
      {
        accountId: fromAccountId,
        balance: fromBalanceAfter,
        version: fromVersionAfter
      },
      {
        accountId: toAccountId,
        balance: toBalanceAfter,
        version: toVersionAfter
      }
    ]
  };

  const log = await writeLogEntry(client, {
    entryType: 'TXN_COMMITTED',
    txnId,
    payload,
    meta
  });

  await client.query(`
    INSERT INTO transactions (
      txn_id, idempotency_key, type, source_account_id, destination_account_id,
      amount, currency, status, request_id, origin_node, leader_id, epoch,
      lsn, lamport_ts, physical_ts_ms, committed_at
    ) VALUES ($1, $2, 'TRANSFER', $3, $4, $5, 'INR', 'COMMITTED', $6, $7, $7, $8, $9, $10, $11, now());
  `, [
    txnId,
    idempotencyKey,
    fromAccountId,
    toAccountId,
    amount,
    requestId,
    log.originNode,
    log.epoch,
    log.lsn,
    log.lamport,
    log.physicalTs
  ]);

  await client.query(`
    INSERT INTO ledger_entries (lsn, line_no, txn_id, account_id, direction, amount, balance_after)
    VALUES
      ($1, 1, $2, $3, 'DEBIT', $4, $5),
      ($1, 2, $2, $6, 'CREDIT', $4, $7);
  `, [log.lsn, txnId, fromAccountId, amount, fromBalanceAfter, toAccountId, toBalanceAfter]);

  await client.query('UPDATE accounts SET updated_lsn = $1 WHERE account_id = $2', [log.lsn, fromAccountId]);
  await client.query('UPDATE accounts SET updated_lsn = $1 WHERE account_id = $2', [log.lsn, toAccountId]);

  const result = {
    txnId,
    status: 'COMMITTED',
    lsn: log.lsn,
    epoch: log.epoch,
    fromBalance: fromBalanceAfter,
    toBalance: toBalanceAfter,
    durability: 'LOCAL',
    duplicate: false,
    lockWaitMs
  };

  await storeIdempotencyResult(client, idempotencyKey, result, log.lsn);
  return result;
}

module.exports = {
  executeBankOperation
};
