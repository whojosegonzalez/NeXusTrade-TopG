# Phase 12 Sub-Phase 12.81: Flow-Aware Hard Stops, Trailing Moonbag, Birdeye Deep Links & Dashboard Session Control

## 1. Executive Summary & Diagnostic Findings from Session 12.8-01

Session `session-paper-12.8-01` achieved major operational and strategic milestones:

- **Execution Unblocked & Active**: 18 trades executed cleanly over 4.0 hours (239.9 minutes) with **10 Wins (55.56% win rate)** and 8 Losses.
- **Drawdown Slashed 17x**: Total equity finished at **9.9003 SOL (-0.0997 SOL / -1.00%)**, down from -16.93% in 12.6.
- **Runners Caught & Banked**:
  - `FFzTy` (**XPAD**): **+40.40%** (+0.3232 SOL) via Tier 2 Ratchet.
  - `C1mBf` (**HOOKED**): **+35.29%** (+0.2823 SOL) via Tier 2 Ratchet.
  - `9k7Ng` (**INUINK**): **+31.44%** (+0.2515 SOL) via Tier 2 Ratchet.
  - `3YWbe` (**Joe**): **+12.10%** (+0.0968 SOL).
  - Plus 5 more winning scalps (`GKokA`, `8VxaJ`, `8LPQX`, `pvzyo`, `9DPUF`).
- **10 Rugs Successfully Dodged**: `USELESS`, `Fartcoin`, `USD1`, `RAY`, etc., all dropped -99% to -100% and were safely rejected by filters.

### Key Friction Points Identified for Sub-Phase 12.81:

1. **Premature Drawdown Grace Exit (`FROCAT`)**:
   `FROCAT` was bought at 0.000001441 SOL, dipped -7.8%, and was dumped after an arbitrary 45-second clock expired under `DRAWDOWN_GRACE_EXPIRED`—despite buyers dominating sellers 10:1 (5,000 buys vs 483 sells). Minutes later, it pumped +27% to new highs.
2. **Razor-Thin Micro-Cap Hard Stop (`SNOWBALL`)**:
   `SNOWBALL` was bought at 0.000001197 SOL with $74K 5m volume and strong buyer dominance (823 buys vs 586 sells). A standard -14% candle wick breached the rigid -12% micro-cap hard stop (`CATASTROPHIC_HARD_STOP`). Seconds later, it skyrocketed 4x to $0.00017917.
3. **Rigid Moonbag Lock on Runners (`HOOKED`)**:
   `HOOKED` ran +91.8% from entry. At Tier 2 (+50%), the daemon locked a fixed floor at +40% based on entry. On a shallow 5m pullback to +30.7%, it sold the remaining 25% moonbag, missing the subsequent push to $0.001874.
4. **Psychological Front-Running at +48.5% (`INUINK`)**:
   `INUINK` peaked at **+49.25%**, missing the rigid +50.0% Tier 2 threshold by just 0.75% before pulling back. Sell walls sit heavily at round numbers (+50.0%). Front-running at **+48.5% (4,850 bps)** secures profits before the rejection.
5. **The "Disappearing Cash" Realized P/L Accounting Bug**:
   When open positions take partial profit (50% at Tier 1 or 25% at Tier 2), the cash is credited to `currentCashSol`, but `totalRealizedPnlSol` only summed `closedTrades`. As a result, the dashboard displayed negative Realized P/L while portfolio equity was positive.
6. **Scratch Tier Badge Latch Glitch**:
   When a token moved between +0.5% and +1.5%, `activeTier` transitioned to `"SCRATCH"`. As the price expanded to +8% or +14%, `activeTier` remained stuck on `"SCRATCH"` instead of updating back to `"RUNNING"` until Tier 1 locked.
7. **Operator UX & Deep Links**:
   - Contract addresses and symbols were plain text, requiring manual copy-pasting to view Birdeye charts.
   - Activity feed showed generic trade logs without buy prices, USD values, or local timestamps.
   - Sessions had to be launched via terminal rather than from the UI.

---

## 2. Technical Deliverables Specification

### Deliverable 1: Flow-Aware Micro-Cap Hard Stops & Dynamic Grace

**Files**:

- `backend/src/exits/DynamicRatchetTypes.ts`
- `backend/src/exits/DynamicRatchetService.ts`

1. **Update Configurations in `DynamicRatchetTypes.ts`**:
   - `MICRO_CAP_DYNAMIC_RATCHET_CONFIG`:
     - Increase `drawdownGracePeriodMs` from `45_000` to `90_000` (90 seconds base).
     - Set `catastrophicFloorBps` to `-2000` (-20.0%) for volume breakouts, while maintaining standard early protection.
2. **Enhance `DynamicRatchetService.evaluate()`**:
   - **Dynamic Grace Extension**:
     In Health Check 3 (Grace period timeout):
     If `context.recentBuysCount60s >= 1.25 * context.recentSellsCount60s` and `elapsedMs <= 180_000` (up to 3 minutes):
     Do NOT trigger `DRAWDOWN_GRACE_EXPIRED`. Continue holding in `HOLD_DRAWDOWN_GRACE`.
   - **Flow-Aware Hard Stop**:
     In Rule A (Catastrophic hard stop):
     If price dips between `-12.0%` and `-20.0%`:
     - If buyer flow is unabsorbed (`buys < sells` or `buys === 0`), trigger immediate exit with `SELL_PRESSURE_UNABSORBED`.
     - If buyer dominance is strong (`buys >= 1.25 * sells`), allow the position to breathe down to `-20.0%`.

---

### Deliverable 2: Front-Run Tier 2 at +48.5% & Dynamic Trailing Moonbag

**Files**:

- `backend/src/exits/DynamicRatchetTypes.ts`
- `backend/src/exits/DynamicRatchetService.ts`

1. **Front-Run Tier 2 Milestone**:
   - Set `tier2PeakThresholdBps: 4850` (+48.5%) across both micro-cap and established configs.
   - Set `tier2LockedFloorBps: 3500` (+35.0%).
2. **Dynamic Trailing Moonbag for Tier 2 Runners**:
   - When a position is in `TIER_2` (Tier 2 profit taken, peak gain $\ge +48.5\%$):
     Calculate a **Trailing High-Water Mark Floor**:
     `trailingFloorBps = Math.max(activeConfig.tier2LockedFloorBps, nextPeakGainBps - 2500)` (trails 25.0% below peak gain).
     - Example: If peak is +55%, floor is +35%. If peak is +90%, floor trails up to +65%, protecting massive gains while allowing pullbacks room to breathe.

---

### Deliverable 3: Realized P/L Accounting & Scratch Latch Fix

**Files**:

- `backend/src/paper/PaperTradingDaemon.ts`
- `backend/src/exits/DynamicRatchetService.ts`

1. **Reconcile Realized P/L in `PaperTradingDaemon.ts` `getSnapshot()`**:
   - Add partial realized gains from active open positions to `totalRealizedPnlSol`:

     ```typescript
     const partialRealizedFromOpenPositions = openPositionsArray.reduce((acc, pos) => {
       const initialCost = pos.initialCostBasisSol ?? pos.costBasisSol;
       const costRelieved = initialCost - pos.costBasisSol;
       const realizedProceeds = pos.realizedProceedsSol ?? 0;
       return acc + (realizedProceeds - costRelieved);
     }, 0);

     const totalRealizedPnlSol =
       this.closedTrades.reduce((acc, trade) => acc + trade.realizedPnlSol, 0) +
       partialRealizedFromOpenPositions;
     ```

   - Mathematical guarantee: $\text{Total Realized PnL} + \text{Total Unrealized PnL} = \text{Current Portfolio SOL} - \text{Initial Portfolio SOL} = \text{Net Session PnL}$.

2. **Unlatch Scratch Tier Badge in `DynamicRatchetService.ts`**:
   - When `currentPnlBps > activeConfig.scratchPnlMaxBps && nextTier === "SCRATCH"`, transition `nextTier` back to `"RUNNING"`.
   - When `currentPnlBps < activeConfig.scratchPnlMinBps && nextTier === "SCRATCH"`, transition `nextTier` back to `"RUNNING"`.

---

### Deliverable 4: Clickable Birdeye Token & CA Links

**Files**:

- `frontend/src/views/ActiveSessionView.tsx`
- `frontend/src/views/HistoryView.tsx`
- `frontend/src/views/PerformanceView.tsx`

Wrap all token symbols and contract addresses in external Birdeye links:

```tsx
const birdeyeUrl = `https://birdeye.so/solana/token/${encodeURIComponent(mintAddress)}?tab=trades&trades_layout=table`;

<a
  href={birdeyeUrl}
  target="_blank"
  rel="noopener noreferrer"
  className="token-link text-indigo-400 hover:text-indigo-300 underline font-mono"
  title={`View ${symbol} on Birdeye`}
>
  <strong>{symbol}</strong>
  <span className="sub-mint opacity-60 ml-1">
    ({mintAddress.slice(0, 4)}...{mintAddress.slice(-4)})
  </span>
</a>;
```

---

### Deliverable 5: Rich Live Session Activity Feed

**Files**:

- `backend/src/scripts/paper-trading-daemon.ts`
- `frontend/src/views/ActiveSessionView.tsx`

1. **Track Full Lifecycle Events in `paper-trading-daemon.ts`**:
   Maintain an `activityLogs` ring buffer (last 50 events) in `paper-session-active.json`:
   - **BUY**: `🟢 ${symbol} bought at $${usdPrice} (${solPrice} SOL) at ${time} | Size: ${size} SOL [${cohort}]`
   - **SCALE**: `🟡 ${symbol} sold 50% at $${usdPrice} (+15% Tier 1) | Floor locked to Breakeven`
   - **SCALE**: `🟡 ${symbol} sold 25% at $${usdPrice} (+48.5% Tier 2) | Floor locked to Trailing Moonbag`
   - **CLOSE**: `🔴 ${symbol} closed at $${usdPrice} at ${time} | Exit: ${reason} | Realized PnL: ${pnlSol} SOL (${pnlPct}%)`
2. **Render in `ActiveSessionView.tsx`**:
   Render token names as clickable Birdeye links and color-code the activity badges (BUY = green, SCALE/RATCHET = yellow, SELL/CLOSE = red).

---

### Deliverable 6: Dashboard Session Control ("Start Paper Session" in Settings)

**Files**:

- `frontend/src/views/SettingsView.tsx`
- `frontend/vite.config.ts`

1. **Add "Launch Paper Trading Session" in `SettingsView.tsx`**:
   - Inputs: Planned Duration (default 4 hours), Session ID (auto-generated e.g. `session-paper-12.81-01`), Max Concurrent Positions (default 5).
   - Button: `🚀 Start Paper Trading Session`.
   - On click, POST to `/api/session/start` and navigate directly to Active Session view.
2. **Add API Handler in `frontend/vite.config.ts`**:
   - Handle `POST /api/session/start`: Spawn `pnpm daemon:paper --duration-hours=${duration} --session-id=${sessionId}` in a detached child process or write an IPC startup command.
   - Handle `POST /api/session/stop`: Issue `MANUAL_STOP` to `session-commands.json` via `SessionControlIpcService`.

---

### Deliverable 7: Birdeye Quota Tracker & Runner Discovery

**Files**:

- `backend/src/services/BirdeyeBudgetTracker.ts`
- `backend/src/discovery/BirdeyeDiscoveryService.ts`

1. **Quota Safety**:
   - Strictly track Compute Unit consumption against the user's **Standard Active** plan (30,000 CU/month limit).
   - Limit Birdeye Trending polls (`/defi/token_trending`, 25 CU) to once every 2.5 minutes (~600 CU/hr, 2,400 CU per 4-hour session).
   - Safe Probe: Probe `/smart-money/v1/token/list` once on startup; if it returns `403 Forbidden`, smoothly disable Smart Money without errors and log plan notice.

---

## 3. Verification & Compliance Requirements

1. **Test Suite Integrity**:
   - `node scripts/check-isolation.mjs` must pass with 0 leaks.
   - `node scripts/architecture-check.mjs` must pass with 0 violations.
   - `node scripts/verify-isolated.mjs` must pass 100% of tests.
   - `pnpm dashboard:build` must compile with 0 type errors.
2. **New Unit Tests**:
   - Dynamic Grace extension when 60s buyer dominance $\ge 1.25\text{x}$.
   - Flow-Aware hard stop permitting dips down to -20% when buyers dominate, but cutting early when sellers dominate.
   - Trailing Moonbag trailing 25% below peak for Tier 2 runners.
   - Snapshot Realized P/L reconciliation balancing to the penny.
