# NeXusTrade — Phase 12.94-D Milestone D.2 Research & Data-Acquisition Proposal (PLANNING ONLY)

## Empirical Telemetry Acquisition, Point-in-Time Causal Feature Extraction, Hypothesis Feasibility & Anti-Bias Statistical Validation

**Document Status:** PLANNING ONLY / RESEARCH DESIGN PROPOSAL  
**Operational Scope:** STRICTLY PLANNING — Zero implementation code, zero data-collection processes, zero PAPER trading daemon restarts, zero live network polling, zero wallet mutations, and zero Generation 2 activation until this proposal is independently reviewed and approved.  
**Review Reference:** Formally records Milestone D.1 Independent Acceptance (commit `86abf6f`) and specifies requirements for Milestone D.2.  
**Prerequisites Closed & Accepted:**

- Phase 12.93D (CLOSED)
- Phase 12.94-A (CLOSED under `7e58ea5`)
- Phase 12.94-B (CLOSED under `c37f91e`)
- Phase 12.94-C (CLOSED under `2541d5b` / `c5931ca` / `7faf705`)
- Phase 12.94-D.1 (FORMALLY ACCEPTED under `86abf6f`)

---

### Executive Confirmation & Permanent Archival Records

1. **Milestone D.1 Formal Acceptance Record**:
   - The Independent Auditor completed the final source review of correction commit `86abf6f` and issued formal acceptance in `NeXusTrade_Phase_12_94D1_Commit_86abf6f_Final_Independent_Acceptance.md`.
   - Both audit v3 findings were independently confirmed resolved:
     - **D1C3-01**: Future developer holdings observations rejected from decision-time H3 readiness; valid pre-decision observations admitted; stale observations rejected.
     - **D1C3-02**: Invalid quote expiration, missing quote evidence, expired fills, and incorrect quote/fill chronology fail closed. Observational decisions without trades remain supported.
   - Test suite status: **981/981 passing tests** across 5 test suites (27 isolated Node, 644 measurement/analysis including 41 quantitative research tests, 194 H2, 98 H3, 18 H4).
   - Raw verification log permanently preserved at `audit/verify-isolated-all.log` (394 lines, 35,569 bytes).

2. **Operational Invariant Attestations (Byte-for-Byte Immutable)**:
   - **Generation 1 Virtual Wallet**: `.tmp/virtual-wallet.json` balance is exactly `7.9259 SOL`. SHA-256 hash is `7F2C2353AC2F62CAC1BB98703742AB19C74AC5521635AF6F49BBE777AD020ED9`.
   - **Active Daemons**: Exactly 0 PAPER trading daemons running on Windows.
   - **Closed Subsystems**: Phase 12.93D, 12.94-A, 12.94-B, 12.94-C, and D.1 remain closed with zero modifications.
   - **Fedora Endurance Experiment**: 168-hour run remains untouched and isolated.
   - **Generation 2**: Uncreated, unactivated, and unauthorized. Tier 3 polling and real-SOL trading disabled.

3. **Prerequisite Mandate Formally Recorded — D2-PREREQ-01**:
   - **Title**: Source/Receipt Clock-Ordering & Timestamp Provenance Policy.
   - **Rule**: Every empirical observation feature must satisfy `responseReceivedMs >= sourceTimestampMs`, `sourceTimestampMs <= ingestionTimestampMs <= responseReceivedMs <= decisionTimestampMs`.
   - **Enforcement**: Any record with inverted clock ordering or anomalous drift must fail closed under `IMPOSSIBLE_TIMESTAMP_ORDERING` or `CLOCK_SKEW_QUARANTINE`. No empirical signal estimates may contribute to statistical rankings or PAPER trading decisions until this condition is met.

---

## 1. Data Feasibility Inventory & Honest Source Provenance

### 1.1 Current On-Disk Telemetry Inventory (Zero Fabrication)

In strict accordance with D.1 findings and the authoritative on-disk readiness audit (`audit/RESEARCH_INPUT_READINESS_REPORT.md`):

```
┌────────────────────────────────────────────────────────────────────────┐
│ Current Windows Telemetry Status: INSUFFICIENT_EVIDENCE                │
├────────────────────────────────────────────────────────────────────────┤
│ • Canonical Telemetry Directory (.tmp/telemetry/sessions):             │
│   - Total Sessions: 0                                                  │
│   - Total Candidate Decisions: 0                                       │
│   - Total Market Observations: 0                                       │
│   - Total Executable Quotes / Simulated Fills: 0                       │
│                                                                        │
│ • Legacy Sessions Directory (.tmp/sessions):                           │
│   - session-paper-12.93-pc-afternoon.json: 1 trade, ending 8.9559 SOL  │
│   - session-paper-12.93-pc-day4.json:      1 trade, ending 7.9259 SOL  │
│   - Data Available: Trade entry/exit timestamps, SOL size, realized PnL│
│   - Data Missing: Point-in-time AMM reserves, orderbook depth,        │
│                   pre-decision candidate scanner rejections, L/MC ratio│
└────────────────────────────────────────────────────────────────────────┘
```

**Conclusion on Windows Data**: The legacy sessions provide historical P&L context for Generation 1 wallet accounting, but **cannot** support statistical hypothesis evaluation for H1–H4 because pre-decision market depth and rejected candidate streams were not captured under Phase 12.93.

### 1.2 Fedora Endurance Run Data Recovery Protocol

The Fedora laptop host is currently executing a 168-hour continuous endurance run initiated under Phase 12.93 code starting at 10.0 SOL:

1. **Recovery Boundary**: The Fedora experiment must complete its scheduled runtime without interruption.
2. **Ingestion & Sanitization Workflow**:
   - When the run completes, copy log files and session summaries via secure copy (`scp`) into an isolated workspace directory: `.tmp/fedora_recovery/raw/`.
   - Run the automated schema and integrity validator: `audit-fedora-endurance-recovery.mjs`.
   - Distinguish legacy trade journals (`session-fedora-*.json`) from continuous daemon text logs (`out.log`, `err.log`).
3. **Data Feasibility from Fedora**:
   - _What is present_: Cumulative realized P&L, trade frequency, hold durations, gas/fee expenditures, and exit reason distribution over 7 continuous days.
   - _What is absent_: Point-in-time AMM base/quote reserves, 5-minute order flow snapshots, developer holding percentages, and rejected candidate decisions.
   - _Role in Research_: Provides empirical operational baseline for trade frequency and execution failure rates under live network conditions, but cannot be retroactively augmented with synthetic telemetry.

### 1.3 Field-by-Field Provenance & Availability Matrix

Every feature used in Phase 12.94-D research is classified under one of four mutually exclusive provenance classes:

- **`OBSERVED`**: Directly received from an external RPC, DEX API, or on-chain event stream with valid source timestamps.
- **`DERIVED`**: Mathematically computed from observed fields at decision time without lookahead (e.g., L/MC ratio).
- **`SYNTHETIC_REPLAY`**: Generated deterministically by the Phase 12.94-C execution engine from verified point-in-time reserves.
- **`UNAVAILABLE`**: Missing from historical payloads or failing pool verification; explicitly tagged with unavailability reason codes. Silent zero-imputation is strictly prohibited.

| Target Property     | Source Schema & Field                    | Provenance Class   | Source Provider | Timestamp Provenance  | Pool Verified?               | Causal at Decision Time?    | Anti-Imputation / Missingness Handling             |
| :------------------ | :--------------------------------------- | :----------------- | :-------------- | :-------------------- | :--------------------------- | :-------------------------- | :------------------------------------------------- |
| **Decision ID**     | `CandidateDecisionRecord.eventId`        | `OBSERVED`         | Scanner Event   | `decisionTimestampMs` | Yes (`poolId`)               | Yes                         | Primary key; rejection if null                     |
| **Session ID**      | `CandidateDecisionRecord.sessionId`      | `OBSERVED`         | Daemon Session  | `decisionTimestampMs` | N/A                          | Yes                         | Foreign key to session metadata                    |
| **Token Mint**      | `CandidateDecisionRecord.mintAddress`    | `OBSERVED`         | On-Chain Stream | `decisionTimestampMs` | Yes                          | Yes                         | SPL mint address; mandatory                        |
| **Tracked Pool**    | `CandidateDecisionRecord.poolId`         | `OBSERVED`         | On-Chain Stream | `decisionTimestampMs` | Yes                          | Yes                         | Primary AMM pair address                           |
| **Decision Cohort** | `CandidateDecisionRecord.decisionCohort` | `OBSERVED`         | Decision Engine | `decisionTimestampMs` | Yes                          | Yes                         | `FILTERED_REJECTED`, `WATCHLIST_RADAR`, etc.       |
| **Token Age (s)**   | `metricsSnapshot.tokenAgeSec`            | `DERIVED`          | Pair Open Time  | `decisionTimestampMs` | Yes                          | Yes                         | Null if open time unknown (`UNAVAILABLE`)          |
| **Liquidity USD**   | `metricsSnapshot.liquidityUsd`           | `OBSERVED`         | DexScreener/Ray | `sourceTimestampMs`   | Yes                          | Yes                         | Fail-closed if omitted; no zero-default            |
| **Market Cap USD**  | `metricsSnapshot.marketCapUsd`           | `OBSERVED`         | DexScreener/Ray | `sourceTimestampMs`   | Yes                          | Yes                         | Fail-closed if omitted; no zero-default            |
| **L/MC Ratio**      | `metricsSnapshot.lmcRatio`               | `DERIVED`          | Scanner Engine  | `decisionTimestampMs` | Yes                          | Yes                         | Null if either input is null                       |
| **LP Burn %**       | `metricsSnapshot.lpBurnPct`              | `OBSERVED`         | On-Chain / DAS  | `sourceTimestampMs`   | Yes                          | Yes                         | **Frequently null**; explicit reason code          |
| **Spot Price USD**  | `metricsSnapshot.spotPriceUsd`           | `OBSERVED`         | DexScreener/Ray | `sourceTimestampMs`   | Yes                          | Yes                         | Mandatory for return calculation                   |
| **5m Volume USD**   | `metricsSnapshot.volume5mUsd`            | `OBSERVED`         | DexScreener/Ray | `sourceTimestampMs`   | Yes                          | Yes                         | Null if omitted by provider                        |
| **5m Buys / Sells** | `metricsSnapshot.buys5m / sells5m`       | `OBSERVED`         | DexScreener/Ray | `sourceTimestampMs`   | Yes                          | Yes                         | Null if omitted; required for H2                   |
| **Base Reserve**    | `liquidityMetrics.baseReserve`           | `OBSERVED`         | AMM Pool State  | `sourceTimestampMs`   | Yes (`actualResponsePoolId`) | **No (Forward Label)**      | Verified via pool identity matcher                 |
| **Quote Reserve**   | `liquidityMetrics.quoteReserve`          | `OBSERVED`         | AMM Pool State  | `sourceTimestampMs`   | Yes (`actualResponsePoolId`) | **No (Forward Label)**      | Verified via pool identity matcher                 |
| **Dev Holding %**   | `holderMetrics?.devHoldingPct`           | `OBSERVED`         | DAS / RPC       | `sourceTimestampMs`   | Yes                          | **Subject to D2-PREREQ-01** | Requires `responseReceivedMs >= sourceTimestampMs` |
| **Top-10 Conc. %**  | `holderMetrics?.top10ConcentrationPct`   | `OBSERVED`         | DAS / RPC       | `sourceTimestampMs`   | Yes                          | **Subject to D2-PREREQ-01** | Null if DAS call omitted                           |
| **Execution Quote** | `ExecutableQuoteRecord.*`                | `SYNTHETIC_REPLAY` | 12.94-C Engine  | `quoteInitiatedMs`    | Yes                          | Yes                         | Generated only when reserves exist                 |
| **Simulated Fill**  | `SimulatedFillRecord.*`                  | `SYNTHETIC_REPLAY` | 12.94-C Engine  | `fillTimestampMs`     | Yes                          | **No (Forward Outcome)**    | Conservative constant-product fill                 |

---

## 2. Non-Fabricating Data Acquisition Protocol: Passive Shadow Telemetry Harvester

Because existing on-disk 12.94-B telemetry contains zero sessions, acquiring genuine empirical market telemetry without risking capital or restarting PAPER trading requires a dedicated, non-executing collection process.

```
┌────────────────────────────────────────────────────────────────────────┐
│                   PASSIVE SHADOW TELEMETRY HARVESTER                   │
│                                                                        │
│   Public Raydium / DexScreener Stream (Tier 2 REST Rate-Limited)       │
│                                  │                                     │
│                                  ▼                                     │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │ Candidate Decision Evaluator (Strictly In-Memory Observation)  │   │
│   │ - Evaluates scanner filters on new pairs                       │   │
│   │ - Emits CandidateDecisionRecord:                               │   │
│   │   • FILTERED_REJECTED (Failed liquidity, age, or L/MC checks)  │   │
│   │   • WATCHLIST_RADAR (Passed initial filters, tracking momentum)│   │
│   │   • TRIGGER_REJECTED (Evaluated at trigger criteria, rejected) │   │
│   │   • SHADOW_TRIGGER_ACCEPTED (Met buy criteria in shadow mode)  │   │
│   └────────────────────────────────────────────────────────────────┘   │
│                                  │                                     │
│         ┌────────────────────────┴────────────────────────┐            │
│         ▼                                                 ▼            │
│   ┌───────────────────────────────┐  ┌───────────────────────────────┐ │
│   │ Stratified Follow-Up Tracker  │  │ Contemporaneous Quote Engine  │ │
│   │ - 1m, 5m, 15m, 60m horizons   │  │ - Simulates 12.94-C quotes    │ │
│   │ - Verifies AMM pool identity  │  │ - Tags SYNTHETIC_REPLAY       │ │
│   │ - Emits MarketObservationRecord│  │ - Zero wallet balance change  │ │
│   └───────────────────────────────┘  └───────────────────────────────┘ │
│                                  │                                     │
│                                  ▼                                     │
│   Append-Only Finalized Session Logs (.tmp/telemetry/sessions/)        │
│   • meta.sessionStatus = "FINALIZED" upon controlled SIGINT/SIGTERM    │
│   • summary.isCompleteSession = true                                   │
└────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Core Operational Guardrails

1. **Zero Wallet Mutations (Read-Only Guarantee)**:
   - The harvester process has **no reference or file handle** to `.tmp/virtual-wallet.json`.
   - Virtual wallet cash balance remains strictly fixed at `7.9259 SOL`.
   - Zero on-chain transactions, zero Solana RPC keypair loading, and zero simulated balance deductions.
2. **Deterministic Session Lifecycle**:
   - Telemetry sessions adhere to the full Phase 12.94-B schema: `session-telemetry-<timestamp>.json`.
   - Clean shutdown handler captures SIGINT/SIGTERM, marks `meta.sessionStatus = "FINALIZED"`, verifies `summary.isCompleteSession = true`, writes record counts, and flushes to disk atomically.
3. **Contemporaneous Quote Generation**:
   - For decisions categorized as `SHADOW_TRIGGER_ACCEPTED`, the harvester invokes the Phase 12.94-C quote generator against verified point-in-time reserves.
   - Emits `ExecutableQuoteRecord` with `providerIdentity: "synthetic_amm_reserve"`, `priceTier: "TIER_2_POOL_RESERVE"`, and exact timestamps.
4. **Acquisition Sizing & Duration Target**:
   - Run duration: 7 to 14 continuous days to capture diverse market regimes (weekend low-liquidity vs weekday volatility).
   - Target sample sizes:
     - Minimum 1,000 screened candidates across all cohorts.
     - Minimum 100 `SHADOW_TRIGGER_ACCEPTED` decisions with complete 60-minute follow-up trajectories.
     - Minimum 200 `FILTERED_REJECTED` and `TRIGGER_REJECTED` counterfactual trajectories.

---

## 3. Hypothesis Feasibility Classification (H1–H4)

Each quantitative hypothesis is formulated with falsifiable rejection criteria, explicit data requirements, sample size minimums, and evaluation horizons:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    HYPOTHESIS FEASIBILITY CLASSIFICATION                    │
├─────────────────────────────────────────────────────────────────────────────┤
│ H1: Liquidity Depth & Price Impact       │ Requires Pre-Decision AMM Reserves│
│ H2: Order Flow Momentum (5m Net Inflow)  │ Requires Co-occurring Buys/Sells │
│ H3: Structural Safety & Dev Holding      │ Requires D2-PREREQ-01 DAS Audits  │
│ H4: Dynamic Capacity Sizing              │ Requires Calibrated Capacity Grid │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Hypothesis H1 — Liquidity Depth & Constant-Product Price Impact

- **Hypothesis Formulation ($H_1$)**:
  In automated constant-product AMM pools ($x \cdot y = k$), trade sizes $S$ exceeding $1.0\%$ of available quote reserves ($S / R_{\text{quote}} > 0.01$) incur non-linear execution slippage and price impact that degrade net realized returns by more than the gross alpha signal, rendering fixed-size strategies unprofitable.
- **Mathematical Oracle**:
  $$\text{Price Impact } I(S) = \frac{S}{R_{\text{quote}} + S}, \quad R_{\text{net}} = R_{\text{gross}} - I(S_{\text{buy}}) - I(S_{\text{sell}}) - 2 \cdot \text{fee}_{\text{LP}} - \text{drag}_{\text{gas}}$$
- **Required Data Fields**:
  - Point-in-time `quoteReserve` and `baseReserve` observed at $t_{\text{source}} \le t_{\text{decision}}$.
  - Contemporaneous quote and simulated fill from 12.94-C engine.
  - Forward spot price at 5m, 15m, 60m.
- **Feasibility Classification**:
  - `OBSERVATIONAL_ONLY`: Ineligible (cannot compute impact without reserves).
  - `SYNTHETIC_REPLAY`: Feasible once the Passive Harvester captures verified reserve snapshots.
- **Statistical Test**:
  - Regress realized slippage on $S / R_{\text{quote}}$.
  - Spearman rank correlation between theoretical price impact and realized return drag.
  - Sample minimum: $N \ge 80$ decisions with verified reserves.

### 3.2 Hypothesis H2 — Order Flow Momentum & Net Inflow Velocity

- **Hypothesis Formulation ($H_2$)**:
  Candidate tokens exhibiting 5-minute net order flow momentum ($NBR_{5m} = \frac{\text{buys5m} - \text{sells5m}}{\text{buys5m} + \text{sells5m}} > +0.30$) combined with volume acceleration produce statistically significant positive excess returns over a 15-minute post-decision horizon compared to tokens with neutral or negative flow.
- **Mathematical Oracle**:
  $$\text{Information Coefficient: } IC = \text{Corr}\left(NBR_{5m}, \frac{P_{15m} - P_{\text{decision}}}{P_{\text{decision}}}\right)$$
- **Required Data Fields**:
  - `buys5m`, `sells5m`, `volume5mUsd`, `txCount5m` co-occurring at $t_{\text{decision}}$.
  - Forward spot prices at 1m, 5m, 15m from verified pool observations.
- **Feasibility Classification**:
  - Feasible in both `OBSERVATIONAL_ONLY` and `SYNTHETIC_REPLAY` modes, provided provider payloads supply transaction breakdown.
- **Statistical Test**:
  - Welch's two-sample t-test comparing top quintile ($NBR_{5m} > +0.50$) vs bottom quintile ($NBR_{5m} < -0.10$).
  - Cluster-robust standard errors clustered by session and token mint.
  - Sample minimum: $N \ge 150$ decisions with complete 5m metrics.

### 3.3 Hypothesis H3 — Structural Safety & Insider/Developer Concentration

- **Hypothesis Formulation ($H_3$)**:
  Tokens where the deployer/developer retains $> 15.0\%$ of circulating supply or LP burn percentage is $< 90.0\%$ exhibit a catastrophic drawdown probability ($P(\text{Drawdown}_{60m} > 50\%)$) exceeding $40\%$, generating negative expected value regardless of early order-flow momentum.
- **Mathematical Oracle**:
  $$\text{Tail Risk Odds Ratio: } \text{OR} = \frac{\text{Odds}(\text{Rug} \mid \text{DevHolding} > 15\%)}{\text{Odds}(\text{Rug} \mid \text{DevHolding} \le 15\%)}, \quad \text{where Rug} \equiv \Delta P_{60m} < -50\%$$
- **Required Data Fields**:
  - `lpBurnPct` from decision-time snapshot.
  - `devHoldingPct` from DAS/RPC holder snapshot.
  - **D2-PREREQ-01 Compliance**: Must satisfy `responseReceivedMs >= sourceTimestampMs`, age $\le 180$s, lag $\le 120$s.
  - 60-minute forward price trajectory.
- **Feasibility Classification**:
  - Feasible subject to D2-PREREQ-01 feature-eligibility gating.
- **Statistical Test**:
  - Logistic regression of catastrophic drawdown indicator on developer holding and LP burn percentage.
  - Fisher's exact test on contingency table.
  - Sample minimum: $N \ge 100$ decisions with valid pre-decision holder metrics.

### 3.4 Hypothesis H4 — Dynamic Capacity Sizing & Slippage-Constrained Allocation

- **Hypothesis Formulation ($H_4$)**:
  A dynamic position-sizing policy $S^* = \min(S_{\text{max}}, \alpha \cdot R_{\text{quote}} \cdot \text{tolerance})$ that constrains marginal slippage to $\le 1.5\%$ achieves a higher Sharpe ratio and lower maximum drawdown than a naive fixed-size allocation ($0.10$ SOL per trade).
- **Mathematical Oracle**:
  $$S^* = \arg\max_{S} \left\{ S \cdot \left(\mathbb{E}[R_{\text{gross}}] - \frac{S}{R_{\text{quote}} + S} - 2 \cdot \text{fee}_{\text{LP}}\right) \right\} \quad \text{s.t. } \frac{S}{R_{\text{quote}} + S} \le \theta_{\text{max}}$$
- **Required Data Fields**:
  - `CapacityCurveAnalyzer` grid evaluations over observed reserve states.
  - Empirical gross return distribution derived from H1/H2 cohorts.
- **Feasibility Classification**:
  - Feasible in `SYNTHETIC_REPLAY` mode across verified reserve snapshots.
- **Statistical Test**:
  - Paired Wilcoxon signed-rank test comparing simulated equity curves under dynamic sizing vs fixed sizing.
  - Deflated Sharpe Ratio (DSR) comparison accounting for trial selection.
  - Sample minimum: $N \ge 80$ decisions with verified reserve capacity.

---

## 4. D2-PREREQ-01 Specification & Execution Realism Guardrails

### 4.1 Formal Specification of D2-PREREQ-01

To permanently close the timestamp provenance vulnerability identified in Independent Acceptance Review of commit `86abf6f`, Milestone D.2 establishes the following mandatory ordering invariants:

```
                    CAUSAL MONOTONICITY TIMELINE

    t_source  ───────►  t_ingestion  ───────►  t_received  ───────►  t_decision
 (External event)     (Scanner wire)       (Client socket)     (Strategy rule)

 Invariant:  t_source <= t_ingestion <= t_received <= t_decision
 Violation:  If t_received < t_source  ==> CLOCK_SKEW_QUARANTINE (Fail Closed)
```

1. **Ordering Invariants**:
   - `responseReceivedMs >= sourceTimestampMs`: A response cannot be received before the external provider generated the event.
   - `sourceTimestampMs <= ingestionTimestampMs`: Provider generation precedes local network packet capture.
   - `ingestionTimestampMs <= responseReceivedMs`: Local packet capture precedes complete payload deserialization.
   - `responseReceivedMs <= decisionTimestampMs`: Complete feature availability must precede the candidate decision timestamp.
2. **Quarantine & Fail-Closed Behavior**:
   - Any observation violating the above monotonicity conditions must be tagged with:
     ```typescript
     unavailabilityReason: "IMPOSSIBLE_TIMESTAMP_ORDERING",
     quarantineStatus: "CLOCK_SKEW_QUARANTINE"
     ```
   - Quarantined observations are completely excluded from H3 holder metric joins.
   - Quarantined decisions cannot contribute to strategy performance ranking or enter any future PAPER evaluation cohort.

### 4.2 Standalone AMM Execution Realism Guardrails

In compliance with Phase 12.94-C accepted findings:

1. **Finite Timestamp Validation**:
   - `quoteInitiatedMs`, `quoteReceivedMs`, and `validUntilMs` must be positive, finite numbers.
   - Quotes with `validUntilMs = NaN` or `Infinity` are rejected under `INVALID_OR_NONFINITE_QUOTE_TIMESTAMPS`.
   - Quote validity TTL is bounded: $0 < (\text{validUntilMs} - \text{quoteReceivedMs}) \le 30{,}000\text{ ms}$.
2. **Chronological Quote/Fill Integrity**:
   - `fillTimestampMs >= quoteReceivedMs`: Fills cannot precede quote receipt.
   - `fillTimestampMs <= validUntilMs`: Fills executed after quote expiry are rejected under `FILL_AGAINST_EXPIRED_QUOTE`.
   - Fills without a matching quote ID fail closed under `ORPHAN_FILL_WITHOUT_QUOTE`.
3. **Atomic Conservation & Fee Accounting**:
   - Constant-product invariant $(x_0 + \Delta x)(y_0 - \Delta y) \ge x_0 y_0$ must hold exactly.
   - LP fee (e.g. 25 bps) is applied inside AMM curve pricing on the gross input amount:
     $$\Delta x_{\text{effective}} = \Delta x \cdot (1 - \phi_{\text{LP}})$$
   - LP fees are never separately deducted from wallet cash.
   - Zero-consideration BUY fills and subatomic quotes ($\Delta x < 1$ or $\Delta y < 1$) are rejected.
4. **Provider Identity Tagging**:
   - Quotes generated via the synthetic AMM execution engine must strictly carry `providerIdentity: "synthetic_amm_reserve"` and `priceTier: "TIER_2_POOL_RESERVE"`.
   - Live network polling (Tier 3) remains unauthorized during Milestone D.2.

---

## 5. Statistical Methodology & Selection Bias Mitigation

Evaluating trading strategies solely on historical traded tokens introduces extreme **conditioning on the decision** (selection bias), because the strategy filtered out hundreds of potentially informative market outcomes.

```
┌────────────────────────────────────────────────────────────────────────┐
│                      SELECTION BIAS DE-BIASING                         │
├────────────────────────────────────────────────────────────────────────┤
│ 1. Complete Candidate Universe Tracking:                               │
│    - Track forward returns for both ACCEPTED and REJECTED candidates   │
│ 2. Inverse Propensity Weighting (IPW):                                 │
│    - Estimate selection propensity e(X) = P(Traded | Features X)       │
│    - Weight observations by w_i = T_i / e(X_i) + (1 - T_i) / (1 - e(X))│
│ 3. Missing Counterfactual Accounting:                                  │
│    - Treat rug-pulled / untradeable tokens as -100% loss               │
│ 4. Multiple Comparison Control:                                        │
│    - Control FWER (Bonferroni) and FDR (Benjamini-Hochberg q* = 0.05)  │
│ 5. Cluster-Robust Variance Estimation:                                 │
│    - Cluster standard errors by (SessionId, MintAddress)               │
└────────────────────────────────────────────────────────────────────────┘
```

### 5.1 Inverse Propensity Score Weighting (IPW)

1. **Selection Propensity Model**:
   Fit a logistic regression model predicting candidate acceptance:
   $$e(X_i) = P(T_i = 1 \mid X_i) = \frac{1}{1 + e^{-\beta^T X_i}}$$
   where $X_i$ includes pre-decision features: `tokenAgeSec`, `liquidityUsd`, `marketCapUsd`, `lmcRatio`, `volume5mUsd`.
2. **Propensity Weighting**:
   To estimate the unbiased counterfactual performance of strategy rules across the entire market distribution:
   $$w_i = \frac{T_i}{\hat{e}(X_i)} + \frac{1 - T_i}{1 - \hat{e}(X_i)}$$
   Trimming is enforced: $w_i \in [0.05, 20.0]$ to prevent high-variance instability from extreme outliers.

### 5.2 Censoring & Survivorship Accounting

- Tokens that experience liquidity removal (LP pull), contract freeze, or trading halt are explicitly labeled as **`IMPAIRED_CATASTROPHIC_COLLAPSE`**.
- Counterfactual returns for impaired tokens are clamped to $-100.0\%$ (total loss), rather than dropped from the dataset.
- Dropping untradeable tokens from performance analysis constitutes survivorship bias and is strictly forbidden.

### 5.3 Multiple Hypothesis Testing Corrections

When testing multiple parameters across H1–H4 (e.g., various momentum thresholds or liquidity cutoffs):

1. **Family-Wise Error Rate (FWER)**:
   For primary confirmation tests, apply Bonferroni adjustment:
   $$\alpha_{\text{adjusted}} = \frac{\alpha_{\text{family}}}{M}$$
   where $M$ is the number of tested variations in the parameter family.
2. **False Discovery Rate (FDR)**:
   For exploratory screening across feature grids, apply Benjamini-Hochberg (BH) procedure at false discovery threshold $q^* = 0.05$:
   $$P_{(k)} \le \frac{k}{M} \cdot q^*$$
3. **Deflated Sharpe Ratio (DSR)**:
   Any strategy Sharpe ratio must be deflated using Bailey & López de Prado's DSR formulation:
   $$\text{DSR} = \Phi\left( \frac{(\widehat{SR} - SR_0) \sqrt{T - 1}}{\sqrt{1 - \hat{\gamma}_3 \widehat{SR} + \frac{\hat{\gamma}_4 - 1}{4} \widehat{SR}^2}} \right)$$
   where $SR_0$ is the expected maximum Sharpe ratio under the null hypothesis given $N_{\text{trials}}$ independent trials.

### 5.4 Cluster-Robust Variance Estimation

Returns from tokens evaluated in the same trading session or sharing the same base pool exhibit significant cross-sectional and temporal correlation. All standard errors and t-statistics must be computed using two-way cluster-robust covariance matrices (clustered by `sessionId` and `mintAddress`):

$$\mathbb{V}_{\text{cluster}} = (X^T X)^{-1} \left( \sum_{c \in \text{Clusters}} X_c^T u_c u_c^T X_c \right) (X^T X)^{-1}$$

---

## 6. Chronological Out-of-Sample (OOS) Protocol

To prevent lookahead leakage, data snooping, and regime over-fitting, Milestone D.2 mandates a strict chronological partitioning architecture:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   CHRONOLOGICAL PARTITION TIMELINE                     │
│                                                                        │
│   ◄────────────────────── Historical Telemetry ──────────────────────► │
│                                                                        │
│   ┌───────────────────────┬──────────────────┬───────────────────────┐ │
│   │   TRAIN / CALIBRATION │  VALIDATION SET  │     TEST HOLDOUT      │ │
│   │          60%          │       20%        │          20%          │ │
│   │  (Hypothesis Fitting) │  (Tuning / Cut)  │ (Final Confirmation)  │ │
│   └───────────────────────┴──────────────────┴───────────────────────┘ │
│                           ▲                  ▲                         │
│                    2-Hour Embargo      2-Hour Embargo                  │
└────────────────────────────────────────────────────────────────────────┘
```

1. **Strict Temporal Partitioning**:
   - **Set 1: In-Sample Calibration (60% chronological)**: Used for parameter calibration, regression fitting, and preliminary hypothesis exploration.
   - **Set 2: Out-of-Sample Validation (20% chronological)**: Used for selecting optimal decision thresholds and verifying out-of-sample stability.
   - **Set 3: Out-of-Sample Holdout (20% chronological)**: Sealed holdout dataset evaluated **exactly once** at research closure to confirm out-of-sample alpha.
2. **Prohibition of Random Splitting**:
   - Random $K$-fold cross-validation or data shuffling is strictly prohibited. Financial time series exhibit volatility clustering and regime shifts; random splitting causes future information to leak into past folds.
3. **Embargo Windows**:
   - A 2-hour temporal embargo is placed between the end of Set 1 and start of Set 2, and between Set 2 and Set 3.
   - Eliminates auto-correlated carryover from multi-hour liquidity dynamics.

---

## 7. Milestone D.2 Deliverables, Roadmap & Acceptance Criteria

### 7.1 Deliverable Roadmap (Planning Phase)

| Deliverable ID | Component Description                  | Core Responsibilities                                                                                                                |
| :------------- | :------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------- |
| **D.2.1**      | **Passive Harvester Specification**    | Complete architectural and interface specification for shadow observation daemon. Zero wallet interaction, strict schema compliance. |
| **D.2.2**      | **Causal Feature Pipeline Design**     | Feature extraction interfaces with D2-PREREQ-01 timestamp monotonicity guards and anti-imputation provenance types.                  |
| **D.2.3**      | **Hypothesis Testing Specification**   | Pre-registered statistical tests for H1, H2, H3, H4, including mathematical formulas, test statistics, and power curves.             |
| **D.2.4**      | **Selection Bias & OOS Engine Design** | Algorithmic design of IPW weighting, cluster-robust standard errors, DSR calculations, and chronological partitioning.               |
| **D.2.5**      | **Independent Verification Fixtures**  | Deterministic regression fixture suite with known mathematical ground truth for IPW, DSR, and cluster-robust estimators.             |

### 7.2 Independent Audit Verification Criteria for Milestone D.2

Before any D.2 research findings or software modules can be accepted:

1. **D2-PREREQ-01 Verification**:
   - Deterministic test cases verifying that `responseReceivedMs < sourceTimestampMs` fails closed under `IMPOSSIBLE_TIMESTAMP_ORDERING`.
   - Clock-skew quarantine correctly isolates corrupted observations without crashing the engine.
2. **Execution Realism Integrity**:
   - Rejection of non-finite quote TTLs (`validUntilMs = NaN`).
   - Rejection of orphan fills and inverted quote/fill timestamps.
   - LP fees applied strictly inside the AMM pricing curve.
3. **Statistical Soundness**:
   - Hand-calculated and reference-verified IPW weighting oracle tests.
   - Bailey-López de Prado DSR implementation matches published mathematical reference values.
   - Cluster-robust covariance matches standard econometrics reference output.
4. **Zero Wallet Mutation Attestation**:
   - Virtual wallet `.tmp/virtual-wallet.json` remains untouched (`7.9259 SOL`, SHA-256 `7F2C2353AC2F62CAC1BB98703742AB19C74AC5521635AF6F49BBE777AD020ED9`).
   - Exactly zero trading daemons running.

---

### Formal Status Declaration

> [!IMPORTANT]
> **PLANNING ONLY NOTICE**: This document represents a formal research and data-acquisition proposal for Phase 12.94-D Milestone D.2. **No code implementation, daemon execution, network data collection, or wallet operations are authorized or initiated.** Milestone D.2 implementation remains strictly blocked pending independent auditor review and explicit operator authorization.
