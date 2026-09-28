# Sub-Phase 12.7: Live RugCheck Alignment, Adaptive L/MC Gate & Tiered Sizing

**Date**: 2026-09-27  
**Status**: APPROVED FOR DEV IMPLEMENTATION  
**Session Analyzed**: `session-paper-12.6-01` (4-Hour Live Saturday Night Session: **8.3070 SOL / -16.93%**, 11 trades, 4 winners banking +1.06 SOL, 7 losses)

---

## 1. 4-Hour Live Test Audit & Root Cause Analysis

### 1.1 The Good: Multi-Timeframe Winners & Automated Lifecycle

- **Winners Banked +1.0658 SOL**:
  - `6UhUkSBc...pump`: **+0.4919 SOL (+49.19%!)** — Held for 66 minutes. At the 4-hour mark, `SESSION_DURATION_CASHOUT` automatically liquidated the runner at spot price into realized cash.
  - `7ESoDXqw...777` (`LUCKY`): **+0.4119 SOL (+41.19%!)** — Established Raydium pool surged past Tier 1 and triggered Tier 2 profit lock.
  - `Di6PQX4D...pump` (`PUMPCAT`): **+0.1006 SOL (+10.06%)** — Banked 50% partial cash at +15% before exit.
  - `2pMyVuWt...pump`: **+0.0614 SOL (+6.14%)** — Tier 1 ratchet lock.
- **The Lifecycle System Works**:
  - Ratchets, milestone partial profit-taking, and duration-based cashout performed flawlessly.

### 1.2 The Bad: Forensic Root Cause of the 7 Losses

1. **The RugCheck Integration Blindspot**:
   - Dev queried `/report/summary` instead of `/report`. The summary endpoint **omits `totalHolders` and `topHolders`**, causing `holdersCount` to be `undefined`.
   - Dev searched for the literal string `"bundled"` inside `risk.name`. In reality, RugCheck flags danger through its overall **`score`** (scores $>700$ mean danger) and the risk tag `level: 'danger'`.
   - As a result, the gate quietly passed `true` on catastrophic honeypots:
     - `2z1kj...pump` (-98.29% loss!): RugCheck score **2,884** (Danger) with only **39 holders**!
     - `3wrok...pump` (-52.20% loss): RugCheck score **2,822** (Danger) with only **120 holders**!
     - `4Z9e...pump` (-13.12% loss): RugCheck score **2,853** (Danger) with only **87 holders**!
2. **The 15% Minimum L/MC Gate Locked Out Raydium Top Traded Pools**:
   - The new Raydium 24h stream discovered real market leaders (`MARTIANS` with $140k liq / $1.89M MC, `moin` with $105k liq / $1.02M MC, `VAULT` with $74k liq / $533k MC).
   - Because established coins have 5% to 12% depth, our `minLmcRatio = 0.15` (15%) rejected **100% of the established pools**, forcing the bot to trade only unproven micro-caps.
3. **Disproportionate Micro-Cap Position Sizing**:
   - Risking 1.0 SOL (10% of portfolio) on a 39-holder micro-cap allowed a single 1-block dev rug (`2z1kj`) to wipe out **0.9829 SOL** (58% of the entire session's loss).

---

## 2. Technical Deliverables for Dev Agent

### Deliverable 1: Live RugCheck Report Alignment (`BuyGateTriggerService.ts`)

- **Query Endpoint**:
  Update `fetchRugCheckMetrics` to query the full report endpoint:
  ```text
  https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(mintAddress)}/report
  ```
- **Parse Security Signals**:
  ```ts
  const data = (await res.json()) as {
    score?: number;
    score_normalised?: number;
    risks?: Array<{ name?: string; value?: string; score?: number; level?: string }>;
    topHolders?: Array<{ pct?: number; address?: string }>;
    totalHolders?: number;
  };
  ```
  Extract:
  - `rugScore`: `typeof data.score === "number" ? data.score : 0`
  - `hasDangerRisk`: `Array.isArray(data.risks) && data.risks.some(r => r.level === "danger")`
  - `holdersCount`: `typeof data.totalHolders === "number" ? data.totalHolders : undefined`
  - `top10HolderPct`: compute sum of `topHolders.slice(0, 10).pct / 100` if array present.
- **Add to `BuyGateConfig` & `BUY_GATE_DEFAULTS`**:
  - `maxRugScore: number = 700` (reject any token with score > 700)
  - `rejectDangerRisks: boolean = true` (reject if any risk level is "danger")
  - `minHoldersCount: number = 350` (reject micro-caps with < 350 holders)
  - `maxTop10HolderPct: number = 0.30` (reject if top 10 hold > 30%)
- **Gate 9 (`RUGCHECK_SECURITY_GATE` / `BUNDLER_CONCENTRATION_GATE`) Rules**:
  - Reject with `RUGCHECK_HIGH_RISK_SCORE_FAILED` if `rugScore > this.config.maxRugScore`.
  - Reject with `RUGCHECK_DANGER_FLAG_FAILED` if `this.config.rejectDangerRisks && hasDangerRisk`.
  - Reject with `INSUFFICIENT_HOLDERS_COUNT_FAILED` if `holdersCount !== undefined && holdersCount < this.config.minHoldersCount`.
  - Reject with `TOP_10_CONCENTRATION_FAILED` if `top10HolderPct !== undefined && top10HolderPct > this.config.maxTop10HolderPct`.
- **Wire into `paper-trading-daemon.ts`**:
  Ensure `marketContext` passes `rugScore`, `hasDangerRisk`, `holdersCount`, and `top10HolderPct` to `buyGateService.evaluateCandidate`.
- **Unit Tests**: Update `BuyGateTriggerService.test.ts` to test `score > 700`, `level === "danger"`, and `totalHolders < 350`.

---

### Deliverable 2: Adaptive L/MC Depth Gate (`BuyGateTriggerService.ts`)

- In `evaluateCandidate(item: WatchlistCandidateItem)`:
  - Check whether the candidate is an **Established / High-Volume pool**:
    ```ts
    const isEstablished =
      item.liquidityUsd >= 40000 || item.assetAgeSeconds >= 3600 || item.marketCapUsd >= 250000;
    ```
  - Apply adaptive depth minimum:
    ```ts
    const effectiveMinLmc = isEstablished ? 0.03 : this.config.minLmcRatio; // 3% for established, 15% for micro-caps
    const depthPassed =
      item.lmcRatio >= effectiveMinLmc && item.lmcRatio <= this.config.maxLmcRatio;
    ```
  - This unlocks genuine high-volume market leaders (`MARTIANS`, `moin`, `VAULT`) while preserving the 15% anti-dilution filter for brand-new bonding curve tokens.
- **Unit Tests**: Update `BuyGateTriggerService.test.ts` verifying that a token with $100k liquidity and $1.5M market cap (L/MC 6.6%) passes when established.

---

### Deliverable 3: Tiered Cohort Position Sizing (`PaperTradingDaemon.ts` & `paper-trading-daemon.ts`)

- Modify dynamic position sizing in `paper-trading-daemon.ts`:

  ```ts
  const isEstablished =
    candidate.liquidityUsd >= 40000 ||
    candidate.assetAgeSeconds >= 3600 ||
    candidate.marketCapUsd >= 250000;

  // Tiered Sizing: 0.25 SOL for unproven micro-caps; 0.80 - 1.0 SOL for established runners
  const targetCohortSize = isEstablished ? 0.8 : 0.25;

  const dynamicSize = Math.max(
    0.1,
    Math.min(
      targetCohortSize,
      parseFloat((currentSnap.currentPortfolioSol / config.maxOpenPositions).toFixed(3)),
    ),
  );
  ```

- **Rationale**:
  - Even if a micro-cap dev dumps in 1 block (-50%), the loss on a 0.25 SOL position is only -0.125 SOL (1.25% of portfolio), easily offset by one runner.
  - Established runners (with deep liquidity and low slippage) receive full capital weight (0.80 SOL) to drive primary profits.

---

### Deliverable 4: Shared Schemas & Past Sessions Registry Update

- In `shared/src/phase12-dashboard-schemas.ts`:
  - Ensure `BACKFILLED_PAST_SESSIONS` accurately reflects:
    - `session-paper-12.3-01`: -4.20% (8 trades, 3W / 5L)
    - `session-paper-12.4-01`: +7.08% (12 trades, 8W / 4L)
    - `session-paper-12.5-01`: -0.26% (7 trades, 2W / 5L)
    - `session-paper-12.6-01`: -16.93% (11 trades, 4W / 7L, +1.06 SOL in wins, 1 cashout)

---

## 3. Verification & Acceptance Criteria

1. `node scripts/verify-isolated.mjs` must pass with 0 failures across all backend tests.
2. `pnpm --filter @nexustrade/research-dashboard test` must pass all tests.
3. `pnpm dashboard:build` must compile with 0 type errors.
4. Live test execution of `BuyGateTriggerService.fetchRugCheckMetrics("2z1kjXiQzWtq75QEnAEQEMyS332toNEcSno3wceJpump")` must return `rugScore: 2884`, `hasDangerRisk: true`, and `holdersCount: 39`, triggering an immediate rejection.
