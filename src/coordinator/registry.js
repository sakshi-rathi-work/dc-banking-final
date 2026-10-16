// src/coordinator/registry.js: Node Health Registry and Read Eligibility
// Specification: PROJECT.md Section 20.1, Section 20.2, Section 28 (Phase 7)
const { callRpc } = require('../shared/rpc/client');
const { logger } = require('../shared/logger');

class HealthRegistry {
  constructor(peers, config = {}) {
    this.peers = peers || {};
    this.config = config;
    this.intervalMs = config.lbHealthIntervalMs || 1000;
    this.unhealthyThreshold = config.lbUnhealthyThreshold || 2;
    this.recoveryThreshold = config.lbRecoveryThreshold || 3;
    this.readMaxLagLsn = config.readMaxLagLsn || 5;

    this.nodeStates = new Map();
    this.timer = null;
    this.running = false;

    // Initialize state per peer
    for (const [peerId, peer] of Object.entries(this.peers)) {
      this.nodeStates.set(peerId, {
        nodeId: peerId,
        url: peer.url,
        rank: peer.rank,
        role: peerId === 'a' ? 'primary' : (peerId === 'b' ? 'backup' : 'replica'),
        epoch: 1,
        appliedLsn: 0,
        leaderLastLsn: 0,
        lag: 0,
        dbHealthy: true,
        state: 'UP', // 'UP' | 'DOWN'
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        active: 0,
        peakActive: 0,
        totalServed: 0,
        totalFailures: 0,
        totalRetries: 0,
        latencies: [],
        lastCheckedAt: 0,
        lastLatencyMs: 0
      });
    }
  }

  start() {
    if (this.running) return;
    this.running = true;

    // Run first check immediately, then schedule
    this.checkHealth().catch(err => {
      logger.debug({ event: 'registry.initial_health_check_error', error: err.message });
    });

    this.timer = setInterval(async () => {
      try {
        await this.checkHealth();
      } catch (err) {
        logger.error({ event: 'registry.health_check_cycle_error', error: err.message });
      }
    }, this.intervalMs);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async checkHealth() {
    const peerEntries = Array.from(this.nodeStates.entries());
    let maxKnownLsn = 0;

    // 1. Poll cluster.getState from all nodes
    await Promise.all(peerEntries.map(async ([nodeId, info]) => {
      const t0 = Date.now();
      try {
        const state = await callRpc(info.url, 'cluster.getState', {}, { timeoutMs: 1000 });
        const latencyMs = Date.now() - t0;

        info.lastCheckedAt = Date.now();
        info.lastLatencyMs = latencyMs;
        info.role = state.role || info.role;
        info.epoch = Number(state.epoch || info.epoch);
        info.appliedLsn = Number(state.lastLsn || 0);
        info.dbHealthy = state.dbHealthy !== false;

        if (info.appliedLsn > maxKnownLsn) {
          maxKnownLsn = info.appliedLsn;
        }

        // Check health criteria: dbHealthy === true AND role !== 'recovering'
        if (info.dbHealthy && info.role !== 'recovering') {
          info.consecutiveFailures = 0;
          info.consecutiveSuccesses++;

          // Transition DOWN -> UP if recovery conditions met
          if (info.state === 'DOWN') {
            const hasRecovered = (info.consecutiveSuccesses >= this.recoveryThreshold) &&
              ['primary', 'backup', 'replica'].includes(info.role) &&
              (info.lag <= this.readMaxLagLsn);

            if (hasRecovered) {
              info.state = 'UP';
              logger.info({
                event: 'registry.node_recovered',
                nodeId,
                role: info.role,
                lag: info.lag,
                successes: info.consecutiveSuccesses
              });
            }
          }
        } else {
          this.handleCheckFailure(info, 'DB_UNHEALTHY_OR_RECOVERING');
        }
      } catch (err) {
        this.handleCheckFailure(info, err.message);
      }
    }));

    // 2. Re-compute lag against highest known LSN
    for (const info of this.nodeStates.values()) {
      info.leaderLastLsn = maxKnownLsn;
      info.lag = Math.max(0, maxKnownLsn - info.appliedLsn);
    }
  }

  handleCheckFailure(info, reason) {
    info.consecutiveSuccesses = 0;
    info.consecutiveFailures++;

    if (info.consecutiveFailures >= this.unhealthyThreshold && info.state !== 'DOWN') {
      info.state = 'DOWN';
      logger.warn({
        event: 'registry.node_unhealthy',
        nodeId: info.nodeId,
        consecutiveFailures: info.consecutiveFailures,
        threshold: this.unhealthyThreshold,
        reason
      });
    }
  }

  recordPassiveFailure(nodeId) {
    const info = this.nodeStates.get(nodeId);
    if (!info) return;

    info.consecutiveSuccesses = 0;
    info.consecutiveFailures++;
    info.totalFailures++;

    if (info.consecutiveFailures >= this.unhealthyThreshold && info.state !== 'DOWN') {
      info.state = 'DOWN';
      logger.warn({
        event: 'registry.node_passive_unhealthy',
        nodeId,
        consecutiveFailures: info.consecutiveFailures,
        threshold: this.unhealthyThreshold
      });
    }
  }

  recordRequestStart(nodeId) {
    const info = this.nodeStates.get(nodeId);
    if (!info) return;

    info.active++;
    if (info.active > info.peakActive) {
      info.peakActive = info.active;
    }
  }

  recordRequestEnd(nodeId, latencyMs, success) {
    const info = this.nodeStates.get(nodeId);
    if (!info) return;

    info.active = Math.max(0, info.active - 1);
    if (success) {
      info.totalServed++;
      if (typeof latencyMs === 'number') {
        info.latencies.push(latencyMs);
      }
    } else {
      info.totalFailures++;
    }
  }

  recordRetry(nodeId) {
    const info = this.nodeStates.get(nodeId);
    if (info) {
      info.totalRetries++;
    }
  }

  /**
   * Determine eligible nodes based on consistency level.
   * Specification: PROJECT.md Section 20.2
   *
   * @param {string} consistency - 'strong' | 'bounded' | 'eventual'
   * @param {number} maxLagLsn - Maximum allowable lag for bounded reads
   * @returns {Array<Object>} Eligible node state objects sorted by nodeId ASC
   */
  getEligibleNodes(consistency = 'eventual', maxLagLsn = null) {
    const all = Array.from(this.nodeStates.values());
    let eligible = [];

    const normConsistency = (consistency || 'eventual').toLowerCase();
    const effectiveMaxLag = (typeof maxLagLsn === 'number') ? maxLagLsn : this.readMaxLagLsn;

    if (normConsistency === 'strong') {
      // Leader only
      eligible = all.filter(n => n.role === 'primary' && n.state === 'UP');
    } else if (normConsistency === 'bounded') {
      // Leader + followers with lag <= maxLagLsn
      eligible = all.filter(n => n.state === 'UP' && n.role !== 'recovering' && n.lag <= effectiveMaxLag);
    } else {
      // Eventual: All healthy, non-recovering nodes
      eligible = all.filter(n => n.state === 'UP' && n.role !== 'recovering');
    }

    // Sort strictly by nodeId ascending ('a', 'b', 'c', 'd')
    eligible.sort((a, b) => a.nodeId.localeCompare(b.nodeId));

    // Fallback: if empty, try any UP node or all nodes to prevent complete starvation
    if (eligible.length === 0) {
      const upNodes = all.filter(n => n.state === 'UP');
      if (upNodes.length > 0) {
        upNodes.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
        return upNodes;
      }
      return all;
    }

    return eligible;
  }

  getNode(nodeId) {
    return this.nodeStates.get(nodeId) || null;
  }

  getAllNodes() {
    return Array.from(this.nodeStates.values());
  }

  resetStats() {
    for (const info of this.nodeStates.values()) {
      info.active = 0;
      info.peakActive = 0;
      info.totalServed = 0;
      info.totalFailures = 0;
      info.totalRetries = 0;
      info.latencies = [];
    }
  }
}

module.exports = {
  HealthRegistry
};
