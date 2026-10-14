// src/node/methods/admin.js: Admin and Invariant Verification RPC handlers
const { verifyInvariants, getStateChecksum } = require('../../domain/invariants');

function registerAdminMethods(rpcServer, config) {
  rpcServer.register('admin.verifyInvariants', async () => {
    const report = await verifyInvariants();
    return {
      nodeId: config.nodeId,
      ...report
    };
  });

  rpcServer.register('admin.stateChecksum', async () => {
    const report = await getStateChecksum();
    return {
      nodeId: config.nodeId,
      ...report
    };
  });
}

module.exports = {
  registerAdminMethods
};
