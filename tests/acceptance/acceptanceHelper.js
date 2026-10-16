// tests/acceptance/acceptanceHelper.js: Shared utilities for T01-T30 acceptance tests
const { callRpc } = require('../../src/shared/rpc/client');

const COORDINATOR_URL = process.env.COORDINATOR_URL || 'http://localhost:8080';
const NODE_URLS = {
  a: process.env.NODE_A_URL || 'http://localhost:3001',
  b: process.env.NODE_B_URL || 'http://localhost:3002',
  c: process.env.NODE_C_URL || 'http://localhost:3003',
  d: process.env.NODE_D_URL || 'http://localhost:3004'
};

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function clearAllFaults() {
  for (const [nodeId, url] of Object.entries(NODE_URLS)) {
    try {
      await callRpc(url, 'cluster.clearFaults', {}, { timeoutMs: 1500 });
    } catch (_) {}
  }
}

async function findCurrentLeader() {
  for (const [nodeId, url] of Object.entries(NODE_URLS)) {
    try {
      const state = await callRpc(url, 'cluster.getState', {}, { timeoutMs: 1500 });
      if (state && state.role === 'primary') {
        return { nodeId, url, epoch: state.epoch };
      }
    } catch (_) {}
  }
  return { nodeId: 'a', url: NODE_URLS.a, epoch: 1 };
}

async function waitForCondition(fn, timeoutMs = 15000, intervalMs = 500) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fn();
      if (res) return res;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Condition timed out after ${timeoutMs}ms${lastErr ? ': ' + lastErr.message : ''}`);
}

module.exports = {
  COORDINATOR_URL,
  NODE_URLS,
  sleep,
  clearAllFaults,
  findCurrentLeader,
  waitForCondition
};
