# Distributed Banking System — Section 34 Final Verification Checklist

> **Specification Source of Truth:** `PROJECT.md` Section 34 ("Final Checklist: Real, Not Simulated")  
> **Status:** All criteria verified with code, unit tests, and acceptance test references.

---

## 1. Processes and Storage

- [x] **Four distinct node containers, four Postgres containers, one coordinator:**  
  *Evidence:* Defined in `docker-compose.yml` (`bank-node-a..d`, `postgres-a..d`, `bank-coordinator`, `bank-cli`). Verified by acceptance test `tests/acceptance/t01.test.js`.
- [x] **Database Isolation & Unique Credentials:**  
  *Evidence:* Each node asserts `DATABASE_URL` matches `postgres-${NODE_ID}` in `src/shared/config.js`. Unit test in `tests/unit/config.test.js` verifies node A refuses to connect to `postgres-b` or as `bank_b`. Acceptance test `tests/acceptance/t02.test.js`.
- [x] **Private Storage Volumes & Data Persistence:**  
  *Evidence:* `docker-compose.yml` mounts separate named volumes `pgdata-a..d`. Acceptance test `tests/acceptance/t03.test.js`.
- [x] **No Cross-Node Database Connections:**  
  *Evidence:* Repository scan verifies zero shared connections or cross-container connection pools.

---

## 2. Network and RPC

- [x] **Multi-Hop Trace across Container Boundaries:**  
  *Evidence:* `src/shared/rpc/meta.js` and `src/coordinator/gateway.js` propagate and record traces across `bank-cli -> bank-coordinator -> bank-node-*`. Acceptance test `tests/acceptance/t04.test.js`.
- [x] **Structured RPC Logging & Failure Handling:**  
  *Evidence:* Pino JSON logger records `rpc.received`, `db.commit`, `rpc.responded`. Timeouts and errors return typed JSON-RPC 2.0 error codes (`src/contracts/errors.js`).
- [x] **Idempotent Retry Deduplication:**  
  *Evidence:* `src/txn/executor.js` claims idempotency keys in PostgreSQL. Acceptance test `tests/acceptance/t05.test.js` verifies 5 serial and 5 concurrent retries yield identical result and single balance alteration.

---

## 3. Concurrency (Experiment 2)

- [x] **Real OS Threads & Backend PIDs:**  
  *Evidence:* `src/workers/worker.js` runs in Node.js `worker_threads`, opens dedicated `pg.Pool`, and queries `SELECT pg_backend_pid()`. Verified in `tests/acceptance/t09.test.js`.
- [x] **Conflicting Withdrawals:**  
  *Evidence:* `tests/acceptance/t08.test.js` tests `conflicting-withdrawals`: exactly 1 commits, 1 rejects with `INSUFFICIENT_FUNDS`, balance mathematically conserved.
- [x] **Worker Crash Rollback Safety:**  
  *Evidence:* `tests/acceptance/t10.test.js` verifies worker crash triggers transaction rollback and safe retry.

---

## 4. Clocks (Experiment 3)

- [x] **Physical Clock Skew & Database Impact:**  
  *Evidence:* Injected offsets via `src/clocks/physicalClock.js` directly modify `physical_ts_ms` committed in transactions (`tests/acceptance/t11.test.js`).
- [x] **Lamport Logical Ordering:**  
  *Evidence:* `tests/acceptance/t12.test.js` proves skewed physical clocks produce $\ge 1$ causal violation while Lamport ordering guarantees strictly 0 violations.
- [x] **Berkeley Clock Synchronization:**  
  *Evidence:* `src/clocks/berkeley.js` and `src/coordinator/timeMaster.js` compute average offset, filter outliers, and reduce cluster spread to $< 10$ms (`tests/unit/clocks.test.js`, `tests/acceptance/t11.test.js`).

---

## 5. Leader Election and Failover (Experiments 4 & 7)

- [x] **Bully and Ring Algorithms:**  
  *Evidence:* `src/election/bully.js` and `src/election/ring.js` exchange real RPC messages, logged to `election_log` on sender and receiver (`tests/acceptance/t13.test.js`, `tests/acceptance/t14.test.js`, `tests/acceptance/t15.test.js`).
- [x] **Epoch Fencing & Automatic Failover:**  
  *Evidence:* Promotion protocol proposing $E' = \max(\text{promised\_epoch}, \text{epoch}) + 1$ requires $\ge 3$ grants (`src/faulttolerance/promotion.js`). Database row-lock on `node_state` fences mutating writes (`tests/acceptance/t24.test.js`).
- [x] **Promotion Refusal Handling:**  
  *Evidence:* Missing quorum returns `-32012 PROMOTION_REFUSED (NO_QUORUM)` (`tests/acceptance/t25.test.js`); lagging candidate refused with `STALE_CANDIDATE` (`tests/acceptance/t26.test.js`).
- [x] **Lease Self-Fencing:**  
  *Evidence:* Isolated primary expires lease after 3s and rejects writes (`tests/acceptance/t27.test.js`).

---

## 6. Replication and Consistency (Experiment 5)

- [x] **Replicated Log & Deterministic Hash Chaining:**  
  *Evidence:* `src/txn/logWriter.js` and `src/replication/applier.js` compute deterministic SHA-256 hash chains over canonical JSON (`tests/unit/replication.test.js`). All nodes match state checksums.
- [x] **SYNC vs ASYNC Modes:**  
  *Evidence:* `src/replication/ackTracker.js` tracks quorum durability for SYNC mode. Latency difference demonstrated in `tests/acceptance/t17.test.js`.
- [x] **Zero PostgreSQL Native Replication:**  
  *Evidence:* Scan confirms no PostgreSQL streaming replication (`wal_level`, `primary_conninfo`, or `pg_subscription`). All replication is application-level state machine replication.
- [x] **ASYNC Loss Window & Divergent Log:**  
  *Evidence:* Rejoin procedure binary-searches common prefix, archives un-replicated transactions into `divergent_log`, and synchronizes state (`tests/acceptance/t28.test.js`).

---

## 7. Load Balancing (Experiment 6)

- [x] **Round Robin & Least Connections:**  
  *Evidence:* `src/coordinator/loadBalancer/roundRobin.js` and `leastConnections.js` route reads based on active connections and algorithms (`tests/acceptance/t21.test.js`, `tests/acceptance/t22.test.js`).
- [x] **Health Exclusion & Re-admission:**  
  *Evidence:* `src/coordinator/registry.js` marks nodes unhealthy after 2 consecutive failures and re-admits only after 3 successes and lag catch-up (`tests/acceptance/t23.test.js`).
- [x] **Leader-Only Writes:**  
  *Evidence:* Mutating writes are strictly routed to the leader; load balancing is never applied to writes.

---

## 8. Terminal Interface and Honesty

- [x] **Single Interactive CLI:**  
  *Evidence:* Interactive menu options 0–12 in `src/cli/menu.js` allow running all 7 experiments and operations.
- [x] **No Theoretical Prose or Hardcoded Output:**  
  *Evidence:* Automated audit in `scripts/check-no-hardcoded-output.sh` and `tests/unit/cli.test.js` confirms zero banned theoretical text in CLI source files.
- [x] **Database Tamper Detection:**  
  *Evidence:* `tests/acceptance/t30.test.js` proves CLI checksums and invariant checks derive directly from live PostgreSQL database rows.
- [x] **Financial Precision:**  
  *Evidence:* `src/domain/money.js` validates decimal strings. Unit test verifies zero use of `Number()` or `parseFloat()` for money in `src/domain/` or `src/txn/`.
