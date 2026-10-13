# NeXusTrade Phase 12.93: Remaining Risks & Execution-Model Limitations

This document provides a comprehensive technical audit of all execution-model limitations, market data constraints, and edge-case risks in the deployed Phase 12.93 codebase (`b3f73c2`).

---

## 1. Assessment of Execution-Model & Market Data Limitations

### 1. Spot vs. Route Pricing

- **Finding**: **DexScreener REST spot prices are used exclusively for all paper trading actions.**
- **Confirmation**:
  - Initial buy entries simulate fill price using `spotInfo.spotPriceSol` from DexScreener.
  - Scale-in additions simulate fill price using `spotInfo.spotPriceSol`.
  - Partial profit exits (`SELL_PARTIAL_50`, `SELL_PARTIAL_25`) evaluate and liquidate at `marketContext.spotPriceSol`.
  - Full exits (`UNCONFIRMED_PRE_BREAKEVEN_CUT`, `MOONBAG_PROTECTION_EXIT`, `CATASTROPHIC_HARD_STOP`, etc.) simulate proceeds strictly against `marketContext.spotPriceSol`.
- **Executable Quote Status**: Neither Jupiter (`/quote`) nor Raydium (`/compute/swap-base-in`) executable quotes are called during live paper execution. The quote routers in `backend/src/providers/` are tested in isolation, but the paper daemon ticker does not query them.

### 2. Transaction Fees, Slippage & Price Impact

- **Finding**: **Simulated paper fills deduct 0 fees, 0 slippage, and 0 price impact.**
- **Details**:
  - In [`PaperTradingDaemon.ts`](file:///u:/Projects/TopG/backend/src/paper/PaperTradingDaemon.ts#L601,L708):
    `finalProceedsSol = position.tokensHeld * exitPriceSol;`
  - Zero AMM swap fee (0.25% Raydium fee) is deducted.
  - Zero Solana network gas (0.000005 SOL) or priority fee / Jito MEV tip (0.001–0.010 SOL) is deducted.
  - Zero price impact is simulated on exit, assuming 100% of tokens sell at the exact mid-market spot price.

### 3. Missing Sell Routes & Liquidity Drain Exposure

- **Finding**: **Unresolved exposure is not modeled when liquidity vanishes.**
- **Details**: If an AMM pool is drained to zero or blacklists sellers (honeypot), DexScreener may report 0 price or stale price. If DexScreener fails completely for 5 minutes, `STAGNANCY_TIMEOUT_EXIT` triggers. During end-of-session cashout, if price is unavailable or 0, the system falls back to `pos.entryPriceSol`, recording a synthetic 0.0% PnL rather than marking the position as `UNRESOLVED_EXPOSURE` or 100% loss.

### 4. Buyer/Seller Flow Derivation

- **Finding**: **60-second transaction rates are derived by dividing 5-minute totals by 5.**
- **Code Reference**: [`backend/src/scripts/paper-trading-daemon.ts`](file:///u:/Projects/TopG/backend/src/scripts/paper-trading-daemon.ts#L324-L325)
  ```typescript
  const recentBuys60s = Math.round(buys5m / 5);
  const recentSells60s = Math.round(sells5m / 5);
  ```
- **Consequence**: If a token had 50 buys during minutes 1–4 of a 5-minute candle, but experienced 0 buys and 30 sells during the last 60 seconds, `recentBuys60s` still reports 10 buys. This smooths out micro-volatility but can present "phantom buyer flow" during an abrupt cliff dump.

### 5. Buyer Dominance Bypassing Protective Stops

- **Finding**: **Estimated buyer dominance bypasses the Universal Pre-Breakeven Cut.**
- **Code Reference**: [`backend/src/exits/DynamicRatchetService.ts`](file:///u:/Projects/TopG/backend/src/exits/DynamicRatchetService.ts#L501-L510)

  ```typescript
  const hasStrongBuyerDominance =
    context.recentBuysCount60s >= 1.25 * Math.max(1, context.recentSellsCount60s);

  if (
    !armedBreakeven &&
    !tier1ProfitTaken &&
    nextPeakGainBps < activeConfig.armedBreakevenThresholdBps &&
    currentPnlBps <= (activeConfig.preBreakevenStopBps ?? -1200) &&
    !hasStrongBuyerDominance
  )
  ```

- **Risk**: If `hasStrongBuyerDominance` is true due to the 5-minute transaction averaging described above, the position is permitted to draw down below -12.0% down to the catastrophic floor (-20.0%), increasing loss severity on deceptive dips.

### 6. Provider Cooldowns Blocking High/Critical Quote Requests

- **Finding**: **`JupiterDemandController` does not allow HIGH priority requests to bypass window exhaustion or adaptive backoff.**
- **Code Reference**: [`backend/src/providers/jupiter/JupiterDemandController.ts`](file:///u:/Projects/TopG/backend/src/providers/jupiter/JupiterDemandController.ts#L100-L130)
  If the global window budget (`maxLiveRequestsPerWindow`) is exceeded or adaptive backoff is cooling down (`now < nextAllowedAtMs`), `tryAcquire` returns `allowed: false` regardless of request priority.
- **Consequence**: In a live trading setup, an emergency exit quote could be delayed or blocked if the quota is exhausted by background polling.

### 7. Quote Scheduler Concurrency Spacing

- **Finding**: **`QuoteScheduler` has an asynchronous race condition when concurrent requests arrive within the same microtask tick.**
- **Code Reference**: [`backend/src/providers/quotes/QuoteScheduler.ts`](file:///u:/Projects/TopG/backend/src/providers/quotes/QuoteScheduler.ts#L52-L58)
  `this.nextAllowedAtMs` is updated _after_ `await this.wait(waitMs)`. Two concurrent requests arriving at `t=0` both observe `waitMs = 0` and fire simultaneously.
- **Mitigation in Production**: `JupiterDemandController` contains internal promise serialization (`this.queue = this.queue.then(...)`) which protects Jupiter calls, but generic `QuoteScheduler` lacks this queue lock.

---

## 2. Risk Classification Matrix

| Risk Item                                     | Impact                                                                        | Likelihood                                 | Classification | Action / Recommendation                                                                         |
| :-------------------------------------------- | :---------------------------------------------------------------------------- | :----------------------------------------- | :------------: | :---------------------------------------------------------------------------------------------- |
| **Cashout Fallback to Entry Price**           | Masks complete liquidity pool rug pulls at 0.0% PnL during cashout            | Low (requires 0 price at exact window end) |   `WARNING`    | Document limitation; in Phase 13, exit at 0 SOL if unpriced                                     |
| **5m Transaction Smoothing (Phantom Buyers)** | Can delay -12% pre-breakeven stop by up to 2-3 minutes during sudden reversal | Medium                                     |   `WARNING`    | Maintain -20% catastrophic stop as ultimate safety floor                                        |
| **Zero Slippage & Fee Modeling**              | Paper performance overstates net profit by ~0.5% to 1.5% per trade            | High (systematic)                          |   `DEFERRED`   | Phase 13 hot wallet transition will incorporate live Jito bundle pricing                        |
| **No Per-Position Mutex in Runner**           | Two concurrent async loops touching same position could race                  | Extremely Low                              |   `RESOLVED`   | Loop A runs sequentially per tick; single-threaded Node.js event loop prevents state corruption |
| **Double Session Settlement**                 | Virtual wallet balances corrupted by duplicate archival                       | None                                       |   `RESOLVED`   | Fully fixed via `settledSessionIds` idempotency guard in `b3f73c2`                              |
| **Premature Daemon Halt on Drawdown**         | Open positions abandoned on drawdown breach                                   | None                                       |   `RESOLVED`   | Fully fixed via `"EXITING"` state transition in `b3f73c2`                                       |
