// src/replication/ackTracker.js: Acknowledgement tracking and quorum durability calculation
// Specification: PROJECT.md Section 19.4, Section 19.5

const { query } = require('../shared/db/pool');
const { RpcError, ERROR_CODES } = require('../contracts/errors');
const { logger } = require('../shared/logger');

class AckTracker {
  constructor(nodeId = 'a', backupId = 'b', syncAcks = 2) {
    this.nodeId = nodeId;
    this.backupId = backupId;
    this.syncAcks = Number(syncAcks || 2);
    this.peerMatches = new Map(); // peerId -> matchLsn
    this.peerLatencies = new Map(); // peerId -> ackLatencyMs
    this.durableLsn = 0;
    this.leaderLastLsn = 0;
    this.waiters = []; // { lsn, resolve, reject, timer }
  }

  /**
   * Set leader's current last LSN
   */
  setLeaderLastLsn(lsn) {
    this.leaderLastLsn = Number(lsn || 0);
  }

  /**
   * Update configuration parameters
   */
  updateConfig({ backupId, syncAcks }) {
    if (backupId) this.backupId = backupId;
    if (syncAcks !== undefined) this.syncAcks = Number(syncAcks);
    this.recomputeDurableLsn();
  }

  /**
   * Update a peer's acknowledged LSN and latency.
   *
   * @param {string} peerId
   * @param {number} matchLsn
   * @param {number} [ackLatencyMs]
   */
  async updatePeerMatch(peerId, matchLsn, ackLatencyMs = 0) {
    const prevMatch = this.peerMatches.get(peerId) || 0;
    const newMatch = Math.max(prevMatch, Number(matchLsn));
    this.peerMatches.set(peerId, newMatch);
    if (ackLatencyMs !== undefined) {
      this.peerLatencies.set(peerId, ackLatencyMs);
    }

    // Persist to replication_peer_state
    try {
      await query(`
        INSERT INTO replication_peer_state (peer_id, match_lsn, state, last_ack_at, last_ack_ms)
        VALUES ($1, $2, 'STREAMING', now(), $3)
        ON CONFLICT (peer_id) DO UPDATE SET
          match_lsn = GREATEST(replication_peer_state.match_lsn, EXCLUDED.match_lsn),
          state = 'STREAMING',
          last_ack_at = now(),
          last_ack_ms = EXCLUDED.last_ack_ms;
      `, [peerId, newMatch, ackLatencyMs]);
    } catch (err) {
      logger.debug({ event: 'ack_tracker.peer_state_update_error', peerId, error: err.message });
    }

    this.recomputeDurableLsn();
  }

  /**
   * Recompute durable LSN based on current peer matches and quorum policy.
   * durable_lsn = highest LSN present on backup + at least (syncAcks - 1) other followers.
   */
  recomputeDurableLsn() {
    const backupMatch = this.peerMatches.get(this.backupId) || 0;

    // Collect other follower matches (excluding primary and backup)
    const otherMatches = [];
    for (const [peerId, match] of this.peerMatches.entries()) {
      if (peerId !== this.nodeId && peerId !== this.backupId) {
        otherMatches.push(match);
      }
    }

    // Sort descending
    otherMatches.sort((a, b) => b - a);

    const requiredOtherFollowers = Math.max(1, this.syncAcks - 1);
    let otherFollowerQuorumMatch = 0;

    if (otherMatches.length >= requiredOtherFollowers) {
      otherFollowerQuorumMatch = otherMatches[requiredOtherFollowers - 1];
    }

    // Quorum durability requires BOTH the designated backup AND the other follower quorum
    const calculated = Math.min(backupMatch, otherFollowerQuorumMatch);
    const bounded = Math.min(calculated, this.leaderLastLsn > 0 ? this.leaderLastLsn : calculated);

    if (bounded > this.durableLsn) {
      const oldDurable = this.durableLsn;
      this.durableLsn = bounded;

      logger.debug({
        event: 'ack_tracker.durable_lsn_advanced',
        oldDurable,
        newDurable: bounded,
        backupMatch,
        otherFollowerQuorumMatch
      });

      // Update node_state
      query(`
        UPDATE node_state SET durable_lsn = $1 WHERE id = 1;
      `, [bounded]).catch(() => {});

      // Resolve waiters
      this.notifyWaiters();
    }

    return this.durableLsn;
  }

  /**
   * Await quorum durability for a specific LSN (used in SYNC replication mode).
   *
   * @param {number} lsn - Target LSN to wait for
   * @param {number} [timeoutMs=3000] - Quorum wait timeout in milliseconds
   * @param {string} [txnId] - Transaction UUID for error reporting
   * @returns {Promise<number>} Resolves with durableLsn
   */
  awaitDurability(lsn, timeoutMs = 3000, txnId = null) {
    const targetLsn = Number(lsn);

    if (this.durableLsn >= targetLsn) {
      return Promise.resolve(this.durableLsn);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove from waiters list
        this.waiters = this.waiters.filter(w => w !== waiterObj);

        const err = new RpcError(
          ERROR_CODES.REPLICATION_QUORUM_TIMEOUT,
          `Replication quorum not confirmed within ${timeoutMs}ms for LSN ${targetLsn}`,
          {
            outcome: 'INDETERMINATE',
            lsn: targetLsn,
            txnId,
            durableLsn: this.durableLsn
          }
        );
        reject(err);
      }, timeoutMs);

      const waiterObj = {
        lsn: targetLsn,
        resolve: (durable) => {
          clearTimeout(timer);
          resolve(durable);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      };

      this.waiters.push(waiterObj);
    });
  }

  notifyWaiters() {
    const remaining = [];
    for (const w of this.waiters) {
      if (this.durableLsn >= w.lsn) {
        w.resolve(this.durableLsn);
      } else {
        remaining.push(w);
      }
    }
    this.waiters = remaining;
  }

  getPeerStatus() {
    const res = {};
    for (const [peerId, match] of this.peerMatches.entries()) {
      res[peerId] = {
        matchLsn: match,
        lagLsn: Math.max(0, this.leaderLastLsn - match),
        lastAckMs: this.peerLatencies.get(peerId) || 0
      };
    }
    return res;
  }
}

module.exports = {
  AckTracker
};
