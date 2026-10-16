// src/coordinator/loadBalancer/index.js: Coordinator Load Balancer Manager
// Specification: PROJECT.md Section 20.3, Section 20.4, Section 24.6, Section 28 (Phase 7)
const { selectRoundRobin } = require('./roundRobin');
const { selectLeastConnections } = require('./leastConnections');
const { calculateNodeStats } = require('./stats');
const { callRpc } = require('../../shared/rpc/client');
const { RpcError, RpcTimeoutError, RpcNetworkError, ERROR_CODES } = require('../../contracts/errors');
const { appendTrace } = require('../../shared/rpc/meta');
const { recordEvent } = require('../../shared/events');
const { logger } = require('../../shared/logger');

class LoadBalancer {
  constructor(registry, config = {}) {
    this.registry = registry;
    this.config = config;
    this.algorithm = (config.lbAlgorithm || 'round-robin').toLowerCase();
    this.rrState = { pointer: 0 };
    this.decisionSeq = 0;
  }

  setAlgorithm(algorithm) {
    const norm = (algorithm || '').toLowerCase();
    if (!['round-robin', 'least-connections'].includes(norm)) {
      throw new RpcError(ERROR_CODES.INVALID_PARAMS, `Invalid load balancing algorithm: ${algorithm}`);
    }
    this.algorithm = norm;
    return { algorithm: this.algorithm };
  }

  getAlgorithm() {
    return this.algorithm;
  }

  selectNode(eligibleNodes, algorithm = this.algorithm) {
    if (algorithm === 'least-connections') {
      return selectLeastConnections(eligibleNodes);
    } else {
      return selectRoundRobin(eligibleNodes, this.rrState);
    }
  }

  /**
   * Execute a read operation via load balanced routing with automatic retries.
   */
  async executeRead(method, params, meta, startTime) {
    const consistency = params.consistency || 'eventual';
    const maxLagLsn = params.maxLagLsn;
    const maxRetries = 2; // Up to 2 retries (3 attempts total)
    const failedNodesThisCall = new Set();
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      let eligible = this.registry.getEligibleNodes(consistency, maxLagLsn);

      // Exclude nodes that failed on prior attempts of this same request
      let pool = eligible.filter(n => !failedNodesThisCall.has(n.nodeId));
      if (pool.length === 0) {
        pool = eligible; // Fallback if all eligible nodes failed
      }

      const selectedNode = this.selectNode(pool, this.algorithm);
      const activeSnapshot = Object.fromEntries(
        eligible.map(n => [n.nodeId, n.active])
      );

      const [s1, ns1] = process.hrtime(startTime);
      appendTrace(
        meta,
        `coordinator.forwarding_read(${this.algorithm}) -> node-${selectedNode.nodeId} (attempt ${attempt})`,
        s1 * 1000 + ns1 / 1e6,
        'coordinator'
      );

      this.registry.recordRequestStart(selectedNode.nodeId);
      const hopStart = Date.now();
      let hopSuccess = false;

      try {
        const targetParams = { ...params, _meta: meta };
        const result = await callRpc(selectedNode.url, method, targetParams, {
          timeoutMs: this.config.rpcTimeoutMs || 2000
        });

        hopSuccess = true;
        const hopLatencyMs = Date.now() - hopStart;
        this.registry.recordRequestEnd(selectedNode.nodeId, hopLatencyMs, true);

        // Record decision log
        await this.recordDecisionLog({
          requestId: meta.traceId || null,
          op: method,
          algorithm: this.algorithm,
          eligible: eligible.map(n => n.nodeId),
          activeSnapshot,
          selected: selectedNode.nodeId,
          attempt,
          status: 'SUCCESS',
          latencyMs: hopLatencyMs
        });

        const [s2, ns2] = process.hrtime(startTime);
        const resMeta = (result && result._meta) ? result._meta : meta;
        appendTrace(
          resMeta,
          `coordinator.received_reply <- node-${selectedNode.nodeId}`,
          s2 * 1000 + ns2 / 1e6,
          'coordinator'
        );

        if (result) {
          result._meta = resMeta;
        }

        return result;
      } catch (err) {
        lastError = err;
        const hopLatencyMs = Date.now() - hopStart;
        this.registry.recordRequestEnd(selectedNode.nodeId, hopLatencyMs, false);

        failedNodesThisCall.add(selectedNode.nodeId);
        this.registry.recordPassiveFailure(selectedNode.nodeId);

        // Record decision log for failed attempt
        await this.recordDecisionLog({
          requestId: meta.traceId || null,
          op: method,
          algorithm: this.algorithm,
          eligible: eligible.map(n => n.nodeId),
          activeSnapshot,
          selected: selectedNode.nodeId,
          attempt,
          status: 'FAILED',
          latencyMs: hopLatencyMs,
          error: err.message
        });

        // Determine if retryable: network error, timeout, or NODE_RECOVERING
        const isNetworkErr = err instanceof RpcNetworkError;
        const isTimeout = err instanceof RpcTimeoutError;
        const isRecovering = err instanceof RpcError && err.code === ERROR_CODES.NODE_RECOVERING;

        if ((isNetworkErr || isTimeout || isRecovering) && attempt <= maxRetries) {
          this.registry.recordRetry(selectedNode.nodeId);
          logger.warn({
            event: 'coordinator.read_retry',
            attempt,
            failedNode: selectedNode.nodeId,
            reason: err.message
          });

          const [sr, nsr] = process.hrtime(startTime);
          appendTrace(
            meta,
            `coordinator.read_retry_attempt_${attempt} -> failover_next`,
            sr * 1000 + nsr / 1e6,
            'coordinator'
          );

          continue;
        }

        throw err;
      }
    }

    throw lastError || new RpcError(ERROR_CODES.INTERNAL_ERROR, 'Read failed after maximum retry attempts');
  }

  async recordDecisionLog(decision) {
    this.decisionSeq++;
    const seq = this.decisionSeq;

    logger.debug({
      event: 'lb.decision',
      seq,
      ...decision
    });

    try {
      await recordEvent({
        eventType: 'lb.decision',
        detail: { seq, ...decision }
      });
    } catch (_) {
      // Non-fatal if event_log unavailable
    }
  }

  /**
   * Run a real load test against the cluster.
   * Specification: PROJECT.md Section 20.4, Section 24.6
   */
  async runLoadTest({
    algorithm = this.algorithm,
    requests = 40,
    concurrency = 8,
    consistency = 'eventual',
    accountId = 'ACC-0001'
  } = {}) {
    this.setAlgorithm(algorithm);
    this.registry.resetStats();

    logger.info({
      event: 'lb.load_test_started',
      algorithm,
      requests,
      concurrency,
      consistency
    });

    let completed = 0;
    const taskQueue = Array.from({ length: requests }, (_, idx) => idx + 1);

    const worker = async () => {
      while (taskQueue.length > 0) {
        const taskId = taskQueue.shift();
        if (taskId === undefined) break;

        const startTime = process.hrtime();
        const meta = {
          from: 'coordinator',
          traceId: `lb-test-${Date.now()}-${taskId}`,
          trace: []
        };

        try {
          await this.executeRead('bank.getBalance', {
            accountId,
            consistency
          }, meta, startTime);
        } catch (err) {
          logger.debug({ event: 'lb.load_test_call_error', taskId, error: err.message });
        } finally {
          completed++;
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, requests) },
      () => worker()
    );

    await Promise.all(workers);

    const stats = this.getStats();
    logger.info({
      event: 'lb.load_test_finished',
      algorithm,
      totalRequests: stats.totalRequests,
      nodes: stats.nodes
    });

    return stats;
  }

  getStats() {
    return calculateNodeStats(this.registry.nodeStates, this.algorithm);
  }
}

module.exports = {
  LoadBalancer
};
