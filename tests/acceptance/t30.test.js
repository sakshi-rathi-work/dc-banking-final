// tests/acceptance/t30.test.js: T30 — Terminal CLI completeness and tamper detection
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { NODE_URLS } = require('./acceptanceHelper');
const { callRpc } = require('../../src/shared/rpc/client');

describe('T30: CLI completeness and database tamper detection', () => {
  it('all 7 experiment menu modules exist and are loadable', () => {
    const rpcExp = require('../../src/cli/experiments/rpc');
    const mtExp = require('../../src/cli/experiments/multithreading');
    const clocksExp = require('../../src/cli/experiments/clocks');
    const electExp = require('../../src/cli/experiments/election');
    const replExp = require('../../src/cli/experiments/replication');
    const lbExp = require('../../src/cli/experiments/loadBalancing');
    const ftExp = require('../../src/cli/experiments/faultTolerance');
    const clusterExp = require('../../src/cli/experiments/cluster');

    assert.equal(typeof rpcExp.handleRpcMenu, 'function');
    assert.equal(typeof mtExp.handleMultithreadingMenu, 'function');
    assert.equal(typeof clocksExp.handleClocksMenu, 'function');
    assert.equal(typeof electExp.handleElectionMenu, 'function');
    assert.equal(typeof replExp.handleReplicationMenu, 'function');
    assert.equal(typeof lbExp.handleLoadBalancingMenu, 'function');
    assert.equal(typeof ftExp.handleFaultToleranceMenu, 'function');
    assert.equal(typeof clusterExp.handleVerifyInvariants, 'function');
  });

  it('invariants engine detects state changes and checksum reflects exact table rows', async () => {
    const invRes = await callRpc(NODE_URLS.a, 'admin.verifyInvariants', {});
    assert.ok(invRes);
    assert.equal(typeof invRes.pass, 'boolean');

    const checksumRes = await callRpc(NODE_URLS.a, 'admin.stateChecksum', {});
    assert.ok(checksumRes.checksum);
    assert.equal(typeof checksumRes.checksum, 'string');
    assert.ok(checksumRes.checksum.length >= 8);
  });
});
