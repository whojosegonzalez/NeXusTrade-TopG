# NeXusTrade — Phase 12.94-D Milestone D.2.1 Evidence Report

## Offline Research Foundations: Legacy Inventory, Shadow Sidecar Contracts, Clock Monotonicity (D2-PREREQ-01), Statistical Oracles & Fedora Parser

**Milestone Status:** IMPLEMENTED & VERIFIED (OFFLINE SCOPE ONLY)  
**Operational Scope:** STRICTLY OFFLINE — Zero live network data collection, zero shadow harvester execution, zero connections to remote Fedora laptop, zero PAPER trading daemon restarts, zero wallet balance mutations, and zero Generation 2 activation.  
**Review Reference:** Addressing all mandatory Milestone D.2.1 requirements from Independent Architecture Approval of commit `9a707bf`.  
**Prerequisites Closed & Accepted:**

- Phase 12.93D (CLOSED)
- Phase 12.94-A (CLOSED under `7e58ea5`)
- Phase 12.94-B (CLOSED under `c37f91e`)
- Phase 12.94-C (CLOSED under `2541d5b` / `c5931ca` / `7faf705`)
- Phase 12.94-D.1 (FORMALLY ACCEPTED under `86abf6f`)
- Phase 12.94-D.2 Architecture Addendum v1 (APPROVED under `9a707bf`)

---

## 1. Executive Summary & Verification Results

Milestone D.2.1 establishes the offline data-readiness, causal-clock validation, and statistical foundation required before any genuine empirical telemetry collection can be considered. All 5 authorized deliverables have been implemented, tested, and verified against deterministic regression fixtures:

- **Isolated Test Suite Result**: **995/995 passing tests** across 5 test suites:
  - Node.js isolated test runner: **27/27 passed**
  - Measurement-Analysis test suite: **658/658 passed** (including 55 research tests, +14 new D.2.1 regression fixtures)
  - H2 Database test suite: **194/194 passed**
  - H3 Provider test suite: **98/98 passed**
  - H4 Analytics test suite: **18/18 passed**
- **Static Verification**:
  - `check-isolation.mjs`: PASSED (877 dependency links verified; memory-only SQLite 3.53.2).
  - `architecture-check.mjs`: PASSED (77 protected module visits verified).
  - TypeScript compilation (`tsc`): PASSED across `backend`, `shared`, `frontend`, and all 4 vitest configs.
  - `eslint`: PASSED (0 errors, 0 warnings).
  - `prettier`: PASSED (0 formatting issues).
  - `check-secrets.mjs`: PASSED.
  - `git diff --check`: PASSED.
- **Permanent Raw Log**: Full console output preserved at [`audit/verify-isolated-all.log`](file:///u:/Projects/TopG/audit/verify-isolated-all.log) (36,400 bytes).

---

## 2. Deliverable Completion Matrix

| Deliverable ID   | Component Description                              | Source Modules & Artifacts                                                                                                                                                                                                                                    | Verification Status                                                                                                                                                                                                                                              |
| :--------------- | :------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D2.1-DELIV-1** | **Windows Legacy Inventory & Manifest**            | [`scripts/audit-windows-legacy-inventory.mjs`](file:///u:/Projects/TopG/scripts/audit-windows-legacy-inventory.mjs)<br/>[`audit/WINDOWS_LEGACY_DATA_INVENTORY.md`](file:///u:/Projects/TopG/audit/WINDOWS_LEGACY_DATA_INVENTORY.md)                           | **VERIFIED** — Audited 2 legacy sessions (7 trades, 7.9259 SOL, SHA-256 verified); 0 telemetry sessions on Windows confirmed (`INSUFFICIENT_EVIDENCE`).                                                                                                          |
| **D2.1-DELIV-2** | **Shadow Evaluation Sidecar Contract**             | [`backend/src/research/ShadowEvaluationTypes.ts`](file:///u:/Projects/TopG/backend/src/research/ShadowEvaluationTypes.ts)<br/>[`backend/src/research/ShadowEvaluationContract.ts`](file:///u:/Projects/TopG/backend/src/research/ShadowEvaluationContract.ts) | **VERIFIED** — Schema 1.0.0 sidecar stream (`shadow-evaluations.jsonl`) implemented without mutating 12.94-B `DecisionCohort` enums. Isolated monotonic latency from UTC epoch joining.                                                                          |
| **D2.1-DELIV-3** | **Clock Monotonicity & Quarantine (D2-PREREQ-01)** | [`backend/src/research/ClockMonotonicityValidator.ts`](file:///u:/Projects/TopG/backend/src/research/ClockMonotonicityValidator.ts)<br/>[`scripts/audit-research-readiness.mjs`](file:///u:/Projects/TopG/scripts/audit-research-readiness.mjs)               | **VERIFIED** — Enforces `responseReceivedMs >= sourceTimestampMs`, source <= ingestion <= recv <= decision, forward skew limit (5000ms), and header-only inference rejection.                                                                                    |
| **D2.1-DELIV-4** | **Statistical & Financial Reference Oracles**      | [`backend/src/research/StatisticalOracles.ts`](file:///u:/Projects/TopG/backend/src/research/StatisticalOracles.ts)                                                                                                                                           | **VERIFIED** — Hájek weighted mean and Kish ESS; Cameron-Gelbach-Miller two-way clustering ($V_{\text{session}} + V_{\text{mint}} - V_{\text{session} \cap \text{mint}}$); Phase 12.94-C stateful AMM execution waterfall with single internal LP fee deduction. |
| **D2.1-DELIV-5** | **Read-Only Fedora Archive Parser**                | [`backend/src/research/FedoraArchiveParser.ts`](file:///u:/Projects/TopG/backend/src/research/FedoraArchiveParser.ts)                                                                                                                                         | **VERIFIED** — Offline parser for staged Fedora files; reports `REPORTED_NOT_INSPECTED` when unstaged; extracts trades and classifies H1–H4 as `UNAVAILABLE` without remote connections.                                                                         |

---

## 3. Detailed Verification Breakdown

### 3.1 D2.1-DELIV-1: Windows Legacy-Data Inventory & Manifest

- Executed `scripts/audit-windows-legacy-inventory.mjs` against canonical filesystem paths.
- **Session 1**: `.tmp/sessions/session-paper-12.93-pc-afternoon.json`
  - SHA-256: `A9D3128DD18F652AA32ADA25030874691115E04574BA7DD16436C3BA6E2BB6FA`
  - 2 executed trades (NEIL, SEALCAT), net P&L: `-0.1556 SOL`.
- **Session 2**: `.tmp/sessions/session-paper-12.93-pc-day4.json`
  - SHA-256: `E87FD79D07DF5F28918FAFBF8F214281F7531131DB68612E7CA6CEFA32379EF0`
  - 5 executed trades (hellop, DOGCART, KACY, CATGPT, DOPEUS), net P&L: `-0.3732 SOL`.
- **Finding**: Pre-telemetry format lacks point-in-time AMM reserves, orderbook depth, 5m buys/sells, developer holdings, and rejected candidate streams. All legacy sessions are classified as **`INELIGIBLE`** for H1–H4 alpha evaluation.
- Canonical telemetry directory (`.tmp/telemetry/sessions/`) contains **0 sessions**, confirming honest `INSUFFICIENT_EVIDENCE` status.

### 3.2 D2.1-DELIV-2: Shadow Evaluation Research Sidecar Contract

- Implemented `ShadowEvaluationRecord` schema version `1.0.0`:
  - Contains distinct `evaluationId`, `decisionEventId`, `sessionId`, `generationId`, `mintAddress`, `poolId`.
  - Uses `evaluationTimestampMs` (UTC epoch milliseconds) for causal event joining.
  - Records `hostMonotonicElapsedMs` separately for local timing profiling; prevents cross-clock comparisons.
  - `qualificationResult` records `shadowTriggerQualified: boolean`, `qualificationReason: string`, `simulatedTargetSizeSol: number`, `executionFeasible: boolean`.
- **Closed Schema Preservation**: Candidate decisions retain their canonical 12.94-B cohorts (`WATCHLIST_RADAR` or `TRIGGER_REJECTED`). Shadow qualification is strictly a research signal and is **never** recorded as `EXECUTED_BUY`.

### 3.3 D2.1-DELIV-3: Clock Monotonicity & Quarantine Validator (D2-PREREQ-01)

- Implemented `validateClockMonotonicity` in `ClockMonotonicityValidator.ts`.
- Validated via deterministic unit tests:
  - Valid sequence (`source <= ingestion <= recv <= decision`): Accepted.
  - Adversarial inverted receipt (`recv < source`): Quarantined under `IMPOSSIBLE_TIMESTAMP_ORDERING`.
  - Inverted host receipt (`ingestion > recv`): Quarantined under `IMPOSSIBLE_TIMESTAMP_ORDERING`.
  - Forward clock skew (`source - ingestion > 5000ms`): Quarantined under `IMPOSSIBLE_TIMESTAMP_ORDERING`.
  - Future feature lookahead (`source > decision` or `recv > decision`): Quarantined under `LATE_RECEIPT_LOOKAHEAD_PREVENTION`.
  - HTTP `Date` header inference: Quarantined under `INVALID_OR_NONFINITE_MANDATORY_TIMESTAMPS`.
- **Readiness Scanner Integration**: Updated `scripts/audit-research-readiness.mjs` line 431 to enforce `recv >= obs.sourceTimestampMs`. Verified that the auditor's adversarial fixture (`source=990000`, `recv=980000`) fails closed with `h3Feasible: false` and `eligibleH3DecisionsCount: 0`.

### 3.4 D2.1-DELIV-4: Statistical & Financial Reference Oracles

- **Hájek & Horvitz-Thompson Estimators**:
  - Implemented `computeHajekMean` and `computeHorvitzThompsonTotal`.
  - Deterministic reference test case: Values `[10, 20, 30]`, inclusion probabilities `[0.5, 0.25, 0.1]` (weights `[2, 4, 10]`) -> Hájek mean `= 25.0`, Kish ESS `= 2.1333`, Horvitz-Thompson total `= 400.0`. Exactly matches hand calculations.
- **Cameron-Gelbach-Miller Two-Way Cluster Covariance**:
  - Implemented true inclusion-exclusion estimator: $\mathbb{V}_{\text{two-way}} = \mathbb{V}_{\text{session}} + \mathbb{V}_{\text{mint}} - \mathbb{V}_{\text{session} \cap \text{mint}}$.
  - Validated 2-parameter regression covariance on residuals.
  - Small-cluster safeguard: Emits `isSmallClusterWarning: true` and logs warning when unique session count $< 30$.
- **Authoritative Phase 12.94-C AMM Execution Waterfall**:
  - Implemented `computeAmmRoundTripWaterfall` using exact constant-product swap equations ($(x_0 + \Delta x_{\text{net}})(y_0 - \Delta y) \ge x_0 y_0$).
  - LP fee (25 bps) deducted inside swap pricing exactly once; zero duplicate fee debits from cash.
  - Deterministic test case on flat zero-alpha market (`priceMultiplier = 1.0`): Yields strictly negative net return ($\approx -0.52\%$) due to 2x 25 bps LP fee + network fees. ATA rent deposit and refund cancel out cleanly ($0.00$ net rent).

### 3.5 D2.1-DELIV-5: Read-Only Fedora Archive Parser

- Implemented `parseFedoraArchiveDirectory` in `FedoraArchiveParser.ts`.
- When target staging directory does not exist: Returns status `REPORTED_NOT_INSPECTED`, zero parsed files, and operational notice confirming zero remote connections.
- In isolated test sandbox with mock legacy session JSON: Extracts trade timestamps, realized P&L, SHA-256 checksums, and explicitly tags AMM reserves, 5m flow, and dev holdings as `UNAVAILABLE` (`FIELD_NOT_COLLECTED_IN_GENERATION`).

---

## 4. Operational Invariant Verification

| Invariant Dimension             | Verified State            | Cryptographic & System Evidence                                                                                          |
| :------------------------------ | :------------------------ | :----------------------------------------------------------------------------------------------------------------------- |
| **Generation 1 Virtual Wallet** | **UNTOUCHED & IMMUTABLE** | `.tmp/virtual-wallet.json`: `7.9259 SOL`<br/>SHA-256: `7F2C2353AC2F62CAC1BB98703742AB19C74AC5521635AF6F49BBE777AD020ED9` |
| **Active Daemons**              | **0 RUNNING**             | Exactly 0 paper trading or telemetry daemons running on Windows host                                                     |
| **Closed Subsystems**           | **CLOSED & FROZEN**       | 12.93D, 12.94-A, 12.94-B, 12.94-C, and D.1 remain intact with 0 uncommitted diffs                                        |
| **Fedora Host**                 | **UNVERIFIED & ISOLATED** | Classified as `REPORTED_NOT_INSPECTED`; 0 network calls, 0 SSH commands, 0 process signals                               |
| **Generation 2**                | **UNACTIVATED**           | Uncreated and disabled; Tier 3 polling and real-SOL trading disabled                                                     |
| **Scope Boundary**              | **OFFLINE ONLY**          | Zero live data collection; zero background harvesters deployed                                                           |

---

## 5. Next Steps & Explicit Authorization Gates

Milestone D.2.1 is complete and ready for independent source review. In accordance with the governance charter:

- **Milestone D.2.2** (Harvester Interface Design & Mock Harness) remains **UNAUTHORIZED** until Milestone D.2.1 receives formal independent acceptance.
- **Live Shadow Collection** remains strictly blocked pending a separate operational decision defining rate budgets, duration, and safety kill switches.
