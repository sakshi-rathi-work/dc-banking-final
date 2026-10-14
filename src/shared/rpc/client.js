// src/shared/rpc/client.js: HTTP JSON-RPC 2.0 Client
const { formatRequest } = require('./envelope');
const { RpcError, RpcTimeoutError, RpcNetworkError } = require('../../contracts/errors');

async function callRpc(url, method, params = {}, options = {}) {
  const timeoutMs = options.timeoutMs || parseInt(process.env.RPC_TIMEOUT_MS || '2000', 10);
  const reqId = options.id || `req-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const payload = formatRequest(method, params, reqId);

  let targetUrl = url;
  if (!targetUrl.endsWith('/rpc')) {
    targetUrl = targetUrl.replace(/\/+$/, '') + '/rpc';
  }

  const signal = AbortSignal.timeout(timeoutMs);

  let response;
  try {
    response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload),
      signal
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || signal.aborted) {
      throw new RpcTimeoutError(`RPC request to ${targetUrl} (${method}) timed out after ${timeoutMs}ms`);
    }
    throw new RpcNetworkError(`RPC network error to ${targetUrl} (${method}): ${err.message}`, err);
  }

  if (!response.ok) {
    throw new RpcNetworkError(`HTTP error ${response.status} from ${targetUrl} (${method})`);
  }

  let body;
  try {
    body = await response.json();
  } catch (err) {
    throw new RpcNetworkError(`Invalid JSON received from ${targetUrl} (${method}): ${err.message}`, err);
  }

  if (body.error) {
    throw new RpcError(body.error.code, body.error.message, body.error.data);
  }

  return body.result;
}

module.exports = {
  callRpc
};
