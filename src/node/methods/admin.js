// src/node/methods/admin.js: Admin, Reset, and Invariant Verification RPC handlers
const { verifyInvariants, getStateChecksum } = require('../../domain/invariants');
const { query } = require('../../shared/db/pool');
const { faults } = require('../../shared/faults');
const { RpcError, ERROR_CODES } = require('../../contracts/errors');

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

  // admin.getEvents (PROJECT.md Section 13.3)
  rpcServer.register('admin.getEvents', async (params) => {
    const limit = params && params.limit ? Number(params.limit) : 50;
    const requestId = params && params.requestId;

    let res;
    if (requestId) {
      res = await query(`
        SELECT id, ts, physical_ts, lamport, event_type, request_id, txn_id, peer, detail
        FROM event_log
        WHERE request_id = $1
        ORDER BY id ASC
        LIMIT $2;
      `, [requestId, limit]);
    } else {
      res = await query(`
        SELECT id, ts, physical_ts, lamport, event_type, request_id, txn_id, peer, detail
        FROM event_log
        ORDER BY id DESC
        LIMIT $1;
      `, [limit]);
    }

    return {
      nodeId: config.nodeId,
      events: res.rows
    };
  });

  // admin.reset (PROJECT.md Section 23.2, Section 30)
  rpcServer.register('admin.reset', async () => {
    // 1. Truncate application data tables
    await query(`
      TRUNCATE TABLE
        ledger_entries,
        transactions,
        idempotency_keys,
        accounts,
        replication_log,
        replication_peer_state,
        replication_errors,
        divergent_log,
        election_log,
        event_log
      CASCADE;
    `);

    // Reset Lamport logical clock to 0
    const { lamportClock } = require('../../clocks/lamportClock');
    lamportClock.set(0);

    // 2. Reset node_state to fresh bootstrap epoch 1
    const role = (config.nodeId === 'a') ? 'primary' : (config.nodeId === 'b' ? 'backup' : 'replica');
    await query(`
      UPDATE node_state SET
        role = $1,
        epoch = 1,
        promised_epoch = 1,
        leader_id = 'a',
        backup_id = 'b',
        last_lsn = 0,
        last_epoch = 0,
        last_hash = '',
        durable_lsn = 0,
        replication_mode = 'ASYNC',
        sync_acks = 2,
        updated_at = now()
      WHERE id = 1;
    `, [role]);

    // 3. Clear faults and reset cluster_nodes suspected flags
    faults.clearFaults();
    await query('UPDATE cluster_nodes SET suspected = false, last_seen_at = now();');

    // 4. Re-initialize LeaderReplicator if running on primary, or stop on non-primary
    const { getLeaderReplicator } = require('../../replication/leaderReplicator');
    const repl = getLeaderReplicator();
    if (repl) {
      if (role === 'primary') {
        await repl.init();
        repl.start();
      } else {
        repl.stop();
      }
    }

    return {
      reset: true,
      nodeId: config.nodeId,
      role,
      epoch: 1
    };
  });

  // admin.crash (PROJECT.md Section 22.2)
  rpcServer.register('admin.crash', async () => {
    if (!faults.isEnabled()) {
      throw new RpcError(ERROR_CODES.INVALID_REQUEST, 'Fault injection is disabled');
    }
    setTimeout(() => {
      process.exit(1);
    }, 50);
    return { crashing: true, nodeId: config.nodeId };
  });
}

module.exports = {
  registerAdminMethods
};
