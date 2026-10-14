// src/cli/index.js: Terminal CLI Entry Point
const { callRpc } = require('../shared/rpc/client');
const { loadConfig } = require('../shared/config');

async function main() {
  const config = loadConfig();
  console.log('=========================================');
  console.log('       DISTRIBUTED BANKING SYSTEM        ');
  console.log('=========================================');

  try {
    const status = await callRpc(config.coordinatorUrl, 'gateway.clusterStatus', {});
    console.log('Coordinator status:', status.coordinator.status);
    console.log('Nodes detected:');
    for (const [nodeId, info] of Object.entries(status.nodes)) {
      console.log(`  Node ${nodeId.toUpperCase()}: ${info.online ? `ONLINE (role=${info.role}, epoch=${info.epoch})` : `OFFLINE (${info.error})`}`);
    }
  } catch (err) {
    console.log(`Unable to reach coordinator at ${config.coordinatorUrl}: ${err.message}`);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('CLI error:', err);
    process.exit(1);
  });
}

module.exports = { main };
