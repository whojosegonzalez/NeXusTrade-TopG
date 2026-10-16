# NeXusTrade — Phase 12.94-D.2.3 Implementation Evidence Report

**Document ID:** `NT-D23-EVIDENCE-v2`  
**Milestone:** Phase 12.94-D.2.3 (Solana Empirical Research Pilot Foundation)  
**Parent Audit Review:** `c:\Users\whojo\Downloads\NeXusTrade_D23_Commit_57db13d_Independent_Offline_Source_Audit_v1.md`  
**Execution Environment:** Windows Offline Research Environment  
**Status:** SOURCE AUDIT CORRECTIONS COMPLETE — READY FOR FINAL RE-AUDIT

---

## 1. Executive Summary & Authorizations

Milestone **Phase 12.94-D.2.3** implements the strictly offline, read-only Solana empirical research pilot components in `backend/src/research/pilot/`. This revision addresses all four technical findings (**D23F-01 through D23F-04**) identified in the Independent Source Audit v1 of commit `57db13d`.

### Operational Boundaries & Safety Guarantees

1. **Zero Real Network Execution:** No outbound network connections, real RPC endpoints, or DexScreener HTTP calls are enabled. All adapters operate against synthetic, deterministic fixtures.
2. **Zero Live Deployment:** Remote Fedora deployment, 2-hour live collection runs, and background daemon polling remain strictly unauthorized and deferred.
3. **Generation 1 Virtual Wallet Immutable:** The continuous virtual wallet balance remains untouched at **`7.9259 SOL`** with canonical SHA-256 hash **`7F2C2353AC2F62CAC1BB98703742AB19C74AC5521635AF6F49BBE777AD020ED9`**.
4. **Historical Subsystems Intact:** Legacy `backend/src/shadow/` and closed milestones `backend/src/research/shadow/` (D.2.2) and D.2.1 remain strictly untouched and immutable.
5. **Windows Engine Paused:** Zero background trading or paper engine daemons are active.

---

## 2. Source Audit Findings Resolution Matrix (D23F-01 – D23F-04)

| Finding ID  | Title                                                      | Summary of Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Authoritative Module                                                                          | Status       |
| :---------- | :--------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------- | :----------- |
| **D23F-01** | Correct Raydium Secondary Layout & Strict Owner Checks     | Corrected Raydium SDK v2 secondary layout offsets: `baseNeedTakePnl`: 192, `quoteNeedTakePnl`: 200, `quoteTotalPnl`: 208, `baseTotalPnl`: 216, `lpMint`: 464, `openOrders`: 496, `marketId`: 528, `marketProgramId`: 560, `targetOrders`: 592. Enforced strict owner checks in `RaydiumAmmParser` and `SolanaRpcResponseAdapter` for `RAYDIUM_AMM_V4_PROGRAM_ID` and `SPL_TOKEN_PROGRAM_ID`. Added independent literal-offset binary test verifying byte indices without sharing code constants. | `RaydiumAmmParser.ts`<br/>`SolanaRpcResponseAdapter.ts`<br/>`AuthoritativeRaydiumFixtures.ts` | **RESOLVED** |
| **D23F-02** | Strict Session ID Validation & Dual-Budget File Admission  | Implemented regex validation (`/^[a-zA-Z0-9_\-.]+$/`) forbidding path separators (`/`, `\`), traversal (`..`), and special characters. Enforced root path confinement via `validatePathConfinement` supporting `allowedRootDir`. Implemented prospective file admission before any disk write with a dual-budget model: operational quota (`maxDiskBytes`) vs emergency metadata allowance (`maxEmergencyDiskBytes` = 4096 bytes). Quota breaches fail closed to `INTERRUPTED`.                  | `PilotCollectorRunner.ts`<br/>`PilotTypes.ts`                                                 | **RESOLVED** |
| **D23F-03** | Attribution, Duplicate Rejection & Baseline Reconciliation | Enforced foreign session (`FOREIGN_SESSION_ATTRIBUTION`) and generation (`FOREIGN_GENERATION_ATTRIBUTION`) attribution checks. Rejected duplicate `decisionEventId` before write (`DUPLICATE_DECISION_ID`). Recorded append-time baseline snapshots and reconciled deep equality against on-disk records before issuing `FINALIZED`. Automated recovery repairs torn lines into `.corrupt-<timestamp>` sidecars and downgrades damaged `FINALIZED` archives to `INTERRUPTED`.                    | `PilotCollectorRunner.ts`                                                                     | **RESOLVED** |
| **D23F-04** | Truthful Provenance & Unavailable Metric Handling          | Never substitutes `decisionEpochMs` or receipt time for unknown source timestamps. Implemented documented sentinel `SYNTHETIC_UNAVAILABLE_SOURCE_TIMESTAMP_MS = 0`, flagged `"sourceTimestampMs"` in `missingFields`, and set `dataFreshnessMs: Number.MAX_SAFE_INTEGER`. Normalized non-finite numbers (`NaN`, `Infinity`, `undefined`) to `null` and set `metricProvenance` to `"UNAVAILABLE"` across candidate decisions and market observations.                                             | `PilotSchemaBridge.ts`<br/>`PilotTypes.ts`<br/>`DexScreenerResponseAdapter.ts`                | **RESOLVED** |

---

## 3. Detailed Component Architecture & Safeguards

### 3.1 Raydium AMM v4 Layout & Owner Attestation (`RaydiumAmmParser.ts`, `SolanaRpcResponseAdapter.ts`)

- **Authoritative Offsets (Raydium SDK v2):**
  - Primary Decimals: `baseDecimal`: 32, `quoteDecimal`: 40 (`u64` little-endian)
  - Secondary PnL: `baseNeedTakePnl`: 192, `quoteNeedTakePnl`: 200, `quoteTotalPnl`: 208, `baseTotalPnl`: 216 (`u64` little-endian)
  - Vault Accounts: `baseVault`: 336, `quoteVault`: 368 (32-byte public keys)
  - Mint Accounts: `baseMint`: 400, `quoteMint`: 432, `lpMint`: 464 (32-byte public keys)
  - Market State Accounts: `openOrders`: 496, `marketId`: 528, `marketProgramId`: 560, `targetOrders`: 592 (32-byte public keys)
- **Strict Program Owner Attestation:**
  - `parseRaydiumAmmV4Account`: Fails closed with `UNAUTHORIZED_OWNER_PROGRAM` if `ownerProgramId !== RAYDIUM_AMM_V4_PROGRAM_ID` (`675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`).
  - `parseSolanaRpcPoolAccountResponse`: Fails closed with `[UNAUTHORIZED_POOL_OWNER]` if `value.owner` is missing or does not match `RAYDIUM_AMM_V4_PROGRAM_ID`.
  - `parseSolanaRpcMultipleVaultsResponse`: Fails closed with `[UNAUTHORIZED_VAULT_OWNER]` if either vault account owner does not match `SPL_TOKEN_PROGRAM_ID` (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`).
- **Independent Binary Decoding Unit Tests:**
  - An independent test in `RaydiumAmmParser.test.ts` manually populates literal byte indices 192, 200, 208, 216, 464, 496, 528 without importing layout constants, proving binary compliance.

### 3.2 Confinement & Prospective File Admission (`PilotCollectorRunner.ts`)

- **Session ID Sanitization:** `validateSessionId` strictly enforces length $\le 100$, regex `/^[a-zA-Z0-9_\-.]+$/`, and rejects any path traversal sequence (`..`), separators (`/`, `\`), drive indicators (`:`), or null bytes.
- **Path Confinement:** `validatePathConfinement` resolves the session directory, verifies it does not escape `allowedRootDir` (defaulting to `outputRootDir`), and guards against symlink escapes.
- **Prospective Admission & Dual Budgeting:**
  - `checkWriteAdmission(projectedBytes, isEmergency)` calculates prospective byte size before opening or writing to any file.
  - Operational quota (`maxDiskBytes`, default 20 MB) limits observation and decision streams.
  - Emergency metadata allowance (`maxEmergencyDiskBytes`, default 4096 bytes) is reserved exclusively for ungraceful crash or interruption metadata.
  - Quota breaches immediately halt operations, set status to `INTERRUPTED`, record the emergency metadata, and fail closed.

### 3.3 Foreign Attribution & Baseline Snapshot Reconciliation (`PilotCollectorRunner.ts`)

- **Attribution Verification:**
  - `candidate.compositeId.sessionId === this.config.sessionId`
  - `candidate.compositeId.generationId === this.config.generationId`
  - `observation.compositeId.sessionId === this.config.sessionId`
  - `observation.compositeId.generationId === this.config.generationId`
  - Any foreign record is rejected prior to write (`FOREIGN_SESSION_ATTRIBUTION` or `FOREIGN_GENERATION_ATTRIBUTION`).
- **Duplicate Event ID Prevention:** Candidate `decisionEventId`s are checked against an in-memory `seenDecisionEventIds` set. Re-entrant or duplicate event IDs throw `DUPLICATE_DECISION_ID` before any write occurs.
- **Append-Time Baseline Snapshots:** Every record appended to `candidate-decisions.jsonl`, `shadow-evaluations.jsonl`, and `market-observations.jsonl` is snapshotted in memory (`decisionsBaseline`, `evaluationsBaseline`, `observationsBaseline`).
- **Finalization Reconciliation:** Prior to issuing `FINALIZED`, `reconcilePersistedEvidence` reads back all on-disk JSONL lines, validates record count, parses JSON, and performs deep equality checks against append snapshots. If any field or metric was tampered on disk, the session fails closed to `INTERRUPTED`.
- **Corrupted Archive Downgrade:** `recoverSession` scans JSONL streams. If torn lines are quarantined into `.corrupt-<timestamp>` sidecars, any archive that previously reported `FINALIZED` is downgraded and repaired to `INTERRUPTED` with `interruptionReason: "CORRUPTED_FINALIZED_ARCHIVE_QUARANTINED"`.

### 3.4 Truthful Provenance & Missing Fields (`PilotSchemaBridge.ts`)

- **Documented Unavailable Sentinel:**
  `export const SYNTHETIC_UNAVAILABLE_SOURCE_TIMESTAMP_MS = 0;`
- **Candidate Decisions:** When upstream candidate source timestamp is null, `sourceTimestampMs` is set to `0`, `"sourceTimestampMs"` is added to `missingFields`, and non-finite metrics in `metricsSnapshot` are tagged with `metricProvenance: "UNAVAILABLE"`.
- **Market Observations:** When `sourceReportedTimeMs` is null, `sourceTimestampMs` is set to `0`, `dataFreshnessMs` is set to `Number.MAX_SAFE_INTEGER`, and missing flow/reserve fields are normalized to `null`.
- Downstream research filters (`ResearchEligibilityGate`) evaluate zero/stale source timestamps as ungrounded and disqualify lookahead evaluation while maintaining schema conformity.

---

## 4. Repository Verification & Test Results

The full repository verification suite was executed via `node scripts/verify-isolated.mjs all` in isolated environments:

| Suite / Check                           | Command                                           | Tests / Visits          | Result                            |
| :-------------------------------------- | :------------------------------------------------ | :---------------------- | :-------------------------------- |
| **Dependency Isolation**                | `scripts/check-isolation.mjs`                     | 877 links               | **PASSED**                        |
| **Architecture Boundaries**             | `scripts/architecture-check.mjs`                  | 77 modules              | **PASSED**                        |
| **TypeScript Compilation**              | `tsc` (backend, shared, frontend, vitest configs) | 4 configs               | **PASSED (0 type errors)**        |
| **Static Code Analysis**                | `eslint`                                          | All files               | **PASSED (0 errors, 0 warnings)** |
| **Code Formatting**                     | `prettier --check`                                | All files               | **PASSED**                        |
| **Architecture & Isolation Unit Tests** | `node --test`                                     | 27 tests                | **PASSED**                        |
| **Measurement & Analysis Suite**        | `vitest.measurement-analysis.config.ts`           | 740 tests               | **PASSED**                        |
| **— Raydium AMM Parser Tests**          | `RaydiumAmmParser.test.ts`                        | 14 tests                | **PASSED**                        |
| **— Pilot Adapters & Runner Tests**     | `PilotAdaptersAndRunner.test.ts`                  | 26 tests                | **PASSED**                        |
| **H2 Database Suite**                   | `vitest.h2.config.ts`                             | 194 tests               | **PASSED**                        |
| **H3 Providers Suite**                  | `vitest.h3.config.ts`                             | 98 tests                | **PASSED**                        |
| **H4 Analytics Suite**                  | `vitest.h4.config.ts`                             | 18 tests                | **PASSED**                        |
| **Total Passing Tests**                 | —                                                 | **1,050 / 1,050 tests** | **100% PASSED (Exit Code: 0)**    |

---

## 5. Security & Safety Invariants Affirmation

1. **Virtual Wallet Balance:** `.tmp/virtual-wallet.json` remains strictly frozen at **`7.9259 SOL`** with SHA-256 hash **`7F2C2353AC2F62CAC1BB98703742AB19C74AC5521635AF6F49BBE777AD020ED9`**.
2. **Untouched Subsystems:** Legacy `backend/src/shadow/` and closed milestones `backend/src/research/shadow/` (D.2.2) and D.2.1 remain completely untouched.
3. **Trading Engine Paused:** Windows paper trading daemon is stopped (0 active processes).
4. **Offline Isolation:** Pilot components contain zero real HTTP/WebSocket client instances; all operations are offline and fixture-driven.
5. **No Remote Fedora Contact:** Fedora host was not contacted and remains reported not inspected.

---

## 6. Authoritative Review Paths for Downstream Hypothesis Evaluation

Per auditor request, the following authoritative contracts and orchestration paths govern session evaluation and hypothesis testing:

1. **Telemetry Schema Definitions:**  
   [`backend/src/telemetry/TelemetryTypes.ts`](file:///u:/Projects/TopG/backend/src/telemetry/TelemetryTypes.ts)  
   _Defines canonical `CandidateDecisionRecord`, `MarketObservationRecord`, `ShadowEvaluationRecord`, and `SessionTelemetrySummary`._

2. **Shadow Evaluation Contract:**  
   [`backend/src/research/ShadowEvaluationContract.ts`](file:///u:/Projects/TopG/backend/src/research/ShadowEvaluationContract.ts)  
   _Enforces qualification result validity, non-negative reserve constraints, point-in-time snapshots, and execution feasibility invariants._

3. **Session Hypothesis Evaluation & Join Engine:**  
   [`backend/src/research/ResearchEligibilityGate.ts`](file:///u:/Projects/TopG/backend/src/research/ResearchEligibilityGate.ts) and [`backend/src/research/TelemetryExecutionJoinEngine.ts`](file:///u:/Projects/TopG/backend/src/research/TelemetryExecutionJoinEngine.ts)  
   _Orchestrates session ingestion, evaluates zero-lookahead decision windows, joins execution telemetry with counterfactual market observations, and enforces hypothesis qualification gates._
