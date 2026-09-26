# Sub-Phase 12.4: Established Runners Engine, Strict Rug Immunity & Table Dashboard

**Date**: 2026-09-26  
**Status**: APPROVED FOR DEV IMPLEMENTATION  
**Session Analyzed**: `session-paper-12.3-01` (4-Hour Live Paper Run, Overnight PVP Window)

---

## 1. 4-Hour Test Audit & Breakthrough Proof

### 1.1 Performance Summary

- **Starting Portfolio**: `10.0000 SOL`
- **Ending Portfolio**: `8.5007 SOL` (**-1.4993 SOL / -14.99%**)
- **Observed Candidates**: 63
- **Executed Trades**: 9 (3 Wins, 6 Losses)
- **Avoided Rugs**: 11 (tokens filtered out that crashed -99% to -100%)

### 1.2 Trade Audit Table

| Token             | Mint          | Hold Time | Realized PnL             | Peak Gain  | Exit Reason                | Strategy Assessment                                                                                  |
| :---------------- | :------------ | :-------- | :----------------------- | :--------- | :------------------------- | :--------------------------------------------------------------------------------------------------- |
| `slopcannon`      | `55Vr...DEzW` | 61s       | **-19.79% (-0.198 SOL)** | +0.0%      | `CATASTROPHIC_HARD_STOP`   | Dev dump within 1 minute.                                                                            |
| `NEWGUY`          | `3BLS...wikM` | 17s       | **-38.92% (-0.389 SOL)** | +0.0%      | `CATASTROPHIC_HARD_STOP`   | Instant block-0 sniper rug.                                                                          |
| `6aHoh5Q5...`     | `6aHo...pump` | 81s       | **-13.87% (-0.139 SOL)** | +0.0%      | `CATASTROPHIC_HARD_STOP`   | Fast dump after entry.                                                                               |
| **`U2DcbVJm...`** | `U2Dc...pump` | 105s      | **+8.85% (+0.089 SOL)**  | **+25.0%** | `RATCHET_TIER_1_TRIGGERED` | **PARTIAL TAKE-PROFIT SUCCESS**: Sold 50% at +25%, booked net profit despite final exit below entry! |
| **`BmP71ELo...`** | `BmP7...NPAY` | 306s      | **+38.45% (+0.385 SOL)** | **+50.0%** | `RATCHET_TIER_2_TRIGGERED` | **MONSTER WIN**: Scaled out at Tier 1 (+25%) and Tier 2 (+50%), banking +38.45%!                     |
| `GPyM1ohx...`     | `GPyM...quyn` | 59s       | **-96.35% (-0.963 SOL)** | +0.0%      | `CATASTROPHIC_HARD_STOP`   | **100% Dev Liquidity Pull Rug.** Accounts for 64% of total session loss!                             |
| `3dMEcjM8...`     | `3dME...tA9q` | 148s      | **-27.15% (-0.271 SOL)** | +0.0%      | `CATASTROPHIC_HARD_STOP`   | Illiquid curve dump.                                                                                 |
| `FPf5b63b...`     | `FPf5...erXa` | 43s       | **-14.17% (-0.142 SOL)** | +0.0%      | `CATASTROPHIC_HARD_STOP`   | Fast dump.                                                                                           |
| **`924hu8kG...`** | `924h...ohoZ` | 153s      | **+13.01% (+0.130 SOL)** | **+25.0%** | `RATCHET_TIER_1_TRIGGERED` | **PARTIAL TAKE-PROFIT SUCCESS**: Scaled out 50% at Tier 1, locked +13.01% gain!                      |

---

## 2. Key Findings: What Worked vs. What Failed

### ✅ The Big Breakthrough: Milestone Partial Scaling Confirmed

The Sub-Phase 12.3 milestone profit-taking worked:

- **3 out of 3 winning trades** (`U2DcbVJm...`, `BmP71ELo...`, and `924hu8kG...`) used partial scaling to lock in profits before trailing stops triggered.
- `BmP71ELo...` generated **+38.45% (+0.385 SOL)**, and `U2DcbVJm...` generated **+8.85%** even though the final exit price dropped below entry!
- Total gross profit from winners was **+0.6031 SOL**.

### ❌ The Root Vulnerability: The 1:00 AM "Latest Profiles" Honeypot Trap

- All 6 losses were **instant rug pulls within 17 to 81 seconds**.
- `GPyM1ohx...` alone dumped 96% in 59 seconds, losing **-0.9635 SOL (64% of the entire net loss)**!
- **Why?** Our candidate stream exclusively queried `token-profiles/latest/v1`. At 1:00 AM – 4:00 AM, scammers pay $300 for a DexScreener profile banner, deploy a token on pump.fun, let automated bots buy the initial minute, and immediately pull liquidity.
- Brand new 5m–15m micro-caps under $20k liquidity have an extreme overnight mortality rate.

---

## 3. Sub-Phase 12.4 Architectural Specification

### 3.1 Dual-Stream Candidate Engine: 6h+ Established Runners (Stream B)

We will expand [`CandidateStreamEngine.ts`](file:///u:/Projects/TopG/backend/src/candidate-scanner/CandidateStreamEngine.ts) to ingest from two distinct streams:

1. **Stream A: Strict High-Liquidity Micro-Caps (< 2h age)**:
   - Minimum Liquidity: Raised from $2,500 to **$20,000** (eliminates low-liquidity honeypots).
   - Minimum Sells: Raised from 5 to **15 sells in 5m** (eliminates block-0 sniper traps).
   - LP Burn: Strictly 100%.

2. **Stream B: Established Runners (2h to 24h age - Organic Runners)**:
   - Query DexScreener top boosted and trending Solana pairs:
     - `https://api.dexscreener.com/token-boosts/top/v1`
     - `https://api.dexscreener.com/token-boosts/latest/v1`
     - `https://api.dexscreener.com/latest/dex/search?q=SOL`
   - Filter Criteria:
     - `assetAgeSeconds >= 7200` (2h) and `<= 86400` (24h).
     - `liquidityUsd >= 40,000`.
     - `marketCapUsd >= 100,000`.
     - `volume5mUsd >= 15,000` with `buys5m >= sells5m`.
   - **Why this eliminates the 60-second rug**: An established token with $40k+ liquidity that has survived 6 hours cannot be 100% rugged in 30 seconds by a dev. The dev has long sold, and the liquidity pool is mature.

### 3.2 Dynamic Risk & Position Sizing

In [`paper-trading-daemon.ts`](file:///u:/Projects/TopG/backend/src/scripts/paper-trading-daemon.ts):

- Replace fixed 1.0 SOL sizing with dynamic capital-based sizing:
  `positionSizeSol = Math.min(1.0, parseFloat(((daemon.getCashSol() - 0.05) / maxOpenPositions).toFixed(4)))`
- Ensures position sizes automatically scale down during drawdowns, preventing a single trade from risking >10% of portfolio.

### 3.3 Dashboard Usability Refactor: Tables & Dynamic Capacity

1. **Dynamic Capacity Indicator**:
   - Add `maxOpenPositions: this.config.maxOpenPositions` to `PaperTradingDaemonSnapshot`.
   - Update [`frontend/vite.config.ts`](file:///u:/Projects/TopG/frontend/vite.config.ts) to return `maxConcurrentPositions: raw.maxOpenPositions || 5` (fixes `0 / 3` bug).
2. **Table-Based Active Open Positions**:
   - In [`ActiveSessionView.tsx`](file:///u:/Projects/TopG/frontend/src/views/ActiveSessionView.tsx), replace `.positions-grid` cards with a clean `<table>`:
     - Columns: `Token / Symbol | Entry Price | Current Spot | Unrealized PnL | Peak Gain | Stop Floor | Tier Badge | Action (Market Close)`
     - Wrapped in a scrollable container (`max-height: 320px; overflow-y: auto`).
3. **Table-Based Live Session Activity Feed**:
   - Replace `.activity-feed` div list with a clean `<table>`:
     - Columns: `Time | Type Badge | Token | Exit / Spot Price | Realized PnL | Exit Reason`
     - Scrollable fixed height (`max-height: 280px; overflow-y: auto`).
