-- 003_cluster.sql: Cluster, Election, and Event Log Schema

CREATE TABLE cluster_nodes (                        -- static membership + last observed state
  node_id TEXT PRIMARY KEY,
  rank INT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ,
  last_role TEXT,
  last_epoch INT,
  last_lsn BIGINT,
  suspected BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE election_log (
  id BIGSERIAL PRIMARY KEY,
  election_id TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('SENT','RECEIVED','LOCAL')),
  peer_id TEXT,
  message_type TEXT NOT NULL,
  lamport BIGINT NOT NULL,
  physical_ts BIGINT NOT NULL,
  detail JSONB
);

CREATE TABLE event_log (                            -- real service events: RPC, DB commit, clock, worker, routing
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  physical_ts BIGINT NOT NULL,
  lamport BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  request_id TEXT,
  txn_id UUID,
  peer TEXT,
  detail JSONB
);

CREATE INDEX ON event_log (request_id);
