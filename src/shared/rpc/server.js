// src/shared/rpc/server.js: JSON-RPC 2.0 Server Router
const express = require('express');
const { formatResponse, formatError, validateRequest } = require('./envelope');
const { extractMeta, appendTrace } = require('./meta');
const { ERROR_CODES, RpcError } = require('../../contracts/errors');
const { logger } = require('../logger');
const { faults } = require('../faults');
const { physicalClock } = require('../../clocks/physicalClock');
const { lamportClock } = require('../../clocks/lamportClock');
const { recordEvent } = require('../events');

class RpcServer {
  constructor() {
    this.methods = new Map();
  }

  register(methodName, handler) {
    if (typeof handler !== 'function') {
      throw new Error(`Handler for method "${methodName}" must be a function`);
    }
    this.methods.set(methodName, handler);
  }

  createMiddleware() {
    const router = express.Router();

    router.post('/rpc', express.json({ limit: '1mb' }), async (req, res) => {
      const startTime = process.hrtime();
      const body = req.body;
      const reqId = body && body.id !== undefined ? body.id : null;

      try {
        validateRequest(body);
      } catch (err) {
        logger.warn({ event: 'rpc.invalid_request', error: err.message, body });
        return res.status(200).json(formatError(reqId, err));
      }

      const { method, params = {}, id } = body;
      const handler = this.methods.get(method);

      if (!handler) {
        logger.warn({ event: 'rpc.method_not_found', method, id });
        return res.status(200).json(
          formatError(id, new RpcError(ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`))
        );
      }

      const meta = extractMeta(params);
      if (meta && meta.lamport !== undefined) {
        // Receive rule: L = max(L, msg.lamport) + 1
        lamportClock.update(meta.lamport);
      }

      if (meta) {
        const [s, ns] = process.hrtime(startTime);
        appendTrace(meta, 'rpc.received', s * 1000 + ns / 1e6);
        const correlationId = (meta && (meta.traceId || meta.requestId)) || reqId;
        recordEvent({
          eventType: 'rpc.received',
          requestId: correlationId,
          peer: meta.from || 'client',
          detail: { method, reqId, traceId: meta.traceId }
        }).catch(() => {});
      }

      try {
        if (method.startsWith('bank.')) {
          const rpcDelay = faults.getFault('rpcDelayMs');
          if (typeof rpcDelay === 'number' && rpcDelay > 0) {
            await new Promise(r => setTimeout(r, rpcDelay));
          }
        }

        const result = await handler(params, meta, req);
        const [s, ns] = process.hrtime(startTime);
        const durationMs = s * 1000 + ns / 1e6;

        // Send response: L = L + 1
        lamportClock.tick();
        const currentLamport = lamportClock.get();
        const currentPhysicalTs = physicalClock.now();

        if (result && typeof result === 'object') {
          const outMeta = result._meta || meta;
          if (outMeta) {
            outMeta.lamport = currentLamport;
            outMeta.physicalTs = currentPhysicalTs;
            appendTrace(outMeta, 'rpc.responded', durationMs);
            result._meta = outMeta;
          }
        }

        logger.debug({ event: 'rpc.success', method, id, durationMs, lamport: currentLamport });
        return res.status(200).json(formatResponse(id, result));
      } catch (err) {
        const [s, ns] = process.hrtime(startTime);
        const durationMs = s * 1000 + ns / 1e6;

        lamportClock.tick();
        const currentLamport = lamportClock.get();
        const currentPhysicalTs = physicalClock.now();

        logger.warn({
          event: 'rpc.error',
          method,
          id,
          code: err.code || -32603,
          message: err.message,
          durationMs,
          lamport: currentLamport
        });

        // Pass meta back in error data if available
        if (meta) {
          meta.lamport = currentLamport;
          meta.physicalTs = currentPhysicalTs;
          appendTrace(meta, 'rpc.error', durationMs);
          if (err instanceof RpcError) {
            err.data = { ...(err.data || {}), _meta: meta };
          } else if (typeof err === 'object' && err !== null) {
            err.data = { ...(err.data || {}), _meta: meta };
          }
        }

        return res.status(200).json(formatError(id, err));
      }
    });

    return router;
  }
}

module.exports = {
  RpcServer
};
