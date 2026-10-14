// src/txn/history.js: Query transaction history
const { getPool } = require('../shared/db/pool');

async function getTransactionHistory(clientOrPool, options = {}) {
  const runner = clientOrPool || getPool();
  const limit = Math.min(Math.max(parseInt(options.limit || '50', 10), 1), 500);
  const conditions = [];
  const values = [];
  let idx = 1;

  if (options.accountId) {
    conditions.push(`(source_account_id = $${idx} OR destination_account_id = $${idx})`);
    values.push(options.accountId);
    idx++;
  }

  if (options.beforeLsn) {
    conditions.push(`lsn < $${idx}`);
    values.push(options.beforeLsn);
    idx++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(limit);

  const sql = `
    SELECT
      txn_id, idempotency_key, type, source_account_id, destination_account_id,
      amount, currency, status, reject_reason, request_id, origin_node,
      leader_id, epoch, lsn, lamport_ts, physical_ts_ms, committed_at
    FROM transactions
    ${whereClause}
    ORDER BY lsn DESC
    LIMIT $${idx};
  `;

  const res = await runner.query(sql, values);
  return res.rows.map(r => ({
    txnId: r.txn_id,
    idempotencyKey: r.idempotency_key,
    type: r.type,
    sourceAccountId: r.source_account_id,
    destinationAccountId: r.destination_account_id,
    amount: r.amount,
    currency: r.currency,
    status: r.status,
    rejectReason: r.reject_reason,
    requestId: r.request_id,
    originNode: r.origin_node,
    leaderId: r.leader_id,
    epoch: r.epoch,
    lsn: Number(r.lsn),
    lamport: Number(r.lamport_ts),
    physicalTs: Number(r.physical_ts_ms),
    committedAt: r.committed_at
  }));
}

module.exports = {
  getTransactionHistory
};
