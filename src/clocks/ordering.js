// src/clocks/ordering.js: Causal Event Ordering and Violation Detection
// Specification: PROJECT.md Section 17.3, Section 24.3, and Acceptance Test T12

/**
 * Compares event ordering across physical time and Lamport logical time.
 * Identifies causal violations where physical timestamps invert causal order.
 *
 * @param {Array<Object>} events - Array of events:
 *   { node, event, physicalTs, lamport, causalOrder }
 *   causalOrder: integer index representing the ground-truth causal flow (0, 1, 2, ...)
 * @returns {Object} Comparison report
 */
function compareEventOrdering(events = []) {
  if (!events || events.length === 0) {
    return {
      events: [],
      physicalViolations: 0,
      lamportViolations: 0,
      violationDetails: []
    };
  }

  // 1. Sort by physical timestamp (tie-break by nodeId)
  const physicalSorted = [...events].sort((a, b) => {
    if (a.physicalTs !== b.physicalTs) {
      return a.physicalTs - b.physicalTs;
    }
    return String(a.node).localeCompare(String(b.node));
  });

  const physicalRankMap = new Map();
  physicalSorted.forEach((ev, idx) => {
    physicalRankMap.set(ev, idx + 1);
  });

  // 2. Sort by Lamport logical timestamp (tie-break by nodeId)
  const lamportSorted = [...events].sort((a, b) => {
    if (a.lamport !== b.lamport) {
      return a.lamport - b.lamport;
    }
    return String(a.node).localeCompare(String(b.node));
  });

  const lamportRankMap = new Map();
  lamportSorted.forEach((ev, idx) => {
    lamportRankMap.set(ev, idx + 1);
  });

  // 3. Assemble combined rows preserving original/causal sequence
  const rows = events.map(ev => ({
    event: ev.event,
    node: ev.node,
    physicalTs: ev.physicalTs,
    physicalRank: physicalRankMap.get(ev),
    lamport: ev.lamport,
    lamportRank: lamportRankMap.get(ev),
    causalOrder: ev.causalOrder !== undefined ? ev.causalOrder : null
  }));

  // 4. Check for causal violations
  // If event A causally precedes event B (causalOrder A < causalOrder B):
  // - Physical violation if physicalRank(A) > physicalRank(B)
  // - Lamport violation if lamportRank(A) > lamportRank(B) or lamport(A) >= lamport(B)
  let physicalViolations = 0;
  let lamportViolations = 0;
  const violationDetails = [];

  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];

      // If a came before b in causal sequence:
      const aPrecedesB = (a.causalOrder !== null && b.causalOrder !== null)
        ? a.causalOrder < b.causalOrder
        : i < j;

      if (aPrecedesB) {
        // Physical check
        if (a.physicalRank > b.physicalRank || a.physicalTs > b.physicalTs) {
          physicalViolations++;
          violationDetails.push({
            type: 'PHYSICAL_CAUSAL_VIOLATION',
            cause: `${a.node}:${a.event} (ts=${a.physicalTs}, rank=${a.physicalRank})`,
            effect: `${b.node}:${b.event} (ts=${b.physicalTs}, rank=${b.physicalRank})`,
            message: `Physical order places ${b.event} before ${a.event}`
          });
        }

        // Lamport check
        if (a.lamportRank > b.lamportRank || a.lamport >= b.lamport) {
          lamportViolations++;
          violationDetails.push({
            type: 'LAMPORT_CAUSAL_VIOLATION',
            cause: `${a.node}:${a.event} (L=${a.lamport}, rank=${a.lamportRank})`,
            effect: `${b.node}:${b.event} (L=${b.lamport}, rank=${b.lamportRank})`,
            message: `Lamport order violation between ${a.event} and ${b.event}`
          });
        }
      }
    }
  }

  return {
    rows,
    physicalViolations,
    lamportViolations,
    violationDetails
  };
}

module.exports = {
  compareEventOrdering
};
