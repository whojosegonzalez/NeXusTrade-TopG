# NeXusTrade — Research Input Readiness & Lineage Report

**Audit Date:** 2026-10-15T05:56:38.101Z<br/>
**Status:** **INSUFFICIENT_EVIDENCE (NO_PERSISTED_TELEMETRY_SESSIONS)**<br/>
**Milestone:** Phase 12.94-D Milestone D.1 — Telemetry Data Feasibility & Lineage Audit

---

## 1. Executive Summary & Inventory Findings

This report documents the empirical audit of historical telemetry and execution files currently persisted on disk in canonical workspace locations (`.tmp/telemetry/sessions` and `.tmp/sessions`).

In strict compliance with Independent Architecture Review v1 (Finding D-01 and D-07 Safeguards):

- **Zero data fabrication**: Missing sessions, records, or features are honestly reported as zero / unavailable.
- **Honest Provenance**: No non-existent quotes, fills, or reserves are assumed or inferred.
- **Readiness Conclusion**: No live or archived 12.94-B telemetry sessions currently exist in the canonical `.tmp/telemetry/sessions` path. Prior test suites executed inside `.tmp/isolated/...` sandbox environments. Consequently, the workspace is currently classified as **`INSUFFICIENT_EVIDENCE`** for quantitative hypothesis evaluation.

---

## 2. Session & Decision Denominators

| Metric                                    | Count | Notes                                                |
| :---------------------------------------- | :---- | :--------------------------------------------------- |
| **Total Telemetry Sessions Found**        | 0     | In `.tmp/telemetry/sessions`                         |
| • Finalized Sessions                      | 0     | Passed affirmative finality & completeness checks    |
| • Interrupted Sessions                    | 0     | Excluded from primary alpha cohorts                  |
| • Unfinalized / Active Sessions           | 0     | Excluded (incomplete finalization)                   |
| **Total Candidate Decisions**             | 0     | Total decisions across all cohorts                   |
| • `FILTERED_REJECTED`                     | 0     | Initial scanner filter rejections                    |
| • `WATCHLIST_RADAR`                       | 0     | Admitted to watchlist tracking                       |
| • `TRIGGER_REJECTED`                      | 0     | Evaluated at trigger, rejected                       |
| • `EXECUTED_BUY`                          | 0     | Executed buy decisions                               |
| **Finalized Research-Eligible Decisions** | 0     | Causally valid in authoritatively finalized sessions |
| **Total Market Observations**             | 0     | Follow-up observation records                        |
| • Observations with Verified Pool ID      | 0     | Verified via `isVerifiedMatchingPool`                |
| • Observations with Valid AMM Reserves    | 0     | Verified pool observations with base/quote reserves  |
| • Usable Pre-Decision Reserve Snapshots   | 0     | Verified pre-decision point-in-time AMM reserves     |
| **Total Executable Quotes (12.94-C)**     | 0     | Standalone 12.94-C execution quotes on disk          |
| **Total Simulated Fills (12.94-C)**       | 0     | Standalone 12.94-C simulated fills on disk           |
| **Total Stratified Sampling Records**     | 0     | Tracked sampling trajectory records                  |
| **Total Malformed / Corrupted Records**   | 0     | Invalid JSON records quarantined                     |
| **Legacy Pre-12.94 Sessions**             | 2     | In `.tmp/sessions` (pre-telemetry format)            |

---

## 3. Feature Availability & Missingness Distribution

| Feature Name              | Available Count | Availability Rate | Current Provenance Status |
| :------------------------ | :-------------- | :---------------- | :------------------------ |
| **tokenAgeSec**           | 0               | 0.0%              | UNAVAILABLE               |
| **liquidityUsd**          | 0               | 0.0%              | UNAVAILABLE               |
| **marketCapUsd**          | 0               | 0.0%              | UNAVAILABLE               |
| **lmcRatio**              | 0               | 0.0%              | UNAVAILABLE               |
| **lpBurnPct**             | 0               | 0.0%              | UNAVAILABLE               |
| **spotPriceUsd**          | 0               | 0.0%              | UNAVAILABLE               |
| **spotPriceSol**          | 0               | 0.0%              | UNAVAILABLE               |
| **volume5mUsd**           | 0               | 0.0%              | UNAVAILABLE               |
| **txCount5m**             | 0               | 0.0%              | UNAVAILABLE               |
| **buys5m / sells5m**      | 0               | 0.0%              | UNAVAILABLE               |
| **baseReserve**           | 0               | 0.0%              | UNAVAILABLE               |
| **quoteReserve**          | 0               | 0.0%              | UNAVAILABLE               |
| **top10ConcentrationPct** | 0               | 0.0%              | UNAVAILABLE               |
| **devHoldingPct**         | 0               | 0.0%              | UNAVAILABLE               |

---

## 4. Evaluation Feasibility Assessment for Hypotheses H1–H4

| Hypothesis                                | Required Features                                                 | Raw Feature Coverage         | Eligible-Cohort Decisions | Current Data Feasibility | Reason Code if Ineligible             |
| :---------------------------------------- | :---------------------------------------------------------------- | :--------------------------- | :------------------------ | :----------------------- | :------------------------------------ |
| **H1: Liquidity Depth & Price Impact**    | Pre-decision quoteReserve, baseReserve, tradeSize                 | 0 valid reserve obs          | 0                         | INELIGIBLE               | NO_INDEPENDENT_POINT_IN_TIME_SNAPSHOT |
| **H2: Order Flow Momentum**               | buys5m, sells5m, volume5mUsd (co-occurring on same decision)      | 0 raw co-occurring decisions | 0                         | INELIGIBLE               | FIELD_NOT_COLLECTED_IN_GENERATION     |
| **H3: Structural Safety & Concentration** | lpBurnPct on decision AND devHoldingPct on matching candidate obs | 0 lpBurn decs, 0 devHold obs | 0                         | INELIGIBLE               | PROVIDER_RESPONSE_OMITTED_FIELD       |
| **H4: Dynamic Capacity Sizing**           | Capacity curve grid on point-in-time reserves                     | 0 valid reserve obs          | 0                         | INELIGIBLE               | NO_INDEPENDENT_POINT_IN_TIME_SNAPSHOT |

---

## 5. Milestone D.1 Readiness Conclusion

1. **Dataset Adequacy**: The disk telemetry directory currently contains zero recorded sessions. This is expected given that Windows PAPER trading has remained paused and prior tests ran in isolated sandbox environments.
2. **Defensible Action**:
   - Do **NOT** fabricate synthetic sessions or backtest results to simulate a profitable edge.
   - Deploy `TelemetryExecutionJoinEngine` and `ResearchEligibilityGate` with full regression test coverage on deterministic fixtures.
   - When new telemetry is gathered in future approved phases, this readiness audit will automatically evaluate live session eligibility against preregistered criteria.
