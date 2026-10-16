# Distributed Banking System — Protocol Specifications & Notes

This document provides formal specifications for the core distributed protocols implemented in the system.

---

## 1. Application-Level State-Machine Replication

### 1.1 Replication Log Entry Schema
Every committed state-mutating transaction appends a deterministic entry to `replication_log`:
- `lsn` (BIGINT): Monotonically increasing sequence number (1, 2, 3...).
- `epoch` (BIGINT): Monotonically increasing leadership era.
- `entry_type` (VARCHAR): `TXN`, `EPOCH_START`, `CONFIG_CHANGE`.
- `txn_id` (UUID): Unique transaction identifier.
- `origin_node` (VARCHAR): Node ID where the transaction was executed.
- `prev_hash` (CHAR(64)): SHA-256 hash of the immediate predecessor entry (or 64 zeros for LSN 1).
- `entry_hash` (CHAR(64)): Deterministic SHA-256 hash computed over:
  $$\text{entry\_hash} = \text{SHA256}(\text{prev\_hash} \,||\, \text{lsn} \,||\, \text{epoch} \,||\, \text{canonicalJSON}(\text{payload}))$$
- `payload` (JSONB): Full transaction effects, including account debits/credits, balance versions, ledger entries, and idempotency key records.

### 1.2 Replication Flow
1. **Primary Commit:** Primary executes transaction under row locks, fences against `role = 'primary' AND epoch = promised_epoch`, allocates `lsn`, computes `entry_hash`, and commits to local PostgreSQL.
2. **Log Streaming:** The leader's replication engine (`leaderReplicator.js`) streams unacknowledged log entries to follower nodes via `replication.append` RPCs.
3. **Follower Inbound Engine (`follower.js`):**
   - Verifies `epoch >= promised_epoch`.
   - Checks continuity: if $\text{prevLsn} > \text{last\_lsn}$, replies with `GAP` status triggering leader rewind.
   - Verifies hash chain: if $\text{prevHash} \ne \text{local\_prev\_hash}$, rejects with `REPLICATION_DIVERGED`.
   - Skips duplicate entries ($\text{lsn} \le \text{last\_lsn}$ with matching hash) without error.
   - Applies state changes via `applier.js` inside an atomic SQL transaction.

### 1.3 Consistency & Durability Modes
- **SYNC Mode:**
  - Requires pre-check: a quorum of followers must be healthy before execution starts, failing fast with `-32008 INSUFFICIENT_REPLICAS` if down.
  - Commits locally, then awaits acknowledgement of $\text{match\_lsn} \ge \text{lsn}$ from designated backup + $\ge 1$ additional follower.
  - Returns `durability: "QUORUM"`.
  - Times out after 3000ms with `-32009 REPLICATION_QUORUM_TIMEOUT` (`outcome: "INDETERMINATE"`).
- **ASYNC Mode:**
  - Commits locally and returns immediately to the client with `durability: "LOCAL"`.
  - Asynchronously flushes entries to followers in periodic background batches.

---

## 2. Leader Election Protocols

### 2.1 Static Rank Ordering
Node ranks are statically defined by Node ID:
$$\text{Rank}(a) = 1 < \text{Rank}(b) = 2 < \text{Rank}(c) = 3 < \text{Rank}(d) = 4$$

### 2.2 Bully Algorithm (`src/election/bully.js`)
1. **Trigger:** Candidate sends `ELECTION` RPC to all alive peers with strictly higher rank.
2. **Response:**
   - If any higher-rank peer replies `OK`, the initiator waits up to `COORDINATOR_WAIT_MS` (5000ms) for an announcement.
   - If no higher-rank peer replies within `BULLY_OK_TIMEOUT_MS` (2000ms), initiator declares itself winner.
3. **Announcement:** Winner executes the candidate promotion protocol.

### 2.3 Ring Algorithm (`src/election/ring.js`)
1. **Ring Topology:** Logical unidirectional ring: $a \to b \to c \to d \to a$.
2. **Token Passing:**
   - Candidate creates `RING_TOKEN` message containing candidate list: `[candidateId]`.
   - Transmits token to immediate clockwise successor.
   - If successor is unreachable within `ELECTION_HOP_TIMEOUT_MS` (1500ms), skips to next clockwise successor.
3. **Completion:** When the token circulates back to the initiator, the live node with the highest rank is declared winner.
4. **Coordination:** Circulates `RING_COORDINATOR` announcing the winner.

---

## 3. Candidate Promotion Protocol & Epoch Fencing

### 3.1 Step-by-Step Promotion Algorithm (`src/faulttolerance/promotion.js`)
1. **Epoch Proposal:** Propose $E' = \max(\text{promised\_epoch}, \text{epoch}) + 1$. Persist `promised_epoch = E'`.
2. **Request Grants:** Broadcast `cluster.requestEpoch` containing $(E', \text{candidateId}, \text{lastEpoch}, \text{lastLsn}, \text{lastHash})$ to all peers.
3. **Peer Grant Rule:** Peer grants if $E' > \text{promised\_epoch}$. Peer acquires row lock on `node_state (id=1)` and updates `promised_epoch = E'`. If peer was the old primary, it immediately steps down.
4. **Majority Quorum:** Candidate requires $\ge 3$ grants out of 4 nodes. Aborts with `-32012 PROMOTION_REFUSED (NO_QUORUM)` on failure.
5. **Log Catch-Up Verification:**
   - Candidate verifies it holds the latest log position among granters: $(E_{\text{cand}}, \text{LSN}_{\text{cand}}) \ge (E_{\text{peer}}, \text{LSN}_{\text{peer}})$.
   - If behind, candidate fetches missing entries via `replication.fetch` from the highest log holder.
   - If unable to catch up, aborts with `-32012 PROMOTION_REFUSED (STALE_CANDIDATE)`.
6. **Open New Epoch:**
   - Appends `EPOCH_START` record to `replication_log`.
   - Updates `node_state`: `role = 'primary'`, `epoch = E'`.
   - Starts leader replicator loops.
7. **Broadcast Announcement:** Sends `cluster.announceLeader` to all peers and coordinator.

### 3.2 Fencing at the Database Level
Every mutating transaction enforces:
```sql
SELECT role, epoch FROM node_state WHERE id = 1 FOR UPDATE;
-- Assert role = 'primary' AND epoch = promised_epoch
```
If an old primary attempts to commit after a new epoch has been promised to a successor, the transaction rolls back with `-32005 NOT_PRIMARY` or `-32006 STALE_LEADER`.

---

## 4. Rejoin and Log Divergence Resolution (`src/faulttolerance/rejoin.js`)

When an offline or deposed node recovers:
1. Boots into `role = 'recovering'`.
2. Discovers the current leader and its epoch via `cluster.getState`.
3. Performs binary search over $1..\min(\text{local\_lsn}, \text{leader\_lsn})$ using `replication.hashAt` to locate highest common LSN $k$.
4. **Divergent Log Archiving:**
   - If local entries exist $> k$ that mismatch the leader's hash chain, they are archived into `divergent_log` alongside their payloads and discrepancy reasons.
5. **State Reset & Catch-Up:**
   - Clears accounts and replays clean entries $1..k$ via `applier.applyEntry`.
   - Streams missing entries $k+1..\text{leader\_lsn}$ from the leader.
6. Transitions to `role = 'replica'`.
