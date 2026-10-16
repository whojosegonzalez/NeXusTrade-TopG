# NeXusTrade — Phase 12.94-D Milestone D.2.3 Architecture Addendum v1

## Empirical Pilot Refinements & Review Resolutions (D23-A01 through D23-A05)

**Document Version:** 1.1.0  
**Status:** PROPOSED ARCHITECTURE ADDENDUM (PLANNING ONLY)  
**Implementation Status:** STRICTLY UNAUTHORIZED — Design, Specification & Governance Scope Only  
**Author:** Antigravity  
**Date:** October 16, 2026  
**Governing Documents:**

- Proposal Baseline: [`audit/PHASE_12_94D2_MILESTONE_D23_PROPOSAL.md`](./PHASE_12_94D2_MILESTONE_D23_PROPOSAL.md) (Commit `38b0f96`)
- Independent Audit Review: [`audit/PHASE_12_94D23_COMMIT_38B0F96_INDEPENDENT_PROPOSAL_REVIEW.md`](./PHASE_12_94D23_COMMIT_38B0F96_INDEPENDENT_PROPOSAL_REVIEW.md)

---

## 1. Context, Purpose & Permanent Safety Invariants

This addendum amends and refines the Milestone D.2.3 Architecture Proposal in direct response to the independent auditor's review (`NeXusTrade_D23_Commit_38b0f96_Independent_Proposal_Review.md`). It addresses findings **D23-A01 through D23-A05** without reopening Milestone D.2.2 or modifying any closed milestone baselines.

### 1.1 Permanent Non-Negotiable Safety Invariants

1. **Planning Only — Implementation Unauthorized**: No live provider adapters, background collection daemons, HTTP polling routines, or network sockets are constructed, deployed, or executed in this planning phase.
2. **Generation 1 Virtual Wallet**: Immutable at **`7.9259 SOL`** with canonical SHA-256 **`7F2C2353AC2F62CAC1BB98703742AB19C74AC5521635AF6F49BBE777AD020ED9`**. The pilot has zero wallet access, zero keypair access, and zero transaction signing capabilities.
3. **Trading Engine State**: Windows PAPER trading remains completely **PAUSED** (0 running daemons). Generation 2 activation and real-SOL trading remain strictly deferred and prohibited.
4. **Fedora Host State**: The former 168-hour endurance test is canceled by the operator. The remote Fedora host remains uncontacted in this turn (`REPORTED_NOT_INSPECTED`). Prior historical test files on Fedora are preserved and must not be overwritten.
5. **Milestone D.2.2 Protection**: Milestone D.2.2 is closed and immutable. Its mock harness (`backend/src/research/shadow/`) is preserved without modification or monkey-patching.

---

## 2. D23-A01: Candidate Discovery, Genuine Pair Resolution & Selection Bias

### 2.1 DexScreener Profile Feed Dissection

DexScreener's public endpoint `GET /token-profiles/latest/v1` returns an array of token profiles containing:

```json
[
  {
    "url": "https://dexscreener.com/solana/...",
    "chainId": "solana",
    "tokenAddress": "So11111111111111111111111111111111111111112",
    "icon": "...",
    "header": "...",
    "description": "...",
    "links": [...]
  }
]
```

**Critical Reality**: This feed provides token-level metadata uploaded by token creators/communities. It is **NOT** a pair-level feed, does **NOT** provide AMM pool addresses or DEX program identities, and is **NOT** a comprehensive or chronological stream of all newly deployed Solana liquidity pools.

### 2.2 Documented Token-to-Pair Resolution Procedure

To evaluate actual liquidity pools from discovered token profiles, the pilot uses a two-stage discovery pipeline:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        TWO-STAGE CANDIDATE DISCOVERY PIPELINE                          │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│  [Stage 1: Token Profile Ingestion]                                                    │
│  Query: GET https://api.dexscreener.com/token-profiles/latest/v1 (Rate: 1 req / 60s)    │
│  Output: Candidate mint address string (case-sensitive base58).                         │
│                                                                                        │
│                                    │ (tokenAddress)                                    │
│                                    ▼                                                   │
│  [Stage 2: Documented Pair Resolution]                                                 │
│  Query: GET https://api.dexscreener.com/latest/dex/tokens/{tokenAddress}               │
│  (Limit: 300 req/min; Pilot allocates max 0.5 req/s)                                  │
│  Output: Array of DEX pairs associated with tokenAddress.                              │
│                                                                                        │
│                                    │ (pairs[])                                         │
│                                    ▼                                                   │
│  [Stage 3: Verified AMM Architecture Filtering]                                        │
│  Filter:                                                                               │
│  - pair.chainId === "solana"                                                           │
│  - pair.dexId === "raydium"                                                            │
│  - Verified Program ID: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 (Raydium AMM v4)  │
│                                                                                        │
│         ┌──────────────────────────┴──────────────────────────┐                        │
│         ▼ (Matches AMM v4)                                    ▼ (Non-v4 / Unverified)  │
│  [Eligible for H1-H4 Evaluation]                    [Discard / Label Non-Standard]     │
│  Label: CANDIDATE_DISCOVERY_PROFILE                 Label: UNSUPPORTED_AMM_TYPE        │
│  Sub-label: WATCHLIST_RADAR                         Reason: "EXCLUDED_CLMM_OR_CPMM"    │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **AMM Family Verification**: Only standard **Raydium AMM v4** pools (`675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`) adhere to the constant-product $x \cdot y = k$ pricing model evaluated in Hypothesis H1.
2. **Exclusion of Non-Constant-Product AMMs**: Raydium Concentrated Liquidity (CLMM, `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`), Raydium CPMM (`CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`), Orca Whirlpools, and Meteora DLMM are tagged `UNSUPPORTED_AMM_TYPE` and excluded from constant-product reserve calculations to prevent invalid pricing math.

### 2.3 Explicit Candidate Selection Population & Selection Bias Disclosure

- **Selection Population**: The discovery cohort consists strictly of _Solana tokens whose developers or communities actively submitted a promotional profile on DexScreener_.
- **Selection Bias Disclosure**:
  - The sample is heavily biased toward tokens with active marketing campaigns, speculative meme tokens, and community-driven initiatives.
  - It omits stealth launches, institutional token pairs, automated arbitrage pools, and tokens without DexScreener profile registrations.
  - Higher probability of extreme volatility, promotional pump-and-dump dynamics, and rapid liquidity extraction.
- **Candidate Labeling Semantics**:
  - Screened profiles are recorded as `CANDIDATE_DISCOVERY_PROFILE` (with observation disposition `WATCHLIST_RADAR` or `FILTERED_REJECTED`).
  - **Never Labeled as Strategy Decisions**: These records represent passive candidate screening inputs for observational market research, **not** trading strategy buy signals or algorithmic decisions.

### 2.4 Strict Solana Case-Sensitive Base58 Key Invariant

- Solana addresses (mint addresses, pool IDs, vault accounts, and program IDs) are encoded using **case-sensitive base58** (Bitcoin alphabet: `[1-9A-HJ-NP-Za-km-z]`).
- **Strict Rule: NEVER lowercase Solana public keys.** Lowercasing a Solana address destroys its 256-bit cryptographic identity and causes RPC account lookups to fail or point to invalid addresses.
- **Validation**: All addresses must pass base58 regex validation: `^[1-9A-HJ-NP-Za-km-z]{32,44}$`. Normalization operations are restricted to trimming surrounding whitespace.

---

## 3. D23-A02: Point-in-Time Timestamps, On-Chain Slots & Monotonic Causality

### 3.1 Rejection of Fallacious Proxy Timestamps

The pilot eliminates all synthetic or misleading timestamp substitutes:

1. **`pairCreatedAt` Rejection**: `pairCreatedAt` represents the initial deployment time of the liquidity pool. It is strictly preserved as historical metadata and **never** used as a current market quote or reserve update timestamp.
2. **HTTP `Date` Header Rejection**: The HTTP `Date` header reflects the edge cache or reverse proxy server clock. It does **not** provide cryptographic or attested evidence of when on-chain trades or price updates occurred.
3. **Solana RPC `context.slot` Reality**: Solana RPC token-balance calls return a `context.slot` (the ledger slot at which the state was evaluated). While slots occur approximately every 400ms, they do not encode a sub-second millisecond timestamp directly. `getBlockTime(slot)` is approximate and rate-prohibitive.

### 3.2 Four Decoupled Timestamp & Context Dimensions

Every empirical observation explicitly records four distinct temporal dimensions:

```typescript
export interface EmpiricalObservationMetadata {
  /** 1. Monotonic client clock when outgoing HTTP/RPC request was dispatched */
  readonly requestDispatchedMs: number;

  /** 2. Monotonic client clock when HTTP/RPC response was received and parsed */
  readonly responseReceivedMs: number;

  /** 3. Provider-attested market update timestamp (null if not explicitly provided in payload) */
  readonly sourceReportedTimeMs: number | null;

  /** 4. Solana on-chain context slot returned by RPC (null for pure REST reads) */
  readonly onChainSlot: number | null;

  /** 5. RPC commitment level evaluated */
  readonly commitment: "confirmed" | "finalized" | null;
}
```

- If `sourceReportedTimeMs` is not explicitly provided by the provider payload, it is stored as `null` (`UNKNOWN`), **never** synthesized from `pairCreatedAt` or HTTP headers.

### 3.3 Decision-Time Causal Ordering & Sequence

To prevent lookahead bias in quantitative research, a candidate decision record $D$ at $t_{\text{decision}}$ must strictly satisfy:

$$t_{\text{request\_dispatched}} \le t_{\text{response\_received}} \le t_{\text{decision}}$$

1. **Sequential Creation**: A decision record is constructed **only after** the required observation has been received locally and parsed ($t_{\text{decision}} \ge t_{\text{response\_received}}$).
2. **No Retroactive Backfilling**: An observation requested or received after $t_{\text{decision}}$ can **never** be backfilled into contemporaneous decision features.
3. **Post-Decision Outcomes**: Trajectory observations at $+60\text{s}$ and $+300\text{s}$ are explicitly classified as post-decision **outcomes**, appended to `market-observations.jsonl`, and strictly segregated from decision-time feature vectors.
4. **Causality Violation Quarantine**: If $t_{\text{response\_received}} > t_{\text{decision}}$, the record is flagged with `discrepancyReason: "CAUSALITY_VIOLATION"` and quarantined. Violations are reported transparently and retained in metrics denominators (never dropped).

---

## 4. D23-A03: Empirical Field Availability, AMM Vault Verification & Hypotheses

### 4.1 Raydium AMM v4 On-Chain Vault Verification Architecture

Solana RPC's `getTokenAccountBalance` requires the public key of an **SPL token account** (vault), not the AMM pool account address. Querying a pool account directly with `getTokenAccountBalance` returns an RPC error.

To retrieve authoritative base and quote reserves ($x, y$), the pilot executes a verified discovery protocol:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                     RAYDIUM AMM v4 VAULT RESOLUTION PROTOCOL                           │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│  1. Fetch Pool Account Info:                                                           │
│     POST https://api.mainnet-beta.solana.com -> getAccountInfo(poolAddress)            │
│                                                                                        │
│  2. Cryptographic Owner & Program Verification:                                        │
│     Assert account.owner === "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"           │
│     (Fails closed if owner is not canonical Raydium AMM v4)                            │
│                                                                                        │
│  3. Binary Layout Parsing (752-byte Raydium AMM v4 Account Layout):                    │
│     - Base Token Decimals:  offset 4   (u8)                                            │
│     - Quote Token Decimals: offset 5   (u8)                                            │
│     - Base Vault Address:   offset 320..352 (Pubkey, base58)                           │
│     - Quote Vault Address:  offset 352..384 (Pubkey, base58)                          │
│     - Base Mint Address:    offset 400..432 (Pubkey, base58)                          │
│     - Quote Mint Address:   offset 432..464 (Pubkey, base58)                          │
│                                                                                        │
│  4. Vault Balance Ingestion:                                                           │
│     POST -> getMultipleAccounts([baseVault, quoteVault])                               │
│     Parse SPL Token Account balance (offset 64..72, u64 little-endian)                 │
│     Calculate decimal-adjusted integer reserves:                                       │
│       baseReserve  = rawBaseAmount / 10^baseDecimal                                    │
│       quoteReserve = rawQuoteAmount / 10^quoteDecimal                                  │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Handling of Unverified Reserves & Absolute Anti-Inference Prohibition

- **Unverified Reserve Flagging**: If pool layout parsing, owner verification, or vault balance retrieval fails, the collector marks:
  ```json
  {
    "baseReserve": null,
    "quoteReserve": null,
    "onChainReservesAvailable": false,
    "reserveUnavailabilityReason": "VAULT_RESOLUTION_FAILED",
    "missingFields": ["baseReserve", "quoteReserve"]
  }
  ```
- **Absolute Anti-Inference Rule**: **Raw integer reserves ($x, y$) must NEVER be inferred or back-calculated from DexScreener USD liquidity.**
  - _Rationale_: DexScreener USD liquidity is an external estimate derived from centralized or off-chain price oracles. Reverse-engineering $x$ and $y$ from USD liquidity creates synthetic circularity that would invalidate any empirical test of constant-product invariant $x \cdot y = k$ and produce fraudulent slippage estimates.

### 4.3 Unsupported H3 Fields Formally Designated Out of Scope

The following fields cannot be verified through DexScreener pair payloads or public RPC vault balances alone:

- **Developer Token Holdings %**: Requires scanning all token holder accounts for the mint.
- **LP Token Burn / Lock Status**: Requires resolving the LP mint address, its total supply, and burned holder accounts (`11111111111111111111111111111111` or Incinerator).
- **Mint & Freeze Authority Revocation**: Requires parsing the SPL token mint account data.

**Formal Determination**: These H3 safety fields are classified as **UNAVAILABLE / OUT OF SCOPE** for this read-only smoke pilot. They are serialized as `null` with explicit unavailability tags (`"UNVERIFIED_AUTHORITY"`, `"UNPARSED_LP_MINT"`).

### 4.4 Maintained Research Hypothesis Framework

| Hypothesis                             | Metric Focus                                                                  | Smoke Pilot Empirical Scope                                                         | Measurement vs Hypothesis                                                                                                                                                                  |
| :------------------------------------- | :---------------------------------------------------------------------------- | :---------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H1: AMM Depth & Slippage Impact**    | Constant-product invariant $x \cdot y = k$, execution slippage vs quoted spot | Verified Raydium AMM v4 base/quote vault reserves $(x, y)$ from Solana RPC          | **Field Availability**: Can on-chain vaults be resolved with verified ownership?<br/>**Hypothesis**: Do verified reserves yield predictive constant-product slippage curves?               |
| **H2: Order-Flow Momentum**            | 5-minute trade volume, buy count, sell count, buyer dominance ratio           | DexScreener `volume.m5`, `txns.m5.buys`, `txns.m5.sells` contemporaneously captured | **Field Availability**: Does DexScreener supply non-null 5m transaction counts?<br/>**Hypothesis**: Does high buyer dominance predict positive $+60\text{s}/+300\text{s}$ forward returns? |
| **H3: Structural Pool Risk**           | Developer holdings, LP burn %, freeze authority status                        | **UNAVAILABLE / OUT OF SCOPE** (Tagged `null` with explicit reason)                 | **Field Availability**: Identified as a documented empirical measurement capability gap.                                                                                                   |
| **H4: Capacity-Aware Position Sizing** | Trade size viability (0.05–0.10 SOL) within $\le 250$ bps slippage limit      | Evaluated strictly on pools where H1 reserves $(x, y)$ are verified                 | **Field Availability**: Dependent on H1 vault availability.<br/>**Hypothesis**: Does available pool depth support target trade sizes without excessive market impact?                      |

---

## 5. D23-A04: Architecture Compatibility, Canonical Tiers & D.2.2 Protection

### 5.1 Complete Preservation of Closed Milestone D.2.2

- The mock shadow collector implemented under Milestone D.2.2 (`backend/src/research/shadow/`) remains **CLOSED, FROZEN, AND UNTOUCHED**.
- Its internal `isApprovedMockProvider` attestation, prototype tamper detection, and fail-closed security boundaries intentionally reject all non-mock providers.
- No live network adapters will be injected into D.2.2 modules.

### 5.2 Separate D.2.3 Live Read-Only Runner & Adapter Boundary

Live collection logic is isolated in a separate, versioned namespace:

- Path: `backend/src/research/pilot/`
  - `LivePilotCollectorRunner.ts`: Orchestrates passive polling, token bucket limits, and session persistence.
  - `DexScreenerPublicAdapter.ts`: Read-only REST client for profiles and pair lookups.
  - `SolanaRpcPublicAdapter.ts`: Read-only RPC client for Raydium account info and vault balances.
  - `RaydiumAmmParser.ts`: Pure binary parser for 752-byte Raydium AMM v4 account layouts.
- **Shared Contracts Reused (Read-Only)**:
  - Schemas: `CandidateDecisionRecord`, `ShadowEvaluationRecord`, `MarketObservationRecord`, `SessionMetadata`, `SessionSummary`.
  - Record Validators: `validateCandidateDecisionRecord`, `validateShadowEvaluationRecord`, `validateMarketObservationRecord`.
  - Composite Research Foreign Key: Strict 5-tuple identity `[sessionId, candidateId/decisionId, poolAddress, tokenAddress, timestamp]`.

### 5.3 Canonical Project Execution Tier Taxonomy

The pilot strictly adopts the established canonical 5-tier project taxonomy:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                         CANONICAL 5-TIER EXECUTION TAXONOMY                            │
├────────┬────────────────────────────────┬──────────────────────────────┬───────────────┤
│ Tier   │ Level Name                     │ Data Source & Math           │ Pilot Status  │
├────────┼────────────────────────────────┼──────────────────────────────┼───────────────┤
│ Tier 1 │ Observed Market States         │ Public REST API / RPC reads  │ AUTHORIZED    │
│        │ (Reserves, prices, flows)      │ (DexScreener, Solana RPC)    │ (Read-Only)   │
├────────┼────────────────────────────────┼──────────────────────────────┼───────────────┤
│ Tier 2 │ Synthetic Reserve Quotes       │ Constant-Product math        │ AUTHORIZED    │
│        │ (Calculated slippage curves)   │ ($x \cdot y = k$ equations)  │ (Local Math)  │
├────────┼────────────────────────────────┼──────────────────────────────┼───────────────┤
│ Tier 3 │ Live Aggregator Quotes         │ Jupiter Quote API, etc.      │ UNAUTHORIZED  │
│        │ (Executable route evaluation)  │                              │ (Zero Calls)  │
├────────┼────────────────────────────────┼──────────────────────────────┼───────────────┤
│ Tier 4 │ Simulated Fills                │ Modeled paper execution      │ AUTHORIZED    │
│        │ (Counterfactual P/L tracking)  │ (Counterfactual research)    │ (Evaluation)  │
├────────┼────────────────────────────────┼──────────────────────────────┼───────────────┤
│ Tier 5 │ Real Execution                 │ Live on-chain transaction    │ STRICTLY      │
│        │ (Keypair signing & broadcast)  │ broadcast & wallet mutation  │ PROHIBITED    │
└────────┴────────────────────────────────┴──────────────────────────────┴───────────────┘
```

- **Zero Tier 3 Calls**: No Jupiter or DEX aggregator APIs are contacted.
- **Zero Tier 5 Activity**: Virtual wallet remains frozen (`7.9259 SOL`), zero keys loaded, zero transactions broadcast.

### 5.4 Canonical Session Statuses & Dual-File Consensus

- **Canonical Session Statuses**: The pilot uses strictly the accepted canonical status values:
  - `ACTIVE`: Session is actively collecting.
  - `FINALIZED`: Session has cleanly terminated and consensus has been achieved.
  - `INTERRUPTED`: Session was halted due to rate limits, resource breach, ungraceful crash, or operator stop.
  - _Non-canonical statuses like `CRASHED` or `COMPLETED` are prohibited._
- **Dual-File Consensus Characterization**:
  - The consensus mechanism between `session-meta.json` and `session-summary.json` is accurately defined as **deterministic SHA-256 digest cross-reconciliation** across record counts, byte counts, and final sequence IDs, **not** as cryptographic asymmetric authentication.

---

## 6. D23-A05: Linux Pilot Operations, 2-Hour Smoke Test & Parallel Development

### 6.1 Initial Two-Hour Smoke Test Protocol

The first operational deployment of Milestone D.2.3 is explicitly bounded as an **empirical availability smoke test**:

- **Duration**: Exactly **2 hours** (automatic shutdown via timer).
- **Core Purpose**: Verify real-world provider availability, rate limits, schema alignment, Raydium vault resolution success rates, and causal timestamp integrity.
- **Availability Targets as Research Hypotheses**:
  - The targets of **100 candidate decisions**, **$\ge 20$ distinct pools**, and **$\ge 85\%$ reserve availability** are **empirical hypotheses about data availability**, not guaranteed performance quotas.
  - If fewer than 100 candidates are discovered, or if reserve completeness is below 85%, this constitutes a **measured empirical research outcome** regarding public Solana API limitations, not a software failure.
- **Separate Multi-Day Authorization Gate**:
  - Any subsequent extended collection (e.g. 14-day endurance run) requires a **separate formal review and explicit operator approval** based on the analyzed smoke test evidence package.

### 6.2 Fedora Host Operational Safeguards

1. **Prior Process Verification & Historical Data Preservation**:
   - Before deploying any new runner, verify that the canceled 168-hour process is fully terminated:
     `pgrep -fa "nexustrade|node" || echo "CLEAN"`
   - Confirm that historical data files in `data/` and legacy directories remain untouched and preserved.
2. **System Sleep & Lid-Switch Inhibition**:
   - To prevent laptop sleep during collection, wrap process execution with systemd inhibitor:
     `systemd-inhibit --what=sleep:idle:handle-lid-switch --who="NeXusTrade-Pilot" --why="D23 Smoke Test" node dist/research/pilot/run.js`
3. **Realistic Process RSS Ceiling**:
   - Node.js LTS baseline RSS typically occupies 70–120 MB. A 128 MB RSS ceiling risks premature failure.
   - **Enforced Budget**: The memory RSS ceiling is adjusted to **256 MB**, actively monitored on every collection loop iteration. If RSS exceeds 256 MB, the collector initiates an orderly `INTERRUPTED` drain.
4. **Offline Export & SHA-256 Manifest Generation**:
   - Upon session finalization on Fedora, a `manifest.json` is generated containing the file size and SHA-256 hash of every `.json` and `.jsonl` file in the session directory.
   - When copied to Windows, research analysis scripts verify the SHA-256 manifest before ingestion by the D.1 evaluation engine.

### 6.3 Parallel Development Policy During Collection

To allow continued software development on Windows without compromising active research data:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                           PARALLEL DEVELOPMENT POLICY                                  │
├─────────────────────────────────────────────────┬──────────────────────────────────────┤
│               FEDORA COLLECTOR HOST             │        WINDOWS DEVELOPMENT HOST      │
├─────────────────────────────────────────────────┼──────────────────────────────────────┤
│  • Pinned Git Tag / Commit:                     │  • Active Development Branches:      │
│    pilot/d23-smoke-v1                           │    feature/backtest-tooling          │
│  • Frozen, immutable configuration.             │    feature/research-analysis         │
│  • Zero git pulls, zero live code edits.        │  • Permitted Activities:             │
│  • Runs read-only collection process.           │    - Code cleanup & refactoring      │
│  • Writes strictly to local isolated filesystem.│    - Unit and regression test suites │
│                                                 │    - Backtest & quantitative tools   │
│                                                 │    - UI & documentation updates      │
│                                                 │    - Analysis of frozen datasets     │
│                                                 │  • STRICTLY PROHIBITED:              │
│                                                 │    - Altering running collector code │
│                                                 │    - Changing recorded schemas       │
│                                                 │    - Modifying live cohort rules     │
│                                                 │    - Mutating Gen 1 wallet / PAPER   │
└─────────────────────────────────────────────────┴──────────────────────────────────────┘
```

---

## 7. Refined Objective Acceptance Criteria (ACC-01 through ACC-08)

| ID         | Criterion                                       | Quantitative Target / Verification Method                                                                                          | Empirical Research Meaning                                                          |
| :--------- | :---------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------- |
| **ACC-01** | **Candidate Discovery & Pool Diversity**        | Record up to 100 candidates across $\ge 20$ pools (or record exact observed census over 2h).                                       | Tests real-world token profile churn on DexScreener.                                |
| **ACC-02** | **On-Chain Reserve Availability (H1)**          | Measure % of Raydium AMM v4 pools with verified on-chain base/quote vault reserves.                                                | Evaluates Solana RPC vault resolution feasibility without paid archive nodes.       |
| **ACC-03** | **Causal Monotonicity & Slot Provenance**       | **100%** compliance with $t_{\text{req}} \le t_{\text{recv}} \le t_{\text{decision}}$; 0 lookahead leaks; on-chain slots recorded. | Guarantees research dataset contains zero future information leaks.                 |
| **ACC-04** | **Contemporaneous Flow Completeness (H2)**      | Record 5m volume, buys, sells; tag unavailable fields explicitly as `null`.                                                        | Measures DexScreener 5m flow availability at discovery time.                        |
| **ACC-05** | **Forward Outcome Trajectory Tracking**         | Track post-decision price observations at $t+60\text{s}$ and $t+300\text{s}$ into `market-observations.jsonl`.                     | Evaluates counterfactual forward outcomes decoupled from decision features.         |
| **ACC-06** | **Case-Sensitive Pool Identity Binding**        | **100%** exact base58 match; 0 lowercased public keys; composite 5-tuple foreign key integrity.                                    | Prevents address corruption and guarantees relational integrity across records.     |
| **ACC-07** | **Dual-File Digest Consensus & Resource Quota** | Exact line counts and IDs reconcile; disk usage $\le 20$ MB; RSS $\le 256$ MB.                                                     | Verifies bounded resource consumption and state integrity under fail-closed limits. |
| **ACC-08** | **Downstream D.1 Quantitative Ingestion**       | Resulting session directory ingests into D.1 `evaluateSessionHypotheses` without parse errors.                                     | Validates that empirical data is immediately actionable for quantitative research.  |

---

## 8. Summary of Addendum Reconciliations

| Review Finding                              | Specific Addendum Resolution                                                                                                                                                                                                                        | Section Reference |
| :------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------- |
| **D23-A01** (Candidate Discovery)           | Replaced raw profile assumption with 2-stage discovery: profile lookup $\to$ pair lookup $\to$ Raydium AMM v4 verification. Disclosed selection bias. Enforced case-sensitive base58 address validation (no lowercasing).                           | Section 2         |
| **D23-A02** (Timestamps & Causality)        | Rejected `pairCreatedAt` and HTTP `Date` as update timestamps. Implemented 4 decoupled timestamp/slot dimensions. Enforced $t_{\text{recv}} \le t_{\text{decision}}$. Decoupled forward trajectories as outcomes. Quarantined causality violations. | Section 3         |
| **D23-A03** (Vault Verification)            | Specified Raydium AMM v4 752-byte layout parsing and owner verification. Prohibited inferring raw reserves from USD liquidity. Designated H3 safety fields (dev holdings, LP burn) as explicitly unavailable.                                       | Section 4         |
| **D23-A04** (Architecture & Tiers)          | Preserved D.2.2 as closed and immutable. Created separate `backend/src/research/pilot/` module. Aligned with canonical 5-tier execution taxonomy. Enforced canonical statuses (`ACTIVE`, `FINALIZED`, `INTERRUPTED`).                               | Section 5         |
| **D23-A05** (Linux Smoke Test & Operations) | Structured pilot as a 2-hour availability smoke test. Adjusted memory ceiling to realistic 256 MB RSS. Formulated Fedora process verification, systemd inhibit, SHA-256 export manifest, and parallel development policy.                           | Section 6         |

This addendum resolves all five findings raised in the independent review and prepares Milestone D.2.3 for bounded, read-only implementation upon operator approval.
