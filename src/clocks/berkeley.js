// src/clocks/berkeley.js: Berkeley Algorithm Offset and Adjustment Calculations
// Specification: PROJECT.md Section 17.2

/**
 * Calculates estimated offsets and adjustments using Berkeley synchronization algorithm.
 *
 * @param {Object} options
 * @param {Array<Object>} options.nodeReadings - Array of node measurement objects:
 *   { nodeId, rttMs, reportedTimeMs, masterTimeAtResponseMs, injectedOffsetMs }
 * @param {number} [options.outlierThresholdMs=10000] - Discard readings with |offset| > threshold
 * @param {string} [options.masterId='coordinator'] - Master node identifier
 * @returns {Object} Berkeley calculation results
 */
function computeBerkeleySync(options = {}) {
  const {
    nodeReadings = [],
    outlierThresholdMs = 10000,
    masterId = 'coordinator'
  } = options;

  // Master's own reading has delta = 0, RTT = 0
  const masterEntry = {
    nodeId: masterId,
    rttMs: 0,
    estimatedOffsetMs: 0,
    injectedOffsetMs: 0,
    errorMs: 0,
    isOutlier: false
  };

  const participants = [];
  const outliers = [];

  for (const node of nodeReadings) {
    const rtt = Number(node.rttMs || 0);
    const T_i = Number(node.reportedTimeMs);
    const M_i = Number(node.masterTimeAtResponseMs);
    const injected = Number(node.injectedOffsetMs || 0);

    // Step 2: Estimated offset δᵢ = (Tᵢ + RTTᵢ/2) − Mᵢ
    const estimatedOffset = (T_i + rtt / 2) - M_i;
    // Estimation error = estimatedOffset - injectedOffset
    const error = estimatedOffset - injected;

    const entry = {
      nodeId: node.nodeId,
      rttMs: Math.round(rtt * 100) / 100,
      estimatedOffsetMs: Math.round(estimatedOffset * 10) / 10,
      injectedOffsetMs: injected,
      errorMs: Math.round(error * 10) / 10,
      isOutlier: false
    };

    // Step 3: Discard nodes with |δᵢ| > BERKELEY_OUTLIER_MS
    if (Math.abs(estimatedOffset) > outlierThresholdMs) {
      entry.isOutlier = true;
      entry.adjustmentMs = 0;
      outliers.push(entry);
    }

    participants.push(entry);
  }

  // Include master in participants list
  participants.push(masterEntry);

  // Step 4: avg = mean(δ of master and kept nodes)
  const kept = participants.filter(p => !p.isOutlier);
  const sumOffsets = kept.reduce((acc, p) => acc + p.estimatedOffsetMs, 0);
  const averageOffset = kept.length > 0 ? sumOffsets / kept.length : 0;
  const roundedAverageOffset = Math.round(averageOffset * 10) / 10;

  // Step 5: Adjustment for node i: adjᵢ = avg − δᵢ; master: avg − 0
  for (const p of participants) {
    if (p.isOutlier) {
      p.adjustmentMs = 0;
    } else {
      p.adjustmentMs = Math.round((roundedAverageOffset - p.estimatedOffsetMs) * 10) / 10;
    }
  }

  return {
    masterId,
    averageOffsetMs: roundedAverageOffset,
    participants,
    outliers,
    keptCount: kept.length,
    totalCount: participants.length
  };
}

/**
 * Calculates max time spread across a list of node timestamps.
 * spread = max(ts) - min(ts)
 */
function calculateSpread(timestamps) {
  if (!timestamps || timestamps.length <= 1) return 0;
  const valid = timestamps.map(Number).filter(t => !isNaN(t));
  if (valid.length <= 1) return 0;
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  return max - min;
}

module.exports = {
  computeBerkeleySync,
  calculateSpread
};
