// src/shared/config.js: Configuration validation and parsing
const { URL } = require('url');

const NODE_RANKS = {
  a: 1,
  b: 2,
  c: 3,
  d: 4
};

function parsePeers(peersStr) {
  if (!peersStr) return {};
  const peers = {};
  const pairs = peersStr.split(',').map(s => s.trim()).filter(Boolean);
  for (const pair of pairs) {
    const [id, url] = pair.split('=');
    if (!id || !url) {
      throw new Error(`Invalid peer specification in PEERS: "${pair}"`);
    }
    const cleanId = id.trim().toLowerCase();
    const cleanUrl = url.trim();
    peers[cleanId] = {
      nodeId: cleanId,
      url: cleanUrl,
      rank: NODE_RANKS[cleanId] || 99
    };
  }
  return peers;
}

function validateDbIsolation(nodeId, databaseUrl) {
  if (!nodeId || !databaseUrl) return;
  if (process.env.ALLOW_ANY_DB_HOST === 'true') return;

  try {
    const parsed = new URL(databaseUrl);
    const expectedHost = `postgres-${nodeId.toLowerCase()}`;
    if (parsed.hostname !== expectedHost) {
      throw new Error(
        `Database isolation violation: Node "${nodeId}" cannot connect to host "${parsed.hostname}". Must equal "${expectedHost}".`
      );
    }
    const expectedUser = `bank_${nodeId.toLowerCase()}`;
    if (parsed.username && parsed.username !== expectedUser) {
      throw new Error(
        `Database credential violation: Node "${nodeId}" cannot connect with user "${parsed.username}". Must equal "${expectedUser}".`
      );
    }
  } catch (err) {
    if (err.message.includes('Database isolation violation') || err.message.includes('Database credential violation')) {
      throw err;
    }
    throw new Error(`Invalid DATABASE_URL format: ${err.message}`);
  }
}

function loadConfig() {
  const env = process.env;
  const nodeId = env.NODE_ID ? env.NODE_ID.trim().toLowerCase() : null;

  if (nodeId && !['a', 'b', 'c', 'd'].includes(nodeId)) {
    throw new Error(`Invalid NODE_ID: "${nodeId}". Must be one of: a, b, c, d`);
  }

  const databaseUrl = env.DATABASE_URL || null;
  if (nodeId && databaseUrl) {
    validateDbIsolation(nodeId, databaseUrl);
  }

  const peers = parsePeers(env.PEERS);

  const config = {
    nodeId,
    nodeRank: nodeId ? (NODE_RANKS[nodeId] || 0) : 0,
    nodePort: parseInt(env.NODE_PORT || '3000', 10),
    databaseUrl,
    peersStr: env.PEERS || '',
    peers,
    coordinatorUrl: env.COORDINATOR_URL || 'http://bank-coordinator:8080',
    bootstrapPrimary: env.BOOTSTRAP_PRIMARY === 'true',

    // Failure detector & cluster timers
    heartbeatIntervalMs: parseInt(env.HEARTBEAT_INTERVAL_MS || '1000', 10),
    failureTimeoutMs: parseInt(env.FAILURE_TIMEOUT_MS || '4000', 10),
    leaderLeaseMs: parseInt(env.LEADER_LEASE_MS || '3000', 10),
    discoveryWindowMs: parseInt(env.DISCOVERY_WINDOW_MS || '5000', 10),
    rpcTimeoutMs: parseInt(env.RPC_TIMEOUT_MS || '2000', 10),
    leaderWaitMs: parseInt(env.LEADER_WAIT_MS || '15000', 10),

    // Replication
    replicationMode: (env.REPLICATION_MODE || 'ASYNC').toUpperCase(),
    syncAcks: parseInt(env.SYNC_ACKS || '2', 10),
    syncTimeoutMs: parseInt(env.SYNC_TIMEOUT_MS || '3000', 10),
    asyncBatchIntervalMs: parseInt(env.ASYNC_BATCH_INTERVAL_MS || '100', 10),
    replBatchSize: parseInt(env.REPL_BATCH_SIZE || '100', 10),
    readMaxLagLsn: parseInt(env.READ_MAX_LAG_LSN || '5', 10),

    // Election
    electionAlgorithm: (env.ELECTION_ALGORITHM || 'bully').toLowerCase(),
    bullyOkTimeoutMs: parseInt(env.BULLY_OK_TIMEOUT_MS || '2000', 10),
    coordinatorWaitMs: parseInt(env.COORDINATOR_WAIT_MS || '5000', 10),
    electionHopTimeoutMs: parseInt(env.ELECTION_HOP_TIMEOUT_MS || '1500', 10),
    ringTimeoutMs: parseInt(env.RING_TIMEOUT_MS || '8000', 10),
    backupGraceMs: parseInt(env.BACKUP_GRACE_MS || '5000', 10),

    // Clocks
    clockOffsetMs: parseInt(env.CLOCK_OFFSET_MS || '0', 10),
    clockDriftPpm: parseFloat(env.CLOCK_DRIFT_PPM || '0'),
    coordinatorClockOffsetMs: parseInt(env.COORDINATOR_CLOCK_OFFSET_MS || '0', 10),
    berkeleyOutlierMs: parseInt(env.BERKELEY_OUTLIER_MS || '10000', 10),

    // Workers
    workerPoolSize: parseInt(env.WORKER_POOL_SIZE || '4', 10),
    batchTimeoutMs: parseInt(env.BATCH_TIMEOUT_MS || '30000', 10),

    // Load Balancing
    lbAlgorithm: (env.LB_ALGORITHM || 'round-robin').toLowerCase(),
    lbHealthIntervalMs: parseInt(env.LB_HEALTH_INTERVAL_MS || '1000', 10),
    lbUnhealthyThreshold: parseInt(env.LB_UNHEALTHY_THRESHOLD || '2', 10),
    lbRecoveryThreshold: parseInt(env.LB_RECOVERY_THRESHOLD || '3', 10),

    // Fault & Control
    enableFaultInjection: env.ENABLE_FAULT_INJECTION === 'true',
    dockerControlEnabled: env.DOCKER_CONTROL_ENABLED === 'true',
    logLevel: env.LOG_LEVEL || 'info',
    maxTxnAmount: env.MAX_TXN_AMOUNT || '1000000.00'
  };

  // Rule verification: LEADER_LEASE_MS must be strictly less than FAILURE_TIMEOUT_MS
  if (config.leaderLeaseMs >= config.failureTimeoutMs) {
    throw new Error(
      `Configuration invariant violated: LEADER_LEASE_MS (${config.leaderLeaseMs}) must be < FAILURE_TIMEOUT_MS (${config.failureTimeoutMs})`
    );
  }

  return config;
}

module.exports = {
  NODE_RANKS,
  parsePeers,
  validateDbIsolation,
  loadConfig
};
