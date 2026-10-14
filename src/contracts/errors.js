// src/contracts/errors.js: Standard and Banking JSON-RPC Error Codes

const ERROR_CODES = {
  // Standard JSON-RPC 2.0
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  // Application & Banking Errors
  ACCOUNT_NOT_FOUND: -32001,
  INSUFFICIENT_FUNDS: -32002,
  ACCOUNT_NOT_ACTIVE: -32003,
  IDEMPOTENCY_KEY_REUSED: -32004,
  NOT_PRIMARY: -32005,
  STALE_LEADER: -32006,
  NO_LEADER: -32007,
  INSUFFICIENT_REPLICAS: -32008,
  REPLICATION_QUORUM_TIMEOUT: -32009,
  DB_UNAVAILABLE: -32010,
  NODE_RECOVERING: -32011,
  PROMOTION_REFUSED: -32012,
  REPLICATION_GAP: -32013,
  REPLICATION_DIVERGED: -32014,
  WORKER_FAILED: -32015,
  READ_TOO_STALE: -32016
};

const ERROR_NAMES = Object.fromEntries(
  Object.entries(ERROR_CODES).map(([name, code]) => [code, name])
);

class RpcError extends Error {
  constructor(code, message, data = null) {
    super(message || ERROR_NAMES[code] || 'RPC_ERROR');
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

class RpcTimeoutError extends Error {
  constructor(message = 'RPC request timed out') {
    super(message);
    this.name = 'RpcTimeoutError';
    this.code = 'ETIMEDOUT';
  }
}

class RpcNetworkError extends Error {
  constructor(message = 'RPC network error', cause = null) {
    super(message);
    this.name = 'RpcNetworkError';
    this.code = 'ECONNREFUSED';
    this.cause = cause;
  }
}

module.exports = {
  ERROR_CODES,
  ERROR_NAMES,
  RpcError,
  RpcTimeoutError,
  RpcNetworkError
};
