const { faults } = require('../../shared/faults');
const { getNodeState } = require('../state');

function registerClusterMethods(rpcServer, failureDetector, config) {
  rpcServer.register('cluster.ping', async (params) => {
    return {
      pong: true,
      nodeId: config.nodeId,
      timestamp: Date.now()
    };
  });

  rpcServer.register('cluster.setFault', async (params) => {
    const { knob, value } = params || {};
    if (!knob) {
      throw new Error('Missing fault knob');
    }
    faults.setFault(knob, value);
    return {
      set: true,
      knob,
      value
    };
  });

  rpcServer.register('cluster.getFaults', async () => {
    return {
      nodeId: config.nodeId,
      faults: faults.getFaults()
    };
  });

  rpcServer.register('cluster.clearFaults', async () => {
    faults.clearFaults();
    return {
      nodeId: config.nodeId,
      cleared: true
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
