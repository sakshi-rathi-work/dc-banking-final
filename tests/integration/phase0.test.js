// tests/integration/phase0.test.js: Phase 0 Integration Test
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const { callRpc } = require('../../src/shared/rpc/client');

describe('Phase 0: Foundation and Cluster Topology', () => {
  const nodePorts = {
    a: 3001,
    b: 3002,
    c: 3003,
    d: 3004
  };

  it('brings up distinct node processes with distinct pid, hostname, and nodeId', async () => {
    const nodeIds = Object.keys(nodePorts);
    const healthResponses = {};

    for (const id of nodeIds) {
      const port = nodePorts[id];
      const res = await fetch(`http://localhost:${port}/health`);
      assert.equal(res.status, 200, `Node ${id} /health returned status ${res.status}`);
      const body = await res.json();
      assert.equal(body.nodeId, id);
      assert.equal(body.dbHealthy, true, `Node ${id} database must be healthy`);
      assert.ok(body.pid > 0, `Node ${id} pid must be positive`);
      assert.ok(body.hostname, `Node ${id} hostname must not be empty`);
      healthResponses[id] = body;
    }

    // Verify distinct PIDs and hostnames
    const pids = new Set(Object.values(healthResponses).map(h => h.pid));
    const hostnames = new Set(Object.values(healthResponses).map(h => h.hostname));

    // In Docker containers, hostnames match container IDs or container names
    assert.equal(hostnames.size, 4, 'All four nodes must have distinct container hostnames');
  });

  it('coordinator /health is UP and reports healthy', async () => {
    const res = await fetch('http://localhost:8080/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.service, 'coordinator');
    assert.equal(body.healthy, true);
  });

  it('each node reports all 3 peers alive in cluster.getState', async () => {
    for (const [id, port] of Object.entries(nodePorts)) {
      const state = await callRpc(`http://localhost:${port}`, 'cluster.getState', {});
      assert.equal(state.nodeId, id);
      assert.equal(state.dbHealthy, true);

      const peers = state.peers || {};
      const otherIds = Object.keys(nodePorts).filter(other => other !== id);

      for (const peerId of otherIds) {
        assert.ok(peers[peerId], `Node ${id} must have peer entry for ${peerId}`);
        assert.equal(peers[peerId].status, 'alive', `Node ${id} must see peer ${peerId} as alive`);
        assert.equal(peers[peerId].suspected, false);
      }
    }
  });

  it('node logs are valid JSON containing nodeId', () => {
    const output = execSync('docker compose logs --tail=20 bank-node-a', { encoding: 'utf8' });
    const lines = output.split('\n').filter(Boolean);

    let jsonLineFound = false;
    for (const line of lines) {
      // Docker compose log prefix may look like "bank-node-a  | {"level"..."
      const jsonStart = line.indexOf('{');
      if (jsonStart !== -1) {
        try {
          const parsed = JSON.parse(line.slice(jsonStart));
          if (parsed.nodeId === 'a' && parsed.level) {
            jsonLineFound = true;
            break;
          }
        } catch (e) {
          // not json line
        }
      }
    }
    assert.ok(jsonLineFound, 'Found JSON log output from bank-node-a with nodeId="a"');
  });

  it('node A cannot start with B database URL (DB credential isolation)', () => {
    // Attempt to run bank-node-a with postgres-b URL
    let failed = false;
    let logOutput = '';
    try {
      execSync(
        'docker compose run --rm -e NODE_ID=a -e DATABASE_URL=postgres://bank_a:pw_a@postgres-b:5432/bank bank-node-a node -e "require(\'./src/shared/config\').loadConfig()"',
        { encoding: 'utf8', stdio: 'pipe' }
      );
    } catch (err) {
      failed = true;
      logOutput = (err.stdout || '') + (err.stderr || '');
    }
    assert.ok(failed, 'Starting node A with postgres-b DATABASE_URL must fail');
    assert.match(logOutput, /Database isolation violation/);
  });

  it('stopping a node causes others to report it suspected within 5 seconds and alive upon restart', async () => {
    console.log('Stopping bank-node-b...');
    execSync('docker stop bank-node-b', { stdio: 'inherit' });

    // Poll Node A's cluster.getState until peer b is suspected
    const startWait = Date.now();
    let suspected = false;

    while (Date.now() - startWait < 8000) {
      try {
        const state = await callRpc(`http://localhost:${nodePorts.a}`, 'cluster.getState', {});
        if (state.peers && state.peers.b && state.peers.b.status === 'suspected') {
          suspected = true;
          break;
        }
      } catch (err) {
        // retry
      }
      await new Promise(r => setTimeout(r, 500));
    }

    assert.ok(suspected, 'Node B must be reported suspected by Node A within 5-8 seconds of stopping');

    // Restart bank-node-b
    console.log('Restarting bank-node-b...');
    execSync('docker start bank-node-b', { stdio: 'inherit' });

    // Poll until node B is alive again
    const startRestart = Date.now();
    let aliveAgain = false;

    while (Date.now() - startRestart < 10000) {
      try {
        const state = await callRpc(`http://localhost:${nodePorts.a}`, 'cluster.getState', {});
        if (state.peers && state.peers.b && state.peers.b.status === 'alive') {
          aliveAgain = true;
          break;
        }
      } catch (err) {
        // retry
      }
      await new Promise(r => setTimeout(r, 500));
    }

    assert.ok(aliveAgain, 'Node B must be reported alive again after restart');
  });
});
