// src/faulttolerance/rejoin.js: Node Rejoin, Binary-Search Common Prefix, and Divergent Log Archiving
// Specification: PROJECT.md Section 21.7, Section 22.1 (F14), Section 28 (Phase 8)
const { query, getClient } = require('../shared/db/pool');
const { callRpc } = require('../shared/rpc/client');
const { getNodeState, updateNodeState } = require('../node/state');
const { applyEntry } = require('../replication/applier');
const { recordEvent } = require('../shared/events');
const { logger } = require('../shared/logger');

/**
 * Execute binary search to find the highest common prefix LSN k between local node and leader.
 */
async function findCommonPrefixLsn(leaderUrl, localLastLsn, leaderLastLsn) {
  let low = 1;
  let high = Math.min(Number(localLastLsn), Number(leaderLastLsn));
  let highestCommon = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);

    // Get local entry hash at mid
    const localRes = await query('SELECT entry_hash FROM replication_log WHERE lsn = $1', [mid]);
    if (localRes.rows.length === 0) {
      high = mid - 1;
      continue;
    }
    const localHash = localRes.rows[0].entry_hash;

    // Get leader entry hash at mid
    let leaderHash = null;
    try {
      const res = await callRpc(leaderUrl, 'replication.hashAt', { lsn: mid }, { timeoutMs: 2000 });
      leaderHash = res ? res.entryHash : null;
    } catch (err) {
      logger.warn({ event: 'rejoin.hash_at_error', lsn: mid, error: err.message });
      high = mid - 1;
      continue;
    }

    if (localHash && leaderHash && localHash === leaderHash) {
      // Common prefix matches up to mid! Search higher
      highestCommon = mid;
      low = mid + 1;
    } else {
      // Diverged at or before mid, search lower
      high = mid - 1;
    }
  }

  return highestCommon;
}

/**
 * Perform rejoin procedure for a recovering node.
 *
 * @param {Object} config - Node configuration
 * @param {Object} targetLeader - { nodeId, url, epoch, lastLsn }
 * @returns {Promise<Object>} Rejoin result
 */
async function executeRejoin(config, targetLeader) {
  const myId = config.nodeId;
  const tStart = Date.now();

  logger.info({
    event: 'rejoin.started',
    nodeId: myId,
    leaderId: targetLeader.nodeId,
    leaderEpoch: targetLeader.epoch,
    leaderLsn: targetLeader.lastLsn
  });

  // Ensure state is recovering
  await updateNodeState({
    role: 'recovering',
    leader_id: targetLeader.nodeId,
    epoch: targetLeader.epoch
  });

  const curState = await getNodeState();
  const localLastLsn = Number(curState.last_lsn || 0);
  const leaderLastLsn = Number(targetLeader.lastLsn || 0);

  // 1. Find common prefix LSN k
  let commonPrefixLsn = 0;
  if (localLastLsn > 0 && leaderLastLsn > 0) {
    commonPrefixLsn = await findCommonPrefixLsn(targetLeader.url, localLastLsn, leaderLastLsn);
  }

  logger.info({
    event: 'rejoin.common_prefix_found',
    nodeId: myId,
    localLastLsn,
    leaderLastLsn,
    commonPrefixLsn
  });

  // 2. Archive divergent entries (> commonPrefixLsn)
  let divergentCount = 0;
  const client = await getClient();

  try {
    await client.query('BEGIN');

    if (localLastLsn > commonPrefixLsn) {
      const divRes = await client.query(`
        SELECT lsn, epoch, entry_type, txn_id, payload, entry_hash
        FROM replication_log
        WHERE lsn > $1
        ORDER BY lsn ASC
      `, [commonPrefixLsn]);

      for (const row of divRes.rows) {
        await client.query(`
          INSERT INTO divergent_log (
            lsn, epoch, entry_type, txn_id, payload, entry_hash, reason
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
          row.lsn,
          row.epoch,
          row.entry_type,
          row.txn_id,
          row.payload,
          row.entry_hash,
          `diverged from epoch ${targetLeader.epoch}`
        ]);
        divergentCount++;
      }

      // Truncate local divergent records from replication_log
      await client.query('DELETE FROM replication_log WHERE lsn > $1', [commonPrefixLsn]);

      // Rebuild state: reset materialized tables and replay own log 1..k
      await client.query('DELETE FROM ledger_entries');
      await client.query('DELETE FROM transactions');
      await client.query('DELETE FROM idempotency_keys');
      await client.query('DELETE FROM accounts');

      const logRows = await client.query(`
        SELECT * FROM replication_log WHERE lsn <= $1 ORDER BY lsn ASC
      `, [commonPrefixLsn]);

      for (const logEntry of logRows.rows) {
        await applyEntry(client, logEntry);
      }

      // Update node_state
      const lastEntryRes = await client.query(`
        SELECT lsn, epoch, entry_hash FROM replication_log WHERE lsn = $1
      `, [commonPrefixLsn]);

      const lastLsn = commonPrefixLsn;
      const lastEpoch = (lastEntryRes.rows.length > 0) ? lastEntryRes.rows[0].epoch : 0;
      const lastHash = (lastEntryRes.rows.length > 0) ? lastEntryRes.rows[0].entry_hash : '';

      await client.query(`
        UPDATE node_state SET
          last_lsn = $1,
          last_epoch = $2,
          last_hash = $3,
          updated_at = now()
        WHERE id = 1
      `, [lastLsn, lastEpoch, lastHash]);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ event: 'rejoin.rebuild_error', error: err.message });
    throw err;
  } finally {
    client.release();
  }

  // 3. Catch up from leader (k + 1 up to leaderLastLsn)
  let caughtUpCount = 0;
  let fromLsn = commonPrefixLsn + 1;

  while (fromLsn <= leaderLastLsn) {
    try {
      const fetchRes = await callRpc(targetLeader.url, 'replication.fetch', {
        fromLsn,
        limit: 100
      }, { timeoutMs: 5000 });

      const entries = (fetchRes && Array.isArray(fetchRes.entries)) ? fetchRes.entries : [];
      if (entries.length === 0) break;

      const applyClient = await getClient();
      try {
        await applyClient.query('BEGIN');
        for (const entry of entries) {
          await applyEntry(applyClient, entry);
          caughtUpCount++;
        }
        await applyClient.query('COMMIT');
      } catch (applyErr) {
        await applyClient.query('ROLLBACK');
        throw applyErr;
      } finally {
        applyClient.release();
      }

      fromLsn += entries.length;
    } catch (fetchErr) {
      logger.error({ event: 'rejoin.fetch_catchup_error', fromLsn, error: fetchErr.message });
      break;
    }
  }

  // 4. Transition to replica
  const postState = await getNodeState();
  const maxLag = config.readMaxLagLsn || 5;
  const currentLag = Math.max(0, leaderLastLsn - Number(postState.last_lsn || 0));

  if (currentLag <= maxLag) {
    await updateNodeState({
      role: 'replica',
      leader_id: targetLeader.nodeId,
      epoch: targetLeader.epoch
    });

    logger.info({
      event: 'rejoin.completed',
      nodeId: myId,
      role: 'replica',
      commonPrefixLsn,
      divergentCount,
      caughtUpCount,
      finalLsn: postState.last_lsn,
      durationMs: Date.now() - tStart
    });
  }

  // Record REJOIN event in event_log
  await recordEvent({
    eventType: 'node.rejoin',
    detail: {
      leaderId: targetLeader.nodeId,
      leaderEpoch: targetLeader.epoch,
      commonPrefixLsn,
      divergentCount,
      caughtUpCount,
      finalLsn: postState.last_lsn,
      durationMs: Date.now() - tStart
    }
  });

  return {
    success: true,
    commonPrefixLsn,
    divergentCount,
    caughtUpCount,
    finalLsn: Number(postState.last_lsn || 0),
    role: currentLag <= maxLag ? 'replica' : 'recovering'
  };
}

module.exports = {
  findCommonPrefixLsn,
  executeRejoin
};
