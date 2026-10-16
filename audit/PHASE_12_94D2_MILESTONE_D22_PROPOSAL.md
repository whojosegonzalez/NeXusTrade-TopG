# NeXusTrade — Phase 12.94-D Milestone D.2.2 Architecture Proposal

## Passive Shadow Collector Interface & Offline Mock Harness

**Document Version:** 1.0.0  
**Status:** PROPOSED FOR INDEPENDENT ARCHITECTURE REVIEW (PLANNING ONLY)  
**Implementation Status:** NOT AUTHORIZED — Strictly Design & Specification Scope  
**Author:** Antigravity  
**Date:** October 15, 2026  
**Prerequisites Closed & Accepted:**

- Phase 12.93D (CLOSED)
- Phase 12.94-A (CLOSED under `7e58ea5`)
- Phase 12.94-B (CLOSED under `c37f91e`)
- Phase 12.94-C (CLOSED under `2541d5b` / `c5931ca` / `7faf705`)
- Phase 12.94-D.1 (FORMALLY ACCEPTED under `86abf6f`)
- Phase 12.94-D.2 Architecture Addendum v1 (APPROVED under `9a707bf`)
- Phase 12.94-D.2.1 (FORMALLY ACCEPTED under commit `da9436c`, review `NeXusTrade_Phase_12_94D21_Commit_da9436c_Final_Independent_Acceptance.md`)

---

## 1. Executive Summary & Architecture Boundary

Following the formal independent acceptance and closure of Milestone D.2.1, this proposal specifies the architecture, interfaces, contracts, and deterministic offline mock harness for **Milestone D.2.2: Passive Shadow Collector Interface & Offline Mock Harness**.

### 1.1 Scope Boundaries & Non-Negotiable Operational Constraints

1. **Strictly Planning & Specification:** This document establishes the research and software design baseline. **No source code implementation is authorized or performed in this milestone.**
2. **Zero Live Data Collection:** No background harvesters, network polling loops, or live socket connections will be deployed or activated.
3. **Complete Process & Memory Isolation:** The shadow collector architecture is designed as a standalone, read-only consumer completely separated from the existing PAPER trading daemons, execution state machine, and Generation 1 virtual wallet.
4. **Generation 1 Wallet Invariant:** The virtual wallet remains immutable at **`7.9259 SOL`** with canonical SHA-256 **`7F2C2353AC2F62CAC1BB98703742AB19C74AC5521635AF6F49BBE777AD020ED9`**. The shadow collector has zero wallet access, zero keypair access, and zero transaction signing capabilities.
5. **Remote Fedora Host Isolation:** The remote Fedora host remains uncontacted and isolated (**0** SSH connections, **0** network packets). Its status remains `REPORTED_NOT_INSPECTED`.
6. **Tier 3 Live Polling & Real-SOL Execution Disabled:** No live executable quote polling (Jupiter/DEX aggregators) or mainnet transaction submission will occur.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              SYSTEM PROCESS BOUNDARY                                   │
├─────────────────────────────────────────────────┬──────────────────────────────────────┤
│           TRADING SUBSYSTEM (PAUSED)            │      RESEARCH HARVESTER (D.2.2)      │
│                                                 │                                      │
│  ┌───────────────────────────────────────────┐  │  ┌────────────────────────────────┐  │
│  │ Generation 1 Virtual Wallet               │  │  │ Read-Only Mock / Provider      │  │
│  │ Balance: 7.9259 SOL (FROZEN)              │  │  │ Interface (IMarketDataProvider)│  │
│  └───────────────────────────────────────────┘  │  └───────────────┬────────────────┘  │
│                       ▲                         │                  │                   │
│                       │ (NO ACCESS)             │                  ▼                   │
│  ┌────────────────────┴──────────────────────┐  │  ┌────────────────────────────────┐  │
│  │ Paper Trading Engine & State Machine      │  │  │ Shadow Collector Service       │  │
│  │ (PAUSED - ZERO RUNNING DAEMONS)           │  │  │ (Isolated Event Loop / Worker) │  │
│  └───────────────────────────────────────────┘  │  └───────────────┬────────────────┘  │
│                                                 │                  │                   │
│                                                 │                  ▼                   │
│                                                 │  ┌────────────────────────────────┐  │
│                                                 │  │ Research Telemetry Filesystem  │  │
│                                                 │  │ (.tmp/telemetry/sessions/)     │  │
│                                                 │  │ - market-observations.jsonl    │  │
│                                                 │  │ - candidate-decisions.jsonl    │  │
│                                                 │  │ - shadow-evaluations.jsonl     │  │
│                                                 │  └────────────────────────────────┘  │
└─────────────────────────────────────────────────┴──────────────────────────────────────┘
```

---

## 2. Read-Only Collector Architecture & Separation

The shadow collector is designed as a standalone subsystem governed by explicit interfaces that prevent any crosstalk with the live or paper trading infrastructure.

### 2.1 Process Separation & Lifecycle States

The collector operates as an independent state machine with five deterministic lifecycle states:

```
┌─────────┐       start()       ┌────────────┐     drain() / timeout     ┌──────────┐
│  IDLE   ├────────────────────►│ COLLECTING ├──────────────────────────►│ DRAINING │
└─────────┘                     └─────┬──────┘                           └────┬─────┘
                                      │                                       │
                         abort() /    │                          flush done   │
                         kill-switch  │                                       ▼
                                      ▼                                  ┌─────────┐
                                ┌───────────┐                            │ STOPPED │
                                │ TERMINATED│                            └─────────┘
                                └───────────┘
```

1. **`IDLE`**: Initialized with configuration, rate limits, and output staging directory. No resources allocated.
2. **`COLLECTING`**: Actively polling or receiving market data from the registered `IMarketDataProvider`. Ingests into an in-memory ring buffer.
3. **`DRAINING`**: Ingestion stopped. In-flight records flushed to disk. Dual-file session consensus updated.
4. **`STOPPED`**: All streams closed and synchronized. Final session status written (`COMPLETED` or `INTERRUPTED`).
5. **`TERMINATED`**: Abrupt termination triggered by emergency kill switch, storage quota breach, or unhandled rejection. Filesystem buffers synced; session finalized as `INTERRUPTED`.

### 2.2 Core Interfaces

```typescript
export interface IMarketDataProvider {
  readonly providerId: string;
  readonly capabilities: ProviderCapabilities;
  getPoolReserves(poolId: string): Promise<PointInTimeReserves>;
  getTokenMetrics(mintAddress: string): Promise<PointInTimeMetrics>;
  getDeveloperHoldings(mintAddress: string): Promise<PointInTimeHoldings>;
}

export interface IShadowCollectorEngine {
  readonly state: CollectorLifecycleState;
  readonly sessionContext: ShadowSessionContext;
  start(): Promise<void>;
  drain(timeoutMs: number): Promise<SessionDrainSummary>;
  abort(reason: string): Promise<void>;
  getTelemetryMetrics(): CollectorTelemetrySnapshot;
}
```

---

## 3. Provider Capability Verification & Field Provenance

Market data providers differ significantly in their available payloads, update frequencies, and timestamp precision. Milestone D.2.2 establishes an explicit, field-by-field verification schema.

### 3.1 Field-by-Field Capability Matrix

| Feature Dimension           | Required Fields                               | Primary Provider Source                | Expected Frequency                         | Provenance Classification                                                | Unavailability Handling                                                                                         |
| :-------------------------- | :-------------------------------------------- | :------------------------------------- | :----------------------------------------- | :----------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- |
| **H1: Momentum & Inflow**   | `volume5mUsd`<br/>`buys5m`<br/>`sells5m`      | Birdeye / DEX Screener REST API        | 10s – 30s polling                          | `OBSERVED` if received $\le 120\text{s}$; `UNAVAILABLE` otherwise        | Recorded with `PROVIDER_RESPONSE_OMITTED_FIELD` or `STALE_SAMPLE_DISCARDED`. Never defaulted to zero.           |
| **H2: Liquidity & AMM**     | `baseReserve`<br/>`quoteReserve`<br/>`poolId` | Raydium AMM / Solana RPC               | Contemporaneous with poll                  | `OBSERVED` if finite and $> 0$; `UNAVAILABLE` otherwise                  | Recorded with `RESERVE_QUANTITY_ZERO_OR_NONFINITE`. Disallows simulated swap execution.                         |
| **H3: Developer Safety**    | `devHoldingPct`<br/>`lpBurnPct`               | Helius DAS / Solana RPC Token Accounts | Pre-decision or cached ($\le 300\text{s}$) | `OBSERVED` if observed pre-decision; `UNAVAILABLE` otherwise             | Pre-decision observations qualify; future observations trigger fail-closed `LATE_RECEIPT_LOOKAHEAD_PREVENTION`. |
| **H4: Multi-Token Context** | `solSize`<br/>`tradeTimestamps`               | Internal Telemetry / Fedora Parser     | Session-dependent                          | `OBSERVED` on sessions with trades; `UNAVAILABLE` on zero-trade sessions | Zero-trade sessions marked `FIELD_NOT_COLLECTED_IN_GENERATION`.                                                 |

### 3.2 Schema Validation Invariant

All raw provider payloads pass through deterministic runtime validators before ingestion:

- Finiteness checks: All numbers must satisfy `Number.isFinite(val)`. `NaN`, `Infinity`, and `-Infinity` are rejected fail-closed.
- Non-negativity checks: Financial reserves, trade sizes, and prices must satisfy `val >= 0` (or `val > 0` for reserves).
- Timestamp checks: Epoch timestamps must be strictly positive integers $\le \text{current UTC time} + 5000\text{ms}$ (tolerated skew).

---

## 4. Point-in-Time Observation & Shadow Sidecar Contracts

The collector writes strictly compatible files conforming to accepted Phase 12.94-D.1 and D.2.1 storage contracts.

### 4.1 Storage Layout

All session data is persisted under `.tmp/telemetry/sessions/<sessionId>/`:

```
.tmp/telemetry/sessions/<sessionId>/
├── meta.json                     # Canonical SessionMeta (session status, timestamps)
├── summary.json                  # Canonical SessionSummary (drain completeness, record counts)
├── market-observations.jsonl     # Canonical MarketObservationRecord (schema 1.0.0)
├── candidate-decisions.jsonl     # Canonical CandidateDecisionRecord (schema 1.0.0)
├── shadow-evaluations.jsonl      # Sidecar ShadowEvaluationRecord (schema 1.0.0)
└── stratified-samples.jsonl      # Canonical StratifiedSamplingRecord (sampling inclusion weights)
```

### 4.2 Composite Foreign-Key Joining

Each `ShadowEvaluationRecord` written to `shadow-evaluations.jsonl` is linked to its corresponding `CandidateDecisionRecord` via a strict 5-tuple composite key:

1. `decisionEventId`: Must match `decision.eventId`.
2. `sessionId`: Must match `decision.sessionId`.
3. `generationId`: Must match `decision.generationId`.
4. `mintAddress`: Must match `decision.mintAddress`.
5. `poolId`: Must match `decision.poolId`.

### 4.3 Timestamp & Monotonicity Invariants (D2-PREREQ-01)

1. **Causal Monotonicity:**
   $$\text{sourceTimestampMs} \le \text{ingestionTimestampMs} \le \text{responseReceivedMs} \le \text{decisionTimestampMs}$$
   Any event violating this causal ordering is flagged `isCausallyMonotonic: false` and quarantined under `ClockCausalAttestation`.
2. **Clock Skew Bounds:** Provider timestamp forward skew $\le 5000\text{ms}$ is quarantined under `TOLERATED_CLOCK_SKEW_QUARANTINE`; skew $> 5000\text{ms}$ is rejected under `EXCESSIVE_CLOCK_SKEW_REJECTED`.
3. **Receipt Evidence Requirement:** `responseReceivedMs` is mandatory. Omitting receipt evidence triggers `MISSING_RECEIPT_EVIDENCE`.
4. **Host Monotonic Isolation:** Host monotonic elapsed time is recorded exclusively in `hostMonotonicElapsedMs` (non-negative number), and is **never** compared against or used as UTC epoch timestamps.

---

## 5. Deterministic Offline Mock Harness

To guarantee 100% offline reproducibility and test coverage without network dependencies, Milestone D.2.2 specifies a comprehensive mock harness: `MockMarketDataProvider`.

### 5.1 Adversarial Simulation Scenarios

The mock harness implements programmable failure modes to test all edge cases:

1. **Missing Field Injection:** Selectively omits fields (e.g. `devHoldingPct`, `volume5mUsd`) to verify that the collector marks them `UNAVAILABLE` with exact reason codes rather than defaulting to zero.
2. **Network Latency & Timeout Injection:** Simulates variable RPC response latencies ($0\text{ms}$ to $15,000\text{ms}$) and timeout aborts, verifying that the collector executes rate-limiter backoff and graceful fail-closed handling.
3. **Clock Skew & Inversion Injection:** Emits payloads with inverted timestamps (`source > ingestion` or `receipt > decision`) to verify deterministic quarantine by `ClockMonotonicityValidator`.
4. **Duplicate Payload Injection:** Emits duplicate events with identical composite keys to verify idempotency, deduplication logging, and stream quarantine.
5. **Pool Mismatch Injection:** Emits reserve snapshots with mismatched `poolId` to verify `POOL_IDENTITY_MISMATCH_DISCARDED`.
6. **Abrupt Process Interruption Simulation:** Simulates SIGINT/SIGTERM or unhandled rejection mid-collection, verifying that unfinalized sessions are cleanly recorded as `INTERRUPTED` without corrupting flushed JSONL lines.

---

## 6. Rate-Limit Budgets, Resource Limits & Emergency Shutdown

### 6.1 Rate-Limit Budgets

The collector enforces strict token-bucket rate limiting per provider:

| Provider         | Maximum Rate | Burst Capacity | Session Ceiling    | Backoff Policy                                  |
| :--------------- | :----------- | :------------- | :----------------- | :---------------------------------------------- |
| **Raydium RPC**  | 5 req/sec    | 10 req         | 10,000 req/session | Exponential with jitter (500ms, 1s, 2s, 5s max) |
| **Birdeye REST** | 2 req/sec    | 5 req          | 2,500 req/session  | Exponential with jitter (1s, 2s, 5s, 10s max)   |
| **Helius DAS**   | 5 req/sec    | 10 req         | 5,000 req/session  | Exponential with jitter (500ms, 1s, 2s, 5s max) |

### 6.2 Resource Ceilings & Storage Quotas

- **Memory Ceiling:** Node.js RSS heap cap of **256 MB**. Exceeding 256 MB triggers immediate orderly drain and clean shutdown.
- **Ring Buffer Cap:** Maximum **1,000 in-memory records**. Backpressure pauses provider polling when the buffer reaches 80% capacity.
- **Session Disk Quota:** Maximum **50 MB** per session directory across all `.jsonl` files. If the quota is reached, collection halts immediately with `interruptionReason: "STORAGE_QUOTA_EXCEEDED"`.
- **Global Staging Quota:** Maximum **1 GB** total staging directory size. Collection will not start if host disk space is below **5 GB**.

### 6.3 Emergency Shutdown Controls

1. **Filesystem Kill Switch:** The collector monitors for the existence of `.tmp/SHADOW_KILL_SWITCH`. When detected, it transitions to `TERMINATED` within $\le 500\text{ms}$.
2. **Signal Handlers:** `SIGINT` and `SIGTERM` trigger the asynchronous drain sequence, flushing pending buffers and writing final status within a **3,000ms timeout window**.
3. **Unhandled Exception Trap:** `uncaughtException` and `unhandledRejection` handlers synchronously flush in-memory buffers to disk and finalize the session as `INTERRUPTED` before process termination.

---

## 7. Session Finalization & Dual-File Consensus Rules

### 7.1 Consensus Mechanism

Finality requires affirmative agreement between `meta.json` and `summary.json`:

- **`FINALIZED`**: Emitted ONLY when `meta.sessionStatus === "FINALIZED"` AND `summary.isCompleteSession === true` AND all records have been completely flushed and verified.
- **`INTERRUPTED`**: Emitted when collection was stopped prematurely, killed, timed out, or interrupted by a resource breach.

### 7.2 Incomplete & Interrupted Invariants

If a session is interrupted:

- `meta.json`:
  ```json
  {
    "sessionStatus": "INTERRUPTED",
    "interruptionReason": "KILL_SWITCH_TRIGGERED",
    "interruptedAtIso": "2026-10-15T18:00:00.000Z"
  }
  ```
- `summary.json`:
  ```json
  {
    "isCompleteSession": false,
    "incompleteDrainReason": "INTERRUPTED_DRAIN_INCOMPLETE",
    "flushedRecordsCount": 142
  }
  ```
- **Guaranteed Invariant:** An interrupted session is **NEVER** marked `FINALIZED` or `isCompleteSession: true`. Flushed records remain readable for diagnostic and recovery purposes, but research eligibility scanners will exclude the session from hypothesis testing.

---

## 8. Multi-Tier Price & Execution Disambiguation

To eliminate any ambiguity between observed market data, counterfactual models, and live execution, Milestone D.2.2 formally enforces the following classification:

| Tier Level                      | Designation                      | Provider Identity                                   | Execution Feasibility                                                | Economic Reality                                                                  |
| :------------------------------ | :------------------------------- | :-------------------------------------------------- | :------------------------------------------------------------------- | :-------------------------------------------------------------------------------- |
| **Tier 1 (Observed)**           | Point-in-Time Market Observation | DEX / AMM Pool (`raydium`, `birdeye`)               | Non-executable (Pure observation)                                    | Real-world observed market state; zero cash flow.                                 |
| **Tier 2 (Synthetic Quote)**    | Synthetic AMM Quote              | `"synthetic_amm_reserve"`                           | Modeled via Constant-Product AMM formula ($x \cdot y = k$)           | Counterfactual reference quote; no execution commitment.                          |
| **Tier 3 (Executable Quote)**   | Live Aggregator Executable Quote | DEX Aggregator (`jupiter`, `raydium_clmm`)          | Time-bounded executable swap quote with route and context slot       | Executable commitment during `validUntilMs` window. (**UNAUTHORIZED & DISABLED**) |
| **Tier 4 (Simulated Fill)**     | Counterfactual Simulated Fill    | `"synthetic_amm_reserve"` (`TIER_4_SIMULATED_FILL`) | Simulated execution with modeled delay, slippage, and fee deductions | Counterfactual cash-flow accounting (lamport-exact delta). Not executable trades. |
| **Tier 5 (Live On-Chain Fill)** | Real On-Chain Swap               | Solana Mainnet Transaction                          | Live SOL debit/credit                                                | Real capital mutation. (**STRICTLY PROHIBITED**)                                  |

---

## 9. Proposed Acceptance Tests & Implementation Roadmap

### 9.1 Acceptance Tests Matrix (D22-ACC-01 – D22-ACC-08)

| Test ID        | Category                             | Verification Criteria                                                                                                          |
| :------------- | :----------------------------------- | :----------------------------------------------------------------------------------------------------------------------------- |
| **D22-ACC-01** | Process & Architecture Isolation     | Verifies zero references or bindings to wallet keypairs, transaction signers, or trading execution modules.                    |
| **D22-ACC-02** | Provider Capability & Validation     | Verifies strict runtime schema validation; rejects `NaN`, `Infinity`, negative reserves, and malformed types fail-closed.      |
| **D22-ACC-03** | Field Provenance Tagging             | Verifies uncollected or omitted provider fields are marked `UNAVAILABLE` with correct `UnavailabilityReason` codes.            |
| **D22-ACC-04** | Composite Key & Chronology Binding   | Verifies 1:1 foreign-key joining between candidate decisions and shadow evaluations; enforces causal timestamp monotonicity.   |
| **D22-ACC-05** | Offline Mock Provider Harness        | Deterministically simulates missing fields, latency timeouts, duplicate payloads, and clock inversions without network access. |
| **D22-ACC-06** | Resource & Rate Budget Enforcement   | Verifies request rate limits, backoff on simulated 429 errors, memory cap enforcement, and storage quota tripwires.            |
| **D22-ACC-07** | Emergency Kill Switch Responsiveness | Verifies detection of `.tmp/SHADOW_KILL_SWITCH` triggers immediate transition to `TERMINATED` within $\le 500\text{ms}$.       |
| **D22-ACC-08** | Session Finality & Consensus         | Verifies dual-file consensus; confirms interrupted sessions are persisted as `INTERRUPTED` and never labeled `FINALIZED`.      |

### 9.2 Step-by-Step Implementation Roadmap (Pending Authorization)

Upon independent architecture approval, implementation will proceed through bounded, offline modules:

1. **Step 1: Interface & Contract Definitions:**
   - Define `backend/src/research/shadow/ShadowCollectorTypes.ts` (interfaces, state enums, capability matrices).
2. **Step 2: Deterministic Mock Harness:**
   - Implement `backend/src/research/shadow/MockMarketDataProvider.ts` with programmable failure scenarios.
3. **Step 3: Rate Limiter & Resource Controller:**
   - Implement `backend/src/research/shadow/ShadowResourceController.ts` (token bucket, memory watcher, disk quota).
4. **Step 4: Collector Engine & Session Finalizer:**
   - Implement `backend/src/research/shadow/ShadowCollectorEngine.ts` (state machine, ring buffer, dual-file consensus).
5. **Step 5: Adversarial Unit Test Suite:**
   - Implement `backend/src/research/shadow/ShadowCollector.test.ts` covering all D22-ACC acceptance tests.

---

## 10. Operational Invariant Confirmation

Antigravity attests to the following operational invariants:

- **Generation 1 Virtual Wallet:** Frozen at **`7.9259 SOL`** with canonical SHA-256 **`7F2C2353AC2F62CAC1BB98703742AB19C74AC5521635AF6F49BBE777AD020ED9`**.
- **Windows Paper Trading Daemons:** Exactly **0** running trading or telemetry processes.
- **Remote Fedora Host:** Completely uncontacted and isolated (**0** SSH connections, **0** network packets). Classified `REPORTED_NOT_INSPECTED`.
- **Closed Subsystems:** Phases 12.93D, 12.94-A, 12.94-B, 12.94-C, D.1, and D.2.1 remain closed and immutable.
- **Generation 2:** Uncreated, unactivated, and unauthorized.
- **No Source Code Implementation:** This submission contains **strictly planning documentation**. Zero D.2.2 production code has been implemented.
