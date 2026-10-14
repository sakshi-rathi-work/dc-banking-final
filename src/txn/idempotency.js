// src/txn/idempotency.js: Idempotency claim and result storage
const crypto = require('crypto');
const { canonicalJSON } = require('../domain/invariants');
const { RpcError, ERROR_CODES } = require('../contracts/errors');

function hashRequestParams(operation, params) {
  const cleanParams = { ...params };
  delete cleanParams._meta;
  delete cleanParams.idempotencyKey;
  delete cleanParams.taskId;
  delete cleanParams.requestId;
  const canonical = canonicalJSON({ op: operation, params: cleanParams });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

async function claimIdempotencyKey(client, key, operation, params) {
  const requestHash = hashRequestParams(operation, params);

  // Attempt to claim key
  const insertRes = await client.query(`
    INSERT INTO idempotency_keys (idempotency_key, operation, request_hash, created_at)
    VALUES ($1, $2, $3, now())
    ON CONFLICT (idempotency_key) DO NOTHING;
  `, [key, operation, requestHash]);

  if (insertRes.rowCount === 1) {
    return { claimed: true, duplicate: false, requestHash };
  }

  // Row already existed: fetch stored record.
  // Using FOR SHARE/UPDATE waits for any concurrent in-flight transaction on this key to finish.
  const existingRes = await client.query(`
    SELECT idempotency_key, operation, request_hash, result, lsn
    FROM idempotency_keys
    WHERE idempotency_key = $1
    FOR SHARE;
  `, [key]);

  if (existingRes.rows.length === 0) {
    throw new RpcError(ERROR_CODES.INTERNAL_ERROR, 'Failed to fetch existing idempotency record');
  }

  const existing = existingRes.rows[0];

  if (existing.request_hash !== requestHash) {
    throw new RpcError(
      ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
      `Idempotency key "${key}" was reused with different payload or operation`
    );
  }

  return {
    claimed: false,
    duplicate: true,
    result: existing.result,
    lsn: existing.lsn
  };
}

async function storeIdempotencyResult(client, key, result, lsn) {
  await client.query(`
    UPDATE idempotency_keys
    SET result = $1, lsn = $2
    WHERE idempotency_key = $3;
  `, [JSON.stringify(result), lsn, key]);
}

module.exports = {
  hashRequestParams,
  claimIdempotencyKey,
  storeIdempotencyResult
};
