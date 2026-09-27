# Sub-Phase 12.6: Executive Daily Performance Ledger & Anti-Bundler Discovery Expansion

**Date**: 2026-09-27  
**Status**: APPROVED FOR DEV IMPLEMENTATION  
**Session Analyzed**: `session-paper-12.5-01` (4-Hour Live Saturday Night Session: **9.9740 SOL / -0.26%**, 7 trades, 0 missed winners, 9 rugs deflected)

---

## 1. 4-Hour Live Test Audit & Forensic Findings

### 1.1 Financial Progression

- **Starting Portfolio**: `10.0000 SOL`
- **Final Portfolio Equity**: `9.9740 SOL` (**-0.0260 SOL / -0.26%**)
- **Candidates Observed**: 54
- **Executed Trades**: 7
- **Missed Winners (>= +15%)**: 0 (all market runners captured)
- **Deflected Catastrophic Rugs**: 9 (tokens like `2Z`, `jellyjelly`, `PUMP` crashed -99% to -100%)

### 1.2 Winning Mechanics Proven in Live Market

- **Tier 1 Take-Profit at +15% with Breakeven Lock**:
  - `STOX` (`hxy2...`) hit the new +15% milestone, banked 50% profit into hard cash, locked the trailing stop to breakeven, and closed at **+10.43% net green (+0.1043 SOL)**. Under old rules (+24%), this would have round-tripped into a loss.
- **Massive Runner Captured**:
  - `WOW` (`GmBg...`) surged, executed Tier 1 and Tier 2 ratchets, and closed at **+54.90% (+0.5490 SOL)**.

### 1.3 The Forensic Discovery: The Jito Bundler Trap

A forensic audit of the 5 losing charts (`ROULETTE`, `Dougherty`, `Luna`, `jizz`, `MarioNawfal`) revealed an identical smoking gun:

1. `ROULETTE` (`Cqes...pump`): **93.25% Bundled supply!** Pumped for 3 candles, then a single red candle crashed -90%+ down to $839 liquidity (dead token).
2. `Dougherty` (`6UTg...pump`): **88.59% Bundled supply!** Parabolic spike followed by straight waterfall dump.
3. `Luna` (`5Az9...pump`): **80.67% Bundled supply!** 1-candle "God Candle" pump and dump.
4. `jizz` (`7nG5...pzU1`): **67.69% Bundled supply!** Choppy distribution into sustained bleed-out.
5. `MarioNawfal` (`6p92...w47e`): **38.79% Bundled supply!** Spiked and crashed -90% to $0.00001.

**Key Finding**: In every single losing trade, deployers bundled 38% to 93% of the supply across burner wallets in slot 0 to fake organic volume.  
**Critical Defense**: Our stop-loss engine (`CATASTROPHIC_HARD_STOP` and `DRAWDOWN_GRACE_EXPIRED`) intercepted all 5 trades between -1% and -19%, saving our wallet from -90% wipeouts.  
**Strategic Imperative**: Filtering out high-bundler and top-holder concentrated tokens before buying will permanently eliminate these traps from entering the portfolio.

---

## 2. Technical Deliverables for Dev Agent

### Deliverable 1: Anti-Bundler & Top-Holder Concentration Gate

- **Target File**: `backend/src/candidate-scanner/BuyGateTriggerService.ts`
- **Config additions** to `BuyGateConfig` & `BUY_GATE_DEFAULTS`:
  - `maxBundlerPct: number = 0.35` (reject if bundler / insider holdings > 35%)
  - `maxTop10HolderPct: number = 0.30` (reject if top 10 non-pool holders hold > 30%)
  - `minHoldersCount: number = 350` (reject micro-caps with < 350 unique holders)
- **Integration**:
  - In `evaluateCandidate`, add `BUNDLER_CONCENTRATION_GATE`:
    - Check token holder concentration and bundler ratio via RugCheck summary endpoint:
      `https://api.rugcheck.xyz/v1/tokens/${item.mintAddress}/report/summary`
    - When RugCheck is unavailable or returns non-200, perform an on-chain fallback check or evaluate `marketContext.bundlerPct` / `marketContext.top10HolderPct` if supplied.
    - If `bundlerPct > maxBundlerPct` OR `top10HolderPct > maxTop10HolderPct` OR `holdersCount < minHoldersCount`, reject with `BUNDLER_CONCENTRATION_GATE_FAILED`.
- **Tests**: Update `BuyGateTriggerService.test.ts`.

---

### Deliverable 2: Multi-Stream Discovery Expansion (Raydium 24H Top Traded & DexScreener Recent Updates)

- **Target File**: `backend/src/candidate-scanner/CandidateStreamEngine.ts`
- **Add Stream 4: Raydium Top 24H Traded Pools**:
  - Implement `fetchRaydiumTopTradedPools(pageSize = 50)`:
    - Queries `https://api-v3.raydium.io/pools/info/list?poolType=all&poolSortField=volume24h&sortType=desc&pageSize=50&page=1`
    - Parses high-volume, deep-liquidity pools, mapping them to `ScannedPoolRecord`.
- **Add Stream 5: DexScreener Recent Updates**:
  - Implement `fetchDexScreenerRecentUpdates()`:
    - Queries `https://api.dexscreener.com/token-profiles/recent-updates/v1`
    - Extracts active Solana tokens with updated profiles.
- **Config updates**:
  - In `CandidateScannerRuntimeConfig`, add:
    - `enableRaydiumTopTraded?: boolean` (default: true)
    - `enableDexScreenerRecentUpdates?: boolean` (default: true)
- **Tests**: Add unit test coverage in `CandidateStreamEngine.test.ts`.

---

### Deliverable 3: Persistent Session Archiver

- **Target Files**:
  - `backend/src/paper/PaperTradingDaemon.ts`
  - `backend/src/scripts/paper-trading-daemon.ts`
- **Archiving Logic**:
  - Create directory `.tmp/sessions/` if it does not exist.
  - When a session completes (or on `stop()` / `handleShutdown`), format the full session summary into `HistoricalSessionSummary` and:
    1. Write `.tmp/sessions/${sessionId}.json`.
    2. Read `.tmp/past-sessions.json` (or initialize as an empty array if missing), append/update the session record, and save.
  - **Backfill**: If `.tmp/past-sessions.json` does not exist, initialize it with retrospective records for:
    - `session-paper-12.3-01`: 2026-09-25, 4h, 8 trades, Net PnL -0.4200 SOL (-4.20%), Start 10.00 -> End 9.58 SOL.
    - `session-paper-12.4-01`: 2026-09-26, 4h, 12 trades, Net PnL +0.7080 SOL (+7.08%), Start 10.00 -> End 10.708 SOL, 73 watched, 0 missed.
    - `session-paper-12.5-01`: 2026-09-26, 4h, 7 trades, Net PnL -0.0260 SOL (-0.26%), Start 10.00 -> End 9.974 SOL, 54 watched, 0 missed.

---

### Deliverable 4: Shared Schemas & Types Update

- **Target File**: `shared/src/phase12-dashboard-schemas.ts`
- Update `historicalSessionSummarySchema`:
  ```ts
  export const historicalSessionSummarySchema = z.object({
    sessionId: z.string(),
    startedAt: z.string(),
    endedAt: z.string(),
    durationMinutes: z.number(),
    startingCapitalSol: z.number(),
    endingCapitalSol: z.number(),
    netPnlSol: z.number(),
    netPnlPct: z.number(),
    totalTrades: z.number(),
    buysCount: z.number().default(0),
    sellsCount: z.number().default(0),
    winsCount: z.number(),
    lossesCount: z.number(),
    scratchesCount: z.number(),
    winRatePct: z.number(),
    coinsWatchedCount: z.number().default(0),
    missedOpportunitiesCount: z.number().default(0),
    trades: z.array(historicalTradeSchema).default([]),
  });
  ```

---

### Deliverable 5: Vite Dev API Bridge (`/api/session/history`)

- **Target File**: `frontend/vite.config.ts`
- Add route handler for `GET /api/session/history`:
  - Reads `.tmp/past-sessions.json` (or `.tmp/sessions/*.json`).
  - If `.tmp/past-sessions.json` does not exist, return the backfilled sessions array.
  - Return HTTP 200 with JSON array of `HistoricalSessionSummary`.
- **Target File**: `frontend/src/hooks/useLiveSessionState.ts`:
  - Fetch `/api/session/history` in `useEffect` on mount.
  - Update `historySessions` state when data arrives.

---

### Deliverable 6: Frontend "Past Sessions" Executive Daily Ledger

- **Target File**: `frontend/src/views/HistoryView.tsx`
- **Layout Specification**:
  1. **Date-Grouped Accordion / Sections**:
     - Group sessions by calendar date using `Intl.DateTimeFormat` or local date string (e.g. `September 26, 2026`).
     - **Date Section Summary Bar**:
       - Date Label: e.g. `📅 September 26, 2026`
       - Sessions Ran: e.g. `2 Sessions Ran`
       - Cumulative Day P/L: e.g. `+0.7080 SOL (+7.08%)` (color-coded green/red)
       - Day Capital Delta: Starting SOL of first session $\rightarrow$ Ending SOL of last session (e.g. `10.0000 → 10.7080 SOL (+0.7080 SOL)`).
  2. **Session Rows (Within Each Date Section)**:
     - Render a clean table with the following exact columns:
       - **Time Window**: Start $\rightarrow$ End time (e.g. `14:30 - 18:30 EDT`)
       - **Duration**: (e.g. `4h 00m`)
       - **Buys / Sells**: e.g. `12 / 12`
       - **Coins Watched**: `coinsWatchedCount` (e.g. `54 candidates`)
       - **Missed Opportunities**: `missedOpportunitiesCount` (e.g. `0 missed`)
       - **Session P/L**: e.g. `+0.7080 SOL (+7.08%)`
       - **Capital Delta**: Starting SOL $\rightarrow$ Ending SOL (e.g. `10.0000 → 10.7080 SOL`)
     - **Zero Individual Coin Clutter**: Individual token transaction logs are removed from the default view to keep the ledger compact, readable, and executive-level.
- **Tests**: Update `frontend/src/views/HistoryView.test.tsx` to verify grouping by date and correct aggregation.

---

## 3. Verification & Acceptance Criteria

1. `node scripts/verify-isolated.mjs` must execute with 0 failures across all backend tests.
2. `pnpm --filter @nexustrade/research-dashboard test` must pass all tests.
3. `pnpm dashboard:build` must compile with 0 type errors.
4. Launching `pnpm dev:frontend` and navigating to the "Past Sessions" tab must render the date-grouped ledger with backfilled sessions.
