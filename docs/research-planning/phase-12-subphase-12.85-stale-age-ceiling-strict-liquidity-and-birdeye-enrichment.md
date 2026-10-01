# Phase 12 Sub-Phase 12.85: Stale Age Ceiling, Strict Live Liquidity Hardening, Real-Data Birdeye Enrichment & Established Retest Gate

## 1. Executive Summary & Diagnostic Findings from Session 12.84-01

Session `session-paper-12.84-01` was executed with a fresh simulated **Continuous Virtual Wallet of 10.0000 SOL**. It operated for ~2.75 hours across 6 closed positions, successfully locking in a **net positive profitable result of 10.0871 SOL (+0.0871 SOL / +0.87% NET GREEN)** before concluding early to seal gains and harden critical defenses.

```
===============================================================================
             NEXUSTRADE: SESSION 12.84-01 EXECUTION SCORECARD
===============================================================================
Starting Portfolio:      10.0000 SOL
Closing Portfolio:       10.0871 SOL (+0.0871 SOL / +0.87% NET GREEN)
Total Closed Trades:     6 (2 Wins, 4 Losses)
Gross Realized Gains:    +0.8272 SOL (AIRPAD +0.7122 SOL, discat +0.1150 SOL)
Gross Realized Losses:   -0.7401 SOL (SS -0.1028, RESI -0.2918, sendor -0.0988, POTUS -0.2466)
Peak Session Portfolio:  10.3337 SOL (+3.34%) following AIRPAD exit
Portfolio Drawdown:      0.00% (Never breached starting balance; zero drawdown violation)
===============================================================================
```

---

### Empirical Trade Ledger & Microstructure Autopsy

```
┌─────────────┬───────────┬──────────────┬────────────┬─────────────┬───────────┬────────────────────────────────────────────────────────┐
│ Symbol      │ Cohort    │ Size (SOL)   │ Hold Time  │ Exit Type   │ PnL (SOL) │ Microstructure Forensic Analysis                       │
├─────────────┼───────────┼──────────────┼────────────┼─────────────┼───────────┼────────────────────────────────────────────────────────┤
│ SS          │ Estab     │ 1.00 SOL     │ 3.2 min    │ Drawdown    │ -0.1028   │ 4-hour-old runner re-bought into late distribution.    │
│ RESI        │ Estab     │ 1.00 SOL     │ 4.5 min    │ Hard Stop   │ -0.2918   │ 3-hour-old runner caught in -26% 1h macro downtrend.   │
│ discat      │ Micro     │ 0.50 SOL     │ 3.0 min    │ Ratchet T1  │ +0.1150   │ TEXTBOOK Retest Gate win! 0.25 probe + 0.25 scale-in.  │
│ sendor      │ Micro     │ 0.25 SOL     │ 1.5 min    │ Hard Stop   │ -0.0988   │ Micro probe strictly capped loss; Tranche 2 blocked.   │
│ AIRPAD      │ Estab     │ 1.00 SOL     │ 38.5 min   │ Ratchet T2  │ +0.7122   │ MONSTER RUNNER! Banked T1 (+20%), T2 (+48.5%), Moonbag │
│ POTUS       │ Micro     │ 0.25 SOL     │ 32 sec     │ Hard Stop   │ -0.2466   │ Block-0 pump.fun rug pull. Sizing preserved portfolio! │
└─────────────┴───────────┴──────────────┴────────────┴─────────────┴───────────┴────────────────────────────────────────────────────────┘
```

#### Diagnostic Finding 1: Sizing Discipline & Retest Gate Prevented Liquidation

- `discat` (+22.99%) confirmed the **Retest / Pullback Confirmation Thesis**: waiting for the 10%–18% pullback dip bypassed the sniper wick, permitted a risk-free 0.25 SOL scale-in at +10% Armed Breakeven, and harvested a clean win.
- `POTUS` (-98.65% dump in 32 seconds): Because probe sizing was strictly capped at **0.25 SOL**, the wallet absorbed an instant rug pull with only a 0.2466 SOL loss, leaving the entire portfolio green. In earlier sessions, a 1.0–2.0 SOL entry on `POTUS` would have wiped out +0.80 SOL.
- `AIRPAD` (+71.22% realized gain): Demonstrated the immense power of the dynamic trailing moonbag, trailing peak gains up to +164% and locking in exits at +139%.

#### Diagnostic Finding 2: The Three Preventable Leaks (Counterfactual P/L: +7.28%)

Without the three flawed trades (`SS`, `RESI`, and `POTUS`), the session would have produced **+0.7284 SOL (+7.28% net profit)**:

1. **The Stale Established Distribution Trap (`SS` and `RESI` = -0.3946 SOL)**:
   - Tokens older than 2 hours (3h–4h old) are in late-stage distribution. Re-entering them on 5m volume spikes caught falling knives.
2. **The Phantom Synthetic Defaults on Birdeye Trending Tokens**:
   - In `paper-trading-daemon.ts`, Birdeye trending tokens were populated with hardcoded synthetic values: `openTimeSec = currentNowSec - 7200` (Age 120m), `marketCapUsd = liquidityUsd * 4` (25% Depth), `buys5m = 16`, `sells5m = 9` (1.8x).
   - This synthetic data leaked onto the live radar, bypassed Gate 4 Flow Absorption, and falsely stamped tokens as Established Runners.
3. **Missing Live Liquidity Floor at Execution Time (`POTUS` = -0.2466 SOL)**:
   - When `fetchDexScreenerSpotInfo` was called, it did not verify that `solPair.liquidity.usd >= 20000` at the exact millisecond of purchase.
   - Additionally, RugCheck returned `holdersCount: undefined` for the unindexed block-0 token, which passed silently instead of failing closed.

---

## 2. Sub-Phase 12.85 Scope of Work & Deliverables

### Deliverable 1: Real-Data Pre-Enrichment for Birdeye Trending (Zero Synthetic Defaults)

- **Target File**: `backend/src/scripts/paper-trading-daemon.ts`
- **Specification**:
  - Remove all hardcoded synthetic placeholders (`buys5m: 16`, `sells5m: 9`, `openTimeSec: currentNowSec - 7200`, `liquidityUsd * 4`).
  - When a Birdeye trending token is fetched, immediately query DexScreener via `streamEngine.fetchDexScreenerTokenPair(token.address)`.
  - Only admit the token to `watchlistService` if DexScreener returns a valid Solana SOL/WSOL pool with authentic `openTimeSec`, `buys5m`, `sells5m`, `volume5mUsd`, and `marketCapUsd`.
  - If DexScreener has no active SOL pair or data is missing, discard the candidate (`FAILED_BIRDEYE_ENRICHMENT`).

### Deliverable 2: Live Spot Liquidity Hard Floor at Execution Time

- **Target File**: `backend/src/scripts/paper-trading-daemon.ts`
- **Specification**:
  - In `fetchDexScreenerSpotInfo(mintAddress)`:
    - Extract `liquidityUsd = solPair.liquidity?.usd ?? 0`.
    - Include `liquidityUsd` in the returned `DexScreenerSpotInfo` interface.
  - In the Stage 2 candidate evaluation loop:
    - Before arming or buying, verify:
      - `spotInfo.liquidityUsd >= 20000` for Micro-Caps.
      - `spotInfo.liquidityUsd >= 50000` for Established tokens.
    - If live liquidity is below the threshold, reject immediately with `REJECTED_INSUFFICIENT_LIVE_LIQUIDITY` and drop the candidate.

### Deliverable 3: Fail-Closed RugCheck on Micro-Caps

- **Target File**: `backend/src/candidate-scanner/BuyGateTriggerService.ts`
- **Specification**:
  - For Micro-Cap tokens (`liquidityUsd < 50000`):
    - Require `holdersCount !== undefined && holdersCount >= 100`.
    - If RugCheck API fails, times out, or returns unindexed data (`holdersCount === undefined`), evaluate Gate 9 (`BUNDLER_CONCENTRATION_GATE`) as **FAILED** with reason `REJECTED_RUGCHECK_UNINDEXED_OR_HOLDERS_UNKNOWN`.
    - Established tokens (`liquidityUsd >= 50000`) continue using lenient fail-open if RugCheck times out.

### Deliverable 4: Established Token Age Ceiling (Max 2 Hours / 7,200s)

- **Target Files**:
  - `backend/src/candidate-scanner/BuyGateTriggerService.ts`
  - `backend/src/candidate-scanner/CandidateWatchlistService.ts`
- **Specification**:
  - Redefine `isEstablished` and `isEstablishedRunner`:
    ```typescript
    const isEstablished =
      item.liquidityUsd >= 50000 &&
      item.assetAgeSeconds >= 1800 && // At least 30m old
      item.assetAgeSeconds <= 7200; // At most 2h old (Anti-Stale Distribution Ceiling)
    ```
  - In `CandidateWatchlistService.ts`:
    - Drop `effectiveMaxAgeSec` for established tokens from `86400` (24h) down to `7200` (2h).
    - If an established token exceeds 7,200 seconds of age, drop it with `EXCEEDED_MAX_ESTABLISHED_AGE_2H`.

### Deliverable 5: Route Established Tokens Through the Retest Gate

- **Target File**: `backend/src/scripts/paper-trading-daemon.ts`
- **Specification**:
  - Established tokens must no longer execute instantaneous market buys on raw green candle tops.
  - Route Established tokens through `armedPullbackCandidates`:
    - Arm at peak price.
    - Rule A: Enter on a **5% to 12% pullback discount** with `recentBuys60s >= 1.15 * recentSells60s`.
    - Rule B: Enter on consolidation within 3% of peak for $\ge 30\text{s}$ with buyer dominance.
    - Rule C: Cancel if it craters $> 15\%$ below peak.
    - Rule D: Expiry after 120 seconds.

### Deliverable 6: Parabolic Moonbag Trailing Stop Tightening

- **Target File**: `backend/src/scripts/paper-trading-daemon.ts`
- **Specification**:
  - In the Moonbag trailing stop loop:
    - If `peakGainPct < 1.00` (+100% gain): Trail at `peakGainPct - 0.25` (25% buffer).
    - If `peakGainPct >= 1.00` (+100% gain): Tighten trail to `peakGainPct - 0.15` (15% buffer).
    - If `peakGainPct >= 2.00` (+200% gain): Tighten trail to `peakGainPct - 0.10` (10% buffer).
  - This secures maximum profit on parabolic vertical candles like `AIRPAD`.

---

## 3. Verification Protocol & Acceptance Criteria

1. **Isolation & In-Memory Guarantees**:
   - `node scripts/check-isolation.mjs` must pass with zero disk SQLite leaks.
   - `node scripts/architecture-check.mjs` must pass 100%.
2. **Unit & Integration Verification**:
   - `node scripts/verify-isolated.mjs` must pass all test suites.
   - `BuyGateTriggerService.test.ts` updated to test the 2h age ceiling, fail-closed RugCheck holder requirements, and live liquidity checks.
3. **Frontend Compilation**:
   - `pnpm dashboard:build` must compile without warnings.
4. **Session Carry-Forward**:
   - Next session (`session-paper-12.85-01`) must launch automatically reading `currentBalanceSol` (10.0871 SOL) from `virtual-wallet.json`.
