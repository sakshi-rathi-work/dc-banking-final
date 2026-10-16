// src/faulttolerance/epochs.js: Epoch management, ordering, and validation utilities
// Specification: PROJECT.md Section 18.5, Section 21.3, Section 28 (Phase 6)

/**
 * Compare two log positions by (epoch, lsn).
 * Returns:
 *   > 0 if posA is newer than posB
 *   < 0 if posA is older than posB
 *   0 if posA and posB are at the exact same position
 */
function compareLogPositions(posA = {}, posB = {}) {
  const epochA = Number(posA.lastEpoch || posA.epoch || 0);
  const epochB = Number(posB.lastEpoch || posB.epoch || 0);

  if (epochA !== epochB) {
    return epochA - epochB;
  }

  const lsnA = Number(posA.lastLsn || posA.lsn || 0);
  const lsnB = Number(posB.lastLsn || posB.lsn || 0);

  return lsnA - lsnB;
}

/**
 * Calculate candidate's proposed epoch E' = max(promised_epoch, epoch) + 1.
 */
function calculateNextEpoch(promisedEpoch = 0, currentEpoch = 0) {
  return Math.max(Number(promisedEpoch || 0), Number(currentEpoch || 0)) + 1;
}

/**
 * Determine if an epoch grant request should be accepted.
 * A peer grants only if proposedEpoch > its promised_epoch.
 */
function shouldGrantEpoch(proposedEpoch, currentPromisedEpoch) {
  return Number(proposedEpoch) > Number(currentPromisedEpoch);
}

module.exports = {
  compareLogPositions,
  calculateNextEpoch,
  shouldGrantEpoch
};
