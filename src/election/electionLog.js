// src/election/electionLog.js: Election log recording and query utility
// Specification: PROJECT.md Section 18.1, Section 18.2, Section 18.3, Section 28 (Phase 6)
const { query } = require('../shared/db/pool');
const { lamportClock } = require('../clocks/lamportClock');
const { physicalClock } = require('../clocks/physicalClock');
const { logger } = require('../shared/logger');

/**
 * Record an election protocol message to the persistent election_log table.
 * Direction must be one of: 'SENT', 'RECEIVED', 'LOCAL'.
 */
async function recordElectionMessage({
  electionId,
  algorithm,
  direction,
  peerId = null,
  messageType,
  detail = {}
}) {
  const lamport = lamportClock.get();
  const physicalTs = physicalClock.now();

  try {
    const res = await query(`
      INSERT INTO election_log (
        election_id, algorithm, direction, peer_id, message_type,
        lamport, physical_ts, detail
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;
    `, [
      electionId,
      algorithm,
      direction,
      peerId,
      messageType,
      lamport,
      physicalTs,
      JSON.stringify(detail || {})
    ]);

    logger.debug({
      event: 'election.log_recorded',
      electionId,
      algorithm,
      direction,
      peerId,
      messageType,
      lamport
    });

    return res.rows[0];
  } catch (err) {
    logger.error({
      event: 'election.log_record_error',
      electionId,
      messageType,
      error: err.message
    });
    // Non-fatal if DB is down or connection lost, but log error
    return null;
  }
}

/**
 * Fetch election log entries, optionally filtered by electionId.
 */
async function getElectionLogs({ electionId = null, limit = 100 } = {}) {
  let sql = 'SELECT * FROM election_log';
  const params = [];

  if (electionId) {
    sql += ' WHERE election_id = $1';
    params.push(electionId);
  }

  sql += ' ORDER BY id ASC LIMIT $' + (params.length + 1);
  params.push(limit);

  const res = await query(sql, params);
  return res.rows;
}

module.exports = {
  recordElectionMessage,
  getElectionLogs
};
