// src/coordinator/loadBalancer/stats.js: Metrics, percentile calculations, and stats summaries
// Specification: PROJECT.md Section 20.4, Section 24.6

function computePercentile(numbers, p) {
  if (!numbers || numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function calculateNodeStats(nodeStates, algorithm = 'round-robin') {
  const totalRequests = Array.from(nodeStates.values())
    .reduce((sum, n) => sum + (n.totalServed || 0), 0);

  const nodes = {};

  for (const node of nodeStates.values()) {
    const served = node.totalServed || 0;
    const sharePct = totalRequests > 0 ? Math.round((served / totalRequests) * 100) : 0;
    const p50 = computePercentile(node.latencies, 50);
    const p95 = computePercentile(node.latencies, 95);

    nodes[node.nodeId] = {
      nodeId: node.nodeId,
      health: node.state,
      requests: served,
      share: `${sharePct}%`,
      active: node.active,
      peakActive: node.peakActive,
      p50: `${p50} ms`,
      p95: `${p95} ms`,
      p50Raw: p50,
      p95Raw: p95,
      failures: node.totalFailures || 0,
      retries: node.totalRetries || 0
    };
  }

  return {
    algorithm,
    totalRequests,
    nodes
  };
}

module.exports = {
  computePercentile,
  calculateNodeStats
};
