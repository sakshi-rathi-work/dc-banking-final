// src/node/state.js: Node State and Persistence in node_state table
const { query } = require('../shared/db/pool');

async function initNodeState(nodeId, isBootstrapPrimary) {
  const existing = await query('SELECT * FROM node_state WHERE id = 1');
  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  const role = (nodeId === 'a' || isBootstrapPrimary) ? 'primary' : (nodeId === 'b' ? 'backup' : 'replica');
  const epoch = 1;
  const leaderId = 'a';
  const backupId = 'b';

  await query(`
    INSERT INTO node_state (
      id, node_id, role, epoch, promised_epoch, leader_id, backup_id,
      last_lsn, last_epoch, last_hash, durable_lsn, replication_mode, sync_acks, updated_at
    ) VALUES (
      1, $1, $2, $3, $3, $4, $5, 0, 0, '', 0, 'ASYNC', 2, now()
    )
    ON CONFLICT (id) DO NOTHING
  `, [nodeId, role, epoch, leaderId, backupId]);

  const res = await query('SELECT * FROM node_state WHERE id = 1');
  return res.rows[0];
}

async function getNodeState() {
  const res = await query('SELECT * FROM node_state WHERE id = 1');
  if (res.rows.length === 0) {
    throw new Error('node_state row 1 not initialized');
  }
  return res.rows[0];
}

async function updateNodeState(fields) {
  const setClauses = [];
  const values = [];
  let idx = 1;

  for (const [key, val] of Object.entries(fields)) {
    setClauses.push(`${key} = $${idx++}`);
    values.push(val);
  }
  setClauses.push(`updated_at = now()`);

  const sql = `UPDATE node_state SET ${setClauses.join(', ')} WHERE id = 1 RETURNING *`;
  const res = await query(sql, values);
  return res.rows[0];
}

module.exports = {
  initNodeState,
  getNodeState,
  updateNodeState
};
