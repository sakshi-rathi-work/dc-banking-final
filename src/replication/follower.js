// src/replication/follower.js: Follower inbound append receiver
// Specification: PROJECT.md Section 19.3

const { getPool } = require('../shared/db/pool');
const { RpcError, ERROR_CODES } = require('../contracts/errors');
const { computeEntryHash } = require('../domain/invariants');
const { applyEntry } = require('./applier');
const { faults } = require('../shared/faults');
const { recordEvent } = require('../shared/events');
const { logger } = require('../shared/logger');

/**
 * Handle incoming replication.append RPC from the primary.
 *
 * @param {Object} params
 * @param {number} params.epoch - Leader's current epoch
 * @param {string} params.leaderId - Leader node identifier ('a', 'b', etc.)
 * @param {number} params.prevLsn - LSN immediately preceding the entries batch
 * @param {string} params.prevHash - Hash of the entry at prevLsn
 * @param {Array<Object>} params.entries - Batch of replication_log entries
 * @param {number} [params.leaderLastLsn] - Leader's highest committed LSN
 * @param {number} [params.durableLsn] - Highest quorum-acknowledged LSN
 * @param {Object} [meta] - Request metadata
 * @returns {Promise<Object>} Append result: { ok, appliedLsn, lastHash, duplicates, reason? }
 */
async function handleAppend(params, meta = {}) {
  const {
    epoch,
    leaderId,
    prevLsn = 0,
    prevHash = '',
    entries = [],
    leaderLastLsn = 0,
    durableLsn = 0
  } = params;

  // Fault Hook: dropNextAppend
  const dropCount = faults.getFault('dropNextAppend');
  if (typeof dropCount === 'number' && dropCount > 0) {
    faults.setFault('dropNextAppend', dropCount - 1);
    logger.warn({ event: 'replication.fault_drop_append', remainingDrops: dropCount - 1 });
    throw new RpcError(ERROR_CODES.INTERNAL_ERROR, 'Dropped append request by fault injection');
  }

  // Fault Hook: applyDelayMs
  const applyDelay = faults.getFault('applyDelayMs');
  if (typeof applyDelay === 'number' && applyDelay > 0) {
    await new Promise(resolve => setTimeout(resolve, applyDelay));
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN;');

    // 1. Lock node_state row 1 FOR UPDATE
    const stateRes = await client.query(`
      SELECT id, node_id, role, epoch, promised_epoch, leader_id, last_lsn, last_epoch, last_hash, durable_lsn
      FROM node_state
      WHERE id = 1
      FOR UPDATE;
    `);

    if (stateRes.rows.length === 0) {
      throw new RpcError(ERROR_CODES.INTERNAL_ERROR, 'node_state not initialized');
    }

    const state = stateRes.rows[0];
    const promisedEpoch = state.promised_epoch;

    // Epoch validation
    if (epoch < promisedEpoch) {
      await client.query('ROLLBACK;');
      throw new RpcError(ERROR_CODES.STALE_LEADER, `Leader epoch ${epoch} is lower than promised epoch ${promisedEpoch}`, {
        epoch,
        promisedEpoch
      });
    }

    // Step down if was primary of an earlier epoch
    let role = state.role;
    if (role === 'primary' && epoch > state.epoch) {
      role = 'replica';
    }

    // Adopt leader and epoch if higher
    if (epoch >= state.epoch) {
      await client.query(`
        UPDATE node_state SET
          epoch = $1,
          leader_id = $2,
          role = $3,
          updated_at = now()
        WHERE id = 1;
      `, [epoch, leaderId, role]);
    }

    let currentLastLsn = Number(state.last_lsn);
    let currentLastHash = state.last_hash || '';

    // 2. Continuity checks
    if (prevLsn > currentLastLsn) {
      await client.query('ROLLBACK;');
      return {
        ok: false,
        reason: 'GAP',
        lastLsn: currentLastLsn
      };
    }

    if (prevLsn > 0) {
      const localAtPrevRes = await client.query(`
        SELECT entry_hash FROM replication_log WHERE lsn = $1;
      `, [prevLsn]);

      if (localAtPrevRes.rows.length === 0) {
        await client.query('ROLLBACK;');
        return {
          ok: false,
          reason: 'GAP',
          lastLsn: currentLastLsn
        };
      }

      const localPrevHash = localAtPrevRes.rows[0].entry_hash;
      if (localPrevHash !== prevHash) {
        await client.query('ROLLBACK;');
        return {
          ok: false,
          reason: 'REPLICATION_DIVERGED',
          lsn: prevLsn,
          localHash: localPrevHash,
          leaderHash: prevHash
        };
      }
    }

    // 3. Process entries in strict order
    let duplicates = 0;

    for (const entry of entries) {
      const entryLsn = Number(entry.lsn);

      if (entryLsn <= currentLastLsn) {
        // Check for duplicate or divergence
        const localEntryRes = await client.query(`
          SELECT entry_hash FROM replication_log WHERE lsn = $1;
        `, [entryLsn]);

        if (localEntryRes.rows.length > 0 && localEntryRes.rows[0].entry_hash === entry.entryHash) {
          duplicates++;
          continue;
        } else {
          await client.query('ROLLBACK;');
          return {
            ok: false,
            reason: 'REPLICATION_DIVERGED',
            lsn: entryLsn
          };
        }
      }

      if (entryLsn === currentLastLsn + 1) {
        // Verify prevHash
        if (entry.prevHash !== currentLastHash && currentLastLsn > 0) {
          await client.query('ROLLBACK;');
          return {
            ok: false,
            reason: 'REPLICATION_DIVERGED',
            lsn: entryLsn
          };
        }

        // Verify entryHash integrity
        const calculatedHash = computeEntryHash(entry.prevHash, entry.lsn, entry.epoch, entry.payload);
        if (calculatedHash !== entry.entryHash) {
          await client.query('ROLLBACK;');
          return {
            ok: false,
            reason: 'REPLICATION_DIVERGED',
            lsn: entryLsn
          };
        }

        // 4. Apply entry effects
        await applyEntry(client, entry);

        currentLastLsn = entryLsn;
        currentLastHash = entry.entryHash;
      } else {
        // Gap detected
        await client.query('ROLLBACK;');
        return {
          ok: false,
          reason: 'GAP',
          lastLsn: currentLastLsn
        };
      }
    }

    // 5. Update durable_lsn if provided and advances
    if (durableLsn > Number(state.durable_lsn)) {
      await client.query(`
        UPDATE node_state SET durable_lsn = $1 WHERE id = 1;
      `, [durableLsn]);
    }

    await client.query('COMMIT;');

    await recordEvent({
      eventType: 'replication.append_ack',
      detail: {
        appliedLsn: currentLastLsn,
        duplicates,
        entryCount: entries.length
      }
    }).catch(() => {});

    if (duplicates > 0) {
      followerDuplicates += duplicates;
    }

    return {
      ok: true,
      appliedLsn: currentLastLsn,
      lastHash: currentLastHash,
      duplicates
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK;');
    } catch (_) {}

    // Record error in replication_errors table
    await client.query(`
      INSERT INTO replication_errors (peer_id, lsn, error_code, detail)
      VALUES ($1, $2, $3, $4);
    `, [leaderId, params.prevLsn, err.code || 'APPEND_ERROR', JSON.stringify({ message: err.message })]).catch(() => {});

    throw err;
  } finally {
    client.release();
  }
}

let followerDuplicates = 0;

function getFollowerDuplicates() {
  return followerDuplicates;
}

module.exports = {
  handleAppend,
  getFollowerDuplicates
};

