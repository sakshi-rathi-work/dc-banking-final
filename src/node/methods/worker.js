// src/node/methods/worker.js: RPC methods for worker pool batch execution and activity inspection
const { WorkerPool } = require('../../workers/pool');
const { runScenario } = require('../../workers/scenarios');
const { getNodeState } = require('../state');
const { RpcError, ERROR_CODES } = require('../../contracts/errors');

let globalWorkerPool = null;

function getWorkerPool(config) {
  if (!globalWorkerPool) {
    const poolSize = parseInt(process.env.WORKER_POOL_SIZE || '4', 10);
    globalWorkerPool = new WorkerPool(config.databaseUrl, poolSize);
  }
  return globalWorkerPool;
}

function registerWorkerMethods(rpcServer, config) {
  async function assertPrimary() {
    const state = await getNodeState();
    if (state.role !== 'primary') {
      throw new RpcError(ERROR_CODES.NOT_PRIMARY, `Node ${config.nodeId} is not primary`, {
        leaderHint: state.leader_id || 'a',
        epoch: state.epoch
      });
    }
    return state;
  }

  const pool = getWorkerPool(config);

  rpcServer.register('worker.runBatch', async (params) => {
    await assertPrimary();
    const { scenario } = params || {};

    if (scenario) {
      return runScenario(scenario, pool, params);
    }

    return pool.runBatch(params || {});
  });

  rpcServer.register('worker.getActivity', async () => {
    return {
      nodeId: config.nodeId,
      poolSize: pool.maxSize,
      activeWorkers: pool.getWorkerStats(),
      totalTasksExecuted: pool.totalTasksExecuted
    };
  });
}

module.exports = {
  registerWorkerMethods,
  getWorkerPool
};
