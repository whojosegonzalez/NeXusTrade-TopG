# NeXusTrade Phase 10.6B Formulation B Tooling Detailed Checklist

## Formulation B Protocol Validator and Analysis Tooling Implementation Checklist

Status: **Completed & Synthetically Verified on 2026-09-24. All 6 planned tooling tasks implemented under H1–H4 engineering standards; passed full static checks, ESLint, Prettier, check-secrets, architecture policy, and 100% of synthetic test suites (277/277 tests passed across measurement/Formulation B suites, 587/587 across all isolated suites) under `node scripts/verify-isolated.mjs`.**

This tooling implementation and verification was strictly synthetic. It did not create operational archive roots, access or rerun production analyzers, make live provider calls, spawn background schedulers, or authorize PAPER or live trading actions.

---

## 1. Tooling Purpose & Scope

The purpose of this tooling phase is to implement and synthetically verify the automated protocol validator and analysis runner for **Formulation B (Liquidity-Independent Momentum Acceleration)**, as specified in the frozen protocol design document ([`docs/research-protocols/formulation-b-exploratory-protocol-design.md`](file:///u:/Projects/TopG/docs/research-protocols/formulation-b-exploratory-protocol-design.md)) and pinned protocol JSON ([`docs/research-protocols/phase10.6a-exploratory-cohort.formulation-b.v1.json`](file:///u:/Projects/TopG/docs/research-protocols/phase10.6a-exploratory-cohort.formulation-b.v1.json)).

### Scope & Constraints:

- **Language & Runtime**: Pure TypeScript / Node.js ESM under `backend/src/research-formulation-b-analysis/`.
- **Engineering Baseline**: Strict compliance with H1 (data isolation / memory-only SQLite), H2 (concurrency safety & deterministic transitions), H3 (fail-closed provider & rate boundary isolation), and H4 (read-only analytics boundary).
- **Execution Boundary**: Purely deterministic and outcome-blind. Zero network dependencies, zero background schedulers, zero database side effects.
- **Verification Harness**: Isolated test suite executed strictly via `node scripts/verify-isolated.mjs`.

---

## 2. Pinned Protocol Specification & Provenance

| Parameter                      | Specification                                                                                                                                                                         | Pinned Hash / Value                                                            |
| :----------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------- |
| **Protocol ID**                | `EXPLORATORY_COHORT_FORMULATION_B@v1`                                                                                                                                                 | Pinned Contract Version `1`                                                    |
| **Protocol Design Doc**        | [`docs/research-protocols/formulation-b-exploratory-protocol-design.md`](file:///u:/Projects/TopG/docs/research-protocols/formulation-b-exploratory-protocol-design.md)               | Approved & Frozen on 2026-09-24                                                |
| **Protocol JSON Path**         | [`docs/research-protocols/phase10.6a-exploratory-cohort.formulation-b.v1.json`](file:///u:/Projects/TopG/docs/research-protocols/phase10.6a-exploratory-cohort.formulation-b.v1.json) | Pinned on disk                                                                 |
| **Protocol JSON SHA-256**      | `241ac7b18711c0b08cc9083b02085c847f71594448c7d9286eb4333194036fda`                                                                                                                    | Exact cryptographic match verified                                             |
| **Deterministic Split**        | `SHA256("formulation-b-exploratory-protocol.v1" \| canonicalMint \| slotId)`                                                                                                          | Last hex char: even $\to$ Discovery, odd $\to$ Validation                      |
| **Candidate Predicate**        | `ACCELERATION__HIGH_V1`                                                                                                                                                               | Top quartile of Discovery acceleration: $\text{acc} \ge Q_3(\text{Discovery})$ |
| **Primary Evaluation Horizon** | Forward 60-minute return ($\text{return}_{60m} > 0$)                                                                                                                                  | Descriptive horizons: 3m, 5m, 15m                                              |

---

## 3. Tooling Implementation Tasks & Delivery Matrix

| Task ID    | Task Description                 | Target File(s)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Status        | Conformance Proof                                                                                           |
| :--------- | :------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------ | :---------------------------------------------------------------------------------------------------------- |
| **Task 1** | **Data Contracts & Types**       | [`FormulationBAnalysisTypes.ts`](file:///u:/Projects/TopG/backend/src/research-formulation-b-analysis/FormulationBAnalysisTypes.ts)<br>[`FormulationBAnalysisErrors.ts`](file:///u:/Projects/TopG/backend/src/research-formulation-b-analysis/FormulationBAnalysisErrors.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **Completed** | Zod schemas, exactOptionalPropertyTypes compliance, fail-closed error hierarchy                             |
| **Task 2** | **Quantile Math & Statistics**   | [`FormulationBQuantile.ts`](file:///u:/Projects/TopG/backend/src/research-formulation-b-analysis/FormulationBQuantile.ts)<br>[`FormulationBAnalysisGates.ts`](file:///u:/Projects/TopG/backend/src/research-formulation-b-analysis/FormulationBAnalysisGates.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **Completed** | 0-based indexing $k = \lceil 0.75 \times (n - 1) \rceil$, group statistics, gate evaluators                 |
| **Task 3** | **Archive Loader & Integrity**   | [`FormulationBArchiveLoader.ts`](file:///u:/Projects/TopG/backend/src/research-formulation-b-analysis/FormulationBArchiveLoader.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | **Completed** | SHA-256 manifest verification, lock check, safety counters check, liquidity prohibition check               |
| **Task 4** | **Analysis Service & Formatter** | [`FormulationBAnalysisService.ts`](file:///u:/Projects/TopG/backend/src/research-formulation-b-analysis/FormulationBAnalysisService.ts)<br>[`FormulationBAnalysisFormatter.ts`](file:///u:/Projects/TopG/backend/src/research-formulation-b-analysis/FormulationBAnalysisFormatter.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                            | **Completed** | Pure evaluation pipeline, deterministic Markdown & JSON output formatters                                   |
| **Task 5** | **CLI Tooling & Script Wiring**  | [`FormulationBAnalysisCli.ts`](file:///u:/Projects/TopG/backend/src/research-formulation-b-analysis/FormulationBAnalysisCli.ts)<br>[`research-formulation-b-analyze.ts`](file:///u:/Projects/TopG/backend/src/scripts/research-formulation-b-analyze.ts)<br>[`package.json`](file:///u:/Projects/TopG/package.json)                                                                                                                                                                                                                                                                                                                                                                                                                               | **Completed** | Strict CLI parser, fail-closed argument guard, `pnpm research:exploratory-cohort:analyze-formulation-b`     |
| **Task 6** | **Synthetic Test Harness**       | [`FormulationBAnalysis.test.ts`](file:///u:/Projects/TopG/backend/src/research-formulation-b-analysis/FormulationBAnalysis.test.ts)<br>[`FormulationBAnalysisIntegrity.test.ts`](file:///u:/Projects/TopG/backend/src/research-formulation-b-analysis/FormulationBAnalysisIntegrity.test.ts)<br>[`FormulationBAnalysisQuantile.test.ts`](file:///u:/Projects/TopG/backend/src/research-formulation-b-analysis/FormulationBAnalysisQuantile.test.ts)<br>[`FormulationBAnalysisGates.test.ts`](file:///u:/Projects/TopG/backend/src/research-formulation-b-analysis/FormulationBAnalysisGates.test.ts)<br>[`FormulationBAnalysisCli.test.ts`](file:///u:/Projects/TopG/backend/src/research-formulation-b-analysis/FormulationBAnalysisCli.test.ts) | **Completed** | All 8 synthetic fixtures, unit tests, integration tests passing cleanly under `scripts/verify-isolated.mjs` |

---

## 4. 0-Based Quantile Derivation Specification

The 0-based non-parametric third quartile ($Q_3$) calculation is implemented in [`FormulationBQuantile.ts`](file:///u:/Projects/TopG/backend/src/research-formulation-b-analysis/FormulationBQuantile.ts):

$$\text{For sorted array } A = [v_0, v_1, \dots, v_{n-1}], \quad k = \left\lceil 0.75 \times (n - 1) \right\rceil, \quad Q_3 = A[k]$$

### Verification Table:

| Sample Size ($n$) | $0.75 \times (n - 1)$    | 0-Based Index ($k$) | Top Quartile Elements Included                  | Test Case Status |
| :---------------- | :----------------------- | :------------------ | :---------------------------------------------- | :--------------- |
| $n = 8$           | $0.75 \times 7 = 5.25$   | $k = 6$             | Indices $[6, 7]$ (2 elements = 25.0%)           | Verified         |
| $n = 12$          | $0.75 \times 11 = 8.25$  | $k = 9$             | Indices $[9, 10, 11]$ (3 elements = 25.0%)      | Verified         |
| $n = 16$          | $0.75 \times 15 = 11.25$ | $k = 12$            | Indices $[12, 13, 14, 15]$ (4 elements = 25.0%) | Verified         |
| $n = 32$          | $0.75 \times 31 = 23.25$ | $k = 24$            | Indices $[24, \dots, 31]$ (8 elements = 25.0%)  | Verified         |
| $n = 48$          | $0.75 \times 47 = 35.25$ | $k = 36$            | Indices $[36, \dots, 47]$ (12 elements = 25.0%) | Verified         |

---

## 5. Synthetic Fixture Matrix & Gate Verification

All 8 pre-registered synthetic test fixtures have been implemented in [`FormulationBAnalysis.test-support.ts`](file:///u:/Projects/TopG/backend/src/research-formulation-b-analysis/FormulationBAnalysis.test-support.ts) and verified in [`FormulationBAnalysis.test.ts`](file:///u:/Projects/TopG/backend/src/research-formulation-b-analysis/FormulationBAnalysis.test.ts):

| Fixture ID     | Scenario Description                                              | Expected Outcome / Error                       | Actual Outcome                                 | Verification Status |
| :------------- | :---------------------------------------------------------------- | :--------------------------------------------- | :--------------------------------------------- | :------------------ |
| **Fixture 01** | Discovery effect $\ge 0.20$ & Validation replication $> 0.00$     | `PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL` | `PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL` | **PASSED**          |
| **Fixture 02** | Discovery effect $\ge 0.20$ but Validation replication $\le 0.00$ | `PRE_REGISTRATION_CANDIDATE_REJECTED`          | `PRE_REGISTRATION_CANDIDATE_REJECTED`          | **PASSED**          |
| **Fixture 03** | Discovery effect $< 0.20$                                         | `NO_DEFENSIBLE_HYPOTHESIS`                     | `NO_DEFENSIBLE_HYPOTHESIS`                     | **PASSED**          |
| **Fixture 04** | Momentum availability $< 90.0\%$                                  | `DATA_INSUFFICIENT`                            | `DATA_INSUFFICIENT`                            | **PASSED**          |
| **Fixture 05** | Total valid units $< 72$                                          | `DATA_INSUFFICIENT`                            | `DATA_INSUFFICIENT`                            | **PASSED**          |
| **Fixture 06** | Maximum date concentration $> 20.0\%$                             | `DATA_INSUFFICIENT`                            | `DATA_INSUFFICIENT`                            | **PASSED**          |
| **Fixture 07** | Tampered artifact / manifest hash mismatch                        | `FORMULATION_B_SOURCE_INCONSISTENCY`           | `FORMULATION_B_SOURCE_INCONSISTENCY`           | **PASSED**          |
| **Fixture 08** | Injected liquidity feature in decision inputs                     | `FORMULATION_B_SOURCE_INCONSISTENCY`           | `FORMULATION_B_SOURCE_INCONSISTENCY`           | **PASSED**          |

---

## 6. Architecture & Isolation Compliance

- **Architecture Policy**: [`scripts/architecture-policy.json`](file:///u:/Projects/TopG/scripts/architecture-policy.json) updated with `formulation-b-analyzer` module group allowing audited named imports (`crypto`, `fs`, `path`, `zod`).
- **Dependency Isolation**: 0 unauthorized dependencies added; `scripts/check-isolation.mjs` verified 877 dependency links with SQLite 3.53.2 memory-only.
- **Static Verification**:
  - `node scripts/check-isolation.mjs`: PASSED
  - `node scripts/architecture-check.mjs`: PASSED (53 protected module visits)
  - `tsc --noEmit` across backend, shared, frontend: PASSED
  - `eslint .`: PASSED (0 errors, 0 warnings)
  - `prettier . --check`: PASSED (100% formatted)
  - `node scripts/check-secrets.mjs`: PASSED
  - `git diff --check`: PASSED (0 whitespace errors)
  - `node scripts/verify-isolated.mjs`: PASSED (56 test files, 587 tests passed)

---

## 7. Operating Boundaries & Governance Non-Authorizations

1. **No Operational Archive Access or Modification**: No live or operational archive directory was accessed, modified, or created.
2. **No Production Analyzer Reruns**: Historical measurement studies (Phase 10.6B V2, Phase 10.6B.3 V3, Phase 10.6B.4) remain immutable.
3. **No Live Network or Provider Invocations**: Zero HTTP requests, RPC calls, or external API accesses were executed.
4. **No Execution or Trading Side Effects**: Zero wallet loading, transaction signing, order submission, or PAPER trading actions.
5. **Human Approval Boundary**: All next steps (e.g. data collection protocol execution, shadow pre-registration drafting) remain subject to explicit user review and approval.
