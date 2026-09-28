# Phase 12 Sub-Phase 12.8: Cohort-Adaptive Dynamic Ratchets & Execution Pipeline Unblocking

## 1. Executive Summary & Diagnostic Findings

In **Sub-Phase 12.7** (`session-paper-12.7-01`), our defensive gates performed with exceptional precision:

- **Capital Preserved**: Preserved 9.8842 SOL (-1.16% drawdown over 96.2 minutes) with 0 open positions at termination.
- **Rugs Avoided**: 11 dangerous honeypots and rug pulls were rejected, including `all/inCat` (which plummeted -90% from \$24k to \$2.4k shortly after detection), `two` (-58%), and `trade` (-55%).
- **Execution Bottlenecks Uncovered**:
  1. **Watchlist Execution Drop in `paper-trading-daemon.ts` (Line 436)**:
     `const poolRecord = rawPools.find(p => p.mintAddress === candidate.mintAddress)`
     Because `rawPools` only contains the single 25-item slice polled during that 5-second tick, any candidate admitted to the watchlist on an earlier tick had `poolRecord === undefined`. As a result, even when all 9 buy gates passed, the buy was silently skipped!
  2. **Redundant Legacy 15-Minute Evaluator in `PaperTradingDaemon.ts` (Line 287)**:
     `const evaluation = this.scannerEvaluator.evaluate(pool, this.scannerConfig, nowSec)`
     `this.scannerConfig` defaults to `CANDIDATE_SCANNER_DEFAULTS` with `maxAgeSec = 900` (15 minutes) and `maxLmcRatio = 0.30`. Even if a pool was found, any established runner (>15m old or with L/MC < 15%) was silently rejected at the daemon entry point.
  3. **Rigid Exit Profiles for High-Risk vs Established Assets**:
     Both fast-moving micro-caps and established runners were evaluated against identical stop-loss and profit targets. Risky micro-caps need faster profit-taking (+10% Tier 1, +25% Tier 2) and tighter loss cuts (-12% stop, 45s grace), whereas established runners need room to breathe (+15% Tier 1, +50% Tier 2, -18% stop, 120s grace).

---

## 2. Technical Deliverables Specification

### Deliverable 1: Cohort-Adaptive Dynamic Ratchet Configurations

**Files**:

- `backend/src/exits/DynamicRatchetTypes.ts`
- `backend/src/exits/DynamicRatchetService.ts`

1. **Define Cohort Configurations in `DynamicRatchetTypes.ts`**:

   ```typescript
   export type CohortTier = "MICRO_CAP" | "ESTABLISHED";

   export const MICRO_CAP_DYNAMIC_RATCHET_CONFIG: DynamicRatchetConfig = {
     catastrophicFloorBps: -1200, // -12.0% hard stop
     drawdownTriggerBps: -600, // -6.0% drawdown warning
     drawdownRecoveryBps: -300, // -3.0% recovery
     drawdownGracePeriodMs: 45_000, // 45s grace period for fast micro-cap dump protection
     scratchPnlMinBps: 50, // +0.5%
     scratchPnlMaxBps: 150, // +1.5%
     tier1PeakThresholdBps: 1000, // +10.0% take-profit Tier 1 (sell 50%, lock floor to breakeven +0.0%)
     tier1LockedFloorBps: 0, // Breakeven (+0.0%) floor
     tier2PeakThresholdBps: 2500, // +25.0% take-profit Tier 2 (sell 25%, lock floor to +18.0%)
     tier2LockedFloorBps: 1800, // +18.0% floor
   };

   export const ESTABLISHED_DYNAMIC_RATCHET_CONFIG: DynamicRatchetConfig = {
     catastrophicFloorBps: -1800, // -18.0% hard stop (wider room for established swings)
     drawdownTriggerBps: -800, // -8.0% drawdown warning
     drawdownRecoveryBps: -400, // -4.0% recovery
     drawdownGracePeriodMs: 120_000, // 120s grace period
     scratchPnlMinBps: 50, // +0.5%
     scratchPnlMaxBps: 150, // +1.5%
     tier1PeakThresholdBps: 1500, // +15.0% take-profit Tier 1 (sell 50%, lock floor to breakeven +0.0%)
     tier1LockedFloorBps: 0, // Breakeven (+0.0%) floor
     tier2PeakThresholdBps: 5000, // +50.0% take-profit Tier 2 (sell 25%, lock floor to +40.0%)
     tier2LockedFloorBps: 4000, // +40.0% floor
   };
   ```

2. **Allow Config Override in `DynamicRatchetService.ts`**:
   Update `evaluate(state: PositionRatchetState, context: MarketEvaluationContext, configOverride?: Partial<DynamicRatchetConfig>): RatchetEvaluationResult`:
   - Use `const activeConfig = configOverride ? { ...this.config, ...configOverride } : this.config;` throughout `evaluate()`.

---

### Deliverable 2: Execution Pipeline Unblocking in `paper-trading-daemon.ts`

**File**: `backend/src/scripts/paper-trading-daemon.ts`

1. **Replace `rawPools.find` Single-Slice Dependency**:
   When `fullGateResult.triggered` is true, if `rawPools.find(...)` returns undefined, construct the `ScannedPoolRecord` directly from the `candidate` metadata and `spotInfo`:
   ```typescript
   let poolRecord = rawPools.find((p) => p.mintAddress === candidate.mintAddress);
   if (!poolRecord) {
     poolRecord = {
       poolId: candidate.poolId,
       mintAddress: candidate.mintAddress,
       symbol: candidate.symbol,
       decimals: 9,
       baseMint: candidate.mintAddress,
       liquidityUsd: candidate.liquidityUsd,
       marketCapUsd: candidate.marketCapUsd,
       openTimeSec: Math.floor(currentNow / 1000) - candidate.assetAgeSeconds,
       lpBurnPct: candidate.lpBurnPct ?? 100,
       mintAuthority: null,
       freezeAuthority: null,
       volume5mUsd: candidate.volume5mUsd,
       txCount5m: candidate.buys5m + candidate.sells5m,
       buys5m: candidate.buys5m,
       sells5m: candidate.sells5m,
       spotPriceUsd:
         candidate.spotPriceUsd > 0 ? candidate.spotPriceUsd : spotInfo.spotPriceSol * 150,
       fetchedAt: new Date(currentNow).toISOString(),
     };
   }
   ```
2. **Pass Sizing and Cohort Config**:
   Pass `cohortConfig` (`MICRO_CAP_DYNAMIC_RATCHET_CONFIG` or `ESTABLISHED_DYNAMIC_RATCHET_CONFIG`) into `daemon.processScannedPool`.

---

### Deliverable 3: Unblock Daemon Admission in `PaperTradingDaemon.ts`

**File**: `backend/src/paper/PaperTradingDaemon.ts`

1. **Update `PaperPosition`**:
   Add optional fields to `PaperPosition`:
   ```typescript
   export interface PaperPosition {
     // ... existing fields ...
     readonly cohort?: CohortTier | undefined;
     readonly ratchetConfig?: DynamicRatchetConfig | undefined;
   }
   ```
2. **Update `processScannedPool` Signature**:
   ```typescript
   processScannedPool(
     pool: ScannedPoolRecord,
     nowTimestampMs?: number,
     entryPriceSolOverride?: number,
     positionSizeSolOverride?: number,
     options?: {
       bypassScannerEvaluation?: boolean;
       cohort?: CohortTier;
       ratchetConfig?: DynamicRatchetConfig;
     },
   ): boolean
   ```
   - In step 2 (Anti-Rug & L/MC Evaluation Check), skip `this.scannerEvaluator.evaluate()` if `options?.bypassScannerEvaluation === true`.
   - In step 3 (Execute Paper Buy), attach `options?.cohort` and `options?.ratchetConfig` to the created `position`.
3. **Update `tickPosition`**:
   When calling `this.ratchetService.evaluate(position.ratchetState, marketContext, position.ratchetConfig)`, pass `position.ratchetConfig` so the position evaluates against its cohort-specific thresholds!

---

### Deliverable 4: Volume Breakout Flow Absorption Relaxation

**File**: `backend/src/candidate-scanner/BuyGateTriggerService.ts`

In `BuyGateTriggerService.ts` Gate 4 (`FLOW_ABSORPTION_GATE`):
Currently:

```typescript
const isHighVolumeBreakout = item.volume5mUsd >= 50000;
const effectiveMinRatio = isHighVolumeBreakout
  ? Math.min(this.config.minBuyToSellRatio, 1.2)
  : this.config.minBuyToSellRatio;
```

Update to:

```typescript
// For strong volume surges (>= $15k in 5m), relax buyer dominance requirement to 1.25x (or 1.15x if >= $35k)
let effectiveMinRatio = this.config.minBuyToSellRatio;
if (item.volume5mUsd >= 35000) {
  effectiveMinRatio = Math.min(effectiveMinRatio, 1.15);
} else if (item.volume5mUsd >= 15000) {
  effectiveMinRatio = Math.min(effectiveMinRatio, 1.25);
}
```

---

## 3. Verification & Compliance Requirements

1. **Test Suite Integrity**:
   - `node scripts/check-isolation.mjs` must pass with 0 leaks.
   - `node scripts/architecture-check.mjs` must pass with 0 policy violations.
   - `pnpm -r build` and typechecks must emit 0 errors.
   - All existing 737+ vitest tests across `measurement-analysis`, `h2`, `h3`, `h4` must pass without regressions.
2. **New Unit Tests**:
   - Unit test in `backend/src/exits/DynamicRatchetService.test.ts` verifying `MICRO_CAP_DYNAMIC_RATCHET_CONFIG` triggers Tier 1 at +10% and Tier 2 at +25% with 45s grace period.
   - Unit test in `backend/src/paper/PaperTradingDaemon.test.ts` verifying `processScannedPool` with `bypassScannerEvaluation: true` admits pools older than 15 minutes.
   - Unit test in `backend/src/candidate-scanner/BuyGateTriggerService.test.ts` verifying volume surges >= \$15,000 admit buy-to-sell ratios at 1.25x.
