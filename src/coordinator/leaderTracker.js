// src/coordinator/leaderTracker.js: Leader discovery and caching via cluster.getState
const { callRpc } = require('../shared/rpc/client');
const { RpcError, ERROR_CODES } = require('../contracts/errors');
const { logger } = require('../shared/logger');

class LeaderTracker {
  constructor(peers) {
    this.peers = peers; // { a: { nodeId, url, rank }, ... }
    this.currentLeader = null;
    this.lastRefreshAt = 0;
  }

  async refreshLeader() {
    const peerEntries = Object.entries(this.peers);
    const candidates = [];

    await Promise.all(peerEntries.map(async ([peerId, peer]) => {
      try {
        const state = await callRpc(peer.url, 'cluster.getState', {}, { timeoutMs: 1000 });
        if (state && state.role === 'primary' && state.leaseValid) {
          candidates.push({
            nodeId: peerId,
            url: peer.url,
            epoch: state.epoch,
            lastLsn: state.lastLsn,
            rank: peer.rank
          });
        }
      } catch (err) {
        // Peer unreachable
      }
    }));

    if (candidates.length === 0) {
      this.currentLeader = null;
      return null;
    }

    // Pick highest epoch, tie-break by highest rank
    candidates.sort((a, b) => {
      if (b.epoch !== a.epoch) return b.epoch - a.epoch;
      return b.rank - a.rank;
    });

    const best = candidates[0];
    this.currentLeader = {
      nodeId: best.nodeId,
      url: best.url,
      epoch: best.epoch,
      lastLsn: best.lastLsn
    };
    this.lastRefreshAt = Date.now();

    logger.debug({
      event: 'coordinator.leader_resolved',
      leader: this.currentLeader
    });

    return this.currentLeader;
  }

  async getLeader(maxWaitMs = 15000) {
    if (this.currentLeader && (Date.now() - this.lastRefreshAt < 2000)) {
      return this.currentLeader;
    }

    const leader = await this.refreshLeader();
    if (leader) return leader;

    // Poll until leader appears or maxWaitMs expires
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      await new Promise(r => setTimeout(r, 500));
      const found = await this.refreshLeader();
      if (found) return found;
    }

    throw new RpcError(
      ERROR_CODES.NO_LEADER,
      `No primary leader found in cluster after waiting ${maxWaitMs}ms`
    );
  }

  invalidateLeader() {
    this.currentLeader = null;
  }
}

module.exports = {
  LeaderTracker
};
