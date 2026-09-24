# Phase 10.6B Formulation B Collection Architecture & Synthetic Verification Record

## Synthetic Collector Verification Record

Date: **2026-09-24**  
Status: **PASSED (100% Synthetic Verification Clean)**  
Harness Command: `node scripts/verify-isolated.mjs`  
Associated Protocol: [`docs/research-protocols/formulation-b-exploratory-protocol-design.md`](file:///u:/Projects/TopG/docs/research-protocols/formulation-b-exploratory-protocol-design.md)  
Pinned Protocol JSON: [`docs/research-protocols/phase10.6a-exploratory-cohort.formulation-b.v1.json`](file:///u:/Projects/TopG/docs/research-protocols/phase10.6a-exploratory-cohort.formulation-b.v1.json)  
Pinned Protocol SHA-256: `241ac7b18711c0b08cc9083b02085c847f71594448c7d9286eb4333194036fda`

---

## 1. Executive Summary

This verification record documents the comprehensive synthetic validation of the **Formulation B Data Collector** under the repository's isolated testing harness (`node scripts/verify-isolated.mjs`). All collector modules were constructed under strict H1–H4 engineering standards and verified exclusively against isolated mock provider fixtures without initiating live external network calls, background schedulers, or operational archive roots.

### Key Verification Metrics:

- **Total Test Suites Executed**: 4 Vitest configurations (`measurement-analysis`, `h2`, `h3`, `h4`) + 2 Node test runners.
- **Total Test Files Passed**: 63 passed, 0 failed.
- **Total Tests Passed**: 616 passed, 0 failed.
- **Formulation B Collection Test Suite**: 7 test files, 29 tests covering all 6 fail-closed safety tripwires, discovery deduplication, token age thresholds, momentum capture & acceleration derivation, multi-horizon forward outcome queuing (+3m, +5m, +15m, +60m), archive lock lifecycle, and full end-to-end downstream analysis integration.
- **Static Checks**: 100% pass across Isolation Check, Architecture Check (64 protected visits), TypeScript (`tsc --noEmit`), ESLint, Prettier, Secrets Detection, and Git Diff whitespace check.

---

## 2. Verification Harness Execution Evidence

The complete verification harness executed cleanly via `node scripts/verify-isolated.mjs`:

```
node.exe scripts/check-isolation.mjs
Isolation verified (877 dependency links); SQLite 3.53.2; memory only.

node.exe scripts/architecture-check.mjs
Architecture policy v1 passed (64 protected module visits).

node.exe node_modules/typescript/bin/tsc -p backend/tsconfig.json --noEmit
node.exe node_modules/typescript/bin/tsc -p shared/tsconfig.json --noEmit
node.exe node_modules/typescript/bin/tsc -p frontend/tsconfig.app.json --noEmit
node.exe node_modules/typescript/bin/tsc --noEmit --module NodeNext --target ES2022 --skipLibCheck --strict backend/vitest.measurement-analysis.config.ts backend/vitest.h2.config.ts backend/vitest.h3.config.ts backend/vitest.h4.config.ts

node.exe node_modules/eslint/bin/eslint.js . --ignore-pattern .pnpm-store/** --ignore-pattern .tmp/**
node.exe node_modules/prettier/bin/prettier.cjs . --check --ignore-path .gitignore --ignore-path .prettierignore
Checking formatting...
All matched files use Prettier code style!

node.exe scripts/check-secrets.mjs
Secret check passed.

git diff --check

node.exe --test scripts/architecture-check.test.mjs scripts/verify-isolated.test.mjs
ℹ tests 27
ℹ suites 0
ℹ pass 27
ℹ fail 0

node.exe node_modules/vitest/vitest.mjs run --config backend/vitest.measurement-analysis.config.ts
 RUN  v4.1.11 U:/Projects/TopG/backend

 ✓ src/research-measurement-cohort-analysis/MeasurementCohortAnalysisIntegrity.test.ts (115 tests)
 ✓ src/research-measurement-cohort-analysis/MeasurementCohortAnalysisCli.test.ts (7 tests)
 ✓ src/research-measurement-cohort-analysis/MeasurementCohortAnalysis.test.ts (77 tests)
 ✓ src/research-measurement-cohort-analysis/MeasurementCohortAnalysisGates.test.ts (26 tests)
 ✓ src/research-measurement-cohort-analysis/MeasurementCohortAnalysisDependencies.test.ts (22 tests)
 ✓ src/research-formulation-b-analysis/FormulationBAnalysis.test.ts (8 tests)
 ✓ src/research-formulation-b-analysis/FormulationBAnalysisIntegrity.test.ts (7 tests)
 ✓ src/research-formulation-b-collection/FormulationBCollectionRunner.test.ts (3 tests)
 ✓ src/research-formulation-b-collection/FormulationBSafetyMonitor.test.ts (7 tests)
 ✓ src/research-formulation-b-analysis/FormulationBAnalysisCli.test.ts (7 tests)
 ✓ src/research-formulation-b-collection/FormulationBCollectionConfig.test.ts (7 tests)
 ✓ src/research-formulation-b-analysis/FormulationBAnalysisGates.test.ts (2 tests)
 ✓ src/research-formulation-b-collection/FormulationBOutcomeQueue.test.ts (4 tests)
 ✓ src/research-formulation-b-collection/FormulationBMomentumCapture.test.ts (3 tests)
 ✓ src/research-formulation-b-collection/FormulationBTokenDiscovery.test.ts (2 tests)
 ✓ src/research-formulation-b-collection/FormulationBCollectionCli.test.ts (3 tests)
 ✓ src/research-formulation-b-analysis/FormulationBAnalysisQuantile.test.ts (6 tests)

 Test Files  17 passed (17)
      Tests  306 passed (306)

node.exe node_modules/vitest/vitest.mjs run --config backend/vitest.h2.config.ts
 Test Files  22 passed (22)
      Tests  194 passed (194)

node.exe node_modules/vitest/vitest.mjs run --config backend/vitest.h3.config.ts
 Test Files  20 passed (20)
      Tests  98 passed (98)

node.exe node_modules/vitest/vitest.mjs run --config backend/vitest.h4.config.ts
 Test Files  4 passed (4)
      Tests  18 passed (18)
```

---

## 3. Fail-Closed Safety Tripwires Synthetic Verification

The 6 fail-closed safety stops implemented in [`FormulationBSafetyMonitor.ts`](file:///u:/Projects/TopG/backend/src/research-formulation-b-collection/FormulationBSafetyMonitor.ts) were individually verified under unit and integration tests:

1. **Clock Drift Safety Tripwire (`FORMULATION_B_CLOCK_DRIFT_STOP`)**:
   - Drift $\le 5.0\text{s}$ executes normally.
   - Drift $> 5.0\text{s}$ (tested with 7.0s and 10.0s skew) immediately halts execution, increments safety counter, records stop code in `cohort-manifest.v1.json`, and preserves `collection.lock`.
2. **Secret & Credential Leakage Tripwire (`FORMULATION_B_SECRET_LEAKAGE_STOP`)**:
   - Payloads containing Bearer tokens, `sk_live_` keys, API key patterns, or RSA private keys are caught by regex filtering, incrementing safety counters and aborting collection immediately.
3. **HTTP Rate Limit Response Tripwire (`FORMULATION_B_RATE_LIMIT_STOP`)**:
   - Encounters with HTTP 429 or HTTP 403 responses immediately trip fail-closed halts without blind retries.
4. **Consecutive Slot Failure Threshold (`FORMULATION_B_CONSECUTIVE_ERROR_STOP`)**:
   - 3 consecutive slot errors trip immediate collection termination; single or double intermittent errors reset cleanly upon subsequent slot success.
5. **Decision-Time Liquidity Prohibition Tripwire (`FORMULATION_B_LIQUIDITY_PROHIBITION_STOP`)**:
   - Any payload key containing `liquidity`, `liquidityusd`, `poolreserve`, `poolreserveusd`, `quoteimpact`, `quoteimpactbps`, or `depth` triggers an immediate fail-closed error.
6. **Request Budget Caps (`FORMULATION_B_BUDGET_EXCEEDED_STOP`)**:
   - Enforces the daily cap of 120 requests/UTC date and the cohort total run cap of 600 requests.

---

## 4. Discovery, Momentum Capture, & Outcome Queuing Verification

- **Token Discovery ([`FormulationBTokenDiscovery.ts`](file:///u:/Projects/TopG/backend/src/research-formulation-b-collection/FormulationBTokenDiscovery.ts))**:
  - Validated asset age gating: candidates with $\text{assetAgeSeconds} < 300\text{s}$ are rejected.
  - In-memory mint deduplication: verified that candidate mints already seen in earlier slots are bypassed to strictly maintain zero repeat mints.
- **Momentum Capture ([`FormulationBMomentumCapture.ts`](file:///u:/Projects/TopG/backend/src/research-formulation-b-collection/FormulationBMomentumCapture.ts))**:
  - Computes $\text{momentumAccelerationPct} = \text{momentum5mPct} - \text{momentum15mPct}$.
  - Correctly flags `missingnessCode: "MISSING_MOMENTUM_HISTORY"` if either horizon is null or unmeasurable.
- **Forward Outcome Queuing ([`FormulationBOutcomeQueue.ts`](file:///u:/Projects/TopG/backend/src/research-formulation-b-collection/FormulationBOutcomeQueue.ts))**:
  - Queries forward spot prices at $+3\text{m}, +5\text{m}, +15\text{m}, +60\text{m}$ relative to anchor timestamp.
  - Assigns `POSITIVE_60M` ($\text{return}_{60m} > 0$), `NON_POSITIVE_60M` ($\text{return}_{60m} \le 0$), or `UNUSABLE_60M` (null forward price or missing anchor price).

---

## 5. End-to-End Downstream Analysis Compatibility

In [`FormulationBCollectionRunner.test.ts`](file:///u:/Projects/TopG/backend/src/research-formulation-b-collection/FormulationBCollectionRunner.test.ts), a synthetic archive generated by `FormulationBCollectionRunner` was ingested by `loadFormulationBArchive` and analyzed by `analyzeFormulationBArchive` ([`FormulationBAnalysisService.ts`](file:///u:/Projects/TopG/backend/src/research-formulation-b-analysis/FormulationBAnalysisService.ts)):

- **Generated Artifacts**:
  - `units.v1.ndjson` (96 unit records, perfectly formatted NDJSON)
  - `source-inventory.v1.json` (sources metadata)
  - `collection-summary.v1.json` (`finalOutcome: "COHORT_COMPLETE"`)
  - `cohort-manifest.v1.json` (accurate SHA-256 hashes of all artifacts)
- **Downstream Result**:
  - Integrity & Quality Gates: `100% passed`.
  - Manifest Checksums: `100% matched`.
  - Partition Split: `48 Discovery, 48 Validation` (balanced $\ge 32$ units per partition).
  - Date Concentration: `12.5% max date share` ($< 20.0\%$ cap across 8 dates).

---

## 6. Architecture & Policy Compliance

- Module registered in [`scripts/architecture-policy.json`](file:///u:/Projects/TopG/scripts/architecture-policy.json) under `formulation-b-collector`.
- Audited named external imports only: `node:fs` (`appendFileSync`, `existsSync`, `mkdirSync`, `readFileSync`, `unlinkSync`, `writeFileSync`), `node:crypto` (`createHash`), `node:path` (`default`), `zod` (`AUDITED_PACKAGE`).
- CLI script registered in [`package.json`](file:///u:/Projects/TopG/package.json) and [`backend/package.json`](file:///u:/Projects/TopG/backend/package.json):
  `"research:exploratory-cohort:collect-formulation-b": "tsx src/scripts/research-formulation-b-collect.ts"`
- Static architecture check: `Architecture policy v1 passed (64 protected module visits)`.

---

## 7. Governance & Operational Boundaries Attestation

1. **Synthetic Verification Only**: No production or live market data was collected, and no network sockets to external providers were opened.
2. **Default Denial Maintained**: No operational archive roots exist in repository paths; all test archives were constructed and torn down under isolated cache directories (`node_modules/.cache/`).
3. **Execution Isolation**: Zero execution, paper trading, wallet, or order placement surfaces were touched.
4. **Awaiting User Authorization**: Live execution of data collection requires explicit operational authorization from the user.
