-- 002_replication.sql: Replication Schema

CREATE TABLE node_state (                          -- exactly one row; its row lock serializes LSN allocation
  id                INT PRIMARY KEY CHECK (id = 1),
  node_id           TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('primary','backup','replica','recovering','candidate')),
  epoch             INT NOT NULL DEFAULT 0,        -- epoch of the leader this node follows (or leads)
  promised_epoch    INT NOT NULL DEFAULT 0,        -- highest epoch this node granted; never decreases
  leader_id         TEXT,
  backup_id         TEXT,
  last_lsn          BIGINT NOT NULL DEFAULT 0,     -- tail of the local log == applied position
  last_epoch        INT NOT NULL DEFAULT 0,        -- epoch of the last log entry
  last_hash         TEXT NOT NULL DEFAULT '',
  durable_lsn       BIGINT NOT NULL DEFAULT 0,     -- highest LSN known to be on a quorum (leader computes; followers learn)
  replication_mode  TEXT NOT NULL DEFAULT 'ASYNC' CHECK (replication_mode IN ('SYNC','ASYNC')),
  sync_acks         INT NOT NULL DEFAULT 2,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE replication_log (
  lsn          BIGINT PRIMARY KEY,
  epoch        INT NOT NULL,
  entry_type   TEXT NOT NULL CHECK (entry_type IN
               ('ACCOUNT_CREATED','TXN_COMMITTED','TXN_REJECTED','CONFIG_CHANGE','EPOCH_START')),
  txn_id       UUID,
  payload      JSONB NOT NULL,                     -- complete effects, see Section 19.2
  prev_hash    TEXT NOT NULL,
  entry_hash   TEXT NOT NULL,                      -- sha256(prev_hash || lsn || epoch || canonical(payload))
  origin_node  TEXT NOT NULL,
  lamport      BIGINT NOT NULL,
  physical_ts  BIGINT NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE replication_peer_state (               -- leader-side view of each follower
  peer_id        TEXT PRIMARY KEY,
  match_lsn      BIGINT NOT NULL DEFAULT 0,         -- highest LSN acknowledged by the peer
  next_lsn       BIGINT NOT NULL DEFAULT 1,
  state          TEXT NOT NULL DEFAULT 'STREAMING', -- STREAMING | BACKOFF | REWIND | NEEDS_RESYNC
  last_ack_at    TIMESTAMPTZ,
  last_ack_ms    INT,                               -- most recent send->ack latency
  duplicates     BIGINT NOT NULL DEFAULT 0,
  last_error     TEXT
);

CREATE TABLE replication_errors (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  peer_id TEXT,
  lsn BIGINT,
  error_code TEXT NOT NULL,
  detail JSONB
);

CREATE TABLE divergent_log (                        -- archived entries removed during rejoin (audit of lost writes)
  id BIGSERIAL PRIMARY KEY,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lsn BIGINT NOT NULL,
  epoch INT NOT NULL,
  entry_type TEXT NOT NULL,
  txn_id UUID,
  payload JSONB NOT NULL,
  entry_hash TEXT NOT NULL,
  reason TEXT NOT NULL
);
