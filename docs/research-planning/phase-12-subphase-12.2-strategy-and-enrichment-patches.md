# NeXusTrade Sub-Phase 12.2: Live Pair Enrichment, Ghost Token Elimination & Stagnancy Exits

**Status**: READY FOR IMPLEMENTATION  
**Author**: Antigravity Architecture & Reviewer  
**Assignee**: Dev Implementation Agent  
**Baseline Session**: `session-paper-20260925171501` (+1.51% net profit, +0.1506 SOL)  
**Target Completion**: 100% test pass rate across all suites, zero ghost tokens, verified 5m stagnancy exits.

---

## 1. Post-Mortem Findings from Session `session-paper-20260925171501`

During the 45-minute live test run of Sub-Phase 12.1, the trading engine achieved a positive net PnL (**+0.1506 SOL**, 3 wins at +8.34%, +9.96%, and +18.04%), but uncovered three critical pipeline defects:

1. **The Ghost Token Defect**:
   - In `CandidateStreamEngine.ts`, `/token-profiles/latest/v1` returns newly minted Solana token addresses without market metrics (no ticker symbol, no liquidity, no volume).
   - A hardcoded placeholder template was assigned (`symbol: "SOL-TOKEN"`, `liquidity: $18,000`, `marketCap: $75,000`, `volume5m: $4,500`, `buys/sells: 24/11`).
   - Tokens that had **no liquidity pool on Raydium/DEX** (e.g. `BhRCage...` and `2ksZNvi...`) triggered the Buy Gate using the fake stats. When `fetchDexScreenerSpotInfo` returned `null`, the daemon defaulted to `0.05 SOL` and purchased ghost tokens.
2. **Clogged Position Slots**:
   - Positions without active DEX pairs return `null` during price ticks and are skipped (`if (!spotInfo) continue;`).
   - Consequently, they never update price, never trigger a ratchet, and never hit a stop-loss. They permanently occupied 2 out of the 3 available slots.
3. **False Positive Admissions on Low-Activity Tokens**:
   - Real tokens like `Bk8k...pump` (CSGO on pump.fun) had only **$119 volume and 1 transaction**, but were admitted because the Buy Gate evaluated the placeholder template ($4,500 volume) instead of real live pair metrics.

---

## 2. Sub-Phase 12.2 Architectural Scope & Required Patches

### Patch 1: Live Pair Enrichment & Ghost Token Elimination

**Target Files**:

- `backend/src/candidate-scanner/CandidateStreamEngine.ts`
- `backend/src/scripts/paper-trading-daemon.ts`

**Requirements**:

1. **Strict Active Pair Verification**:
   - Before any candidate is admitted to the Watchlist Radar or executed as a buy, verify that an active trading pair exists on Solana.
   - If `fetchDexScreenerSpotInfo(mintAddress)` returns `null` or `pairs === null`, immediately reject with reason `REJECTED_NO_ACTIVE_DEX_PAIR`. Never fall back to fake default prices like `0.05 SOL`.
2. **Live Data Enrichment**:
   - Do not populate Watchlist candidates with static placeholder values.
   - Query DexScreener token endpoint (`/latest/dex/tokens/${mintAddress}`) to populate the candidate record with real data:
     - `symbol`: Real token symbol (e.g. `CSGO`, `DOGE`).
     - `liquidityUsd`: Actual pool liquidity.
     - `marketCapUsd`: Actual market cap / FDV.
     - `volume5mUsd`: Actual 5-minute volume.
     - `buys5m` / `sells5m`: Actual buy and sell counts.
     - `assetAgeSeconds`: Actual age derived from `pairCreatedAt` timestamp.
3. **Buy Gate Truth Enforcement**:
   - `BuyGateTriggerService.evaluateCandidate` must evaluate **only verified live metrics**. If `volume5mUsd < minVolume5mUsd` ($2,500), it must fail the Volume Surge Gate.

---

### Patch 2: Stagnancy & Activity Timeout Exit Engine

**Target Files**:

- `backend/src/paper/PaperTradingDaemon.ts`
- `backend/src/scripts/paper-trading-daemon.ts`

**Requirements**:

1. **Inactivity Tracking per Position**:
   - In `PaperPosition`, add tracking for:
     - `lastActivityMs: number` (updated whenever a transaction or price tick occurs).
     - `stagnantTicksCount: number` (incremented if price does not change or spot query returns null).
2. **5-Minute Stagnancy Timeout**:
   - If a position exhibits **no price change, zero transactions, or consecutive price query failures for 300,000ms (5 minutes)**:
     - Trigger an immediate exit with reason: `STAGNANCY_TIMEOUT_EXIT`.
     - Free up the position slot and return capital to deployable cash.
     - Record the exit in `closedTrades` and apply the 30-minute anti-rebuy cooldown.

---

### Patch 3: Scalable Concurrency & Dynamic Sizing

**Target Files**:

- `backend/src/paper/PaperTradingDaemon.ts`
- `backend/src/scripts/paper-trading-daemon.ts`

**Requirements**:

1. **Configurable Capacity (5 to 10 Slots)**:
   - Allow CLI argument `--max-positions=5` (default: 5, configurable up to 10).
2. **Capital Safety & Balanced Sizing**:
   - When `--max-positions=5` with `10.0 SOL` initial portfolio, ensure position sizing adheres to:
     $$\text{Position Size} = \min\left(1.0\text{ SOL}, \frac{\text{Initial Portfolio} - \text{Gas Reserve}}{\text{Max Positions}}\right)$$
   - Prevents cash depletion while maximizing observational throughput.

---

## 3. Verification & Acceptance Criteria

1. **Unit Tests**:
   - Update `CandidateStreamEngine.test.ts` to verify that `fetchDexScreenerPools` discards tokens without active pairs or enriches them with live pair data.
   - Update `PaperTradingDaemon.test.ts` to test that a position with no activity for 5 minutes triggers `STAGNANCY_TIMEOUT_EXIT`.
   - Update `BuyGateTriggerService.test.ts` to ensure low-volume tokens ($119 vol) are rejected.
2. **Static & Regression Testing**:
   - `node scripts/verify-isolated.mjs static` must pass cleanly (all 77 modules).
   - `node scripts/verify-isolated.mjs tests` must pass 100% across all test suites.
3. **Execution Verification**:
   - In a test run of `pnpm daemon:paper --max-positions=5`, all tokens on the dashboard radar must display real ticker symbols (not `SOL-TOKEN`), real variable liquidity, and genuine volume.
   - Zero positions entered with entry price `0.05 SOL`.
