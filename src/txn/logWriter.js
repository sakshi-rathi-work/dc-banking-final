// src/txn/logWriter.js: LSN allocation, hash chaining, and replication_log writing inside transaction
const { computeEntryHash } = require('../domain/invariants');
const { RpcError, ERROR_CODES } = require('../contracts/errors');

async function writeLogEntry(client, { entryType, txnId = null, payload, meta = {} }) {
  // 1. Lock node_state row 1 to serialize LSN allocation and fence leadership
  const stateRes = await client.query(`
    SELECT id, node_id, role, epoch, promised_epoch, leader_id, last_lsn, last_epoch, last_hash
    FROM node_state
    WHERE id = 1
    FOR UPDATE;
  `);

  if (stateRes.rows.length === 0) {
    throw new RpcError(ERROR_CODES.INTERNAL_ERROR, 'node_state not initialized');
  }

  const state = stateRes.rows[0];

  // Leadership Fencing Check
  if (state.role !== 'primary') {
    throw new RpcError(ERROR_CODES.NOT_PRIMARY, 'Node is not primary', {
      leaderHint: state.leader_id || 'a',
      epoch: state.epoch
    });
  }

  if (state.epoch !== state.promised_epoch) {
    throw new RpcError(ERROR_CODES.STALE_LEADER, 'Leader epoch is stale', {
      epoch: state.epoch,
      promisedEpoch: state.promised_epoch
    });
  }

  const lsn = Number(state.last_lsn) + 1;
  const epoch = state.epoch;
  const prevHash = state.last_hash || '';
  const originNode = state.node_id;

  const safeMeta = meta || {};
  const lamport = safeMeta.lamport !== undefined ? Number(safeMeta.lamport) : 0;
  const physicalTs = safeMeta.physicalTs !== undefined ? Number(safeMeta.physicalTs) : Date.now();

  const entryHash = computeEntryHash(prevHash, lsn, epoch, payload);

  // 2. Insert into replication_log
  await client.query(`
    INSERT INTO replication_log (
      lsn, epoch, entry_type, txn_id, payload, prev_hash, entry_hash,
      origin_node, lamport, physical_ts, committed_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now());
  `, [
    lsn,
    epoch,
    entryType,
    txnId,
    JSON.stringify(payload),
    prevHash,
    entryHash,
    originNode,
    lamport,
    physicalTs
  ]);

  // 3. Update node_state
  await client.query(`
    UPDATE node_state SET
      last_lsn = $1,
      last_epoch = $2,
      last_hash = $3,
      updated_at = now()
    WHERE id = 1;
  `, [lsn, epoch, entryHash]);

  return {
    lsn,
    epoch,
    prevHash,
    entryHash,
    originNode,
    lamport,
    physicalTs
  };
}

module.exports = {
  writeLogEntry
};
