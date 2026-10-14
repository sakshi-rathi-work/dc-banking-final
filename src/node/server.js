// src/node/server.js: Bank Node Server Entry Point
const express = require('express');
const os = require('os');
const { loadConfig } = require('../shared/config');
const { logger } = require('../shared/logger');
const { runMigrations } = require('../shared/db/migrate');
const { closePool, query } = require('../shared/db/pool');
const { initNodeState, getNodeState } = require('./state');
const { FailureDetector } = require('../election/failureDetector');
const { RpcServer } = require('../shared/rpc/server');
const { registerClusterMethods } = require('./methods/cluster');

async function main() {
  const config = loadConfig();
  logger.info({
    event: 'node.starting',
    nodeId: config.nodeId,
    port: config.nodePort,
    pid: process.pid,
    hostname: os.hostname()
  });

  // 1. Run migrations
  try {
    const applied = await runMigrations();
    logger.info({ event: 'db.migrations_complete', appliedCount: applied.length, applied });
  } catch (err) {
    logger.fatal({ event: 'db.migration_fatal', error: err.message, stack: err.stack });
    process.exit(1);
  }

  // 2. Initialize node_state
  try {
    const state = await initNodeState(config.nodeId, config.bootstrapPrimary);
    logger.info({
      event: 'node.state_initialized',
      role: state.role,
      epoch: state.epoch,
      leaderId: state.leader_id
    });
  } catch (err) {
    logger.fatal({ event: 'node.state_init_fatal', error: err.message });
    process.exit(1);
  }

  // 3. Initialize Failure Detector
  const failureDetector = new FailureDetector(config);
  try {
    await failureDetector.init();
    failureDetector.start();
    logger.info({ event: 'failure_detector.started' });
  } catch (err) {
    logger.error({ event: 'failure_detector.init_error', error: err.message });
  }

  // 4. Create Express app & RPC Server
  const app = express();
  const rpcServer = new RpcServer();

  registerClusterMethods(rpcServer, failureDetector, config);

  // Mount JSON-RPC handler at POST /rpc
  app.use(rpcServer.createMiddleware());

  // GET /health for Docker healthchecks
  app.get('/health', async (req, res) => {
    let dbHealthy = true;
    let role = 'unknown';
    let epoch = 0;

    try {
      await query('SELECT 1');
      const state = await getNodeState();
      role = state.role;
      epoch = state.epoch;
    } catch (err) {
      dbHealthy = false;
    }

    const payload = {
      nodeId: config.nodeId,
      pid: process.pid,
      hostname: os.hostname(),
      dbHealthy,
      role,
      epoch
    };

    if (dbHealthy) {
      return res.status(200).json(payload);
    } else {
      return res.status(503).json(payload);
    }
  });

  const server = app.listen(config.nodePort, () => {
    logger.info({
      event: 'node.ready',
      nodeId: config.nodeId,
      port: config.nodePort
    });
  });

  const shutdown = async (signal) => {
    logger.info({ event: 'node.shutting_down', signal });
    failureDetector.stop();
    server.close();
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(err => {
  console.error('Fatal unhandled error on boot:', err);
  process.exit(1);
});
