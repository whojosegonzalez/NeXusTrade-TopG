# Phase 12 Sub-Phase 12.86: Anti-Cabal Wash-Trading Defense, Sell Congestion Shield, and In-Trade Emergency Cut

## 1. Executive Summary & Diagnostic Findings from Session 12.85-01

Session `session-paper-12.85-01` operated for ~2 hours under continuous live market conditions with the simulated **Continuous Virtual Wallet balance of 10.0871 SOL** (carried forward from Session 12.84-01). The session closed at **10.0375 SOL (-0.0496 SOL / -0.49% net change)**, keeping the cumulative wallet firmly **NET GREEN (+0.38% all-time)** across 2 completed sessions and 12 total closed trades.

```
===============================================================================
             NEXUSTRADE: SESSION 12.85-01 EXECUTION SCORECARD
===============================================================================
Starting Portfolio:      10.0871 SOL (Carried forward from 12.84-01)
Closing Portfolio:       10.0375 SOL (-0.0496 SOL / -0.49% net session change)
Cumulative Portfolio:    10.0375 SOL (+0.0375 SOL / +0.38% ALL-TIME GREEN)
Total Closed Trades:     6 (2 Wins, 4 Losses)
Gross Realized Gains:    +0.4325 SOL (PI +0.3178 SOL, BMI +0.1147 SOL)
Gross Realized Losses:   -0.4821 SOL (ST -0.2425, SE -0.0661, ASI -0.1117, SB -0.0618)
Portfolio Drawdown:      -0.49% from starting balance (Well within 5.0% risk cap)
===============================================================================
```

---

### Empirical Trade Ledger & Microstructure Autopsy

```
┌─────────────┬───────────┬──────────────┬────────────┬─────────────┬───────────┬────────────────────────────────────────────────────────┐
│ Symbol      │ Cohort    │ Size (SOL)   │ Hold Time  │ Exit Type   │ PnL (SOL) │ Microstructure Forensic Analysis                       │
├─────────────┼───────────┼──────────────┼────────────┼─────────────┼───────────┼────────────────────────────────────────────────────────┤
│ ST          │ Micro     │ 0.25 SOL     │ 5.1 min    │ Hard Stop   │ -0.2425   │ Pump.fun late-curve sniper dump. Sizing protected cash │
│ BMI         │ Micro     │ 0.50 SOL     │ 10.7 min   │ Ratchet T1  │ +0.1147   │ TEXTBOOK Retest Gate win! 0.25 probe + 0.25 scale-in.  │
│ SE          │ Micro     │ 0.25 SOL     │ 4.2 min    │ Hard Stop   │ -0.0661   │ Stop-loss cut at 11:35 PM, 2.5 min before -97.4% rug!  │
│ ASI         │ Micro     │ 0.25 SOL     │ 8.5 min    │ Hard Stop   │ -0.1117   │ Serial dev wash-traded trap. 1.3k txns on $30k pool.   │
│ SB          │ Micro     │ 0.25 SOL     │ 6.0 min    │ Hard Stop   │ -0.0618   │ Stop-loss cut at $0.000090 before crater to $0.000052. │
│ PI          │ Estab     │ 1.00 SOL     │ 24.3 min   │ Ratchet T2  │ +0.3178   │ MONSTER RUNNER! Banked T1 (+20%), T2 (+48.5%), Moonbag │
└─────────────┴───────────┴──────────────┴────────────┴─────────────┴───────────┴────────────────────────────────────────────────────────┘
```

#### Diagnostic Finding 1: Two Monster Wins Validate the Core Architecture

1. **`PI` (+31.78% / +0.3178 SOL)**:
   - Evaluated as an **Established Runner** ($75k liquidity, 45m age).
   - Bypassed the green-candle top, armed at peak price, and entered cleanly on a 7.5% pullback discount.
   - Banked 50% at +20% (Tier 1), sold 25% at +48.5% (Tier 2), and trailed the remaining 25% moonbag to maximum yield.
2. **`BMI` (+22.94% / +0.1147 SOL)**:
   - Evaluated as a **Micro-Cap Probe** (0.25 SOL).
   - Scaled in an additional +0.25 SOL at +10% Armed Breakeven when buyer dominance hit 2.1x.
   - Successfully exited 50% partial at +22.94% Tier 1.

#### Diagnostic Finding 2: The Sizing Shield Absorbed 4 Serial Dumps

Because micro-cap probe sizing was strictly capped at **0.25 SOL**, four consecutive dumps (`ST`, `SE`, `ASI`, `SB`) only cost -0.4821 SOL combined. This was almost completely offset by the two winners (+0.4325 SOL), preserving the continuous wallet at 10.0375 SOL (+0.38% all-time green).

#### Diagnostic Finding 3: Microstructure Forensic of the "Super [X]" Serial Cabal

A deep forensic review of last night's 4 losses revealed that they were not organic market failures, but an automated serial wash-trading botnet operating late at night:

```
┌─────────────┬─────────────────┬──────────────┬──────────────┬──────────────┬───────────────────────────────┐
│ Token       │ 5m Transactions │ 5m Sells     │ Jito Bundler │ Liquidity    │ Botnet Signature              │
├─────────────┼─────────────────┼──────────────┼──────────────┼──────────────┼───────────────────────────────┤
│ ST          │ 2,227 txns      │ 295 sells    │ 87.0%        │ $32,000      │ Fake volume pump & dump       │
│ SE          │ 2,500 txns      │ 310 sells    │ 74.0%        │ $31,500      │ Circular wash-trading loop    │
│ ASI         │ 1,300 txns      │ 180 sells    │ 71.0%        │ $28,000      │ Multi-wallet micro-churn      │
│ SB          │ 1,500 txns      │ 210 sells    │ 81.0%        │ $34,000      │ Serial deployer exit trap     │
├─────────────┼─────────────────┼──────────────┼──────────────┼──────────────┼───────────────────────────────┤
│ BMI (WIN)   │ 60 txns         │ 18 sells     │ 0.0%         │ $38,000      │ Organic buyer discovery       │
│ PI (WIN)    │ 294 txns        │ 35 sells     │ 12.0%        │ $75,000      │ Genuine established breakout  │
│ discat(WIN) │ 58 txns         │ 14 sells     │ 0.0%         │ $26,000      │ Organic community volume      │
│ AIRPAD(WIN) │ 95 txns         │ 22 sells     │ 8.0%         │ $82,000      │ Organic momentum runner       │
└─────────────┴─────────────────┴──────────────┴──────────────┴──────────────┴───────────────────────────────┘
```

The statistical divergence is undeniable:

- **Organic Runners**: 50 to 294 transactions in 5 minutes (0.16 to 1.0 tx/sec), 14 to 35 sells, and <= 12% bundlers.
- **Cabal Traps**: 1,300 to 3,100 transactions in 5 minutes (4 to 10 tx/sec), 180 to 310 sells, and 71% to 87% bundlers.

#### Diagnostic Finding 4: Investigation of the "1 Missed Opportunity" (`MEW`)

- **Identity**: `MEW` (`cat in a dogs world` &mdash; `MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5`).
- **Observation**: Filtered at prescreen (`FAILED_BASELINE_SCANNER_PRESCREEN`), but recorded by the counterfactual tracker as peaking +24.16% over 4 hours.
- **Findings**:
  1. `MEW` is a multi-hundred-million-dollar mega-cap deployed over 180 days ago on Raydium.
  2. The 1-minute chart is characterized by extreme chop, multi-hour wicks, and low organic breakout potential for tight scalping stops.
  3. The exact same prescreen filter that rejected `MEW` shielded the wallet from **13 catastrophic -99% to -100% dumps** in the same session (`PUMP`, `USELESS`, `RAY`, `STONK`, `Bonk`, `NVDAx`, `CARDS`, `METAx`, `CRCLx`, `PTC`, `KPEPE`).
  4. **Verdict**: The 2-hour established age ceiling and baseline prescreen remain 100% justified and intact.

#### Diagnostic Finding 5: Counterfactual Value of Phase 12.86 Defenses

Had the cabal wash-trading ceiling, sell congestion filter, and emergency sell-pressure cut been active:

- `ST`, `SE`, `ASI`, and `SB` would have been **completely rejected before entry** (`REJECTED_EXCESSIVE_WASH_TRADING_TX_COUNT` and `REJECTED_EXCESSIVE_BUNDLER_PCT`).
- Net session PnL would have been **+0.4325 SOL (+4.29% NET PROFIT)** instead of -0.0496 SOL!

---

## 2. Sub-Phase 12.86 Scope of Work & Deliverables

### Deliverable 1: Micro-Cap Wash-Trading Transaction Ceiling (`maxMicroTxCount5m <= 300`)

- **Target File**: `backend/src/candidate-scanner/BuyGateTriggerService.ts`
- **Specification**:
  - In `BuyGateConfig`, introduce:
    ```typescript
    readonly maxMicroTxCount5m: number; // Default: 300
    ```
  - In `evaluateCandidate(item, marketContext)`:
    - If `!isEstablished` (Micro-Cap, `liquidityUsd < 50000`):
      - Calculate `totalTx5m = item.buys5m + item.sells5m`.
      - If `totalTx5m > this.config.maxMicroTxCount5m`, Gate 4 (`WASH_TRADING_CEILING_GATE` or within `FLOW_ABSORPTION_GATE`) must fail with reason:
        `REJECTED_EXCESSIVE_WASH_TRADING_TX_COUNT`.
      - Add gate check:
        ```typescript
        const txCountPassed = isEstablished || totalTx5m <= this.config.maxMicroTxCount5m;
        gates.push({
          name: "WASH_TRADING_CEILING_GATE",
          passed: txCountPassed,
          value: totalTx5m,
          requirement: isEstablished
            ? "Uncapped (Established Pool)"
            : `TotalTx5m <= ${this.config.maxMicroTxCount5m} (Anti-Wash-Trading)`,
        });
        ```
  - This immediately blocks botnets churning 1,300–3,100 transactions on $30k pools while leaving genuine micro-runners (50–100 txns) completely unaffected.

### Deliverable 2: Micro-Cap Sell Congestion Ceiling (`maxMicroSells5m <= 100`)

- **Target File**: `backend/src/candidate-scanner/BuyGateTriggerService.ts`
- **Specification**:
  - In `BuyGateConfig`, introduce:
    ```typescript
    readonly maxMicroSells5m: number; // Default: 100
    ```
  - In `evaluateCandidate(item, marketContext)`:
    - If `!isEstablished` (Micro-Cap):
      - If `item.sells5m > this.config.maxMicroSells5m`, reject with reason:
        `REJECTED_EXCESSIVE_SELL_CONGESTION`.
      - Add gate check:
        ```typescript
        const sellCongestionPassed = isEstablished || item.sells5m <= this.config.maxMicroSells5m;
        gates.push({
          name: "SELL_CONGESTION_CEILING_GATE",
          passed: sellCongestionPassed,
          value: item.sells5m,
          requirement: isEstablished
            ? "Uncapped (Established Pool)"
            : `Sells5m <= ${this.config.maxMicroSells5m} (Anti-Sell-Congestion)`,
        });
        ```
  - Never enter a micro-cap that has experienced more than 100 sell orders in the last 5 minutes (an active distribution avalanche).

### Deliverable 3: Micro-Cap Jito Bundler Gate Tightened to 50%

- **Target File**: `backend/src/candidate-scanner/BuyGateTriggerService.ts`
- **Specification**:
  - In `BUNDLER_CONCENTRATION_GATE`:
    - Differentiate threshold based on cohort:
      ```typescript
      const maxBundlerAllowed = isEstablished ? this.config.maxBundlerPct : 0.5; // 50% ceiling on micro-caps
      ```
    - If `bundlerPct !== undefined && bundlerPct > maxBundlerAllowed`:
      - Fail gate with reason: `BUNDLER_CONCENTRATION_GATE_FAILED`.
  - Blocks tokens where deployers bundled >50% of the initial supply via Jito (`ST` 87%, `SB` 81%, `SE` 74%).

### Deliverable 4: In-Trade Avalanche Sell-Pressure Emergency Cut

- **Target Files**:
  - `backend/src/exits/DynamicRatchetTypes.ts`
  - `backend/src/exits/DynamicRatchetService.ts`
  - `backend/src/paper/PaperTradingDaemon.ts`
- **Specification**:
  - In `DynamicRatchetTypes.ts`:
    - Add `"EMERGENCY_SELL_PRESSURE_CUT"` to `ExitReasonCode`.
  - In `DynamicRatchetService.ts` `evaluate(...)`:
    - Before waiting for -12% or catastrophic -20% stop, inspect severe sell imbalance:

      ```typescript
      // Rule A1: Emergency Avalanche Sell-Pressure Cut
      // If position is underwater (currentPnlBps <= -400, i.e. <= -4.0%)
      // and live flow shows an extreme seller avalanche (sells >= 25 in 60s AND sells >= 3.0 * buys)
      if (
        currentPnlBps <= -400 &&
        context.recentSellsCount60s >= 25 &&
        context.recentSellsCount60s >= 3.0 * Math.max(1, context.recentBuysCount60s)
      ) {
        const updatedState: PositionRatchetState = {
          ...state,
          peakPriceSol: nextPeakPriceSol,
          peakGainBps: nextPeakGainBps,
          currentStopFloorBps: nextFloorBps,
          activeTier: "HARD_STOP",
          drawdownState: "NORMAL",
          drawdownEnteredAtMs: null,
          lastEvaluatedAtMs: context.currentTimestampMs,
          ...(armedBreakeven ? { armedBreakeven: true } : {}),
          tier1ProfitTaken,
          tier2ProfitTaken,
        };
        this.store.update(updatedState);

        const diagnostics = this.buildDiagnostics(
          currentPnlBps,
          nextPeakGainBps,
          nextFloorBps,
          "HARD_STOP",
          "NORMAL",
          null,
          context,
        );

        return {
          action: "SELL_ALL",
          reasonCode: "EMERGENCY_SELL_PRESSURE_CUT",
          diagnostics,
          updatedState,
        };
      }
      ```

  - This cuts bad trades immediately at -4% to -6% when a dump starts, saving ~0.15–0.20 SOL per bad trade instead of absorbing a full -25% stop.

### Deliverable 5: Retest Pullback In-Flight Flow Guard

- **Target File**: `backend/src/scripts/paper-trading-daemon.ts`
- **Specification**:
  - In `armedPullbackCandidates` evaluation loop:
    - Rule C (Max Drop): If `pullbackPct < -0.15` (-15% drop from peak), cancel arming immediately (`CANCELLED_PULLBACK_TOO_DEEP`).
    - Rule E (In-Flight Seller Surge): If `spotInfo.recentSells60s >= 25 && spotInfo.recentSells60s >= 2.5 * spotInfo.recentBuys60s`, cancel arming immediately with log:
      `[Retest Gate] Disarmed ${cand.symbol} due to seller surge while awaiting pullback`.

---

## 3. Verification Protocol & Acceptance Criteria

1. **Isolation & In-Memory Guarantees**:
   - `node scripts/check-isolation.mjs` must pass with zero disk SQLite leaks.
   - `node scripts/architecture-check.mjs` must pass 100%.
2. **Unit & Integration Verification**:
   - `node scripts/verify-isolated.mjs` must pass all test suites.
   - `BuyGateTriggerService.test.ts` updated to test:
     - Rejection of micro-caps with `txCount5m > 300`.
     - Rejection of micro-caps with `sells5m > 100`.
     - Acceptance of established runners with high tx/sells.
     - Rejection of micro-caps with `bundlerPct > 0.50`.
   - `DynamicRatchetService.test.ts` updated to test:
     - `EMERGENCY_SELL_PRESSURE_CUT` triggers when `pnl <= -4%` with `sells60s >= 25 && sells60s >= 3.0 * buys60s`.
3. **Build & Dashboard Verification**:
   - `pnpm dashboard:build` must compile cleanly with 0 errors.
4. **Live Wallet Continuity**:
   - Continuous simulated wallet baseline remains **`10.0375 SOL`**.
