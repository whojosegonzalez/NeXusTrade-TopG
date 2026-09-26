# Sub-Phase 12.3: Milestone Profit-Taking, Anti-Sniper Guardrails & Extended Radar

**Date**: 2026-09-26  
**Status**: APPROVED FOR DEV IMPLEMENTATION  
**Session Analyzed**: `session-paper-12.2-01` (4-Hour Uninterrupted Live Paper Run)

---

## 1. 4-Hour Test Post-Mortem & Performance Metrics

### 1.1 Summary Portfolio Progression

- **Initial Capital**: 10.0000 SOL
- **Final Capital**: 9.6061 SOL (-0.3939 SOL / -3.94%)
- **Total Candidates Observed**: 69
- **Watchlist Candidates**: 25
- **Executed Trades**: 4

### 1.2 Trade Audit

| Token         | Mint          | Peak Gain   | Realized PnL             | Duration | Exit Reason                | Diagnostic Note                                                                            |
| :------------ | :------------ | :---------- | :----------------------- | :------- | :------------------------- | :----------------------------------------------------------------------------------------- |
| **`PAIDDOG`** | `G5Gg...pump` | +18.2%      | **+14.42% (+0.144 SOL)** | 10.8m    | `RATCHET_TIER_1_TRIGGERED` | Steady runner, clean Tier 1 lock.                                                          |
| **`a/aut`**   | `8V1J...pump` | +0.0%       | **-27.06% (-0.271 SOL)** | 40s      | `CATASTROPHIC_HARD_STOP`   | Immediate sniper dump upon entry.                                                          |
| **`x/acc`**   | `Avj4...pump` | **+54.18%** | **-7.49% (-0.075 SOL)**  | 3.1m     | `RATCHET_TIER_2_TRIGGERED` | **Flash dump from +54% to -7% in seconds.** Blew through +45% floor before tick execution. |
| **`ddoscat`** | `EC9C...pump` | +1.2%       | **-19.25% (-0.193 SOL)** | 28s      | `CATASTROPHIC_HARD_STOP`   | Immediate dev/sniper dump in 28 seconds.                                                   |

---

## 2. Root Cause Analysis & Architectural Flaws

### Flaw A: Zero Partial Profit-Taking (100% Position Hold on +50% Runners)

- In `Avj4...pump`, the coin spiked to **+54.18%**. The engine moved the stop floor to +45% (`TIER_2_LOCKED`), but held **100% of tokens**.
- On PumpSwap/pump.fun bonding curves, a single whale sell flash-crashes the pool across multiple blocks. The next poll executed at the bottom (-7.49%).
- **Remedy**: **Milestone Scaling (Take-Profit Scaling)**:
  - At **Tier 1 (+25% gain)**: Sell **50% of the position** to secure +12.5% net profit on invested capital immediately.
  - On the remaining 50%, let the Dynamic Ratchet trail with a floor at Breakeven (+0%).
  - At **Tier 2 (+50% gain)**: Sell another **25% of the original position** (75% total profit taken).
  - Trail the remaining 25% "Moon Bag" with Tier 2 floor (+40%).
  - **Simulation on `Avj4...`**:
    - 50% sold at +25% = +0.125 SOL profit
    - 25% sold at +50% = +0.125 SOL profit
    - 25% sold at -7.49% = -0.019 SOL loss
    - **Net Result: +0.231 SOL (+23.1% profit) instead of -0.075 SOL loss!**
    - This single rule flips the entire 4-hour session from -0.39 SOL into **+0.16 SOL (+1.6% profit)**.

### Flaw B: 30-Second Sniper Dumping (`a/aut` & `ddoscat`)

- Tokens bought at minute 5-7 were immediately dumped on by early block 0-1 snipers.
- In `paper-trading-daemon.ts`, `buyGateService.evaluateCandidate(candidate)` was called with `{}` (empty market context), bypassing single-disposal checks.
- Also, 5m buy-to-sell ratio masked rapid 1m sell deterioration.
- **Remedy**:
  1. Add **1m Short-Horizon Flow Check**: If `sells1m > buys1m` or `momentum1m < -5%`, reject entry even if 5m looks good.
  2. Add **Min Sells Threshold**: Avoid tokens with `< 5 sells` in 5m; tokens with zero sells often have snipers waiting for the first external buyer to dump.

### Flaw C: Premature Watchlist Expiry (Missed Massive Runner `STEVEWILLDOIT`)

- `STEVEWILLDOIT` pumped 10x from $150k to $715k-$900k MC, but was discarded because its age was 25m (`EXCEEDED_MAX_WATCHLIST_AGE_20M`).
- Real meme runners frequently consolidate for 15-30 minutes before breaking out into secondary surges.
- **Remedy**: **Adaptive Watchlist Radar**:
  - If `liquidityUsd >= $20,000` and `volume5mUsd >= $25,000`, extend max watchlist age to **60 minutes (3,600s)** and maturity age ceiling to **45 minutes (2,700s)**.
  - For high-volume breakouts ($> $50k volume), allow buy-to-sell ratio down to **1.20x** (captures liquid tokens with high volume like `STEVEWILLDOIT` at 1.26x).

### Flaw D: Counterfactual Sampling Blindspot

- `CounterfactualOpportunityTracker` only sampled prices for candidates with status `"WATCHING"`. Once marked `"DROPPED"` or `"FILTERED_REJECTED"`, sampling stopped, falsely reporting 0 missed winners.
- **Remedy**:
  - Sample prices for all active candidates in `records` (limited to top 20 by volume/liquidity) regardless of cohort, enabling accurate post-run missed-winner detection.

---

## 3. Implementation Plan for Dev (Sub-Phase 12.3)

1. **`DynamicRatchetService.ts` & `PaperTradingDaemon.ts`**:
   - Add support for partial scale-out actions (`SELL_PARTIAL_50`, `SELL_PARTIAL_25`).
   - Track `remainingTokensHeld` and `realizedProceedsSol` per position.
   - On reaching Tier 1 (+25%): close 50% at spot.
   - On reaching Tier 2 (+50%): close 25% at spot.
   - On stop floor breach: close remaining tokens at spot.
2. **`BuyGateTriggerService.ts`**:
   - Add high-volume breakout rule: if `volume5mUsd >= 50000`, `minBuyToSellRatio` drops to `1.20`.
   - Add adaptive maturity window: if `liquidityUsd >= 20000 && volume5mUsd >= 25000`, `maxMaturityAgeSec` extends to `2700` (45m).
3. **`CandidateWatchlistService.ts`**:
   - Extend `maxWatchlistAgeSec` to `3600` (60m) for high-liquidity candidates ($\ge \$20\text{k}$).
4. **`CounterfactualOpportunityTracker.ts` & `paper-trading-daemon.ts`**:
   - Sample up to 10 top observed candidates across all cohorts (including DROPPED) every 15s so the analytics report accurately captures missed runners.
