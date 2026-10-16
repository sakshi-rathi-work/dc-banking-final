const { faults } = require('../../shared/faults');
const { getNodeState } = require('../state');

function registerClusterMethods(rpcServer, failureDetector, config) {
  rpcServer.register('cluster.ping', async (params) => {
    return {
      pong: true,
      nodeId: config.nodeId,
      timestamp: Date.now()
    };
  });

  rpcServer.register('cluster.setFault', async (params) => {
    const { knob, value } = params || {};
    if (!knob) {
      throw new Error('Missing fault knob');
    }
    faults.setFault(knob, value);
    return {
      set: true,
      knob,
      value
    };
  });

  rpcServer.register('cluster.getFaults', async () => {
    return {
      nodeId: config.nodeId,
      faults: faults.getFaults()
    };
  });

  rpcServer.register('cluster.clearFaults', async () => {
    faults.clearFaults();
    return {
      nodeId: config.nodeId,
      cleared: true
    };
  });

  rpcServer.register('cluster.getState', async (params) => {
    const state = await getNodeState();
    let peers = {};
    if (failureDetector) {
      peers = await failureDetector.getPeerStates();
    }

    const { getFencingManager } = require('../../faulttolerance/fencing');
    const fencing = getFencingManager();
    const leaseValid = (state.role === 'primary' && fencing) ? fencing.isLeaseValid() : true;

    return {
      nodeId: config.nodeId,
      role: state.role,
      epoch: state.epoch,
      promisedEpoch: state.promised_epoch,
      leaderId: state.leader_id,
      backupId: state.backup_id,
      lastLsn: state.last_lsn,
      lastEpoch: state.last_epoch,
      durableLsn: state.durable_lsn,
      replicationMode: state.replication_mode,
      syncAcks: state.sync_acks,
      dbHealthy: true,
      leaseValid,
      peers
    };
  });

  rpcServer.register('cluster.heartbeat', async (params) => {
    if (failureDetector) {
      failureDetector.recordInboundHeartbeat(params);
    }

    const state = await getNodeState();
    return {
      ack: true,
      nodeId: config.nodeId,
      role: state.role,
      epoch: state.epoch,
      lastLsn: state.last_lsn
    };
  });

  // cluster.requestEpoch (PROJECT.md Section 21.3 Promotion Protocol Step 3)
  rpcServer.register('cluster.requestEpoch', async (params) => {
    const { getPool } = require('../../shared/db/pool');
    const { getLeaderReplicator } = require('../../replication/leaderReplicator');
    const { epoch, candidateId } = params;

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const res = await client.query('SELECT * FROM node_state WHERE id = 1 FOR UPDATE');
      const row = res.rows[0];

      if (Number(epoch) <= Number(row.promised_epoch)) {
        await client.query('ROLLBACK');
        return {
          granted: false,
          promisedEpoch: Number(row.promised_epoch),
          nodeId: config.nodeId
        };
      }

      // Grant epoch! If this node was primary, it must step down immediately
      const wasPrimary = row.role === 'primary';
      const newRole = wasPrimary ? 'replica' : row.role;

      await client.query(`
        UPDATE node_state SET
          promised_epoch = $1,
          role = $2,
          updated_at = now()
        WHERE id = 1;
      `, [epoch, newRole]);

      await client.query('COMMIT');

      if (wasPrimary) {
        const rep = getLeaderReplicator();
        if (rep) rep.stop();
      }

      return {
        granted: true,
        nodeId: config.nodeId,
        lastEpoch: Number(row.last_epoch || 0),
        lastLsn: Number(row.last_lsn || 0),
        durableLsn: Number(row.durable_lsn || 0),
        lastHash: row.last_hash || ''
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // cluster.announceLeader (PROJECT.md Section 21.3 Promotion Protocol Step 7)
  rpcServer.register('cluster.announceLeader', async (params) => {
    const { getPool } = require('../../shared/db/pool');
    const { getLeaderReplicator } = require('../../replication/leaderReplicator');
    const { epoch, leaderId, backupId } = params;

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const res = await client.query('SELECT * FROM node_state WHERE id = 1 FOR UPDATE');
      const row = res.rows[0];

      if (Number(epoch) >= Number(row.epoch)) {
        const wasPrimary = row.role === 'primary' && leaderId !== config.nodeId;
        const newRole = (config.nodeId === leaderId) ? 'primary'
          : (config.nodeId === backupId ? 'backup' : 'replica');

        await client.query(`
          UPDATE node_state SET
            epoch = $1,
            promised_epoch = GREATEST(promised_epoch, $1),
            leader_id = $2,
            backup_id = COALESCE($3, backup_id),
            role = $4,
            updated_at = now()
          WHERE id = 1;
        `, [epoch, leaderId, backupId || null, newRole]);

        await client.query('COMMIT');

        if (wasPrimary) {
          const rep = getLeaderReplicator();
          if (rep) rep.stop();
        }
      } else {
        await client.query('ROLLBACK');
      }

      return {
        ack: true,
        nodeId: config.nodeId,
        epoch
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // cluster.rejoin (PROJECT.md Section 21.7)
  rpcServer.register('cluster.rejoin', async (params) => {
    const { executeRejoin } = require('../../faulttolerance/rejoin');
    let targetLeader = params && params.targetLeader;

    if (!targetLeader && failureDetector) {
      const peers = await failureDetector.getPeerStates();
      let bestLeader = null;
      for (const [id, p] of Object.entries(peers)) {
        if (p.role === 'primary' && p.status === 'alive') {
          if (!bestLeader || Number(p.epoch) > Number(bestLeader.epoch)) {
            bestLeader = p;
          }
        }
      }
      if (bestLeader) {
        targetLeader = {
          nodeId: bestLeader.nodeId,
          url: bestLeader.url,
          epoch: bestLeader.epoch,
          lastLsn: bestLeader.lastLsn
        };
      }
    }

    if (!targetLeader) {
      throw new Error('No leader found to rejoin');
    }

    return await executeRejoin(config, targetLeader);
  });
}

module.exports = {
  registerClusterMethods
};
