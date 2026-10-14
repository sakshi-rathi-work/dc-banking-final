// src/node/methods/cluster.js: Cluster RPC handlers for node
const { getNodeState } = require('../state');

function registerClusterMethods(rpcServer, failureDetector, config) {
  rpcServer.register('cluster.ping', async (params) => {
    return {
      pong: true,
      nodeId: config.nodeId,
      timestamp: Date.now()
    };
  });

  rpcServer.register('cluster.getState', async (params) => {
    const state = await getNodeState();
    let peers = {};
    if (failureDetector) {
      peers = await failureDetector.getPeerStates();
    }

    return {
      nodeId: config.nodeId,
      role: state.role,
      epoch: state.epoch,
      promisedEpoch: state.promised_epoch,
      leaderId: state.leader_id,
      backupId: state.backup_id,
      lastLsn: state.last_lsn,
      lastEpoch: state.last_epoch,
      durableLsn: state.durable_lsn,
      replicationMode: state.replication_mode,
      syncAcks: state.sync_acks,
      dbHealthy: true,
      leaseValid: true,
      peers
    };
  });

  rpcServer.register('cluster.heartbeat', async (params) => {
    if (failureDetector) {
      failureDetector.recordInboundHeartbeat(params);
    }

    const state = await getNodeState();
    return {
      ack: true,
      nodeId: config.nodeId,
      role: state.role,
      epoch: state.epoch,
      lastLsn: state.last_lsn
    };
  });
}

module.exports = {
  registerClusterMethods
};
