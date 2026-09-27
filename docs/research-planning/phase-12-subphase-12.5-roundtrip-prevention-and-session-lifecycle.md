# Sub-Phase 12.5: Round-Trip Prevention, Live Watchlist Polling & Session Lifecycle Finalization

**Date**: 2026-09-26  
**Status**: APPROVED FOR DEV IMPLEMENTATION  
**Session Analyzed**: `session-paper-12.4-01` (4-Hour Live Saturday Afternoon Session: **+7.08% Net Profit**)

---

## 1. 4-Hour Test Audit & Key Milestones

### 1.1 Financial Progression

- **Starting Portfolio**: `10.0000 SOL`
- **Final Portfolio Equity**: `10.7080 SOL` (**+0.7080 SOL / +7.08% NET PROFIT! 🟢**)
- **Total Candidates Observed**: 73
- **Executed Trades**: 12
- **Avoided Catastrophic Rugs**: 10 tokens filtered out that dropped -99% to -100%.
- **Zero 90%+ overnight rugs occurred** (the tightened $20k liquidity and 15-sell gates successfully eliminated block-0 honeypots).

### 1.2 Winning Mechanics Proven in Live Market

- **Partial Profit-Taking**:
  - `CMPksXm4...` surged to **+186.54% peak gain**. Partial scaling took profit at +25% and +50%, recovering **1.0478 SOL in hard cash** (more than 100% of initial capital) while trailing the remaining tokens.
  - `Normie8XeL...` booked **+35.44% (+0.354 SOL)**.
  - `DpoZVSB3...` booked **+32.90% (+0.329 SOL)**.
  - `4YHbtGNf...` booked **+19.25% (+0.193 SOL)**.
  - `DAemPFNc...` banked **+0.744 SOL cash** at Tier 1, trailing the rest.

---

## 2. Issues to Address & Root Cause Solutions

### Issue 1: Round-Trip Disaster (`aCfL...` / `C@T`)

- **The Event**: `aCfL...pump` ran up to **+22.76% peak gain**, missed Tier 1 (+24%) by 1.24%, stayed in `SMART HOLD`, and crashed straight through into a **-28.53% loss**.
- **Fix**:
  1. Lower Tier 1 trigger from +24% to **+15.0% (1,500 bps)**: sell 50% at +15%, and **immediately lock the trailing stop floor of the remaining 50% to Breakeven (+0.0%)**. Under this rule, `aCfL...` would have closed as a **+7.5% net win** instead of a -28.5% loss.
  2. Smart Hold "Never-Red-Again" Recovery: If a position enters `SMART HOLD` (negative drawdown) and subsequently climbs $\ge +8.0\%$, immediately advance its floor to **Breakeven (+0.0%)**.

### Issue 2: Watchlist Data Freezing on Stale Snapshots (`GROWTREES`)

- **The Event**: `GROWTREES` was pumping on DexScreener from \$53k to \$63k MC and crossed \$20k liquidity, but the bot's watchlist table was frozen at \$19,283 liquidity and 204 buys because `fetchRawPools` only polls the general top-10 list.
- **Fix**: Add a dedicated Watchlist Poller in `paper-trading-daemon.ts` that iterates through all items on the watchlist every 10s and calls `fetchDexScreenerTokenPair(candidate.mintAddress)` directly by address.

### Issue 3: Reversal / Dip-Bounce Ignored on Dropped Coins (`BAGSPAYBOT`)

- **The Event**: Once an item is marked `DROPPED`, `getActiveWatchingItems()` permanently ignores it, even if it bottoms out and prints a 2.0x buy/sell ratio with green volume.
- **Fix**: In `CandidateWatchlistService.ts`, if a `DROPPED` coin exhibits `buys5m >= 25`, `buys5m / sells5m >= 1.8`, and `volume5mUsd >= 5000`, revive its status to `"WATCHING"`.

### Issue 4: Artificial L/MC Depth Ceiling (30%) Rejecting Deep Liquidity

- **The Event**: `DEPTH_BALANCE_GATE` rejected `GROWTREES` (35.8%), `Molview` (36.1%), and `BAGSPAYBOT` (41.3%) because `maxLmcRatio` was capped at 30%. Deep liquidity is safer and reduces slippage.
- **Fix**: Raise `maxLmcRatio` to **0.55 (55%)**.

### Issue 5: Dangling Open Positions on Session Expiry

- **The Event**: When the 4 hours elapsed, the daemon broke out of the loop, leaving `CMPk...pump` and `DAem...DGqN` open in `.tmp/paper-session-active.json` without officially liquidating their remaining tokens into cash.
- **Fix**: When `elapsed >= maxDurationMs`, automatically execute `daemon.manualExit(pos.positionId, pos.spotPriceSol, currentNow, "SESSION_DURATION_CASHOUT")` for all remaining open positions, settling 100% of final equity into realized SOL cash.

### Issue 6: Live Elapsed Timer & Planned Duration Bridge Bugs

- **The Event**: Frontend displays `Planned: 1h` (hardcoded in `vite.config.ts`) and `Elapsed: 00:56:13` freezes when 0 positions are open because `lastTickAtMs` only updated during position ticks.
- **Fix**: In `frontend/vite.config.ts`, return `durationHours: raw.durationHours || 4` and calculate `now = Date.now()` so the live elapsed timer ticks every second.

---

## 3. Implementation Plan for Dev (Sub-Phase 12.5)

1. **`DynamicRatchetTypes.ts` & `DynamicRatchetService.ts`**:
   - Change `tier1PeakThresholdBps` to `1500` (+15.0%).
   - On Tier 1 (+15%): emit `SELL_PARTIAL_50` and set `currentStopFloorBps = Math.max(currentStopFloorBps, 0)` (Breakeven +0%).
   - Add Smart Hold Recovery: if `state.drawdownState === "EVALUATING_DRAWDOWN"` and `currentPnlBps >= 800`, set `drawdownState = "NORMAL"`, `drawdownEnteredAtMs = null`, and `currentStopFloorBps = Math.max(currentStopFloorBps, 0)`.
   - Add optional `hardTakeProfitBps` to `DynamicRatchetConfig`. If configured and `currentPnlBps >= hardTakeProfitBps`, emit `SELL_ALL` with reason `HARD_TAKE_PROFIT_CAP_TRIGGERED`.

2. **`BuyGateTriggerService.ts`**:
   - Change `maxLmcRatio` default to `0.55` (55%).

3. **`CandidateWatchlistService.ts`**:
   - Add Reversal Revival check in `admitOrUpdate()`: if `existing.status === "DROPPED"` and `pool.buys5m >= 25 && pool.buys5m / Math.max(1, pool.sells5m) >= 1.8 && pool.volume5mUsd >= 5000`, set `updatedStatus = "WATCHING"` and clear `rejectionReason`.

4. **`paper-trading-daemon.ts`**:
   - Add dedicated Watchlist Refresh Loop every 10s: iterate over `watchlistService.getItems()`, call `streamEngine.fetchDexScreenerTokenPair(item.mintAddress)`, and pass to `watchlistService.admitOrUpdate()`.
   - On session duration elapsed: iterate through `daemon.getSnapshot().openPositions` and call `daemon.manualExit(pos.positionId, pos.spotPriceSol, currentNow, "SESSION_DURATION_CASHOUT")` before completing.
   - Update `lastTickAtMs = currentNow` on every heartbeat loop so `lastTickAtMs` stays continuous.

5. **`frontend/vite.config.ts`**:
   - Return `durationHours: raw.durationHours || 4` (fixes `Planned: 1h` bug).
   - Use `const now = Date.now()` for real-time elapsed duration calculation.
