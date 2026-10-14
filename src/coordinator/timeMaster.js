// src/coordinator/timeMaster.js: Berkeley Time Synchronization Master
// Specification: PROJECT.md Section 17.2

const crypto = require('crypto');
const { callRpc } = require('../shared/rpc/client');
const { physicalClock } = require('../clocks/physicalClock');
const { lamportClock } = require('../clocks/lamportClock');
const { computeBerkeleySync, calculateSpread } = require('../clocks/berkeley');
const { recordEvent } = require('../shared/events');
const { logger } = require('../shared/logger');

class TimeMaster {
  constructor(peers, config = {}) {
    this.peers = peers; // { a: { url }, b: { url }, ... }
    this.outlierThresholdMs = Number(config.berkeleyOutlierMs || 10000);
    this.masterId = 'coordinator';
  }

  /**
   * Run Berkeley Clock Synchronization across cluster.
   *
   * @param {Object} options
   * @param {number} [options.outlierMs] - Outlier cutoff threshold in ms
   * @returns {Promise<Object>} Complete synchronization report
   */
  async runSync(options = {}) {
    const outlierCutoff = options.outlierMs !== undefined
      ? Number(options.outlierMs)
      : this.outlierThresholdMs;

    const syncId = `sync-${crypto.randomUUID().slice(0, 8)}`;
    logger.info({ event: 'berkeley.sync_started', syncId, outlierCutoff });

    // Step 1: Query clock.get from all reachable nodes and measure RTT
    const nodeReadings = [];
    const preSyncTimestamps = [physicalClock.now()];

    for (const [nodeId, peer] of Object.entries(this.peers)) {
      try {
        const t0 = process.hrtime();
        const clockRes = await callRpc(peer.url, 'clock.get', {}, { timeoutMs: 1500 });
        const [s, ns] = process.hrtime(t0);
        const rttMs = s * 1000 + ns / 1e6;
        const masterTimeAtResponseMs = physicalClock.now();

        preSyncTimestamps.push(Number(clockRes.physicalTs));

        nodeReadings.push({
          nodeId,
          rttMs,
          reportedTimeMs: Number(clockRes.physicalTs),
          masterTimeAtResponseMs,
          injectedOffsetMs: Number(clockRes.offsetMs || 0)
        });
      } catch (err) {
        logger.warn({ event: 'berkeley.node_unreachable', nodeId, error: err.message });
      }
    }

    const preSyncSpreadMs = calculateSpread(preSyncTimestamps);

    // Steps 2 - 5: Compute Berkeley offsets, outliers, average, and adjustments
    const berkeleyResult = computeBerkeleySync({
      nodeReadings,
      outlierThresholdMs: outlierCutoff,
      masterId: this.masterId
    });

    // Step 5: Send adjustments
    // 5a. Adjust nodes
    for (const p of berkeleyResult.participants) {
      if (p.nodeId === this.masterId || p.isOutlier) continue;

      const peer = this.peers[p.nodeId];
      if (!peer) continue;

      try {
        await callRpc(peer.url, 'clock.adjust', {
          deltaMs: p.adjustmentMs,
          syncId
        }, { timeoutMs: 1500 });
        logger.debug({ event: 'berkeley.node_adjusted', nodeId: p.nodeId, deltaMs: p.adjustmentMs });
      } catch (err) {
        logger.error({ event: 'berkeley.adjust_failed', nodeId: p.nodeId, error: err.message });
      }
    }

    // 5b. Adjust master's own physical clock
    const masterParticipant = berkeleyResult.participants.find(p => p.nodeId === this.masterId);
    if (masterParticipant && masterParticipant.adjustmentMs !== undefined) {
      physicalClock.adjust(masterParticipant.adjustmentMs);
    }

    // Step 6: Verify post-sync spread
    const postSyncTimestamps = [physicalClock.now()];
    for (const [nodeId, peer] of Object.entries(this.peers)) {
      try {
        const verifyRes = await callRpc(peer.url, 'clock.get', {}, { timeoutMs: 1500 });
        postSyncTimestamps.push(Number(verifyRes.physicalTs));
      } catch (err) {
        // Skip unreachable node in verification
      }
    }

    const postSyncSpreadMs = calculateSpread(postSyncTimestamps);

    await recordEvent({
      eventType: 'clock.sync',
      detail: {
        syncId,
        averageOffsetMs: berkeleyResult.averageOffsetMs,
        preSyncSpreadMs,
        postSyncSpreadMs,
        participantCount: berkeleyResult.keptCount
      }
    });

    const report = {
      syncId,
      master: this.masterId,
      averageOffsetMs: berkeleyResult.averageOffsetMs,
      participants: berkeleyResult.participants,
      outliers: berkeleyResult.outliers,
      preSyncSpreadMs,
      postSyncSpreadMs
    };

    logger.info({
      event: 'berkeley.sync_completed',
      syncId,
      preSyncSpreadMs,
      postSyncSpreadMs,
      avgOffsetMs: berkeleyResult.averageOffsetMs
    });

    return report;
  }
}

module.exports = {
  TimeMaster
};
