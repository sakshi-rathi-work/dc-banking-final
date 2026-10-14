// src/shared/rpc/envelope.js: JSON-RPC 2.0 formatting and validation
const { ERROR_CODES, RpcError } = require('../../contracts/errors');

function formatRequest(method, params = {}, id = null) {
  return {
    jsonrpc: '2.0',
    id: id !== undefined ? id : `req-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    method,
    params
  };
}

function formatResponse(id, result) {
  return {
    jsonrpc: '2.0',
    id: id !== undefined ? id : null,
    result
  };
}

function formatError(id, error) {
  let code = ERROR_CODES.INTERNAL_ERROR;
  let message = 'Internal error';
  let data = null;

  if (error instanceof RpcError) {
    code = error.code;
    message = error.message;
    data = error.data;
  } else if (typeof error === 'object' && error !== null) {
    code = typeof error.code === 'number' ? error.code : ERROR_CODES.INTERNAL_ERROR;
    message = error.message || 'Internal error';
    data = error.data || null;
  } else if (typeof error === 'string') {
    message = error;
  }

  const errObj = { code, message };
  if (data !== null && data !== undefined) {
    errObj.data = data;
  }

  return {
    jsonrpc: '2.0',
    id: id !== undefined ? id : null,
    error: errObj
  };
}

function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RpcError(ERROR_CODES.INVALID_REQUEST, 'Request must be a JSON object');
  }
  if (body.jsonrpc !== '2.0') {
    throw new RpcError(ERROR_CODES.INVALID_REQUEST, 'Invalid JSON-RPC version; must be "2.0"');
  }
  if (typeof body.method !== 'string' || !body.method.trim()) {
    throw new RpcError(ERROR_CODES.INVALID_REQUEST, 'Method name must be a non-empty string');
  }
  if (body.params !== undefined && (typeof body.params !== 'object' || body.params === null)) {
    throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'Params must be an object or array if provided');
  }
}

module.exports = {
  formatRequest,
  formatResponse,
  formatError,
  validateRequest
};
