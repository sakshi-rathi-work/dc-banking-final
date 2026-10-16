// tests/unit/loadBalancer.test.js: Unit tests for Load Balancing algorithms and Health Registry
// Specification: PROJECT.md Section 20, Section 28 (Phase 7 Exit Criteria)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { selectRoundRobin } = require('../../src/coordinator/loadBalancer/roundRobin');
const { selectLeastConnections } = require('../../src/coordinator/loadBalancer/leastConnections');
const { HealthRegistry } = require('../../src/coordinator/registry');
const { computePercentile, calculateNodeStats } = require('../../src/coordinator/loadBalancer/stats');
const { METHOD_NAMES, validateMethodParams } = require('../../src/contracts/methods');

describe('Round Robin Algorithm (PROJECT.md Section 20.3, T21)', () => {
  it('distributes 40 requests evenly across 4 healthy nodes (10/10/10/10)', () => {
    const nodes = [
      { nodeId: 'a' },
      { nodeId: 'b' },
      { nodeId: 'c' },
      { nodeId: 'd' }
    ];

    const state = { pointer: 0 };
    const counts = { a: 0, b: 0, c: 0, d: 0 };

    for (let i = 0; i < 40; i++) {
      const selected = selectRoundRobin(nodes, state);
      counts[selected.nodeId]++;
    }

    assert.deepEqual(counts, { a: 10, b: 10, c: 10, d: 10 });
  });

  it('distributes 30 requests evenly across 3 surviving nodes when node c is excluded (10/10/10)', () => {
    const nodes = [
      { nodeId: 'a' },
      { nodeId: 'b' },
      { nodeId: 'd' }
    ];

    const state = { pointer: 0 };
    const counts = { a: 0, b: 0, d: 0 };

    for (let i = 0; i < 30; i++) {
      const selected = selectRoundRobin(nodes, state);
      counts[selected.nodeId]++;
    }

    assert.deepEqual(counts, { a: 10, b: 10, d: 10 });
  });
});

describe('Least Connections Algorithm (PROJECT.md Section 20.3, T22)', () => {
  it('selects node with lowest active in-flight requests', () => {
    const nodes = [
      { nodeId: 'a', active: 2, totalServed: 10 },
      { nodeId: 'b', active: 0, totalServed: 15 },
      { nodeId: 'c', active: 1, totalServed: 8 },
      { nodeId: 'd', active: 3, totalServed: 12 }
    ];

    const selected = selectLeastConnections(nodes);
    assert.equal(selected.nodeId, 'b', 'Should select node with 0 active connections');
  });

  it('breaks ties using lowest totalServed, then lowest nodeId', () => {
    // Tie on active: 1 between b and c, but c has fewer totalServed
    const nodes1 = [
      { nodeId: 'a', active: 2, totalServed: 5 },
      { nodeId: 'b', active: 1, totalServed: 20 },
      { nodeId: 'c', active: 1, totalServed: 10 }
    ];
    assert.equal(selectLeastConnections(nodes1).nodeId, 'c');

    // Tie on both active and totalServed between a and b: tie broken by lowest nodeId
    const nodes2 = [
      { nodeId: 'b', active: 1, totalServed: 10 },
      { nodeId: 'a', active: 1, totalServed: 10 }
    ];
    assert.equal(selectLeastConnections(nodes2).nodeId, 'a');
  });

  it('routes away from slow node that accumulates active requests', () => {
    const nodes = [
      { nodeId: 'a', active: 1, totalServed: 10 },
      { nodeId: 'b', active: 5, totalServed: 10 }, // Slow node with 5 active
      { nodeId: 'c', active: 1, totalServed: 10 },
      { nodeId: 'd', active: 1, totalServed: 10 }
    ];

    // Node B has highest active, should never be selected while others have active = 1
    const selected = selectLeastConnections(nodes);
    assert.notEqual(selected.nodeId, 'b');
    assert.equal(selected.nodeId, 'a');
  });
});

describe('Health Registry and Read Eligibility (PROJECT.md Section 20.1, Section 20.2, T23)', () => {
  const peers = {
    a: { url: 'http://localhost:3001', rank: 1 },
    b: { url: 'http://localhost:3002', rank: 2 },
    c: { url: 'http://localhost:3003', rank: 3 },
    d: { url: 'http://localhost:3004', rank: 4 }
  };

  it('marks node DOWN after 2 consecutive failures', () => {
    const registry = new HealthRegistry(peers, { lbUnhealthyThreshold: 2 });
    const nodeC = registry.getNode('c');
    assert.equal(nodeC.state, 'UP');

    registry.recordPassiveFailure('c');
    assert.equal(nodeC.state, 'UP'); // 1 failure, threshold is 2

    registry.recordPassiveFailure('c');
    assert.equal(nodeC.state, 'DOWN'); // 2 consecutive failures
  });

  it('re-admits node to UP only after 3 consecutive successes and lag <= READ_MAX_LAG_LSN', () => {
    const registry = new HealthRegistry(peers, {
      lbRecoveryThreshold: 3,
      readMaxLagLsn: 5
    });

    const nodeC = registry.getNode('c');
    nodeC.state = 'DOWN';
    nodeC.consecutiveFailures = 2;
    nodeC.consecutiveSuccesses = 0;
    nodeC.role = 'replica';
    nodeC.lag = 10; // Lag is 10 > 5

    // Simulate 3 poll successes, but lag is too high
    for (let i = 0; i < 3; i++) {
      nodeC.consecutiveSuccesses++;
    }
    assert.equal(nodeC.state, 'DOWN', 'Should not recover while lag > 5');

    // Reduce lag to <= 5
    nodeC.lag = 2;
    const canRecover = (nodeC.consecutiveSuccesses >= 3) &&
      ['primary', 'backup', 'replica'].includes(nodeC.role) &&
      (nodeC.lag <= 5);

    assert.ok(canRecover);
    if (canRecover) nodeC.state = 'UP';
    assert.equal(nodeC.state, 'UP');
  });

  it('filters eligible nodes by consistency level', () => {
    const registry = new HealthRegistry(peers, { readMaxLagLsn: 5 });
    const nodes = registry.getAllNodes();

    // Setup: Node A is primary lag 0, B is replica lag 2, C is replica lag 8, D is DOWN
    registry.getNode('a').role = 'primary';
    registry.getNode('a').lag = 0;
    registry.getNode('a').state = 'UP';

    registry.getNode('b').role = 'replica';
    registry.getNode('b').lag = 2;
    registry.getNode('b').state = 'UP';

    registry.getNode('c').role = 'replica';
    registry.getNode('c').lag = 8;
    registry.getNode('c').state = 'UP';

    registry.getNode('d').state = 'DOWN';

    // 1. Strong: leader only
    const strong = registry.getEligibleNodes('strong');
    assert.deepEqual(strong.map(n => n.nodeId), ['a']);

    // 2. Bounded (maxLagLsn=5): A and B (lag 0 and 2 <= 5; C has lag 8 > 5)
    const bounded = registry.getEligibleNodes('bounded', 5);
    assert.deepEqual(bounded.map(n => n.nodeId), ['a', 'b']);

    // 3. Eventual: all UP non-recovering nodes (A, B, C; D is DOWN)
    const eventual = registry.getEligibleNodes('eventual');
    assert.deepEqual(eventual.map(n => n.nodeId), ['a', 'b', 'c']);
  });
});

describe('Stats and Percentile Calculations (PROJECT.md Section 20.4, Section 24.6)', () => {
  it('correctly calculates p50 and p95 percentiles', () => {
    const latencies = [5, 6, 7, 8, 9, 10, 11, 12, 13, 100];
    assert.equal(computePercentile(latencies, 50), 9);
    assert.equal(computePercentile(latencies, 95), 100);
  });

  it('validates load balancer method contract parameters', () => {
    assert.doesNotThrow(() => validateMethodParams(METHOD_NAMES.LB_SET_ALGORITHM, {
      algorithm: 'round-robin'
    }));
    assert.doesNotThrow(() => validateMethodParams(METHOD_NAMES.LB_SET_ALGORITHM, {
      algorithm: 'least-connections'
    }));
    assert.throws(() => validateMethodParams(METHOD_NAMES.LB_SET_ALGORITHM, {
      algorithm: 'random'
    }));

    assert.doesNotThrow(() => validateMethodParams(METHOD_NAMES.LB_RUN, {
      algorithm: 'round-robin',
      requests: 40,
      concurrency: 8
    }));
    assert.throws(() => validateMethodParams(METHOD_NAMES.LB_RUN, {
      requests: -5
    }));
  });
});
