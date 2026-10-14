// tests/unit/rpc.test.js: Unit tests for JSON-RPC 2.0 envelope and errors
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatRequest, formatResponse, formatError, validateRequest } = require('../../src/shared/rpc/envelope');
const { ERROR_CODES, RpcError } = require('../../src/contracts/errors');

describe('JSON-RPC 2.0 Envelope and Formatting', () => {
  it('formats requests correctly', () => {
    const req = formatRequest('cluster.ping', { foo: 'bar' }, 'test-1');
    assert.equal(req.jsonrpc, '2.0');
    assert.equal(req.method, 'cluster.ping');
    assert.deepEqual(req.params, { foo: 'bar' });
    assert.equal(req.id, 'test-1');
  });

  it('formats responses correctly', () => {
    const res = formatResponse('test-1', { pong: true });
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, 'test-1');
    assert.deepEqual(res.result, { pong: true });
  });

  it('formats errors correctly with code and message', () => {
    const err = new RpcError(ERROR_CODES.NOT_PRIMARY, 'Not the primary leader', { leaderHint: 'a' });
    const formatted = formatError('test-1', err);

    assert.equal(formatted.jsonrpc, '2.0');
    assert.equal(formatted.id, 'test-1');
    assert.equal(formatted.error.code, -32005);
    assert.equal(formatted.error.message, 'Not the primary leader');
    assert.deepEqual(formatted.error.data, { leaderHint: 'a' });
  });

  it('validates request envelope strictly', () => {
    assert.throws(() => validateRequest(null), /Request must be a JSON object/);
    assert.throws(() => validateRequest('string'), /Request must be a JSON object/);
    assert.throws(() => validateRequest({ method: 'ping' }), /Invalid JSON-RPC version/);
    assert.throws(() => validateRequest({ jsonrpc: '2.0', method: '' }), /Method name must be a non-empty string/);
    assert.throws(() => validateRequest({ jsonrpc: '2.0', method: 'ping', params: 123 }), /Params must be an object or array/);
    assert.doesNotThrow(() => validateRequest({ jsonrpc: '2.0', method: 'ping', params: {} }));
  });
});
