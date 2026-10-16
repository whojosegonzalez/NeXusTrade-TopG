# NeXusTrade — Phase 12.94-D Milestone D.2.3 Architecture Proposal

## Controlled Empirical Market Data Pilot (PLANNING ONLY)

**Document Version:** 1.0.0 (Governed by Addendum v1.1.0)  
**Status:** DIRECTIONALLY APPROVED — REFINED VIA ADDENDUM V1 (PLANNING ONLY)  
**Implementation Status:** STRICTLY UNAUTHORIZED — Design, Specification & Governance Scope Only  
**Author:** Antigravity  
**Date:** October 16, 2026  
**Governing Addendum:** [`audit/PHASE_12_94D2_MILESTONE_D23_ADDENDUM.md`](./PHASE_12_94D2_MILESTONE_D23_ADDENDUM.md)  
**Independent Audit Review:** [`audit/PHASE_12_94D23_COMMIT_38B0F96_INDEPENDENT_PROPOSAL_REVIEW.md`](./PHASE_12_94D23_COMMIT_38B0F96_INDEPENDENT_PROPOSAL_REVIEW.md)  
**Prerequisites Closed & Accepted:**

- Phase 12.93D (CLOSED)
- Phase 12.94-A (CLOSED under `7e58ea5`)
- Phase 12.94-B (CLOSED under `c37f91e`)
- Phase 12.94-C (CLOSED under `2541d5b` / `c5931ca` / `7faf705`)
- Phase 12.94-D.1 (FORMALLY ACCEPTED under `86abf6f`)
- Phase 12.94-D.2 Architecture Addendum v1 (APPROVED under `9a707bf`)
- Phase 12.94-D.2.1 (FORMALLY ACCEPTED under `da9436c`)
- Phase 12.94-D.2.2 (FORMALLY ACCEPTED AND CLOSED under commit `f933305`, review `NeXusTrade_Phase_12_94D22_Commit_f933305_Final_Independent_Acceptance.md`)

---

## 1. Executive Summary, Scope Boundary & Permanent Restrictions

Following the formal independent acceptance and closure of Milestone D.2.2 (strictly offline mock-provider harness and collector state machine), this proposal establishes the architectural design, data dictionary, candidate discovery mechanism, resource budgets, and objective evaluation criteria for **Milestone D.2.3: Controlled Empirical Market Data Pilot**.

### 1.1 Non-Negotiable Operational Constraints & Scope Boundaries

1. **Planning Only — Implementation Unauthorized**: This document serves solely as an architectural specification. **Zero live provider adapters, zero network polling loops, and zero background collection processes are built, deployed, or executed in this planning phase.**
2. **Permanent Invariant Safeguards**:
   - **Generation 1 Virtual Wallet**: Immutable at **`7.9259 SOL`** with canonical SHA-256 **`7F2C2353AC2F62CAC1BB98703742AB19C74AC5521635AF6F49BBE777AD020ED9`**. The pilot has zero wallet access, zero keypair access, and zero transaction signing capabilities.
   - **Trading Daemon State**: The Windows PAPER trading engine remains completely **PAUSED** (0 running daemons). No trading strategies, buy triggers, sizing logic, or exit rules are activated.
   - **Remote Fedora Host**: Remains completely uncontacted and isolated (**0** SSH connections, **0** network packets). Its status remains `REPORTED_NOT_INSPECTED`.
   - **Historical Shadow Subsystem**: The legacy July 2026 trading shadow located at `backend/src/shadow/` remains preserved and untouched.
   - **Generation 2 & Real-SOL Execution**: Strictly unauthorized and unactivated.
3. **Minimal Pilot Priority**: The proposed pilot is deliberately bounded to a small, passive, read-only exercise designed strictly to test empirical data availability, timestamp validity, and provider schema fidelity for Hypotheses H1–H4, avoiding unnecessary infrastructure complexity.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              SYSTEM PROCESS BOUNDARY                                   │
├─────────────────────────────────────────────────┬──────────────────────────────────────┤
│           TRADING SUBSYSTEM (PAUSED)            │         PILOT HARVESTER (D.2.3)      │
│                                                 │                                      │
│  ┌───────────────────────────────────────────┐  │  ┌────────────────────────────────┐  │
│  │ Generation 1 Virtual Wallet               │  │  │ Read-Only Live Provider        │  │
│  │ Balance: 7.9259 SOL (FROZEN)              │  │  │ (DexScreener / Solana RPC)     │  │
│  └───────────────────────────────────────────┘  │  └───────────────┬────────────────┘  │
│                       ▲                         │                  │                   │
│                       │ (NO ACCESS)             │                  ▼ (Read-Only HTTP)  │
│  ┌────────────────────┴──────────────────────┐  │  ┌────────────────────────────────┐  │
│  │ Paper Trading Engine & State Machine      │  │  │ Shadow Collector Engine        │  │
│  │ (PAUSED - ZERO RUNNING DAEMONS)           │  │  │ (State Machine, Token Bucket)  │  │
│  └───────────────────────────────────────────┘  │  └───────────────┬────────────────┘  │
│                                                 │                  │                   │
│                                                 │                  ▼                   │
│                                                 │  ┌────────────────────────────────┐  │
│                                                 │  │ Isolated Pilot Filesystem      │  │
│                                                 │  │ (.tmp/research-pilot/sessions/)│  │
│                                                 │  │ - session-meta.json            │  │
│                                                 │  │ - session-summary.json         │  │
│                                                 │  │ - candidate-decisions.jsonl    │  │
│                                                 │  │ - shadow-evaluations.jsonl     │  │
│                                                 │  │ - market-observations.jsonl    │  │
│                                                 │  └────────────────────────────────┘  │
└─────────────────────────────────────────────────┴──────────────────────────────────────┘
```

---

## 2. Empirical Research Questions & H1–H4 Feature Requirements

The pilot addresses four specific empirical questions directly corresponding to the approved research hypotheses (D.1 / D.2 baseline):

| Hypothesis                                     | Core Empirical Question                                                                                                                                                                                    | Required Telemetry Fields                                                                                         | Point-in-Time Requirement                                                       | Fallback / Missing Handling                                                                                                                                                                                |
| :--------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H1: AMM Liquidity Depth & Price Impact**     | Can on-chain Raydium AMM pool reserves ($x, y$) be retrieved with causal timestamps ($t_{\text{recv}} \le t_{\text{decision}}$) to evaluate constant-product slippage curves against real-world liquidity? | `baseReserve: number`<br/>`quoteReserve: number`<br/>`poolId: string`<br/>`sourceTimestampMs: number`             | $t_{\text{src}} \le t_{\text{ing}} \le t_{\text{recv}} \le t_{\text{decision}}$ | If reserves unavailable from DexScreener, query Solana RPC reserve vault; if both fail, log `null` reserves with `missingFields: ["baseReserve", "quoteReserve"]` and mark `executionFeasible: false`.     |
| **H2: Order-Flow Momentum & Buyer Dominance**  | Can 5-minute transaction flow (buys, sells, net volume) be captured contemporaneously at candidate discovery time without lookahead bias?                                                                  | `volume5mUsd: number`<br/>`buys5m: number`<br/>`sells5m: number`<br/>`buyerDominanceRatio: number`                | $t_{\text{ing}} \le t_{\text{decision}}$                                        | If 5m trade counts are omitted by provider, record `null` and compute buyer dominance as `null` with explicit `missingFields: ["buys5m", "sells5m"]`.                                                      |
| **H3: Structural Safety & Developer Holdings** | Can developer wallet concentration, mint authority status, and LP burn percentage be verified at candidate discovery?                                                                                      | `devHoldingPct: number`<br/>`lpBurnPct: number`<br/>`isVerifiedDevWallet: boolean`<br/>`devWalletAddress: string` | $t_{\text{src}} \le t_{\text{decision}}$                                        | If developer authority is unverified or multi-sig/pool address is unconfirmed, mark `isVerifiedDevWallet: false`, `devHoldingPct: null`, and set `devHoldingUnavailabilityReason: "UNVERIFIED_AUTHORITY"`. |
| **H4: Capacity-Aware Position Sizing**         | Does observed pool liquidity support a modeled position size (e.g. 0.05–0.10 SOL) without exceeding acceptable slippage bounds ($\le 250$ bps)?                                                            | `liquidityUsd: number`<br/>`expectedSlippageBps: number`<br/>`simulatedExecutionPrice: number`                    | Calculated from $t_{\text{decision}}$ reserves                                  | If reserve snapshot is missing or zero, position sizing cannot be evaluated; mark `executionFeasible: false` and set `rejectionReasons: ["INSUFFICIENT_LIQUIDITY_DEPTH"]`.                                 |

### 2.1 Complete Pilot Data Dictionary

```typescript
export interface EmpiricalObservationPayload {
  // Identification & Provenance
  readonly mintAddress: string;
  readonly poolId: string;
  readonly providerIdentity: "dexscreener_public_v1" | "solana_rpc_public_v1";
  readonly capabilityStatus: "EMPIRICALLY_VERIFIED" | "UNVERIFIED_DESIGN_EXPECTATION";

  // Temporal Causality (Triple Timestamps)
  readonly sourceTimestampMs: number; // On-chain block time or provider update time
  readonly ingestionTimestampMs: number; // Dispatch time from local collector
  readonly responseReceivedMs: number; // Completion time of HTTP parse

  // H1: AMM Reserve Snapshot
  readonly baseReserve: number | null; // Token vault balance (decimal adjusted)
  readonly quoteReserve: number | null; // SOL vault balance (decimal adjusted)
  readonly spotPriceSol: number | null; // quoteReserve / baseReserve
  readonly spotPriceUsd: number | null; // Spot price in USD

  // H2: 5-Minute Flow Metrics
  readonly volume5mUsd: number | null;
  readonly buys5m: number | null;
  readonly sells5m: number | null;
  readonly netBuyerVolumeUsd: number | null;

  // H3: Safety & Structural Metrics
  readonly devHoldingPct: number | null;
  readonly lpBurnPct: number | null;
  readonly isVerifiedDevWallet: boolean;

  // Data Quality & Completeness
  readonly missingFields: readonly string[];
  readonly dataFreshnessMs: number; // ingestionTimestampMs - sourceTimestampMs
}
```

---

## 3. Real-World Provider Capabilities, Endpoints, Timestamps, Costs & Rate Limits

The pilot evaluates two complementary read-only data sources to achieve complete H1–H4 coverage without paid infrastructure:

| Parameter                 | Primary: DexScreener Public REST API                                                                                                     | Secondary / Fallback: Solana Public RPC                                                                    |
| :------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------- |
| **Target Endpoints**      | `GET https://api.dexscreener.com/latest/dex/pairs/solana/{poolId}`<br/>`GET https://api.dexscreener.com/latest/dex/tokens/{mint}`        | `POST https://api.mainnet-beta.solana.com`<br/>(`getMultipleAccounts`, `getTokenAccountBalance`)           |
| **Fields Returned**       | `priceUsd`, `priceNative`, `liquidity.usd`, `volume.m5`, `txns.m5.buys`, `txns.m5.sells`, `pairCreatedAt`                                | Raw token account balances (`amount`, `decimals`), block slot, block time                                  |
| **Fields Omitted / Gaps** | **Base/quote token integer reserves ($x, y$) omitted**; LP burn % omitted; holder concentration omitted                                  | 5m volume, buys/sells counts, and pricing marks omitted                                                    |
| **Timestamp Semantics**   | Provider update timestamp (`pairCreatedAt` + internal cache freshness). Must verify whether response headers provide millisecond `Date`. | Block time (`blockTime` in seconds since epoch) or node clock                                              |
| **Rate Limits**           | 300 requests / minute (IP-wide limit)                                                                                                    | 10–40 requests / second (public tier, rate-shedding on burst)                                              |
| **Pilot Concurrency**     | Max 1.5 requests / second (90 req/min) via VirtualTokenBucket                                                                            | Max 1 request / second (strictly for reserve vault balances)                                               |
| **Financial Cost**        | **$0.00 USD** (Completely free, no authentication, no API key)                                                                           | **$0.00 USD** (Public rate-limited cluster)                                                                |
| **Budget Ceiling**        | **0 paid credits; 0 financial liability**                                                                                                | **0 paid credits; 0 financial liability**                                                                  |
| **Capability Status**     | Initial: `UNVERIFIED_DESIGN_EXPECTATION`<br/>Transition to `EMPIRICALLY_VERIFIED` upon validated telemetry                               | Initial: `UNVERIFIED_DESIGN_EXPECTATION`<br/>Transition to `EMPIRICALLY_VERIFIED` upon validated telemetry |

---

## 4. Passive Candidate Discovery Architecture (Independent of Paused Trading Daemon)

To preserve the invariant that the trading daemon is **PAUSED** and generates zero state mutations, candidate discovery is completely decoupled from the execution engine:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        CANDIDATE DISCOVERY FLOW (PASSIVE)                              │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│  ┌─────────────────────────────────┐                                                   │
│  │ DexScreener Latest Solana Pools │                                                   │
│  │ (GET /token-profiles/latest/v1) │                                                   │
│  └────────────────┬────────────────┘                                                   │
│                   │ Poll 1 batch every 60 seconds (Read-Only)                          │
│                   ▼                                                                    │
│  ┌─────────────────────────────────┐                                                   │
│  │ Passive Candidate Filter        │ ◄── Pure Read-Only Criteria:                      │
│  │ (Observational Filter)          │     - Chain: "solana"                             │
│  │                                 │     - DEX: "raydium" (AMM v4)                     │
│  │                                 │     - Min Liquidity: $5,000 USD                   │
│  └────────────────┬────────────────┘                                                   │
│                   │                                                                    │
│         ┌─────────┴─────────┐                                                          │
│         │                   │                                                          │
│         ▼ (Passed Filter)   ▼ (Failed Filter)                                          │
│  ┌───────────────┐   ┌───────────────────┐                                             │
│  │ Decision:     │   │ Decision:         │                                             │
│  │ WATCHLIST_    │   │ FILTERED_REJECTED │                                             │
│  │ RADAR         │   │                   │                                             │
│  └───────┬───────┘   └─────────┬─────────┘                                             │
│          │                     │                                                       │
│          └──────────┬──────────┘                                                       │
│                     │ Ingest into ShadowCollectorEngine                                │
│                     ▼                                                                  │
│  ┌─────────────────────────────────────┐                                               │
│  │ candidate-decisions.jsonl           │ (Recorded strictly as research evidence)      │
│  └─────────────────────────────────────┘                                               │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Decoupled Polling**: A lightweight discovery poller queries DexScreener's public latest tokens feed once every 60 seconds.
2. **Read-Only Screening**: Candidates are evaluated against basic research eligibility gates (Solana chain, Raydium AMM pool, min liquidity \$5,000 USD).
3. **Cohort Attribution**: Candidates meeting screening criteria are labeled `WATCHLIST_RADAR`; non-qualifying tokens are labeled `FILTERED_REJECTED` with specific rejection reasons.
4. **Zero Buy Gates**: No buy trigger logic is evaluated, no simulated order is constructed, and no trading state machine is contacted.

---

## 5. Point-in-Time Observations, Missing Values, Pool Identity & Trajectories

### 5.1 Causal Point-in-Time Enforcement

- Every candidate decision $D$ establishes an authoritative decision time $t_{\text{decision}}$.
- At $t_{\text{decision}}$, the collector queries DexScreener and/or Solana RPC.
- The triple-timestamp monotonicity contract verified in D.2.1/D.2.2 is strictly applied:
  $$t_{\text{src}} \le t_{\text{ing}} \le t_{\text{recv}} \le t_{\text{decision}}$$
- Any market observation or reserve response arriving after $t_{\text{decision}}$ is rejected for decision-time evaluation and quarantined to avoid future lookahead bias.

### 5.2 Forward Outcome Trajectories

- To evaluate counterfactual outcomes (e.g. price change, avoided rugs, missed winners), forward observations are scheduled at fixed post-decision intervals:
  - **Horizon 1**: $t_{\text{decision}} + 60\text{ seconds}$ (1-minute follow-up)
  - **Horizon 2**: $t_{\text{decision}} + 300\text{ seconds}$ (5-minute follow-up)
- Forward observations are appended to `market-observations.jsonl`.
- They are strictly isolated from candidate decisions and cannot alter $t_{\text{decision}}$ feature vectors.

### 5.3 Pool Identity & Missing Value Handling

- **Pool Identity Normalization**: All pool addresses are normalized (lowercased, whitespace trimmed, `dexscreener-` prefix stripped). If `actualResponsePoolId !== expectedPoolId`, the record is marked `UNVERIFIED_POOL` and rejected.
- **Missing Value Transparency**: If a provider omits a field (e.g. DexScreener omits base/quote integer reserves), the field is serialized as `null`, explicitly added to `missingFields: string[]`, and tagged with `unavailabilityReason`.

---

## 6. Pilot Parameters, Targets, Resource Budgets & Stopping Conditions

### 6.1 Pilot Parameters & Targets

| Parameter                        | Specification                                           | Purpose                                                                     |
| :------------------------------- | :------------------------------------------------------ | :-------------------------------------------------------------------------- |
| **Duration Box**                 | **2 Hours** (Hard ceiling: 4 Hours)                     | Prevents runaway background processes; limits telemetry volume              |
| **Candidate Decision Target**    | **100 Decisions**                                       | Sufficient statistical support to evaluate H1–H4 while minimizing API calls |
| **Distinct Pools Target**        | $\ge \mathbf{20\text{ Distinct Raydium AMM Pools}}$     | Ensures diversity across different liquidity tiers and volatility profiles  |
| **Observation Horizons**         | **2 per candidate** ($t + 60\text{s}, t + 300\text{s}$) | Tracks short-term forward trajectory without excessive polling              |
| **Estimated Total Decisions**    | ~100 records in `candidate-decisions.jsonl`             | Sized for rapid analysis by D.1 quantitative engine                         |
| **Estimated Total Observations** | ~200 records in `market-observations.jsonl`             | Validates forward trajectory recording                                      |
| **Estimated Evaluations**        | ~100 records in `shadow-evaluations.jsonl`              | Evaluates H1–H4 eligibility and counterfactual feasibility                  |

### 6.2 Strict Resource Budgets

| Resource                     | Budget Allocation                   | Enforcement Mechanism                                         |
| :--------------------------- | :---------------------------------- | :------------------------------------------------------------ |
| **HTTP Request Rate**        | Max 1.5 req / sec (burst: 3)        | Managed by `VirtualTokenBucket` in `ShadowResourceController` |
| **Total HTTP Requests**      | Max 1,500 requests for entire pilot | Process terminates once ceiling reached                       |
| **Disk Storage Quota**       | Max **20 MB** (operational payload) | Tracked by `ShadowResourceController.recordBytesWritten`      |
| **Emergency Metadata Quota** | Max **2 KB** (abort / diagnostics)  | Dedicated emergency allowance preventing unfinalized crashes  |
| **Memory RSS Ceiling**       | Max **128 MB**                      | Monitored by `checkResourceLimits()` on every loop iteration  |
| **Financial Cost**           | **$0.00 USD**                       | Zero paid endpoints; public tier only                         |

### 6.3 Fail-Closed Stopping Conditions

The pilot process must immediately enter `DRAINING` and finalize as `COMPLETED` or `INTERRUPTED` if **any** of the following conditions occur:

1. **Target Met**: 100 candidate decisions and their corresponding forward observations are collected.
2. **Time Expiration**: Wall-clock runtime reaches 2 hours (or hard limit 4 hours).
3. **Rate-Limit Backoff Trip**: 5 consecutive HTTP `429` (Too Many Requests) or `503` responses occur despite deterministic backoff.
4. **Storage Quota Breach**: Total session disk usage reaches 20 MB.
5. **Memory Quota Breach**: Node.js process RSS exceeds 128 MB.
6. **Clock Skew Detected**: Provider timestamp deviates from local virtual clock by $> 2,000$ ms.
7. **Emergency Kill Switch**: Operator or monitoring script creates `TRIGGER_KILL_SWITCH` file in session directory.

---

## 7. Isolated Storage Destination & Recovery Procedure

### 7.1 Path Confinement & Output Staging

All pilot data is strictly confined to an isolated temporary directory:

- Path: `.tmp/research-pilot/sessions/<sessionId>/`
- **Path Confinement Verification**: Enforced at startup using `validatePathConfinement()`.
- **Prohibited Destinations**: Rejects any path resolving to:
  - `.tmp/telemetry/sessions/` (canonical trading telemetry)
  - `.tmp/sessions/` (legacy paper trading sessions)
  - `.tmp/virtual-wallet.json` (Generation 1 virtual wallet)
  - Repository roots (`backend/`, `shared/`, `frontend/`)

### 7.2 Directory File Structure

```
.tmp/research-pilot/sessions/<sessionId>/
├── session-meta.json                 (Authoritative session metadata, timestamps, & status)
├── session-summary.json              (Reconciled record counts & dual-file consensus)
├── candidate-decisions.jsonl         (Screened candidate decisions: WATCHLIST_RADAR)
├── shadow-evaluations.jsonl          (1:N shadow qualification & synthetic quote sidecar)
└── market-observations.jsonl         (Post-decision forward observations at 1m, 5m)
```

### 7.3 Crash Recovery & Quarantine Procedure

In the event of an ungraceful shutdown or process crash:

1. `ShadowCollectorEngine.recoverSessionDirectory()` is executed on restart.
2. Torn or incomplete JSON lines are quarantined to `.corrupt-<timestamp>`.
3. Schema-invalid records are isolated and excluded from valid counts.
4. Orphan evaluations lacking matching candidate decisions are identified and flagged.
5. Dual-file consensus between `session-meta.json` and `session-summary.json` is audited; any identity mismatch forces status to `INTERRUPTED`.

---

## 8. Execution Tiers & Strict Boundary Between Market Data and Trading

To guarantee that empirical data collection never triggers unintended financial commitments or simulated order fills, the pilot adopts a strict 4-tier taxonomy:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              EXECUTION TIERS & BOUNDARIES                              │
├─────────┬───────────────────────────────┬───────────────────────────────┬──────────────┤
│ Tier    │ Description                   │ Mechanism & Data Source       │ Pilot Status │
├─────────┼───────────────────────────────┼───────────────────────────────┼──────────────┤
│ Tier 0  │ Observed Market State         │ Public REST API / RPC reads   │ AUTHORIZED   │
│         │ (Reserves, prices, volumes)   │ (DexScreener, Solana RPC)     │ (Read-Only)  │
├─────────┼───────────────────────────────┼───────────────────────────────┼──────────────┤
│ Tier 1  │ Synthetic AMM Quotes          │ Constant-Product math         │ AUTHORIZED   │
│         │ (Calculated slippage curves)  │ ($x \cdot y = k$ equations)   │ (Sidecar)    │
├─────────┼───────────────────────────────┼───────────────────────────────┼──────────────┤
│ Tier 2  │ Simulated Counterfactual Fill │ Modeled paper execution       │ AUTHORIZED   │
│         │ (Zero execution / research)   │ (Counterfactual P/L tracking) │ (Evaluation) │
├─────────┼───────────────────────────────┼───────────────────────────────┼──────────────┤
│ Tier 3  │ Executable Route Quotes       │ Live Jupiter / DEX aggregator │ STRICTLY     │
│         │ & Actual Transaction Broadcast│ API calls & wallet signatures │ PROHIBITED   │
└─────────┴───────────────────────────────┴───────────────────────────────┴──────────────┘
```

- **No Tier 3 Quotes**: The pilot will not contact Jupiter or any DEX routing API for executable swap transactions.
- **No Wallet Interaction**: Virtual wallet balance (`7.9259 SOL`) is completely decoupled; zero balance queries, zero reservations, and zero mutations.

---

## 9. Objective Acceptance Criteria for Quantitative Research Suitability

The empirical pilot will be deemed successful and accepted for downstream quantitative research if and only if all eight objective criteria are satisfied:

| ID         | Criterion                               | Quantitative Threshold                                                                                                                     | Pass / Fail Verification Method                                                             |
| :--------- | :-------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------ |
| **ACC-01** | **Sample Size & Target Completion**     | $\ge 100$ candidate decisions recorded across $\ge 20$ distinct Raydium pools.                                                             | Inspect `session-summary.json` `totalDecisionsRecorded` and distinct `poolId` count.        |
| **ACC-02** | **Reserve Availability Rate (H1)**      | $\ge 85\%$ of eligible decisions have valid, non-null base and quote reserves.                                                             | Filter `shadow-evaluations.jsonl` for `observedReserveSnapshot !== null`.                   |
| **ACC-03** | **Clock Monotonicity & Causality**      | **100%** causal compliance ($t_{\text{src}} \le t_{\text{ing}} \le t_{\text{recv}} \le t_{\text{decision}}$); zero future lookahead leaks. | Run `validateClockMonotonicity()` across all records; 0 violations allowed.                 |
| **ACC-04** | **Flow & Momentum Completeness (H2)**   | $\ge 90\%$ of candidate decisions contain non-null 5-minute volume and transaction counts.                                                 | Filter `candidate-decisions.jsonl` for valid `metricsSnapshot.volume5mUsd`.                 |
| **ACC-05** | **Trajectory Follow-Up Completeness**   | $\ge 80\%$ of candidate decisions have both $t + 60\text{s}$ and $t + 300\text{s}$ observations recorded.                                  | Reconcile foreign keys between `candidate-decisions.jsonl` and `market-observations.jsonl`. |
| **ACC-06** | **Pool Identity Integrity**             | **100%** pool address verification; 0 mismatched pools, 0 orphan evaluations.                                                              | Enforce `isVerifiedMatchingPool()` on all returned records.                                 |
| **ACC-07** | **Dual-File Consensus & Quota**         | Exact line counts and IDs match between disk and memory; total disk usage $\le 20$ MB.                                                     | Enforce `deepEqualRecords()` payload reconciliation in `drain()`.                           |
| **ACC-08** | **Downstream D.1 Engine Compatibility** | The resulting session directory can be ingested by the accepted D.1 `evaluateSessionHypotheses` engine without schema or parsing errors.   | Execute D.1 research engine against pilot session directory; verify report generation.      |

---

## 10. Implementation Roadmap & Explicit Governance Authorization Gates

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                          MILESTONE D.2.3 GOVERNANCE PHASES                             │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│  [PHASE 1: ARCHITECTURE PROPOSAL] (CURRENT STEP - PLANNING ONLY)                       │
│  • Submit PHASE_12_94D2_MILESTONE_D23_PROPOSAL.md for independent review.              │
│  • Zero code changes, zero live requests, zero adapter creation.                       │
│  • STATUS: READY FOR OPERATOR & AUDITOR REVIEW.                                        │
│                                                                                        │
│  [GATE 1: FORMAL ARCHITECTURE APPROVAL REQUIRED]                                       │
│                                                                                        │
│  [PHASE 2: LIVE READ-ONLY ADAPTER IMPLEMENTATION] (AWAITING APPROVAL)                  │
│  • Implement DexScreenerPublicAdapter and SolanaRpcPublicAdapter implementing           │
│    IMarketDataProvider interface under backend/src/research/shadow/.                  │
│  • Write unit tests verifying rate-limiting, error handling, and timeout behavior.     │
│  • Execute full isolated test suite (1,037+ tests passing).                            │
│                                                                                        │
│  [GATE 2: ADAPTER SOURCE AUDIT APPROVAL REQUIRED]                                      │
│                                                                                        │
│  [PHASE 3: CONTROLLED PILOT EXECUTION] (AWAITING SEPARATE OPERATOR APPROVAL)           │
│  • Run 2-hour bounded collection pilot into .tmp/research-pilot/sessions/.             │
│  • Verify all 8 acceptance criteria (ACC-01 through ACC-08).                           │
│  • Ingest resulting dataset into D.1 research engine to evaluate H1–H4.                │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

**Conclusion**: This proposal strictly bounds the pilot to a read-only, non-trading, non-polling planning exercise. No implementation or network execution will occur until this document is reviewed and approved by the independent auditor and authorized by the operator.
