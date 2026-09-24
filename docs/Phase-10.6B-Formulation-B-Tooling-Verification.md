# Phase 10.6B Formulation B Tooling Verification Record

## Synthetic Tooling & Protocol Validator Verification Record

Date: **2026-09-24**  
Status: **PASSED (100% Synthetic Verification Clean)**  
Harness Command: `node scripts/verify-isolated.mjs`  
Associated Protocol: [`docs/research-protocols/formulation-b-exploratory-protocol-design.md`](file:///u:/Projects/TopG/docs/research-protocols/formulation-b-exploratory-protocol-design.md)  
Pinned Protocol JSON: [`docs/research-protocols/phase10.6a-exploratory-cohort.formulation-b.v1.json`](file:///u:/Projects/TopG/docs/research-protocols/phase10.6a-exploratory-cohort.formulation-b.v1.json)  
Pinned Protocol SHA-256: `241ac7b18711c0b08cc9083b02085c847f71594448c7d9286eb4333194036fda`

---

## 1. Executive Summary

This verification record documents the comprehensive synthetic validation of the automated protocol validator and analysis tooling for **Formulation B (Liquidity-Independent Momentum Acceleration)** under the repository's isolated testing harness.

### Key Verification Metrics:

- **Total Test Suites Executed**: 4 Vitest configurations (`measurement-analysis`, `h2`, `h3`, `h4`) + 2 Node test runners.
- **Total Test Files Passed**: 56 passed, 0 failed.
- **Total Tests Passed**: 587 passed, 0 failed.
- **Formulation B Test Suite**: 5 test files, 30 tests covering all 8 synthetic fixtures, quantile edge cases, gate mathematics, archive integrity, and CLI argument parsing/formatting.
- **Static Checks**: 100% pass across Isolation Check, Architecture Check, TypeScript (`tsc --noEmit`), ESLint, Prettier, Secrets Detection, and Git Diff whitespace check.

---

## 2. Verification Harness Execution Evidence

The complete verification harness was executed cleanly via `node scripts/verify-isolated.mjs`:

```
node.exe scripts/check-isolation.mjs
Isolation verified (877 dependency links); SQLite 3.53.2; memory only.

node.exe scripts/architecture-check.mjs
Architecture policy v1 passed (53 protected module visits).

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
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0

node.exe node_modules/vitest/vitest.mjs run --config backend/vitest.measurement-analysis.config.ts
 RUN  v4.1.11 U:/Projects/TopG/backend

 ✓ src/research-formulation-b-analysis/FormulationBAnalysis.test.ts (8 tests) 31ms
 ✓ src/research-formulation-b-analysis/FormulationBAnalysisCli.test.ts (7 tests) 15ms
 ✓ src/research-measurement-cohort-analysis/MeasurementCohortAnalysisIntegrity.test.ts (115 tests) 2915ms
 ✓ src/research-measurement-cohort-analysis/MeasurementCohortAnalysisCli.test.ts (7 tests) 1339ms
 ✓ src/research-measurement-cohort-analysis/MeasurementCohortAnalysis.test.ts (77 tests) 696ms
 ✓ src/research-measurement-cohort-analysis/MeasurementCohortAnalysisGates.test.ts (26 tests) 258ms
 ✓ src/research-measurement-cohort-analysis/MeasurementCohortAnalysisDependencies.test.ts (22 tests) 160ms
 ✓ src/research-formulation-b-analysis/FormulationBAnalysisIntegrity.test.ts (7 tests) 26ms
 ✓ src/research-formulation-b-analysis/FormulationBAnalysisGates.test.ts (2 tests) 5ms
 ✓ src/research-formulation-b-analysis/FormulationBAnalysisQuantile.test.ts (6 tests) 4ms

 Test Files  10 passed (10)
      Tests  277 passed (277)

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

## 3. Synthetic Fixture Matrix Verification Detail

The 8 pre-registered synthetic fixtures executed under [`FormulationBAnalysis.test.ts`](file:///u:/Projects/TopG/backend/src/research-formulation-b-analysis/FormulationBAnalysis.test.ts) verified every state transition:

### Fixture 01: Replicated Signal (Discovery + Validation Pass)

- **Inputs**: 96 valid units across 8 dates (48 Discovery, 48 Validation).
- **Discovery Metrics**: $Q_3 = +13.0\%$, Top Acceleration Rule positive rate = 100.0%, Comparison positive rate = 33.3%, $\Delta = +66.7\% \ge 20.0\%$.
- **Validation Metrics**: Top Acceleration Rule positive rate = 80.0%, Comparison positive rate = 40.0%, $\Delta = +40.0\% > 0.0\%$.
- **Decision Outcome**: `PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL`.

### Fixture 02: Validation Replication Failure

- **Inputs**: 96 valid units across 8 dates. Discovery effect clears $\ge 20.0\%$, but Validation top acceleration produces lower positive return than comparison ($\Delta = -40.0\% \le 0.0\%$).
- **Validation Gate**: `VAL_REPLICATION_GATE` fails.
- **Decision Outcome**: `PRE_REGISTRATION_CANDIDATE_REJECTED`.

### Fixture 03: Discovery Effect Threshold Failure

- **Inputs**: 96 valid units across 8 dates. Discovery top acceleration produces equivalent return rate to comparison ($\Delta = 0.0\% < 20.0\%$).
- **Discovery Gate**: `DISC_EFFECT_GATE` fails.
- **Decision Outcome**: `NO_DEFENSIBLE_HYPOTHESIS`.

### Fixture 04: Momentum Availability Floor Breach

- **Inputs**: 96 valid units. 20 units have null momentum decision evidence ($\sim 79\%$ availability $< 90.0\%$).
- **Quality Gate**: `MOMENTUM_AVAILABILITY_FLOOR` fails.
- **Decision Outcome**: `DATA_INSUFFICIENT`.

### Fixture 05: Minimum Cohort Size Breach

- **Inputs**: 60 valid units ($< 72$ minimum).
- **Quality Gate**: `MINIMUM_VALID_UNITS` fails.
- **Decision Outcome**: `DATA_INSUFFICIENT`.

### Fixture 06: Maximum Single-Date Concentration Breach

- **Inputs**: 96 valid units with 30 units concentrated on day 1 (31.25% $> 20.0\%$).
- **Quality Gate**: `MAXIMUM_DATE_SHARE` fails.
- **Decision Outcome**: `DATA_INSUFFICIENT`.

### Fixture 07: Archive Artifact Checksum Tampering

- **Inputs**: `units.v1.ndjson` modified after manifest generation.
- **Loader Result**: Throws `FormulationBAnalysisError` with code `FORMULATION_B_SOURCE_INCONSISTENCY`.

### Fixture 08: Injected Liquidity Feature Detection

- **Inputs**: Unit record injected with forbidden field `liquidityUsd`.
- **Loader Result**: Throws `FormulationBAnalysisError` with code `FORMULATION_B_SOURCE_INCONSISTENCY` and message `"Forbidden liquidity field detected"`.

---

## 4. Quantile Derivation Mathematical Proof

Implemented in [`FormulationBQuantile.ts`](file:///u:/Projects/TopG/backend/src/research-formulation-b-analysis/FormulationBQuantile.ts) using the 0-based indexing rule:

$$k = \left\lceil 0.75 \times (n - 1) \right\rceil, \quad Q_3 = A_{\text{sorted}}[k]$$

Verified via [`FormulationBAnalysisQuantile.test.ts`](file:///u:/Projects/TopG/backend/src/research-formulation-b-analysis/FormulationBAnalysisQuantile.test.ts):

- Array $[1, 2, 3, 4, 5, 6, 7, 8]$ ($n=8$): $k = \lceil 0.75 \times 7 \rceil = 6 \implies Q_3 = 7$.
- Array $[10, 20, 30, 40]$ ($n=4$): $k = \lceil 0.75 \times 3 \rceil = 3 \implies Q_3 = 40$.
- Array of length 48 ($n=48$): $k = \lceil 0.75 \times 47 \rceil = 36 \implies$ Exactly top 12 elements (25.0%) selected as $\ge Q_3$.
- Identical values $[5, 5, 5, 5, 5, 5, 5, 5]$ ($n=8$): $Q_3 = 5$.
- Empty array: Throws `FORMULATION_B_QUANTILE_EMPTY_ARRAY`.

---

## 5. CLI & Script Wiring Conformance

- Executable script added to [`package.json`](file:///u:/Projects/TopG/package.json):
  `"research:exploratory-cohort:analyze-formulation-b": "tsx backend/src/scripts/research-formulation-b-analyze.ts"`
- CLI argument parsing tests in [`FormulationBAnalysisCli.test.ts`](file:///u:/Projects/TopG/backend/src/research-formulation-b-analysis/FormulationBAnalysisCli.test.ts):
  - Correctly parses `--archive-root=...` and `--format=markdown|json`.
  - Rejects missing archive root, multiple archive roots, path traversal attempts (`..`), and unrecognized flags.
  - Formats output deterministically to stdout with 0 error code on success and non-zero on failure.

---

## 6. Operating Boundaries & Governance Attestation

1. **Synthetic Only**: Zero operational data was written to or read from disk during tooling construction or verification.
2. **Outcome Blind**: Tooling is strictly deterministic and evaluates gates without prior knowledge of live market outcomes.
3. **No Downstream Authority**: This verification record does NOT authorize data collection, live trading, paper trading, or strategy execution. Any subsequent exploratory data collection requires a separate user-approved scope proposal.
