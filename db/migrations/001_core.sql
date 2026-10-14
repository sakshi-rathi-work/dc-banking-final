-- 001_core.sql: Core Banking Schema

CREATE TABLE accounts (
  account_id   TEXT PRIMARY KEY CHECK (account_id ~ '^ACC-[0-9]{4,}$'),
  holder_name  TEXT NOT NULL CHECK (length(trim(holder_name)) BETWEEN 1 AND 100),
  status       TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','FROZEN','CLOSED')),
  balance      NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),   -- overdraft rejected by default
  currency     CHAR(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  version      BIGINT NOT NULL DEFAULT 0,          -- +1 on every balance change; verified on replica apply
  created_at   TIMESTAMPTZ NOT NULL,               -- taken from the log entry (identical on all nodes)
  updated_at   TIMESTAMPTZ NOT NULL,
  created_lsn  BIGINT NOT NULL,
  updated_lsn  BIGINT NOT NULL
);

CREATE TABLE idempotency_keys (
  idempotency_key TEXT PRIMARY KEY,
  operation       TEXT NOT NULL,                   -- createAccount | deposit | withdraw | transfer
  request_hash    TEXT NOT NULL,                   -- sha256 of canonical params (detects key reuse with different payload)
  result          JSONB,                           -- final stored response (set before commit)
  lsn             BIGINT,
  created_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE transactions (
  txn_id                  UUID PRIMARY KEY,
  idempotency_key         TEXT NOT NULL UNIQUE REFERENCES idempotency_keys(idempotency_key),
  type                    TEXT NOT NULL CHECK (type IN ('DEPOSIT','WITHDRAWAL','TRANSFER')),
  source_account_id       TEXT REFERENCES accounts(account_id),
  destination_account_id  TEXT REFERENCES accounts(account_id),
  amount                  NUMERIC(14,2) NOT NULL CHECK (amount > 0 AND amount <= 1000000.00),
  currency                CHAR(3) NOT NULL DEFAULT 'INR',
  status                  TEXT NOT NULL CHECK (status IN ('COMMITTED','REJECTED')),
  reject_reason           TEXT,
  request_id              TEXT NOT NULL,
  origin_node             TEXT NOT NULL,           -- node that executed it (the primary at that time)
  leader_id               TEXT NOT NULL,
  epoch                   INT  NOT NULL,
  lsn                     BIGINT NOT NULL UNIQUE,  -- replication log position
  lamport_ts              BIGINT NOT NULL,
  physical_ts_ms          BIGINT NOT NULL,         -- application-managed physical clock at commit
  committed_at            TIMESTAMPTZ NOT NULL,
  CHECK ((status = 'REJECTED') = (reject_reason IS NOT NULL)),
  CHECK (
    (type='DEPOSIT'    AND source_account_id IS NULL     AND destination_account_id IS NOT NULL) OR
    (type='WITHDRAWAL' AND source_account_id IS NOT NULL AND destination_account_id IS NULL) OR
    (type='TRANSFER'   AND source_account_id IS NOT NULL AND destination_account_id IS NOT NULL
                       AND source_account_id <> destination_account_id))
);

CREATE TABLE ledger_entries (                      -- double-entry audit lines (only for COMMITTED txns)
  lsn           BIGINT NOT NULL,
  line_no       SMALLINT NOT NULL,
  txn_id        UUID NOT NULL REFERENCES transactions(txn_id),
  account_id    TEXT NOT NULL REFERENCES accounts(account_id),
  direction     TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount        NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  balance_after NUMERIC(14,2) NOT NULL CHECK (balance_after >= 0),
  PRIMARY KEY (lsn, line_no)
);

CREATE INDEX ON transactions (source_account_id);
CREATE INDEX ON transactions (destination_account_id);
CREATE INDEX ON ledger_entries (account_id, lsn);
