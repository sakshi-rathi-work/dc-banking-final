# Distributed Banking System — Implementation Plan

> **Specification Source of Truth:** `PROJECT.md`  
> **Status:** Draft awaiting user approval.  
> **Execution Gate:** No code for Phase 0 or Phase 1 will be written until this plan is formally approved by the user.

---

## 1. Architectural Principles and Non-Negotiables

As mandated by `PROJECT.md`, the implementation will strictly adhere to the following principles:

1. **Not a Simulator:**
   - 4 independent node processes (`bank-node-a`, `bank-node-b`, `bank-node-c`, `bank-node-d`), each in its own Docker container.
   - 4 independent PostgreSQL 16 databases (`postgres-a`, `postgres-b`, `postgres-c`, `postgres-d`), each with its own volume (`pgdata-a..d`) and distinct credentials (`bank_a`/`pw_a`, etc.).
   - 1 coordinator process (`bank-coordinator`) acting as JSON-RPC gateway, health registry, leader tracker, load balancer, and Berkeley time master (holds no financial state).
   - 1 terminal CLI process (`bank-cli`) running on demand with Docker socket access (allow-listed to bank containers) for fault injection.
   - Real JSON-RPC 2.0 over HTTP on the user-defined bridge network `bank-net`. No shared database, no in-memory bank state, no canned terminal output, no fake logs.
2. **Minimal Runtime Stack:**
   - Node.js 20 LTS (CommonJS).
   - Allowed runtime dependencies: `express` (4.x), `pg` (8.x), `pino` (9.x). **No other runtime dependencies without prior explicit approval.**
   - Standard library tools for everything else: `node:test`, `node:assert`, `worker_threads`, `readline/promises`, `crypto`, `http`, `events`.
3. **Financial Precision:**
   - PostgreSQL: `NUMERIC(14,2)` with `CHECK (balance >= 0)`.
   - JavaScript: Decimal strings (e.g. `"500.00"`), validated with regex `/^\d{1,12}(\.\d{1,2})?$/`.
   - **Zero usage of JavaScript `Number` for monetary amounts.** All balance arithmetic is executed directly inside PostgreSQL queries (`balance = balance ± $amount`). A lint test will verify no `Number` conversion in `src/domain/` or `src/txn/`.
4. **Single Banking Execution Path:**
   - Deposit, withdraw, and transfer logic is implemented solely in `src/txn/executor.js`. Experiments and worker threads call this module; none re-implement it.
5. **Configuration and Observability:**
   - Strict 12-factor configuration via environment variables only; parsed and validated at boot in `src/shared/config.js`.
   - Structured JSON logging to stdout via `pino`, including `ts`, `level`, `nodeId`, `requestId`, `txnId`, `lsn`, `epoch`, `lamport`, `event`.
   - Persisted event logging in local PostgreSQL tables (`event_log`, `election_log`, `replication_errors`, `divergent_log`).
6. **Strict Error Handling & Fencing:**
   - Typed error codes (-32001 to -32016) adhering to Section 13.4 of `PROJECT.md`.
   - Leadership fenced at the PostgreSQL transaction level: every mutating transaction acquires a row lock on `node_state` (id=1) and verifies `role = 'primary' AND epoch = promised_epoch`.

---

## 2. Target Repository Structure

The complete project structure will match Section 25 of `PROJECT.md`:

```
c:\Users\Sakshi\Desktop\dc-banking-final\
├── PROJECT.md
├── IMPLEMENTATION_PLAN.md
├── README.md
├── package.json
├── docker-compose.yml
├── .env.example
├── docker/
│   └── Dockerfile
├── db/
│   └── migrations/
│       ├── 001_core.sql
│       ├── 002_replication.sql
│       └── 003_cluster.sql
├── src/
│   ├── cli/
│   │   ├── index.js
│   │   ├── menu.js
│   │   ├── render.js
│   │   ├── dockerControl.js
│   │   └── experiments/
│   │       ├── rpc.js
│   │       ├── multithreading.js
│   │       ├── clocks.js
│   │       ├── election.js
│   │       ├── replication.js
│   │       ├── loadBalancing.js
│   │       ├── faultTolerance.js
│   │       └── cluster.js
│   ├── coordinator/
│   │   ├── server.js
│   │   ├── gateway.js
│   │   ├── registry.js
│   │   ├── leaderTracker.js
│   │   ├── timeMaster.js
│   │   └── loadBalancer/
│   │       ├── index.js
│   │       ├── roundRobin.js
│   │       ├── leastConnections.js
│   │       └── stats.js
│   ├── node/
│   │   ├── server.js
│   │   ├── state.js
│   │   └── methods/
│   │       ├── bank.js
│   │       ├── cluster.js
│   │       ├── election.js
│   │       ├── replication.js
│   │       ├── clock.js
│   │       ├── worker.js
│   │       └── admin.js
│   ├── domain/
│   │   ├── money.js
│   │   ├── validators.js
│   │   └── invariants.js
│   ├── txn/
│   │   ├── executor.js
│   │   ├── idempotency.js
│   │   ├── logWriter.js
│   │   └── history.js
│   ├── replication/
│   │   ├── leaderReplicator.js
│   │   ├── applier.js
│   │   ├── ackTracker.js
│   │   ├── follower.js
│   │   └── lag.js
│   ├── clocks/
│   │   ├── physicalClock.js
│   │   ├── lamportClock.js
│   │   └── berkeley.js
│   ├── election/
│   │   ├── bully.js
│   │   ├── ring.js
│   │   ├── failureDetector.js
│   │   └── electionLog.js
│   ├── faulttolerance/
│   │   ├── epochs.js
│   │   ├── promotion.js
│   │   ├── fencing.js
│   │   ├── rejoin.js
│   │   └── failoverController.js
│   ├── workers/
│   │   ├── pool.js
│   │   ├── worker.js
│   │   ├── barrier.js
│   │   └── scenarios.js
│   ├── contracts/
│   │   ├── methods.js
│   │   └── errors.js
│   └── shared/
│       ├── rpc/
│       │   ├── server.js
│       │   ├── client.js
│       │   ├── envelope.js
│       │   └── meta.js
│       ├── db/
│       │   ├── pool.js
│       │   └── migrate.js
│       ├── config.js
│       ├── logger.js
│       ├── events.js
│       ├── faults.js
│       └── ids.js
├── tests/
│   ├── unit/
│   ├── integration/
│   └── acceptance/
├── scripts/
│   ├── wait-for-cluster.sh
│   ├── demo-reset.js
│   └── check-no-hardcoded-output.sh
└── docs/
    ├── demo-scenarios.md
    ├── limitations.md
    └── protocol-notes.md
```

---

## 3. Phase-by-Phase Implementation Roadmap

Each phase is executed strictly in sequential order. Phase $N+1$ will never commence until all unit, integration, and exit criteria for Phase $N$ are completely verified against the live Docker cluster.

---

### Phase 0: Foundation & Topology
**Focus:** Infrastructure skeleton, Docker compose orchestration, DB isolation, base configuration, migration runner, basic JSON-RPC, and failure detection.

#### Tasks & Deliverables
1. **Package Configuration:**
   - Create `package.json` with scripts: `test:unit`, `test:integration`, `test:acceptance`, `cli`, `demo:reset`.
   - Install dependencies: `express`, `pg`, `pino`.
2. **Docker Orchestration:**
   - Create `docker/Dockerfile` (Node 20 Alpine, CommonJS).
   - Create `docker-compose.yml` with 10 services:
     - 4 Postgres containers: `postgres-a..d` on bridge network `bank-net`, volumes `pgdata-a..d`, unique DB credentials, custom health checks (`pg_isready`).
     - 4 Node containers: `bank-node-a..d`, ports 3001–3004, env configuration (`NODE_ID`, `DATABASE_URL`, `PEERS`, etc.), `restart: "no"`.
     - 1 Coordinator container: `bank-coordinator`, port 8080.
     - 1 CLI container: `bank-cli` with `profiles: ["cli"]`, Docker socket mount for container control.
   - Create `.env.example`.
3. **Database Migration Runner:**
   - Implement `src/shared/db/pool.js` (connection pool with pg) and `src/shared/db/migrate.js` (reads SQL migration files, records executed files in `schema_migrations`).
   - Create base migrations:
     - `db/migrations/003_cluster.sql`: creates `cluster_nodes`, `node_state`, `event_log`.
4. **Configuration & Shared Utilities:**
   - Implement `src/shared/config.js`: validates all environment variables from Section 27. **Enforce DB isolation rule:** verify that `DATABASE_URL` host matches `postgres-${NODE_ID}`; refuse to boot on mismatch.
   - Implement `src/shared/logger.js`: structured JSON logger with pino.
   - Implement `src/shared/ids.js`: UUID and prefixed ID generators.
5. **Basic JSON-RPC 2.0 Server & Client:**
   - Implement `src/shared/rpc/envelope.js`: parse and format JSON-RPC 2.0 requests, responses, and typed errors.
   - Implement `src/shared/rpc/server.js`: Express middleware handling `POST /rpc`.
   - Implement `src/shared/rpc/client.js`: HTTP client with `fetch`, timeout handling (`AbortSignal.timeout`), and typed errors.
6. **Node Boot & Basic Endpoints:**
   - Implement `GET /health` (`{nodeId, pid, hostname, dbHealthy, role, epoch}`).
   - Implement `cluster.ping`, `cluster.getState`, `cluster.heartbeat` RPC methods in `src/node/methods/cluster.js`.
   - Implement `src/election/failureDetector.js`: periodic heartbeat pinging to all `PEERS` (1s); mark peer suspect if no heartbeat for `FAILURE_TIMEOUT_MS` (4000ms).
7. **Testing:**
   - Unit tests: RPC envelope parsing, config validation, DB isolation checker.
   - Integration test: `tests/integration/phase0.test.js`.

#### Exit Criteria
- `docker compose up -d` brings up 10 healthy services.
- Each node responds on its port with distinct `nodeId`, `hostname`, `pid`.
- Node A refuses to boot if passed `postgres-b` in `DATABASE_URL`.
- `cluster.getState` on every node lists all 3 peers as alive.
- Stopping `bank-node-b` causes nodes A, C, D to mark B `suspected` within 4–5 seconds; restarting B restores status to alive.

---

### Phase 1: Core Banking & Transaction Invariants
**Focus:** ACID banking operations on the primary, strict money typing, idempotency, ordered row locks, audit ledger, LSN allocation, hash-chained log, and DB-level fencing.

#### Tasks & Deliverables
1. **Full Database Migrations:**
   - `db/migrations/001_core.sql`: `accounts`, `idempotency_keys`, `transactions`, `ledger_entries`.
   - `db/migrations/002_replication.sql`: `replication_log`, `replication_peer_state`, `replication_errors`, `divergent_log`.
2. **Domain Models & Validation:**
   - `src/domain/money.js`: decimal string validation (`^\d{1,12}(\.\d{1,2})?$`), string formatting, zero JS `Number` usage.
   - `src/domain/validators.js`: validation for account IDs, holder names, transfer inputs.
   - `src/domain/invariants.js`: SQL verification for Invariants I1–I12 (no negative balance, ledger/balance agreement, money conservation, checksum calculation).
3. **Log Writer & Hash Chaining:**
   - `src/txn/logWriter.js`: inside the active SQL transaction, locks `node_state` (id=1), allocates `lsn = last_lsn + 1`, canonicalizes JSON payload, computes `entry_hash = sha256(prev_hash || lsn || epoch || payload)`, updates `node_state`, inserts into `replication_log`.
4. **Unified Banking Executor (`src/txn/executor.js`):**
   - Implement the complete algorithm from Section 14.1:
     1. Claim idempotency key (`INSERT INTO idempotency_keys ... ON CONFLICT DO NOTHING`). If conflict, return stored result (`duplicate=true`) or throw `IDEMPOTENCY_KEY_REUSED` on payload mismatch.
     2. Lock accounts `FOR UPDATE` ordered strictly by `account_id ASC` (deadlock prevention).
     3. Business check: account exists, active, sufficient funds. Missing account rolls back with `ACCOUNT_NOT_FOUND`. Insufficient funds commits a `TXN_REJECTED` row with reason.
     4. Update account balances and increment `version = version + 1`.
     5. Fence check: lock `node_state` (id=1) `FOR UPDATE`; assert `role = 'primary' AND epoch = promised_epoch`. Roll back with `NOT_PRIMARY` or `STALE_LEADER` if check fails.
     6. Log & Ledger: call `logWriter`, insert `transactions`, insert `ledger_entries` (double-entry audit lines), store final result in `idempotency_keys`.
     7. Commit SQL transaction.
5. **Node Banking Methods:**
   - Implement `bank.createAccount`, `bank.deposit`, `bank.withdraw`, `bank.transfer`, `bank.getBalance`, `bank.getAccount`, `bank.listAccounts`, `bank.getHistory` in `src/node/methods/bank.js`.
   - Implement `admin.verifyInvariants` and `admin.stateChecksum` in `src/node/methods/admin.js`.
   - Static interim bootstrap: Node A starts with `role = 'primary'`, epoch = 1; Nodes B, C, D start as `role = 'replica'`.
   - Non-primary nodes reject mutating bank RPCs with `NOT_PRIMARY` and `leaderHint = 'a'`.
6. **Testing:**
   - Unit tests: money regex, canonical JSON hash chaining, invariant logic.
   - Integration test: `tests/integration/phase1.test.js` verifying deposits, withdrawals, transfers, overdraft rejection, idempotency replay, and invariant enforcement.

#### Exit Criteria
- Direct RPC calls to Node A successfully execute all banking operations.
- Non-primary nodes return `-32005 NOT_PRIMARY` with `leaderHint = 'a'`.
- Overdrafts and transfers with insufficient funds produce `COMMITTED = false` / `status = REJECTED` transaction rows without altering balances.
- Duplicate idempotency keys return the exact original result with `duplicate: true`.
- Killing Node A mid-transfer results in clean rollback (verified via `verifyInvariants`).
- Data persists across `docker compose restart`.
- LSN sequence is strictly gap-free (1..N) and hash chain validates on Node A.

---

### Phase 2: Client-Server Communication (RPC) [COMPLETED - Git Commit 8863f2b]
**Focus:** Full JSON-RPC 2.0 transport, `_meta` envelope with distributed trace propagation, coordinator gateway, parameter validation contracts, and idempotent retries.

#### Tasks & Deliverables
1. **Contract Definitions:**
   - `src/contracts/methods.js`: param schemas and validation functions for all RPC methods.
   - `src/contracts/errors.js`: standard error codes (-32700..-32603) and banking error codes (-32001..-32016).
2. **Metadata & Distributed Tracing:**
   - `src/shared/rpc/meta.js`: inject and propagate `_meta` containing `from`, `traceId`, `lamport`, `physicalTs`, `epoch`, and `trace[]`.
   - `src/shared/events.js`: record request trace hops (`rpc.received`, `db.commit`, `rpc.responded`) with monotonic micro-durations (`dtMs` via `process.hrtime`).
3. **Coordinator Gateway (`src/coordinator/gateway.js`):**
   - Implement `gateway.call`:
     - Resolves leader from `leaderTracker.js` (polled from `cluster.getState`).
     - Routes mutating calls (`bank.*` writes) strictly to the leader.
     - Merges coordinator trace spans with downstream node trace spans.
     - Enforces write timeouts (`LEADER_WAIT_MS` = 15000ms, per-call `RPC_TIMEOUT_MS` = 2000ms).
     - Retries idempotent write requests with the **same** `idempotencyKey` on network errors or `NOT_PRIMARY` (re-resolving leader).
4. **Coordinator Server (`src/coordinator/server.js`):**
   - Express server on port 8080 exposing `POST /rpc` and `GET /health`.
   - Endpoints: `gateway.call`, `gateway.clusterStatus`.
5. **Non-Interactive CLI Commands:**
   - Basic CLI subcommands (`node src/cli/index.js rpc deposit ...`) to verify wire communication and print rendered trace steps.
6. **Fault Injection Infrastructure:**
   - `src/shared/faults.js`: in-memory fault registry gated by `ENABLE_FAULT_INJECTION=true`.
   - Implement `rpcDelayMs` knob: injects delay before node handles RPC to test client timeout and retries.
7. **Testing:**
   - Unit tests: param contract validators, trace merging.
   - Integration test: `tests/integration/phase2.test.js`.

#### Exit Criteria
- CLI calls coordinator, coordinator calls Node A; response returns merged trace displaying all three container hops.
- Invalid method or parameters return `-32602` without hitting the database.
- Mutating call sent to Node B returns `NOT_PRIMARY` with `leaderHint = 'a'`.
- Injecting `rpcDelayMs = 2500` causes coordinator RPC timeout and automatic idempotent retry.

---

### Phase 3: Multithreading & Concurrency (Experiment 2) [COMPLETED - Git Commit 7d09162]
**Focus:** Real OS threads via `worker_threads`, PostgreSQL row-lock contention, zero JS locks, simultaneous barrier release via `SharedArrayBuffer` & `Atomics`, batch execution, and crash handling.

#### Tasks & Deliverables
1. **Worker Pool Architecture:**
   - `src/workers/worker.js`: running inside a dedicated `worker_threads` isolate.
     - Creates its own isolated `pg.Pool({ max: 1 })`.
     - Queries `SELECT pg_backend_pid()` to report distinct backend PID.
     - Imports `src/txn/executor.js` (identical code path as RPC).
     - Synchronizes on start barrier using `Atomics.wait(barrierArray, 0, 0)`.
     - Measures lock wait duration around `FOR UPDATE` statement.
   - `src/workers/barrier.js`: manages `SharedArrayBuffer` with `Int32Array` for simultaneous release via `Atomics.store` + `Atomics.notify`.
   - `src/workers/pool.js`: spawns up to `WORKER_POOL_SIZE` (default 4, max 16) workers, dispatches tasks, collects results, manages worker crashes and restarts.
2. **Batch Runner & Distribution:**
   - `src/workers/scenarios.js`: predefined test scenarios:
     - `parallel-withdrawals`: 4 workers × ₹2,000 on account with ₹10,000 (all succeed).
     - `conflicting-withdrawals`: 2 workers × ₹4,000 on account with ₹5,000 (exactly 1 succeeds, 1 rejected).
     - `stress`: N requests across K accounts with mixed deposit/withdraw/transfer.
     - `duplicate-flood`: 10 workers simultaneously submitting identical idempotency key.
     - `worker-crash`: worker deliberately calls `process.exit(1)` after lock acquisition (`workerCrashOnTask` knob) to prove PostgreSQL rolls back open transactions.
3. **RPC Integration:**
   - Implement `worker.runBatch` and `worker.getActivity` in `src/node/methods/worker.js`.
4. **Testing:**
   - Integration test: `tests/integration/phase3.test.js` running all 5 scenarios and asserting thread/PID distinctness and mathematical balance conservation.

#### Exit Criteria
- Worker report displays distinct `threadId` and `pg_backend_pid` for every worker.
- Overlapping execution intervals `[tStart, tEnd]` prove simultaneous execution.
- `conflicting-withdrawals` results in exactly 1 commit and 1 rejection across 50 consecutive runs.
- `stress` test conserves total money: $\sum \text{balances} = \text{initial} + \text{deposits} - \text{withdrawals}$.
- `worker-crash` rolls back cleanly without phantom debits or deadlocks.

---

### Phase 4: Physical & Logical Clocks (Experiment 3)
**Focus:** Application-managed physical clocks with drift and offset, Berkeley clock synchronization, Lamport logical clocks, causal event ordering.

#### Tasks & Deliverables
1. **Application-Managed Physical Clock:**
   - `src/clocks/physicalClock.js`:
     - $\text{physicalNow}() = \max(\text{lastIssued}, \text{Date.now}() + \text{offsetMs} + \text{driftPpm} \times 10^{-6} \times (\text{Date.now}() - t_0))$.
     - Monotonic guard ensures non-decreasing timestamps even after backward time adjustments.
     - Exposes `get()`, `setOffset(offsetMs, driftPpm)`, `adjust(deltaMs)`.
2. **Lamport Logical Clock:**
   - `src/clocks/lamportClock.js`:
     - Local event: $L = L + 1$.
     - Send: $L = L + 1$; attaches $L$ to `_meta.lamport`.
     - Receive: $L = \max(L, L_{\text{msg}}) + 1$.
3. **Clock Interceptors & Event Log:**
   - Stamp all incoming and outgoing RPC envelopes with Lamport and physical timestamps.
   - Record all domain and protocol events into `event_log` table with both timestamps.
   - Record `lamport_ts` and `physical_ts_ms` into `transactions` and `replication_log` at commit.
4. **Berkeley Synchronization Algorithm:**
   - `src/coordinator/timeMaster.js` & `src/clocks/berkeley.js`:
     - Coordinator polls `clock.get` from all reachable nodes, measuring RTT.
     - Computes estimated offset: $\delta_i = (T_i + \text{RTT}_i/2) - M_i$.
     - Discards outliers where $|\delta_i| > \text{BERKELEY\_OUTLIER\_MS}$ (10000ms).
     - Computes group average offset including master.
     - Sends `clock.adjust` to all nodes with respective deltas.
     - Queries post-sync times to verify residual spread $\le$ network RTT.
5. **RPC Endpoints:**
   - Node: `clock.get`, `clock.setOffset`, `clock.adjust`, `clock.events`.
   - Coordinator: `clock.sync`.
6. **Testing:**
   - Unit tests: Lamport clock increments and receipt max; Berkeley calculation math.
   - Integration test: `tests/integration/phase4.test.js`.

#### Exit Criteria
- Injecting $+2500$ ms offset into Node A shifts subsequent transaction `physical_ts_ms` by $\approx 2500$ ms.
- Berkeley sync reduces cluster time spread from seconds to $< 10$ ms.
- Side-by-side ordering comparison under skew demonstrates $\ge 1$ causal violation in physical timestamp order, and exactly 0 violations in Lamport order.

---

### Phase 5: Replication & Consistency Modes (Experiment 5)
**Focus:** Application-level state-machine replication, hash-chained log verification, SYNC and ASYNC modes, ack tracking, lag calculation, gap/divergence detection, and replica catch-up.

#### Tasks & Deliverables
1. **Replication Entry Format & Log Streaming:**
   - Match Section 19.2 format: `lsn`, `epoch`, `entryType`, `txnId`, `originNode`, `prevHash`, `entryHash`, `payload` (effects: transactions, ledger, account balances/versions, idempotency).
   - `src/replication/applier.js`: `applyEntry(client, entry)` applies effects in a single SQL transaction; validates `account.version = expectedVersion + 1`; updates `node_state.last_lsn`. Shared between follower replication and rejoin replay.
2. **Follower Inbound Engine (`src/replication/follower.js`):**
   - Handles `replication.append`:
     - Verifies `epoch >= promised_epoch`.
     - Validates continuity: if `prevLsn > last_lsn`, replies with `GAP`. If `prevHash` mismatches, returns `REPLICATION_DIVERGED`.
     - Skips already-applied duplicate entries (`lsn <= last_lsn` with matching hash).
     - Injects fault hooks (`applyDelayMs`, `dropNextAppend`).
3. **Leader Replication Engine (`src/replication/leaderReplicator.js`):**
   - Spawns sender loop for each peer tracking peer status in `replication_peer_state`.
   - Streams batches of up to `REPL_BATCH_SIZE` (100) unacknowledged log entries.
   - Implements back-off on network failures; handles `GAP` by rewinding `next_lsn`.
   - Supports fault knobs: `replicationDelayMs{peer}`, `blockReplicationTo[]`.
4. **Acknowledgement Tracker & Consistency Modes:**
   - `src/replication/ackTracker.js`:
     - Tracks `match_lsn` per peer. Computes `durable_lsn` = highest LSN acknowledged by designated backup + at least `SYNC_ACKS - 1` other followers (on $\ge 3$ nodes).
     - **SYNC Mode:** transaction execution awaits `durable_lsn >= lsn` or times out after `SYNC_TIMEOUT_MS` (3000ms) with `REPLICATION_QUORUM_TIMEOUT` (`outcome: "INDETERMINATE"`). Pre-checks for healthy quorum of followers before starting transaction; fails fast with `INSUFFICIENT_REPLICAS` if down.
     - **ASYNC Mode:** completes immediately upon local commit with `durability: "LOCAL"`; ships in background every `ASYNC_BATCH_INTERVAL_MS` (100ms).
5. **Replication RPCs & State Queries:**
   - `replication.append`, `replication.fetch`, `replication.hashAt`, `replication.status`, `replication.leaderStatus`, `replication.setMode`, `replication.resend`.
   - Read consistency options in `bank.getBalance`: `strong` (primary only), `bounded` (max lag check), `eventual` (any non-recovering node), `minLsn` (read-your-writes).
6. **Testing:**
   - Unit tests: hash validation, ack tracking logic.
   - Integration test: `tests/integration/phase5.test.js`.

#### Exit Criteria
- Banking transactions on Node A replicate to Nodes B, C, D; direct query on all 4 databases shows identical transaction rows, ledger lines, and matching `stateChecksum`.
- In ASYNC mode, injecting `replicationDelayMs{d} = 3000` demonstrates observable lag on Node D, followed by eventual convergence.
- In SYNC mode, write latency includes the injected delay to the backup; loss of 2 followers immediately returns `INSUFFICIENT_REPLICAS`.
- Missing records trigger `GAP` and automatic rewind; resending entries increments duplicate count without altering balances.
- Restarted follower fetches missed entries and catches up to leader.

---

### Phase 6: Leader Election & Epochs (Experiment 4)
**Focus:** Bully algorithm, Ring algorithm, election message logging, candidate promotion protocol, majority quorum grants, and planned leadership handover.

#### Tasks & Deliverables
1. **Election Message Protocols:**
   - `src/election/bully.js`:
     - Sends `ELECTION` to nodes with higher rank (`a=1 < b=2 < c=3 < d=4`).
     - Waits for `OK` (`BULLY_OK_TIMEOUT_MS` = 2000ms). If `OK` received, waits for `COORDINATOR` (`COORDINATOR_WAIT_MS` = 5000ms). If timeout, declares self coordinator.
   - `src/election/ring.js`:
     - Sends `RING_TOKEN` around logical ring $a \to b \to c \to d \to a$.
     - Skips unacknowledged peers after `ELECTION_HOP_TIMEOUT_MS` (1500ms).
     - Selects candidate with highest rank among alive members.
     - Circulates `RING_COORDINATOR` message.
2. **Election Log & Auditing:**
   - Record every message (`SENT`, `RECEIVED`, `LOCAL`) in `election_log` on each node with Lamport timestamp.
   - Support `excluded` list for nodes disqualified during promotion.
3. **Epochs & Promotion Protocol (`src/faulttolerance/promotion.js`):**
   - **Step 1:** Propose $E' = \max(\text{promised\_epoch}, \text{epoch}) + 1$; persist `promised_epoch = E'`.
   - **Step 2:** Send `cluster.requestEpoch{E', candidateId, lastEpoch, lastLsn, lastHash}` to all peers.
   - **Step 3:** Peer grants if $E' > \text{promised\_epoch}$; updates `promised_epoch = E'` under `node_state` lock (drains in-flight writes; old primary steps down).
   - **Step 4 (Quorum):** Requires $\ge 3$ grants out of 4. Else aborts with `PROMOTION_REFUSED(NO_QUORUM)`.
   - **Step 5 (Log Catch-up):** Candidate verifies it holds highest `(lastEpoch, lastLsn)` among granters. If behind, fetches missing entries via `replication.fetch` from the best log holder.
   - **Step 6 (Open Epoch):** Appends `EPOCH_START{epoch: E', leaderId, backupId}` to `replication_log`; updates `node_state` (`role = 'primary'`, `epoch = E'`); opens write gate.
   - **Step 7:** Broadcasts `cluster.announceLeader{E', leaderId}`.
4. **Coordinator Leader Tracker:**
   - `src/coordinator/leaderTracker.js`: tracks leader by polling nodes; resolves leader as node with `role = 'primary'`, valid lease, and highest epoch.
5. **Manual Election & Handover:**
   - `election.start{algorithm}`: triggers Bully or Ring and runs promotion to perform clean leadership handover.
6. **Testing:**
   - Unit tests: Bully message state machine, Ring token forwarding.
   - Integration test: `tests/integration/phase6.test.js`.

#### Exit Criteria
- Running Bully with Node D stopped elects Node C; Ring election skips stopped nodes.
- Competing simultaneous elections converge on a single winner.
- Election winner successfully promotes to primary, increments epoch, and writes `EPOCH_START`.
- Coordinator automatically detects the new leader and routes subsequent writes to it.
- Old primary steps down and rejects writes with `NOT_PRIMARY`.
- Election messages appear in `election_log` of both sender and receiver.

---

### Phase 7: Load Balancing (Experiment 6)
**Focus:** Gateway routing algorithms (Round Robin, Least Connections), health monitoring, read eligibility by consistency level, and automatic failover retries.

#### Tasks & Deliverables
1. **Health Registry (`src/coordinator/registry.js`):**
   - Polls `cluster.getState` on all nodes every `LB_HEALTH_INTERVAL_MS` (1000ms).
   - Marks node unhealthy after `LB_UNHEALTHY_THRESHOLD` (2) consecutive failures or network error.
   - Restores node to eligible after `LB_RECOVERY_THRESHOLD` (3) consecutive successes and `lag <= READ_MAX_LAG_LSN` (5).
2. **Read Eligibility Matrix:**
   - `strong`: current leader only.
   - `bounded`: leader + followers with `lag <= maxLagLsn`.
   - `eventual`: all healthy non-recovering nodes.
   - Writes: strictly `LEADER_ONLY` (load balancing algorithm is never applied to writes).
3. **Balancing Algorithms:**
   - `src/coordinator/loadBalancer/roundRobin.js`: round-robin pointer advancing over eligible nodes.
   - `src/coordinator/loadBalancer/leastConnections.js`: tracks active in-flight requests per node; routes to node with minimum active requests (ties broken by lowest total served).
4. **Stats & Decision Auditing:**
   - Record every routing decision in coordinator `event_log` (`algorithm`, `eligible[]`, `activeSnapshot`, `selected`, `latencyMs`).
   - Implement `lb.run{algorithm, requests, concurrency, mix}` and `lb.stats`.
5. **Testing:**
   - Unit tests: Round Robin and Least Connections selection functions.
   - Integration test: `tests/integration/phase7.test.js`.

#### Exit Criteria
- Round Robin distributes 40 read requests evenly (10/10/10/10) across healthy nodes.
- Injecting `rpcDelayMs{b} = 80` under Least Connections causes Node B to receive significantly fewer requests while peak active connections remain high.
- Stopping a node removes it from eligibility within 2 checks; read requests are retried on surviving nodes without client error.
- Re-started node is re-admitted only after catching up to `READ_MAX_LAG_LSN`.

---

### Phase 8: Primary-Backup Fault Tolerance (Experiment 7)
**Focus:** Automatic failover, backup-first promotion, lease self-fencing, old primary rejoin and divergence resolution, refusal scenarios, and cluster reboot.

#### Tasks & Deliverables
1. **Failure Controller (`src/faulttolerance/failoverController.js`):**
   - Monitored by periodic failure detector.
   - If primary suspected:
     - **Designated Backup:** initiates promotion immediately.
     - **Other Followers:** wait `BACKUP_GRACE_MS` (5000ms); if no new leader, run election (Bully/Ring) and promote winner.
2. **Leader Lease & Fencing (`src/faulttolerance/fencing.js`):**
   - Primary must receive heartbeat acknowledgements from $\ge 2$ peers within `LEADER_LEASE_MS` (3000ms).
   - If lease expires, primary closes write gate and transitions to `recovering`.
3. **DB-Down Step-Down & Backup Re-designation:**
   - If primary's local database fails (`dbHealthy = false`), primary steps down immediately.
   - If backup fails in SYNC mode, primary re-designates next healthy follower via `CONFIG_CHANGE`.
4. **Rejoin & Log Divergence Resolution (`src/faulttolerance/rejoin.js`):**
   - Deposed/restarted node starts in `recovering`.
   - Binary searches highest common LSN $k$ with leader using `replication.hashAt`.
   - Archives any divergent entries $> k$ into `divergent_log` with payloads and reasons.
   - Resets state by clearing accounts and replaying its own log $1..k$ via `applier.applyEntry`.
   - Fetches missing entries from leader $k+1..$ until caught up, then transitions to `replica`.
5. **Promotion Refusal Handling:**
   - `NO_QUORUM`: $< 3$ grants aborts promotion; system remains read-only.
   - `STALE_CANDIDATE`: candidate lagging required durable log or blocked by `blockFetch` is refused and added to `excluded`.
6. **Full Cluster Restart Procedure:**
   - Replace interim static bootstrap with full dynamic `BOOTSTRAP_PRIMARY` logic from Section 9.2.
7. **Testing:**
   - Integration test: `tests/integration/phase8.test.js` validating acceptance scenarios T24–T28.

#### Exit Criteria
- **T24:** In SYNC mode, killing Node A promotes Node B within 20s; all 20 acknowledged transactions are preserved; new writes succeed on Node B.
- **T25:** Stopping Leader A and Node C causes promotion to fail with `NO_QUORUM`; writes return `NO_LEADER`; eventual reads continue.
- **T26:** Lagging candidate D winning Bully election is refused with `STALE_CANDIDATE`; rerun promotes Node C.
- **T27:** Isolating Node A causes lease expiry $\le 3$s; Node A stops accepting writes before Node B promotes.
- **T28:** In ASYNC mode, un-replicated writes on dead primary are reported in the loss window and correctly archived in `divergent_log` upon restart.

---

### Phase 9: Terminal Interface & Experiment Integration
**Focus:** Complete interactive terminal CLI, real-time status banner, zero canned prose, live event rendering, assertions on real data, confirmed reset.

#### Tasks & Deliverables
1. **Terminal Architecture (`src/cli/`):**
   - `src/cli/index.js`: interactive loop using `readline/promises`.
   - `src/cli/menu.js`: main menu (options 0–12) matching Section 23.2; dynamic one-line cluster status banner.
   - `src/cli/render.js`: ASCII table printers, trace renderers, and assertion verification formatters.
   - `src/cli/dockerControl.js`: interacts with Docker Engine API via `/var/run/docker.sock` to stop/kill/start allow-listed containers (`bank-node-*`, `postgres-*`).
2. **Experiment Screens (`src/cli/experiments/`):**
   - `rpc.js`: Menu 1 (create account, deposit, withdraw, transfer, resend, timeout test).
   - `multithreading.js`: Menu 2 (concurrent scenarios, stress test, worker crash, activity view).
   - `clocks.js`: Menu 3 (view clocks, set offset, Berkeley sync, compare causal ordering).
   - `election.js`: Menu 4 (run Bully, run Ring, competing elections, message audit).
   - `replication.js`: Menu 5 (sync/async mode, lag/acks, delay injection, duplicate resend, convergence wait).
   - `loadBalancing.js`: Menu 6 (algorithm selection, read load test, rpcDelay injection, failover test).
   - `faultTolerance.js`: Menu 7 (kill primary, watch failover, refusal scenarios, restart & rejoin).
   - `cluster.js`: Menu 8 (cluster status), Menu 9 (history), Menu 10 (verify invariants), Menu 11 (fault injection panel), Menu 12 (confirmed `RESET`).
3. **Tamper Test & Verification:**
   - Strict adherence to Section 23.1: **Zero theory, zero explanatory text, zero hardcoded values.**
   - All `PASS`/`FAIL` lines computed dynamically from actual RPC responses and database queries.
4. **Anti-Hardcoding Audit Script:**
   - `scripts/check-no-hardcoded-output.sh`: scans CLI sources for canned output strings.
5. **Testing:**
   - Acceptance test: `tests/acceptance/t30.test.js` validating all menu paths and SQL tamper detection.

#### Exit Criteria
- Every menu option executes against the running Docker cluster.
- Financial transactions executed in Menu 1 immediately reflect in Menus 5, 8, 9, 10.
- Modifying account balance directly via `psql` on a replica is immediately caught by Menu 10 (`stateChecksum` mismatch).
- No hardcoded strings or explanatory paragraphs present in CLI output.

---

### Phase 10: End-to-End Validation & Demonstration
**Focus:** Automated execution of all 30 acceptance tests (T01–T30), documentation, Section 34 checklist completion.

#### Tasks & Deliverables
1. **Acceptance Test Suite (`tests/acceptance/`):**
   - Automate tests T01 through T30 exactly as specified in Section 29 of `PROJECT.md`:
     - T01: 4 distinct node processes (PIDs, hostnames).
     - T02: 4 distinct databases (independent tables and credentials).
     - T03: Data persistence across `docker compose restart`.
     - T04: Multi-hop RPC traces across container boundaries.
     - T05: Idempotency under serial and concurrent load.
     - T06: Overdraft and atomic rollback.
     - T07: Parallel withdrawals.
     - T08: Conflicting withdrawals (50 runs).
     - T09: Real worker threads and backend PIDs.
     - T10: Worker crash rollback and retry.
     - T11: Physical clock offset and Berkeley convergence.
     - T12: Lamport causal consistency vs physical clock violations.
     - T13: Bully election with node failure.
     - T14: Ring election skipping failed node.
     - T15: Competing elections convergence.
     - T16: ASYNC replication, lag, and convergence.
     - T17: SYNC vs ASYNC acknowledgement latencies.
     - T18: SYNC failure on insufficient replicas.
     - T19: Duplicate delivery skipping and gap recovery.
     - T20: Offline replica catch-up upon restart.
     - T21: Round Robin read distribution.
     - T22: Least Connections skew under latency.
     - T23: Unhealthy node exclusion and re-admission.
     - T24: SYNC failover with zero loss of acknowledged data.
     - T25: Promotion refusal on missing quorum.
     - T26: Promotion refusal on stale candidate.
     - T27: Isolated primary lease self-fencing.
     - T28: ASYNC loss window reporting and divergent log archiving.
     - T29: Full invariant verification across all nodes.
     - T30: CLI completeness and database tamper detection.
2. **Project Documentation:**
   - `docs/demo-scenarios.md`: step-by-step reproduction scripts for viva demonstration.
   - `docs/limitations.md`: complete transcription of known trade-offs and non-guarantees from Section 31.
   - `docs/protocol-notes.md`: formal specifications of replication, election, and promotion protocols.
   - `README.md`: clean-checkout build and execution guide.
3. **Final Gate Verification:**
   - Execute Section 34 checklist items and generate complete evidence artifact.

#### Exit Criteria
- Clean clone passes `docker compose build && docker compose up -d && npm run test:acceptance`.
- All 30 acceptance tests pass cleanly.
- Section 34 checklist is 100% verified with recorded outputs.

---

## 4. Acceptance Test Matrix (T01–T30)

| Test ID | Description | Primary Enabling Phase | Verification Command |
|---|---|---|---|
| **T01** | Four independent node processes | Phase 0 | `node --test tests/acceptance/t01.test.js` |
| **T02** | Four independent databases | Phase 0 | `node --test tests/acceptance/t02.test.js` |
| **T03** | Persistence across container restarts | Phase 1 | `node --test tests/acceptance/t03.test.js` |
| **T04** | RPC crosses container boundaries | Phase 2 | `node --test tests/acceptance/t04.test.js` |
| **T05** | Idempotent retry deduplication | Phase 1 & 2 | `node --test tests/acceptance/t05.test.js` |
| **T06** | Overdraft & atomic failure | Phase 1 | `node --test tests/acceptance/t06.test.js` |
| **T07** | Parallel withdrawals | Phase 3 | `node --test tests/acceptance/t07.test.js` |
| **T08** | Conflicting withdrawals (50 runs) | Phase 3 | `node --test tests/acceptance/t08.test.js` |
| **T09** | Worker threads are genuine OS threads | Phase 3 | `node --test tests/acceptance/t09.test.js` |
| **T10** | Worker crash rollback safety | Phase 3 | `node --test tests/acceptance/t10.test.js` |
| **T11** | Physical clocks & Berkeley sync | Phase 4 | `node --test tests/acceptance/t11.test.js` |
| **T12** | Lamport vs physical ordering | Phase 4 | `node --test tests/acceptance/t12.test.js` |
| **T13** | Bully election with node failure | Phase 6 | `node --test tests/acceptance/t13.test.js` |
| **T14** | Ring election skipping dead node | Phase 6 | `node --test tests/acceptance/t14.test.js` |
| **T15** | Competing simultaneous elections | Phase 6 | `node --test tests/acceptance/t15.test.js` |
| **T16** | Async replication, lag & convergence | Phase 5 | `node --test tests/acceptance/t16.test.js` |
| **T17** | Sync vs Async ack latency | Phase 5 | `node --test tests/acceptance/t17.test.js` |
| **T18** | Sync mode insufficient replicas | Phase 5 | `node --test tests/acceptance/t18.test.js` |
| **T19** | Duplicate delivery & gap recovery | Phase 5 | `node --test tests/acceptance/t19.test.js` |
| **T20** | Replica restart recovery | Phase 5 | `node --test tests/acceptance/t20.test.js` |
| **T21** | Round Robin load distribution | Phase 7 | `node --test tests/acceptance/t21.test.js` |
| **T22** | Least Connections under latency | Phase 7 | `node --test tests/acceptance/t22.test.js` |
| **T23** | Health exclusion & re-admission | Phase 7 | `node --test tests/acceptance/t23.test.js` |
| **T24** | SYNC failover zero data loss | Phase 8 | `node --test tests/acceptance/t24.test.js` |
| **T25** | Promotion refusal: NO_QUORUM | Phase 8 | `node --test tests/acceptance/t25.test.js` |
| **T26** | Promotion refusal: STALE_CANDIDATE | Phase 8 | `node --test tests/acceptance/t26.test.js` |
| **T27** | Isolated primary lease self-fencing | Phase 8 | `node --test tests/acceptance/t27.test.js` |
| **T28** | ASYNC loss window & divergent rejoin | Phase 8 | `node --test tests/acceptance/t28.test.js` |
| **T29** | Banking invariants (I1–I12) verification | Phase 1 & 8 | `node --test tests/acceptance/t29.test.js` |
| **T30** | Terminal CLI & DB tamper detection | Phase 9 | `node --test tests/acceptance/t30.test.js` |

---

## 5. Current Gate & Next Step

- **Current State:** `IMPLEMENTATION_PLAN.md` has been generated from the comprehensive specification in `PROJECT.md`.
- **Next Step:** Awaiting explicit user approval.
- **Rule:** Do not write any code for Phase 0 or Phase 1 until the user approves this implementation plan.
