// src/faulttolerance/promotion.js: Epoch Promotion Protocol
// Specification: PROJECT.md Section 18.5, Section 21.3, Section 21.4, Section 28 (Phase 6)
const { query, getClient } = require('../shared/db/pool');
const { callRpc } = require('../shared/rpc/client');
const { getNodeState, updateNodeState } = require('../node/state');
const { RpcError, ERROR_CODES } = require('../contracts/errors');
const { computeEntryHash } = require('../domain/invariants');
const { applyEntry } = require('../replication/applier');
const { getLeaderReplicator } = require('../replication/leaderReplicator');
const { lamportClock } = require('../clocks/lamportClock');
const { physicalClock } = require('../clocks/physicalClock');
const { recordEvent } = require('../shared/events');
const { logger } = require('../shared/logger');
const { compareLogPositions, calculateNextEpoch } = require('./epochs');

/**
 * Execute the Promotion Protocol to promote candidateId to primary for new epoch E'.
 *
 * @param {string} candidateId - Node ID attempting promotion
 * @param {string} electionId - Associated election ID
 * @param {Object} options - { excluded = [], config }
 * @returns {Promise<Object>} Promotion result
 */
async function executePromotion(candidateId, electionId, options = {}) {
  const config = options.config || require('../shared/config').loadConfig();
  const excluded = options.excluded || [];
  const tStart = Date.now();

  logger.info({
    event: 'promotion.started',
    candidateId,
    electionId,
    excluded
  });

  // Step 1: Propose E' = max(promised_epoch, epoch) + 1 and persist
  const curState = await getNodeState();
  const proposedEpoch = calculateNextEpoch(curState.promised_epoch, curState.epoch);

  await updateNodeState({
    promised_epoch: proposedEpoch,
    role: 'candidate'
  });

  // Step 2: Request grants from all peers (and self grant)
  const selfGrant = {
    nodeId: candidateId,
    granted: true,
    lastEpoch: Number(curState.last_epoch || 0),
    lastLsn: Number(curState.last_lsn || 0),
    lastHash: curState.last_hash || '',
    durableLsn: Number(curState.durable_lsn || 0)
  };

  const peers = config.peers || {};
  const peerIds = Object.keys(peers).filter(id => id !== candidateId);

  const grantPromises = peerIds.map(async (peerId) => {
    const peer = peers[peerId];
    if (!peer || excluded.includes(peerId)) {
      return { nodeId: peerId, granted: false, reason: 'EXCLUDED' };
    }

    try {
      const res = await callRpc(peer.url, 'cluster.requestEpoch', {
        epoch: proposedEpoch,
        candidateId,
        lastEpoch: Number(curState.last_epoch || 0),
        lastLsn: Number(curState.last_lsn || 0),
        lastHash: curState.last_hash || ''
      }, { timeoutMs: Math.min(config.rpcTimeoutMs || 2000, 2000) });

      if (res && res.granted) {
        return {
          nodeId: peerId,
          granted: true,
          lastEpoch: Number(res.lastEpoch || 0),
          lastLsn: Number(res.lastLsn || 0),
          lastHash: res.lastHash || '',
          durableLsn: Number(res.durableLsn || 0)
        };
      } else {
        return {
          nodeId: peerId,
          granted: false,
          promisedEpoch: res ? res.promisedEpoch : undefined,
          reason: 'REFUSED'
        };
      }
    } catch (err) {
      logger.warn({
        event: 'promotion.grant_request_failed',
        peerId,
        error: err.message
      });
      return { nodeId: peerId, granted: false, reason: 'UNREACHABLE' };
    }
  });

  const responses = await Promise.all(grantPromises);
  const allGrants = [selfGrant, ...responses.filter(r => r.granted)];

  logger.info({
    event: 'promotion.grants_collected',
    candidateId,
    proposedEpoch,
    grantsCount: allGrants.length,
    granters: allGrants.map(g => g.nodeId)
  });

  // Step 3: Quorum check (>= 3 of 4)
  if (allGrants.length < 3) {
    // Revert role to replica if refused
    await updateNodeState({ role: 'replica' });

    logger.error({
      event: 'promotion.refused',
      candidateId,
      reason: 'NO_QUORUM',
      grantsCount: allGrants.length,
      required: 3
    });

    throw new RpcError(ERROR_CODES.PROMOTION_REFUSED, 'PROMOTION_REFUSED: NO_QUORUM', {
      reason: 'NO_QUORUM',
      grantsCount: allGrants.length,
      required: 3
    });
  }

  // Step 4: Required log and catch-up
  // Find highest log position among granters
  let targetGranter = allGrants[0];
  let maxDurableLsn = 0;

  for (const grant of allGrants) {
    if (compareLogPositions(grant, targetGranter) > 0) {
      targetGranter = grant;
    }
    if (grant.durableLsn > maxDurableLsn) {
      maxDurableLsn = grant.durableLsn;
    }
  }

  let freshState = await getNodeState();
  let catchUpEntries = 0;

  if (compareLogPositions(freshState, targetGranter) < 0) {
    logger.info({
      event: 'promotion.catch_up_required',
      candidateLsn: freshState.last_lsn,
      targetLsn: targetGranter.lastLsn,
      targetGranter: targetGranter.nodeId
    });

    try {
      const targetPeer = peers[targetGranter.nodeId];
      if (!targetPeer) {
        throw new Error(`Target granter ${targetGranter.nodeId} not found in peers`);
      }

      const fetchRes = await callRpc(targetPeer.url, 'replication.fetch', {
        fromLsn: Number(freshState.last_lsn) + 1,
        limit: 1000
      }, { timeoutMs: 5000 });

      const entries = (fetchRes && Array.isArray(fetchRes.entries)) ? fetchRes.entries : [];
      if (entries.length > 0) {
        const client = await getClient();
        try {
          await client.query('BEGIN');
          for (const entry of entries) {
            await applyEntry(client, entry);
            catchUpEntries++;
          }
          await client.query('COMMIT');
        } catch (applyErr) {
          await client.query('ROLLBACK');
          throw applyErr;
        } finally {
          client.release();
        }
      }

      freshState = await getNodeState();
    } catch (fetchErr) {
      await updateNodeState({ role: 'replica' });

      logger.error({
        event: 'promotion.refused',
        candidateId,
        reason: 'STALE_CANDIDATE',
        error: fetchErr.message
      });

      throw new RpcError(ERROR_CODES.PROMOTION_REFUSED, 'PROMOTION_REFUSED: STALE_CANDIDATE', {
        reason: 'STALE_CANDIDATE',
        detail: `Catch-up from ${targetGranter.nodeId} failed: ${fetchErr.message}`
      });
    }
  }

  // Step 5: Safety check (lastLsn >= requiredDurable)
  if (Number(freshState.last_lsn) < maxDurableLsn) {
    await updateNodeState({ role: 'replica' });

    logger.error({
      event: 'promotion.refused',
      candidateId,
      reason: 'STALE_CANDIDATE',
      lastLsn: freshState.last_lsn,
      requiredDurable: maxDurableLsn
    });

    throw new RpcError(ERROR_CODES.PROMOTION_REFUSED, 'PROMOTION_REFUSED: STALE_CANDIDATE', {
      reason: 'STALE_CANDIDATE',
      detail: `Candidate last_lsn (${freshState.last_lsn}) < requiredDurable (${maxDurableLsn})`
    });
  }

  // Step 6: Choose backupId & Open Epoch with EPOCH_START entry
  // backupId = healthy follower with highest match/lastLsn (ties: lowest ID)
  const followerGranters = allGrants.filter(g => g.nodeId !== candidateId);
  followerGranters.sort((a, b) => {
    if (b.lastLsn !== a.lastLsn) return b.lastLsn - a.lastLsn;
    return a.nodeId.localeCompare(b.nodeId);
  });

  const chosenBackupId = followerGranters.length > 0 ? followerGranters[0].nodeId : 'b';

  // Open Epoch inside single SQL transaction
  const client = await getClient();
  let epochStartLsn = 0;
  let epochStartHash = '';

  try {
    await client.query('BEGIN');

    // 1. Lock node_state
    const nsRes = await client.query('SELECT * FROM node_state WHERE id = 1 FOR UPDATE');
    const ns = nsRes.rows[0];

    epochStartLsn = Number(ns.last_lsn) + 1;
    const prevHash = ns.last_hash || '';
    const epochStartPayload = {
      epochStart: {
        epoch: proposedEpoch,
        leaderId: candidateId,
        backupId: chosenBackupId
      }
    };

    lamportClock.tick();
    const lamport = lamportClock.get();
    const physicalTs = physicalClock.now();

    epochStartHash = computeEntryHash(prevHash, epochStartLsn, proposedEpoch, epochStartPayload);

    // 2. Insert EPOCH_START into replication_log
    await client.query(`
      INSERT INTO replication_log (
        lsn, epoch, entry_type, txn_id, payload, prev_hash, entry_hash,
        origin_node, lamport, physical_ts, committed_at
      ) VALUES ($1, $2, 'EPOCH_START', NULL, $3, $4, $5, $6, $7, $8, now());
    `, [
      epochStartLsn,
      proposedEpoch,
      JSON.stringify(epochStartPayload),
      prevHash,
      epochStartHash,
      candidateId,
      lamport,
      physicalTs
    ]);

    // 3. Update node_state to primary
    await client.query(`
      UPDATE node_state SET
        role = 'primary',
        epoch = $1,
        promised_epoch = $1,
        leader_id = $2,
        backup_id = $3,
        last_lsn = $4,
        last_epoch = $1,
        last_hash = $5,
        updated_at = now()
      WHERE id = 1;
    `, [
      proposedEpoch,
      candidateId,
      chosenBackupId,
      epochStartLsn,
      epochStartHash
    ]);

    await client.query('COMMIT');
  } catch (txErr) {
    await client.query('ROLLBACK');
    throw txErr;
  } finally {
    client.release();
  }

  // Start leader replicator
  const replicator = getLeaderReplicator();
  if (replicator) {
    try {
      await replicator.init();
      replicator.start();
      logger.info({ event: 'promotion.leader_replicator_started' });
    } catch (repErr) {
      logger.error({ event: 'promotion.replicator_start_error', error: repErr.message });
    }
  }

  // Step 7: Announce leader to all peers
  await Promise.all(peerIds.map(async (peerId) => {
    const peer = peers[peerId];
    if (!peer) return;

    try {
      await callRpc(peer.url, 'cluster.announceLeader', {
        epoch: proposedEpoch,
        leaderId: candidateId,
        lastLsn: epochStartLsn,
        backupId: chosenBackupId
      }, { timeoutMs: 1500 });
    } catch (annErr) {
      logger.debug({ event: 'promotion.announce_peer_error', peerId, error: annErr.message });
    }
  }));

  // Step 8: Report FAILOVER_REPORT event
  const durationMs = Date.now() - tStart;
  await recordEvent({
    eventType: 'FAILOVER_REPORT',
    detail: {
      electionId,
      oldLeader: curState.leader_id,
      oldEpoch: curState.epoch,
      newLeader: candidateId,
      newEpoch: proposedEpoch,
      backupId: chosenBackupId,
      durationMs,
      catchUpEntries,
      epochStartLsn,
      grantsCount: allGrants.length
    }
  });

  logger.info({
    event: 'promotion.completed',
    candidateId,
    epoch: proposedEpoch,
    backupId: chosenBackupId,
    epochStartLsn,
    durationMs
  });

  return {
    success: true,
    candidateId,
    epoch: proposedEpoch,
    backupId: chosenBackupId,
    epochStartLsn,
    durationMs,
    grants: allGrants
  };
}

module.exports = {
  executePromotion
};
