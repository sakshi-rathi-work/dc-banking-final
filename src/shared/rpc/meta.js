// src/shared/rpc/meta.js: Metadata and distributed tracing utilities
const crypto = require('crypto');

function createMeta(options = {}) {
  return {
    from: options.from || process.env.NODE_ID || 'coordinator',
    traceId: options.traceId || `trc-${crypto.randomUUID().slice(0, 8)}`,
    lamport: options.lamport || 0,
    physicalTs: options.physicalTs || Date.now(),
    epoch: options.epoch !== undefined ? options.epoch : 0,
    trace: options.trace ? [...options.trace] : []
  };
}

function extractMeta(params) {
  if (params && typeof params === 'object' && params._meta) {
    return params._meta;
  }
  return null;
}

function appendTrace(meta, eventName, dtMs = 0, nodeOverride = null) {
  if (!meta) return;
  if (!meta.trace) meta.trace = [];
  const node = nodeOverride || (process.env.NODE_ID ? `node-${process.env.NODE_ID}` : 'coordinator');
  meta.trace.push({
    node,
    event: eventName,
    lamport: meta.lamport || 0,
    dtMs: Math.round(dtMs * 100) / 100
  });
}

module.exports = {
  createMeta,
  extractMeta,
  appendTrace
};
