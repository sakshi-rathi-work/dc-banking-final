// src/faulttolerance/fencing.js: Leader Lease and Self-Fencing Manager
// Specification: PROJECT.md Section 14.1, Section 21.5, Section 22.1 (F8), Section 28 (Phase 8)
const { updateNodeState, getNodeState } = require('../node/state');
const { logger } = require('../shared/logger');

class FencingManager {
  constructor(config = {}) {
    this.config = config;
    this.nodeId = config.nodeId;
    this.leaderLeaseMs = config.leaderLeaseMs || 3000;
    this.peerHeartbeatAcks = new Map(); // peerId -> timestamp
    this.writeGateOpen = true;
    this.timer = null;
    this.running = false;
    this.bootGraceUntil = Date.now() + (config.leaderLeaseMs || 3000) * 2;
  }

  recordPeerAck(peerId) {
    if (!peerId) return;
    this.peerHeartbeatAcks.set(peerId, Date.now());
  }

  /**
   * Determine if the primary's lease is currently valid.
   * A primary lease requires heartbeat acknowledgements from >= 2 peers
   * within LEADER_LEASE_MS (3000 ms).
   */
  isLeaseValid() {
    const { faults } = require('../shared/faults');
    if (faults && faults.getFault('isolate')) {
      return false;
    }

    const now = Date.now();
    if (this.bootGraceUntil && now < this.bootGraceUntil) {
      return true;
    }

    let recentAcks = 0;

    for (const [peerId, ts] of this.peerHeartbeatAcks.entries()) {
      if (peerId !== this.nodeId && (now - ts) <= this.leaderLeaseMs) {
        recentAcks++;
      }
    }

    // Must have at least 2 distinct peer acks (self + 2 peers = majority of 3/4)
    return recentAcks >= 2;
  }

  getRecentAckCount() {
    const now = Date.now();
    let count = 0;
    for (const [peerId, ts] of this.peerHeartbeatAcks.entries()) {
      if (peerId !== this.nodeId && (now - ts) <= this.leaderLeaseMs) {
        count++;
      }
    }
    return count;
  }

  start(onLeaseExpiredCallback) {
    if (this.running) return;
    this.running = true;

    this.timer = setInterval(async () => {
      try {
        const state = await getNodeState();
        if (state.role === 'primary') {
          const valid = this.isLeaseValid();
          if (!valid) {
            // Lease expired! Close write gate and step down to recovering
            this.writeGateOpen = false;
            logger.warn({
              event: 'fencing.lease_expired',
              nodeId: this.nodeId,
              recentAcks: this.getRecentAckCount(),
              leaseMs: this.leaderLeaseMs
            });

            await updateNodeState({ role: 'recovering' });

            if (typeof onLeaseExpiredCallback === 'function') {
              onLeaseExpiredCallback();
            }
          } else {
            this.writeGateOpen = true;
          }
        }
      } catch (err) {
        logger.debug({ event: 'fencing.check_error', error: err.message });
      }
    }, 500);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  closeWriteGate() {
    this.writeGateOpen = false;
  }

  openWriteGate() {
    this.writeGateOpen = true;
  }
}

let fencingInstance = null;

function initFencingManager(config) {
  fencingInstance = new FencingManager(config);
  return fencingInstance;
}

function getFencingManager() {
  return fencingInstance;
}

module.exports = {
  FencingManager,
  initFencingManager,
  getFencingManager
};
