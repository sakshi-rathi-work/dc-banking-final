// src/shared/rpc/server.js: JSON-RPC 2.0 Server Router
const express = require('express');
const { formatResponse, formatError, validateRequest } = require('./envelope');
const { extractMeta, appendTrace } = require('./meta');
const { ERROR_CODES, RpcError } = require('../../contracts/errors');
const { logger } = require('../logger');

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
      if (meta) {
        const [s, ns] = process.hrtime(startTime);
        appendTrace(meta, 'rpc.received', s * 1000 + ns / 1e6);
      }

      try {
        const result = await handler(params, meta, req);
        const [s, ns] = process.hrtime(startTime);
        const durationMs = s * 1000 + ns / 1e6;

        if (result && typeof result === 'object' && meta && !result._meta) {
          appendTrace(meta, 'rpc.responded', durationMs);
          result._meta = meta;
        }

        logger.debug({ event: 'rpc.success', method, id, durationMs });
        return res.status(200).json(formatResponse(id, result));
      } catch (err) {
        const [s, ns] = process.hrtime(startTime);
        const durationMs = s * 1000 + ns / 1e6;

        logger.warn({
          event: 'rpc.error',
          method,
          id,
          code: err.code || -32603,
          message: err.message,
          durationMs
        });

        // Pass meta back in error data if available
        if (meta && err instanceof RpcError) {
          err.data = { ...(err.data || {}), _meta: meta };
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
