// src/election/bully.js: Bully Election Algorithm Implementation
// Specification: PROJECT.md Section 18.1, Section 18.2, Section 18.4, Section 28 (Phase 6)
const { EventEmitter } = require('events');
const { callRpc } = require('../shared/rpc/client');
const { getNodeState } = require('../node/state');
const { lamportClock } = require('../clocks/lamportClock');
const { recordElectionMessage } = require('./electionLog');
const { executePromotion } = require('../faulttolerance/promotion');
const { logger } = require('../shared/logger');

const bullyEvents = new EventEmitter();
let activeElectionPromise = null;

/**
 * Handle incoming election.bully message on this node.
 * Lower-rank nodes send this to higher-rank nodes.
 */
async function handleBullyMessage(params, config) {
  const { electionId, fromId, excluded = [] } = params;
  const myId = config.nodeId;
  const myRank = config.nodeRank;
  const fromRank = (config.peers[fromId] && config.peers[fromId].rank) || 0;

  await recordElectionMessage({
    electionId,
    algorithm: 'bully',
    direction: 'RECEIVED',
    peerId: fromId,
    messageType: 'ELECTION',
    detail: { fromId, fromRank, excluded }
  });

  if (excluded.includes(myId)) {
    logger.info({ event: 'bully.ignored_excluded', electionId, myId });
    return { ok: false, reason: 'EXCLUDED' };
  }

  if (myRank > fromRank) {
    // Reply OK to acknowledge and suppress lower node
    await recordElectionMessage({
      electionId,
      algorithm: 'bully',
      direction: 'SENT',
      peerId: fromId,
      messageType: 'OK',
      detail: { to: fromId }
    });

    // Start own election asynchronously if not already running
    setImmediate(() => {
      startBullyElection(config, { excluded }).catch(err => {
        logger.error({ event: 'bully.triggered_election_error', error: err.message });
      });
    });

    return {
      ok: true,
      fromId: myId,
      electionId
    };
  }

  return {
    ok: false,
    reason: 'RANK_TOO_LOW'
  };
}

/**
 * Handle incoming election.bullyCoordinator announcement.
 */
async function handleBullyCoordinator(params, config) {
  const { electionId, winnerId, epochSeen } = params;

  await recordElectionMessage({
    electionId,
    algorithm: 'bully',
    direction: 'RECEIVED',
    peerId: winnerId,
    messageType: 'COORDINATOR',
    detail: { winnerId, epochSeen }
  });

  bullyEvents.emit('coordinator', { electionId, winnerId });

  return {
    ack: true,
    electionId,
    winnerId
  };
}

/**
 * Start a Bully Election as initiator.
 *
 * @param {Object} config - Node configuration
 * @param {Object} options - { excluded = [], initiatorId = config.nodeId }
 * @returns {Promise<Object>} Election outcome
 */
async function startBullyElection(config, options = {}) {
  if (activeElectionPromise) {
    logger.info({ event: 'bully.election_already_running', nodeId: config.nodeId });
    return activeElectionPromise;
  }

  activeElectionPromise = (async () => {
    try {
      return await runBullyAlgorithm(config, options);
    } finally {
      activeElectionPromise = null;
    }
  })();

  return activeElectionPromise;
}

async function runBullyAlgorithm(config, options = {}) {
  const myId = config.nodeId;
  const myRank = config.nodeRank;
  const peers = config.peers || {};
  const excluded = options.excluded || [];

  const curState = await getNodeState();
  const epochSeen = curState.epoch || 1;
  const lamport = lamportClock.tick();
  const electionId = `${epochSeen + 1}-${myId}-${lamport}`;

  await recordElectionMessage({
    electionId,
    algorithm: 'bully',
    direction: 'LOCAL',
    peerId: null,
    messageType: 'ELECTION_START',
    detail: { initiatorId: myId, rank: myRank, excluded }
  });

  // Find all higher-rank peers not excluded
  const higherPeers = Object.entries(peers).filter(([peerId, peer]) => {
    return peer.rank > myRank && !excluded.includes(peerId);
  });

  logger.info({
    event: 'bully.started',
    electionId,
    initiatorId: myId,
    higherPeersCount: higherPeers.length
  });

  // If no higher-rank peers exist: initiator wins immediately
  if (higherPeers.length === 0) {
    return await declareBullyWinner(config, electionId, myId, epochSeen, excluded);
  }

  // Send ELECTION message to all higher-rank peers
  const okTimeoutMs = config.bullyOkTimeoutMs || 2000;
  let receivedAnyOk = false;

  await Promise.all(higherPeers.map(async ([peerId, peer]) => {
    await recordElectionMessage({
      electionId,
      algorithm: 'bully',
      direction: 'SENT',
      peerId,
      messageType: 'ELECTION',
      detail: { to: peerId }
    });

    try {
      const res = await callRpc(peer.url, 'election.bully', {
        electionId,
        fromId: myId,
        excluded
      }, { timeoutMs: okTimeoutMs });

      if (res && res.ok) {
        receivedAnyOk = true;
        await recordElectionMessage({
          electionId,
          algorithm: 'bully',
          direction: 'RECEIVED',
          peerId,
          messageType: 'OK',
          detail: { from: peerId }
        });
      }
    } catch (err) {
      // Peer unreachable or timed out
      logger.debug({ event: 'bully.peer_no_ok', peerId, error: err.message });
    }
  }));

  // If ANY higher-rank peer replied OK: initiator stops and waits for COORDINATOR
  if (receivedAnyOk) {
    logger.info({ event: 'bully.suppressed', electionId, myId });
    const coordWaitMs = config.coordinatorWaitMs || 5000;

    const winner = await waitForBullyCoordinator(electionId, coordWaitMs);
    if (winner) {
      return {
        electionId,
        winner,
        algorithm: 'bully',
        suppressed: true
      };
    } else {
      // Timeout waiting for coordinator announcement! Restart election
      logger.warn({ event: 'bully.coordinator_wait_timeout', electionId });
      return await runBullyAlgorithm(config, options);
    }
  }

  // If NO higher-rank peer replied OK: initiator wins!
  return await declareBullyWinner(config, electionId, myId, epochSeen, excluded);
}

/**
 * Announce coordinator and run promotion protocol.
 */
async function declareBullyWinner(config, electionId, winnerId, epochSeen, excluded) {
  const peers = config.peers || {};

  await recordElectionMessage({
    electionId,
    algorithm: 'bully',
    direction: 'LOCAL',
    peerId: null,
    messageType: 'COORDINATOR',
    detail: { winnerId, epochSeen }
  });

  // Broadcast COORDINATOR to all peers
  await Promise.all(Object.entries(peers).map(async ([peerId, peer]) => {
    await recordElectionMessage({
      electionId,
      algorithm: 'bully',
      direction: 'SENT',
      peerId,
      messageType: 'COORDINATOR',
      detail: { to: peerId, winnerId }
    });

    try {
      await callRpc(peer.url, 'election.bullyCoordinator', {
        electionId,
        winnerId,
        epochSeen
      }, { timeoutMs: 1500 });
    } catch (err) {
      logger.debug({ event: 'bully.coordinator_broadcast_failed', peerId, error: err.message });
    }
  }));

  // Execute promotion
  let promotionResult = null;
  let promoted = false;

  try {
    promotionResult = await executePromotion(winnerId, electionId, { excluded, config });
    promoted = true;
  } catch (promErr) {
    logger.error({ event: 'bully.promotion_error', electionId, error: promErr.message });
    throw promErr;
  }

  return {
    electionId,
    winner: winnerId,
    algorithm: 'bully',
    promoted,
    promotionResult
  };
}

function waitForBullyCoordinator(electionId, timeoutMs) {
  return new Promise((resolve) => {
    let timer = null;

    const onCoord = (data) => {
      clearTimeout(timer);
      bullyEvents.removeListener('coordinator', onCoord);
      resolve(data.winnerId);
    };

    timer = setTimeout(() => {
      bullyEvents.removeListener('coordinator', onCoord);
      resolve(null);
    }, timeoutMs);

    bullyEvents.once('coordinator', onCoord);
  });
}

module.exports = {
  startBullyElection,
  handleBullyMessage,
  handleBullyCoordinator
};
