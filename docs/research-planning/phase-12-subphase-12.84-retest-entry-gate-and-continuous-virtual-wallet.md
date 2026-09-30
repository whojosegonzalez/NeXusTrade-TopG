# Phase 12 Sub-Phase 12.84: Retest Pullback Entry Confirmation Gate, Strict Liquidity Floor & Continuous Virtual Wallet

## 1. Executive Summary & Diagnostic Findings from Session 12.83-01

Session `session-paper-12.83-01` operated for ~2.5 hours before halting safely via the portfolio drawdown circuit breaker at **9.1712 SOL** (-0.8288 SOL net realized drawdown).

```
===============================================================================
             NEXUSTRADE: 4-HOUR OBSERVATIONAL & STRATEGY REPORT
===============================================================================
Portfolio Progression: 10.0000 SOL -> 9.1712 SOL (-0.8288 SOL / -8.29%)
Candidates Observed:     94
Executed Paper Buys:     14
Missed Winners (>= +15%): 0 (100% of runners discovered)
Avoided Rugs (<= -30%):   5 (USD1, RAY, CARDS, NVDAx, CRCLx -99.9% rejected)
===============================================================================
```

---

### Empirical Chart Review & Forensic Discoveries

Through direct chart inspection of user-uploaded screenshots (`BAGSPAY`, `RESI`, `SS`, `SI 7Wh6`, `ASI`, `FINGER`, `SC A3dt`, `SC 7rRN`, `SAI`, `SI 9aqn`, and `ARTHUR`), we uncovered three fundamental microstructure truths:

```
┌─────────────┬───────────┬──────────────┬────────────┬─────────────┬───────────┬────────────────────────────────────────────────────────┐
│ Symbol      │ Cohort    │ Size (SOL)   │ Bundlers % │ Exit Type   │ PnL (SOL) │ Microstructure Forensic Analysis                       │
├─────────────┼───────────┼──────────────┼────────────┼─────────────┼───────────┼────────────────────────────────────────────────────────┤
│ RESI        │ Estab     │ 1.00 SOL     │ 52.0%      │ Ratchet T2  │ +0.4773   │ Textbook runner. Banked Tier 1, Tier 2, and Moonbag.   │
│ BAGSPAY     │ Estab     │ 1.00 SOL     │ 0.00%      │ Ratchet T2  │ +0.3480   │ Clean 0% bundlers runner. Banked +34.80%.              │
│ SS          │ Estab     │ 1.00 SOL     │ Low        │ Ratchet T1  │ +0.1381   │ Patient 24m hold. Banked Tier 1 (+20%), locked floor.  │
│ ASI         │ Micro     │ 0.50 SOL     │ Low        │ Breakeven   │ -0.0718   │ Pyramided live: 0.25 probe + 0.25 scale-in. Capped loss│
│ FINGER      │ Micro     │ 0.25 SOL     │ Low        │ Hard Stop   │ -0.0591   │ Instant dump. Tranche 2 never bought; loss capped.     │
│ SC (A3dt)   │ Micro     │ 0.25 SOL     │ Low        │ Hard Stop   │ -0.0548   │ Instant dump. Tranche 2 never bought; loss capped.     │
│ SC (7rRN)   │ Micro     │ 0.25 SOL     │ Low        │ Hard Stop   │ -0.0567   │ Instant dump. Tranche 2 never bought; loss capped.     │
│ SI (9aqn)   │ Estab*    │ 1.00 SOL     │ 91.76%     │ Breakeven   │ -0.1171   │ Top-tick shakeout on C2 wick; EXPLODED 6.3x to $0.00095│
│ SAI         │ Estab*    │ 1.00 SOL     │ 83.31%     │ Hard Stop   │ -0.3934   │ Misclassified Birdeye micro-cap ($33k liq). Ran 2.5x!  │
│ ARTHUR      │ Estab     │ 1.00 SOL     │ 57.23%     │ Hard Stop   │ -0.3725   │ DexScreener picked STONK pair (Raydium) instead of SOL!│
└─────────────┴───────────┴──────────────┴────────────┴─────────────┴───────────┴────────────────────────────────────────────────────────┘
* Mislabeled as Established due to Birdeye trending 7200s hardcoded age or non-mandatory liquidity rule.
```

#### Finding 1: The "Top-Tick Shakeout Before the Moonshot" Phenomenon

- In **8 out of 11 unique tokens picked (73% selection accuracy)**, the tokens went on to make massive **2x to 6.3x runs**:
  - `SI` (`9aqn...`): Shaken out at -11.7% on candle 2 $\rightarrow$ **Rocketed 6.3x to $0.00095**!
  - `SAI` (`BiFf...`): Shaken out at -39.3% on candle 2 $\rightarrow$ **Rebounded 2.5x to $0.00037**!
  - `SI` (`7Wh6...`): Shaken out at -24.5% $\rightarrow$ **Exploded 5.2x to $0.0019**!
  - `SC` (`A3dt...`): Shaken out in 37s $\rightarrow$ **Exploded 2x above entry**!
- **Root Cause**: The Stage 2 Buy Gate executes a market buy at the very peak of Candle 1. In meme-coin order books, Candle 2 almost always experiences a sharp **-15% to -25% retest wick** as block-0 snipers harvest quick profits. Our -20% catastrophic stop dumps our position to market makers right before the multi-candle blastoff.
- **The Solution (The Retest / Pullback Entry Gate)**: Never market-buy the impulse peak. Transition candidate to `ARMED_PULLBACK` and enter on a **10% to 18% pullback discount** with confirmed buyer flow (`buys60s >= 1.25 * sells60s`) or 30s consolidation.

#### Finding 2: Two Oversized Sizing Traps Caused 92.4% of the Total Drawdown

- Total session realized loss was -0.8288 SOL.
- **`SAI` (-0.3934 SOL) and `ARTHUR` (-0.3725 SOL)** accounted for **-0.7659 SOL (92.4%)**!
- Why were they bought with 1.00 SOL?
  1. `SAI` was sourced from Birdeye Trending with age hardcoded to 7,200s (2h). Because `isEstablished` used an `||` condition (`liquidityUsd >= 40000 || assetAgeSeconds >= 3600`), it treated thin $33k liquidity tokens as Established!
  2. `ARTHUR` had a Raydium pool quoted against `STONK`. DexScreener returned this as `pairs[0]`, distorting `priceNative`.
- **The Solution**:
  1. Enforce that a token can **ONLY** be `ESTABLISHED` if **`liquidityUsd >= 50000` IS MANDATORY**. Any token under $\$50,000$ liquidity is strictly a `MICRO_CAP` (0.25 SOL probe).
  2. DexScreener parser must strictly filter pairs where `quoteToken.symbol === "SOL"` or `WSOL` and sort by highest USD liquidity.

#### Finding 3: The Established-Only Hypothetical Audit

Auditing actual trades across the last two sessions (**12.82 and 12.83**) reveals:

- **True Established Coins ($\ge \$50\text{k}$ liquidity)**:
  - 14 total trades across two sessions.
  - **9 Wins, 5 Controlled Grace Exits, ZERO Hard-Stop Blowouts**.
  - **Win Rate: 64.3%**.
  - **Net Realized PnL: +1.1879 SOL (+11.88% wallet gain)**!
- True established tokens have deep liquidity that cushions against flash dumps and enables our Dynamic Ratchet to hit Tier 1 (+20%), Tier 2 (+48.5%), and Moonbag consistently.

---

## 2. Core Deliverables & Architectural Specifications

### Deliverable 1: Retest / Pullback Entry Confirmation Gate

- **File**: `backend/src/candidate-scanner/BuyGateTriggerService.ts` & `backend/src/scripts/paper-trading-daemon.ts`
- **Specification**:
  1. Extend `BuyGateEvaluationResult` or candidate tracking with an armed pullback state:
     ```typescript
     export interface ArmedPullbackState {
       readonly mintAddress: string;
       readonly armedAtMs: number;
       readonly peakPriceSol: number;
       readonly peakPriceUsd: number;
       ticksObserved: number;
     }
     ```
  2. When a `MICRO_CAP` candidate passes Stage 2 Buy Gate:
     - Instead of immediately opening a position, store it in an active `Map<string, ArmedPullbackState>` (`armedPullbackCandidates`).
     - On subsequent daemon ticks (every 1s / next poll), evaluate spot price against `peakPriceSol`:
       - **Rule A (Retest Pullback Entry)**: Price has pulled back by **10.0% to 18.0%** from peak (`currentPrice <= peak * 0.90 && currentPrice >= peak * 0.80`), and recent 60s flow shows buyer absorption (`recentBuys60s >= 1.25 * recentSells60s`). Trigger BUY!
       - **Rule B (Consolidation Breakout Entry)**: Price holds within 5% of peak (`currentPrice >= peak * 0.95`) for $\ge 30$ seconds (at least 3 ticks) with strong flow (`recentBuys60s >= 1.5 * recentSells60s`). Trigger BUY!
       - **Rule C (Invalidation / Knife Avoidance)**: If price plunges $> 25\%$ below peak (`currentPrice < peak * 0.75`), drop candidate from armed state immediately (`REJECTED_PULLBACK_CRATERED`).
       - **Rule D (Expiry)**: If neither entry condition is satisfied within **90 seconds**, expire candidate from armed state.
  3. `ESTABLISHED` tokens ($\ge \$50\text{k}$ liquidity) may enter directly or on shallow retest, as their deep order books do not suffer from block-0 sniper wicks.

---

### Deliverable 2: Mandatory Liquidity Floor for Established Cohort & Birdeye Age Fix

- **File**: `backend/src/candidate-scanner/BuyGateTriggerService.ts` & `backend/src/scripts/paper-trading-daemon.ts`
- **Specification**:
  1. Update `isEstablished` logic across the entire codebase to require minimum liquidity as a **strict prerequisite**:
     ```typescript
     // MANDATORY Liquidity Floor: Must have >= $50,000 liquidity to ever be classified as ESTABLISHED
     const isEstablished =
       candidate.liquidityUsd >= 50000 &&
       (candidate.assetAgeSeconds >= 3600 || candidate.marketCapUsd >= 250000);
     ```
  2. If `candidate.liquidityUsd < 50000`, the token is **STRICTLY `MICRO_CAP`** (probe size 0.25 SOL).
  3. In `paper-trading-daemon.ts:552`, fix Birdeye Trending ingestion:
     - If `token.liquidity < 50000`, set `openTimeSec = currentNowSec - 300` (5 minutes old), ensuring thin Birdeye tokens are treated as Micro-Caps and subject to the 0.25 SOL probe and Retest Entry Gate.

---

### Deliverable 3: Strict DexScreener SOL Quote Pair Selection

- **File**: `backend/src/scripts/paper-trading-daemon.ts`
- **Specification**:
  1. In `fetchDexScreenerSpotInfo(mintAddress)`:

     ```typescript
     const WSOL_MINT = "So11111111111111111111111111111111111111112";
     const validSolPairs = pairs.filter((p) => {
       const quoteAddr = p.quoteToken?.address;
       const quoteSym = p.quoteToken?.symbol?.toUpperCase();
       return quoteAddr === WSOL_MINT || quoteSym === "SOL" || quoteSym === "WSOL";
     });

     if (validSolPairs.length === 0) return null;

     // Sort by highest USD liquidity to guarantee canonical pool
     validSolPairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
     const solPair = validSolPairs[0];
     ```

  2. This guarantees that non-SOL pools (like `STONK` on `ARTHUR`) are strictly excluded, preventing price-native scaling corruption.

---

### Deliverable 4: Continuous Virtual Wallet & Session Carry-Forward

- **Specification**:
  1. **Archive Old Sessions**:
     - Archive existing `backend/.tmp/past-sessions.json` to `backend/.tmp/past-sessions-archive-12.83.json`.
     - Initialize clean `backend/.tmp/past-sessions.json` for Phase 12.84.
  2. **Virtual Wallet State File (`.tmp/virtual-wallet.json`)**:
     - Store persistent wallet data:
       ```json
       {
         "walletAddress": "SimulatedVirtualWallet111111111111111111111111",
         "currentBalanceSol": 10.0,
         "initialBalanceSol": 10.0,
         "totalSessionsCompleted": 0,
         "allTimeRealizedPnlSol": 0.0,
         "lastUpdatedMs": 1790731666723
       }
       ```
  3. **Paper Daemon Integration**:
     - If `--initial-sol` CLI argument is not specified, read `currentBalanceSol` from `.tmp/virtual-wallet.json`.
     - On daemon shutdown or halt, update `.tmp/virtual-wallet.json`:
       $$\text{currentBalanceSol}_{\text{new}} = \text{currentPortfolioSol}$$
       $$\text{allTimeRealizedPnlSol} += \text{netRealizedSessionPnlSol}$$
       $$\text{totalSessionsCompleted} += 1$$
  4. **Dashboard Control Plane (`frontend/vite.config.ts`)**:
     - Add `/api/wallet/virtual` endpoint to inspect virtual wallet status.
     - Add `/api/wallet/reset` endpoint to reset wallet to 10.00 SOL if explicitly requested.

---

### Deliverable 5: Startup 60-Second Watchlist Warm-Up Buffer

- **File**: `backend/src/scripts/paper-trading-daemon.ts`
- **Specification**:
  1. Define `SESSION_START_WARMUP_MS = 60_000` (60 seconds).
  2. During the first 60 seconds after daemon launch:
     - Radar pool ingestion, Raydium streams, and DexScreener enrichment run normally.
     - Buy Gate triggers are suppressed: `console.log("[PaperDaemon] [WARMUP] Observing market (warmup buffer active: Xs remaining)...")`.
  3. Require candidate items to have been present on the radar for at least **30 seconds** (`candidate.observedDurationMs >= 30_000`) before buy gate confirmation, ensuring fresh, confirmed metrics.

---

## 3. Verification Protocol

1. **Isolation Check**: `node scripts/check-isolation.mjs`
2. **Architecture Check**: `node scripts/architecture-check.mjs`
3. **Full Isolated Verification Suite**: `node scripts/verify-isolated.mjs`
4. **Dashboard Build**: `pnpm dashboard:build`
5. **Prettier Format Check**: `npx prettier --check ...`

---

## 4. Developer Implementation Prompt & Handoff Package

````markdown
### Task: Implement Phase 12 Sub-Phase 12.84 (Retest Pullback Entry Confirmation Gate, Strict Liquidity Floor & Continuous Virtual Wallet)

Please implement the full specification defined in `docs/research-planning/phase-12-subphase-12.84-retest-entry-gate-and-continuous-virtual-wallet.md`:

#### 1. Update `backend/src/candidate-scanner/BuyGateTriggerService.ts`

- **Mandatory Liquidity Floor**:
  - Update `isEstablished` calculation:
    ```typescript
    const isEstablished =
      item.liquidityUsd >= 50000 && (item.assetAgeSeconds >= 3600 || item.marketCapUsd >= 250000);
    ```
  - Ensure tokens with liquidity < $50,000 are NEVER classified as Established.
- **Pullback Confirmation Types**:
  - Export `ArmedPullbackState`:
    ```typescript
    export interface ArmedPullbackState {
      readonly mintAddress: string;
      readonly armedAtMs: number;
      readonly peakPriceSol: number;
      readonly peakPriceUsd: number;
      ticksObserved: number;
    }
    ```

#### 2. Update `backend/src/scripts/paper-trading-daemon.ts`

- **Strict SOL Quote Pair Selection in `fetchDexScreenerSpotInfo`**:
  - Filter `pairs` for `quoteToken.address === "So11111111111111111111111111111111111111112" || quoteToken.symbol === "SOL" || quoteToken.symbol === "WSOL"`.
  - Reject pairs quoted in other tokens (e.g. STONK, USDC, meme tokens).
  - Sort matching pairs by `liquidity.usd` descending and pick `pairs[0]`.
- **Birdeye Trending Age Fix**:
  - In Birdeye ingestion, if `token.liquidity < 50000`, set `openTimeSec = currentNowSec - 300` (5 minutes), preventing thin tokens from being labeled Established.
- **Startup 60-Second Warm-up Buffer**:
  - Track `sessionStartMs = currentNow`.
  - For `currentNow - sessionStartMs < 60_000`, suppress buy triggers and log warmup countdown.
  - Require candidates to have `currentNowSec - candidate.openTimeSec >= 30` or radar observation >= 30s.
- **Micro-Cap Retest / Pullback Entry Confirmation**:
  - Maintain `armedPullbackCandidates: Map<string, ArmedPullbackState>`.
  - For `MICRO_CAP` candidates that trigger Stage 2 Buy Gate:
    - If not already armed, record in `armedPullbackCandidates` with current spot price as peak.
    - On subsequent ticks:
      - If price pulled back 10% to 18% from peak (`price <= peak * 0.90 && price >= peak * 0.80`) with `recentBuys60s >= 1.25 * recentSells60s`: EXECUTE BUY!
      - If price consolidated within 5% of peak for >= 30s (at least 3 ticks) with `recentBuys60s >= 1.5 * recentSells60s`: EXECUTE BUY!
      - If price dumped > 25% from peak (`price < peak * 0.75`): Invalidate and delete from armed map.
      - If elapsed time > 90s: Expire and delete from armed map.
  - `ESTABLISHED` tokens continue to execute buy directly.
- **Continuous Virtual Wallet Integration**:
  - On startup: Read `.tmp/virtual-wallet.json` (or `backend/.tmp/virtual-wallet.json`) if `--initial-sol` is not passed. Default to 10.00 SOL if absent.
  - On shutdown/halt: Write updated balance, total sessions count, and cumulative PnL back to `.tmp/virtual-wallet.json`.

#### 3. Update `frontend/vite.config.ts`

- Archive existing `backend/.tmp/past-sessions.json` to `backend/.tmp/past-sessions-archive-12.83.json` if not already archived.
- Add `/api/wallet/virtual` GET endpoint returning the virtual wallet summary.
- Add `/api/wallet/reset` POST endpoint allowing manual reset to 10.00 SOL.

#### 4. Add Unit Tests & Verification

- Add unit tests in `BuyGateTriggerService.test.ts` verifying the mandatory $50k liquidity rule.
- Run the full verification suite:
  - `node scripts/check-isolation.mjs`
  - `node scripts/architecture-check.mjs`
  - `node scripts/verify-isolated.mjs`
  - `pnpm dashboard:build`
  - `npx prettier --write ...`
````
