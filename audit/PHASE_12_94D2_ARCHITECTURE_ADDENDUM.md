# NeXusTrade — Phase 12.94-D.2 Architecture Addendum v1 (PLANNING ONLY)

## Bounded Design Addendum Addressing Independent Architecture Audit v1 Findings D2-A01 through D2-A07

**Document Status:** PLANNING ONLY / ARCHITECTURE ADDENDUM  
**Operational Scope:** STRICTLY PLANNING — Zero implementation code, zero data-collection processes, zero PAPER trading daemon restarts, zero live network polling, zero wallet mutations, and zero Generation 2 activation until this addendum is independently reviewed and approved.  
**Review Reference:** Responding directly to Independent Architecture Audit v1 (`NeXusTrade_Phase_12_94D2_Commit_5306779_Independent_Architecture_Audit_v1.md`).  
**Prerequisites Closed & Accepted:**

- Phase 12.93D (CLOSED)
- Phase 12.94-A (CLOSED under `7e58ea5`)
- Phase 12.94-B (CLOSED under `c37f91e`)
- Phase 12.94-C (CLOSED under `2541d5b` / `c5931ca` / `7faf705`)
- Phase 12.94-D.1 (FORMALLY ACCEPTED under `86abf6f`)

---

## 1. Audit v1 Response Matrix (Findings D2-A01 through D2-A07)

| Audit Finding                                          | Core Issue Identified                                                                                                                                                                            | Bounded Architecture Revision                                                                                                                                                                                                                                                                                                                                               | Addendum Section |
| :----------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------- |
| **D2-A01 (Verified Source Inventory)**                 | Fedora run state and field completeness were asserted without inspection; Windows legacy session fields unitemized.                                                                              | Classified Fedora status as `REPORTED_NOT_INSPECTED` (unverified). Created comprehensive source-by-source inventory with exact paths, host origins, evidence classes, permissible read-only extraction methods, and zero-mutation recovery boundaries.                                                                                                                      | **Section 2**    |
| **D2-A02 (Shadow-Event & Session Compatibility)**      | `SHADOW_TRIGGER_ACCEPTED` broke closed 12.94-B enum contracts; single-file session naming violated D.1 directory schema; signal handler auto-finalization risked corrupting un-drained sessions. | Maintained 12.94-B contracts byte-for-byte; shadow signals represented via backward-compatible sidecar stream (`shadow-evaluations.jsonl`) or within existing `WATCHLIST_RADAR` cohort; mandated exact D.1 directory layout; established strict completeness-based finalization requiring drain of all pending horizons.                                                    | **Section 3**    |
| **D2-A03 (Data-Provider Feasibility)**                 | DexScreener REST snapshots assumed to contain true AMM reserves, LP burns, and dev holdings; Tier 2 conflated with REST; simulated fills called observed.                                        | Built detailed Provider Capability Matrix per endpoint, rate limit, and pool family. Classified H1/H4 as `NOT_EVALUABLE` until verified on-chain reserves exist; H3 as `NOT_EVALUABLE` until DAS holder metrics exist. Strictly segregated Tier 1 (spot marks), Tier 2 (synthetic quotes), Tier 4 (simulated fills), and Tier 3 (deferred/unauthorized).                    | **Section 4**    |
| **D2-A04 (Selection Bias & Weighting)**                | IPW formula used treatment propensity instead of persisted 12.94-B sampling probabilities; untraded rejected tokens assigned "-100% realized portfolio losses".                                  | Decoupled 4 processes: screening, admission, observation sampling, and outcome censoring. Defined Horvitz-Thompson / Hájek estimators using actual persisted inclusion probabilities ($\pi_i$). Strictly segregated realized cash P&L (traded tokens only) from marked-to-model impairment write-downs (held inventory) and counterfactual benchmarks (rejected tokens).    | **Section 5**    |
| **D2-A05 (Execution Financial Math)**                  | Linear impact approximation double-counted LP fees; simulated fills called realized slippage; H4 optimization lacked constraints; Wilcoxon test on dependent cumulative equity points invalid.   | Specified authoritative Phase 12.94-C stateful AMM execution engine with single internal LP fee deduction, signed network fees, and ATA rent. Decoupled theoretical, model-net, and live returns. Reformulated H4 optimization over capacity grid; restricted hypothesis tests to independent opportunities or non-overlapping portfolio increments.                        | **Section 6**    |
| **D2-A06 (Statistical Methodology & Sample Adequacy)** | Sample targets conflicted across hypotheses; 2h embargo insufficient; two-way cluster equation was single-sum; few sessions invalidate asymptotic clustering.                                    | Defined true analysis units (candidate decisions vs daily portfolio return series); specified label-length purging + embargo buffer; aligned sample size power calculations ($N \ge 80$ to $200$); implemented true Cameron-Gelbach-Miller two-way clustering ($V_{\text{session}} + V_{\text{mint}} - V_{\text{session} \cap \text{mint}}$) with small-cluster safeguards. | **Section 7**    |
| **D2-A07 (Clock Provenance & Authorization Gates)**    | Provider vs host clock domains assumed identical; `CLOCK_SKEW_QUARANTINE` broke D.1 enums; specification deliverables blurred into harvester deployment.                                         | Defined separate clock domains (Provider UTC vs Local Monotonic), RTT latency budgeting, and maximum allowed skew ($\pm 5{,}000$ ms). Preserved D.1 schema compatibility via existing quarantine annotations. Structured Milestone D.2 into 4 strictly gated, reviewable sub-milestones.                                                                                    | **Section 8**    |

---

## 2. Verified Source Inventory & Provenance Manifest (Finding D2-A01)

### 2.1 Authoritative Source-by-Source Inventory

Every historical data artifact is classified under strict empirical verification criteria:

- **`CONFIRMED_ON_DISK`**: Physically inspected, schema verified, and checksummed on the local Windows filesystem.
- **`REPORTED_NOT_INSPECTED`**: Reported by external host/process, but **unverified**; no assumptions made regarding execution state or field completeness.
- **`UNAVAILABLE`**: Known to be missing or omitted from historical payloads.
- **`NOT_YET_COLLECTED`**: Requires future authorized data-collection processes.

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   AUTHORITATIVE DATA SOURCE MANIFEST                                        │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. Windows Telemetry (Canonical D.1 Path: .tmp/telemetry/sessions/)                                         │
│    • Status: CONFIRMED_ON_DISK (Zero Sessions, INSUFFICIENT_EVIDENCE)                                       │
│    • Total Valid Decisions: 0 | Total Market Observations: 0 | Total Quotes/Fills: 0                        │
│                                                                                                             │
│ 2. Windows Legacy Sessions (.tmp/sessions/)                                                                 │
│    • Status: CONFIRMED_ON_DISK (2 Sessions, Pre-Telemetry Format)                                           │
│    • session-paper-12.93-pc-afternoon.json (SHA-256: 6b36a...): 1 trade, ending 8.9559 SOL                  │
│    • session-paper-12.93-pc-day4.json      (SHA-256: 7f2c2...): 1 trade, ending 7.9259 SOL                  │
│    • Available: Entry/exit timestamp, SOL size, net PnL, exit reason                                        │
│    • Unavailable: AMM reserves, orderbook depth, candidate filter rejections, L/MC ratios                    │
│                                                                                                             │
│ 3. Fedora Endurance Run (Remote Host: fedora_laptop)                                                        │
│    • Status: REPORTED_NOT_INSPECTED (Operational State & Content Strictly Unverified)                       │
│    • Assumed Horizon: Initiated at 10.0 SOL under pre-12.94-B codebase                                      │
│    • Read-Only Recovery Protocol: Non-invasive, post-run scp to isolated staging directory                  │
│    • Prohibitions: Zero remote process termination, zero live polling, zero SSH mutation                    │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Field-Level Extraction Table for Confirmed Windows Legacy Sessions

| Session File Name                       | Timestamp Span (UTC)     | Executed Trades | Recorded Fields                                                              | Missing Quantitative Features                                                                          | Usability for H1–H4                                    |
| :-------------------------------------- | :----------------------- | :-------------- | :--------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------- | :----------------------------------------------------- |
| `session-paper-12.93-pc-afternoon.json` | 2026-10-12 18:22 – 18:45 | 1 (BUY/SELL)    | `tokenMint`, `entryPrice`, `exitPrice`, `solSize`, `netPnlSol`, `exitReason` | `baseReserve`, `quoteReserve`, `buys5m`, `sells5m`, `devHoldingPct`, `lpBurnPct`, `rejectedCandidates` | **`INELIGIBLE`** (Wallet P&L historical baseline only) |
| `session-paper-12.93-pc-day4.json`      | 2026-10-13 14:10 – 14:38 | 1 (BUY/SELL)    | `tokenMint`, `entryPrice`, `exitPrice`, `solSize`, `netPnlSol`, `exitReason` | `baseReserve`, `quoteReserve`, `buys5m`, `sells5m`, `devHoldingPct`, `lpBurnPct`, `rejectedCandidates` | **`INELIGIBLE`** (Wallet P&L historical baseline only) |

### 2.3 Safe, Read-Only Fedora Recovery Protocol (Specification Only)

1. **Non-Interference Guarantee**: The Fedora experiment must run to its natural completion or manual operator stop on that machine. Antigravity will make no network connections, SSH attempts, or process signals to the Fedora laptop during Milestone D.2 planning.
2. **Post-Completion Transfer**: If and when authorized by the operator, files will be copied via read-only `scp` to an isolated workspace folder: `.tmp/fedora_recovery/raw/`.
3. **Integrity & Verification**: Upon arrival, compute SHA-256 hashes for all files before any parsing script touches them.
4. **Independent Schema Inspection**: Execute an isolated read-only audit script (`audit-fedora-evidence.mjs`) to classify available fields into `OBSERVED`, `DERIVED`, or `UNAVAILABLE`.

---

## 3. Versioned Shadow-Event & Session-Finalization Contracts (Finding D2-A02)

### 3.1 Preservation of Closed Phase 12.94-B Contracts

The proposal's proposed `SHADOW_TRIGGER_ACCEPTED` is **retracted**. Phase 12.94-B schemas are closed and will not be modified:

```typescript
// TelemetryTypes.ts (UNCHANGED, FROZEN)
export type DecisionCohort =
  | "FILTERED_REJECTED"
  | "WATCHLIST_RADAR"
  | "TRIGGER_REJECTED"
  | "EXECUTED_BUY";
```

### 3.2 Nonbreaking Shadow Evaluation Representation

To track candidates that would have triggered a buy in shadow mode without corrupting existing enums, Milestone D.2 introduces a **backward-compatible sidecar research stream**:

```
.tmp/telemetry/sessions/<sessionId>/
├── session-meta.json                 (Authoritative session metadata & status)
├── session-summary.json              (Reconciled record counts & completeness)
├── candidate-decisions.jsonl         (Canonical 12.94-B records: WATCHLIST_RADAR, etc.)
├── market-observations.jsonl         (Stratified 1m, 5m, 15m, 60m follow-ups)
├── sampling-trajectories.jsonl       (Persisted inclusion probabilities & stratum)
├── execution-quotes.jsonl            (12.94-C quotes: provider: synthetic_amm_reserve)
├── simulated-fills.jsonl             (12.94-C simulated fills: Tier 4 modeled)
├── shadow-evaluations.jsonl          (SIDECAR: Research shadow evaluations)
└── quarantined-records.jsonl         (Malformed or clock-skewed records)
```

**Sidecar Research Schema (`shadow-evaluations.jsonl`)**:

```typescript
export interface ShadowEvaluationRecord {
  readonly schemaVersion: "1.0.0";
  readonly eventId: string; // Foreign key -> CandidateDecisionRecord.eventId
  readonly sessionId: string; // Foreign key -> SessionId
  readonly mintAddress: string;
  readonly evaluationTimestampMs: number; // Host monotonic timestamp
  readonly shadowTriggerQualified: boolean; // true if rule criteria met, false otherwise
  readonly qualificationReason: string; // e.g., "MET_MOMENTUM_AND_SAFETY_CRITERIA"
  readonly simulatedTargetSizeSol: number; // e.g., 0.10 SOL
  readonly executionFeasible: boolean; // true if reserves existed to quote
}
```

_D.1 Compatibility Guarantee_: The primary `candidate-decisions.jsonl` logs the candidate under `WATCHLIST_RADAR` (if tracked) or `TRIGGER_REJECTED` (if rejected by standard execution gates). The D.1 `TelemetryExecutionJoinEngine` reads canonical files without syntax or enum errors.

### 3.3 Authoritative Session Finalization & Drain Protocol

A session is **never** marked `FINALIZED` merely because a process signal (SIGINT/SIGTERM) was received. Finalization requires affirmative reconciliation:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   DETERMINISTIC SESSION LIFECYCLE                      │
├────────────────────────────────────────────────────────────────────────┤
│ 1. ACTIVE: Session logging candidate decisions & scheduled follow-ups  │
│                                                                        │
│ 2. SHUTDOWN INITIATED (SIGINT/SIGTERM):                                │
│    • Cease ingesting new candidate decisions                           │
│    • Enter DRAIN_PHASE: wait for pending forward observations          │
│      (up to maximum scheduled horizon, e.g. 60 minutes)                │
│                                                                        │
│ 3. RECONCILIATION & DURABLE FLUSH:                                     │
│    • Flush all JSONL buffers to disk with fsync()                      │
│    • Count exact lines in all JSONL files                              │
│    • Compare counts against in-memory dispatch counters                │
│                                                                        │
│ 4. FINAL STATE EVALUATION:                                             │
│    • If all scheduled trajectories completed & counts match:           │
│      ==> meta.sessionStatus = "FINALIZED"                              │
│      ==> summary.isCompleteSession = true                              │
│    • If drain timed out, interrupted, or counts mismatch:              │
│      ==> meta.sessionStatus = "INTERRUPTED_DRAIN_INCOMPLETE"           │
│      ==> summary.isCompleteSession = false                             │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Corrected Provider Capability & Data Feasibility Matrix (Finding D2-A03)

### 4.1 Real-World Data Provider Capabilities

| Provider & Protocol                | Target Endpoints                                                    | Rate Limits & Budgets           | Pool Family Supported                | Actual Returned Fields                                                                         | Unavailable / Omitted Fields                                                                        | Claim Tier Authorized                                     |
| :--------------------------------- | :------------------------------------------------------------------ | :------------------------------ | :----------------------------------- | :--------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------- | :-------------------------------------------------------- |
| **DexScreener REST API**           | `/latest/dex/pairs/solana/{poolId}`<br/>`/latest/dex/tokens/{mint}` | 300 req/min (IP-wide)           | Raydium v4, Orca Whirlpools, PumpFun | `priceUsd`, `priceNative`, `liquidity.usd`, `volume.m5`, `txns.m5.buys/sells`, `pairCreatedAt` | **Base/quote token reserves ($x, y$) omitted**; LP burn status omitted; holder distribution omitted | **Tier 1 Only** (Informational spot marks & 5m volume)    |
| **Raydium API v3**                 | `https://api-v3.raydium.io/pools/info/ids`                          | 120 req/min (Strict cloudflare) | Standard AMM v4, CPMM                | `price`, `tvl`, `mintAmountA`, `mintAmountB` (UI amounts)                                      | Raw on-chain integer reserves; slot numbers; holder distribution                                    | **Tier 1 Only** (Secondary liquidity mark)                |
| **Solana RPC (GetAccountInfo)**    | `getAccountInfo(poolId)` (Base64/JSONParsed)                        | 10–40 req/s (Public RPC)        | Raydium AMM v4                       | Raw reserve vault token balances (`amount` in base lamports/subunits), slot number             | Transaction history, 5m volume, token metadata                                                      | **Tier 2 Prerequisite** (Verified point-in-time reserves) |
| **Solana DAS (Helius/Triton)**     | `getAsset`, `getAssetsByOwner`                                      | Account rate budget             | SPL Token Standard                   | `compression`, `ownership.owner`, `token_info`                                                 | Real-time liquidity, reserve balances                                                               | **Tier 1 Structural** (Verified dev holding snapshot)     |
| **Phase 12.94-C Execution Engine** | Local In-Memory `AmmReserveEngine`                                  | Infinite (Local computation)    | Constant-Product ($x \cdot y = k$)   | Deterministic `ExecutableQuoteRecord`, `SimulatedFillRecord`                                   | Real live liquidity (purely synthetic model)                                                        | **Tier 2 (Quote) & Tier 4 (Simulated Fill)**              |

### 4.2 Research Feasibility Classification for Hypotheses H1–H4

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    HYPOTHESIS FEASIBILITY CLASSIFICATION                    │
├─────────────────────────────────────────────────────────────────────────────┤
│ • H1 (Liquidity Depth & AMM Impact):    NOT_EVALUABLE (on REST alone)       │
│   ==> Requires verified RPC reserve vault balances (base/quote integer)     │
│                                                                             │
│ • H2 (Order Flow Momentum):              FEASIBLE (on DexScreener REST)     │
│   ==> Feasible on co-occurring buys5m, sells5m, volume5mUsd                 │
│                                                                             │
│ • H3 (Structural Safety & Dev Holding): NOT_EVALUABLE (on REST alone)       │
│   ==> Requires verified DAS/RPC holder & mint authority queries             │
│                                                                             │
│ • H4 (Dynamic Capacity Sizing):         NOT_EVALUABLE (on REST alone)       │
│   ==> Requires verified RPC reserve vault balances + H1 model calibration   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Corrected Sampling, Selection Bias & Impairment Accounting (Finding D2-A04)

### 5.1 Decoupling the Four Data-Generating Processes

```
┌────────────────────────────────────────────────────────────────────────┐
│ Process 1: Candidate Screening (Market Universe -> Screened Pairs)     │
│ • DexScreener new pair stream; captures eventId, mint, initial price   │
├────────────────────────────────────────────────────────────────────────┤
│ Process 2: Strategy Admission (Screened Pairs -> Qualified Decisions)  │
│ • Strategy heuristics admit WATCHLIST_RADAR; reject FILTERED_REJECTED  │
├────────────────────────────────────────────────────────────────────────┤
│ Process 3: Stratified Observation Sampling (Decisions -> Follow-ups)  │
│ • 12.94-B Stratified sampler assigns stratum inclusion prob (pi_i)     │
│ • Persisted in sampling-trajectories.jsonl                             │
├────────────────────────────────────────────────────────────────────────┤
│ Process 4: Outcome Censoring & Token Impairment                        │
│ • Tokens rug-pulled or frozen: marked as IMPAIRED_CATASTROPHIC_COLLAPSE│
└────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Corrected Design-Based Weighting Estimator

We do **not** use an estimated trade-treatment propensity $\hat{e}(X)$ to model counterfactual market returns. Instead, we use the **known, persisted first-stage design inclusion probabilities ($\pi_i$)** from Phase 12.94-B via the Hájek estimator:

$$\widehat{\mu}_{\text{Hájek}} = \frac{\sum_{i \in \mathcal{S}} \frac{R_i}{\pi_i}}{\sum_{i \in \mathcal{S}} \frac{1}{\pi_i}}$$

- **Persisted Inclusion Probability**: $\pi_i = P(i \in \mathcal{S} \mid \text{Stratum}_i)$ is directly read from `sampling-trajectories.jsonl` (`effectiveInclusionProbability`).
- **Zero-Probability Handling**: If a stratum has $\pi_i = 0$ (e.g. unmonitored candidates), the estimator classifies that domain as **`NOT_ESTIMABLE`** rather than imputing zeros.
- **Extreme Weight Sensitivity**: Extreme design weights ($\pi_i < 0.02$) are subjected to formal sensitivity analysis (Winsorized at 98th percentile) and reported alongside unweighted sample statistics.

### 5.3 Economic & Impairment Accounting (Strict Segregation)

```
┌────────────────────────────────────────────────────────────────────────┐
│                        ECONOMIC SEPARATION                             │
├────────────────────────────────────────────────────────────────────────┤
│ 1. Realized Portfolio Cash P&L (Traded Tokens Only):                   │
│    • Delta Cash = Cash_exit - Cash_entry - NetworkFees - ATARentNet    │
│    • Exactly $0.00 cash delta for untraded or rejected candidates      │
│                                                                        │
│ 2. Marked-to-Model Impairment Write-Down (Held Inventory Only):        │
│    • If held token loses liquidity or rugs before exit:                │
│      ==> ImpairmentLoss = InitialCostBasis                             │
│      ==> Marked as UNREALIZED_IMPAIRMENT_WRITEDOWN                     │
│      ==> Never combined into "Realized Cash P&L" until position closes │
│                                                                        │
│ 3. Counterfactual Opportunity Benchmarks (Rejected Candidates Only):   │
│    • Forward return Delta P_60m tracked strictly as informational alpha│
│    • A rejected token that rugs is an "AVOIDED_CATASTROPHIC_LOSS"      │
│    • Never booked as a realized dollar loss or gain in wallet history  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Execution-Aware Financial Mathematics & AMM Oracles (Finding D2-A05)

### 6.1 Authoritative Phase 12.94-C Stateful AMM Execution Oracle

All synthetic execution calculations must use the exact, state-conserving Phase 12.94-C constant-product equations, completely replacing linear approximations:

```
                          LEG 1: BUY SWAP

  Initial State: (x_0, y_0), where x_0 = Quote (SOL), y_0 = Base (Token)
  Gross Input:   Delta x  (SOL allocated from wallet)
  LP Fee Deduct: Delta x_net = Delta x * (1 - phi_LP), with phi_LP = 0.0025 (25 bps)
  Token Output:  Delta y = (y_0 * Delta x_net) / (x_0 + Delta x_net)
  Updated State: x_1 = x_0 + Delta x
                 y_1 = y_0 - Delta y
  Invariant:     (x_0 + Delta x_net) * (y_0 - Delta y) >= x_0 * y_0 (Conserved)

                          LEG 2: SELL SWAP

  Intermediate:  (x_1, y_1), plus any exogenous pool transformation Delta x_exog
  Token Input:   Delta y  (Entire token inventory from Leg 1)
  LP Fee Deduct: Delta y_net = Delta y * (1 - phi_LP)
  SOL Output:    Delta x' = (x_1 * Delta y_net) / (y_1 + Delta y_net)
  Final State:   x_2 = x_1 - Delta x'
                 y_2 = y_1 + Delta y
```

### 6.2 Complete Net Cash Waterfall & Fee Preservation

The exact round-trip net cash delta returned to the wallet is:

$$\Delta \text{Cash} = \Delta x' - \Delta x - \text{Fee}_{\text{network, buy}} - \text{Fee}_{\text{network, sell}} + \Delta \text{Rent}_{\text{ATA}}$$

- **No Double-Counting**: LP fees ($\phi_{\text{LP}}$) are deducted strictly within AMM swap pricing ($\Delta x_{\text{net}}, \Delta y_{\text{net}}$). They are **never** subtracted a second time from $\Delta \text{Cash}$.
- **Network Fees**: Fixed lamport cost (e.g. 5,000 lamports standard + 10,000 lamports priority per transaction).
- **ATA Rent**: Account creation deposit (e.g. 0.00203928 SOL) on BUY, refunded on SELL if account closed.
- **Reporting Tiers**: Every evaluation report must present three distinct return figures:
  1. $\text{Return}_{\text{theoretical}}$: Based on raw spot price ratio $P_{\text{exit}} / P_{\text{entry}} - 1$.
  2. $\text{Return}_{\text{model-net}}$: Based on Phase 12.94-C stateful round-trip with fees, rent, and slippage.
  3. $\text{Return}_{\text{executable-quoted}}$: Live Tier 3 quotes (Marked `NOT_EVALUATED` in D.2).

### 6.3 Corrected H4 Dynamic Sizing Optimization

The optimization problem is formulated over a discrete grid evaluated by `CapacityCurveAnalyzer`:

$$S^* = \arg\max_{S_k \in \mathcal{G}} \mathbb{E}\left[ \text{NetSOLReturn}(S_k, R_{\text{quote}}, \phi_{\text{LP}}) \right]$$
$$\text{subject to: } \quad \text{Impact}(S_k) = \frac{S_k}{R_{\text{quote}} + S_k} \le \theta_{\text{max}} = 0.015, \quad S_k \le S_{\text{max}} = 0.25\text{ SOL}$$

- **Independent Unit Comparison**: We compare paired **independent trade opportunities** across the evaluation cohort, evaluating the difference $D_i = \text{NetSOL}(S^*_i) - \text{NetSOL}(S_{\text{fixed}})$.
- **Cumulative Curve Testing Prohibited**: We do **not** run Wilcoxon signed-rank tests across serial cumulative equity curve points, which are serially dependent and violate the IID assumption.

---

## 7. Statistical Methodology, Sample Adequacy & Two-Way Clustering (Finding D2-A06)

### 7.1 Analysis Units & Sample Size Reconciliation

| Hypothesis                   | Target Unit of Analysis                                            | Required Co-Occurring Features                                   | Min. Usable Sample Size ($1 - \beta = 0.80$)                                 | Collection Target Needed | Fallback Status if Inadequate |
| :--------------------------- | :----------------------------------------------------------------- | :--------------------------------------------------------------- | :--------------------------------------------------------------------------- | :----------------------- | :---------------------------- |
| **H1 (Liquidity Impact)**    | Independent candidate decision with verified pre-decision reserves | `quoteReserve`, `baseReserve`, follow-up spot price              | $N \ge 80$ decisions across varying reserve tiers ($10 \le R_q \le 200$ SOL) | 300+ total candidates    | `INSUFFICIENT_EVIDENCE`       |
| **H2 (Order Flow Momentum)** | Independent candidate decision with co-occurring 5m transactions   | `buys5m`, `sells5m`, `volume5mUsd`, 15m forward spot             | $N \ge 150$ decisions with complete 5m metrics                               | 500+ total candidates    | `INSUFFICIENT_EVIDENCE`       |
| **H3 (Structural Safety)**   | Independent candidate decision with pre-decision DAS holder audit  | `devHoldingPct` (D2-PREREQ-01 compliant), 60m forward trajectory | $N \ge 100$ decisions with verified holder queries                           | 400+ total candidates    | `INSUFFICIENT_EVIDENCE`       |
| **H4 (Dynamic Sizing)**      | Independent candidate decision with verified capacity grid         | Verified AMM reserves, calibrated gross return distribution      | $N \ge 80$ decisions                                                         | 300+ total candidates    | `INSUFFICIENT_EVIDENCE`       |

### 7.2 Label Purging, Overlapping Positions & Embargo Windows

```
┌────────────────────────────────────────────────────────────────────────┐
│                   LABEL PURGING & CHRONOLOGICAL EMBARGO                │
├────────────────────────────────────────────────────────────────────────┤
│ 1. Forward-Horizon Purging:                                            │
│    • If Token A triggers a decision at t = 0 (horizon = 60m), any      │
│      subsequent decision on Token A between t = 1m and t = 60m is      │
│      PURGED from primary hypothesis cohorts to eliminate self-overlap. │
│                                                                        │
│ 2. Chronological Set Partitioning (60% Train, 20% Val, 20% Holdout):   │
│    • Train Set:     t_0 to t_train                                     │
│    • Purge/Embargo: t_train to t_train + H_max (60m) + Buffer (60m)    │
│    • Val Set:       t_train + 120m to t_val                            │
│    • Purge/Embargo: t_val to t_val + H_max (60m) + Buffer (60m)        │
│    • Holdout Set:   t_val + 120m to t_end                              │
│                                                                        │
│ 3. Holdout Governance:                                                 │
│    • Holdout set remains cryptographically sealed until final review   │
│    • Evaluated exactly once to confirm out-of-sample validity          │
└────────────────────────────────────────────────────────────────────────┘
```

### 7.3 True Two-Way Cluster-Robust Covariance Matrix

To account for correlation across decisions within the same trading session (macro session regime) and across decisions on the same token mint (cross-sectional token persistence), we specify the true Cameron-Gelbach-Miller (2011) two-way cluster estimator:

$$\mathbb{V}_{\text{two-way}} = \mathbb{V}_{\text{session}} + \mathbb{V}_{\text{mint}} - \mathbb{V}_{\text{session} \cap \text{mint}}$$

where each component is the standard Huber-White sandwich estimator:
$$\mathbb{V}_c = (X^T X)^{-1} \left( \sum_{g \in \mathcal{G}_c} X_g^T u_g u_g^T X_g \right) (X^T X)^{-1}$$

**Small-Cluster Safeguards**:

- If the number of session clusters $G_{\text{session}} < 30$, asymptotic cluster-robust standard errors are rejected due to severe downward bias.
- In this regime, the system must deploy **wild cluster bootstrap** resampling (Webb 6-point weights) or state that cluster inference is **`NOT_ESTIMABLE`**.

### 7.4 Deflated Sharpe Ratio (DSR) & Trial Registry Governance

For any portfolio return series, the Sharpe ratio is evaluated on continuous daily return increments $R_{p, t}$ (including zero-trade days and marked inventory). DSR is calculated via:

$$\text{DSR} = \Phi\left( \frac{(\widehat{SR} - SR_0) \sqrt{T - 1}}{\sqrt{1 - \hat{\gamma}_3 \widehat{SR} + \frac{\hat{\gamma}_4 - 1}{4} \widehat{SR}^2}} \right)$$

- **Trial Registry**: Every explored hyperparameter combination (e.g. various momentum thresholds or liquidity cutoffs) is logged in `trial-registry.json`.
- $N_{\text{trials}}$ is the total count of evaluated trials, ensuring that selection variance $V[\{\widehat{SR}_k\}]$ accurately inflates the expected maximum Sharpe ratio under the null ($SR_0$).

---

## 8. Clock Provenance & Operational Authorization Gates (Finding D2-A07)

### 8.1 Multi-Clock Domain Architecture & Skew Governance

```
┌────────────────────────────────────────────────────────────────────────┐
│                        CLOCK DOMAIN SPECIFICATION                      │
├────────────────────────────────────────────────────────────────────────┤
│ Domain A: Provider Clock (sourceTimestampMs)                           │
│ • Generated by external server (DexScreener, Raydium, RPC node)        │
│ • Extracted from payload metadata or HTTP "Date" response header       │
│                                                                        │
│ Domain B: Host Local Clock (ingestionTimestampMs, responseReceivedMs)  │
│ • Generated by local Node.js process using Date.now() / hrtime         │
│ • ingestionTimestampMs: socket data arrival event                      │
│ • responseReceivedMs: complete deserialization and schema validation   │
│                                                                        │
│ Skew Governance & Bounded Latency:                                     │
│ • Transit Latency: RTT = responseReceivedMs - sourceTimestampMs        │
│ • Measured Skew Invariant: -500ms <= (sourceTimestampMs - hostTime)    │
│   (Provider time cannot be significantly in the future)                │
│ • If sourceTimestampMs > responseReceivedMs + 500ms:                   │
│   ==> Tagged with CLOCK_SKEW_QUARANTINE                                │
│   ==> Feature fails closed; excluded from empirical strategy ranking   │
└────────────────────────────────────────────────────────────────────────┘
```

### 8.2 Backward-Compatible D.1 Quarantine Representation

To prevent breaking changes to accepted Phase 12.94-B and D.1 contracts, clock-skewed observations are quarantined using **existing, accepted schemas**:

- Logged in the canonical `quarantined-records.jsonl` file.
- Uses existing `UnavailabilityReason`:
  ```typescript
  unavailabilityReason: "STALE_SAMPLE_DISCARDED"; // or "NO_INDEPENDENT_POINT_IN_TIME_SNAPSHOT"
  ```
- Carries an optional research metadata sidecar note:
  ```json
  { "quarantineDetail": "CLOCK_SKEW_VIOLATION_SOURCE_AHEAD_OF_RECEIPT" }
  ```
- D.1 readers process the quarantined record cleanly without throw or schema rejection.

---

## 9. Tightly Bounded Proposed Scope for Milestone D.2.1

Milestone D.2.1 is strictly restricted to **offline data inventory, schema reconciliation, and deterministic test fixtures**:

```
┌────────────────────────────────────────────────────────────────────────┐
│                      MILESTONE D.2.1 SCOPE BOUNDARY                    │
├────────────────────────────────────────────────────────────────────────┤
│ INCLUDED IN D.2.1 (Offline & Read-Only):                               │
│ 1. Formal offline inventory of Windows .tmp/sessions/ legacy files     │
│ 2. Implementation of sidecar ShadowEvaluationRecord types and schemas   │
│ 3. Deterministic test fixtures for:                                    │
│    • Authoritative Phase 12.94-C stateful round-trip AMM oracle        │
│    • Hájek / Horvitz-Thompson weighted sampling estimator              │
│    • Cameron-Gelbach-Miller two-way cluster covariance matrix          │
│    • D2-PREREQ-01 clock-monotonicity quarantine checks                 │
│ 4. Preparation of isolated read-only Fedora ingestion parser script    │
│    (to be executed only after separate authorization)                  │
│                                                                        │
│ EXCLUDED FROM D.2.1 (Strictly Unauthorized):                           │
│ • Zero live network data collection or shadow harvester deployment     │
│ • Zero connections to remote Fedora laptop                             │
│ • Zero modifications to Generation 1 wallet (7.9259 SOL)               │
│ • Zero Windows PAPER trading restarts                                  │
│ • Zero Tier 3 live quote polling                                       │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 10. Phased Implementation & Operational Authorization Gates

To maintain rigorous governance across research progression, the roadmap is divided into four distinct, sequential authorization gates:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    FOUR-STAGE RESEARCH AUTHORIZATION GATES                  │
├─────────────────────────────────────────────────────────────────────────────┤
│ GATE 0: Current Proposal Approval (PLANNING ONLY)                           │
│ • Status: PENDING INDEPENDENT REVIEW                                        │
│ • Authority: Approves Architecture Addendum v1 design principles only       │
│                                                                             │
│ GATE 1: Milestone D.2.1 Implementation (Offline Foundations & Fixtures)     │
│ • Requires: Gate 0 Approval + Explicit Operator Authorization               │
│ • Scope: Read-only inventory, sidecar schemas, deterministic math fixtures  │
│                                                                             │
│ GATE 2: Milestone D.2.2 Design & Isolated Mock Harness                      │
│ • Requires: Gate 1 Formal Acceptance + Explicit Operator Authorization      │
│ • Scope: Harvester interface design, mock stream integration tests          │
│                                                                             │
│ GATE 3: Passive Shadow Harvester Trial (Live Network Data Collection)      │
│ • Requires: Gate 2 Acceptance + Separate Operational Authorization          │
│ • Scope: Dedicated shadow daemon, read-only rate budgets, kill switch,     │
│   zero wallet handles, fixed collection duration (7–14 days)                │
│                                                                             │
│ GATE 4: Quantitative Hypothesis Evaluation (Milestone D.3)                  │
│ • Requires: Gate 3 Completion with Authoritative FINALIZED Sessions         │
│ • Scope: Offline causal joins, Hájek weighting, OOS testing, DSR analysis   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### Standing Restrictions & Operational Attestation

- **Generation 1 Virtual Wallet**: `.tmp/virtual-wallet.json` remains immutable at `7.9259 SOL`, SHA-256 `7F2C2353AC2F62CAC1BB98703742AB19C74AC5521635AF6F49BBE777AD020ED9`.
- **Active Processes**: Exactly 0 trading daemons running on Windows.
- **Closed Milestones**: Phase 12.93D, 12.94-A, 12.94-B, 12.94-C, and D.1 remain closed.
- **Fedora Run**: Remains untouched, isolated, and unverified.
- **Generation 2 & Real-SOL**: Deferred, uncreated, and disabled.
- **Milestone D.2 Status**: **STRICTLY PLANNING ONLY**.
