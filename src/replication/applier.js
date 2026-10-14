// src/replication/applier.js: Deterministic log applier
// Specification: PROJECT.md Section 19.2, Section 19.3
// Shared between follower replication, log replay during rejoin, and tests.

const { RpcError, ERROR_CODES } = require('../contracts/errors');
const { computeEntryHash } = require('../domain/invariants');

/**
 * Apply a single replication_log entry to the local database.
 * MUST be executed within an active SQL transaction (client).
 *
 * @param {Object} client - pg client with active BEGIN
 * @param {Object} entry - replication_log entry object
 * @returns {Promise<Object>} applied entry confirmation
 */
async function applyEntry(client, entry) {
  const {
    lsn,
    epoch,
    entryType,
    txnId,
    payload,
    prevHash,
    entryHash,
    originNode,
    lamport,
    physicalTs,
    committedAt
  } = entry;

  const parsedPayload = typeof payload === 'string' ? JSON.parse(payload) : payload;

  // 1. Apply Effects by entryType
  switch (entryType) {
    case 'ACCOUNT_CREATED': {
      const acc = parsedPayload.account;
      if (acc) {
        await client.query(`
          INSERT INTO accounts (account_id, holder_name, balance, status, version, created_lsn, updated_lsn, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $6, COALESCE($7, now()), now())
          ON CONFLICT (account_id) DO UPDATE SET
            holder_name = EXCLUDED.holder_name,
            balance = EXCLUDED.balance,
            status = EXCLUDED.status,
            version = EXCLUDED.version,
            updated_lsn = EXCLUDED.updated_lsn,
            updated_at = now();
        `, [
          acc.accountId,
          acc.holderName,
          acc.balance,
          acc.status || 'ACTIVE',
          acc.version || 0,
          lsn,
          committedAt || null
        ]);
      }

      if (parsedPayload.txn) {
        await insertTransactionRow(client, parsedPayload.txn, entry);
      }
      if (Array.isArray(parsedPayload.ledger)) {
        await insertLedgerRows(client, parsedPayload.ledger, lsn, txnId);
      }
      if (parsedPayload.idempotency) {
        await upsertIdempotency(client, parsedPayload.idempotency, lsn);
      }
      break;
    }

    case 'TXN_COMMITTED': {
      // Step 4 of Section 19.3: verify version = expectedPrevious + 1
      if (Array.isArray(parsedPayload.accounts)) {
        for (const acc of parsedPayload.accounts) {
          const accRes = await client.query(`
            SELECT version, balance FROM accounts WHERE account_id = $1 FOR UPDATE;
          `, [acc.accountId]);

          if (accRes.rows.length === 0) {
            throw new RpcError(ERROR_CODES.INTERNAL_ERROR, `APPLY_MISMATCH: account ${acc.accountId} not found on replica`);
          }

          const currentVersion = Number(accRes.rows[0].version);
          const expectedTargetVersion = Number(acc.version);

          if (currentVersion + 1 !== expectedTargetVersion) {
            throw new RpcError(
              ERROR_CODES.INTERNAL_ERROR,
              `APPLY_MISMATCH: account ${acc.accountId} current version ${currentVersion} does not precede target version ${expectedTargetVersion}`
            );
          }

          await client.query(`
            UPDATE accounts SET
              balance = $1,
              version = $2,
              updated_lsn = $3,
              updated_at = now()
            WHERE account_id = $4;
          `, [acc.balance, expectedTargetVersion, lsn, acc.accountId]);
        }
      }

      if (parsedPayload.txn) {
        await insertTransactionRow(client, parsedPayload.txn, entry);
      }
      if (Array.isArray(parsedPayload.ledger)) {
        await insertLedgerRows(client, parsedPayload.ledger, lsn, txnId);
      }
      if (parsedPayload.idempotency) {
        await upsertIdempotency(client, parsedPayload.idempotency, lsn);
      }
      break;
    }

    case 'TXN_REJECTED': {
      if (parsedPayload.txn) {
        await insertTransactionRow(client, parsedPayload.txn, entry);
      }
      if (parsedPayload.idempotency) {
        await upsertIdempotency(client, parsedPayload.idempotency, lsn);
      }
      break;
    }

    case 'CONFIG_CHANGE': {
      const cfg = parsedPayload.config || {};
      await client.query(`
        UPDATE node_state SET
          replication_mode = COALESCE($1, replication_mode),
          sync_acks = COALESCE($2, sync_acks),
          backup_id = COALESCE($3, backup_id),
          updated_at = now()
        WHERE id = 1;
      `, [cfg.replicationMode || null, cfg.syncAcks || null, cfg.backupId || null]);
      break;
    }

    case 'EPOCH_START': {
      const es = parsedPayload.epochStart || {};
      await client.query(`
        UPDATE node_state SET
          epoch = $1,
          leader_id = $2,
          backup_id = COALESCE($3, backup_id),
          updated_at = now()
        WHERE id = 1;
      `, [es.epoch, es.leaderId, es.backupId || null]);
      break;
    }

    default:
      break;
  }

  // 2. Insert into follower's own replication_log
  await client.query(`
    INSERT INTO replication_log (
      lsn, epoch, entry_type, txn_id, payload, prev_hash, entry_hash,
      origin_node, lamport, physical_ts, committed_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, now()))
    ON CONFLICT (lsn) DO NOTHING;
  `, [
    lsn,
    epoch,
    entryType,
    txnId,
    JSON.stringify(parsedPayload),
    prevHash,
    entryHash,
    originNode,
    lamport || 0,
    physicalTs || Date.now(),
    committedAt || null
  ]);

  // 3. Update node_state
  await client.query(`
    UPDATE node_state SET
      last_lsn = $1,
      last_epoch = $2,
      last_hash = $3,
      updated_at = now()
    WHERE id = 1;
  `, [lsn, epoch, entryHash]);

  return {
    applied: true,
    lsn,
    epoch,
    entryHash
  };
}

async function insertTransactionRow(client, txn, entry) {
  const parsedPayload = typeof entry.payload === 'string' ? JSON.parse(entry.payload) : (entry.payload || {});
  const idemKey = txn.idempotencyKey || parsedPayload.idempotency?.key || `idem-lsn-${entry.lsn}`;

  await client.query(`
    INSERT INTO idempotency_keys (idempotency_key, operation, request_hash, result, lsn, created_at)
    VALUES ($1, $2, '', $3, $4, now())
    ON CONFLICT (idempotency_key) DO NOTHING;
  `, [idemKey, txn.type || 'transaction', JSON.stringify(txn), entry.lsn]);

  await client.query(`
    INSERT INTO transactions (
      txn_id, idempotency_key, type, source_account_id, destination_account_id,
      amount, currency, status, reject_reason, request_id, origin_node,
      leader_id, epoch, lsn, lamport_ts, physical_ts_ms, committed_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, COALESCE($17, now()))
    ON CONFLICT (txn_id) DO NOTHING;
  `, [
    txn.txnId || entry.txnId,
    idemKey,
    txn.type,
    txn.sourceAccountId || null,
    txn.destinationAccountId || null,
    txn.amount,
    txn.currency || 'INR',
    txn.status || 'COMMITTED',
    txn.rejectReason || null,
    txn.requestId || null,
    entry.originNode,
    entry.originNode, // leader_id
    entry.epoch,
    entry.lsn,
    entry.lamport || 0,
    entry.physicalTs || Date.now(),
    entry.committedAt || null
  ]);
}

async function insertLedgerRows(client, ledgerLines, lsn, txnId) {
  for (const line of ledgerLines) {
    await client.query(`
      INSERT INTO ledger_entries (lsn, line_no, txn_id, account_id, direction, amount, balance_after)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (lsn, line_no) DO NOTHING;
    `, [
      lsn,
      line.lineNo,
      txnId,
      line.accountId,
      line.direction,
      line.amount,
      line.balanceAfter
    ]);
  }
}

async function upsertIdempotency(client, idem, lsn) {
  if (!idem) return;
  const key = idem.key || idem.idempotencyKey;
  if (!key) return;
  await client.query(`
    INSERT INTO idempotency_keys (idempotency_key, operation, request_hash, result, lsn, created_at)
    VALUES ($1, $2, $3, $4, $5, now())
    ON CONFLICT (idempotency_key) DO UPDATE SET
      result = EXCLUDED.result,
      lsn = EXCLUDED.lsn;
  `, [
    key,
    idem.operation || 'transaction',
    idem.requestHash || '',
    JSON.stringify(idem.result || {}),
    lsn || null
  ]);
}

module.exports = {
  applyEntry
};
