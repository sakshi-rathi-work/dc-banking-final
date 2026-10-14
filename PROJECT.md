# Distributed Banking System — `PROJECT.md`

> **Status:** Specification v1.0 (single source of truth). **Scope:** laboratory-scale, real, networked, persistent, fault-tolerant distributed banking application.
> **Audience:** the student team, and coding agents (Claude Code, Antigravity) that will implement the system phase by phase.

---

## 0. Rules for Implementing Agents (read first)

1. **Read this entire file before touching the repository.** If the code and this file disagree, stop, decide which is right, and update this file in the same change.
2. **Implement exactly one phase at a time** (Section 28). Do not start phase *N+1* until every exit criterion of phase *N* has been verified against the running Docker cluster.
3. **Inspect before writing.** List the directory and read existing files before creating or overwriting anything.
4. **Preserve contracts.** RPC method names, parameter shapes, error codes (Section 13), DB schema (Section 11) and the replication protocol (Section 19) are contracts. Change them only by editing this document first.
5. **Write tests alongside code.** Every phase ships unit tests (`node:test`) and at least one integration test that runs against the real Docker cluster.
6. **No simulation, ever.** Never mark an experiment done because a menu item or log line exists. "Done" means real database rows, real network requests between containers, and real measured values (Section 34 is the gate).
7. **Configuration via environment variables only.** No hardcoded hostnames, ports, credentials, or timings.
8. **Structured logs and explicit errors.** One JSON object per log line; every failure returns a typed error (Section 13). Never swallow errors, never fall back silently to local-only execution, shared databases, or in-memory state.
9. **One banking code path.** Deposit/withdraw/transfer logic exists exactly once (`src/txn/executor.js`). Experiments call it; they never re-implement it.
10. **Readability over cleverness.** A second-year CS student must be able to explain every module in a viva. Few dependencies, small files, plain JavaScript (CommonJS), no framework magic.
11. **Update documentation** (`PROJECT.md`, `docs/`) whenever behaviour changes.
12. **Terminal output rule:** experiment screens print only real events, measured values, tables and PASS/FAIL verdicts computed from real data. **No theory, no explanatory paragraphs, no hardcoded results** (Section 23).

---

## 1. Project Title and Brief

**Distributed Banking System**

A functioning distributed bank in which four independently running bank servers (Node A–D), each in its own Docker container with its own PostgreSQL database and persistent volume, process real banking transactions (create account, balance, deposit, withdraw, transfer, history). The nodes exchange real network requests over a Docker network; replicate committed transaction records through an application-level replication protocol; elect leaders with the Bully and Ring algorithms; balance load through a coordinator; and survive primary failure through epoch-fenced primary-backup failover.

The system exists to demonstrate seven Distributed Computing laboratory experiments inside **one coherent banking system**, accessed from **one interactive terminal application**:

| # | Experiment | Real capability implemented |
|---|---|---|
| 1 | Client-server communication (RPC) | JSON-RPC 2.0 over HTTP between CLI → coordinator → bank nodes, with idempotent retries |
| 2 | Multithreading | `worker_threads` pool executing concurrent banking transactions with PostgreSQL row locks |
| 3 | Clock synchronization | Application-managed physical clocks with injectable offsets, Berkeley synchronization, Lamport logical clocks |
| 4 | Bully and Ring election | Real election messages between node processes, with leadership epochs |
| 5 | Consistency and replication | Application-level log replication between four separate databases; synchronous and asynchronous modes |
| 6 | Load balancing | Round Robin and Least Connections routing of real requests with health-aware eligibility |
| 7 | Primary-backup fault tolerance | Detection, safe promotion, fencing, client rediscovery, rejoin and divergence handling |

### 1.1 This is NOT a simulator

- Every node is a separate OS process in a separate container. Four nodes never share a database.
- All inter-node traffic is real HTTP between containers on the Docker network `bank-net`.
- Replication is implemented by the application (a replicated log), **not** by PostgreSQL streaming replication and **not** by a shared database.
- Terminal output comes from RPC responses, database queries and service event logs. Fault injection and configurable delays are allowed, but they act on the **real** services and communication paths.
- Failures produce explicit, inspectable outcomes. The system never silently falls back to fake or local-only behaviour.

---

## 2. Objectives and Scope

### 2.1 Objectives

| ID | Objective |
|---|---|
| O1 | Provide correct banking operations: create account, balance, deposit, withdraw, transfer, history. |
| O2 | Preserve banking invariants (Section 11.4) under concurrency, retries and failures. |
| O3 | Run four independent bank nodes with independent PostgreSQL databases. |
| O4 | Implement and demonstrate all seven experiments on the **same** accounts and transactions. |
| O5 | Make every claim verifiable: logs, DB rows, cross-node checksums, invariant checks. |
| O6 | State precisely what the system guarantees and what it does not (Sections 22, 31). |

### 2.2 In scope

Account/transaction domain; JSON-RPC layer; coordinator (gateway, health, leader tracking, load balancing, time master); node services; worker pool; clocks; Bully/Ring elections; log replication; epoch-based failover; terminal CLI; Docker Compose deployment; automated tests; demo scenarios; documentation.

### 2.3 Scale assumptions

Four nodes, tens of accounts, hundreds to low thousands of transactions, one developer laptop, one currency (INR).

---

## 3. Explicit Non-Goals

- No web or mobile frontend (the terminal CLI is the only UI). No React.
- No Redis, Kafka, Kubernetes, service mesh, API gateway products, message brokers.
- No PostgreSQL streaming/logical replication, no shared database, no distributed SQL.
- No Paxos/Raft library. We implement a small epoch-and-log protocol *inspired by* Raft ideas (Section 19, 21) and document its limits. We do **not** claim to be a verified consensus implementation.
- No two-phase commit. Writes have a single writer (the primary), so a transfer is one local ACID transaction; durability across nodes is achieved by log replication (Section 7.2 explains why this is not "global atomicity").
- No sharding: every node stores a full copy of all accounts.
- No multi-currency, interest, fees, authentication, authorization, KYC, regulatory compliance.
- No production hardening (TLS, secret managers, rate limiting). Basic security hygiene only (Section 5).
- No Byzantine fault tolerance. Nodes are crash-fail, not malicious.
- No automatic log compaction or snapshotting (log replay is the recovery mechanism).
- The coordinator is **not** made fault tolerant (documented single point of failure for routing; it holds no financial state).

---

## 4. Functional Requirements

| ID | Requirement |
|---|---|
| **Banking** | |
| FR-1 | Create an account (holder name, optional opening deposit). IDs are `ACC-0001`, `ACC-0002`, … generated by the primary. |
| FR-2 | Query balance and account details. |
| FR-3 | Deposit a positive amount (≤ 2 decimal places, ≤ policy max). |
| FR-4 | Withdraw a positive amount; reject overdrafts (default policy). |
| FR-5 | Transfer between two distinct accounts atomically with respect to every node's visible state. |
| FR-6 | Transaction history per account and global, with status, LSN, epoch, clocks, origin node. |
| FR-7 | Every mutating request carries an idempotency key; retries never duplicate financial effects. |
| FR-8 | Rejected business requests (insufficient funds, frozen account) are recorded as `REJECTED` transactions for audit. |
| **Distributed behaviour** | |
| FR-9 | Four nodes with stable ordered IDs A < B < C < D; one coordinator; one CLI. |
| FR-10 | Nodes discover each other from static configuration, exchange heartbeats, and agree on `(epoch, leader)`. |
| FR-11 | All writes execute on the current primary; non-primary nodes reject writes with a leader hint. |
| FR-12 | RPC: JSON-RPC 2.0 over HTTP with request IDs, timeouts, validation, typed errors. |
| FR-13 | Worker-thread batch execution of banking requests, with stress and conflict scenarios. |
| FR-14 | Application-managed physical clocks (injectable offset/drift), Berkeley synchronization, Lamport clocks propagated in every RPC. |
| FR-15 | Bully and Ring elections as real inter-node messages, with an election log. |
| FR-16 | Log replication with LSNs, acknowledgements, retry, gap detection, duplicate detection, divergence handling. |
| FR-17 | Synchronous and asynchronous replication modes, switchable at runtime. |
| FR-18 | Round Robin and Least Connections load balancing with health-aware eligibility. |
| FR-19 | Automatic primary failover with epoch fencing, safe promotion rules, and old-primary rejoin. |
| FR-20 | Fault injection (node stop/kill/start, DB stop, delay, drop, partition, worker crash) acting on real services. |
| FR-21 | Interactive terminal CLI exposing all seven experiments, cluster status, history, invariant verification, confirmed reset. |
| FR-22 | `verifyInvariants` across all nodes including cross-node state checksums. |

---

## 5. Non-Functional Requirements

| Category | Requirement |
|---|---|
| Correctness | Section 11.4 invariants hold in all supported scenarios; verified by tests. |
| Durability | Each node's data survives container restarts (named Docker volumes). Synchronous-mode acknowledged transactions survive loss of any single node including the primary (Section 19.8). |
| Observability | JSON logs with `ts, level, nodeId, requestId, txnId, lsn, epoch, lamport, event`. Event table `event_log` per node. |
| Repeatability | Demo scenarios are deterministic given fault-injection settings; concurrency proofs use barriers, not sleeps. |
| Performance (lab targets) | Local RPC round trip < 100 ms; failover completes < 20 s with default timers; cold `docker compose up` < 90 s. |
| Resource use | The full 10-container stack runs on a laptop with ≤ 4 GB RAM allocated to Docker. |
| Portability | Linux/macOS/Windows with Docker Desktop; Node.js 20 LTS inside containers only. |
| Understandability | Plain JS, small modules, no code generation, ≤ 3 runtime dependencies. |
| Security basics | Parameterized SQL only; strict input validation; credentials only in env; secrets never logged; fault-injection RPCs enabled only when `ENABLE_FAULT_INJECTION=true`; Docker socket mounted **only** in `bank-cli` and restricted to an allow-list of container names (lab-only risk, documented). |

---

## 6. Technology Stack

| Component | Choice | Justification |
|---|---|---|
| Runtime | Node.js 20 LTS (CommonJS) | Required; built-in `worker_threads`, `node:test`, `fetch`, `crypto.randomUUID`, `readline/promises`. |
| HTTP server | Express 4 | Required; minimal and widely understood. |
| DB | PostgreSQL 16 (one container per node) | Required; ACID, `NUMERIC`, row locks (`SELECT … FOR UPDATE`), `CHECK` constraints. |
| DB client | `pg` (node-postgres) with `Pool` | Explicit transactions, no ORM magic, row-lock SQL visible in code. |
| RPC | **JSON-RPC 2.0 over HTTP** (`POST /rpc`) | Real RPC semantics (method name, params, id, error object) with trivial tooling. Custom ~150-line client/server in `src/shared/rpc/`. No gRPC: protobuf codegen adds build complexity without teaching more. |
| Concurrency | `worker_threads` + PostgreSQL transactions | True multithreading (separate V8 isolates/OS threads); correctness from DB row locks, not JS locks. |
| Logging | `pino` (JSON) | Structured logs with minimal setup. |
| CLI | Built-in `readline/promises` + small table printer | No dependency. |
| Docker control | Docker Engine API via `node:http` over `/var/run/docker.sock` | No extra dependency; CLI can stop/start/kill containers for fault tests. |
| Deployment | Docker, Docker Compose v2 | Required. |
| Testing | `node:test`, `node:assert` | Zero dependencies. |

**Runtime dependencies: `express`, `pg`, `pino`.** Nothing else without a documented reason. One Docker image (`bank-app`) contains all code; the container `command` selects node / coordinator / cli.

**Money representation:** PostgreSQL `NUMERIC(14,2)`. In JavaScript, amounts are **decimal strings** (`"500.00"`), validated by regex, never converted to `Number`. Arithmetic is performed by PostgreSQL (`balance = balance - $1`).

---

## 7. System Architecture

### 7.1 Principles

1. **Single writer, full replication.** At any moment exactly one node (the primary, identified by `(epoch, leaderId)`) accepts writes. Every node holds a full copy of all accounts.
2. **The log is the unit of replication.** Each committed business request produces exactly one `replication_log` entry (carrying its complete effects) written in the *same local SQL transaction* that changes balances.
3. **Deterministic apply.** Followers apply entries strictly in LSN order using the entry's recorded effects, never by re-running business logic.
4. **Leadership is fenced by epochs.** Epochs only increase; a node never accepts replication or writes from an epoch lower than the highest it has promised.
5. **Election ≠ promotion.** An election picks a *candidate*. Promotion requires a majority of epoch grants **and** the candidate holding the required log (Section 21).
6. **Coordinator holds no financial state.** It routes, monitors, balances, and acts as time master. Losing it loses routing, not money.

### 7.2 Key design decisions

| # | Decision | Reason / consequence |
|---|---|---|
| D1 | Single-writer primary; no 2PC | A transfer touches two accounts that live in the **same** DB on the primary → one local ACID transaction. Other databases receive the effect via the log. |
| D2 | **Honest atomicity statement** | We do **not** claim a distributed atomic commit. We claim: (a) on every node each transaction is applied atomically in a single SQL transaction; (b) no node ever exposes half a transfer; (c) replicas may *lag* but apply in order; (d) cross-node durability is defined by the replication mode (Section 19). |
| D3 | Log entries carry **effects** (new balances, ledger lines, versions) | Replay is deterministic and verifiable (version checks); no business logic divergence. |
| D4 | Hash-chained log (`entry_hash = sha256(prev_hash ‖ lsn ‖ epoch ‖ payload)`) | Prefix equality can be checked with one hash comparison → cheap divergence detection by binary search. |
| D5 | Majority = 3 of 4 nodes | Epoch grants need 3 votes (including the candidate). Prevents two leaders (any two majorities intersect). Cost: with one node already down, a second failure halts promotion (writes unavailable) — chosen deliberately over risking split-brain. |
| D6 | Sync policy = **primary + designated backup + at least one more follower** (`SYNC_ACKS=2` follower acks, backup mandatory) | Acknowledged entries are on ≥ 3 nodes = a majority, so every promotion quorum overlaps them. |
| D7 | Async policy = ack after local commit | Fast; entries beyond `durable_lsn` can be lost on primary failure. Reported explicitly, never hidden. |
| D8 | Backup-first failover, election fallback | Gives "designated backup" real meaning while still exercising Bully/Ring. |
| D9 | Manual election performs a real leadership handover | No special "demo-only" election path: the winner runs the same promotion protocol. |
| D10 | Recovery = log replay | Divergent suffixes are archived (`divergent_log`) then state is rebuilt by replaying the surviving log prefix. No snapshots needed. |
| D11 | JSON-RPC metadata lives in `params._meta` / `result._meta` | Keeps messages valid JSON-RPC 2.0 while carrying Lamport/physical clocks, epoch, trace. |
| D12 | Leader lease self-fencing (`LEADER_LEASE_MS < FAILURE_TIMEOUT_MS`) | An isolated old primary stops accepting writes before others elect a successor (assumes bounded clock-rate drift). |

---

## 8. Docker Service Topology

| Service | Container name | Purpose | Port (host:container) | Depends on |
|---|---|---|---|---|
| `bank-cli` | `bank-cli` | Interactive terminal; run on demand with `docker compose run --rm bank-cli` | — | `bank-coordinator` |
| `bank-coordinator` | `bank-coordinator` | Gateway, health registry, leader tracker, load balancer, Berkeley time master | 8080:8080 | nodes healthy |
| `bank-node-a` | `bank-node-a` | Bank node A (`NODE_ID=a`) | 3001:3000 | `postgres-a` |
| `bank-node-b` | `bank-node-b` | Bank node B | 3002:3000 | `postgres-b` |
| `bank-node-c` | `bank-node-c` | Bank node C | 3003:3000 | `postgres-c` |
| `bank-node-d` | `bank-node-d` | Bank node D | 3004:3000 | `postgres-d` |
| `postgres-a..d` | `postgres-a..d` | One PostgreSQL 16 per node; volume `pgdata-a..d`; **not** published to the host by default | — | — |

**Additional services: none are strictly necessary.** Migrations run inside each node at startup (plain SQL files + a tiny runner using a `schema_migrations` table). Health checks use Compose `healthcheck`. No proxy, no broker.

**Network:** one user-defined bridge network `bank-net`. Hostnames are Docker DNS service names (`bank-node-a`, `postgres-a`, …). Each node's `DATABASE_URL` points **only** to its own Postgres with credentials unique to that database (`bank_a`/`pw_a`, …), so cross-wiring is detectable.

**Start-up order:** postgres (healthy) → nodes (healthy) → coordinator → CLI.

---

## 9. Four-Node Role and Leadership Model

### 9.1 Identity and ordering

`NODE_ID ∈ {a,b,c,d}` with fixed rank `a=1 < b=2 < c=3 < d=4`. Rank is the Bully priority and the Ring order (`a→b→c→d→a`). Membership is static (from `PEERS`).

### 9.2 Logical roles (never permanent)

| Role | Meaning | Accepts writes | Serves reads |
|---|---|---|---|
| `primary` | Holder of the current epoch's leadership and a valid lease | Yes | Yes (strong) |
| `backup` | Designated synchronous standby and preferred successor | No | Yes (if caught up) |
| `replica` | Ordinary follower | No | Yes (if caught up) |
| `recovering` | Just started, behind, diverged, or lost DB/lease; not eligible for routing | No | No |
| `candidate` (transient) | Running the promotion protocol | No | No |

**Bootstrap (fresh cluster only):** A is the primary, B the backup, C and D replicas. `BOOTSTRAP_PRIMARY=true` on A is honoured **only** if A's persisted `epoch = 0` and a majority of nodes reachable report `epoch = 0`; A then runs the normal promotion protocol to obtain epoch 1 and appends `EPOCH_START{epoch:1, backupId:"b"}`. After that, roles are determined solely by the protocols. The environment variable is ignored on every later start.

```mermaid
stateDiagram-v2
  [*] --> Recovering: process start
  Recovering --> Replica: leader found, log prefix matched, caught up
  Replica --> Backup: designated by primary
  Backup --> Replica: re-designated
  Replica --> Candidate: election won
  Backup --> Candidate: backup-first trigger
  Candidate --> Primary: majority grants + required log + EPOCH_START appended
  Candidate --> Replica: promotion refused
  Primary --> Recovering: higher epoch seen / lease lost / DB lost
  Replica --> Recovering: diverged / DB reconnected
  Backup --> Recovering: diverged / DB reconnected
```

### 9.3 Discovery, health, leader identification

- **Discovery:** static `PEERS` list resolved by Docker DNS. At start-up each node upserts `cluster_nodes` (node id, URL, rank).
- **Heartbeats:** every `HEARTBEAT_INTERVAL_MS` (1000) each node calls `cluster.heartbeat` on every peer with `{nodeId, role, epoch, promisedEpoch, leaderId, backupId, lastLsn, lastEpoch, durableLsn, replicationMode, dbHealthy, leaseValid}` plus Lamport/physical clock in `_meta`.
- **Failure detector:** a peer is *suspected* if no successful heartbeat for `FAILURE_TIMEOUT_MS` (4000). One successful heartbeat clears suspicion. This is an unreliable detector (it cannot distinguish a crashed node from a slow or partitioned one); epochs and leases provide safety, not the detector.
- **Leader identification:** each node stores `(epoch, leader_id)` in `node_state`. A heartbeat or `cluster.announceLeader` carrying a **higher** epoch is adopted (after verifying it is `≥ promised_epoch`). Exactly one leader per epoch is guaranteed by "one grant per node per epoch + majority".
- **Coordinator/CLI discovery:** the coordinator polls `cluster.getState` of all nodes each `LB_HEALTH_INTERVAL_MS` and also reacts to `NOT_PRIMARY` / `STALE_LEADER` errors by refreshing immediately. Leader = node reporting `role=primary` with the highest epoch and `leaseValid=true`.

### 9.4 Restart behaviour

| Situation | Behaviour |
|---|---|
| Replica/backup restarts | Starts `recovering`; discovers the leader; matches log prefix (hash compare); catches up via `replication.fetch`/append; becomes `replica`; becomes eligible for routing after `LB_RECOVERY_THRESHOLD` healthy checks within `READ_MAX_LAG_LSN`. |
| Old primary restarts after failover | Always starts `recovering` (never assumes primary). Sees higher epoch → follower; divergence check; archive divergent entries; replay; catch up. |
| Primary restarts quickly, no one took over | Starts `recovering`; after `DISCOVERY_WINDOW_MS` (5000) with no valid leader, the normal automatic election + promotion runs among reachable nodes (it may be A again if A holds the best log). |
| Full cluster restart | All `recovering`; discovery window expires; election among reachable nodes; the winner's promotion fetches the best log (highest `(lastEpoch,lastLsn)`) from the majority before promoting. |

---

## 10. Architecture Diagram

```mermaid
flowchart TB
  subgraph host["Developer laptop - Docker Engine"]
    DSOCK["/var/run/docker.sock"]
    subgraph net["Docker network: bank-net"]
      CLI["bank-cli<br/>terminal menu"]
      COORD["bank-coordinator<br/>gateway, health, leader tracker,<br/>load balancer, time master"]
      subgraph NA["Node A"]
        A["bank-node-a<br/>Express, JSON-RPC, workers"]
        PA[("postgres-a<br/>pgdata-a")]
      end
      subgraph NB["Node B"]
        B["bank-node-b"]
        PB[("postgres-b<br/>pgdata-b")]
      end
      subgraph NC["Node C"]
        C["bank-node-c"]
        PC[("postgres-c<br/>pgdata-c")]
      end
      subgraph ND["Node D"]
        D["bank-node-d"]
        PD[("postgres-d<br/>pgdata-d")]
      end
    end
  end
  CLI -->|"JSON-RPC"| COORD
  CLI -.->|"stop / kill / start"| DSOCK
  COORD -->|"JSON-RPC"| A
  COORD -->|"JSON-RPC"| B
  COORD -->|"JSON-RPC"| C
  COORD -->|"JSON-RPC"| D
  A --- PA
  B --- PB
  C --- PC
  D --- PD
  A -.-|"heartbeat, election, replication"| B
  A -.- C
  A -.- D
  B -.- C
  B -.- D
  C -.- D
```

---

## 11. Banking Data Model and Database Constraints

Each node has its **own** copy of these tables in its **own** database. Migrations live in `db/migrations/` and run at node start-up.

### 11.1 Core tables (`001_core.sql`)

```sql
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
```

*Deposit = one CREDIT line; withdrawal = one DEBIT line; transfer = DEBIT (source) + CREDIT (destination) with equal amounts. `balance` is a materialized view of the ledger; invariant I2 checks they agree.*

### 11.2 Replication and cluster tables (`002_replication.sql`, `003_cluster.sql`)

```sql
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
  last_ack_ms    INT,                               -- most recent send→ack latency
  duplicates     BIGINT NOT NULL DEFAULT 0,
  last_error     TEXT
);

CREATE TABLE replication_errors (
  id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  peer_id TEXT, lsn BIGINT, error_code TEXT NOT NULL, detail JSONB
);

CREATE TABLE divergent_log (                        -- archived entries removed during rejoin (audit of lost writes)
  id BIGSERIAL PRIMARY KEY, archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lsn BIGINT NOT NULL, epoch INT NOT NULL, entry_type TEXT NOT NULL,
  txn_id UUID, payload JSONB NOT NULL, entry_hash TEXT NOT NULL, reason TEXT NOT NULL
);

CREATE TABLE cluster_nodes (                        -- static membership + last observed state
  node_id TEXT PRIMARY KEY, rank INT NOT NULL UNIQUE, url TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ, last_role TEXT, last_epoch INT, last_lsn BIGINT, suspected BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE election_log (
  id BIGSERIAL PRIMARY KEY, election_id TEXT NOT NULL, algorithm TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('SENT','RECEIVED','LOCAL')),
  peer_id TEXT, message_type TEXT NOT NULL, lamport BIGINT NOT NULL, physical_ts BIGINT NOT NULL,
  detail JSONB
);

CREATE TABLE event_log (                            -- real service events: RPC, DB commit, clock, worker, routing
  id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  physical_ts BIGINT NOT NULL, lamport BIGINT NOT NULL,
  event_type TEXT NOT NULL, request_id TEXT, txn_id UUID, peer TEXT, detail JSONB
);
CREATE INDEX ON event_log (request_id);
```

Account-creation and balance-change effects are replicated; **`event_log`, `election_log`, `replication_peer_state`, `replication_errors`, `divergent_log` are node-local** (never replicated).

### 11.3 Entry types

| Entry type | Meaning |
|---|---|
| `ACCOUNT_CREATED` | New account row (and idempotency record; optional opening-deposit is a separate `TXN_COMMITTED` entry in the same request → two LSNs, sequential). |
| `TXN_COMMITTED` | Transaction row, ledger lines, account balance/version updates, idempotency result. |
| `TXN_REJECTED` | Transaction row with `REJECTED`, idempotency result; no balance change. |
| `CONFIG_CHANGE` | Replication mode, `syncAcks`, or `backupId` change (replicated so a new primary inherits policy). |
| `EPOCH_START` | First entry of every new epoch, appended by the new primary; carries `{epoch, leaderId, backupId}`. |

### 11.4 Banking invariants and how they are enforced

| ID | Invariant | PostgreSQL enforcement | Protocol enforcement |
|---|---|---|---|
| I1 | No negative balance (default no-overdraft policy) | `CHECK (balance >= 0)`; `UPDATE … SET balance = balance - $amt` after `FOR UPDATE` lock and explicit funds check | Rejected request becomes `TXN_REJECTED` |
| I2 | No floating-point money | `NUMERIC(14,2)`; amounts are strings validated by `^\d{1,12}(\.\d{1,2})?$` | JS never uses `Number` for money (lint test greps for it in `src/domain`, `src/txn`) |
| I3 | No partial update on failure | One SQL transaction per request: balances + transaction + ledger + log entry + idempotency result commit together or not at all | Followers apply each entry in one SQL transaction |
| I4 | Transfer debits and credits atomically | Both `UPDATE`s and both ledger lines in the same SQL transaction on the primary | Single log entry carries both effects; a replica never applies half |
| I5 | No double spend under concurrency | `SELECT … FOR UPDATE` on all involved accounts, in ascending `account_id` order (deadlock-free) before the funds check | Writes only on the primary; fencing prevents a second writer |
| I6 | Retries do not duplicate effects | `idempotency_key` PK/UNIQUE; claim-first `INSERT … ON CONFLICT DO NOTHING` | Idempotency rows are replicated, so retries after failover are still deduplicated |
| I7 | Every committed transaction is auditable | `transactions` + `ledger_entries` + `replication_log` rows with LSN, epoch, clocks, origin | Log is append-only, hash-chained; lost entries are archived in `divergent_log`, never silently dropped |
| I8 | Ledger/balance agreement | verified: `balance = Σ credits − Σ debits` per account | `verifyInvariants` on every node |
| I9 | Money conservation | verified: `Σ balances = Σ committed deposits − Σ committed withdrawals` | cross-node check at equal LSN |
| I10 | Replicas can detect missing/unapplied entries | gap-free LSN `1..last_lsn` (verified); `node_state.last_lsn` | `prevLsn/prevHash` check in `replication.append`; `replication.fetch` |
| I11 | Stale/ineligible node cannot become primary | `promised_epoch` persisted; DB-level fencing check inside every write transaction | Promotion requires majority grants + required log (Section 21.3) |
| I12 | Replicas converge | `state_checksum` = md5 over `(account_id, balance, version)` ordered by id | Compared across nodes at equal `last_lsn` |

---

## 12. Service Responsibilities

### 12.1 Services

| Service | Responsibilities | Must NOT |
|---|---|---|
| **bank-cli** | Menu, argument prompts, generates idempotency keys, calls the coordinator, renders traces/tables, drives fault injection (via coordinator RPC and Docker API), runs verdict assertions on real responses | Contain banking logic; print hardcoded results |
| **bank-coordinator** | Single entry point for the CLI; RPC gateway; node registry and health; leader tracker; routing (writes → leader; reads via load balancer); retries with the same idempotency key; Berkeley time master; aggregates cluster status | Hold balances, run SQL, decide leadership |
| **bank-node-X** (one image, `NODE_ID` parameter) | JSON-RPC server; banking executor; local PostgreSQL access; replication leader/follower roles; heartbeats and failure detector; election participant; promotion/fencing; clock and Lamport maintenance; worker pool; local invariant and checksum queries | Connect to another node's database; act as primary without a valid epoch/lease |
| **postgres-X** | Durable storage of one node's data | Be reachable by another node's code path (distinct credentials) |

### 12.2 Shared modules (one implementation, used by every experiment)

| Module | Responsibility |
|---|---|
| `src/txn/executor.js` | The **only** implementation of create/deposit/withdraw/transfer (Section 14). Used by RPC handlers *and* by worker threads. |
| `src/txn/logWriter.js` | Allocates LSN, builds payload, computes hash chain, writes log row — inside the caller's SQL transaction. |
| `src/replication/applier.js` | `applyEntry(client, entry)` — used by followers, by log replay during rejoin, and by tests. |
| `src/shared/rpc/*` | JSON-RPC client/server, envelope, error mapping, `_meta` handling (Lamport + trace). |
| `src/clocks/*` | Physical clock (offset/drift), Lamport clock, Berkeley algorithm. |
| `src/faulttolerance/epochs.js`, `promotion.js` | Epoch promises, fencing, promotion protocol, shared by election and failover. |
| `src/shared/events.js` | Writes `event_log` and returns request-scoped trace. |

### 12.3 Integration matrix (how experiments cooperate)

| Interaction | Mechanism |
|---|---|
| RPC ↔ banking | Every experiment menu calls the same `bank.*` RPC methods through the coordinator. A deposit made in menu 1 appears in menu 5 (replication view) because it is the same log entry. |
| Worker threads ↔ DB concurrency | Workers call `executor.execute()` on their own `pg` connections; correctness comes from row locks and the `node_state` row lock, not from JS. |
| Clocks ↔ messages | Every JSON-RPC request/response carries Lamport + physical timestamps in `_meta`; every transaction stores `lamport_ts` and `physical_ts_ms`. |
| Election ↔ leader discovery | Election winner runs promotion → epoch grants → `announceLeader`; the coordinator's leader tracker follows the highest epoch. |
| Replication ↔ commit | The commit path writes the log entry in the same SQL transaction; replicator ships from the `replication_log` table; sync mode awaits acknowledgements. |
| Load balancing ↔ health | Coordinator registry (fed by `cluster.getState`) defines eligible nodes; reads are balanced across them; writes go to the leader. |
| Promotion ↔ replication recovery | Promotion catches up via `replication.fetch` before opening for writes; rejoin uses hash-chain match + replay. |
| Idempotent retry | Same key across coordinator retries, failover and workers → one financial effect (Section 15.2). |

---

## 13. API and RPC Contract Overview

### 13.1 Transport

`POST /rpc` (JSON-RPC 2.0, `Content-Type: application/json`) on every node and on the coordinator. `GET /health` returns plain JSON for Docker health checks (`{nodeId, pid, hostname, dbHealthy, role, epoch}`).

**RPC vs. an ordinary REST endpoint.** REST addresses *resources* with HTTP verbs/URLs (`POST /accounts/1/deposits`) and signals outcome mainly through HTTP status codes. JSON-RPC addresses *procedures* (`bank.deposit`), has one endpoint, a uniform request/response envelope, a correlation `id`, and a structured `error` object, so a remote call reads like a local function call (`client.call('bank.deposit', params)`). It is still carried over HTTP; the distinction is the calling model, not the wire.

### 13.2 Envelope

```json
// request
{ "jsonrpc": "2.0", "id": "req-000102", "method": "bank.deposit",
  "params": { "accountId": "ACC-0001", "amount": "500.00", "currency": "INR",
              "idempotencyKey": "idem-6f1c…",
              "_meta": { "from": "coordinator", "lamport": 57, "physicalTs": 1767225600123,
                         "epoch": 1, "traceId": "trc-9d2a…" } } }

// success
{ "jsonrpc": "2.0", "id": "req-000102",
  "result": { "txnId": "9c1e…", "status": "COMMITTED", "lsn": 42, "epoch": 1,
              "balance": "10500.00", "durability": "LOCAL", "duplicate": false,
              "_meta": { "from": "node-a", "lamport": 61, "physicalTs": 1767225600131,
                         "trace": [ { "node": "node-a", "event": "rpc.received", "lamport": 59, "dtMs": 0 }, … ] } } }

// error
{ "jsonrpc": "2.0", "id": "req-000102",
  "error": { "code": -32005, "message": "NOT_PRIMARY",
             "data": { "leaderHint": "b", "epoch": 2, "_meta": { … } } } }
```

`_meta.trace` is assembled from real events emitted during the call (each hop appends its own events; the coordinator merges downstream traces). `dtMs` values come from monotonic timers (`process.hrtime`), not from the skewed application clock.

### 13.3 Method catalogue

| Namespace | Method | Params → Result (summary) | Runs on |
|---|---|---|---|
| bank | `createAccount` | `{holderName, openingDeposit?, idempotencyKey}` → `{accountId, lsn}` | primary |
| bank | `deposit` / `withdraw` | `{accountId, amount, idempotencyKey}` → `{txnId,status,lsn,balance,durability,duplicate}` | primary |
| bank | `transfer` | `{fromAccountId,toAccountId,amount,idempotencyKey}` → `{txnId,status,lsn,balances,…}` | primary |
| bank | `getBalance` / `getAccount` / `listAccounts` | `{accountId, consistency?, minLsn?, maxLagLsn?}` → data + `{servedBy, appliedLsn, leaderLastLsn, staleBy}` | any eligible node |
| bank | `getHistory` | `{accountId?, limit, beforeLsn?, consistency?}` → transactions | any eligible node |
| cluster | `heartbeat`, `getState` | state exchange (Section 9.3) | any |
| cluster | `requestEpoch`, `announceLeader` | promotion protocol (Section 21.3) | any |
| cluster | `setFault`, `getFaults`, `clearFaults` | fault injection (Section 22.2) | any (flag-gated) |
| election | `start`, `bully`, `bullyCoordinator`, `ringToken`, `ringCoordinator`, `getLog` | Section 18 | any |
| replication | `append`, `fetch`, `hashAt`, `status`, `leaderStatus`, `setMode`, `resend` | Section 19 | per method |
| clock | `get`, `setOffset`, `adjust` (node); `sync` (coordinator); `events` | Section 17 | node / coordinator |
| worker | `runBatch`, `getActivity` | Section 16 | primary (writes) |
| admin | `verifyInvariants`, `stateChecksum`, `getEvents`, `reset`, `crash` | local checks; `reset` requires all four nodes reachable | node |
| gateway (coordinator) | `gateway.call`, `gateway.clusterStatus`, `lb.setAlgorithm`, `lb.run`, `lb.stats` | CLI-facing | coordinator |

All methods validate params in `src/contracts/` (hand-written validators); invalid input returns `-32602` before any side effect.

### 13.4 Error codes

| Code | Name | Meaning | Retry? |
|---|---|---|---|
| -32700/-32600/-32601/-32602/-32603 | JSON-RPC standard | parse / invalid request / unknown method / invalid params / internal | no (fix request) |
| -32001 | `ACCOUNT_NOT_FOUND` | not recorded as a transaction | no |
| -32002 | `INSUFFICIENT_FUNDS` | recorded `REJECTED`; the stored result is replayed on retry | no |
| -32003 | `ACCOUNT_NOT_ACTIVE` | recorded `REJECTED` | no |
| -32004 | `IDEMPOTENCY_KEY_REUSED` | same key, different payload | no |
| -32005 | `NOT_PRIMARY` | `data.leaderHint` | yes, to the hinted leader |
| -32006 | `STALE_LEADER` | request/append epoch lower than promised epoch | refresh leader, retry |
| -32007 | `NO_LEADER` | coordinator found no valid leader within `LEADER_WAIT_MS` | later |
| -32008 | `INSUFFICIENT_REPLICAS` | sync mode pre-check failed; **nothing executed** | later, same key |
| -32009 | `REPLICATION_QUORUM_TIMEOUT` | committed locally, quorum not confirmed; `data.outcome = "INDETERMINATE"` | retry **same key** |
| -32010 | `DB_UNAVAILABLE` | local database down | other node / later |
| -32011 | `NODE_RECOVERING` | node not eligible | other node |
| -32012 | `PROMOTION_REFUSED` | `data.reason ∈ NO_QUORUM, STALE_CANDIDATE, LOG_MISMATCH` | n/a |
| -32013 | `REPLICATION_GAP` / `REPLICATION_DIVERGED` | follower response to `append` | leader rewinds / follower resyncs |
| -32015 | `WORKER_FAILED` | worker thread died; task retried with same key | automatic |
| -32016 | `READ_TOO_STALE` | `minLsn`/`maxLagLsn` not satisfied | other node / wait |
| client-side | `RpcTimeoutError`, `RpcNetworkError` | thrown by the client, never on the wire | per table below |

### 13.5 Timeouts and retry rules

| Call class | Timeout | Retry policy |
|---|---|---|
| Any RPC | `RPC_TIMEOUT_MS` = 2000 (client `AbortSignal.timeout`) | — |
| Write via coordinator | total `LEADER_WAIT_MS` = 15000 | up to 3 attempts to the **leader only**, **same idempotency key**; leader re-resolved after `NOT_PRIMARY`/`STALE_LEADER`/network error |
| Read via load balancer | per attempt 2000 | up to 2 retries on the **next eligible node**; each retry logged |
| Replication append | 2000 | exponential back-off 200 ms → 5 s, forever, while the peer is not suspected-dead for the sender's purposes (state `BACKOFF`) |
| Election messages | `BULLY_OK_TIMEOUT_MS` 2000 / `ELECTION_HOP_TIMEOUT_MS` 1500 | protocol-specific (Section 18) |

A timed-out write is **indeterminate** to the client; safety comes from retrying with the same idempotency key.

---

## 14. Banking Transaction Lifecycle

```mermaid
sequenceDiagram
  autonumber
  participant CLI as bank-cli
  participant CO as bank-coordinator
  participant P as Primary node (epoch e)
  participant DB as Primary Postgres
  participant F as Followers (B, C, D)
  CLI->>CO: bank.deposit {key K}
  CO->>CO: resolve leader (tracker)
  CO->>P: bank.deposit {key K, _meta.epoch=e}
  P->>DB: BEGIN
  P->>DB: claim idempotency key K
  P->>DB: lock accounts FOR UPDATE (ordered)
  P->>DB: validate, UPDATE balance, lock node_state, allocate LSN
  P->>DB: INSERT transaction, ledger, replication_log, UPDATE idempotency result
  P->>DB: COMMIT
  Note over P,F: commit order == LSN order
  par replicate
    P-)F: replication.append {entries}
    F--)P: ack {appliedLsn}
  end
  alt SYNC mode
    P->>P: wait until backup + (SYNC_ACKS-1) followers acked, or SYNC_TIMEOUT_MS
  else ASYNC mode
    P->>P: no wait
  end
  P-->>CO: result {lsn, durability}
  CO-->>CLI: result + merged trace
```

### 14.1 Executor algorithm (`executeBankOperation`)

```
BEGIN                                    -- READ COMMITTED
1  claim:  INSERT INTO idempotency_keys(key, operation, request_hash) ON CONFLICT DO NOTHING
           if conflict → SELECT row (waits for the competing transaction to finish):
              request_hash differs → ROLLBACK, error IDEMPOTENCY_KEY_REUSED
              else → ROLLBACK, return stored result with duplicate=true (and wait for durability if still pending)
2  lock:   SELECT … FROM accounts WHERE account_id = ANY($ids) ORDER BY account_id FOR UPDATE
3  check:  accounts exist / ACTIVE / funds sufficient
           missing account → ROLLBACK, ACCOUNT_NOT_FOUND (not recorded)
           business rejection → continue as REJECTED (no balance changes, no ledger lines)
4  apply:  UPDATE accounts SET balance = balance ± $amt, version = version + 1, … RETURNING balance, version
5  fence:  SELECT last_lsn, last_hash, role, epoch, promised_epoch FROM node_state WHERE id=1 FOR UPDATE
           require role='primary' AND epoch = promised_epoch (and writeGate open) else ROLLBACK, NOT_PRIMARY / STALE_LEADER
6  log:    lsn = last_lsn+1; build payload (effects); entry_hash = sha256(last_hash‖lsn‖epoch‖payload)
           INSERT transactions, ledger_entries, replication_log; UPDATE idempotency_keys SET result, lsn;
           UPDATE node_state SET last_lsn, last_epoch, last_hash
COMMIT
7  notify replicator; if SYNC: await quorum; return result
```

Why this is safe and fast enough:

- **Fencing is inside the database transaction.** A promotion grant (`cluster.requestEpoch`) must update `node_state.promised_epoch`, which needs the same row lock held by step 5. A grant therefore waits for in-flight writes to commit, and any later write fails the epoch check. This is the "drain" step of a handover.
- **Commit order = LSN order.** The `node_state` lock is taken last (step 5) and held until COMMIT; transactions on *different* accounts overlap in steps 2–4 and serialize only for the short log-append step. Documented limitation: peak write throughput is bounded by this serialization.
- **Deadlock-free:** account locks are always taken in ascending ID order, then `node_state` last.

### 14.2 Transaction states (client-visible)

`REQUESTED → ROUTED → EXECUTING → COMMITTED_LOCAL → REPLICATING → DURABLE` (success), `REJECTED` (business rejection, replicated), `INDETERMINATE` (`REPLICATION_QUORUM_TIMEOUT` or lost response; resolved by retrying the same key). Response field `durability`: `LOCAL` (async ack), `QUORUM` (sync ack, entry on ≥ 3 nodes).

---

## 15. Transaction Integrity and Idempotency Strategy

### 15.1 Atomicity statement

- **Single node:** all state changes for a request, including its log entry, commit atomically in one PostgreSQL transaction.
- **Across nodes:** there is **no** atomic commit across databases. The commit point of a transaction is the primary's local `COMMIT`. Replicas apply the same entry later, atomically, in order. During replication a replica may lag but never shows half a transaction.
- **Sync mode** adds a *durability* gate (client is told success only after ≥ 3 nodes hold the entry); it is not a distributed commit protocol. If the gate fails, the transaction is already committed on the primary and the response is `INDETERMINATE` (Section 22, F9).

### 15.2 Idempotency

| Scenario | Outcome |
|---|---|
| Same key, same payload, original committed | Stored result returned, `duplicate=true`, no new LSN |
| Same key, same payload, original in flight (concurrent) | Second transaction blocks on the unique index until the first finishes, then returns its result |
| Same key, different payload | `IDEMPOTENCY_KEY_REUSED` |
| Retry after a timeout where the primary actually committed | Duplicate path; no second effect |
| Retry after failover, entry was replicated | New primary has the idempotency row (it is part of the replicated effects) → duplicate path |
| Retry after failover, entry was *not* replicated (lost) | Executes once on the new primary; the old copy is archived in `divergent_log` on rejoin → exactly one effect in the surviving history |
| Rejected request retried | Stored `REJECTED` result replayed (balance is **not** re-evaluated) |

Keys are generated by the CLI (`idem-<uuid>`) per user action, so every layer (CLI retry, coordinator retry, failover retry, worker retry) reuses the same key.

### 15.3 Ordering and concurrency rules

1. Lock accounts in ascending ID order, then `node_state`.
2. Never hold a DB transaction open across a network call to another node.
3. Replication shipping runs from committed rows, never inside the executor transaction.
4. All timestamps used for ordering inside the protocol are LSNs/epochs; clocks are metadata only.

---

## 16. Multithreading Implementation (Experiment 2)

Node.js asynchronous I/O and many simultaneous Express requests are **not** multithreading (one JavaScript thread interleaves them). This experiment uses real `worker_threads`: separate V8 isolates on separate OS threads, each with its **own PostgreSQL connection**.

### 16.1 Design

- Every node contains a worker pool (`src/workers/pool.js`). Only the primary accepts the writes (the DB fence in executor step 5 enforces it), so batches are run on the primary via `worker.runBatch`.
- **Pool size:** `WORKER_POOL_SIZE` (default 4, max 16); a batch may request fewer workers. Workers are created on first use and reused.
- **Worker:** `src/workers/worker.js` creates `new pg.Pool({ max: 1 })` from `DATABASE_URL`, imports `src/txn/executor.js` (same code as RPC), and processes tasks sent by the main thread.
- **Ordinary RPC requests stay on the main thread** (I/O-bound, async). Both paths call the same `executor.execute()`.

### 16.2 Lifecycle and task distribution

```mermaid
sequenceDiagram
  participant M as Main thread (node-a)
  participant W1 as Worker 1
  participant W2 as Worker 2
  participant DB as postgres-a
  M->>W1: spawn(workerId=1, sharedBarrier)
  M->>W2: spawn(workerId=2, sharedBarrier)
  W1-->>M: ready (threadId, pg backend pid)
  W2-->>M: ready (threadId, pg backend pid)
  M->>M: Atomics.store(barrier,1); Atomics.notify
  par released together
    W1->>DB: BEGIN; SELECT … FOR UPDATE; UPDATE; COMMIT
  and
    W2->>DB: BEGIN; SELECT … FOR UPDATE (waits if same row)
  end
  W1-->>M: result {requestId, status, lsn, timings}
  W2-->>M: result {requestId, status, lsn, timings}
```

1. Main builds the task list (each task has `taskId`, `requestId`, `operation`, params, **`idempotencyKey`**).
2. Workers are spawned or reused; each posts `ready` with `threadId`, `pgPid` (`SELECT pg_backend_pid()`) and blocks in `Atomics.wait` on a `SharedArrayBuffer` **start barrier**.
3. Main releases the barrier (`Atomics.store` + `Atomics.notify`) so all workers begin simultaneously — the primary proof of concurrency (no `sleep`).
4. Distribution: `static` (task *i* → worker *i mod W*, all released at once; used by the conflict tests) or `dynamic` (worker posts `next`, main replies with the next task; used by the stress test).
5. Each worker reports `{taskId, requestId, workerId, threadId, pgPid, tStartNs, tEndNs, lockWaitMs, status, errorCode, lsn, balanceAfter}`. Time values use `process.hrtime.bigint()` relative to the barrier release.
6. In SYNC mode a worker posts `awaitDurable{lsn}`; main resolves it when the replicator's acknowledgement tracker reaches `lsn`. Replication itself runs in the main thread from committed log rows.

### 16.3 Concurrency control

| Concern | Mechanism |
|---|---|
| Two workers touch the same account | `SELECT … FOR UPDATE` serializes them; the loser re-reads the committed balance when it gets the lock |
| Transfers in opposite directions | Ordered locking (ascending ID) — no deadlock |
| LSN allocation | `node_state` row lock, taken last |
| Duplicate task execution | Idempotency key per task |
| `lockWaitMs` | Measured around the `FOR UPDATE` statement (real wait) |

*Optional contention proof:* `holdAfterLockMs` (fault knob, default 0) makes the winner hold its row lock for *n* ms **inside the transaction**; the loser's measured `lockWaitMs` must then be ≥ *n*. It supplements, never replaces, the barrier-based proof.

### 16.4 Failure handling

- Worker `error`/non-zero `exit`: tasks assigned to it become `WORKER_FAILED`, are re-queued up to 2 times with the **same** idempotency key (if the dead worker had committed, the retry returns `duplicate=true`), and a replacement worker is spawned.
- `workerCrashOnTask=<taskId>` (fault knob) calls `process.exit(1)` inside the worker after it has acquired row locks, so PostgreSQL rolls back the open transaction (visible in the verification).
- Batch-level timeout `BATCH_TIMEOUT_MS` (30000); unfinished tasks are reported `TIMEOUT` (outcome unknown → verify by key).

### 16.5 `worker.runBatch`

```json
{ "operations": [ { "type":"withdraw", "accountId":"ACC-0001", "amount":"2000.00" } ],
  "workers": 4, "distribution": "static", "scenario": null }
```
Result: per-task rows (above), `summary {requests, succeeded, rejected, failed, durationMs, throughputPerSec, perWorker[]}`, `balancesAfter`, `invariants` (result of `admin.verifyInvariants`).

**Built-in scenarios** (`scenario` parameter; accounts are created fresh by the experiment, idempotency keys auto-generated):

| Scenario | Setup | Expected |
|---|---|---|
| `parallel-withdrawals` | balance ₹10,000; 4 workers × withdraw ₹2,000 | 4 succeed; final ₹2,000 |
| `conflicting-withdrawals` | balance ₹5,000; 2 workers × withdraw ₹4,000 | exactly 1 `COMMITTED`, 1 `REJECTED(INSUFFICIENT_FUNDS)`; final ₹1,000 |
| `stress` | `requests` N (default 200), `workers` W, mixed deposit/withdraw/transfer across `accounts` K | Σ balances = initial + deposits − withdrawals; no negative balance; no duplicate LSN |
| `duplicate-flood` | 10 concurrent tasks with the **same** idempotency key | exactly 1 effect, 9 `duplicate=true` |
| `worker-crash` | as `parallel-withdrawals` with a crash fault | final balance still ₹2,000 (no double or lost debit) |

**Evidence that threads are genuine:** distinct `threadId` per worker, `isMainThread=false` logged, distinct `pg_backend_pid`, overlapping `[tStart, tEnd]` intervals, and (optionally) `pg_stat_activity` showing multiple connections from the node.

---

## 17. Physical and Logical Clock Implementation (Experiment 3)

### 17.1 Honest model

Containers share the host kernel clock, so real wall clocks are not independent. Each service therefore owns an **application-managed physical clock**:

```
physicalNow() = max(lastIssued, Date.now() + offsetMs + driftPpm × 1e-6 × (Date.now() − t0))
```

`offsetMs` and `driftPpm` are configured per node (`CLOCK_OFFSET_MS`, `CLOCK_DRIFT_PPM`) and changeable at runtime (`clock.setOffset`). `physicalNow()` is the **only** time source for protocol timestamps (`physical_ts`, `_meta.physicalTs`, `transactions.physical_ts_ms`), so injected skew genuinely affects stored data. The `max(lastIssued, …)` guard keeps each node's clock non-decreasing after backward adjustments. Monotonic timers (`hrtime`) are used only for durations. The coordinator and CLI have their own application clocks (`COORDINATOR_CLOCK_OFFSET_MS`).

### 17.2 Berkeley synchronization

Chosen because there is no authoritative time server: the coordinator is the **time master** and averages the group (including itself).

Assumptions: network delay is roughly symmetric (error bound ≈ RTT/2); nodes respond truthfully; adjustments change only application clocks.

Algorithm (`clock.sync` on the coordinator, every node queried over real RPC):

1. For each reachable node *i*: `t0 = hrtime`; call `clock.get` → node time `Tᵢ`; `t1 = hrtime`; `RTTᵢ = t1 − t0`; master clock reading at response time `Mᵢ = master.physicalNow()`.
2. Estimated offset: `δᵢ = (Tᵢ + RTTᵢ/2) − Mᵢ`. Master has `δ = 0`.
3. Discard nodes with `|δᵢ| > BERKELEY_OUTLIER_MS` (default 10000) from the average (still reported).
4. `avg = mean(δ of master and kept nodes)`.
5. Adjustment for node *i*: `adjᵢ = avg − δᵢ`; master: `avg − 0`. Send `clock.adjust{deltaMs: adjᵢ, syncId}`; each node adds it to `offsetMs` (backward adjustments are absorbed by the monotonic guard).
6. Verify: query all clocks again; report residual spread. Because injected offsets are known, the CLI also reports `injectedOffset`, `estimatedOffset`, `estimationError` (expected ≈ jitter ≤ RTT/2).

### 17.3 Lamport logical clocks

Every service (nodes, coordinator, CLI) has `LamportClock { value }`:

| Event | Rule |
|---|---|
| Local event (DB commit, state change, election step) | `value += 1` |
| Send (RPC request or response) | `value += 1`; put `value` in `_meta.lamport` |
| Receive | `value = max(value, msg.lamport) + 1` |

The Lamport value at transaction commit is stored in `transactions.lamport_ts` and `replication_log.lamport`. Every notable event is written to `event_log` `(lamport, physical_ts, event_type, request_id, peer)`.

**Displaying ordering:** the CLI collects `clock.events` from all nodes for a chosen request or time window and prints two orderings side by side: by `(physicalTs)` and by `(lamport, nodeId)`. With skew present the physical ordering can place a *receive* before its *send*; Lamport order never does. Lamport ordering is consistent with causality but concurrent events are ordered arbitrarily (tie-break by node rank); the output marks events with no causal path as concurrent when `sent→received` chains do not connect them.

---

## 18. Bully and Ring Election Implementations (Experiment 4)

Both algorithms run between the four node processes over JSON-RPC. Every message is logged on both ends in `election_log` with election ID, sender, receiver, type, Lamport time and result.

### 18.1 Common rules

- `electionId = "<epochSeen+1>-<initiatorId>-<lamport>"`.
- Rank order a < b < c < d. A node only participates if its DB is healthy and it is not in the message's `excluded` set (ineligible nodes after a refused promotion, TTL 30 s).
- **Triggers:** (1) automatic: failure detector marks the primary down and the backup-first grace period expires without a new leader (Section 21.2); (2) manual: CLI → `election.start{algorithm, excluded?}`; (3) discovery window expiry after cluster restart.
- **Outcome:** the winner is the *election coordinator*. It then runs the **promotion protocol** (Section 21.3). An election result alone never changes who accepts writes.
- Manual election with a healthy primary performs a genuine **leadership handover** (winner obtains a higher epoch; the old primary fences itself, drains in-flight writes and becomes a follower).

### 18.2 Bully

| Message | Direction | Meaning |
|---|---|---|
| `ELECTION{electionId, fromId, excluded}` | to every **higher-rank** node | "I am starting an election" |
| `OK{electionId, fromId}` | reply (JSON-RPC response) | "I am higher and alive; I take over" |
| `COORDINATOR{electionId, winnerId, epochSeen}` | to all nodes | winner announcement |

Procedure for initiator *n*:
1. Send `ELECTION` to all nodes with rank > *n* (parallel, timeout `BULLY_OK_TIMEOUT_MS` = 2000).
2. If any `OK` arrives: *n* stops; it waits `COORDINATOR_WAIT_MS` (5000) for a `COORDINATOR` message, else restarts the election.
3. A node receiving `ELECTION` from a lower rank replies `OK` and starts its own election (if not already running).
4. If no `OK` arrives, *n* sends `COORDINATOR` to everyone and calls promotion.

**Highest-ID failure:** with D stopped, B's `ELECTION` to C and D: D times out, C answers `OK`; C's own election to D times out, so C announces itself. If C is also down, B wins.

### 18.3 Ring

Logical ring: `a → b → c → d → a`.

| Message | Meaning |
|---|---|
| `RING_TOKEN{electionId, initiatorId, candidates[], excluded}` | collects live participants |
| `RING_COORDINATOR{electionId, winnerId, members[]}` | announces the winner around the ring |

Procedure:
1. Initiator creates the token with its own ID and sends it to its successor.
2. Each node appends its ID and forwards to its successor. The RPC **response** is an immediate acknowledgement of receipt (the forwarding happens asynchronously, avoiding nested long calls). If the successor does not acknowledge within `ELECTION_HOP_TIMEOUT_MS` (1500), the node **skips** it and tries the next successor (logged `SKIPPED`).
3. When the token returns to the initiator, the winner = highest rank in `candidates` (excluding `excluded`).
4. Initiator sends `RING_COORDINATOR` around the ring; each node records `(electionId, winnerId)` and forwards. The election ends when it returns to the initiator; the winner calls promotion.
5. If no completion arrives within `RING_TIMEOUT_MS` (8000), the initiator restarts with a new election ID (max 3 attempts).

### 18.4 Competing elections

- Bully: a lower-rank initiator is suppressed by `OK` from higher ranks; only the highest alive initiator completes.
- Ring: concurrent tokens are all valid; they produce the same winner (highest alive rank). A node that already recorded a `RING_COORDINATOR` for the same winner and epoch ignores duplicates.
- Both: promotion is still gated by one-grant-per-epoch (Section 21.3); duplicate winners cannot both obtain a majority.

### 18.5 Election safety vs. promotion safety; split-brain

| Risk | Mitigation |
|---|---|
| A stale node wins the election | Election carries no authority. Promotion requires majority grants **and** the candidate's log ≥ required position; otherwise `PROMOTION_REFUSED`, the winner is excluded, election reruns. |
| Two leaders in one epoch | One grant per node per epoch; majority = 3 of 4. |
| Old leader alive in a minority partition | Lease self-fencing (3000 ms < 4000 ms detector timeout); DB-level epoch fence; replicas reject `append` with a stale epoch (`STALE_LEADER`). |
| Delayed messages from an old epoch | Every message carries an epoch; lower than `promised_epoch` ⇒ rejected. |
| Election storms | Randomized start jitter (0–500 ms) and the backup-first grace period. |

Assumption: clock *rates* (not absolute time) are roughly equal so that lease expiry precedes detector expiry. This cannot be guaranteed in a truly asynchronous network; documented in Section 31.

---

## 19. Replication Protocol and Consistency Modes (Experiment 5)

### 19.1 Overview

Application-level state-machine replication. The primary's `replication_log` is shipped to the three other nodes with `replication.append`. No PostgreSQL replication feature is used; every follower writes to its **own** database.

### 19.2 Log entry format

```json
{ "lsn": 42, "epoch": 1, "entryType": "TXN_COMMITTED", "txnId": "9c1e…", "originNode": "a",
  "lamport": 59, "physicalTs": 1767225600129, "committedAt": "2026-03-01T10:00:00.129Z",
  "prevHash": "…", "entryHash": "…",
  "payload": {
    "txn": { /* complete `transactions` row */ },
    "ledger": [ { "lineNo": 1, "accountId": "ACC-0001", "direction": "CREDIT", "amount": "500.00", "balanceAfter": "10500.00" } ],
    "accounts": [ { "accountId": "ACC-0001", "balance": "10500.00", "version": 7 } ],
    "idempotency": { "key": "idem-…", "operation": "deposit", "requestHash": "…", "result": { /* stored response */ } } } }
```

`entryHash = sha256(prevHash ‖ lsn ‖ epoch ‖ canonicalJSON(payload))` (keys sorted). LSNs are gap-free and strictly monotonic (`last_lsn + 1` under the `node_state` lock).

### 19.3 Follower: `replication.append`

Params: `{epoch, leaderId, prevLsn, prevHash, entries[], leaderLastLsn, durableLsn}`. In one SQL transaction (`node_state … FOR UPDATE`):

1. `epoch < promised_epoch` → error `STALE_LEADER` (nothing applied). Otherwise adopt `epoch`, `leader_id`; if the node was `primary` of a lower epoch, step down.
2. Continuity: if `prevLsn > last_lsn` → `{ok:false, reason:"GAP", lastLsn}`. If `prevLsn ≤ last_lsn` and the local hash at `prevLsn` ≠ `prevHash` → `REPLICATION_DIVERGED`.
3. For each entry in order: `lsn ≤ last_lsn` → compare `entryHash`; equal ⇒ **duplicate** (skipped, counted); different ⇒ `DIVERGED`. `lsn = last_lsn+1` ⇒ verify `prevHash` and `entryHash`, `applyEntry`, insert log row, update `node_state`. Any other `lsn` ⇒ `GAP`.
4. `applyEntry` inserts/updates rows exactly as recorded and **verifies** `version = expectedPrevious + 1`; a mismatch aborts the transaction (`APPLY_MISMATCH` → follower becomes `recovering` and resyncs).
5. Reply `{ok:true, appliedLsn, lastHash, duplicates}` and update `durable_lsn` from the request.

### 19.4 Leader: sender loop and acknowledgement tracking

One sender per follower (`src/replication/leaderReplicator.js`) with state `STREAMING | BACKOFF | REWIND | NEEDS_RESYNC` in `replication_peer_state`.

- Reads entries `> match_lsn` from `replication_log` in batches (≤ 100), sends `append`, applies fault-injection delay/drop hooks on the send path.
- On `ok`: `match_lsn = appliedLsn`; compute acknowledgement latency; recompute `durable_lsn`.
- On `GAP{lastLsn}`: set `next_lsn = lastLsn+1` (REWIND) and resend; on `DIVERGED`: mark `NEEDS_RESYNC` (follower handles its own rejoin, Section 21.7); on timeout/network error: `BACKOFF` (200 ms → 5 s), log to `replication_errors`.
- Acks are **cumulative**: `match_lsn ≥ n` acknowledges all entries ≤ n.
- Heartbeats also carry `lastLsn` so lagging followers pull (`replication.fetch`) if the leader is silent.

**`durable_lsn`** = the highest LSN *n* such that the designated backup and at least `SYNC_ACKS − 1` further followers have `match_lsn ≥ n` (i.e., present on ≥ 3 nodes with the primary). It is computed in both modes; it is *informational* in ASYNC and *gating* in SYNC.

### 19.5 Synchronous mode (`REPLICATION_MODE=SYNC`)

| Aspect | Definition |
|---|---|
| Success condition | Local COMMIT **and** `durable_lsn ≥ lsn` within `SYNC_TIMEOUT_MS` (3000) |
| Required acks | Designated backup (mandatory) + ≥ 1 other follower (`SYNC_ACKS=2`) |
| Pre-check | If fewer than the required healthy followers (per the primary's failure detector) exist, reject up-front with `INSUFFICIENT_REPLICAS` — **no execution, no state change** |
| Timeout after commit | Return `REPLICATION_QUORUM_TIMEOUT` with `outcome:"INDETERMINATE"`, `lsn`, `txnId`. The entry stays in the log and keeps replicating. A retry with the same key returns the stored result as soon as `durable_lsn ≥ lsn` |
| Backup unavailable | Primary detects the backup as suspected for `FAILURE_TIMEOUT_MS`, appends `CONFIG_CHANGE{backupId: next healthy follower with highest match_lsn}`; until then sync writes fail fast with `INSUFFICIENT_REPLICAS` |
| Caveat | The primary's own reads and its local state include entries not yet quorum-durable (an in-flight sync write is visible locally before its ack). Documented limitation: reading only quorum-durable state is not offered. |

### 19.6 Asynchronous mode (`REPLICATION_MODE=ASYNC`)

Success after local COMMIT (`durability:"LOCAL"`). Shipping is continuous in the background; the backup is served first in each cycle, then the others, at interval `ASYNC_BATCH_INTERVAL_MS` (100) or immediately on commit. Fault knobs (Section 22.2) delay or block shipping, making lag and later convergence observable and repeatable.

### 19.7 Reads and staleness

| Read option | Served by | Staleness |
|---|---|---|
| `consistency="strong"` (default for `bank.getBalance` via CLI banking menus) | primary only | none w.r.t. committed local state |
| `"bounded"` + `maxLagLsn` | primary or follower whose `leaderLastLsn − appliedLsn ≤ maxLagLsn` | ≤ `maxLagLsn` entries behind |
| `"eventual"` | any eligible node | arbitrary lag (ASYNC); in SYNC, entries are guaranteed only on the backup and ≥ 1 other follower |
| `minLsn` (read-your-writes) | any node whose `appliedLsn ≥ minLsn` (waits up to 1000 ms else `READ_TOO_STALE`) | none relative to the client's last write |

Every read returns `servedBy`, `appliedLsn`, `leaderLastLsn`, `staleBy`.

### 19.8 What survives a primary failure

| Configuration | Acknowledged transactions | Notes |
|---|---|---|
| SYNC (default `SYNC_ACKS=2`) | Present on primary + backup + ≥ 1 follower (≥ 3 of 4). Any promotion quorum (3 grants) overlaps them, and promotion fetches the best log, so **no acknowledged transaction is lost on a single-node failure**. | A second simultaneous failure halts writes (no quorum) rather than losing data. Data is lost only if every copy is destroyed (e.g., volumes deleted). |
| ASYNC | Only entries `≤ durable_lsn` are guaranteed. Entries in `(durable_lsn, lastLsn]` may exist only on the failed primary. | The failover report prints the **possible loss window** (LSNs and transaction IDs from the old primary's last heartbeat) and, after the old primary rejoins, the archived `divergent_log` rows. |

### 19.9 Lag, pending work, errors

- `lagLsn(peer) = leader.last_lsn − peer.match_lsn`.
- `lagMs(peer)` = age (monotonic) of the oldest entry sent or pending but not yet acknowledged.
- `pending(peer)` = count of entries with `lsn > match_lsn`.
- Errors: `replication_errors` (timeouts, gaps, divergence, apply mismatch).
- **Convergence** = all four nodes have equal `last_lsn` **and** equal `state_checksum`.

### 19.10 Reconciliation and recovery

| Situation | Handling |
|---|---|
| Replica was offline | Starts `recovering`; hash-match its tail with the leader (`replication.hashAt`); leader's sender streams from `match_lsn+1` |
| Missing record detected (gap) | `GAP` reply → leader rewinds; or follower pulls with `replication.fetch{fromLsn,toLsn}` |
| Duplicate delivery | LSN/hash check; skipped; counted in `duplicates` |
| Out-of-order delivery | `GAP`; entries beyond `last_lsn+1` are never applied |
| Divergent suffix (old primary) | Section 21.7 |
| Fault test hooks | `replication.resend{toPeer, fromLsn, toLsn}` (re-sends already applied entries to prove duplicate handling) |

### 19.11 Mode changes

`replication.setMode{mode, syncAcks}` on the primary appends `CONFIG_CHANGE` (replicated). Switching ASYNC → SYNC takes effect for new writes; the primary first waits (bounded) for `durable_lsn == last_lsn` so that the guarantee starts from a clean point.

---

## 20. Load Balancing Algorithms (Experiment 6)

Implemented in the **coordinator** (`src/coordinator/loadBalancer/`). Every selected node receives a genuine JSON-RPC request.

### 20.1 Node registry and health

- Poll `cluster.getState` on all nodes every `LB_HEALTH_INTERVAL_MS` (1000), timeout 1000 ms. Record `{role, epoch, appliedLsn, leaderLastLsn, dbHealthy, state, latencyMs}`.
- **Unhealthy:** `LB_UNHEALTHY_THRESHOLD` (2) consecutive failures, or any request-time network error (passive check), or `dbHealthy=false`, or `role=recovering`.
- **Recovered:** `LB_RECOVERY_THRESHOLD` (3) consecutive successful polls **and** `role ∈ {primary, backup, replica}` **and** lag ≤ `READ_MAX_LAG_LSN` (default 5).

### 20.2 Eligibility

| Request | Eligible nodes |
|---|---|
| Write (`createAccount`, `deposit`, `withdraw`, `transfer`, `worker.runBatch`) | **Only the current leader.** Strategy is `LEADER_ONLY`. The load-balancing algorithm is **not** applied to writes. |
| Read `consistency=strong` | Leader only |
| Read `bounded` | Leader + followers within `maxLagLsn` |
| Read `eventual` | All healthy, non-recovering nodes |

### 20.3 Algorithms (over the eligible list sorted by node ID)

- **Round Robin:** a pointer `rr` advances per selection and skips ineligible nodes; counters are per algorithm run.
- **Least Connections:** `active[node]` is incremented immediately before the RPC is sent and decremented in a `finally` block (success, error or timeout). Select `argmin(active)`; ties → lowest `totalServed`, then lowest ID.

### 20.4 Retries, logging, measurement

- Read failure (network error/timeout/`NODE_RECOVERING`): mark node suspect, retry on the next eligible node (≤ 2 retries); each attempt logged.
- Write failure: retried **only** against the (re-resolved) leader with the same key.
- Decision log line (also stored in `event_log` on the coordinator): `{seq, requestId, op, algorithm, eligible[], activeSnapshot, selected, attempt, status, latencyMs}`.
- `lb.run{algorithm, requests, concurrency, mix}` issues real traffic, then `lb.stats` returns per-node: requests, active, failures, retries, p50/p95 latency, share %.
- **Equal counts ≠ equal workloads:** requests differ in cost (`getBalance` vs. `getHistory limit=500`) and nodes differ in speed (fault knob `rpcDelayMs`). Round Robin equalizes counts; Least Connections equalizes in-flight work. The CLI shows both count share and cumulative busy time per node.

---

## 21. Primary-Backup Failover and Recovery (Experiment 7)

### 21.1 What is replicated to the backup

Everything: the full ordered log (accounts, transactions, ledger, idempotency records, config, epoch starts). The backup is replicated first in every cycle, and in SYNC mode its acknowledgement is mandatory. All four nodes hold the complete state; "backup" is a privilege (sync standby, preferred successor), not a different data set.

### 21.2 Detection and candidate selection

1. **Monitoring:** all nodes heartbeat each other (1 s). The primary is *suspected* by a node after 4 s without a heartbeat response, or immediately on `DB unhealthy` announced by the primary, or when its lease is reported lost.
2. **Backup-first:** the designated backup (`backup_id`, known to all) starts the promotion protocol immediately on suspicion.
3. **Fallback:** other nodes wait `BACKUP_GRACE_MS` (5000) after their own suspicion. If no higher epoch with a live leader appears, they run the configured election (`ELECTION_ALGORITHM` = `bully` or `ring`) among eligible nodes; the winner runs promotion.
4. **Refused winner:** if promotion is refused, the winner is added to `excluded` and the election reruns.

### 21.3 Promotion protocol (`src/faulttolerance/promotion.js`)

```mermaid
sequenceDiagram
  participant Cand as Candidate
  participant P1 as Peer 1
  participant P2 as Peer 2
  participant Old as Old primary (maybe dead)
  Cand->>Cand: E' = max(promised_epoch, epoch) + 1; persist promised_epoch = E'
  par request grants
    Cand->>P1: cluster.requestEpoch{E', lastEpoch, lastLsn, lastHash}
    Cand->>P2: cluster.requestEpoch{E', …}
    Cand--xOld: cluster.requestEpoch (timeout if dead)
  end
  P1-->>Cand: granted {lastEpoch, lastLsn, durableLsn}
  P2-->>Cand: granted {…}
  Cand->>Cand: grants >= 3 of 4 (incl. self)?
  Cand->>P1: replication.fetch (missing entries, from best log)
  P1-->>Cand: entries
  Cand->>Cand: verify hash chain, apply, check lastLsn >= required
  Cand->>Cand: append EPOCH_START{E', leaderId, backupId}; role = primary
  Cand-)P1: cluster.announceLeader{E'}
  Cand-)P2: cluster.announceLeader{E'}
```

1. **Propose:** candidate picks `E' = max(promised_epoch, epoch) + 1` and persists `promised_epoch = E'`.
2. **Grants:** it sends `cluster.requestEpoch{epoch:E', candidateId, lastEpoch, lastLsn, lastHash}` to all peers. A peer grants only if `E' > its promised_epoch`; it then persists `promised_epoch = E'` (this needs the `node_state` lock ⇒ waits for in-flight writes: if it is the old primary it **stops accepting writes and steps down** once drained), and replies `{granted:true, lastEpoch, lastLsn, durableLsn}`; otherwise `{granted:false, promisedEpoch}`.
3. **Quorum:** grants (including self) must be ≥ **3**. Otherwise `PROMOTION_REFUSED(NO_QUORUM)`. (If the refusal was due to a competing higher epoch, retry later with jittered back-off.)
4. **Required log:** `target = max by (lastEpoch, lastLsn)` over grants; `requiredDurable = max(durableLsn)`. If the candidate's `(lastEpoch,lastLsn) < target`, it fetches the missing entries from the granter holding `target` (trying others on failure), verifying `prev_hash` chaining; if its own tail diverges it first runs the rejoin repair (Section 21.7). Fetch failure ⇒ `PROMOTION_REFUSED(STALE_CANDIDATE)`.
5. **Safety check:** after catch-up, require `lastLsn ≥ requiredDurable`; otherwise `PROMOTION_REFUSED(STALE_CANDIDATE)`.
6. **Open epoch:** append `EPOCH_START{epoch:E', leaderId, backupId}`; set `role=primary`, `epoch=E'`, `leader_id=self`; choose `backupId` = healthy follower with highest `match_lsn` (ties: lowest ID); start leader replicator; open the write gate once the lease is valid (heartbeat acks from ≥ 2 peers).
7. **Announce:** `cluster.announceLeader{E', leaderId, lastLsn}` to all; coordinator discovers it via polling.
8. **Report:** write a `FAILOVER_REPORT` event: old leader/epoch, new leader/epoch, detection time, promotion duration, `catchUpEntries`, `lastKnownOldPrimaryLsn` vs `newPrimaryLastLsn`, `possibleLossWindow` (empty in SYNC unless > 1 failure).

### 21.4 Promotion refusal rules (summary)

| Condition | Result |
|---|---|
| < 3 grants (e.g., two nodes down or partition) | `NO_QUORUM`; cluster stays without a leader; reads from eligible followers continue (`eventual`/`bounded`); writes return `NO_LEADER`. |
| Required log unreachable (holder down/blocked) or hash chain mismatch | `STALE_CANDIDATE`; candidate excluded; election reruns. |
| Candidate's epoch promise superseded mid-way | Abort and retry with higher epoch. |
| Refusal after the old primary already granted the epoch (manual handover) | The old primary stays stepped down; the cluster is leaderless until the excluded-candidate election completes (seconds). Writes return `NO_LEADER` meanwhile. |

### 21.5 How old leaders are prevented from writing

1. **DB-level fence:** every write transaction verifies `role='primary' AND epoch = promised_epoch` under the `node_state` lock (Section 14.1).
2. **Grant = fence:** granting a higher epoch atomically ends the grantor's leadership.
3. **Lease:** a primary that has not had successful heartbeats from ≥ 2 peers within `LEADER_LEASE_MS` (3000) closes its write gate and goes `recovering` (isolated primary).
4. **Replica rejection:** followers reject `append` from epochs < `promised_epoch`.
5. **Client side:** coordinator sends `_meta.epoch`; a node with a higher epoch answers `STALE_LEADER`/`NOT_PRIMARY` with `leaderHint`.

### 21.6 Client discovery

The coordinator's leader tracker follows the highest-epoch healthy primary. Writes issued during failover wait up to `LEADER_WAIT_MS` (15 s) polling for a leader and then fail with `NO_LEADER`. The CLI displays the leader change as soon as the tracker updates.

### 21.7 Rejoin and catch-up without overwriting newer state

A restarted or deposed node:
1. Starts `recovering`, discovers the leader (highest valid epoch).
2. **Finds the common prefix:** because the log is hash-chained, "entry hash at LSN *k* equals the leader's" implies the identical prefix. It binary-searches the highest *k* with equal `entryHash` using `replication.hashAt` (and `replication.fetch` for the leader's entry range).
3. **Archives** local entries `> k` into `divergent_log` (`reason = "diverged from epoch E"`), including transaction IDs and payloads, so lost acknowledged writes are inspectable. If nothing diverges, `k = last_lsn`.
4. **Rebuilds state** by clearing the materialized tables and **replaying its own log `1..k`** with `applyEntry` (no network needed), then truncating the log to `k`.
5. Streams entries `k+1…` from the leader (normal append path). Once `lag ≤ READ_MAX_LAG_LSN` it becomes a `replica` and is announced eligible.

It never pushes its entries to the leader and never "wins" with a higher LSN from a lower epoch.

### 21.8 Availability vs. consistency trade-off

| Choice | Effect |
|---|---|
| Majority (3 of 4) for promotion | Prevents split-brain; but after one node is down, a second failure leaves the cluster **read-only** until a node returns. We choose consistency over write availability. |
| SYNC mode | No acknowledged write is lost on a single-node failure; higher write latency (waits for backup + 1) and `INSUFFICIENT_REPLICAS` rejections when followers are down. |
| ASYNC mode | Lower latency and higher availability; acknowledged writes beyond `durable_lsn` may be lost on primary failure. **The system reports this window; it never claims those writes are safe.** |

---

## 22. Failure Scenarios and Recovery Behaviour

### 22.1 Scenario catalogue

| ID | Scenario | Behaviour | Guarantee / outcome |
|---|---|---|---|
| F1 | Replica or backup crashes | Marked suspected after 4 s; removed from routing; in SYNC, backup loss triggers re-designation (Section 19.5). On restart: rejoin (21.7). | No data loss; temporary `INSUFFICIENT_REPLICAS` possible in SYNC |
| F2 | Primary crashes while idle | Failover (Section 21). | SYNC: no acknowledged loss. ASYNC: possible loss window reported |
| F3a | Follower's database unavailable | `/health` and heartbeat show `dbHealthy=false`; node reports `DB_UNAVAILABLE`; excluded from routing; log shipping to it backs off. After DB returns: rejoin. | No effect on others |
| F3b | Primary's database unavailable | Executor returns `DB_UNAVAILABLE`; primary closes its write gate, announces `dbHealthy=false`, steps down to `recovering`; failover as F2. | No writes accepted without a DB |
| F4 | Network timeout on a write RPC | Client treats the outcome as **indeterminate**, retries with the same key. | Exactly-once effect via idempotency |
| F5 | Duplicate RPC (retry or double-send) | Idempotency path (Section 15.2). | No duplicate effect |
| F6 | Delayed/duplicated replication messages | Duplicates skipped by LSN+hash; delayed ones arrive in order or produce `GAP` and rewind. | Replicas apply each entry once, in order |
| F7 | Missing replication entries | `GAP` → leader rewinds or follower fetches. | Converges; verified by checksum |
| F8 | Stale leader (partitioned or paused old primary) | Lease expires → write gate closes; followers reject its epoch; DB fence rejects writes after a grant. | At most one leader accepts writes per epoch; stale writes are rejected, not merged |
| F9 | Primary crashes **after** local commit, **before** sync quorum ack | Client receives a timeout/`REPLICATION_QUORUM_TIMEOUT` (indeterminate). If the entry reached ≥ 1 survivor with the best log it survives promotion; otherwise it is lost and archived on rejoin. Client retry with the same key resolves the truth. | Never reported as success unless quorum-durable (SYNC) |
| F10 | Primary crashes **during** a transfer (before COMMIT) | PostgreSQL rolls the transaction back; no partial debit/credit; no log entry. | Atomic |
| F11 | Concurrent writes on the same account | Row locks serialize; second sees the new balance. | No double spend |
| F12 | Replica restarts after being offline | Catch-up by append/fetch; eligible after threshold. | Converges |
| F13 | Election winner lacks recent committed data | Promotion fetches the best log or is refused (`STALE_CANDIDATE`); winner excluded; election reruns. | Stale node cannot overwrite newer data |
| F14 | Asynchronous replication data loss | Entries `> durable_lsn` on a dead primary may vanish; reported at failover and archived on rejoin. | **Possible loss**; documented |
| F15 | False failure suspicion (slow node) | A slow primary may be suspected; epochs/lease ensure at most one writer; the slow node is fenced and rejoins. | Safety preserved; availability blip |
| F16 | Coordinator crash | CLI gets connection errors; nodes continue (heartbeats, replication, failover are node-to-node). Restart coordinator: it rebuilds registry from `cluster.getState`. | No financial state lost. Coordinator is a single point of failure for routing |
| F17 | Two nodes down | Primary alive: ASYNC writes continue; SYNC needs backup + 1 other follower, but only one follower remains → `INSUFFICIENT_REPLICAS`. Primary among the two: only 2 of 4 nodes remain, so no promotion quorum → `NO_LEADER`; eligible reads continue. | Consistency over availability |
| F18 | Full cluster restart | Section 9.4. | Best log wins; no divergence silently accepted |
| F19 | Worker thread crash | Section 16.4. | No partial update, no duplicate |

### 22.2 Fault injection (acts on real services)

Gated by `ENABLE_FAULT_INJECTION=true`. Configured with `cluster.setFault` (in-memory, cleared on restart or `cluster.clearFaults`).

| Knob | Effect (real path affected) |
|---|---|
| `rpcDelayMs` | Server-side delay before handling inbound `bank.*` calls (makes a node genuinely slow for LB tests; can trigger real client timeouts) |
| `replicationDelayMs{peer}` | Leader delays `append` to that peer (lag demonstrations; sync latency) |
| `blockReplicationTo[]` | Leader does not send to listed peers (client-visible: real unacknowledged entries) |
| `applyDelayMs` | Follower delays applying incoming entries |
| `dropNextAppend: n` | Follower discards the next *n* `append` requests without replying (forces timeout/gap) |
| `blockFetch` | `replication.fetch` fails (forces `STALE_CANDIDATE` refusal) |
| `blockPeers[]` / `isolate` | Application-level partition: inbound RPC from listed peers is dropped without a response and outbound RPC to them is not sent (real timeouts). The coordinator is not blocked unless `blockCoordinator` is set. |
| `holdAfterLockMs` | Holds account row locks inside the transaction (lock-wait evidence) |
| `workerCrashOnTask` | Worker exits after taking locks |

**Container control** (CLI → Docker Engine API, allow-list `bank-node-*`, `postgres-*`): `stop` (SIGTERM), `kill` (SIGKILL), `start`, plus `restart`. The coordinator itself is not in the allow-list.

### 22.3 What the system does **not** guarantee

- No global atomic commit across databases (Section 15.1).
- No zero-data-loss in ASYNC mode.
- No availability when a majority is unreachable.
- No protection against simultaneous loss of all copies (e.g., deleting all volumes).
- Failure detection is heuristic (asynchronous network); safety relies on epochs and leases, and lease safety assumes similar clock *rates*.

---

## 23. Terminal Menu Design

### 23.1 Output rules (mandatory)

1. **No theory.** Experiment screens contain no explanations, definitions, hints or descriptions of how an algorithm works. Output = real events, tables, measured values, verdict lines.
2. Every printed value originates from an RPC response, a DB query or a service event. Nothing is precomputed or constant.
3. Verdict lines (`PASS`/`FAIL`) are computed by assertions over real data (e.g., final balance equals expected balance **and** invariants pass on each node).
4. Errors are printed with their real code and message, e.g. `ERROR -32009 REPLICATION_QUORUM_TIMEOUT outcome=INDETERMINATE lsn=61`.
5. A one-line status banner (leader, epoch, mode, nodes up) is read from the cluster each time a menu is drawn.
6. `--raw` toggle prints the raw JSON-RPC envelopes for debugging.
7. No animations; progress is shown as timestamped event lines.

### 23.2 Main menu

```
=========================================
       DISTRIBUTED BANKING SYSTEM
  leader: node-a  epoch: 1  mode: ASYNC  nodes up: 4/4
=========================================

1. Client-Server Communication (RPC)
2. Multithreading
3. Clock Synchronization
4. Leader Election
5. Data Consistency and Replication
6. Load Balancing
7. Primary-Backup Fault Tolerance

8. View Cluster Status
9. View Transaction History
10. Verify Banking Invariants
11. Fault Injection and Node Control
12. Reset Demo Data
0. Exit

Select an option:
```

### 23.3 Experiment menus

All experiment menus include the banking operations below (they call the shared `bank.*` RPCs) **plus** experiment-specific controls.

| Menu | Banking operations | Experiment-specific controls |
|---|---|---|
| 1 RPC | Create Account, Check Balance, Deposit, Withdraw, Transfer | Resend Last Request (same key), Call a Node Directly, Show Last Trace, Timeout Test (injects `rpcDelayMs`) |
| 2 Multithreading | Deposit, Withdraw, Transfer | Run Concurrent Transaction Test (scenario list), Stress Test (N requests, W workers), Worker Crash Test, View Worker Activity, Verify Final Balances |
| 3 Clocks | Deposit, Withdraw, Transfer (generate events) | View Clocks, Set Clock Offset, Synchronize (Berkeley), Compare Event Ordering, View Lamport Event Log |
| 4 Election | Deposit, Withdraw, Transfer (prove the new leader works) | Run Bully, Run Ring, Competing Elections, View Election Messages, View Leader/Epoch, Stop/Start Node |
| 5 Replication | Deposit, Withdraw, Transfer | Set Mode (SYNC/ASYNC), Inject Delay/Drop, Replication Status (all nodes), Pending/Acks/Errors, Wait for Convergence, Duplicate-Delivery Test, Gap Test, Restart Replica and Recover |
| 6 Load Balancing | Deposit, Withdraw, Transfer (routed to leader), Check Balance (load-balanced) | Set Algorithm, Run Read Load Test, Mixed-Cost Load Test, View Routing Decisions, View Distribution, Stop/Start Node |
| 7 Fault Tolerance | Deposit, Withdraw, Transfer | Show Cluster, Stop Primary, Kill Primary, Watch Failover, Refusal Scenarios (no quorum / stale candidate), Restart Old Primary, Planned Handover, Failover Report, Verify State |

Cross-cutting menus: **8 Cluster Status** (per node: role, epoch, leader, last/applied/durable LSN, lag, health, fault knobs, lease), **9 Transaction History** (global or per account; per-node view option; shows status, LSN, epoch, Lamport, origin), **10 Verify Invariants** (I1–I12 per node plus cross-node checksum), **11 Fault Injection and Node Control**, **12 Reset Demo Data** (requires typing `RESET`; calls `admin.reset` on all four nodes — refuses if any node is unreachable — then seeds demo accounts through the normal primary path so seed data has real log entries).

---

## 24. Example Terminal Workflows

The following illustrate **format only**; every value is produced at run time by the real system.

### 24.1 Experiment 1 — RPC

```
RPC > Deposit
Account: ACC-0001   Amount: 500.00

[RPC] req-000102 cli -> coordinator       bank.deposit          L=57
[RPC] req-000102 coordinator -> node-a    bank.deposit          L=58  epoch=1
[node-a] rpc.received  bank.deposit       req-000102  host=bank-node-a  L=59
[node-a] db.commit     txn=9c1e4b52  lsn=42  epoch=1  L=60
[node-a] rpc.responded SUCCESS            req-000102  L=61
[RPC] req-000102 coordinator <- node-a    SUCCESS               L=62
[RPC] req-000102 cli <- coordinator       SUCCESS               L=63

txn        9c1e4b52   DEPOSIT   COMMITTED
account    ACC-0001   10000.00 -> 10500.00
lsn        42   epoch 1   durability LOCAL
round trip 14 ms   (coordinator 2 ms, node-a 9 ms)

RPC > Resend Last Request
[RPC] req-000103 cli -> coordinator       bank.deposit          L=64
[RPC] req-000103 coordinator -> node-a    bank.deposit          L=65  epoch=1
[node-a] idempotency.hit  key=idem-6f1c  txn=9c1e4b52  L=66
result     DUPLICATE  txn=9c1e4b52  lsn=42  (no new effect)
balance    ACC-0001   10500.00
```

### 24.2 Experiment 2 — Multithreading

```
MULTITHREADING > Concurrent Test > parallel-withdrawals
account ACC-0007   initial 10000.00   workers 4

worker thread pgpid  request     start     end       lockWait  result
w1     t1     8841   req-w-0001  0.00 ms   14.2 ms   0.0 ms    COMMITTED  lsn=51  balance=8000.00
w3     t3     8843   req-w-0003  0.02 ms   17.9 ms   9.6 ms    COMMITTED  lsn=52  balance=6000.00
w2     t2     8842   req-w-0002  0.01 ms   21.3 ms   13.1 ms   COMMITTED  lsn=53  balance=4000.00
w4     t4     8844   req-w-0004  0.02 ms   24.8 ms   16.4 ms   COMMITTED  lsn=54  balance=2000.00

committed 4   rejected 0   failed 0   duration 24.8 ms
final      ACC-0007   2000.00   expected 2000.00   PASS
invariants node-a 12/12 PASS

MULTITHREADING > Concurrent Test > conflicting-withdrawals
account ACC-0008   initial 5000.00   workers 2
w1     t1     8841   req-w-0011  0.00 ms   12.7 ms   0.0 ms    COMMITTED  lsn=55  balance=1000.00
w2     t2     8842   req-w-0012  0.01 ms   15.0 ms   11.9 ms   REJECTED   lsn=56  INSUFFICIENT_FUNDS
committed 1   rejected 1
final      ACC-0008   1000.00   exactly-one-commit   PASS
```

### 24.3 Experiment 3 — Clocks

```
CLOCKS > View Clocks
node   offsetMs   physical (app clock)        lamport
a          +0     2026-10-14T10:02:11.402Z    118
b       +2500     2026-10-14T10:02:13.907Z    97
c       -1800     2026-10-14T10:02:09.606Z    104
d        +700     2026-10-14T10:02:12.108Z    91
coord      +0     2026-10-14T10:02:11.405Z    131

CLOCKS > Synchronize (Berkeley)
node   rtt     estOffset   injected   error   adjustment
a      2.1 ms      +1         +0       +1      +280.4
b      2.4 ms   +2503      +2500       +3     -2221.6
c      1.9 ms   -1798      -1800       +2     +2079.4
d      2.2 ms    +701       +700       +1      -419.6
coord  -           0          0        0      +281.4
average offset 281.4 ms
after sync   max spread 3 ms

CLOCKS > Compare Event Ordering   req-000231  deposit ACC-0001 on a, replicated to b
event                  node  physical-rank  lamport  lamport-rank
rpc.received           a     2              201      1
db.commit              a     3              202      2
replication.send -> b  a     4              203      3
replication.apply      b     1              204      4
physical order places repl.apply before rpc.received: 1 causal violation
lamport order: 0 causal violations
```

### 24.4 Experiment 4 — Election

```
ELECTION > Run Bully   initiator b   node d stopped
election 2-b-143
seq  L    from  to  message      result
1    144  b     c   ELECTION     OK(c)        12 ms
2    144  b     d   ELECTION     TIMEOUT      2000 ms
3    146  c     d   ELECTION     TIMEOUT      2000 ms
4    148  c     a   COORDINATOR  ACK          9 ms
5    148  c     b   COORDINATOR  ACK          8 ms
6    148  c     d   COORDINATOR  UNREACHABLE
winner   node-c
promotion  epoch 2  grants a,b,c  required lsn 57  have 57  catch-up 0   GRANTED
leader seen by a,b,c: c (epoch 2)   old primary a: replica

ELECTION > Run Ring   initiator a   node c stopped
election 3-a-201
seq  L    from  to  message           result
1    202  a     b   RING_TOKEN        ACK   candidates=[a]
2    203  b     c   RING_TOKEN        TIMEOUT 1500 ms
3    204  b     d   RING_TOKEN        ACK   candidates=[a,b]   (skipped c)
4    205  d     a   RING_TOKEN        ACK   candidates=[a,b,d]
5    206  a     b   RING_COORDINATOR  ACK   winner=d
6    207  b     d   RING_COORDINATOR  ACK
7    208  d     a   RING_COORDINATOR  ACK
promotion  epoch 3  grants a,b,d   GRANTED
```

### 24.5 Experiment 5 — Replication

```
REPLICATION > Set Mode: ASYNC   Inject: replicationDelayMs d=3000
REPLICATION > Deposit ACC-0001 +250.00
txn 4d07a1c9   lsn=43   durability LOCAL   ack 11 ms

REPLICATION > Replication Status
node  role     applied  lag  pending  lastAck   ACC-0001    checksum
a     primary  43       0    0        -         10750.00    7be1c2
b     backup   43       0    0        4 ms      10750.00    7be1c2
c     replica  43       0    0        6 ms      10750.00    7be1c2
d     replica  42       1    1        -         10500.00    (lsn 42)
errors none   acks b=43 c=43 d=42

REPLICATION > Wait for Convergence
t+3.02 s   converged   lsn 43 on a,b,c,d   checksum 7be1c2 equal   PASS

REPLICATION > Set Mode: SYNC   Inject: replicationDelayMs b=1500
REPLICATION > Deposit ACC-0001 +100.00
txn 8aa3f0e2   lsn=44   durability QUORUM   ack 1512 ms   acked by b,c
REPLICATION > Set Mode: ASYNC
REPLICATION > Deposit ACC-0001 +100.00
txn c912be07   lsn=45   durability LOCAL    ack 9 ms
```

### 24.6 Experiment 6 — Load balancing

```
LOAD BALANCING > Read Load Test   algorithm=round-robin   requests=40   concurrency=8   consistency=eventual
node  health  requests  share  peakActive  p50     p95     failures
a     UP      10        25%    3           6 ms    11 ms   0
b     UP      10        25%    3           6 ms    12 ms   0
c     UP      10        25%    2           7 ms    13 ms   0
d     UP      10        25%    3           6 ms    10 ms   0

Inject rpcDelayMs b=80
LOAD BALANCING > Read Load Test   algorithm=least-connections   requests=40   concurrency=8
node  health  requests  share  peakActive  p50     p95     failures
a     UP      13        33%    2           6 ms    9 ms    0
b     UP      4         10%    5           84 ms   96 ms   0
c     UP      12        30%    2           6 ms    10 ms   0
d     UP      11        28%    2           7 ms    10 ms   0

LOAD BALANCING > Stop node c   (docker stop bank-node-c)
LOAD BALANCING > Read Load Test   algorithm=round-robin   requests=30
node  health  requests  share  failures  retries
a     UP      10        33%    0         0
b     UP      10        33%    0         0
c     DOWN    0         0%     1         1     (excluded after 2 failed checks)
d     UP      10        33%    0         0
writes routed: LEADER_ONLY -> node-a (epoch 1)
```

### 24.7 Experiment 7 — Fault tolerance

```
FAULT TOLERANCE > Stop Primary
before   leader a (epoch 1)   backup b   mode SYNC   lsn a=57 b=57 c=57 d=57
[docker] stop bank-node-a   ok
+0.0 s   bank-node-a stopped
+4.1 s   node-b: primary suspected (no heartbeat 4012 ms)
+4.1 s   node-b: promotion start epoch 2
+4.2 s   grants b,c,d   a unreachable   3/3 required
+4.2 s   required lsn 57   have 57   catch-up 0
+4.3 s   EPOCH_START epoch=2 lsn=58 leader=b backup=c
+4.3 s   coordinator leader=b epoch=2
Deposit ACC-0001 +100.00  -> node-b  lsn=59  durability QUORUM
check    57/57 acknowledged transactions present on b,c,d   PASS
invariants b,c,d 12/12 PASS   checksum equal at lsn 59

FAULT TOLERANCE > Restart Old Primary
[docker] start bank-node-a   ok
+2.3 s   node-a recovering   leader b epoch 2
         common prefix lsn 57   divergent entries 0   replay 57
         caught up lsn 59   role replica
checksum a,b,c,d equal at lsn 59   PASS

(each scenario below starts from a freshly verified cluster)

FAULT TOLERANCE > Refusal Scenarios > no quorum   (leader a and node c stopped)
node-b: promotion start epoch 3   grants b,d   2/3 required
PROMOTION_REFUSED NO_QUORUM
write attempt -> ERROR -32007 NO_LEADER        read eventual -> served by b lsn 59

FAULT TOLERANCE > Refusal Scenarios > stale candidate   (SYNC; manual Bully election; replication delayed to d; blockFetch on d)
node-d: election winner (bully)   epoch 3 proposed   grants a,b,c,d   target lsn 59 (from b)   d has 57
node-d: fetch lsn 58..59 from b   FAILED (blockFetch)
PROMOTION_REFUSED STALE_CANDIDATE   d excluded
node-a: stepped down (epoch 3 promised)   no leader
election rerun excluded=[d]   winner c   catch-up 0   GRANTED epoch 4   leader c

FAULT TOLERANCE > ASYNC loss window   (blockReplicationTo b,c,d; 3 deposits acknowledged; kill a)
acked on a: lsn 58,59,60  durable_lsn 57
failover report  new leader b epoch 2   newLastLsn 57   oldPrimaryLastKnown 60
possible loss    lsn 58..60   txn 11aa…, 20bc…, 5f09…
after a rejoins  divergent_log: 3 entries archived   balances rebuilt from lsn 57
```

---

## 25. Repository and Directory Structure

One repository, one `package.json`, one Docker image. The four bank nodes run the **same** code parameterized by `NODE_ID`.

```
distributed-banking-system/
├── PROJECT.md                     # this file (source of truth)
├── README.md                      # quick start (derived from Section 30)
├── package.json                   # deps: express, pg, pino; scripts: test:*, cli
├── docker-compose.yml
├── .env.example
├── docker/
│   └── Dockerfile                 # single image: node:20-alpine, npm ci, copies src/ and db/
├── db/
│   └── migrations/                # 001_core.sql, 002_replication.sql, 003_cluster.sql
├── src/
│   ├── cli/                       # terminal application
│   │   ├── index.js               # entry, main menu loop
│   │   ├── menu.js                # prompt helpers, status banner
│   │   ├── render.js              # table/trace printers (no prose)
│   │   ├── dockerControl.js       # Docker Engine API (stop/kill/start, allow-listed)
│   │   └── experiments/           # rpc.js, multithreading.js, clocks.js, election.js,
│   │                              # replication.js, loadBalancing.js, faultTolerance.js, cluster.js
│   ├── coordinator/
│   │   ├── server.js              # Express + JSON-RPC (gateway.*, lb.*, clock.sync)
│   │   ├── gateway.js             # routing, retries, trace merge
│   │   ├── registry.js            # node health registry
│   │   ├── leaderTracker.js       # highest-epoch leader discovery
│   │   ├── timeMaster.js          # Berkeley coordination
│   │   └── loadBalancer/          # roundRobin.js, leastConnections.js, index.js, stats.js
│   ├── node/
│   │   ├── server.js              # boot: config → migrate → services → Express
│   │   ├── methods/               # bank.js cluster.js election.js replication.js clock.js worker.js admin.js
│   │   └── state.js               # node_state access, role transitions
│   ├── domain/                    # money.js (string validation), validators, invariants.js (SQL checks)
│   ├── txn/                       # executor.js, idempotency.js, logWriter.js, history.js
│   ├── replication/               # leaderReplicator.js, applier.js, ackTracker.js, follower.js, lag.js
│   ├── clocks/                    # physicalClock.js, lamportClock.js, berkeley.js
│   ├── election/                  # bully.js, ring.js, failureDetector.js, electionLog.js
│   ├── faulttolerance/            # epochs.js, promotion.js, fencing.js, rejoin.js, failoverController.js
│   ├── workers/                   # pool.js, worker.js, barrier.js, scenarios.js
│   ├── contracts/                 # methods.js (names + param validators), errors.js (codes)
│   └── shared/
│       ├── rpc/                   # server.js, client.js, envelope.js, meta.js
│       ├── db/                    # pool.js, migrate.js
│       ├── config.js              # env parsing and validation
│       ├── logger.js              # pino setup
│       ├── events.js              # event_log + request trace
│       ├── faults.js              # fault-injection registry
│       └── ids.js                 # request / idempotency / election IDs
├── tests/
│   ├── unit/                      # money, hash chain, lamport, berkeley math, bully/ring logic, LB selection
│   ├── integration/               # run against the live cluster, per phase (phase0.test.js … phase9.test.js)
│   └── acceptance/                # T01–T30 (Section 29); may stop/start containers
├── scripts/                       # wait-for-cluster.sh, demo-reset.js, check-no-hardcoded-output.sh
└── docs/                          # demo-scenarios.md, limitations.md, protocol-notes.md
```

Design rules: no module imports across experiment folders except through `shared/`, `txn/`, `domain/`, `contracts/`; no file above ~300 lines; no classes where plain functions suffice.

---

## 26. Docker Compose Design and Networking

### 26.1 Excerpt (authoritative shape)

```yaml
name: distributed-banking
networks:
  bank-net: { driver: bridge }
volumes: { pgdata-a: {}, pgdata-b: {}, pgdata-c: {}, pgdata-d: {} }

x-node: &node
  build: { context: ., dockerfile: docker/Dockerfile }
  command: ["node", "src/node/server.js"]
  networks: [bank-net]
  restart: "no"                       # stopped containers must stay stopped during failure demos
  healthcheck:
    test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]
    interval: 2s
    timeout: 2s
    retries: 15
  environment: &node-env
    NODE_PORT: "3000"
    PEERS: "a=http://bank-node-a:3000,b=http://bank-node-b:3000,c=http://bank-node-c:3000,d=http://bank-node-d:3000"
    COORDINATOR_URL: "http://bank-coordinator:8080"
    ENABLE_FAULT_INJECTION: "true"

services:
  postgres-a:
    image: postgres:16-alpine
    networks: [bank-net]
    environment: { POSTGRES_DB: bank, POSTGRES_USER: bank_a, POSTGRES_PASSWORD: pw_a }
    volumes: [ "pgdata-a:/var/lib/postgresql/data" ]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U bank_a -d bank"], interval: 2s, timeout: 2s, retries: 15 }
    restart: "no"

  bank-node-a:
    <<: *node
    container_name: bank-node-a
    ports: ["3001:3000"]
    depends_on: { postgres-a: { condition: service_healthy } }
    environment:
      <<: *node-env
      NODE_ID: a
      DATABASE_URL: postgres://bank_a:pw_a@postgres-a:5432/bank
      BOOTSTRAP_PRIMARY: "true"       # only A; honoured only on a fresh cluster

  # bank-node-b/c/d and postgres-b/c/d follow the same pattern (distinct NODE_ID, DATABASE_URL, volume, credentials)

  bank-coordinator:
    build: { context: ., dockerfile: docker/Dockerfile }
    container_name: bank-coordinator
    command: ["node", "src/coordinator/server.js"]
    networks: [bank-net]
    ports: ["8080:8080"]
    depends_on:
      bank-node-a: { condition: service_healthy }
      bank-node-b: { condition: service_healthy }
      bank-node-c: { condition: service_healthy }
      bank-node-d: { condition: service_healthy }
    environment:
      PEERS: "a=http://bank-node-a:3000,b=http://bank-node-b:3000,c=http://bank-node-c:3000,d=http://bank-node-d:3000"
      LB_ALGORITHM: round-robin

  bank-cli:
    build: { context: ., dockerfile: docker/Dockerfile }
    command: ["node", "src/cli/index.js"]
    networks: [bank-net]
    stdin_open: true
    tty: true
    profiles: ["cli"]                 # started with: docker compose run --rm bank-cli
    volumes: [ "/var/run/docker.sock:/var/run/docker.sock" ]   # lab-only: fault demos (allow-listed names)
    environment:
      COORDINATOR_URL: "http://bank-coordinator:8080"
      PEERS: "a=http://bank-node-a:3000,b=http://bank-node-b:3000,c=http://bank-node-c:3000,d=http://bank-node-d:3000"
      DOCKER_CONTROL_ENABLED: "true"
```

### 26.2 Networking rules

- All services join `bank-net`; inter-service addressing uses service DNS names. No `localhost` between services.
- Host-published ports (3001–3004, 8080) are for debugging only; the CLI uses the internal network.
- PostgreSQL ports are **not** published by default (optionally `5433–5436` in a debug override file).
- Each database has unique credentials; a node whose `DATABASE_URL` host is not its own `postgres-<id>` must refuse to start (config check `DB host must equal postgres-${NODE_ID}`).
- `restart: "no"` everywhere so `docker stop/kill` produce real, lasting outages until `docker start`.
- Coordinator and CLI also read `PEERS`; none of them connect to databases.

---

## 27. Environment Configuration

| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `NODE_ID` | — | node | `a`/`b`/`c`/`d` |
| `NODE_PORT` | 3000 | node | HTTP port |
| `DATABASE_URL` | — | node | Own Postgres only |
| `PEERS` | — | all | `id=url,…` static membership |
| `COORDINATOR_URL` | — | node, cli | Gateway URL |
| `BOOTSTRAP_PRIMARY` | false | node (a) | Fresh-cluster bootstrap only (Section 9.2) |
| `HEARTBEAT_INTERVAL_MS` | 1000 | node | Heartbeat period |
| `FAILURE_TIMEOUT_MS` | 4000 | node | Suspicion threshold |
| `LEADER_LEASE_MS` | 3000 | node | Primary self-fence (must be < `FAILURE_TIMEOUT_MS`) |
| `DISCOVERY_WINDOW_MS` | 5000 | node | Wait for a leader after start |
| `RPC_TIMEOUT_MS` | 2000 | all | Per-call timeout |
| `LEADER_WAIT_MS` | 15000 | coordinator | Write wait for leader |
| `REPLICATION_MODE` | ASYNC | node | Initial mode (runtime changes are replicated via `CONFIG_CHANGE`) |
| `SYNC_ACKS` | 2 | node | Follower acks incl. backup |
| `SYNC_TIMEOUT_MS` | 3000 | node | Quorum wait |
| `ASYNC_BATCH_INTERVAL_MS` | 100 | node | Background shipping interval |
| `REPL_BATCH_SIZE` | 100 | node | Entries per append |
| `READ_MAX_LAG_LSN` | 5 | coordinator, node | Eligibility lag |
| `ELECTION_ALGORITHM` | bully | node | Used by automatic failover |
| `BULLY_OK_TIMEOUT_MS` / `COORDINATOR_WAIT_MS` | 2000 / 5000 | node | Bully timers |
| `ELECTION_HOP_TIMEOUT_MS` / `RING_TIMEOUT_MS` | 1500 / 8000 | node | Ring timers |
| `BACKUP_GRACE_MS` | 5000 | node | Delay before non-backups start elections |
| `CLOCK_OFFSET_MS` / `CLOCK_DRIFT_PPM` | 0 / 0 | node | Application clock model |
| `COORDINATOR_CLOCK_OFFSET_MS` | 0 | coordinator | Time master offset |
| `BERKELEY_OUTLIER_MS` | 10000 | coordinator | Exclusion threshold |
| `WORKER_POOL_SIZE` | 4 | node | Max workers |
| `BATCH_TIMEOUT_MS` | 30000 | node | Batch limit |
| `LB_ALGORITHM` | round-robin | coordinator | `round-robin` \| `least-connections` |
| `LB_HEALTH_INTERVAL_MS` / `LB_UNHEALTHY_THRESHOLD` / `LB_RECOVERY_THRESHOLD` | 1000 / 2 / 3 | coordinator | Health logic |
| `ENABLE_FAULT_INJECTION` | false (true in compose) | node | Gate for `cluster.setFault`, `admin.crash` |
| `DOCKER_CONTROL_ENABLED` | false | cli | Enable container control |
| `LOG_LEVEL` | info | all | pino level |
| `MAX_TXN_AMOUNT` | 1000000.00 | node | Policy cap |

`src/shared/config.js` validates all variables at start-up and fails fast with a clear message.

---

## 28. Implementation Phases, Dependencies, Deliverables and Exit Criteria

### 28.0 Phase ordering and why it differs from the proposal

The proposed sequence is kept, with **two changes**:

1. **Replication (Phase 5) precedes Leader election (Phase 6).** An election that changes who accepts writes is only safe if followers already hold a replicated, hash-chained log that promotion can verify and catch up from. Building replication first lets election and promotion be implemented once, correctly, rather than first with a placeholder "interim safety hook".
2. **Architectural necessities are front-loaded**, not deferred: transaction IDs, idempotency, LSNs and the full replication-log schema (Phase 1); `node_state` with `epoch`/`promised_epoch` and the DB-level fencing check in the write path (Phase 1); heartbeats and failure detection (Phase 0); the `_meta` envelope for clocks/epochs (Phase 2); epoch rejection in `replication.append` (Phase 5).

Dependencies: 0 → 1 → 2 → {3, 4, 5} → 6 → 7 → 8 → 9 → 10. Phases 3 and 4 depend only on Phases 1–2 and can proceed in parallel with Phase 5.

Every phase: write tests; run `npm run test:unit` and `npm run test:integration -- --phase N`; update this file.

### Phase 0 — Foundation
**Deliverables:** repo skeleton; Dockerfile; `docker-compose.yml` with 10 services; migration runner and `node_state`, `cluster_nodes`, `event_log` tables; config validation; pino logger; minimal JSON-RPC server/client (`cluster.ping`, `cluster.getState`, `cluster.heartbeat`); `/health`; heartbeats and failure detector (observation only); DB credential isolation check.
**Exit criteria:** `docker compose up -d` brings up 10 healthy services; each node reports a distinct `nodeId`, `hostname`, `pid`; each node's `cluster.getState` shows all three peers `alive`; stopping one node makes the others report it `suspected` within 5 s and `alive` again after restart; logs are JSON with `nodeId`; node A cannot start with B's database URL.

### Phase 1 — Core banking
**Deliverables:** full schema (`001`–`003`); `money.js`; `executor.js` (algorithm of Section 14.1) including idempotency, ordered locking, REJECTED recording, LSN/hash-chain log entry, DB fence; `bank.*` read methods; history; `admin.verifyInvariants`, `admin.stateChecksum`; interim static bootstrap (`STATIC_BOOTSTRAP=a` sets A as primary at epoch 1 — removed in Phase 8); non-primary writes return `NOT_PRIMARY`. **Authoritative writer: the primary only (initially Node A).**
**Exit criteria:** create/deposit/withdraw/transfer work on node A through direct RPC; overdraft rejected and recorded; duplicate key returns the stored result; kill -9 mid-transfer leaves no partial change; data persists after `docker compose restart bank-node-a postgres-a`; `verifyInvariants` passes; every committed transaction has a gap-free LSN and a valid hash chain.

### Phase 2 — Client-server RPC
**Deliverables:** complete envelope with `_meta` (request ID, trace, epoch; Lamport/physical fields reserved); `contracts/` validators and error codes; coordinator gateway with leader resolution from `cluster.getState`, timeouts, retries with the same key; non-interactive CLI commands (`cli rpc deposit …`) printing real traces; direct-node call mode.
**Exit criteria:** CLI → coordinator → node-a deposit shows trace events originating in all three services; a timeout (via `rpcDelayMs`) is surfaced and retried idempotently; invalid params rejected with `-32602` before any DB access; a write sent to node-b returns `NOT_PRIMARY` with `leaderHint=a`.

### Phase 3 — Multithreading
**Deliverables:** worker pool, barrier, static/dynamic distribution, `worker.runBatch`, `worker.getActivity`, scenarios (Section 16.5), crash handling, metrics; unit + integration tests.
**Exit criteria:** `parallel-withdrawals`, `conflicting-withdrawals`, `stress`, `duplicate-flood`, `worker-crash` all pass with invariants; evidence of distinct thread IDs and backend PIDs and overlapping intervals.

### Phase 4 — Clock synchronization
**Deliverables:** `physicalClock` (offset/drift/monotonic guard), `lamportClock`, interceptors in the RPC layer that stamp every request/response, `event_log` writes, `clock.get/setOffset/adjust/events`, coordinator `clock.sync` (Berkeley), transaction `lamport_ts`/`physical_ts_ms` populated.
**Exit criteria:** setting the primary (A) to +2500 ms shifts the `physical_ts_ms` of subsequently committed transactions by about 2500 ms, and B's `event_log` entries carry B's own offset; Berkeley reduces the clock spread to within the measured RTT bound; Lamport ordering shows zero causal violations while physical ordering shows ≥ 1 with skew; unit tests for Lamport and Berkeley math.

### Phase 5 — Replication and consistency
**Deliverables:** `leaderReplicator`, follower `append`/`fetch`/`hashAt`/`status`, `applier.applyEntry` (shared with replay), hash-chain verification, ack tracker and `durable_lsn`, SYNC/ASYNC modes with `CONFIG_CHANGE`, lag/pending/error views, fault knobs (`replicationDelayMs`, `blockReplicationTo`, `applyDelayMs`, `dropNextAppend`), `replication.resend`, replica catch-up after restart, `INSUFFICIENT_REPLICAS`/`REPLICATION_QUORUM_TIMEOUT`, read options (`consistency`, `minLsn`). Leader is still static.
**Exit criteria:** after a deposit all four databases contain the same transaction and ledger rows and equal checksums; ASYNC lag and convergence observable with a delay fault; SYNC ack latency ≥ injected delay on the backup while ASYNC is not; duplicates counted and gap recovered; a stopped replica catches up after restart; stale-epoch `append` is rejected.

### Phase 6 — Leader election and epochs
**Deliverables:** Bully and Ring, `election_log`, `election.start`, `excluded` handling, `epochs.js` + `promotion.js` (grants, quorum, catch-up, `EPOCH_START`, announce), coordinator leader tracker following highest epoch, planned handover via manual election.
**Exit criteria:** Bully with D stopped elects C; Ring skips a stopped node; competing elections yield one leader; after a manual election the new leader accepts writes and the old primary rejects them (`NOT_PRIMARY`); election messages visible in `election_log` of both ends; epoch never decreases.

### Phase 7 — Load balancing
**Deliverables:** registry/health, Round Robin, Least Connections, eligibility by consistency, retries, decision log, `lb.run`/`lb.stats`, `rpcDelayMs` knob.
**Exit criteria:** RR distributes evenly across eligible nodes; LC sends fewer requests to the slowed node; stopped node is excluded within `LB_UNHEALTHY_THRESHOLD` checks and re-admitted after `LB_RECOVERY_THRESHOLD` checks and catch-up; all writes go to the leader and are visible on every node after replication.

### Phase 8 — Primary-backup fault tolerance
**Deliverables:** `failoverController` (detection → backup-first → fallback election), lease self-fencing, DB-down step-down, backup re-designation, rejoin (`hashAt` binary search, `divergent_log` archival, replay), failover report, refusal scenarios, `BOOTSTRAP_PRIMARY` replaces the interim static bootstrap, full-cluster restart procedure.
**Exit criteria:** tests T24–T28 pass (Section 29): SYNC failover with no acknowledged loss; ASYNC loss window reported and archived on rejoin; `NO_QUORUM` and `STALE_CANDIDATE` refusals; isolated old primary fenced; restarted old primary rejoins without overwriting newer state.

### Phase 9 — Terminal interface and experiment integration
**Deliverables:** full menu tree (Section 23), banking operations inside each experiment, experiment-specific controls, cluster status, history, invariant check, fault panel, `RESET` confirmation, status banner, `--raw`.
**Exit criteria:** every menu item executes against the live cluster; an operation made in menu 1 is visible in menus 5, 8, 9; no output contains explanatory prose (checked by `scripts/check-no-hardcoded-output.sh` plus review); verdict lines derive from assertions.

### Phase 10 — End-to-end validation and demonstration
**Deliverables:** acceptance suite T01–T30 automated; `docs/demo-scenarios.md` (repeatable scripts per experiment); `docs/limitations.md`; clean-checkout run documented.
**Exit criteria:** from a clean clone, `docker compose build && docker compose up -d && npm run test:acceptance` passes; the Section 34 checklist is fully ticked with evidence.

---

## 29. End-to-End Acceptance Criteria

Automated in `tests/acceptance/`. Unless stated, start from a healthy cluster (leader a, epoch 1) with fresh demo data. Each test lists **Setup / Action / Expected / Evidence / Fails if**.

**T01 — Four independent node processes.**
Setup: cluster up. Action: call `/health` on ports 3001–3004. Expected: four distinct `nodeId`, `hostname`, `pid`. Evidence: `docker compose ps` shows four `bank-node-*` containers. Fails if: any duplicate identity or fewer than four processes.

**T02 — Four independent databases.**
Setup: cluster up. Action: insert a marker row directly into `postgres-b` with `psql`; query all nodes. Expected: marker only on B; each node's `current_database()` and `inet_server_addr()` differ; node A's `DATABASE_URL` host is `postgres-a`. Evidence: psql output; config dump. Fails if: marker visible elsewhere or any node shares a DB host.

**T03 — Persistence across restarts.**
Action: deposit, then `docker compose restart` all node and postgres containers. Expected: balances and transaction history identical afterwards on every node. Evidence: before/after `stateChecksum` and `last_lsn`. Fails if: any row or LSN lost.

**T04 — RPC crosses container boundaries.**
Action: deposit via CLI. Expected: trace contains events from `bank-cli`, `bank-coordinator`, `bank-node-a` with different hostnames; node log shows `remoteAddr` equal to the coordinator container's IP. Evidence: trace + `docker compose logs`. Fails if: any hop is missing or addresses are `127.0.0.1`.

**T05 — Idempotent retry.**
Action: send the same deposit key 5 times sequentially, then 10 times concurrently. Expected: exactly one transaction row and one LSN; later calls `duplicate=true`; balance changes once. Evidence: `transactions` count by key. Fails if: balance changes more than once.

**T06 — Overdraft and atomic failure.**
Action: withdraw more than the balance; transfer more than the source balance; transfer to a non-existent account. Expected: `INSUFFICIENT_FUNDS` recorded as `REJECTED` (no ledger lines); non-existent account → `ACCOUNT_NOT_FOUND`; balances unchanged. Evidence: balances, ledger, log. Fails if: any partial debit/credit.

**T07 — Parallel withdrawals.**
Action: scenario `parallel-withdrawals` (₹10,000; 4 × ₹2,000). Expected: 4 committed; final ₹2,000; invariants pass; replicas converge. Evidence: worker table, DB rows. Fails if: final ≠ ₹2,000.

**T08 — Conflicting withdrawals.**
Action: scenario `conflicting-withdrawals` (₹5,000; 2 × ₹4,000), repeated 50 times with fresh accounts. Expected: every run: exactly one `COMMITTED`, one `REJECTED`, final ₹1,000. Evidence: per-run results. Fails if: any run commits two or none.

**T09 — Worker threads are real.**
Action: run `stress` with 8 workers, 200 requests. Expected: 8 distinct `threadId`, 8 distinct `pg_backend_pid`, overlapping intervals, `isMainThread=false`; Σ balances conserved; no duplicate LSN. Evidence: worker report; `pg_stat_activity`. Fails if: fewer threads/PIDs than workers or intervals strictly sequential.

**T10 — Worker crash safety.**
Action: scenario `worker-crash`. Expected: open transaction rolled back, task retried with same key, final balance exactly as if no crash. Evidence: log of `WORKER_FAILED` and retry; balances. Fails if: double or lost debit.

**T11 — Physical clocks and Berkeley.**
Action: set offsets a=0, b=+2500, c=−1800, d=+700; run a deposit; synchronize. Expected: stored `physical_ts_ms` reflects the primary's offset; estimated offsets within RTT/2 + tolerance of injected values; post-sync spread ≤ max RTT. Evidence: clock table; transaction rows. Fails if: timestamps unaffected by offsets or spread not reduced.

**T12 — Lamport ordering.**
Action: deposit on a with replication to b, c, d under skew (T11 before sync). Expected: Lamport order respects every send→receive pair (0 violations); physical order shows ≥ 1 violation. Evidence: merged `event_log` from all nodes. Fails if: Lamport violations > 0 or values constant.

**T13 — Bully election.**
Action: stop D; start Bully from B. Expected: `ELECTION` messages cross containers; D times out; C replies `OK`; C announces `COORDINATOR`; promotion epoch ≥ 2; leader = C on a, b, c. Evidence: `election_log` on every node; cluster status. Fails if: leader differs across live nodes or messages missing from either end.

**T14 — Ring election.**
Action: stop C; start Ring from A. Expected: token hops a→b, b→c times out, b→d; token returns with `[a,b,d]`; winner d; `RING_COORDINATOR` visits all live nodes. Evidence: `election_log`. Fails if: c not skipped or no completion.

**T15 — Competing elections.**
Action: start Bully from A and B simultaneously, and Ring from A and C simultaneously. Expected: exactly one leader and one new epoch per round; both algorithms agree on the same winner. Evidence: epochs on all nodes. Fails if: two leaders or epoch increments by more than the number of promotions.

**T16 — Async replication, lag and convergence.**
Action: ASYNC; `replicationDelayMs d=3000`; deposit. Expected: client ack ≪ 3 s; d shows lag 1 and an older balance, then converges; checksum equal on all nodes. Evidence: replication status polls. Fails if: d updated instantly or never converges.

**T17 — Sync vs async acknowledgement.**
Action: `replicationDelayMs b=1500`; one deposit in SYNC, one in ASYNC. Expected: SYNC ack ≥ 1500 ms and `durability=QUORUM`; ASYNC ack small with `LOCAL`. Evidence: measured latencies. Fails if: latencies similar.

**T18 — Sync with insufficient replicas.**
Action: SYNC; stop two followers; attempt deposit. Expected: `INSUFFICIENT_REPLICAS`; no new LSN; balance unchanged. Evidence: `last_lsn`. Fails if: balance changed.

**T19 — Duplicate and missing replication entries.**
Action: `replication.resend` already-applied entries to c; `dropNextAppend 2` on d then deposit. Expected: c reports `duplicates>0` and unchanged state; d gap detected, rewound, converges. Evidence: peer state, `replication_errors`. Fails if: double application or permanent gap.

**T20 — Replica restart recovery.**
Action: stop c; 10 deposits; start c. Expected: c `recovering` → catches up to the leader's LSN → eligible; checksum equal. Evidence: status timeline. Fails if: c skips entries or is routed to before catching up.

**T21 — Round Robin.**
Action: 40 eventual reads, concurrency 8. Expected: counts 10/10/10/10; every selected node's own request log shows its receipts. Evidence: LB stats and per-node `event_log`. Fails if: distribution uneven or node receives no request.

**T22 — Least Connections.**
Action: `rpcDelayMs b=80`; 40 reads at concurrency 8. Expected: B receives noticeably fewer requests than others; B's peak active is highest. Evidence: stats. Fails if: distribution equals Round Robin's.

**T23 — Health exclusion and re-entry.**
Action: stop c during a load test; later start it. Expected: c excluded within `LB_UNHEALTHY_THRESHOLD` checks (at most one failed request, retried elsewhere); re-admitted only after `LB_RECOVERY_THRESHOLD` successes and catch-up. Writes always to the leader. Evidence: decision log. Fails if: requests keep going to a dead node or recovering node serves reads.

**T24 — SYNC failover, no acknowledged loss.**
Setup: SYNC; 20 acknowledged deposits. Action: `docker kill bank-node-a`; keep submitting writes. Expected: B promoted (epoch 2) within 20 s; all 20 acknowledged transactions present on b, c, d; new writes succeed on B; invariants pass. Evidence: failover report; history diff. Fails if: any acknowledged transaction missing.

**T25 — Promotion refused: no quorum.**
Action: stop leader a and node c. Expected: promotion attempts report `NO_QUORUM`; writes return `NO_LEADER`; eventual reads still served; after c restarts a leader is elected. Evidence: election/promotion logs. Fails if: a leader is installed with < 3 grants.

**T26 — Promotion refused: stale candidate.**
Setup: SYNC; delay replication to d so it lags; `blockFetch` on d. Action: manual Bully election (d wins). Expected: `PROMOTION_REFUSED STALE_CANDIDATE`; d excluded; c (up to date) promoted. Evidence: promotion log; epochs. Fails if: d becomes primary or acknowledged entries disappear.

**T27 — Isolated old primary is fenced.**
Action: `isolate` on a (blocks peers) while submitting a write directly to a. Expected: a's lease expires (≤ 3 s) → writes rejected; b promoted at epoch 2; after healing, a rejoins as follower; no transaction accepted by a after the new epoch started. Evidence: epochs and LSNs. Fails if: both nodes accept writes in overlapping periods.

**T28 — Async loss window and divergent rejoin.**
Action: ASYNC; `blockReplicationTo b,c,d`; 3 acknowledged deposits on a; kill a; failover; restart a. Expected: failover report lists the possible loss window (3 entries); after rejoin `divergent_log` on a contains exactly those entries; a's state equals the new leader's. Evidence: reports, `divergent_log`, checksums. Fails if: loss unreported or lost entries silently discarded.

**T29 — Invariants and cross-node consistency.**
Action: after T07–T28 scenarios, run Verify Invariants. Expected: I1–I12 pass on every node; equal checksums at equal LSN. Evidence: verification output. Fails if: any violated invariant.

**T30 — CLI completeness and "real data" tamper test.**
Action: (a) enumerate all menu items and run each; (b) directly `UPDATE accounts` on one replica via psql, then run Verify Invariants and Replication Status. Expected: all seven experiments reachable; the tampering is detected (checksum mismatch / `APPLY_MISMATCH` on next entry) — output must change with real state. Evidence: CLI output. Fails if: any menu path prints static text or the tamper goes unnoticed.

---

## 30. Build, Run, Test and Reset Commands

```bash
# Build and start the full cluster
docker compose build
docker compose up -d
docker compose ps                                  # 4 nodes + 4 postgres + coordinator = 9 services (+ cli on demand)
./scripts/wait-for-cluster.sh                      # waits until a leader exists

# Interactive terminal
docker compose run --rm bank-cli

# Tests
npm run test:unit                                  # pure logic, no cluster
npm run test:integration -- --phase 5              # against the running cluster
npm run test:acceptance                            # T01–T30 (stops/starts containers)

# Logs and inspection
docker compose logs -f bank-node-a
docker compose exec postgres-a psql -U bank_a -d bank -c "SELECT lsn, entry_type FROM replication_log ORDER BY lsn DESC LIMIT 5;"

# Manual failure injection (outside the CLI)
docker kill bank-node-a
docker start bank-node-a

# Reset demo data (also available as CLI menu 12, which asks for confirmation)
npm run demo:reset -- --yes

# Stop, keeping data / destroy all data
docker compose down
docker compose down -v
```

---

## 31. Known Trade-offs and Limitations

- **Not a verified consensus protocol.** Epoch grants + log catch-up follow Raft-like reasoning but are a simplified, laboratory design; no formal proof, no pre-vote, no membership change.
- **No distributed atomic commit** (Section 15.1); a sync-mode timeout is *indeterminate* until retried.
- **Primary-side visibility:** the primary's state includes entries not yet quorum-durable; reading only durable state is not offered.
- **Majority = 3 of 4.** The cluster tolerates one failure with writes available; two failures make it read-only (SYNC/ASYNC both need a leader with a promotion quorum).
- **Lease safety assumes similar clock rates**; a long pause or severe clock-rate anomaly can break the "old leader stops before the new one starts" assumption (the DB-level and follower-side epoch checks still prevent conflicting acceptance by replicas, but a paused old primary's in-flight request may be committed locally and later archived).
- **LSN allocation serializes commits** on the primary (short critical section); throughput is bounded by it.
- **No log compaction/snapshots;** rejoin replays the log (O(n)).
- **Coordinator is a single point of failure** for routing and the CLI (nodes continue autonomously).
- **Fault injection is application-level** for partitions/delays; container stop/kill/start are real process failures; the Docker socket mount is a lab-only privilege.
- **Application clocks, not OS clocks,** are skewed; real containers share a host clock.
- **Single currency, no auth.**
- **Fault knobs reset on node restart** (in-memory).
- **ASYNC mode can lose acknowledged writes** on primary failure; this is reported, not prevented.

---

## 32. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Replication/promotion logic is subtle | Incorrect failover, data divergence | Implement in small steps (Phases 5, 6, 8); unit-test hash chain, grant rules, rejoin search; acceptance tests T24–T28; keep protocol notes in `docs/protocol-notes.md` |
| Timing-dependent tests are flaky | Unreliable demos | Use barriers/LSN conditions instead of sleeps; poll with deadlines; configurable timers; `wait-for-cluster.sh` |
| LSN lock hotspot | Throughput ceiling confuses stress results | Document; measure and show lock-wait separately |
| Docker socket exposure | Host root-equivalent from CLI container | Allow-list container names; lab-only; document; alternative: run CLI on the host with Docker CLI |
| Agents re-implement banking logic per experiment | Divergent semantics | Single `executor.js`; review rule in Section 0 |
| CLI prints canned output | Violates "not a simulator" | Section 34 checklist; tamper test T30; script scanning for suspicious literals |
| Laptop resource limits | Slow startup | Alpine images, small pools (`pg` max 5 per node), no extra services |
| Spec/code drift | Confusion | Update `PROJECT.md` in the same change as any contract change |
| Lease/failure detector tuning | Spurious failovers or slow detection | All timers in env; defaults validated by T24/T27 |
| Hash canonicalization bugs | False divergence | One `canonicalJson` utility with unit tests (key ordering, numeric strings) |

---

## 33. Suggested Division of Work for a Team

| Member | Primary ownership | Phases | Interfaces they must freeze early |
|---|---|---|---|
| 1 — Infrastructure & banking core | Docker/Compose, migrations, config, `executor.js`, invariants | 0, 1, 10 (acceptance harness) | DB schema, `executor.execute()` signature, error codes |
| 2 — RPC, coordinator, load balancing | JSON-RPC layer, gateway, registry, leader tracker, LB | 2, 7 | Envelope/`_meta`, method catalogue, eligibility rules |
| 3 — Concurrency, clocks, CLI | Worker pool, clocks, Berkeley, CLI framework and experiment screens | 3, 4, 9 | `worker.runBatch` schema, `event_log`, rendering helpers |
| 4 — Replication, election, failover | Replicator/applier, Bully/Ring, promotion, failover, rejoin | 5, 6, 8 | Log entry format, `node_state` fields, `cluster.requestEpoch` |

Integration points: the log-entry format (Section 19.2) and `node_state` (Section 11.2) are agreed in Phase 0 by members 1 and 4; the RPC envelope by members 2 and 3. All members review Section 34 together before the demo.

---

## 34. Final Checklist: Real, Not Simulated

Tick every item with evidence (command output or test name) before declaring the project complete.

**Processes and storage**
- [ ] `docker compose ps` shows four distinct node containers, four Postgres containers, one coordinator.
- [ ] Each node's `DATABASE_URL` host equals its own `postgres-<id>`; credentials differ; T02 passes.
- [ ] Each Postgres has its own named volume; data survives `docker compose restart` (T03).
- [ ] Repository search finds no module that connects a node to another node's database.

**Network and RPC**
- [ ] A deposit trace contains events from CLI, coordinator and node with different hostnames (T04).
- [ ] `docker compose logs` shows `rpc.received` on the node for each CLI action; stopping the node turns the same action into a real timeout/error.
- [ ] Idempotent retry produces exactly one effect (T05).

**Concurrency**
- [ ] Worker report shows distinct thread IDs and DB backend PIDs with overlapping intervals (T09).
- [ ] Conflicting-withdrawal test: exactly one success in 50 runs (T08).

**Clocks**
- [ ] Changing a node's offset changes the timestamps that are written to the database (T11).
- [ ] Lamport values come from `_meta` on real messages; the ordering comparison uses collected `event_log` rows (T12).

**Election and failover**
- [ ] Election messages appear in `election_log` on both sender and receiver (T13, T14).
- [ ] After `docker kill bank-node-a`, a new leader with a higher epoch accepts writes; the old one rejects them after rejoin (T24, T27).
- [ ] Promotion refusals (`NO_QUORUM`, `STALE_CANDIDATE`) are reproducible (T25, T26).

**Replication**
- [ ] The same transaction rows with identical LSN and entry hash exist in all four databases (query each directly).
- [ ] ASYNC lag and convergence visible; SYNC latency differs measurably (T16, T17).
- [ ] No PostgreSQL replication features, shared volumes or shared databases are configured (`grep -ri "wal_level\|primary_conninfo\|publication"` finds nothing).
- [ ] ASYNC loss window reported and archived (T28).

**Load balancing**
- [ ] Per-node request logs match the coordinator's decision log; RR and LC distributions differ as expected; stopped node excluded and re-admitted (T21–T23).

**CLI and honesty**
- [ ] All seven experiments, cluster status, history, invariants, fault panel and reset reachable from one CLI (T30).
- [ ] Experiment screens contain no explanatory prose; PASS/FAIL derived from real data.
- [ ] Tamper test: a manual SQL change on one replica is detected by the CLI (T30).
- [ ] No money arithmetic uses `Number`/floating point (`grep` in `src/domain`, `src/txn`; unit test).
- [ ] No fallback path silently runs local-only, in-memory, or shared-DB behaviour when a network call fails; failures surface as typed errors.
- [ ] `docs/limitations.md` is consistent with Section 31, and the demo does not claim zero data loss in ASYNC mode.
