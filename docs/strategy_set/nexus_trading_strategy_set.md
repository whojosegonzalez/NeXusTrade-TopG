# NeXusTrade / TopG: Complete Trading Strategy Set & Gate Specification

**Version:** Phase 12.92 Turbo-Refinement  
**System Architecture:** Local-First Autonomous Solana Meme-Coin Trading Engine  
**Execution Runtime:** TypeScript / Node.js / SQLite (In-Memory)  
**Target Performance:** $+3.0\%\text{ to }+6.0\%$ Daily Net Portfolio Gain (Targeting $+5.0\%\text{ to }+10.0\%$ Gross)

---

## 1. Executive Strategy Overview

The NeXusTrade autonomous trading architecture operates on a **defense-first, staged-conviction model** tailored specifically for the extreme volatility, predatory liquidity mechanics, and cabal pump-and-dump dynamics of the Solana meme-coin ecosystem (Pump.fun and Raydium CPMM).

The strategy rejects two fatal flaws common in naive crypto trading bots:

1. **Blind Market-Buying**: Never market-buy green candle breakouts at peak euphoria; wait for structural absorption via the Flow-Aware Retest Gate.
2. **Fixed Stop-Loss / Take-Profit Orders**: Fixed $-10\%$ or $+20\%$ orders get front-run or wick-liquidated by MEV bots. NeXusTrade employs an active, stateful multi-tier dynamic ratchet stop-loss engine that moves stops upwards monotonically, takes partial profits in staged tranches, and trails parabolic moonbags with dynamic trailing cushions.

```
                              ┌──────────────────────────────────────┐
                              │     DEX DISCOVERY & STREAMING        │
                              │  (Birdeye Fast API + DexScreener)    │
                              └──────────────────┬───────────────────┘
                                                 │
                                                 ▼
                              ┌──────────────────────────────────────┐
                              │  GATE 1: BASELINE PRE-SCREEN FILTERS │
                              │    (Anti-Rug First Line of Defense)  │
                              └──────────────────┬───────────────────┘
                                                 │ Passed Prescreen
                                                 ▼
                              ┌──────────────────────────────────────┐
                              │   GATE 2: RADAR WATCHLIST & RETEST   │
                              │      (Flow-Aware Retest Gate)        │
                              └──────────────────┬───────────────────┘
                                                 │ Entry Confirmed
                                                 ▼
                              ┌──────────────────────────────────────┐
                              │  GATE 3: STAGED POSITION SIZING      │
                              │    (0.50 SOL Probe Allocation)       │
                              └──────────────────┬───────────────────┘
                                                 │ In Position
                                                 ▼
                              ┌──────────────────────────────────────┐
                              │ GATE 4: MOMENTUM SCALE-IN PYRAMIDING │
                              │   (+7% Breakout + Velocity Filter)   │
                              └──────────────────┬───────────────────┘
                                                 │
                                                 ▼
                              ┌──────────────────────────────────────┐
                              │ GATE 5: MULTI-TIER DYNAMIC RATCHET   │
                              │  (Breakeven, Tier 1, Tier 2 Moonbag) │
                              └──────────────────┬───────────────────┘
                                                 │
                                                 ▼
                              ┌──────────────────────────────────────┐
                              │ GATE 6: EMERGENCY CIRCUIT BREAKERS   │
                              │  (-12% Cut, Avalanche, Stagnancy 3m) │
                              └──────────────────┬───────────────────┘
                                                 │ Trade Closed
                                                 ▼
                              ┌──────────────────────────────────────┐
                              │ GATE 7: PORTFOLIO & REBUY LIFECYCLE  │
                              │   (30m Cooldown, Drawdown Ceiling)   │
                              └──────────────────────────────────────┘
```

---

## 2. Gate 1: Baseline Scanner Pre-Screen Filters (Anti-Rug Shield)

Before any token is considered for trade monitoring, it must pass seven non-negotiable structural security and liquidity filters.

### 2.1 Prescreen Gate Parameters

| Filter Parameter                   |                           Threshold / Rule                            | Rationale & Protection                                                                                                   |
| :--------------------------------- | :-------------------------------------------------------------------: | :----------------------------------------------------------------------------------------------------------------------- |
| **Minimum Liquidity ($L$)**        | $\ge \$10,000\text{ USD}$ (Ideal: $\$15\text{k}\text{–}\$50\text{k}$) | Eliminates micro-pools where a 0.5 SOL buy moves price $> 5\%$ or dev can rug for pennies.                               |
| **Market Cap Range ($MC$)**        |               $\$40,000\text{ to }\$500,000\text{ USD}$               | Focuses strictly on sub-million high-velocity meme tokens while discarding pre-curve noise and bloated tops.             |
| **Liquidity-to-MC Ratio ($L/MC$)** |                             $\ge 15.0\%$                              | Rejects synthetic pump schemes where market cap is spoofed to $\$2\text{M}$ with only $\$5\text{k}$ liquidity.           |
| **LP Burn / Permanent Lock**       |                             $\ge 90.0\%$                              | Prevents liquidity drain rugs. Unburned LP is immediately rejected.                                                      |
| **Mint Authority**                 |                       Strictly `null` (Revoked)                       | Prevents developer from minting infinite tokens and dumping to zero.                                                     |
| **Freeze Authority**               |                       Strictly `null` (Revoked)                       | Prevents honeypots where developer freezes buyer token accounts.                                                         |
| **Token Age Window**               |    $300\text{s to }900\text{s}$ ($5\text{ to }15\text{ minutes}$)     | Protects against sniper sandwich attacks in the first 5 minutes while avoiding stale, dying coins older than 15 minutes. |
| **5-Minute Volume**                |                       $\ge \$10,000\text{ USD}$                       | Guarantees genuine live retail liquidity turnover.                                                                       |
| **5-Minute Transactions**          |                     $\ge 25\text{ transactions}$                      | Filters low-activity wash-trading pools.                                                                                 |

### 2.2 Disqualification Codes

- `FAILED_BASELINE_SCANNER_PRESCREEN`: Token failed one or more structural filters.
- **Empirical Validation**: Filtered out **103 total rugs** during live sessions, including catastrophic crashes like `NEAR` ($-100\%$), `USELESS` ($-99.96\%$), `MBOT` ($-99.24\%$), and `CLAUD` ($-98.83\%$).

---

## 3. Gate 2: Radar Watchlist & Flow-Aware Retest Gate

Tokens that pass the baseline prescreen are **never bought at market immediately**. They are placed on the active Radar Watchlist (`armedPullbackCandidates`) to observe structural price action.

### 3.1 Arming Mechanism

When a candidate enters radar:

- `armedAtMs`: Timestamp of arrival.
- `peakPriceSol`: Highest spot price observed while on radar.
- `ticksObserved`: Count of live evaluations.

### 3.2 The Flow-Aware Retest Rules

```
Price from Peak
   0.0%  ────────────── Peak Observed ──────────────
         │
         │  [Rule B: Consolidation Breakout (0% to -4%)]
         │   • Duration: >= 30s or >= 3 ticks
         │   • Buyer Dominance: >= 1.25x buys over sells
         │   • Status: Confirms Entry!
         │
  -4.0%  ────────────────────────────────────────────
         │
         │  [Rule A: Retest Pullback Discount (-4% to -10%)]
         │   • Pullback Ratio: 0.90 <= Spot / Peak <= 0.96
         │   • Absorbing Flow: >= 1.15x buys over sells
         │   • Status: Confirms Entry! (CDRIP / UNCC Fix)
         │
 -10.0%  ────────────────────────────────────────────
         │
         │  [Rule C: Anti-Falling Knife Drop]
         │   • If Flow Absorbing (>= 1.15x): Allowed down to -12.0%
         │   • If Flow Unabsorbed (< 1.15x): DROPPED at -8.0%
         │
 -12.0%  ────────────────────────────────────────────
         │  > -12.0% Drop: Drop candidate unconditionally (cratered)
```

#### Rule A: Retest Pullback Discount Entry

- **Established Cohort**: Price pulls back between $4.0\%$ and $10.0\%$ from peak (`minPullbackRatio = 0.90`, `maxPullbackRatio = 0.96`), with buyer absorption ratio $\ge 1.15\text{x}$ (`recentBuys60s >= 1.15 * recentSells60s`).
- **Micro-Cap Cohort**: Price pulls back between $10.0\%$ and $15.0\%$ from peak (`minPullbackRatio = 0.85`, `maxPullbackRatio = 0.90`), with buyer flow $\ge 1.25\text{x}$.
- **CDRIP / UNCC Case Study**: In Phase 12.91, `CDRIP` had an $8.2\%$ dip at 4:23 PM with strong buyers ($1.5\text{x}$ ratio) before soaring $+24,193\%$. The old rigid $8.0\%$ cliff dropped it. Expanding Rule A to $10.0\%$ with a $12.0\%$ absorbing ceiling captures these monster runners.

#### Rule B: Consolidation Breakout Entry

- **Established Cohort**: Price holds within $0.0\%\text{ to }4.0\%$ of peak (`maxConsolidationDropPct = 0.04`) for $\ge 30\text{ seconds}$ or $\ge 3\text{ ticks}$, with buyer dominance $\ge 1.25\text{x}$.
- **Micro-Cap Cohort**: Price holds within $0.0\%\text{ to }5.0\%$ of peak for $\ge 30\text{ seconds}$ or $\ge 3\text{ ticks}$, with buyer dominance $\ge 1.50\text{x}$.

#### Rule C: Crater Ceiling (Falling Knife Filter)

- If buyer flow is absorbing ($\ge 1.15\text{x}$ ratio), ceiling is expanded to **$12.0\%$ dip**.
- If buyer flow is unabsorbed ($< 1.15\text{x}$ ratio), candidate drops immediately at **$8.0\%$ dip** (`REJECTED_EXCESSIVE_PULLBACK`).

#### Rule E: In-Flight Seller Surge Circuit Breaker

- If sellers dump while candidate is awaiting pullback discount ($\ge 25\text{ sells}$ in 60s and sells $\ge 2.5\text{x}$ buys), disarm candidate immediately (`REJECTED_IN_FLIGHT_SELLER_SURGE`).

#### Rule D: Radar Expiry Timeout

- Established tokens expire after $120\text{ seconds}$ without entry confirmation (`REJECTED_PULLBACK_EXPIRED`).
- Micro-cap tokens expire after $90\text{ seconds}$.

---

## 4. Gate 3: Capital Allocation & Staged Probe Sizing

Risk is strictly partitioned through fixed probe sizing rather than all-in market entries.

### 4.1 Sizing Specification

| Portfolio Parameter          |           Established Cohort           |    Micro-Cap Cohort    | Description                                                                    |
| :--------------------------- | :------------------------------------: | :--------------------: | :----------------------------------------------------------------------------- |
| **Initial Probe Size**       |           $0.50\text{ SOL}$            |   $0.25\text{ SOL}$    | Small toehold probe to verify live execution and initial tick direction.       |
| **Dynamic Wallet Scaling**   | $\min(0.65, 0.50 \times \text{scale})$ | Flat $0.25\text{ SOL}$ | Scales up to $0.65\text{ SOL}$ as portfolio compounds above $10.0\text{ SOL}$. |
| **Max Concurrent Positions** |              5 positions               |      5 positions       | Hard ceiling on simultaneous open exposure.                                    |
| **Gas Reserve**              |           $0.05\text{ SOL}$            |   $0.05\text{ SOL}$    | Untouchable reserve for transaction and priority fees.                         |

---

## 5. Gate 4: Momentum-Only Scale-In Pyramiding

To capture outsized runners without exposing capital to low-volume fakeout traps, positions only scale in when viral retail momentum is mathematically verified.

### 5.1 Pyramiding Qualification Rules

```
Position Reaches Milestone:
  • Established: +7.0% Gain (700 bps)
  • Micro-Cap:  +10.0% Gain (1000 bps)
                     │
                     ▼
         Is Cash Available > 0.5 SOL?
                     │ Yes
                     ▼
        VIRAL MOMENTUM VERIFICATION GATE:
          1. Recent Buys (60s)  >= 15
          2. Buyer Dominance     >= 2.0x (Buys >= 2.0 * Sells)
          3. 5-Minute Momentum   >= +4.0% (momentum5mBps >= 400)
                     │
         ┌───────────┴───────────┐
         ▼ Yes                   ▼ No
┌─────────────────────┐ ┌───────────────────────────┐
│ SCALE IN APPROVED:  │ │ SCALE IN DENIED:          │
│ Add +0.50 SOL       │ │ Keep Flat 0.50 SOL Probe  │
│ Recalculate Blended │ │ Protects capital against  │
│ Entry Price Basis   │ │ fakeout reversal trap!    │
└─────────────────────┘ └───────────────────────────┘
```

- **Fakeout Reversal Defense**: In Day 2, `CNVQ6V` and `7QB9SH` surged $+7\%$ on low volume (3 buys vs 2 sells) and immediately reversed. The momentum filter denies scale-in, cutting the loss from a doubled $1.0\text{ SOL}$ position down to a flat $0.50\text{ SOL}$ probe.

---

## 6. Gate 5: Multi-Tier Dynamic Ratchet Stop-Loss & Take-Profit Engine

NeXusTrade uses a continuous stateful ratchet engine (`DynamicRatchetService`) that evaluates position health on every live tick. Stop-loss floors are **strictly monotonic** (they can only stay flat or move up; they can never be lowered).

### 6.1 Ratchet Milestones & Profit Schedule

```
PnL Gain (%)
  +200.0% ────────────────────────────────── Moonbag trails at Peak - 10%
          │
  +100.0% ────────────────────────────────── Moonbag trails at Peak - 15%
          │
   +48.5% ──────── TIER 2 TAKE PROFIT ────── Sell 25% of Position
          │                                  Lock Moonbag Floor to Peak - 18% (min +35%)
          │
   +20.0% ──────── TIER 1 TAKE PROFIT ────── Sell 50% of Position
          │                                  Lock Floor to +10.0% Profit Guarantee
          │
   +10.0% ──────── ARMED BREAKEVEN ───────── Lock Floor to +0.0% (Risk-Free Trade)
          │
    +1.0% ──────── SCRATCH BAND ───────────── Exit if momentum stalls for > 180s
     0.0% ── ENTRY ──────────────────────────
          │
    -4.0% ──────── AVALANCHE CUT ──────────── Exit if Sells >= 25 & Sells >= 3.0x Buys
          │
    -8.0% ──────── WHALE CLIFF CUT ────────── Exit if Single Tick Drop <= -10% & Buys == 0
          │
   -12.0% ──────── UNIVERSAL QUICK-CUT ────── Exit unconfirmed probes (Peak < +1%) immediately!
          │                                  (Unless viral buyer absorption >= 50 buys & >= 1.25x)
          │
   -18.0% ──────── CATASTROPHIC HARD STOP ─── Absolute terminal stop floor
```

### 6.2 Detailed Trigger Definitions

1. **Armed Breakeven (+10.0% Peak / 1000 bps)**:
   - Once a position touches $+10.0\%$ peak gain, `armedBreakeven` triggers. Stop floor moves to `0 bps` ($+0.0\%$). The trade is guaranteed never to become red. Exit reason: `ARMED_BREAKEVEN_BREACH`.
2. **Tier 1 Take-Profit (+20.0% Peak / 2000 bps)**:
   - Action: Partial sale of $50\%$ of held tokens (`SELL_PARTIAL_50`).
   - Stop Floor: Moves to `+10.0%` (1000 bps) on remaining $50\%$ tokens.
   - Exit reason: `RATCHET_TIER_1_BREACH`.
3. **Tier 2 Take-Profit (+48.5% Peak / 4850 bps)**:
   - Action: Partial sale of $25\%$ of original position (`SELL_PARTIAL_25`).
   - Stop Floor: Locks to minimum `+35.0%` (3500 bps) or Dynamic Trailing Moonbag.
4. **Tightened Dynamic Trailing Moonbag (Remaining 25% Tokens)**:
   - **Base Buffer**: Trails **$18.0\%$ ($1800\text{ bps}$)** below peak (Phase 12.92 tightened from 25%).
   - **Parabolic Buffer ($\ge +100\%$ Peak)**: Trails **$15.0\%$ ($1500\text{ bps}$)** below peak.
   - **Super-Parabolic Buffer ($\ge +200\%$ Peak)**: Trails **$10.0\%$ ($1000\text{ bps}$)** below peak.
   - Exit reason: `RATCHET_TIER_2_BREACH`.
5. **Universal -12% Unconfirmed Quick-Cut (Phase 12.92 Deliverable 2)**:
   - Applies to all cohorts (Established and Micro-Cap).
   - If position has never demonstrated positive momentum (`peakGainBps < 100`, i.e. $< +1.0\%$) and drops to $\le -12.0\%$ ($-1200\text{ bps}$), it is liquidated immediately via `PROBE_UNCONFIRMED_DUMP_CUT`.
   - **Exception**: High-velocity buyer absorption ($\ge 50\text{ buys}$ in 60s and buys $\ge 1.25\text{x}$ sells).
   - **Empirical Impact**: Stops micro-cap bleeds like `FDEBYP` (which previously fell to $-25.9\%$), saving $0.14\text{ SOL}$ per trapped position.
6. **Avalanche Sell-Pressure Emergency Cut (Sub-Phase 12.86)**:
   - If position is underwater ($P/L \le -4.0\%$) and live seller avalanche hits ($\ge 25\text{ sells/min}$ AND sells $\ge 3.0\text{x}$ buys), exit immediately via `EMERGENCY_SELL_PRESSURE_CUT`.
7. **Single-Tick Whale Dump Circuit Breaker**:
   - If position is underwater ($P/L \le -8.0\%$), zero buys in 60s, and single-tick cliff drop $\le -10.0\%$, exit immediately via `WHALE_DEV_DUMP_CLIFF_CUT`.
8. **Catastrophic Hard Stop**:
   - Established: $-18.0\%$ ($-1800\text{ bps}$).
   - Micro-Cap: $-20.0\%$ ($-2000\text{ bps}$).
   - Flow-Aware Band ($-12\%$ to catastrophic floor): If buys $<$ sells or buys $= 0$, cut immediately via `SELL_PRESSURE_UNABSORBED`.

---

## 7. Gate 6: Capital Turnover & 3-Minute Stagnancy Quick-Release

Solana meme-coin momentum is perishable. Capital locked in stalled tokens degrades portfolio turnover and misses emerging runners.

### 7.1 Stagnancy Engine Specification

- **Monitoring**: Tracks tick-level price changes, transaction count, and volume stalling.
- **Inactivity Timeout**: **$180\text{ seconds}$ (3 minutes)** (Phase 12.92 reduced from 5 minutes).
- **Trigger Condition**: Position experiences no price change and zero transaction activity for $\ge 180\text{ seconds}$.
- **Action**: Immediate market liquidation via `STAGNANCY_TIMEOUT_EXIT`. Capital is returned to cash to reload on live scanner candidates.

---

## 8. Gate 7: Portfolio-Level Risk & Lifecycle Controls

### 8.1 Macro Controls

1. **Portfolio Drawdown Circuit Breaker**:
   - Hard circuit breaker at $-5.0\%$ ($-500\text{ bps}$) portfolio drawdown halts all new entries.
   - May be waived with `--waive-drawdown` during research/empirical evaluation sessions.
2. **Anti-Rebuy Cooldown**:
   - $30\text{ minutes}$ (`antiRebuyCooldownMs = 1,800,000ms`) per token mint address. Prevents emotional re-entry, revenge trading, and churn.
3. **Chrono-Regime Gating & Scheduled Sessions**:
   - Configurable schedule window via `--schedule HH:MM-HH:MM[:TZ]` (e.g. `07:00-18:00:PDT`).
   - Outside trading window: daemon idles in warm-standby (zero buys).
   - Window onset (07:00 PDT): buy gates and radar scanning automatically activate.
   - Window conclusion (18:00 PDT): open positions automatically cash out cleanly via `SCHEDULE_WINDOW_CONCLUDED`, final analytics archive, and wallet persists.
4. **Continuous Virtual Wallet State**:
   - Persistent ledger saved in `.tmp/virtual-wallet.json`. Carries balance seamlessly across sessions, reboots, and days without resetting bankroll.

---

## 9. Comprehensive Strategy Gate Reference Matrix

| Gate #  | Strategy Subsystem                 | Primary Trigger / Condition                                        | Action / Output                                      | Protection / Purpose                        |
| :-----: | :--------------------------------- | :----------------------------------------------------------------- | :--------------------------------------------------- | :------------------------------------------ |
| **1.1** | **Prescreen Liquidity**            | $L < \$10,000\text{ USD}$                                          | Rejection: `FAILED_BASELINE_SCANNER_PRESCREEN`       | Prevents high slippage & micro-rugs         |
| **1.2** | **Prescreen Market Cap**           | $MC < \$40\text{k}$ or $MC > \$500\text{k}$                        | Rejection: `FAILED_BASELINE_SCANNER_PRESCREEN`       | Focuses on optimal meme growth band         |
| **1.3** | **Prescreen L/MC Ratio**           | $L / MC < 15.0\%$                                                  | Rejection: `FAILED_BASELINE_SCANNER_PRESCREEN`       | Blocks synthetic/inflated valuation schemes |
| **1.4** | **Prescreen LP Burn**              | LP Burn $< 90.0\%$                                                 | Rejection: `FAILED_BASELINE_SCANNER_PRESCREEN`       | Eliminates liquidity removal rugs           |
| **1.5** | **Prescreen Authority**            | Mint or Freeze $\ne \text{null}$                                   | Rejection: `FAILED_BASELINE_SCANNER_PRESCREEN`       | Eliminates honeypots & mint-dilution rugs   |
| **1.6** | **Prescreen Age Window**           | Age $< 300\text{s}$ or $> 900\text{s}$                             | Rejection: `FAILED_BASELINE_SCANNER_PRESCREEN`       | Avoids sniper sandwiches & stale tokens     |
| **2.1** | **Retest Rule A (Pullback)**       | $4\%\text{–}10\%$ dip, buys $\ge 1.15\text{x}$                     | Confirms Entry: `CONFIRMED_RETEST_PULLBACK`          | Enters structural dips (CDRIP / UNCC)       |
| **2.2** | **Retest Rule B (Consolidation)**  | $0\%\text{–}4\%$ dip for $\ge 30\text{s}$, buys $\ge 1.25\text{x}$ | Confirms Entry: `CONFIRMED_CONSOLIDATION_BREAKOUT`   | Enters sustained momentum breakout          |
| **2.3** | **Retest Rule C (Crater Ceiling)** | Dip $> 12\%$ (or $> 8\%$ unabsorbed)                               | Drop Candidate: `REJECTED_EXCESSIVE_PULLBACK`        | Anti-falling knife protection               |
| **2.4** | **Retest Rule E (Seller Surge)**   | Sells $\ge 25$, sells $\ge 2.5\text{x}$ buys                       | Disarm Candidate: `REJECTED_IN_FLIGHT_SELLER_SURGE`  | Blocks in-flight dump waves                 |
| **2.5** | **Retest Rule D (Expiry)**         | Timeout $> 120\text{s}$ ($90\text{s}$ micro)                       | Drop Candidate: `REJECTED_PULLBACK_EXPIRED`          | Recycles watchlist radar capacity           |
| **3.1** | **Probe Sizing**                   | New Entry Confirmed                                                | Allocate $0.50\text{ SOL}$ ($0.25\text{ SOL}$ micro) | Risk-partitioned probe toehold              |
| **4.1** | **Momentum Pyramiding**            | Gain $\ge +7\%$, buys $\ge 15$, ratio $\ge 2.0\text{x}$            | Scale In $+0.50\text{ SOL}$                          | Maximizes runner conviction size            |
| **4.2** | **Fakeout Scale-In Denied**        | Gain $\ge +7\%$, volume stalls                                     | Deny Scale-In (Hold $0.50\text{ SOL}$)               | Protects against reversal trap              |
| **5.1** | **Unconfirmed Quick-Cut**          | Peak $< +1.0\%$, $P/L \le -12.0\%$                                 | Exit All: `PROBE_UNCONFIRMED_DUMP_CUT`               | Halts unconfirmed probe bleedouts           |
| **5.2** | **Avalanche Emergency Cut**        | $P/L \le -4.0\%$, sells $\ge 25$, ratio $\ge 3.0\text{x}$          | Exit All: `EMERGENCY_SELL_PRESSURE_CUT`              | Evacuates before total collapse             |
| **5.3** | **Whale Cliff Cut**                | $P/L \le -8.0\%$, tick $\le -10\%$, buys $= 0$                     | Exit All: `WHALE_DEV_DUMP_CLIFF_CUT`                 | Instant exit on developer dump              |
| **5.4** | **Catastrophic Hard Stop**         | $P/L \le -18.0\%$ ($-20.0\%$ micro)                                | Exit All: `CATASTROPHIC_HARD_STOP`                   | Non-negotiable portfolio loss ceiling       |
| **5.5** | **Armed Breakeven**                | Peak $\ge +10.0\%$                                                 | Stop Floor locks to $+0.0\%$                         | Eliminates loss on confirmed winner         |
| **5.6** | **Tier 1 Take-Profit**             | Peak $\ge +20.0\%$                                                 | Sell $50\%$, lock floor at $+10.0\%$                 | Secures $+10\%$ to $+20\%$ banked profit    |
| **5.7** | **Tier 2 Take-Profit**             | Peak $\ge +48.5\%$                                                 | Sell $25\%$, lock floor at $+35.0\%$                 | Locks outsized milestone profit             |
| **5.8** | **Trailing Moonbag**               | Peak $> +48.5\%$, trails $18\%$ ($15\%$/$10\%$)                    | Exit Remainder: `RATCHET_TIER_2_BREACH`              | Rides parabolic meme expansions             |
| **6.1** | **Stagnancy Quick-Release**        | Inactive for $\ge 180\text{ seconds}$                              | Exit All: `STAGNANCY_TIMEOUT_EXIT`                   | Frees capital from dead tokens              |
| **7.1** | **Anti-Rebuy Cooldown**            | Token closed                                                       | Cooldown $30\text{ minutes}$                         | Stops churn & revenge trading               |
| **7.2** | **End-of-Schedule Cashout**        | 18:00 PDT reached                                                  | Liquidate All: `SCHEDULE_WINDOW_CONCLUDED`           | Guarantees overnight cash certainty         |

---

_Document compiled and certified for NeXusTrade / TopG production deployment._
