// src/coordinator/loadBalancer/leastConnections.js: Least Connections Routing Algorithm
// Specification: PROJECT.md Section 20.3, Section 28 (Phase 7)

/**
 * Select a node from eligibleNodes using Least Connections.
 * Ties are broken by:
 *   1. Lowest totalServed
 *   2. Lowest nodeId (alphabetical order)
 *
 * @param {Array<Object>} eligibleNodes - Eligible node states sorted by nodeId
 * @returns {Object} Selected node
 */
function selectLeastConnections(eligibleNodes) {
  if (!eligibleNodes || eligibleNodes.length === 0) {
    throw new Error('No eligible nodes available for least connections selection');
  }

  let best = eligibleNodes[0];

  for (let i = 1; i < eligibleNodes.length; i++) {
    const candidate = eligibleNodes[i];

    const activeDiff = candidate.active - best.active;
    if (activeDiff < 0) {
      best = candidate;
    } else if (activeDiff === 0) {
      // Tie breaker 1: lowest totalServed
      const servedDiff = (candidate.totalServed || 0) - (best.totalServed || 0);
      if (servedDiff < 0) {
        best = candidate;
      } else if (servedDiff === 0) {
        // Tie breaker 2: lowest nodeId
        if (candidate.nodeId.localeCompare(best.nodeId) < 0) {
          best = candidate;
        }
      }
    }
  }

  return best;
}

module.exports = {
  selectLeastConnections
};
