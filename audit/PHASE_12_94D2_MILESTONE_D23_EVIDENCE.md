# NeXusTrade — Phase 12.94-D.2.3 Implementation Evidence Report

**Document ID:** `NT-D23-EVIDENCE-v3`  
**Milestone:** Phase 12.94-D.2.3 (Solana Empirical Research Pilot Foundation)  
**Parent Audit Review:** `c:\Users\whojo\Downloads\NeXusTrade_D23_Commit_2acb2bd_Independent_Focused_Reaudit_v2.md`  
**Execution Environment:** Windows Offline Research Environment  
**Status:** RE-AUDIT v2 FINDINGS (D23R-01 THROUGH D23R-04) FULLY RESOLVED — VERIFICATION SUITE EXIT CODE 0

---

## 1. Executive Summary & Authorizations

Milestone **Phase 12.94-D.2.3** implements the strictly offline, read-only Solana empirical research pilot components in `backend/src/research/pilot/`. This revision addresses all four technical findings (**D23R-01 through D23R-04**) identified in the Independent Focused Re-audit v2 of commit `2acb2bd`.

### Operational Boundaries & Safety Guarantees

1. **Zero Real Network Execution:** No outbound network connections, real RPC endpoints, or DexScreener HTTP calls are enabled. All operations run offline against synthetic, deterministic fixtures.
2. **Zero Live Deployment:** Remote Fedora deployment, 2-hour live collection runs, and background daemon polling remain strictly unauthorized and deferred until separate operator authorization.
3. **Generation 1 Virtual Wallet Immutable:** The continuous virtual wallet balance remains untouched at **`7.9259 SOL`** with canonical SHA-256 hash **`7F2C2353AC2F62CAC1BB98703742AB19C74AC5521635AF6F49BBE777AD020ED9`**.
4. **Historical Subsystems Intact:** Legacy `backend/src/shadow/` and closed milestones `backend/src/research/shadow/` (D.2.2) and D.2.1 remain strictly untouched and immutable.
5. **Windows Engine Paused:** Zero background trading or paper engine daemons are active.

---

## 2. Re-audit v2 Findings Resolution Matrix (D23R-01 – D23R-04)

| Finding ID  | Title                                                         | Summary of Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Authoritative Module                                                               | Status       |
| :---------- | :------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------- | :----------- |
| **D23R-01** | Temporal Causality, Source Timestamp Bounds & Eligibility     | Added `validateCandidateCausality()` to enforce strict finite UTC epoch sequence: candidate $requestEpochMs \le receiptEpochMs \le decisionEpochMs$. If candidate $sourceTimestampMs$ is attested (non-null and non-zero), enforces $sourceTimestampMs \le receiptEpochMs$ and $sourceTimestampMs \le decisionEpochMs$. Enforces observation $requestEpochMs \le receiptEpochMs \le candidate.decisionEpochMs$, observation source time bounds, observation mint/pool ID match, and affirmatively validates `isEligible` from `validateShadowEvaluationEligibility()`. Rejects invalid or ineligible candidates before any JSONL write, preventing finalized sessions with invalid records. | `PilotCollectorRunner.ts`<br/>`PilotClock.ts`<br/>`PilotAdaptersAndRunner.test.ts` | **RESOLVED** |
| **D23R-02** | Recovery Cross-File Identity Consensus & Record Counts        | `PilotCollectorRunner.recoverSession()` now enforces complete semantic identity consensus between `session-meta.json` and `session-summary.json` (`sessionId`, `generationId`, `strategyRevision`, `startedAtIso`, `closedAtIso`, chronology, and affirmative completion flags). Cross-validates persisted record counts against summary totals and verifies foreign keys across all decisions, evaluations, and observations. Any mismatch downgrades status to `INTERRUPTED` with `interruptionReason: "METADATA_SUMMARY_IDENTITY_CONTRADICTION"` (or count contradiction) and repairs on-disk files. A regenerated manifest cannot override semantic inconsistencies.                    | `PilotCollectorRunner.ts`<br/>`PilotAdaptersAndRunner.test.ts`                     | **RESOLVED** |
| **D23R-03** | Synchronous Duplicate Event Reservation & Write Serialization | In `recordScreenedCandidate()`, reserves each unique `decisionEventId` synchronously before any `await`. If duplicate event ID is submitted concurrently (`Promise.allSettled`), the second call synchronously throws `[DUPLICATE_DECISION_ID]`. Serializes async writes and append-time baselines through `private writeMutex: Promise<void>`. Updated `finalize()` to await and drain `writeMutex` before validating reconciliation and setting finality. Regression tests verify that under concurrent identical calls, exactly one write succeeds and exactly one is rejected.                                                                                                          | `PilotCollectorRunner.ts`<br/>`PilotAdaptersAndRunner.test.ts`                     | **RESOLVED** |
| **D23R-04** | Symlink Canonical Destination & Protected Root Confinement    | Enhanced `validatePathConfinement()` to check both lexical paths AND canonical `realpath` of target, output root, and `allowedRootDir` against protected repository paths (`.tmp/telemetry`, `.tmp/sessions`, `.tmp/virtual-wallet.json`, `backend`, `frontend`, `shared`, `audit`, `scripts`). Also checks path segment patterns so symlinks pointing to `.tmp/telemetry` or `.tmp/sessions` inside any disposable test tree are immediately caught and rejected (`PATH_CONFINEMENT_VIOLATION`).                                                                                                                                                                                           | `PilotCollectorRunner.ts`<br/>`PilotAdaptersAndRunner.test.ts`                     | **RESOLVED** |

---

## 3. Targeted Adversarial Test Coverage

The following targeted regression tests were added to [`backend/src/research/pilot/PilotAdaptersAndRunner.test.ts`](file:///u:/Projects/TopG/backend/src/research/pilot/PilotAdaptersAndRunner.test.ts) (total suite expanded from 26 to 37 passing tests):

1. **D23R-01 Causality & Clock Checks:**
   - `directly validates candidate causality helper (D23R-01)`: Asserts valid finite epochs pass, and inverted request/receipt throws `REQUEST_AFTER_RECEIPT`.
   - `rejects candidate when receiptEpochMs > decisionEpochMs (lookahead violation)`: Asserts response after claimed decision throws `LOOKAHEAD_VIOLATION`.
   - `rejects candidate when sourceTimestampMs > decisionEpochMs (future source time)`: Asserts provider future source time throws `FUTURE_SOURCE_TIMESTAMP_LOOKAHEAD`.
   - `rejects candidate when requestEpochMs > receiptEpochMs (inverted causality)`: Asserts request after receipt throws `REQUEST_AFTER_RECEIPT`.
   - `rejects observation with mismatched mint address or late observation receipt (D23R-01)`: Asserts cross-mint observation throws `COMPOSITE_FOREIGN_KEY_MISMATCH` and observation received after candidate decision throws `OBSERVATION_LOOKAHEAD`.

2. **D23R-02 Recovery Cross-File Consensus Checks:**
   - `downgrades FINALIZED session to INTERRUPTED on generationId contradiction even with valid manifest (D23R-02)`: Creates clean finalized session, tampers `session-summary.json.generationId` to a foreign generation, regenerates export manifest, and verifies `recoverSession()` repairs and downgrades both meta and summary to `INTERRUPTED` with `interruptionReason: "METADATA_SUMMARY_IDENTITY_CONTRADICTION"`.
   - `downgrades FINALIZED session to INTERRUPTED when decision count contradicts summary (D23R-02)`: Tampers summary decision count and verifies recovery detects `RECORD_COUNT_SUMMARY_CONTRADICTION` and downgrades to `INTERRUPTED`.

3. **D23R-03 Concurrent Duplicate Admission:**
   - `prevents concurrent duplicate event IDs: exactly one write succeeds, exactly one duplicate rejected (D23R-03)`: Executes `Promise.allSettled([runner.recordScreenedCandidate(E1), runner.recordScreenedCandidate(E1)])` concurrently. Asserts exactly 1 promise fulfills, exactly 1 promise rejects with `DUPLICATE_DECISION_ID`, exactly 1 line exists on disk, and finalization completes without reconciliation error.

4. **D23R-04 Symlink Redirection Protection:**
   - `rejects outputRootDir symlink redirecting into protected telemetry directory (D23R-04)`: Creates isolated junction/symlink `redirected -> fake-project/.tmp/telemetry/sessions` and asserts `validatePathConfinement` throws `PATH_CONFINEMENT_VIOLATION`.
   - `enforces allowedRootDir when configured (D23R-04)`: Verifies paths outside `allowedRootDir` are rejected.

5. **D.1 Read-Only Interoperability Round-Trip:**
   - `successfully reads and verifies an exported pilot session with runReadinessAudit`: Exports a clean finalized pilot session and executes D.1 `runReadinessAudit()` with isolated `telemetrySessionsDir` and `legacySessionsDir`. Confirms 1 finalized session, 0 interrupted, 0 unfinalized, 1 decision, and 1 observation reported truthfully.

---

## 4. Repository Verification & Test Accounting

The entire repository verification suite was executed via `node scripts/verify-isolated.mjs all` in isolated environments:

| Suite / Check                      | Command                                           | Tests / Visits  | Result                                 |
| :--------------------------------- | :------------------------------------------------ | :-------------- | :------------------------------------- |
| **Dependency Isolation**           | `scripts/check-isolation.mjs`                     | 877 links       | **PASSED**                             |
| **Architecture Boundaries**        | `scripts/architecture-check.mjs`                  | 77 modules      | **PASSED**                             |
| **TypeScript Compilation**         | `tsc` (backend, shared, frontend, vitest configs) | 4 configs       | **PASSED (0 type errors)**             |
| **Static Code Analysis**           | `eslint`                                          | All files       | **PASSED (0 errors, 0 warnings)**      |
| **Code Formatting**                | `prettier --check`                                | All files       | **PASSED**                             |
| **Secrets Scan**                   | `scripts/check-secrets.mjs`                       | All files       | **PASSED**                             |
| **Git Diff Boundary**              | `git diff --check`                                | Working tree    | **PASSED**                             |
| **Node Test Runner**               | `node --test`                                     | 27 tests        | **PASSED (27/27)**                     |
| **Vitest: Measurement & Analysis** | `vitest.measurement-analysis.config.ts`           | 751 tests       | **PASSED (35 files, +11 pilot tests)** |
| **Vitest: H2 Database**            | `vitest.h2.config.ts`                             | 194 tests       | **PASSED (22 files)**                  |
| **Vitest: H3 Providers**           | `vitest.h3.config.ts`                             | 98 tests        | **PASSED (20 files)**                  |
| **Vitest: H4 Analytics**           | `vitest.h4.config.ts`                             | 18 tests        | **PASSED (4 files)**                   |
| **Total Passing Tests**            | **Node (27) + Vitest (1,061)**                    | **1,088 tests** | **100% PASSED (Exit Code: 0)**         |

### Reconciliation of Test Accounting

- **Prior reported count in commit `2acb2bd`:** 1,050 Vitest tests (740 + 194 + 98 + 18) + 27 Node tests = **1,077 total tests**.
- **Current count in this commit:** 1,061 Vitest tests (751 + 194 + 98 + 18) + 27 Node tests = **1,088 total tests**.
- **Net change:** +11 tests added to `backend/src/research/pilot/PilotAdaptersAndRunner.test.ts` (expanded from 26 to 37 tests). All 1,088 tests passed cleanly.

---

## 5. Current File Paths for D.1 Interoperability Review

Per auditor request in section 7 of the Focused Re-audit v2, the current versions and canonical paths of the actual D.1 readiness and joining components are provided below:

1. **D.1 Readiness Audit Script (`runReadinessAudit` export):**  
   [`scripts/audit-research-readiness.mjs`](file:///u:/Projects/TopG/scripts/audit-research-readiness.mjs)  
   _Authoritative session-directory reader, finality evaluator, and hypothesis feasibility scanner. Options accept custom `telemetrySessionsDir`, `legacySessionsDir`, `rootDir`, and `reportOutputPath`._

2. **D.1 Research Eligibility Gate (`evaluateResearchEligibility`, `determineSessionStatus`):**  
   [`backend/src/research/ResearchEligibilityGate.ts`](file:///u:/Projects/TopG/backend/src/research/ResearchEligibilityGate.ts)  
   _Enforces fail-closed data quality gating, cross-file identity consensus, anti-lookahead timestamp bounds, and non-negative reserve constraints._

3. **D.1 Point-in-Time Join Engine (`joinTelemetryAndExecution`):**  
   [`backend/src/research/TelemetryExecutionJoinEngine.ts`](file:///u:/Projects/TopG/backend/src/research/TelemetryExecutionJoinEngine.ts)  
   _Implements point-in-time joins between candidate decisions and market observations, feature extraction with explicit provenance tracking (`OBSERVED`, `DERIVED`, `UNAVAILABLE`, `PLACEHOLDER`), and trajectory linking._

4. **Public TypeScript Declaration File:**  
   [`scripts/audit-research-readiness.d.ts`](file:///u:/Projects/TopG/scripts/audit-research-readiness.d.ts)  
   _Declares public options and `ReadinessAuditResult` interface for `runReadinessAudit()`._

---

## 6. Raw Verification Log (Complete Execution Summary)

```text
node.exe scripts/check-isolation.mjs
Isolation verified (877 dependency links); SQLite 3.53.2; memory only.

node.exe scripts/architecture-check.mjs
Architecture policy v1 passed (77 protected module visits).

node.exe node_modules/typescript/bin/tsc -p backend/tsconfig.json --noEmit
node.exe node_modules/typescript/bin/tsc -p shared/tsconfig.json --noEmit
node.exe node_modules/typescript/bin/tsc -p frontend/tsconfig.app.json --noEmit
node.exe node_modules/typescript/bin/tsc --noEmit --module NodeNext --target ES2022 --skipLibCheck --strict \
  backend/vitest.measurement-analysis.config.ts \
  backend/vitest.h2.config.ts \
  backend/vitest.h3.config.ts \
  backend/vitest.h4.config.ts

node.exe node_modules/eslint/bin/eslint.js . --ignore-pattern .pnpm-store/** --ignore-pattern .tmp/**
node.exe node_modules/prettier/bin/prettier.cjs . --check --ignore-path .gitignore --ignore-path .prettierignore
Checking formatting...
All matched files use Prettier code style!

node.exe scripts/check-secrets.mjs
Secret check passed.

git diff --check

node.exe --test scripts/architecture-check.test.mjs scripts/verify-isolated.test.mjs
✔ rejects capability new Function("return 1") (2.7816ms)
✔ rejects capability Date.now() (2.8154ms)
✔ rejects capability setTimeout(()=>{},1) (3.2971ms)
✔ unresolved runtime and unreviewed type dependencies fail explicitly (7.2229ms)
✔ renamed filesystem writes cannot pass a named read API allowance (3.1759ms)
✔ an audited package name still requires successful module resolution (3.7044ms)
✔ rejects redirected source before reading its target (4.9308ms)
✔ isolated plan contains exactly the four audited suites and no operational command (1.2691ms)
✔ first child failure stops subsequent commands with nonzero status (1.7398ms)
✔ spawn errors and signals fail closed (1.618ms)
✔ invalid modes fail before execution (0.3153ms)
ℹ tests 27
ℹ suites 0
ℹ pass 27
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 343.5776

node.exe node_modules/vitest/vitest.mjs run --config backend/vitest.measurement-analysis.config.ts
 Test Files  35 passed (35)
      Tests  751 passed (751)
   Start at  18:01:07
   Duration  15.20s

node.exe node_modules/vitest/vitest.mjs run --config backend/vitest.h2.config.ts
 Test Files  22 passed (22)
      Tests  194 passed (194)
   Start at  18:01:23
   Duration  35.26s

node.exe node_modules/vitest/vitest.mjs run --config backend/vitest.h3.config.ts
 Test Files  20 passed (20)
      Tests  98 passed (98)
   Start at  18:01:58
   Duration  5.54s

node.exe node_modules/vitest/vitest.mjs run --config backend/vitest.h4.config.ts
 Test Files  4 passed (4)
      Tests  18 passed (18)
   Start at  18:02:04
   Duration  1.77s

Verification suite completed successfully.
Exit Code: 0
```
