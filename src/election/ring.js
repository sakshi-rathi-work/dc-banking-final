// src/election/ring.js: Ring Election Algorithm Implementation
// Specification: PROJECT.md Section 18.1, Section 18.3, Section 18.4, Section 28 (Phase 6)
const { EventEmitter } = require('events');
const { callRpc } = require('../shared/rpc/client');
const { getNodeState } = require('../node/state');
const { lamportClock } = require('../clocks/lamportClock');
const { recordElectionMessage } = require('./electionLog');
const { executePromotion } = require('../faulttolerance/promotion');
const { logger } = require('../shared/logger');

const ringEvents = new EventEmitter();
let activeRingPromise = null;
const processedCoordinators = new Set(); // deduplicate concurrent ring coordinators

/**
 * Get ordered ring of node IDs: ['a', 'b', 'c', 'd'].
 */
function getRingNodes(config) {
  const nodes = [{ nodeId: config.nodeId, rank: config.nodeRank }];
  for (const [peerId, peer] of Object.entries(config.peers || {})) {
    nodes.push({ nodeId: peerId, rank: peer.rank });
  }
  nodes.sort((a, b) => a.rank - b.rank);
  return nodes.map(n => n.nodeId);
}

/**
 * Get prioritized successors for a given node in the ring.
 */
function getSuccessorCandidates(myId, ringNodes) {
  const myIndex = ringNodes.indexOf(myId);
  if (myIndex === -1) return ringNodes.filter(id => id !== myId);

  const candidates = [];
  const n = ringNodes.length;
  for (let step = 1; step < n; step++) {
    candidates.push(ringNodes[(myIndex + step) % n]);
  }
  return candidates;
}

/**
 * Forward message around the ring with automatic successor skipping on timeout.
 */
async function forwardHop(method, payload, config, electionId) {
  const myId = config.nodeId;
  const ringNodes = getRingNodes(config);
  const candidateSuccessors = getSuccessorCandidates(myId, ringNodes);
  const hopTimeoutMs = config.electionHopTimeoutMs || 1500;

  for (const targetId of candidateSuccessors) {
    if (targetId === myId) {
      continue;
    }

    const peer = config.peers[targetId];
    if (!peer) continue;

    await recordElectionMessage({
      electionId,
      algorithm: 'ring',
      direction: 'SENT',
      peerId: targetId,
      messageType: method === 'election.ringToken' ? 'RING_TOKEN' : 'RING_COORDINATOR',
      detail: { to: targetId, payload }
    });

    try {
      const res = await callRpc(peer.url, method, payload, { timeoutMs: hopTimeoutMs });
      if (res && res.ack) {
        // Successfully acknowledged! Hop complete
        logger.debug({ event: 'ring.hop_ack', method, to: targetId, electionId });
        return { targetId, success: true };
      }
    } catch (err) {
      // Timeout or unreachable: skip this node and log SKIPPED
      logger.warn({
        event: 'ring.hop_skipped',
        skippedNode: targetId,
        electionId,
        error: err.message
      });

      await recordElectionMessage({
        electionId,
        algorithm: 'ring',
        direction: 'LOCAL',
        peerId: targetId,
        messageType: 'SKIPPED',
        detail: { skippedNode: targetId, reason: 'TIMEOUT_OR_UNREACHABLE' }
      });
    }
  }

  // All peers failed or skipped
  return { targetId: null, success: false };
}

/**
 * Handle incoming election.ringToken.
 */
async function handleRingToken(params, config) {
  const { electionId, initiatorId, candidates = [], excluded = [] } = params;
  const myId = config.nodeId;

  await recordElectionMessage({
    electionId,
    algorithm: 'ring',
    direction: 'RECEIVED',
    peerId: initiatorId,
    messageType: 'RING_TOKEN',
    detail: { initiatorId, candidates, excluded }
  });

  if (initiatorId === myId) {
    // Token completed full round trip back to initiator!
    ringEvents.emit(`token_returned:${electionId}`, candidates);
    return { ack: true, electionId, completed: true };
  }

  // Intermediate node: append self if eligible, then forward asynchronously
  const updatedCandidates = [...candidates];
  if (!excluded.includes(myId) && !updatedCandidates.includes(myId)) {
    updatedCandidates.push(myId);
  }

  setImmediate(async () => {
    try {
      const hopRes = await forwardHop('election.ringToken', {
        electionId,
        initiatorId,
        candidates: updatedCandidates,
        excluded
      }, config, electionId);

      if (!hopRes.success) {
        // If could not forward to any peer, check if initiator is reachable
        logger.warn({ event: 'ring.token_dead_end', electionId });
      }
    } catch (err) {
      logger.error({ event: 'ring.forward_token_error', electionId, error: err.message });
    }
  });

  return { ack: true, electionId };
}

/**
 * Handle incoming election.ringCoordinator.
 */
async function handleRingCoordinator(params, config) {
  const { electionId, winnerId, members = [], initiatorId } = params;
  const myId = config.nodeId;

  await recordElectionMessage({
    electionId,
    algorithm: 'ring',
    direction: 'RECEIVED',
    peerId: winnerId,
    messageType: 'RING_COORDINATOR',
    detail: { winnerId, members, initiatorId }
  });

  const coordKey = `${electionId}-${winnerId}`;
  if (processedCoordinators.has(coordKey) && initiatorId !== myId) {
    return { ack: true, electionId, duplicate: true };
  }
  processedCoordinators.add(coordKey);

  if (initiatorId === myId) {
    // Coordinator completed full round trip back to initiator!
    ringEvents.emit(`coordinator_returned:${electionId}`, winnerId);
    return { ack: true, electionId, completed: true };
  }

  // Intermediate node: forward to successor asynchronously
  setImmediate(async () => {
    try {
      await forwardHop('election.ringCoordinator', {
        electionId,
        winnerId,
        members,
        initiatorId
      }, config, electionId);
    } catch (err) {
      logger.error({ event: 'ring.forward_coordinator_error', electionId, error: err.message });
    }
  });

  return { ack: true, electionId };
}

/**
 * Start a Ring Election as initiator.
 *
 * @param {Object} config - Node configuration
 * @param {Object} options - { excluded = [], initiatorId = config.nodeId }
 * @returns {Promise<Object>} Election outcome
 */
async function startRingElection(config, options = {}) {
  if (activeRingPromise) {
    logger.info({ event: 'ring.election_already_running', nodeId: config.nodeId });
    return activeRingPromise;
  }

  activeRingPromise = (async () => {
    try {
      return await runRingElectionWithRetries(config, options);
    } finally {
      activeRingPromise = null;
    }
  })();

  return activeRingPromise;
}

async function runRingElectionWithRetries(config, options, maxAttempts = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await runRingAttempt(config, options, attempt);
    } catch (err) {
      lastError = err;
      logger.warn({
        event: 'ring.attempt_failed',
        attempt,
        maxAttempts,
        error: err.message
      });
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  throw lastError || new Error('Ring election failed after maximum attempts');
}

async function runRingAttempt(config, options, attempt) {
  const myId = config.nodeId;
  const excluded = options.excluded || [];
  const curState = await getNodeState();
  const epochSeen = curState.epoch || 1;
  const lamport = lamportClock.tick();
  const electionId = `${epochSeen + 1}-${myId}-${lamport}`;

  await recordElectionMessage({
    electionId,
    algorithm: 'ring',
    direction: 'LOCAL',
    peerId: null,
    messageType: 'ELECTION_START',
    detail: { initiatorId: myId, attempt, excluded }
  });

  const initialCandidates = [];
  if (!excluded.includes(myId)) {
    initialCandidates.push(myId);
  }

  // 1. Send initial RING_TOKEN to successor
  const ringTimeoutMs = config.ringTimeoutMs || 8000;

  const hopRes = await forwardHop('election.ringToken', {
    electionId,
    initiatorId: myId,
    candidates: initialCandidates,
    excluded
  }, config, electionId);

  let gatheredCandidates = initialCandidates;

  if (hopRes.success) {
    // Wait for RING_TOKEN to circle back to initiator
    gatheredCandidates = await waitForRingEvent(`token_returned:${electionId}`, ringTimeoutMs);
    if (!gatheredCandidates) {
      throw new Error(`Ring token timed out after ${ringTimeoutMs}ms`);
    }
  } else {
    // No peers reachable; gatheredCandidates is just self
    logger.warn({ event: 'ring.no_peers_reachable', electionId });
  }

  // 2. Determine winner = candidate with highest rank among alive candidates not excluded
  const eligibleCandidates = gatheredCandidates.filter(id => !excluded.includes(id));
  if (eligibleCandidates.length === 0) {
    throw new Error('No eligible candidates remaining in ring election');
  }

  eligibleCandidates.sort((a, b) => {
    const rankA = a === myId ? config.nodeRank : ((config.peers[a] && config.peers[a].rank) || 0);
    const rankB = b === myId ? config.nodeRank : ((config.peers[b] && config.peers[b].rank) || 0);
    return rankB - rankA;
  });

  const winnerId = eligibleCandidates[0];

  await recordElectionMessage({
    electionId,
    algorithm: 'ring',
    direction: 'LOCAL',
    peerId: null,
    messageType: 'RING_WINNER',
    detail: { winnerId, candidates: gatheredCandidates }
  });

  // 3. Circulate RING_COORDINATOR around the ring
  const coordHop = await forwardHop('election.ringCoordinator', {
    electionId,
    winnerId,
    members: gatheredCandidates,
    initiatorId: myId
  }, config, electionId);

  if (coordHop.success) {
    await waitForRingEvent(`coordinator_returned:${electionId}`, ringTimeoutMs);
  }

  // 4. If winner is self, call promotion!
  let promoted = false;
  let promotionResult = null;

  if (winnerId === myId) {
    promotionResult = await executePromotion(myId, electionId, { excluded, config });
    promoted = true;
  }

  return {
    electionId,
    winner: winnerId,
    algorithm: 'ring',
    promoted,
    promotionResult,
    candidates: gatheredCandidates
  };
}

function waitForRingEvent(eventName, timeoutMs) {
  return new Promise((resolve) => {
    let timer = null;

    const handler = (data) => {
      clearTimeout(timer);
      ringEvents.removeListener(eventName, handler);
      resolve(data);
    };

    timer = setTimeout(() => {
      ringEvents.removeListener(eventName, handler);
      resolve(null);
    }, timeoutMs);

    ringEvents.once(eventName, handler);
  });
}

module.exports = {
  startRingElection,
  handleRingToken,
  handleRingCoordinator
};
