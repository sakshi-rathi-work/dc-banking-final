// src/coordinator/gateway.js: Gateway routing, timeouts, retries, and trace merging
const { callRpc } = require('../shared/rpc/client');
const { validateMethodParams } = require('../contracts/methods');
const { RpcError, RpcTimeoutError, RpcNetworkError, ERROR_CODES } = require('../contracts/errors');
const { createMeta, appendTrace } = require('../shared/rpc/meta');
const { logger } = require('../shared/logger');

const MUTATING_METHODS = new Set([
  'bank.createAccount',
  'bank.deposit',
  'bank.withdraw',
  'bank.transfer'
]);

class Gateway {
  constructor(leaderTracker, config) {
    this.leaderTracker = leaderTracker;
    this.config = config;
    this.maxWriteRetries = 3;
  }

  async handleCall(method, params = {}, incomingMeta = null) {
    const startTime = process.hrtime();

    // 1. Validate contract parameters upfront before any network or DB calls
    validateMethodParams(method, params);

    // 2. Initialize or propagate metadata
    const meta = incomingMeta ? { ...incomingMeta, trace: [...(incomingMeta.trace || [])] } : createMeta();
    if (!meta.trace.some(t => t.node === 'coordinator' && t.event.includes('received'))) {
      appendTrace(meta, 'coordinator.received', 0);
    }

    const isMutating = MUTATING_METHODS.has(method);

    if (isMutating) {
      return this.routeWriteWithRetry(method, params, meta, startTime);
    } else {
      return this.routeRead(method, params, meta, startTime);
    }
  }

  async routeWriteWithRetry(method, params, meta, startTime) {
    let attempts = 0;
    let lastError = null;

    while (attempts < this.maxWriteRetries) {
      attempts++;
      let leader;

      try {
        const [s0, ns0] = process.hrtime(startTime);
        appendTrace(meta, 'coordinator.resolving_leader', s0 * 1000 + ns0 / 1e6);
        leader = await this.leaderTracker.getLeader(this.config.leaderWaitMs || 15000);
      } catch (err) {
        throw err;
      }

      meta.epoch = leader.epoch;
      const targetParams = { ...params, _meta: meta };

      const [s1, ns1] = process.hrtime(startTime);
      appendTrace(meta, `coordinator.forwarding -> node-${leader.nodeId}`, s1 * 1000 + ns1 / 1e6, 'coordinator');

      try {
        const result = await callRpc(leader.url, method, targetParams, {
          timeoutMs: this.config.rpcTimeoutMs || 2000
        });

        const [s2, ns2] = process.hrtime(startTime);
        const resMeta = (result && result._meta) ? result._meta : meta;
        appendTrace(resMeta, `coordinator.received_reply <- node-${leader.nodeId}`, s2 * 1000 + ns2 / 1e6, 'coordinator');
        if (result) {
          result._meta = resMeta;
        }

        return result;
      } catch (err) {
        lastError = err;

        if (err.data && err.data._meta) {
          const [se, nse] = process.hrtime(startTime);
          appendTrace(err.data._meta, `coordinator.received_error <- node-${leader.nodeId}`, se * 1000 + nse / 1e6, 'coordinator');
        }

        // If NOT_PRIMARY or STALE_LEADER or Network Error or Timeout: re-resolve leader and retry with same key
        const isNotPrimary = err instanceof RpcError && (err.code === ERROR_CODES.NOT_PRIMARY || err.code === ERROR_CODES.STALE_LEADER);
        const isNetworkErr = err instanceof RpcNetworkError;
        const isTimeout = err instanceof RpcTimeoutError;

        if (isTimeout) {
          const [st, nst] = process.hrtime(startTime);
          appendTrace(meta, `coordinator.timeout <- node-${leader.nodeId}`, st * 1000 + nst / 1e6, 'coordinator');
        } else if (isNetworkErr) {
          const [sn, nsn] = process.hrtime(startTime);
          appendTrace(meta, `coordinator.network_error <- node-${leader.nodeId}`, sn * 1000 + nsn / 1e6, 'coordinator');
        }

        if ((isNotPrimary || isNetworkErr || isTimeout) && attempts < this.maxWriteRetries) {
          logger.warn({
            event: 'coordinator.write_retry',
            attempt: attempts,
            failedNode: leader.nodeId,
            reason: err.message
          });

          this.leaderTracker.invalidateLeader();
          const [sr, nsr] = process.hrtime(startTime);
          appendTrace(meta, `coordinator.retry_attempt_${attempts}`, sr * 1000 + nsr / 1e6, 'coordinator');
          await new Promise(r => setTimeout(r, 200));
          continue;
        }

        throw err;
      }
    }

    throw lastError || new RpcError(ERROR_CODES.INTERNAL_ERROR, 'Write failed after maximum retry attempts');
  }

  async routeRead(method, params, meta, startTime) {
    let targetNode;
    try {
      targetNode = await this.leaderTracker.getLeader(2000);
    } catch (e) {
      targetNode = Object.values(this.config.peers)[0];
    }

    const [s1, ns1] = process.hrtime(startTime);
    appendTrace(meta, `coordinator.forwarding_read -> node-${targetNode.nodeId}`, s1 * 1000 + ns1 / 1e6, 'coordinator');

    const targetParams = { ...params, _meta: meta };
    const result = await callRpc(targetNode.url, method, targetParams, {
      timeoutMs: this.config.rpcTimeoutMs || 2000
    });

    const [s2, ns2] = process.hrtime(startTime);
    const resMeta = (result && result._meta) ? result._meta : meta;
    appendTrace(resMeta, `coordinator.received_reply <- node-${targetNode.nodeId}`, s2 * 1000 + ns2 / 1e6, 'coordinator');
    if (result) {
      result._meta = resMeta;
    }

    return result;
  }
}

module.exports = {
  Gateway
};
