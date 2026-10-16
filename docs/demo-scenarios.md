# Distributed Banking System — Viva & Demo Scenarios

This document provides step-by-step reproduction scripts for demonstrating all seven Distributed Computing laboratory experiments during a viva or practical examination.

---

## Prerequisites
Ensure the cluster is up and healthy:
```bash
docker compose up -d
npm run demo:reset
npm run cli
```

---

## Scenario 1: Experiment 1 — Client-Server Communication (RPC)
**Menu Option:** `1. Experiment 1: Client-Server RPC`

### Steps
1. Select `1` (Create Account):
   - Enter Holder Name: `Alice Cooper`
   - Opening Deposit: `5000.00`
   - Observe real-time multi-hop trace: `cli -> coordinator -> node-a -> db.commit -> coordinator -> cli` with microsecond hop latencies and Lamport timestamps.
2. Select `2` (Deposit):
   - Select the account created above, amount `1000.00`.
   - Observe LSN increment and local durability.
3. Select `6` (Resend Last Request / Idempotency Test):
   - The CLI resubmits the exact same idempotency key.
   - Observe `idempotency.hit` in the node log: returns `duplicate: true`, identical transaction hash, and zero balance modification.
4. Select `7` (Injected RPC Delay & Timeout Test):
   - Inject 2500ms delay.
   - Observe coordinator timeout handling and client retry behavior.

---

## Scenario 2: Experiment 2 — Multithreading & Database Row-Locking
**Menu Option:** `2. Experiment 2: Multithreading`

### Steps
1. Select `1` (Run parallel-withdrawals):
   - 4 worker threads attempt ₹2,000 withdrawals concurrently from an account with ₹10,000.
   - Verify:
     - 4 distinct `threadId` (from Node.js `worker_threads`).
     - 4 distinct `pg_backend_pid` (from PostgreSQL `SELECT pg_backend_pid()`).
     - Overlapping execution intervals $[t_{\text{start}}, t_{\text{end}}]$.
     - Final balance = ₹2,000.00 (`PASS`).
2. Select `2` (Run conflicting-withdrawals):
   - 2 worker threads attempt ₹4,000 withdrawals from an account with ₹5,000.
   - Verify: Exactly 1 transaction commits (`COMMITTED`), and exactly 1 transaction rejects with `INSUFFICIENT_FUNDS` (`REJECTED`). Final balance = ₹1,000.00.
3. Select `3` (Worker Crash & Rollback Safety):
   - A worker process deliberately crashes mid-transaction (`workerCrashOnTask`).
   - Verify: PostgreSQL rolls back open transaction; the task retries with the same idempotency key; balance is conserved with zero phantom debits.

---

## Scenario 3: Experiment 3 — Physical and Logical Clocks
**Menu Option:** `3. Experiment 3: Clocks`

### Steps
1. Select `1` (View Clocks):
   - Displays real-time physical clocks, offsets, ISO strings, and Lamport ticks for Node A, B, C, D, and Coordinator.
2. Select `2` (Set Clock Offset / Inject Skew):
   - Inject offsets: Node A = 0 ms, Node B = +2500 ms, Node C = -1800 ms, Node D = +700 ms.
3. Select `4` (Compare Causal Event Ordering):
   - Executes a deposit on Node A replicated to Node B under skew.
   - Demonstrates that physical timestamp ordering shows **$\ge 1$ causal violation** (receive appears before send).
   - Demonstrates that Lamport logical timestamp ordering strictly guarantees **0 causal violations**.
4. Select `3` (Synchronize Clocks via Berkeley Algorithm):
   - Coordinator polls nodes, measures RTT, excludes outliers, computes average offset, and sends corrections.
   - Post-sync cluster time spread drops from $>4000$ ms to $<10$ ms.

---

## Scenario 4: Experiment 4 — Bully and Ring Leader Election
**Menu Option:** `4. Experiment 4: Election`

### Steps
1. Select `1` (Run Bully Election):
   - Stop or exclude Node D.
   - Start Bully from Node B.
   - Observe `ELECTION` message sent to higher rank nodes C and D.
   - D times out, C responds `OK`, C announces `COORDINATOR`.
   - Node C promotes to primary with new epoch ($E \ge 2$).
2. Select `2` (Run Ring Election):
   - Stop or exclude Node C.
   - Start Ring from Node A.
   - Token travels along logical ring $a \to b \to d \to a$, skipping offline node C.
   - Node D selected as highest-rank live candidate; `RING_COORDINATOR` announces D as new leader.
3. Select `4` (View Election Message Audit Log):
   - Inspect local `election_log` rows with Lamport timestamps, senders, receivers, and latencies.

---

## Scenario 5: Experiment 5 — Replication and Consistency Modes
**Menu Option:** `5. Experiment 5: Replication`

### Steps
1. Select `1` (Toggle Replication Mode):
   - Switch between `ASYNC` and `SYNC` modes.
2. Select `2` (View Replication Status & Lag):
   - Shows leader `applied_lsn`, follower `applied_lsn`, lag, round-trip replication latencies, and state checksums.
3. Select `3` (Inject Replication Delay & Observe Lag):
   - In ASYNC mode, inject `replicationDelayMs = 2500` to Node D.
   - Submit deposit on leader: deposit acks instantly to client (`durability: LOCAL`).
   - Node D displays lag = 1; after delay elapses, Node D converges to matching LSN and checksum.
4. Select `4` (Test SYNC Mode Acknowledgement Latency):
   - In SYNC mode, inject 1500 ms delay to designated backup B.
   - Submit deposit: client wait duration includes the 1500 ms delay; returns `durability: QUORUM`.

---

## Scenario 6: Experiment 6 — Load Balancing
**Menu Option:** `6. Experiment 6: Load Balancing`

### Steps
1. Select `1` (Select Algorithm & Run Load Test):
   - Run 40 read requests under **Round Robin**:
     - Distribution: 10 / 10 / 10 / 10 across Nodes A, B, C, D.
2. Select `2` (Least Connections under Latency Skew):
   - Inject `rpcDelayMs = 80` to Node B.
   - Run 40 read requests under **Least Connections**:
     - Node B active connections accumulate; algorithm routes away from B; faster nodes absorb the traffic.
3. Health-Aware Exclusion:
   - Stop Node C. Registry marks C unhealthy after 2 failed checks.
   - Load balancer redistributes reads evenly across surviving nodes A, B, D without client errors.

---

## Scenario 7: Experiment 7 — Primary-Backup Fault Tolerance & Failover
**Menu Option:** `7. Experiment 7: Fault Tolerance`

### Steps
1. Select `1` (Simulate Primary Crash & Automatic Failover):
   - In SYNC mode with acknowledged deposits, primary (Node A) is stopped.
   - Designated backup (Node B) promotes to primary with new epoch ($E=2$).
   - All acknowledged transactions are intact; new writes succeed on Node B.
2. Select `2` (Promotion Refusal Scenarios):
   - Missing Quorum: Stopping 2 of 4 nodes leaves fewer than 3 grants; promotion fails fast with `-32012 PROMOTION_REFUSED (NO_QUORUM)`.
   - Stale Candidate: Candidate lagging durable state is refused with `STALE_CANDIDATE`.
3. Select `3` (Primary Isolation & Lease Self-Fencing):
   - Node A is isolated from peers. Heartbeat lease expires ($\le 3$s).
   - Writes directly submitted to Node A are rejected with `-32005 NOT_PRIMARY` before backup promotes.
4. Select `4` (Deposed Primary Rejoin & Divergent Log Resolution):
   - Old primary rejoins cluster as replica via `cluster.rejoin`.
   - Binary searches common prefix with new leader; archives divergent entries in `divergent_log`; catches up to leader LSN.

---

## Scenario 8: Cross-Cutting Audit & Invariant Verification
**Menu Option:** `10. Verify Banking Invariants`

- Executes full SQL verification of Invariants I1–I12:
  - I1: No negative balances.
  - I8: Ledger entries exactly match account balances.
  - I9: Total money conservation across deposits and withdrawals.
  - I10: Gap-free, monotonically increasing LSNs and valid SHA-256 hash chains.
  - I11: Monotonic epoch fencing.
  - I12: Cross-node state checksum matching.
