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
  CLUSTER_SET_FAULT: 'cluster.setFault',
  CLUSTER_GET_FAULTS: 'cluster.getFaults',
  CLUSTER_CLEAR_FAULTS: 'cluster.clearFaults',

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
  GATEWAY_CLUSTER_STATUS: 'gateway.clusterStatus'
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

    case METHOD_NAMES.WORKER_RUN_BATCH:
      if (!params.scenario && (!Array.isArray(params.operations) || params.operations.length === 0)) {
        throw new RpcError(
          ERROR_CODES.INVALID_PARAMS,
          'worker.runBatch requires either a valid "scenario" string or a non-empty "operations" array'
        );
      }
      break;

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

    default:
      // Other methods do not have strict required parameters
      break;
  }
}

module.exports = {
  METHOD_NAMES,
  validateMethodParams
};
