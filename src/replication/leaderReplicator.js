// src/replication/leaderReplicator.js: Leader replication streaming sender and peer coordination
// Specification: PROJECT.md Section 19.4, Section 19.5, Section 19.6

const { callRpc } = require('../shared/rpc/client');
const { query } = require('../shared/db/pool');
const { logger } = require('../shared/logger');
const { faults } = require('../shared/faults');
const { AckTracker } = require('./ackTracker');
const { RpcError, ERROR_CODES } = require('../contracts/errors');

class LeaderReplicator {
  constructor(config, failureDetector) {
    this.config = config;
    this.nodeId = config.nodeId;
    this.peers = config.peers; // { a: { url, rank }, ... }
    this.failureDetector = failureDetector;
    this.ackTracker = new AckTracker(this.nodeId, 'b', 2);
    this.timer = null;
    this.running = false;
    this.inFlight = new Map(); // peerId -> boolean
    this.pendingPass = new Map(); // peerId -> boolean
    this.batchSize = 100;
    this.asyncIntervalMs = 100; // ASYNC_BATCH_INTERVAL_MS
  }

  async init() {
    // 1. Fetch current node_state
    const stateRes = await query('SELECT role, backup_id, sync_acks, last_lsn, durable_lsn FROM node_state WHERE id = 1');
    if (stateRes.rows.length > 0) {
      const state = stateRes.rows[0];
      this.ackTracker.updateConfig({
        backupId: state.backup_id || 'b',
        syncAcks: Number(state.sync_acks || 2)
      });
      this.ackTracker.setLeaderLastLsn(Number(state.last_lsn || 0));
    }

    // 2. Initialize replication_peer_state for all peers
    const peerIds = Object.keys(this.peers).filter(id => id !== this.nodeId);
    for (const peerId of peerIds) {
      await query(`
        INSERT INTO replication_peer_state (peer_id, match_lsn, next_lsn, state)
        VALUES ($1, 0, 1, 'STREAMING')
        ON CONFLICT (peer_id) DO NOTHING;
      `, [peerId]);

      // Seed ackTracker with existing match_lsn
      const pRes = await query('SELECT match_lsn, last_ack_ms FROM replication_peer_state WHERE peer_id = $1', [peerId]);
      if (pRes.rows.length > 0) {
        this.ackTracker.updatePeerMatch(peerId, Number(pRes.rows[0].match_lsn || 0), pRes.rows[0].last_ack_ms || 0);
      }
    }
  }

  start() {
    if (this.running) return;
    this.running = true;

    this.timer = setInterval(async () => {
      try {
        await this.replicateBatch();
      } catch (err) {
        logger.debug({ event: 'replication.batch_error', error: err.message });
      }
    }, this.asyncIntervalMs);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Immediate replication trigger called after a local commit.
   */
  async replicateNow() {
    return this.replicateBatch();
  }

  /**
   * Run one replication cycle across all peers (backup first).
   */
  async replicateBatch() {
    let state;
    try {
      const stateRes = await query('SELECT role, epoch, backup_id, sync_acks, last_lsn, durable_lsn FROM node_state WHERE id = 1');
      if (stateRes.rows.length === 0) return;
      state = stateRes.rows[0];
    } catch (err) {
      return;
    }

    if (state.role !== 'primary') {
      return;
    }

    this.ackTracker.updateConfig({
      backupId: state.backup_id || 'b',
      syncAcks: Number(state.sync_acks || 2)
    });
    this.ackTracker.setLeaderLastLsn(Number(state.last_lsn || 0));

    const backupId = state.backup_id || 'b';
    const allPeers = Object.keys(this.peers).filter(id => id !== this.nodeId);

    // Backup is served FIRST in each cycle, then the others (PROJECT.md Section 19.6)
    const orderedPeers = [];
    if (allPeers.includes(backupId)) {
      orderedPeers.push(backupId);
    }
    for (const pid of allPeers) {
      if (pid !== backupId) {
        orderedPeers.push(pid);
      }
    }

    // Trigger sends
    for (const peerId of orderedPeers) {
      this.triggerPeerSend(peerId);
    }
  }

  triggerPeerSend(peerId) {
    if (this.inFlight.get(peerId)) {
      this.pendingPass.set(peerId, true);
      return;
    }

    this.inFlight.set(peerId, true);
    this.pendingPass.set(peerId, false);

    (async () => {
      try {
        await this.sendToPeer(peerId);
      } catch (err) {
        logger.debug({ event: 'replication.send_to_peer_error', peerId, error: err.message });
      } finally {
        this.inFlight.set(peerId, false);
        if (this.pendingPass.get(peerId)) {
          this.pendingPass.set(peerId, false);
          this.triggerPeerSend(peerId);
        }
      }
    })();
  }

  /**
   * Send unacknowledged batch to a single peer.
   */
  async sendToPeer(peerId) {
    // 1. Fault Hook: blockReplicationTo[]
    const blockedPeers = faults.getFault('blockReplicationTo');
    if (Array.isArray(blockedPeers) && blockedPeers.includes(peerId)) {
      logger.debug({ event: 'replication.fault_block_peer', peerId });
      return;
    }

    // 2. Fault Hook: replicationDelayMs{peer}
    let delay = faults.getFault(`replicationDelayMs_${peerId}`)
      ?? faults.getFault(`replicationDelayMs${peerId.toUpperCase()}`)
      ?? faults.getFault(`replicationDelayMs${peerId}`);
    if (typeof delay !== 'number') {
      const map = faults.getFault('replicationDelayMs');
      if (map && typeof map === 'object' && typeof map[peerId] === 'number') {
        delay = map[peerId];
      }
    }
    if (typeof delay === 'number' && delay > 0) {
      await new Promise(r => setTimeout(r, delay));
    }

    // Query fresh node_state
    const stateRes = await query('SELECT epoch, last_lsn FROM node_state WHERE id = 1');
    if (stateRes.rows.length === 0) return;
    const leaderLastLsn = Number(stateRes.rows[0].last_lsn || 0);
    const leaderEpoch = stateRes.rows[0].epoch;

    // 3. Query peer state
    const peerRes = await query(`
      SELECT match_lsn, next_lsn, state FROM replication_peer_state WHERE peer_id = $1
    `, [peerId]);

    if (peerRes.rows.length === 0) return;
    const peerState = peerRes.rows[0];

    if (peerState.state === 'NEEDS_RESYNC') {
      return; // Waiting for follower-initiated resync
    }

    const nextLsn = Number(peerState.next_lsn || 1);

    if (nextLsn > leaderLastLsn) {
      // Caught up, nothing to send
      return;
    }

    // 4. Fetch batch from replication_log
    const logRes = await query(`
      SELECT lsn, epoch, entry_type, txn_id, payload, prev_hash, entry_hash, origin_node, lamport, physical_ts, committed_at
      FROM replication_log
      WHERE lsn >= $1
      ORDER BY lsn ASC
      LIMIT $2;
    `, [nextLsn, this.batchSize]);

    if (logRes.rows.length === 0) {
      return;
    }

    const entries = logRes.rows.map(r => ({
      lsn: Number(r.lsn),
      epoch: r.epoch,
      entryType: r.entry_type,
      txnId: r.txn_id,
      payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
      prevHash: r.prev_hash,
      entryHash: r.entry_hash,
      originNode: r.origin_node,
      lamport: Number(r.lamport),
      physicalTs: Number(r.physical_ts),
      committedAt: r.committed_at
    }));

    const firstEntryLsn = entries[0].lsn;
    const prevLsn = firstEntryLsn - 1;
    let prevHash = '';

    if (prevLsn > 0) {
      const prevHashRes = await query('SELECT entry_hash FROM replication_log WHERE lsn = $1', [prevLsn]);
      if (prevHashRes.rows.length > 0) {
        prevHash = prevHashRes.rows[0].entry_hash;
      }
    }

    const appendPayload = {
      epoch: leaderEpoch,
      leaderId: this.nodeId,
      prevLsn,
      prevHash,
      entries,
      leaderLastLsn,
      durableLsn: this.ackTracker.durableLsn
    };

    const peerInfo = this.peers[peerId];
    if (!peerInfo || !peerInfo.url) return;

    const t0 = Date.now();
    try {
      const res = await callRpc(peerInfo.url, 'replication.append', appendPayload, {
        timeoutMs: 2000
      });
      const ackMs = Date.now() - t0;

      if (res && res.ok) {
        const appliedLsn = Number(res.appliedLsn);
        const duplicates = Number(res.duplicates || 0);

        await query(`
          UPDATE replication_peer_state SET
            match_lsn = GREATEST(match_lsn, $1),
            next_lsn = $1 + 1,
            state = 'STREAMING',
            last_ack_at = now(),
            last_ack_ms = $2,
            duplicates = duplicates + $3,
            last_error = NULL
          WHERE peer_id = $4;
        `, [appliedLsn, ackMs, duplicates, peerId]);

        await this.ackTracker.updatePeerMatch(peerId, appliedLsn, ackMs);

        // If there are more entries to send, schedule immediately
        if (appliedLsn < leaderLastLsn) {
          this.pendingPass.set(peerId, true);
        }
      } else if (res && !res.ok) {
        if (res.reason === 'GAP') {
          const targetLsn = Number(res.lastLsn || 0);
          logger.warn({ event: 'replication.peer_gap', peerId, leaderNextLsn: nextLsn, followerLastLsn: targetLsn });

          await query(`
            UPDATE replication_peer_state SET
              state = 'REWIND',
              next_lsn = $1 + 1,
              last_error = 'GAP'
            WHERE peer_id = $2;
          `, [targetLsn, peerId]);

          await query(`
            INSERT INTO replication_errors (peer_id, lsn, error_code, detail)
            VALUES ($1, $2, 'GAP', $3);
          `, [peerId, targetLsn, JSON.stringify({ followerLastLsn: targetLsn, leaderSentFrom: nextLsn })]);

          // Immediately rewind and retry
          this.pendingPass.set(peerId, true);
        } else if (res.reason === 'REPLICATION_DIVERGED') {
          logger.error({ event: 'replication.peer_diverged', peerId, lsn: res.lsn });

          await query(`
            UPDATE replication_peer_state SET
              state = 'NEEDS_RESYNC',
              last_error = 'REPLICATION_DIVERGED'
            WHERE peer_id = $1;
          `, [peerId]);

          await query(`
            INSERT INTO replication_errors (peer_id, lsn, error_code, detail)
            VALUES ($1, $2, 'REPLICATION_DIVERGED', $3);
          `, [peerId, res.lsn, JSON.stringify(res)]);
        }
      }
    } catch (err) {
      const isTimeout = err.name === 'RpcTimeoutError' || err.code === 'ETIMEDOUT';
      const isConnRefused = err.name === 'RpcNetworkError' || err.code === 'ECONNREFUSED';

      await query(`
        UPDATE replication_peer_state SET
          state = 'BACKOFF',
          last_error = $1
        WHERE peer_id = $2;
      `, [err.message, peerId]).catch(() => {});

      await query(`
        INSERT INTO replication_errors (peer_id, lsn, error_code, detail)
        VALUES ($1, $2, $3, $4);
      `, [
        peerId,
        nextLsn,
        isTimeout ? 'TIMEOUT' : (isConnRefused ? 'CONN_REFUSED' : 'APPEND_FAILED'),
        JSON.stringify({ message: err.message, nextLsn })
      ]).catch(() => {});

      logger.debug({ event: 'replication.append_failed', peerId, error: err.message });
    }
  }

  /**
   * Resend already-applied entries to prove duplicate handling (Section 19.10)
   */
  async resend({ toPeer, fromLsn, toLsn }) {
    const peerInfo = this.peers[toPeer];
    if (!peerInfo) {
      throw new RpcError(ERROR_CODES.INVALID_PARAMS, `Unknown peer: ${toPeer}`);
    }

    const stateRes = await query('SELECT epoch, last_lsn FROM node_state WHERE id = 1');
    const state = stateRes.rows[0];

    const logRes = await query(`
      SELECT lsn, epoch, entry_type, txn_id, payload, prev_hash, entry_hash, origin_node, lamport, physical_ts, committed_at
      FROM replication_log
      WHERE lsn >= $1 AND lsn <= $2
      ORDER BY lsn ASC;
    `, [fromLsn, toLsn]);

    if (logRes.rows.length === 0) {
      return { ok: true, sentCount: 0 };
    }

    const entries = logRes.rows.map(r => ({
      lsn: Number(r.lsn),
      epoch: r.epoch,
      entryType: r.entry_type,
      txnId: r.txn_id,
      payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
      prevHash: r.prev_hash,
      entryHash: r.entry_hash,
      originNode: r.origin_node,
      lamport: Number(r.lamport),
      physicalTs: Number(r.physical_ts),
      committedAt: r.committed_at
    }));

    const prevLsn = entries[0].lsn - 1;
    let prevHash = '';
    if (prevLsn > 0) {
      const pRes = await query('SELECT entry_hash FROM replication_log WHERE lsn = $1', [prevLsn]);
      if (pRes.rows.length > 0) prevHash = pRes.rows[0].entry_hash;
    }

    const appendPayload = {
      epoch: state.epoch,
      leaderId: this.nodeId,
      prevLsn,
      prevHash,
      entries,
      leaderLastLsn: Number(state.last_lsn),
      durableLsn: this.ackTracker.durableLsn
    };

    const res = await callRpc(peerInfo.url, 'replication.append', appendPayload, { timeoutMs: 2000 });
    return {
      ok: true,
      sentCount: entries.length,
      result: res
    };
  }
}

let leaderReplicatorInstance = null;

function initLeaderReplicator(config, failureDetector) {
  leaderReplicatorInstance = new LeaderReplicator(config, failureDetector);
  return leaderReplicatorInstance;
}

function getLeaderReplicator() {
  return leaderReplicatorInstance;
}

module.exports = {
  LeaderReplicator,
  initLeaderReplicator,
  getLeaderReplicator
};
