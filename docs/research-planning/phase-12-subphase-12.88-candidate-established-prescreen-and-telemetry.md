# Phase 12 Sub-Phase 12.88: Candidate Established Runner Pre-Screening Unblock, Counterfactual Expiry Tracking, and Daemon Heartbeat Telemetry

## 1. Executive Summary & Diagnostic Findings from Session 12.87-01

Session `session-paper-12.87-01` completed a full 4-hour live calibration run (239.8 minutes, from 01:57 UTC to 05:57 UTC / 6:57 PM PDT to 10:57 PM PDT) with the continuous simulated wallet balance of **10.8758 SOL** (carried forward from Session 12.86-01).

The session concluded with **100% capital preservation (10.8758 SOL balance, 0 drawdowns, 0 losses)**. Across 4 completed continuous sessions, the virtual wallet maintains an all-time green balance of **10.8758 SOL (+8.76% all-time profit)** across 16 historical closed trades.

```
===============================================================================
             NEXUSTRADE: SESSION 12.87-01 EXECUTION SCORECARD
===============================================================================
Starting Portfolio:      10.8758 SOL (Carried forward from 12.86-01)
Closing Portfolio:       10.8758 SOL (+0.0000 SOL / 100.0% Capital Preserved)
Cumulative Portfolio:    10.8758 SOL (+0.8758 SOL / +8.76% ALL-TIME PROFIT)
Session Duration:        239.8 Minutes (Full 4.0 Hours)
Total Closed Trades:     0 (0 Wins, 0 Losses, 0 Capital Bleed)
Candidates Observed:     93 Total Candidates Monitored
Avoided Rugs (<= -30%):   12 Confirmed Scams Filtered (-99.15% to -100.00% Dumps)
Continuous Sessions:     4 Completed Sessions (16 total trades, 0 capital breaches)
===============================================================================
```

---

### Empirical Forensic Review & Key Diagnostic Findings

#### Diagnostic Finding 1: Flawless Defense Against Catastrophic Rugs & Cabal Traps

The session proved that the Sub-Phase 12.86 and 12.87 defensive hardening operates with high precision:

1. **12 Confirmed Catastrophic Rugs Screened Out**:
   - `PUMP` (-100.00%), `USELESS` (-100.00%), `RAY` (-99.99%), `STONK` (-99.19%), `HYPE` (-99.17%), `NVDAx` (-99.16%), `CARDS` (-99.16%), `USD1` (-99.16%), `NEAR` (-99.16%), `CRCLx` (-99.15%), `MELANIA` (-99.15%), `SPCX` (-99.15%).
2. **Live Cabal Traps Disqualified in Real-Time**:
   - **`SK` (Super Kitty)**: Spiked with $64k liquidity, then at 20:19 collapsed **-99.32% in a single red waterfall to $1.05k liquidity**. Disqualified by depth ratio before the drop; our capital was completely shielded.
   - **`s/acc` (Super Accelerationism)**: Appeared bullish with $68k liquidity and $1.04M volume, but harbored **77.71% bundler sniper concentration**. Disqualified by our 50% bundler ceiling (`maxBundlerPct: 0.50`). The 77.7% bundler cabal subsequently dumped the pool down to $2.9k liquidity.
   - **`SXI` (Super X Inu)**: Contained **70.47% bundler concentration** and bot-farmed churn (1,370 txns in 5 min, 377 sells). Strictly disqualified by `BUNDLER_CONCENTRATION_GATE` and `TRANSACTION_CHURN_GATE`.
   - **`snowball`**: Had sub-floor liquidity of **$17.72k** (< $20k floor), **53.73% bundlers**, and **22.01% top 10 concentration**. Disqualified across 4 separate gates.

#### Diagnostic Finding 2: The "Chicken-and-Egg" Preliminary Gate Deadlock (`SII`)

During the session, one genuine, organic Established Runner emerged: **`SII` (Super Intelligence Inu)**:

- **Liquidity**: $64.12k (comfortably above our $50k Established floor).
- **Market Cap**: $486.23k (healthy depth ratio of ~13%, above the 3% established floor).
- **Verified Holders**: **4,180 holders** (far exceeding the 250 holder floor).
- **Bundler Concentration**: **42.57%** (clean under our 50.0% bundler ceiling).
- **Top 10 Concentration**: **4.85%** (exceptionally distributed, well under 18.0%).
- **Dev Holdings**: 0%.
- **Buyer Dominance**: 344 buys vs 155 sells (2.22x buyer flow ratio).
- **Price Action**: Stair-stepped cleanly from $0.00015 to $0.00078 (+400%).

Despite meeting every single one of our target criteria, **`SII` never triggered a buy**.

##### Forensic Autopsy of the Deadlock:

1. In Sub-Phase 12.87, `BuyGateTriggerService.ts` defined:

   ```typescript
   const hasEstablishedHolders =
     marketContext.holdersCount !== undefined &&
     marketContext.holdersCount >= this.config.minEstablishedHolders;

   const isEstablished =
     item.liquidityUsd >= 50000 &&
     item.assetAgeSeconds >= 1800 &&
     item.assetAgeSeconds <= 7200 &&
     hasEstablishedHolders;
   ```

2. In `paper-trading-daemon.ts`:
   To avoid wasting API bandwidth querying DexScreener spot pairs and RugCheck on ineligible coins, the daemon executes a preliminary in-memory screening gate:
   ```typescript
   const preliminaryGate = buyGateService.evaluateCandidate(candidate); // marketContext is {}
   if (preliminaryGate.triggered) {
     // Fetch spot info and RugCheck metrics HERE
     // Run Stage 2 fullGateResult with marketContext.holdersCount
   }
   ```
3. During the preliminary in-memory check, `marketContext.holdersCount` is `undefined` (because RugCheck hasn't been called yet!).
4. Because `holdersCount` was `undefined`, `hasEstablishedHolders` evaluated to `false`.
5. Because `hasEstablishedHolders` was `false`, `isEstablished` was `false`, and `SII` was evaluated under **Micro-Cap Probe rules**.
6. Micro-cap probe rules enforce:
   - Maximum token age: 20–45 minutes (`MATURITY_WINDOW_GATE`).
   - Minimum depth ratio: 15% (`ADAPTIVE_DEPTH_BALANCE_GATE`).
7. `SII` was 69 minutes old with a 13% depth ratio (which is completely normal for an established pool).
8. **Result**: `SII` failed the preliminary gate every loop tick. The daemon **never queried RugCheck**, never learned that `SII` actually had **4,180 verified holders**, never armed it for the Retest Gate, and left it idling on the radar until it hit 2 hours and was dropped (`EXCEEDED_MAX_ESTABLISHED_AGE_2H`)!

#### Diagnostic Finding 3: Telemetry Gaps (Counterfactual Drop Tracking & Duration Recording)

1. **Counterfactual Expiry Tracking**: When `SII` exceeded 2 hours on the watchlist, its status was updated to `"DROPPED"`. However, dropped watchlist candidates were not registered with `tracker.recordCandidate(..., "FILTERED_REJECTED", ...)`. Consequently, `session-paper-observation-report.json` reported `missedWinnersCount: 0` because it stopped price-sampling `SII` after it was dropped.
2. **Session Duration in Zero-Trade Sessions**: In `PaperTradingDaemon.ts`, `daemon.lastTickAtMs` was only updated when open positions were ticked (`tickPosition`). In a session with zero entered trades, `lastTickAtMs` stayed at `startedAtMs`, causing `past-sessions.json` to record `durationMinutes: 1` despite running for the full 240 minutes.

---

## 2. Quantitative Architecture: Decoupling Preliminary vs Stage 2 Verification

We must decouple **Preliminary In-Memory Screening** (gate unblocking) from **Stage 2 Verified Evaluation** (fail-closed security):

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ STAGE 1: Preliminary In-Memory Screening (No Network Calls Yet)                        │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Candidate has Liquidity >= $50,000 AND Age between 1,800s and 7,200s                   │
│ MarketContext is {} (holdersCount is undefined, requireVerifiedHolders is undefined)   │
│                                                                                        │
│ DECISION: Classify as "Candidate Established Runner" (isCandidateEstablished = true)   │
│ • Age ceiling expands to 7,200s (2h)                                                   │
│ • Depth floor adjusts to 0.03 (3%)                                                     │
│ • Candidate passes preliminary screening!                                              │
└───────────────────────────────────┬────────────────────────────────────────────────────┘
                                    │ Unblocks Network Queries
                                    ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ STAGE 2: Full Evaluation (Spot Info & RugCheck Holders Count Fetched)                 │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Pass full marketContext into evaluateCandidate:                                        │
│ marketContext.holdersCount = rugMetrics.holdersCount                                   │
│ marketContext.requireVerifiedHolders = !isCandidateEstablished                         │
│                                                                                        │
│ CASE A: Dev Trap (SIC)                                                                 │
│ • Liquidity = $62k, Age = 38m, Holders = 86 (< 250 floor!)                             │
│ • hasEstablishedHolders = false -> isEstablished = false                               │
│ • Drops to Micro-Cap rules -> Fails INSUFFICIENT_HOLDERS_COUNT_FAILED                  │
│ • REJECTED! Zero capital risked.                                                       │
│                                                                                        │
│ CASE B: Bundler Cabal (s/acc)                                                          │
│ • Liquidity = $68k, Holders = 4.6k, Bundlers = 77.71% (> 50% ceiling!)                 │
│ • Fails EXCESSIVE_BUNDLER_PCT_FAILED                                                   │
│ • REJECTED! Zero capital risked.                                                       │
│                                                                                        │
│ CASE C: Genuine Established Runner (SII)                                               │
│ • Liquidity = $64k, Age = 69m, Holders = 4,180 (>= 250), Bundlers = 42.57% (<= 50%)    │
│ • hasEstablishedHolders = true -> isEstablished = true                                 │
│ • Passes all Stage 2 gates!                                                            │
│ • ARMED for Retest Pullback Gate -> Executes 1.0 SOL Established Buy!                 │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Sub-Phase 12.88 Deliverables

### Deliverable 1: Candidate Established Runner Pre-Screening Unblock in `BuyGateTriggerService.ts`

In [`backend/src/candidate-scanner/BuyGateTriggerService.ts`](file:///u:/Projects/TopG/backend/src/candidate-scanner/BuyGateTriggerService.ts):

1. Update `hasEstablishedHolders` evaluation in `evaluateCandidate`:

   ```typescript
   // Established / High-Volume pool detection
   // When holdersCount is provided (Stage 2 post-RugCheck), enforce minEstablishedHolders (>= 250).
   // When holdersCount is undefined:
   //   - If requireVerifiedHolders is false or undefined (Preliminary in-memory screening):
   //     permit the candidate to qualify preliminarily so spot info and RugCheck can be queried.
   //   - If requireVerifiedHolders is true: fail-closed (cannot be established).
   const hasEstablishedHolders =
     marketContext.holdersCount !== undefined
       ? marketContext.holdersCount >= this.config.minEstablishedHolders
       : !marketContext.requireVerifiedHolders;

   const isEstablished =
     item.liquidityUsd >= 50000 &&
     item.assetAgeSeconds >= 1800 &&
     item.assetAgeSeconds <= 7200 &&
     hasEstablishedHolders;
   ```

2. In Gate 11 (`BUNDLER_CONCENTRATION_GATE`), preserve the fail-closed check:
   If `holdersCount !== undefined`, verify against `effectiveMinHolders` (`250` if `isEstablished`, else `minHoldersCount`).

### Deliverable 2: Counterfactual Price Tracking on Dropped Candidates in `paper-trading-daemon.ts`

In [`backend/src/scripts/paper-trading-daemon.ts`](file:///u:/Projects/TopG/backend/src/scripts/paper-trading-daemon.ts):

When items on the watchlist transition to `"DROPPED"` (e.g. `EXCEEDED_MAX_WATCHLIST_AGE_20M`, `EXCEEDED_MAX_ESTABLISHED_AGE_2H`, or `REJECTED_INSUFFICIENT_LIVE_LIQUIDITY`):

1. Immediately register the drop in `tracker`:
   ```typescript
   tracker.recordCandidate(
     candidate,
     "FILTERED_REJECTED",
     spotPriceSol,
     currentNow,
     rejectionReason,
   );
   ```
2. Ensure `tracker.samplePrice` continues to track prices for these candidates during background intervals so that any subsequent pump $\ge +15\%$ is captured in `missedWinners`.

### Deliverable 3: Daemon Idle Heartbeat & Duration Telemetry in `PaperTradingDaemon.ts`

In [`backend/src/paper/PaperTradingDaemon.ts`](file:///u:/Projects/TopG/backend/src/paper/PaperTradingDaemon.ts):

1. Add a public `heartbeat` method:
   ```typescript
   heartbeat(nowTimestampMs?: number): void {
     this.lastTickAtMs = nowTimestampMs ?? this.clock();
   }
   ```
2. In [`backend/src/scripts/paper-trading-daemon.ts`](file:///u:/Projects/TopG/backend/src/scripts/paper-trading-daemon.ts):
   Call `daemon.heartbeat(currentNow)` in the main while loop on every tick.
3. This guarantees that `daemon.lastTickAtMs` reflects real time throughout the session, and `getHistoricalSummary()` correctly computes `durationMinutes: 240` on clean 4-hour halts.

---

## 4. Verification & Testing Matrix

1. **Unit Test Coverage (`BuyGateTriggerService.test.ts`)**:
   - Preliminary evaluation (with empty `marketContext = {}`):
     - An item with $60k liquidity and 3,600s age (60m) MUST pass preliminary screening (`triggered: true`).
   - Stage 2 evaluation with insufficient holders:
     - An item with $60k liquidity, 3,600s age, but `marketContext: { holdersCount: 86, requireVerifiedHolders: true }` MUST fail Stage 2 (`triggered: false`, `rejectionReason: "INSUFFICIENT_HOLDERS_COUNT_FAILED"`).
   - Stage 2 evaluation with sufficient holders:
     - An item with $60k liquidity, 3,600s age, `marketContext: { holdersCount: 4180, bundlerPct: 0.42 }` MUST pass Stage 2 (`triggered: true`).
2. **Daemon Heartbeat Unit Test (`PaperTradingDaemon.test.ts`)**:
   - Verify that calling `daemon.heartbeat(futureTimeMs)` updates `lastTickAtMs` and accurately calculates `durationMinutes` in `getHistoricalSummary()`.
3. **Architecture & Isolation Verification**:
   - `node scripts/check-isolation.mjs`
   - `node scripts/architecture-check.mjs`
   - `node scripts/verify-isolated.mjs`
   - Ensure all 774+ tests pass.
4. **Dashboard Build**:
   - `pnpm dashboard:build` passes cleanly with zero TypeScript errors.
