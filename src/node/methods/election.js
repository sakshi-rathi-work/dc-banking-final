// src/node/methods/election.js: Election JSON-RPC method registrations
// Specification: PROJECT.md Section 13.3, Section 18, Section 28 (Phase 6)
const { startBullyElection, handleBullyMessage, handleBullyCoordinator } = require('../../election/bully');
const { startRingElection, handleRingToken, handleRingCoordinator } = require('../../election/ring');
const { getElectionLogs } = require('../../election/electionLog');

function registerElectionMethods(rpcServer, config) {
  // 1. election.start
  rpcServer.register('election.start', async (params) => {
    const algorithm = (params && params.algorithm) ? params.algorithm.toLowerCase() : (config.electionAlgorithm || 'bully');
    const excluded = (params && Array.isArray(params.excluded)) ? params.excluded : [];

    if (algorithm === 'ring') {
      return await startRingElection(config, { excluded });
    } else {
      return await startBullyElection(config, { excluded });
    }
  });

  // 2. election.bully
  rpcServer.register('election.bully', async (params) => {
    return await handleBullyMessage(params, config);
  });

  // 3. election.bullyCoordinator
  rpcServer.register('election.bullyCoordinator', async (params) => {
    return await handleBullyCoordinator(params, config);
  });

  // 4. election.ringToken
  rpcServer.register('election.ringToken', async (params) => {
    return await handleRingToken(params, config);
  });

  // 5. election.ringCoordinator
  rpcServer.register('election.ringCoordinator', async (params) => {
    return await handleRingCoordinator(params, config);
  });

  // 6. election.getLog
  rpcServer.register('election.getLog', async (params) => {
    const electionId = params ? params.electionId : null;
    const limit = (params && typeof params.limit === 'number') ? params.limit : 100;
    const logs = await getElectionLogs({ electionId, limit });
    return {
      nodeId: config.nodeId,
      count: logs.length,
      logs
    };
  });
}

module.exports = {
  registerElectionMethods
};
