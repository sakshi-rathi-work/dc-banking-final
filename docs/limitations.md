# Distributed Banking System — Known Trade-offs and Limitations

> **Source:** `PROJECT.md` Section 31.

This document details the architectural boundaries, deliberate trade-offs, and explicit non-guarantees of the system.

---

## 1. Not a Verified Consensus Protocol
- Epoch grants + log catch-up follow Raft-like reasoning but are a simplified, laboratory design.
- There is no formal TLA+ proof, no pre-vote phase, and no dynamic cluster membership change protocol.
- The membership set $\{a, b, c, d\}$ is fixed at boot.

## 2. No Distributed Atomic Commit
- The system does not implement Two-Phase Commit (2PC) or Three-Phase Commit (3PC) across databases.
- A SYNC-mode replication timeout yields an **indeterminate** outcome (`-32009 REPLICATION_QUORUM_TIMEOUT`) until verified or retried by the client using the same idempotency key.

## 3. Primary-Side Read Visibility
- The primary node's local database reflects transactions immediately upon local commit.
- This includes transactions that have not yet reached quorum durability on followers.
- The system does not support reading exclusively quorum-durable state on the primary.

## 4. Majority Quorum Requirement ($3$ of $4$)
- The cluster requires $\ge 3$ out of 4 grants for leader promotion.
- Therefore, the cluster tolerates exactly **one** node failure while maintaining mutating write availability.
- Two simultaneous node failures make the cluster strictly read-only (mutating writes return `NO_LEADER` or `NO_QUORUM`).

## 5. Lease Safety Assumptions
- Leader lease expiration assumes approximately similar clock progression rates across containers.
- Severe virtual machine pauses or extreme clock drift can violate the assumption that the deposed leader stops accepting writes before the new leader begins.
- However, database-level epoch fencing and follower epoch checks ensure conflicting mutations cannot be accepted by replicas.

## 6. LSN Allocation Critical Section
- LSN allocation on the primary requires an exclusive row lock on `node_state (id=1)` inside the transaction.
- This serializes the commit phase of concurrent transactions, establishing an upper bound on single-node write throughput.

## 7. No Log Compaction or Snapshots
- Rejoining or catching up a replica requires streaming and replaying historical log entries from the common prefix ($O(N)$ log replay).
- The system does not maintain periodic database snapshots or WAL truncation.

## 8. Coordinator as Single Routing Point
- The coordinator process is a single point of entry for the interactive CLI and HTTP gateway routing.
- If the coordinator fails, bank nodes continue operating autonomously, but external client routing must target nodes directly.

## 9. Application-Level Fault Injection & Clocks
- Network delays, packet drops, and clock offsets are managed at the application layer within container processes.
- Containers share the underlying host OS kernel clock.
- Container stop/kill/restart operations via the Docker socket represent genuine OS process terminations.

## 10. Financial Precision & Scope Boundaries
- Zero floating-point arithmetic is permitted (`NUMERIC(14,2)` in PostgreSQL, decimal string representation in JavaScript).
- The system operates with a single unified currency (₹ INR) and does not implement authentication, KYC, or multi-currency exchange.

## 11. ASYNC Mode Data Loss Window
- In ASYNC replication mode, un-replicated transactions committed locally on a crashed primary can be lost upon failover.
- The system reports and archives these lost transactions in `divergent_log` upon rejoin rather than silently ignoring or overwriting them.
