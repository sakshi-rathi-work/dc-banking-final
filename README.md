# Real Distributed Banking System

A persistent, fault-tolerant, laboratory-scale distributed banking system built across four independent node processes, four independent PostgreSQL databases, a centralized coordinator gateway, and an interactive terminal CLI.

The system is designed to provide genuine distributed computing primitives and demonstrate seven core Distributed Computing laboratory experiments within one coherent banking application.

---

## Architecture & Topology

- **4 Bank Nodes (`bank-node-a`, `bank-node-b`, `bank-node-c`, `bank-node-d`):**
  - Independent OS processes, each in its own Docker container.
  - Expose JSON-RPC 2.0 over HTTP on user-defined bridge network `bank-net` (ports 3001–3004).
- **4 PostgreSQL Databases (`postgres-a`, `postgres-b`, `postgres-c`, `postgres-d`):**
  - Independent PostgreSQL 16 instances with private storage volumes (`pgdata-a..d`) and isolated credentials (`bank_a`/`pw_a`, etc.).
  - **Zero shared database state.** Enforced database isolation prevents cross-node database connections.
- **1 Coordinator Gateway (`bank-coordinator`):**
  - JSON-RPC gateway on port 8080, health registry, leader tracker, load balancer, and Berkeley time master. Holds no financial state.
- **1 Interactive Terminal CLI (`bank-cli`):**
  - Menu-driven terminal application (options 0–12) with zero canned output or theoretical prose.

---

## Prerequisites

- [Node.js](https://nodejs.org/) >= 20.0.0 LTS
- [Docker](https://www.docker.com/) and Docker Compose v2

---

## Quickstart

### 1. Build and Start the Cluster
```bash
docker compose build
docker compose up -d
```

### 2. Wait for Health and Seed Demo Data
```bash
# Seed initial accounts and cluster configuration
npm run demo:reset
```

### 3. Launch Interactive Terminal CLI
```bash
npm run cli
```

---

## Laboratory Experiments (Menu Guide)

| # | Menu Option | Experiment | Capabilities Demonstrated |
|---|---|---|---|
| 1 | `1` | **Client-Server RPC** | Multi-hop RPC traces, microsecond hop latencies, parameter validation, idempotent replay |
| 2 | `2` | **Multithreading** | Real OS threads via `worker_threads`, PostgreSQL row-locks, barrier release, worker crash rollback |
| 3 | `3` | **Clock Synchronization** | Application physical clocks, offset injection, Lamport causal event ordering, Berkeley sync |
| 4 | `4` | **Leader Election** | Real Bully and Ring message exchanges, audit logs, promotion protocol, monotonic epochs |
| 5 | `5` | **Replication & Consistency** | Application state-machine replication, hash chains, SYNC vs ASYNC durability, lag & gap recovery |
| 6 | `6` | **Load Balancing** | Round Robin and Least Connections routing, health monitoring, slow-node diversion |
| 7 | `7` | **Primary-Backup Failover** | Automatic backup promotion, lease self-fencing, refusal scenarios, divergent rejoin |
| — | `8–12`| **Cluster Operations** | Real-time cluster status, ledger history, banking invariant verification (I1–I12), fault injection panel, confirmed demo reset |

---

## Testing

```bash
# Run all unit tests (84 tests across 11 suites)
npm run test:unit

# Run all integration tests (Phase 0 to Phase 8)
npm run test:integration

# Run all 30 automated end-to-end acceptance tests (T01 to T30)
npm run test:acceptance
```

---

## Financial Precision & Invariants

- Monetary amounts are strictly formatted as decimal strings (e.g. `"1000.00"`).
- All balance arithmetic executes directly within PostgreSQL queries (`balance = balance + $amount`).
- Zero usage of JavaScript `Number` or floating point for money arithmetic.
- Verified Invariants (I1–I12):
  - **I1:** Non-negative account balances (`CHECK (balance >= 0)`).
  - **I8:** Strict double-entry ledger and balance agreement.
  - **I9:** Mathematical conservation of total money.
  - **I10:** Gap-free, monotonically increasing LSNs and deterministic SHA-256 hash chains.
  - **I11:** Leadership epoch fencing at the PostgreSQL transaction level.
  - **I12:** Cross-node state checksum agreement.

---

## Documentation

- [Viva & Demo Scenarios Guide](docs/demo-scenarios.md): Step-by-step reproduction scripts for examinations.
- [Known Limitations & Non-Guarantees](docs/limitations.md): Architectural trade-offs and boundaries (Section 31).
- [Protocol Specifications](docs/protocol-notes.md): Formal specifications of replication, election, and promotion protocols.
- [Specification Source of Truth](PROJECT.md): The full project specification.
