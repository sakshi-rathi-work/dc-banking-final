// src/faulttolerance/failoverController.js: Automatic Failover Controller, Backup-first, and Refusal Handling
// Specification: PROJECT.md Section 18.5, Section 21.2, Section 21.4, Section 28 (Phase 8)
const { getNodeState, updateNodeState } = require('../node/state');
const { executePromotion } = require('./promotion');
const { startBullyElection } = require('../election/bully');
const { startRingElection } = require('../election/ring');
const { query } = require('../shared/db/pool');
const { writeLogEntry } = require('../txn/logWriter');
const { getClient } = require('../shared/db/pool');
const { logger } = require('../shared/logger');

class FailoverController {
  constructor(config, failureDetector) {
    this.config = config;
    this.nodeId = config.nodeId;
    this.failureDetector = failureDetector;
    this.backupGraceMs = config.backupGraceMs || 5000;
    this.electionAlgorithm = (config.electionAlgorithm || 'bully').toLowerCase();

    this.excludedCandidates = new Map(); // nodeId -> expiryTimestamp
    this.handlingFailover = false;
    this.graceTimer = null;
  }

  getExcludedNodes() {
    const now = Date.now();
    const active = [];
    for (const [id, expiry] of this.excludedCandidates.entries()) {
      if (now < expiry) {
        active.push(id);
      } else {
        this.excludedCandidates.delete(id);
      }
    }
    return active;
  }

  excludeCandidate(nodeId, ttlMs = 30000) {
    this.excludedCandidates.set(nodeId, Date.now() + ttlMs);
    logger.warn({
      event: 'failover.candidate_excluded',
      nodeId,
      ttlMs
    });
  }

  /**
   * Called when failure detector suspects a peer.
   */
  async onPeerSuspected(suspectedPeerId) {
    let curState;
    try {
      curState = await getNodeState();
    } catch (_) {
      return;
    }

    // 1. If this node is primary and in SYNC mode, and the suspected peer is the designated backup:
    // Re-designate next healthy follower via CONFIG_CHANGE (PROJECT.md Section 19.5, 22.1 F1)
    if (curState.role === 'primary' && curState.replication_mode === 'SYNC' && suspectedPeerId === curState.backup_id) {
      await this.handleBackupRedesignation(curState);
      return;
    }

    // 2. If the suspected peer is the current leader:
    if (suspectedPeerId === curState.leader_id && curState.role !== 'primary') {
      await this.handlePrimaryFailure(curState);
    }
  }

  async handleBackupRedesignation(curState) {
    logger.warn({
      event: 'failover.backup_suspected',
      oldBackupId: curState.backup_id,
      primaryId: this.nodeId
    });

    const peerStates = this.failureDetector ? await this.failureDetector.getPeerStates() : {};
    const healthyFollowers = Object.entries(peerStates).filter(([id, p]) => {
      return id !== this.nodeId && id !== curState.backup_id && !p.suspected;
    });

    if (healthyFollowers.length === 0) {
      logger.error({ event: 'failover.no_healthy_followers_for_backup' });
      return;
    }

    // Sort by highest lastLsn, tie break lowest ID
    healthyFollowers.sort((a, b) => {
      const lsnA = a[1].lastLsn || 0;
      const lsnB = b[1].lastLsn || 0;
      if (lsnB !== lsnA) return lsnB - lsnA;
      return a[0].localeCompare(b[0]);
    });

    const newBackupId = healthyFollowers[0][0];

    const client = await getClient();
    try {
      await client.query('BEGIN');
      await writeLogEntry(client, {
        entryType: 'CONFIG_CHANGE',
        payload: {
          config: {
            backupId: newBackupId,
            replicationMode: curState.replication_mode,
            syncAcks: curState.sync_acks
          }
        }
      });
      await client.query('UPDATE node_state SET backup_id = $1 WHERE id = 1', [newBackupId]);
      await client.query('COMMIT');

      logger.info({
        event: 'failover.backup_redesignated',
        newBackupId,
        oldBackupId: curState.backup_id
      });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ event: 'failover.backup_redesignate_error', error: err.message });
    } finally {
      client.release();
    }
  }

  async handlePrimaryFailure(curState) {
    if (this.handlingFailover) return;
    this.handlingFailover = true;

    try {
      const myId = this.nodeId;
      const isDesignatedBackup = curState.role === 'backup' || (curState.backup_id === myId);

      if (isDesignatedBackup) {
        // Backup-first: start promotion immediately
        logger.info({ event: 'failover.backup_first_trigger', candidateId: myId });
        await this.runPromotionWithFallback(myId, `failover-${Date.now()}`);
      } else {
        // Other followers wait BACKUP_GRACE_MS
        logger.info({
          event: 'failover.follower_grace_wait',
          nodeId: myId,
          graceMs: this.backupGraceMs
        });

        await new Promise(r => setTimeout(r, this.backupGraceMs));

        // Check if a new leader promoted in the meantime
        const freshState = await getNodeState();
        if (freshState.epoch > curState.epoch && freshState.leader_id && freshState.leader_id !== curState.leader_id) {
          logger.info({
            event: 'failover.new_leader_detected_after_grace',
            newLeader: freshState.leader_id,
            newEpoch: freshState.epoch
          });
          return;
        }

        // No new leader appeared: run election among eligible nodes
        logger.info({
          event: 'failover.fallback_election_trigger',
          algorithm: this.electionAlgorithm,
          nodeId: myId
        });

        await this.runElectionFailover();
      }
    } finally {
      this.handlingFailover = false;
    }
  }

  async runPromotionWithFallback(candidateId, electionId) {
    const excluded = this.getExcludedNodes();

    try {
      await executePromotion(candidateId, electionId, { excluded, config: this.config });
      logger.info({ event: 'failover.promotion_succeeded', candidateId });
    } catch (err) {
      logger.warn({
        event: 'failover.promotion_failed',
        candidateId,
        reason: err.message
      });

      if (err.data && err.data.reason === 'STALE_CANDIDATE') {
        this.excludeCandidate(candidateId);
        // Rerun election excluding stale candidate
        await this.runElectionFailover();
      }
    }
  }

  async runElectionFailover() {
    const excluded = this.getExcludedNodes();

    try {
      if (this.electionAlgorithm === 'ring') {
        await startRingElection(this.config, { excluded });
      } else {
        await startBullyElection(this.config, { excluded });
      }
    } catch (err) {
      logger.error({ event: 'failover.election_error', error: err.message });
    }
  }
}

let failoverControllerInstance = null;

function initFailoverController(config, failureDetector) {
  failoverControllerInstance = new FailoverController(config, failureDetector);
  return failoverControllerInstance;
}

function getFailoverController() {
  return failoverControllerInstance;
}

module.exports = {
  FailoverController,
  initFailoverController,
  getFailoverController
};
