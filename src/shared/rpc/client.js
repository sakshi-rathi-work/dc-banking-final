// src/shared/rpc/client.js: HTTP JSON-RPC 2.0 Client
const { formatRequest } = require('./envelope');
const { createMeta } = require('./meta');
const { RpcError, RpcTimeoutError, RpcNetworkError } = require('../../contracts/errors');
const { physicalClock } = require('../../clocks/physicalClock');
const { lamportClock } = require('../../clocks/lamportClock');

async function callRpc(url, method, params = {}, options = {}) {
  const timeoutMs = options.timeoutMs || parseInt(process.env.RPC_TIMEOUT_MS || '2000', 10);
  const reqId = options.id || `req-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

  const isLivenessCheck = method === 'cluster.heartbeat' || method === 'cluster.ping' || method === 'cluster.getState' || Boolean(options.skipLamportTick);
  // Stamp request with outgoing Lamport clock and Physical clock
  // Send rule: L = L + 1 (for domain events)
  if (!isLivenessCheck) {
    lamportClock.tick();
  }
  const currentLamport = lamportClock.get();
  const currentPhysicalTs = physicalClock.now();

  const reqMeta = (params && params._meta)
    ? {
        ...params._meta,
        lamport: currentLamport,
        physicalTs: currentPhysicalTs
      }
    : createMeta({
        lamport: currentLamport,
        physicalTs: currentPhysicalTs
      });

  const outgoingParams = {
    ...params,
    _meta: reqMeta
  };

  const payload = formatRequest(method, outgoingParams, reqId);

  let targetUrl = url;
  if (!targetUrl.endsWith('/rpc')) {
    targetUrl = targetUrl.replace(/\/+$/, '') + '/rpc';
  }

  // Check partition/isolate faults (PROJECT.md Section 22.2)
  const { faults } = require('../faults');
  if (faults && faults.isEnabled()) {
    const isIsolated = Boolean(faults.getFault('isolate'));
    const isTargetCoordinator = targetUrl.includes('8080') || targetUrl.includes('coordinator');
    if (isIsolated && !isTargetCoordinator && method !== 'cluster.clearFaults') {
      throw new RpcTimeoutError(`RPC request to ${targetUrl} (${method}) dropped due to isolate fault`);
    }
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

  // Update client's Lamport clock upon receiving response
  // Receive rule: L = max(L, msg.lamport) + 1 (for non-liveness events)
  if (!isLivenessCheck) {
    if (body.result && body.result._meta && body.result._meta.lamport !== undefined) {
      lamportClock.update(body.result._meta.lamport);
    } else if (body.error && body.error.data && body.error.data._meta && body.error.data._meta.lamport !== undefined) {
      lamportClock.update(body.error.data._meta.lamport);
    }
  }

  if (body.error) {
    throw new RpcError(body.error.code, body.error.message, body.error.data);
  }

  return body.result;
}

module.exports = {
  callRpc
};
