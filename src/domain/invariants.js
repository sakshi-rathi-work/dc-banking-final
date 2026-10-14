// src/domain/invariants.js: Banking Invariant Verification and Checksum Computation
const crypto = require('crypto');
const { getPool } = require('../shared/db/pool');

function canonicalJSON(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJSON).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  const pairs = keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(obj[k]));
  return '{' + pairs.join(',') + '}';
}

function computeEntryHash(prevHash, lsn, epoch, payload) {
  const canonical = canonicalJSON(payload);
  const data = `${prevHash}${lsn}${epoch}${canonical}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function getStateChecksum(clientOrPool) {
  const runner = clientOrPool || getPool();

  const res = await runner.query(`
    SELECT
      COALESCE(md5(string_agg(account_id || ':' || balance || ':' || version, ',' ORDER BY account_id)), md5('')) AS checksum,
      COUNT(*)::INT AS account_count
    FROM accounts;
  `);

  const stateRes = await runner.query('SELECT last_lsn, epoch FROM node_state WHERE id = 1');
  const state = stateRes.rows[0] || { last_lsn: 0, epoch: 0 };

  return {
    checksum: res.rows[0].checksum,
    accountCount: res.rows[0].account_count,
    lastLsn: Number(state.last_lsn),
    epoch: state.epoch
  };
}

async function verifyInvariants(clientOrPool) {
  const runner = clientOrPool || getPool();
  const results = {};
  let allPassed = true;

  // I1: No negative balance
  const negBalRes = await runner.query(`
    SELECT COUNT(*)::INT AS violations FROM accounts WHERE balance < 0;
  `);
  const negViolations = negBalRes.rows[0].violations;
  results.I1_noNegativeBalance = {
    pass: negViolations === 0,
    violations: negViolations
  };
  if (negViolations > 0) allPassed = false;

  // I8: Ledger/balance agreement
  const ledgerAgreeRes = await runner.query(`
    SELECT a.account_id, a.balance,
           COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0) AS ledger_sum
    FROM accounts a
    LEFT JOIN ledger_entries l ON a.account_id = l.account_id
    GROUP BY a.account_id, a.balance
    HAVING a.balance <> COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0);
  `);
  const ledgerMismatches = ledgerAgreeRes.rows.length;
  results.I8_ledgerBalanceAgreement = {
    pass: ledgerMismatches === 0,
    mismatches: ledgerAgreeRes.rows
  };
  if (ledgerMismatches > 0) allPassed = false;

  // I9: Money conservation
  const moneyConsRes = await runner.query(`
    SELECT
      (SELECT COALESCE(SUM(balance), 0) FROM accounts) AS total_balances,
      (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE type = 'DEPOSIT' AND status = 'COMMITTED') AS total_deposits,
      (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE type = 'WITHDRAWAL' AND status = 'COMMITTED') AS total_withdrawals;
  `);
  const { total_balances, total_deposits, total_withdrawals } = moneyConsRes.rows[0];
  const expectedBalances = (BigInt(Math.round(total_deposits * 100)) - BigInt(Math.round(total_withdrawals * 100)));
  const actualBalances = BigInt(Math.round(total_balances * 100));
  const conservationPassed = expectedBalances === actualBalances;
  results.I9_moneyConservation = {
    pass: conservationPassed,
    totalBalances: total_balances,
    totalDeposits: total_deposits,
    totalWithdrawals: total_withdrawals
  };
  if (!conservationPassed) allPassed = false;

  // I10: Gap-free LSN and hash chain integrity
  const stateRes = await runner.query('SELECT last_lsn, last_hash FROM node_state WHERE id = 1');
  const state = stateRes.rows[0] || { last_lsn: 0, last_hash: '' };
  const lastLsn = Number(state.last_lsn);

  let gapFree = true;
  let hashChainValid = true;
  let chainErrors = [];

  if (lastLsn > 0) {
    const logRes = await runner.query(`
      SELECT lsn, epoch, prev_hash, entry_hash, payload
      FROM replication_log
      ORDER BY lsn ASC;
    `);

    if (logRes.rows.length !== lastLsn) {
      gapFree = false;
      chainErrors.push(`Log entry count (${logRes.rows.length}) does not match last_lsn (${lastLsn})`);
    }

    let expectedPrevHash = '';
    for (let i = 0; i < logRes.rows.length; i++) {
      const entry = logRes.rows[i];
      const currentLsn = Number(entry.lsn);

      if (currentLsn !== i + 1) {
        gapFree = false;
        chainErrors.push(`LSN gap at index ${i}: expected ${i + 1}, found ${currentLsn}`);
      }

      if (entry.prev_hash !== expectedPrevHash) {
        hashChainValid = false;
        chainErrors.push(`Hash chain break at LSN ${currentLsn}: expected prev_hash "${expectedPrevHash}", found "${entry.prev_hash}"`);
      }

      const computedHash = computeEntryHash(entry.prev_hash, currentLsn, entry.epoch, entry.payload);
      if (entry.entry_hash !== computedHash) {
        hashChainValid = false;
        chainErrors.push(`Hash mismatch at LSN ${currentLsn}: expected "${computedHash}", found "${entry.entry_hash}"`);
      }

      expectedPrevHash = entry.entry_hash;
    }
  }

  results.I10_gapFreeHashChain = {
    pass: gapFree && hashChainValid,
    lastLsn,
    chainErrors
  };
  if (!gapFree || !hashChainValid) allPassed = false;

  // I11: Promised epoch fencing
  const epochRes = await runner.query('SELECT epoch, promised_epoch FROM node_state WHERE id = 1');
  const epState = epochRes.rows[0] || { epoch: 0, promised_epoch: 0 };
  const epochValid = epState.promised_epoch >= epState.epoch;
  results.I11_epochFencing = {
    pass: epochValid,
    epoch: epState.epoch,
    promisedEpoch: epState.promised_epoch
  };
  if (!epochValid) allPassed = false;

  return {
    pass: allPassed,
    checks: results
  };
}

module.exports = {
  canonicalJSON,
  computeEntryHash,
  getStateChecksum,
  computeStateChecksum: getStateChecksum,
  verifyInvariants
};
