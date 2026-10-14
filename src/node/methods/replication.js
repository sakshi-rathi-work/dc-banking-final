// src/node/methods/replication.js: JSON-RPC replication endpoints
// Specification: PROJECT.md Section 13.3, Section 19

const { handleAppend, getFollowerDuplicates } = require('../../replication/follower');
const { getLeaderReplicator } = require('../../replication/leaderReplicator');
const { getNodeState, updateNodeState } = require('../state');
const { query, getPool } = require('../../shared/db/pool');
const { getStateChecksum } = require('../../domain/invariants');
const { writeLogEntry } = require('../../txn/logWriter');
const { faults } = require('../../shared/faults');
const { RpcError, ERROR_CODES } = require('../../contracts/errors');

function registerReplicationMethods(rpcServer, config) {
  // 1. Follower inbound replication.append
  rpcServer.register('replication.append', async (params, meta) => {
    return handleAppend(params, meta);
  });

  // 2. Fetch missing entries (used in catch-up and gap resolution)
  rpcServer.register('replication.fetch', async (params) => {
    if (faults.getFault('blockFetch')) {
      throw new RpcError(ERROR_CODES.INTERNAL_ERROR, 'replication.fetch blocked by fault injection');
    }

    const fromLsn = Number(params.fromLsn || 0);
    const toLsn = params.toLsn !== undefined ? Number(params.toLsn) : fromLsn + 100;

    const res = await query(`
      SELECT lsn, epoch, entry_type, txn_id, payload, prev_hash, entry_hash, origin_node, lamport, physical_ts, committed_at
      FROM replication_log
      WHERE lsn >= $1 AND lsn <= $2
      ORDER BY lsn ASC
      LIMIT 500;
    `, [fromLsn, toLsn]);

    return {
      entries: res.rows.map(r => ({
        lsn: Number(r.lsn),
        epoch: r.epoch,
        entryType: r.entry_type,
        txnId: r.txn_id,
        payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
        prevHash: r.prev_hash,
        entryHash: r.entry_hash,
        originNode: r.origin_node,
        lamport: Number(r.lamport),
        physicalTs: Number(r.physical_ts),
        committedAt: r.committed_at
      }))
    };
  });

  // 3. Binary search hash lookup at specific LSN
  rpcServer.register('replication.hashAt', async (params) => {
    const lsn = Number(params.lsn);
    const res = await query('SELECT entry_hash FROM replication_log WHERE lsn = $1;', [lsn]);
    return {
      lsn,
      entryHash: res.rows.length > 0 ? res.rows[0].entry_hash : null
    };
  });

  // 4. Local node replication status
  rpcServer.register('replication.status', async () => {
    const state = await getNodeState();
    const csObj = await getStateChecksum();
    const checksum = csObj.checksum;

    const dupRes = await query('SELECT COALESCE(SUM(duplicates), 0) AS total_duplicates FROM replication_peer_state;');
    const totalDuplicates = Number(dupRes.rows[0]?.total_duplicates || 0) + getFollowerDuplicates();

    return {
      nodeId: state.node_id,
      role: state.role,
      epoch: state.epoch,
      appliedLsn: Number(state.last_lsn),
      lastHash: state.last_hash,
      durableLsn: Number(state.durable_lsn),
      replicationMode: state.replication_mode,
      syncAcks: state.sync_acks,
      backupId: state.backup_id,
      leaderId: state.leader_id,
      stateChecksum: checksum,
      duplicates: totalDuplicates
    };
  });

  // 5. Leader replication status across all peers
  rpcServer.register('replication.leaderStatus', async () => {
    const state = await getNodeState();
    if (state.role !== 'primary') {
      throw new RpcError(ERROR_CODES.NOT_PRIMARY, `Node ${config.nodeId} is not primary`, {
        leaderHint: state.leader_id || 'a',
        epoch: state.epoch
      });
    }

    const peersRes = await query(`
      SELECT peer_id, match_lsn, next_lsn, state, last_ack_at, last_ack_ms, duplicates, last_error
      FROM replication_peer_state
      ORDER BY peer_id ASC;
    `);

    const peers = {};
    for (const p of peersRes.rows) {
      const matchLsn = Number(p.match_lsn);
      const lastLsn = Number(state.last_lsn);
      const lagLsn = Math.max(0, lastLsn - matchLsn);

      peers[p.peer_id] = {
        matchLsn,
        lagLsn,
        pending: lagLsn,
        nextLsn: Number(p.next_lsn),
        state: p.state,
        lastAckAt: p.last_ack_at,
        lastAckMs: p.last_ack_ms,
        duplicates: Number(p.duplicates),
        lastError: p.last_error
      };
    }

    return {
      nodeId: state.node_id,
      role: state.role,
      epoch: state.epoch,
      lastLsn: Number(state.last_lsn),
      durableLsn: Number(state.durable_lsn),
      replicationMode: state.replication_mode,
      syncAcks: state.sync_acks,
      backupId: state.backup_id,
      peers
    };
  });

  // 6. Set mode (SYNC / ASYNC) on primary (Section 19.11)
  rpcServer.register('replication.setMode', async (params) => {
    const state = await getNodeState();
    if (state.role !== 'primary') {
      throw new RpcError(ERROR_CODES.NOT_PRIMARY, `Node ${config.nodeId} is not primary`, {
        leaderHint: state.leader_id || 'a',
        epoch: state.epoch
      });
    }

    const targetMode = params.mode;
    const targetSyncAcks = params.syncAcks !== undefined ? Number(params.syncAcks) : state.sync_acks;

    const replicator = getLeaderReplicator();

    // If switching ASYNC -> SYNC, wait (bounded) for durable_lsn == last_lsn (Section 19.11)
    if (state.replication_mode === 'ASYNC' && targetMode === 'SYNC') {
      const targetLsn = Number(state.last_lsn);
      if (targetLsn > 0 && replicator && replicator.ackTracker) {
        if (replicator.ackTracker.durableLsn < targetLsn) {
          await replicator.replicateNow();
          try {
            await replicator.ackTracker.awaitDurability(targetLsn, 1200);
          } catch (err) {
            // Proceed even if timeout so mode can be changed
          }
        }
      }
    }

    const pool = getPool();
    const client = await pool.connect();
    let log;

    try {
      await client.query('BEGIN');

      const payload = {
        config: {
          replicationMode: targetMode,
          syncAcks: targetSyncAcks,
          backupId: state.backup_id
        }
      };

      log = await writeLogEntry(client, {
        entryType: 'CONFIG_CHANGE',
        payload
      });

      await client.query(`
        UPDATE node_state SET
          replication_mode = $1,
          sync_acks = $2,
          updated_at = now()
        WHERE id = 1;
      `, [targetMode, targetSyncAcks]);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    if (replicator) {
      replicator.ackTracker.updateConfig({ syncAcks: targetSyncAcks });
      replicator.replicateNow();
    }

    return {
      ok: true,
      mode: targetMode,
      syncAcks: targetSyncAcks,
      lsn: log.lsn
    };
  });

  // 7. Fault test hook: resend already-applied entries to prove duplicate handling (Section 19.10)
  rpcServer.register('replication.resend', async (params) => {
    const replicator = getLeaderReplicator();
    if (!replicator) {
      throw new RpcError(ERROR_CODES.INTERNAL_ERROR, 'Leader replicator not running on this node');
    }

    return replicator.resend(params);
  });
}

module.exports = {
  registerReplicationMethods
};
