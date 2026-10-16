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

    const { getFencingManager } = require('../../faulttolerance/fencing');
    const fencing = getFencingManager();
    if (fencing && (!fencing.isLeaseValid() || !fencing.writeGateOpen)) {
      fencing.closeWriteGate();
      throw new RpcError(ERROR_CODES.NOT_PRIMARY, `Leader lease expired on Node ${config.nodeId}`, {
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

  // Read Consistency Enforcement (PROJECT.md Section 19.7)
  async function checkReadConsistency(params) {
    let state = await getNodeState();
    if (state.role === 'recovering') {
      throw new RpcError(ERROR_CODES.NODE_RECOVERING, 'Node is in recovering state');
    }

    // 1. minLsn (read-your-writes): waits up to 1000 ms
    if (params && params.minLsn !== undefined && params.minLsn !== null) {
      const minLsn = Number(params.minLsn);
      const startWait = Date.now();
      while (Number(state.last_lsn) < minLsn) {
        if (Date.now() - startWait >= 1000) {
          throw new RpcError(ERROR_CODES.READ_TOO_STALE, `Node ${config.nodeId} applied LSN ${state.last_lsn} < minLsn ${minLsn}`, {
            appliedLsn: Number(state.last_lsn),
            minLsn,
            leaderLastLsn: Number(state.last_lsn)
          });
        }
        await new Promise(r => setTimeout(r, 50));
        state = await getNodeState();
      }
    }

    const consistency = params && params.consistency;

    // 2. strong consistency: primary only
    if (consistency === 'strong') {
      if (state.role !== 'primary') {
        throw new RpcError(ERROR_CODES.NOT_PRIMARY, `Strong consistency read requires primary node`, {
          leaderHint: state.leader_id || 'a',
          epoch: state.epoch
        });
      }
    }

    // Determine leaderLastLsn
    let leaderLastLsn = Number(state.last_lsn);
    if (state.role !== 'primary') {
      const leaderRow = await query('SELECT last_lsn FROM cluster_nodes WHERE node_id = $1', [state.leader_id || 'a']);
      if (leaderRow.rows.length > 0 && leaderRow.rows[0].last_lsn) {
        leaderLastLsn = Math.max(leaderLastLsn, Number(leaderRow.rows[0].last_lsn));
      }
    }

    const appliedLsn = Number(state.last_lsn);
    const staleBy = Math.max(0, leaderLastLsn - appliedLsn);

    // 3. bounded consistency: maxLagLsn check
    if (consistency === 'bounded') {
      const maxLagLsn = params.maxLagLsn !== undefined ? Number(params.maxLagLsn) : 5;
      if (staleBy > maxLagLsn) {
        throw new RpcError(ERROR_CODES.READ_TOO_STALE, `Node lag ${staleBy} exceeds maxLagLsn ${maxLagLsn}`, {
          appliedLsn,
          leaderLastLsn,
          staleBy,
          maxLagLsn
        });
      }
    }

    return {
      state,
      appliedLsn,
      leaderLastLsn,
      staleBy,
      servedBy: config.nodeId
    };
  }

  // Read Operations (Can run on any eligible node)
  rpcServer.register('bank.getBalance', async (params) => {
    const metaInfo = await checkReadConsistency(params);
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

    return {
      accountId: acc.account_id,
      holderName: acc.holder_name,
      balance: acc.balance,
      currency: acc.currency,
      status: acc.status,
      version: Number(acc.version),
      appliedLsn: metaInfo.appliedLsn,
      leaderLastLsn: metaInfo.leaderLastLsn,
      staleBy: metaInfo.staleBy,
      servedBy: metaInfo.servedBy
    };
  });

  rpcServer.register('bank.getAccount', async (params) => {
    const metaInfo = await checkReadConsistency(params);
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
      servedBy: metaInfo.servedBy,
      appliedLsn: metaInfo.appliedLsn,
      leaderLastLsn: metaInfo.leaderLastLsn,
      staleBy: metaInfo.staleBy
    };
  });

  rpcServer.register('bank.listAccounts', async (params) => {
    const metaInfo = await checkReadConsistency(params);
    const res = await query(`
      SELECT account_id, holder_name, status, balance, currency, version
      FROM accounts
      ORDER BY account_id ASC;
    `);

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
      servedBy: metaInfo.servedBy,
      appliedLsn: metaInfo.appliedLsn,
      leaderLastLsn: metaInfo.leaderLastLsn,
      staleBy: metaInfo.staleBy
    };
  });

  rpcServer.register('bank.getHistory', async (params) => {
    const metaInfo = await checkReadConsistency(params);
    const transactions = await getTransactionHistory(null, params);
    return {
      transactions,
      count: transactions.length,
      servedBy: metaInfo.servedBy,
      appliedLsn: metaInfo.appliedLsn,
      leaderLastLsn: metaInfo.leaderLastLsn,
      staleBy: metaInfo.staleBy
    };
  });
}

module.exports = {
  registerBankMethods
};
