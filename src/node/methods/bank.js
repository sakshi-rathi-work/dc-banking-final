// src/node/methods/bank.js: JSON-RPC banking methods registered on node
const { executeBankOperation } = require('../../txn/executor');
const { getTransactionHistory } = require('../../txn/history');
const { getNodeState } = require('../state');
const { query } = require('../../shared/db/pool');
const { validateAccountId } = require('../../domain/validators');
const { RpcError, ERROR_CODES } = require('../../contracts/errors');

function registerBankMethods(rpcServer, config) {
  // Pre-check for mutating writes
  async function assertPrimary() {
    const state = await getNodeState();
    if (state.role !== 'primary') {
      throw new RpcError(ERROR_CODES.NOT_PRIMARY, `Node ${config.nodeId} is not primary`, {
        leaderHint: state.leader_id || 'a',
        epoch: state.epoch
      });
    }
    return state;
  }

  // Mutating Banking Operations (Primary Only)
  rpcServer.register('bank.createAccount', async (params, meta) => {
    await assertPrimary();
    return executeBankOperation('createAccount', params, meta);
  });

  rpcServer.register('bank.deposit', async (params, meta) => {
    await assertPrimary();
    return executeBankOperation('deposit', params, meta);
  });

  rpcServer.register('bank.withdraw', async (params, meta) => {
    await assertPrimary();
    return executeBankOperation('withdraw', params, meta);
  });

  rpcServer.register('bank.transfer', async (params, meta) => {
    await assertPrimary();
    return executeBankOperation('transfer', params, meta);
  });

  // Read Operations (Can run on any eligible node)
  rpcServer.register('bank.getBalance', async (params) => {
    const accountId = validateAccountId(params.accountId);
    const accRes = await query(`
      SELECT account_id, holder_name, status, balance, currency, version, updated_lsn
      FROM accounts
      WHERE account_id = $1;
    `, [accountId]);

    if (accRes.rows.length === 0) {
      throw new RpcError(ERROR_CODES.ACCOUNT_NOT_FOUND, `Account not found: ${accountId}`);
    }

    const acc = accRes.rows[0];
    const state = await getNodeState();

    return {
      accountId: acc.account_id,
      holderName: acc.holder_name,
      balance: acc.balance,
      currency: acc.currency,
      status: acc.status,
      version: Number(acc.version),
      appliedLsn: Number(acc.updated_lsn),
      leaderLastLsn: Number(state.last_lsn),
      staleBy: Math.max(0, Number(state.last_lsn) - Number(acc.updated_lsn)),
      servedBy: config.nodeId
    };
  });

  rpcServer.register('bank.getAccount', async (params) => {
    const accountId = validateAccountId(params.accountId);
    const accRes = await query(`
      SELECT account_id, holder_name, status, balance, currency, version,
             created_at, updated_at, created_lsn, updated_lsn
      FROM accounts
      WHERE account_id = $1;
    `, [accountId]);

    if (accRes.rows.length === 0) {
      throw new RpcError(ERROR_CODES.ACCOUNT_NOT_FOUND, `Account not found: ${accountId}`);
    }

    const acc = accRes.rows[0];
    const state = await getNodeState();

    return {
      accountId: acc.account_id,
      holderName: acc.holder_name,
      balance: acc.balance,
      currency: acc.currency,
      status: acc.status,
      version: Number(acc.version),
      createdAt: acc.created_at,
      updatedAt: acc.updated_at,
      createdLsn: Number(acc.created_lsn),
      updatedLsn: Number(acc.updated_lsn),
      servedBy: config.nodeId,
      appliedLsn: Number(state.last_lsn)
    };
  });

  rpcServer.register('bank.listAccounts', async () => {
    const res = await query(`
      SELECT account_id, holder_name, status, balance, currency, version
      FROM accounts
      ORDER BY account_id ASC;
    `);

    const state = await getNodeState();
    return {
      accounts: res.rows.map(r => ({
        accountId: r.account_id,
        holderName: r.holder_name,
        balance: r.balance,
        currency: r.currency,
        status: r.status,
        version: Number(r.version)
      })),
      totalAccounts: res.rows.length,
      servedBy: config.nodeId,
      appliedLsn: Number(state.last_lsn)
    };
  });

  rpcServer.register('bank.getHistory', async (params) => {
    const transactions = await getTransactionHistory(null, params);
    const state = await getNodeState();
    return {
      transactions,
      count: transactions.length,
      servedBy: config.nodeId,
      appliedLsn: Number(state.last_lsn)
    };
  });
}

module.exports = {
  registerBankMethods
};
