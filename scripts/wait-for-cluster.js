#!/usr/bin/env node
// scripts/wait-for-cluster.js: Waits until coordinator and all 4 nodes are healthy
const { callRpc } = require('../src/shared/rpc/client');

async function waitForCluster() {
  const coordinatorUrl = process.env.COORDINATOR_URL || 'http://localhost:8080';
  const maxAttempts = 60;
  const delayMs = 1000;

  console.log(`Waiting for cluster via coordinator at ${coordinatorUrl}...`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${coordinatorUrl}/health`);
      if (res.ok) {
        const status = await callRpc(coordinatorUrl, 'gateway.clusterStatus', {}, { timeoutMs: 2000 });
        const nodes = status.nodes || {};
        const onlineCount = Object.values(nodes).filter(n => n.online).length;

        if (onlineCount === 4) {
          console.log(`Cluster is ready! All 4 nodes are online.`);
          process.exitCode = 0;
          return;
        } else {
          console.log(`Attempt ${attempt}/${maxAttempts}: ${onlineCount}/4 nodes online...`);
        }
      }
    } catch (err) {
      console.log(`Attempt ${attempt}/${maxAttempts}: coordinator not ready yet (${err.message})...`);
    }

    await new Promise(r => setTimeout(r, delayMs));
  }

  console.error(`Timed out waiting for cluster after ${maxAttempts} attempts.`);
  process.exit(1);
}

waitForCluster();
