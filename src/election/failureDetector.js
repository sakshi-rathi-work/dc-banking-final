// src/election/failureDetector.js: Heartbeats and Failure Detector
const { callRpc } = require('../shared/rpc/client');
const { query } = require('../shared/db/pool');
const { logger } = require('../shared/logger');
const { getNodeState } = require('../node/state');

class FailureDetector {
  constructor(config) {
    this.config = config;
    this.nodeId = config.nodeId;
    this.peers = config.peers; // { a: { nodeId, url, rank }, ... }
    this.heartbeatIntervalMs = config.heartbeatIntervalMs || 1000;
    this.failureTimeoutMs = config.failureTimeoutMs || 4000;
    this.timer = null;
    this.running = false;
    this.peerMemoryState = new Map(); // peerId -> { lastSeenAt, suspected, lastState }
  }

  async init() {
    for (const [peerId, peer] of Object.entries(this.peers)) {
      await query(`
        INSERT INTO cluster_nodes (node_id, rank, url, last_seen_at, suspected)
        VALUES ($1, $2, $3, now(), false)
        ON CONFLICT (node_id) DO UPDATE SET
          rank = EXCLUDED.rank,
          url = EXCLUDED.url
      `, [peerId, peer.rank, peer.url]);

      this.peerMemoryState.set(peerId, {
        nodeId: peerId,
        url: peer.url,
        rank: peer.rank,
        lastSeenAt: Date.now(),
        suspected: false,
        lastRole: null,
        lastEpoch: 0,
        lastLsn: 0
      });
    }
  }

  start() {
    if (this.running) return;
    this.running = true;

    this.timer = setInterval(async () => {
      try {
        await this.heartbeatCycle();
      } catch (err) {
        logger.error({ event: 'heartbeat.cycle_error', error: err.message });
      }
    }, this.heartbeatIntervalMs);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async heartbeatCycle() {
    const now = Date.now();
    let myState;
    try {
      myState = await getNodeState();
    } catch (err) {
      // DB might be down
      return;
    }

    const payload = {
      nodeId: this.nodeId,
      role: myState.role,
      epoch: myState.epoch,
      promisedEpoch: myState.promised_epoch,
      leaderId: myState.leader_id,
      backupId: myState.backup_id,
      lastLsn: myState.last_lsn,
      lastEpoch: myState.last_epoch,
      durableLsn: myState.durable_lsn,
      replicationMode: myState.replication_mode,
      dbHealthy: true,
      leaseValid: true
    };

    const peerIds = Object.keys(this.peers).filter(id => id !== this.nodeId);

    await Promise.all(peerIds.map(async (peerId) => {
      const peer = this.peers[peerId];
      const mem = this.peerMemoryState.get(peerId);

      try {
        const res = await callRpc(peer.url, 'cluster.heartbeat', payload, {
          timeoutMs: Math.min(this.config.rpcTimeoutMs || 2000, 1000)
        });

        // Peer replied! Mark alive
        mem.lastSeenAt = Date.now();
        mem.suspected = false;
        if (res) {
          mem.lastRole = res.role || mem.lastRole;
          mem.lastEpoch = res.epoch || mem.lastEpoch;
          mem.lastLsn = res.lastLsn || mem.lastLsn;
        }

        await query(`
          UPDATE cluster_nodes SET
            last_seen_at = now(),
            suspected = false,
            last_role = $1,
            last_epoch = $2,
            last_lsn = $3
          WHERE node_id = $4
        `, [mem.lastRole, mem.lastEpoch, mem.lastLsn, peerId]);

      } catch (err) {
        // Heartbeat failed. Check if suspicion timeout exceeded
        const elapsed = now - (mem ? mem.lastSeenAt : 0);
        if (elapsed > this.failureTimeoutMs) {
          if (!mem.suspected) {
            mem.suspected = true;
            logger.warn({
              event: 'peer.suspected',
              peerId,
              elapsedMs: elapsed,
              thresholdMs: this.failureTimeoutMs
            });

            await query(`
              UPDATE cluster_nodes SET
                suspected = true
              WHERE node_id = $1
            `, [peerId]);
          }
        }
      }
    }));
  }

  recordInboundHeartbeat(params) {
    const peerId = params.nodeId;
    if (!peerId) return;

    const mem = this.peerMemoryState.get(peerId) || {
      nodeId: peerId,
      lastSeenAt: Date.now(),
      suspected: false
    };

    mem.lastSeenAt = Date.now();
    mem.suspected = false;
    mem.lastRole = params.role || mem.lastRole;
    mem.lastEpoch = params.epoch || mem.lastEpoch;
    mem.lastLsn = params.lastLsn || mem.lastLsn;
    this.peerMemoryState.set(peerId, mem);

    // Fire-and-forget update to database
    query(`
      UPDATE cluster_nodes SET
        last_seen_at = now(),
        suspected = false,
        last_role = $1,
        last_epoch = $2,
        last_lsn = $3
      WHERE node_id = $4
    `, [params.role, params.epoch, params.lastLsn, peerId]).catch(err => {
      logger.debug({ event: 'db.update_inbound_heartbeat_error', error: err.message });
    });
  }

  async getPeerStates() {
    const res = await query('SELECT * FROM cluster_nodes ORDER BY rank ASC');
    const peers = {};
    const now = Date.now();

    for (const row of res.rows) {
      const lastSeen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
      const isSuspected = row.node_id === this.nodeId
        ? false
        : (row.suspected || (now - lastSeen > this.failureTimeoutMs));

      peers[row.node_id] = {
        nodeId: row.node_id,
        rank: row.rank,
        url: row.url,
        lastSeenAt: row.last_seen_at,
        role: row.last_role,
        epoch: row.last_epoch,
        lastLsn: row.last_lsn,
        suspected: isSuspected,
        status: isSuspected ? 'suspected' : 'alive'
      };
    }
    return peers;
  }
}

module.exports = {
  FailureDetector
};
