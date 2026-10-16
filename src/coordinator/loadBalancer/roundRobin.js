// src/coordinator/loadBalancer/roundRobin.js: Round Robin Routing Algorithm
// Specification: PROJECT.md Section 20.3, Section 28 (Phase 7)

/**
 * Select a node from eligibleNodes using Round Robin pointer.
 *
 * @param {Array<Object>} eligibleNodes - Eligible node states sorted by nodeId
 * @param {Object} state - State holder with pointer integer: { pointer: 0 }
 * @returns {Object} Selected node
 */
function selectRoundRobin(eligibleNodes, state) {
  if (!eligibleNodes || eligibleNodes.length === 0) {
    throw new Error('No eligible nodes available for round robin selection');
  }

  if (typeof state.pointer !== 'number') {
    state.pointer = 0;
  }

  const index = state.pointer % eligibleNodes.length;
  const selected = eligibleNodes[index];

  state.pointer = (state.pointer + 1) % eligibleNodes.length;

  return selected;
}

module.exports = {
  selectRoundRobin
};
