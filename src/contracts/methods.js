// src/contracts/methods.js: Method catalogue, parameter validators, and contract definitions
const { RpcError, ERROR_CODES } = require('./errors');
const {
  validateAccountId,
  validateHolderName,
  validateAmount,
  validateIdempotencyKey
} = require('../domain/validators');

const METHOD_NAMES = {
  // Bank
  BANK_CREATE_ACCOUNT: 'bank.createAccount',
  BANK_DEPOSIT: 'bank.deposit',
  BANK_WITHDRAW: 'bank.withdraw',
  BANK_TRANSFER: 'bank.transfer',
  BANK_GET_BALANCE: 'bank.getBalance',
  BANK_GET_ACCOUNT: 'bank.getAccount',
  BANK_LIST_ACCOUNTS: 'bank.listAccounts',
  BANK_GET_HISTORY: 'bank.getHistory',

  // Cluster & Faults
  CLUSTER_PING: 'cluster.ping',
  CLUSTER_GET_STATE: 'cluster.getState',
  CLUSTER_HEARTBEAT: 'cluster.heartbeat',
  CLUSTER_REQUEST_EPOCH: 'cluster.requestEpoch',
  CLUSTER_ANNOUNCE_LEADER: 'cluster.announceLeader',
  CLUSTER_SET_FAULT: 'cluster.setFault',
  CLUSTER_GET_FAULTS: 'cluster.getFaults',
  CLUSTER_CLEAR_FAULTS: 'cluster.clearFaults',

  // Election (Experiment 4)
  ELECTION_START: 'election.start',
  ELECTION_BULLY: 'election.bully',
  ELECTION_BULLY_COORDINATOR: 'election.bullyCoordinator',
  ELECTION_RING_TOKEN: 'election.ringToken',
  ELECTION_RING_COORDINATOR: 'election.ringCoordinator',
  ELECTION_GET_LOG: 'election.getLog',

  // Admin
  ADMIN_VERIFY_INVARIANTS: 'admin.verifyInvariants',
  ADMIN_STATE_CHECKSUM: 'admin.stateChecksum',

  // Worker & Multithreading
  WORKER_RUN_BATCH: 'worker.runBatch',
  WORKER_GET_ACTIVITY: 'worker.getActivity',

  // Clocks (Experiment 3)
  CLOCK_GET: 'clock.get',
  CLOCK_SET_OFFSET: 'clock.setOffset',
  CLOCK_ADJUST: 'clock.adjust',
  CLOCK_EVENTS: 'clock.events',
  CLOCK_SYNC: 'clock.sync',

  // Replication (Experiment 5)
  REPLICATION_APPEND: 'replication.append',
  REPLICATION_FETCH: 'replication.fetch',
  REPLICATION_HASH_AT: 'replication.hashAt',
  REPLICATION_STATUS: 'replication.status',
  REPLICATION_LEADER_STATUS: 'replication.leaderStatus',
  REPLICATION_SET_MODE: 'replication.setMode',
  REPLICATION_RESEND: 'replication.resend',

  // Gateway
  GATEWAY_CALL: 'gateway.call',
  GATEWAY_CLUSTER_STATUS: 'gateway.clusterStatus',

  // Load Balancer (Experiment 6)
  LB_SET_ALGORITHM: 'lb.setAlgorithm',
  LB_RUN: 'lb.run',
  LB_STATS: 'lb.stats'
};

function validateMethodParams(method, params = {}) {
  if (!params || typeof params !== 'object') {
    throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'Params must be an object');
  }

  switch (method) {
    case METHOD_NAMES.BANK_CREATE_ACCOUNT:
      validateHolderName(params.holderName);
      validateIdempotencyKey(params.idempotencyKey);
      if (params.openingDeposit !== undefined && params.openingDeposit !== null) {
        validateAmount(params.openingDeposit);
      }
      break;

    case METHOD_NAMES.BANK_DEPOSIT:
    case METHOD_NAMES.BANK_WITHDRAW:
      validateAccountId(params.accountId);
      validateAmount(params.amount);
      validateIdempotencyKey(params.idempotencyKey);
      break;

    case METHOD_NAMES.BANK_TRANSFER:
      validateAccountId(params.fromAccountId, 'fromAccountId');
      validateAccountId(params.toAccountId, 'toAccountId');
      if (params.fromAccountId === params.toAccountId) {
        throw new RpcError(
          ERROR_CODES.INVALID_PARAMS,
          'fromAccountId and toAccountId must be distinct'
        );
      }
      validateAmount(params.amount);
      validateIdempotencyKey(params.idempotencyKey);
      break;

    case METHOD_NAMES.BANK_GET_BALANCE:
    case METHOD_NAMES.BANK_GET_ACCOUNT:
      validateAccountId(params.accountId);
      break;

    case METHOD_NAMES.CLUSTER_SET_FAULT:
      if (!params.knob || typeof params.knob !== 'string') {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'Missing fault knob name');
      }
      break;

    case METHOD_NAMES.WORKER_RUN_BATCH: {
      const ops = params.operations || params.tasks;
      if (!params.scenario && (!Array.isArray(ops) || ops.length === 0)) {
        throw new RpcError(
          ERROR_CODES.INVALID_PARAMS,
          'worker.runBatch requires either a valid "scenario" string or a non-empty "operations" array'
        );
      }
      break;
    }

    case METHOD_NAMES.CLOCK_SET_OFFSET:
      if (params.offsetMs === undefined || typeof params.offsetMs !== 'number' || isNaN(params.offsetMs)) {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'clock.setOffset requires numeric "offsetMs"');
      }
      if (params.driftPpm !== undefined && (typeof params.driftPpm !== 'number' || isNaN(params.driftPpm))) {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, '"driftPpm" must be a number');
      }
      break;

    case METHOD_NAMES.CLOCK_ADJUST:
      if (params.deltaMs === undefined || typeof params.deltaMs !== 'number' || isNaN(params.deltaMs)) {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'clock.adjust requires numeric "deltaMs"');
      }
      break;

    case METHOD_NAMES.CLOCK_SYNC:
      if (params.outlierMs !== undefined && (typeof params.outlierMs !== 'number' || isNaN(params.outlierMs))) {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, '"outlierMs" must be a number');
      }
      break;

    case METHOD_NAMES.REPLICATION_APPEND:
      if (params.epoch === undefined || typeof params.epoch !== 'number') {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'replication.append requires numeric "epoch"');
      }
      if (!params.leaderId || typeof params.leaderId !== 'string') {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'replication.append requires string "leaderId"');
      }
      if (!Array.isArray(params.entries)) {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'replication.append requires "entries" array');
      }
      break;

    case METHOD_NAMES.REPLICATION_FETCH:
      if (params.fromLsn === undefined || typeof params.fromLsn !== 'number' || params.fromLsn < 0) {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'replication.fetch requires non-negative numeric "fromLsn"');
      }
      break;

    case METHOD_NAMES.REPLICATION_HASH_AT:
      if (params.lsn === undefined || typeof params.lsn !== 'number' || params.lsn < 0) {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'replication.hashAt requires non-negative numeric "lsn"');
      }
      break;

    case METHOD_NAMES.REPLICATION_SET_MODE:
      if (!params.mode || (params.mode !== 'SYNC' && params.mode !== 'ASYNC')) {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'replication.setMode requires mode to be "SYNC" or "ASYNC"');
      }
      if (params.syncAcks !== undefined && (typeof params.syncAcks !== 'number' || params.syncAcks < 1)) {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'syncAcks must be an integer >= 1');
      }
      break;

    case METHOD_NAMES.REPLICATION_RESEND:
      if (!params.toPeer || typeof params.toPeer !== 'string') {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'replication.resend requires string "toPeer"');
      }
      if (typeof params.fromLsn !== 'number' || typeof params.toLsn !== 'number' || params.fromLsn > params.toLsn) {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'Invalid fromLsn/toLsn range for resend');
      }
      break;

    case METHOD_NAMES.CLUSTER_REQUEST_EPOCH:
      if (params.epoch === undefined || typeof params.epoch !== 'number' || params.epoch < 1) {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'cluster.requestEpoch requires positive numeric "epoch"');
      }
      if (!params.candidateId || typeof params.candidateId !== 'string') {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'cluster.requestEpoch requires string "candidateId"');
      }
      break;

    case METHOD_NAMES.CLUSTER_ANNOUNCE_LEADER:
      if (params.epoch === undefined || typeof params.epoch !== 'number' || params.epoch < 1) {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'cluster.announceLeader requires positive numeric "epoch"');
      }
      if (!params.leaderId || typeof params.leaderId !== 'string') {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'cluster.announceLeader requires string "leaderId"');
      }
      break;

    case METHOD_NAMES.ELECTION_START:
      if (params.algorithm && !['bully', 'ring'].includes(params.algorithm)) {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'election.start "algorithm" must be "bully" or "ring"');
      }
      if (params.excluded && !Array.isArray(params.excluded)) {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'election.start "excluded" must be an array of node IDs');
      }
      break;

    case METHOD_NAMES.ELECTION_BULLY:
      if (!params.electionId || typeof params.electionId !== 'string') {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'election.bully requires string "electionId"');
      }
      if (!params.fromId || typeof params.fromId !== 'string') {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'election.bully requires string "fromId"');
      }
      break;

    case METHOD_NAMES.ELECTION_BULLY_COORDINATOR:
      if (!params.electionId || typeof params.electionId !== 'string') {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'election.bullyCoordinator requires string "electionId"');
      }
      if (!params.winnerId || typeof params.winnerId !== 'string') {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'election.bullyCoordinator requires string "winnerId"');
      }
      break;

    case METHOD_NAMES.ELECTION_RING_TOKEN:
      if (!params.electionId || typeof params.electionId !== 'string') {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'election.ringToken requires string "electionId"');
      }
      if (!params.initiatorId || typeof params.initiatorId !== 'string') {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'election.ringToken requires string "initiatorId"');
      }
      if (!Array.isArray(params.candidates)) {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'election.ringToken requires "candidates" array');
      }
      break;

    case METHOD_NAMES.ELECTION_RING_COORDINATOR:
      if (!params.electionId || typeof params.electionId !== 'string') {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'election.ringCoordinator requires string "electionId"');
      }
      if (!params.winnerId || typeof params.winnerId !== 'string') {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'election.ringCoordinator requires string "winnerId"');
      }
      if (!Array.isArray(params.members)) {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'election.ringCoordinator requires "members" array');
      }
      break;

    case METHOD_NAMES.LB_SET_ALGORITHM:
      if (!params.algorithm || !['round-robin', 'least-connections'].includes(params.algorithm.toLowerCase())) {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'lb.setAlgorithm requires "algorithm" to be "round-robin" or "least-connections"');
      }
      break;

    case METHOD_NAMES.LB_RUN:
      if (params.algorithm && !['round-robin', 'least-connections'].includes(params.algorithm.toLowerCase())) {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'lb.run "algorithm" must be "round-robin" or "least-connections"');
      }
      if (params.requests !== undefined && (typeof params.requests !== 'number' || params.requests < 1)) {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'lb.run "requests" must be an integer >= 1');
      }
      if (params.concurrency !== undefined && (typeof params.concurrency !== 'number' || params.concurrency < 1)) {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'lb.run "concurrency" must be an integer >= 1');
      }
      break;

    default:
      // Other methods do not have strict required parameters
      break;
  }
}

module.exports = {
  METHOD_NAMES,
  validateMethodParams
};
