// src/coordinator/server.js: Coordinator Server Entry Point
const express = require('express');
const os = require('os');
const { loadConfig } = require('../shared/config');
const { logger } = require('../shared/logger');
const { RpcServer } = require('../shared/rpc/server');
const { callRpc } = require('../shared/rpc/client');

const { LeaderTracker } = require('./leaderTracker');
const { Gateway } = require('./gateway');
const { METHOD_NAMES } = require('../contracts/methods');

async function main() {
  const config = loadConfig();
  logger.info({
    event: 'coordinator.starting',
    port: 8080,
    pid: process.pid,
    hostname: os.hostname()
  });

  const leaderTracker = new LeaderTracker(config.peers);
  const gateway = new Gateway(leaderTracker, config);

  const app = express();
  const rpcServer = new RpcServer();

  rpcServer.register('cluster.ping', async () => {
    return {
      pong: true,
      service: 'coordinator',
      timestamp: Date.now()
    };
  });

  rpcServer.register('gateway.clusterStatus', async () => {
    const nodes = {};
    for (const [peerId, peer] of Object.entries(config.peers)) {
      try {
        const state = await callRpc(peer.url, 'cluster.getState', {}, { timeoutMs: 1000 });
        nodes[peerId] = {
          online: true,
          ...state
        };
      } catch (err) {
        nodes[peerId] = {
          online: false,
          error: err.message
        };
      }
    }

    return {
      coordinator: {
        pid: process.pid,
        hostname: os.hostname(),
        status: 'UP'
      },
      nodes
    };
  });

  // Explicit gateway.call handler
  rpcServer.register('gateway.call', async (params, meta) => {
    const { method, params: innerParams } = params || {};
    return gateway.handleCall(method, innerParams, meta);
  });

  // Direct banking, admin, and worker calls proxied through gateway
  for (const method of Object.values(METHOD_NAMES)) {
    if (method.startsWith('bank.') || method.startsWith('admin.') || method.startsWith('worker.')) {
      rpcServer.register(method, async (params, meta) => {
        return gateway.handleCall(method, params, meta);
      });
    }
  }

  app.use(rpcServer.createMiddleware());

  app.get('/health', (req, res) => {
    res.status(200).json({
      service: 'coordinator',
      pid: process.pid,
      hostname: os.hostname(),
      healthy: true
    });
  });

  const server = app.listen(8080, () => {
    logger.info({ event: 'coordinator.ready', port: 8080 });
  });

  const shutdown = (signal) => {
    logger.info({ event: 'coordinator.shutting_down', signal });
    server.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(err => {
  console.error('Fatal coordinator startup error:', err);
  process.exit(1);
});
