# NeXusTrade Master Roadmap: Phase 12.9+

**Production Calibration, 168-Hour Chrono-Regime Stress Testing, and Mainnet Hot Wallet Orchestration**

_Last updated: 2026-10-01_  
_Predecessor Roadmap: [ROADMAP_Phase9_to_12.88.md](./ROADMAP_Phase9_to_12.88.md)_

---

## 1. Executive Context & Proven Baseline

As of October 1, 2026, the TopG automated Solana paper trading engine has completed its core algorithmic hardening through Sub-Phase 12.88.

Across continuous multi-session testing with the simulated continuous virtual wallet, the system has achieved:

- **Continuous Virtual Wallet Balance**: **`11.25+ SOL` (+12.5% to +13.5% all-time net profit)** grown from the `10.00 SOL` baseline.
- **Zero Capital Breaches**: 5 continuous completed/active sessions with zero drawdowns below starting capital.
- **High-Conviction Runner Extraction**:
  - `SACC` (+84.00% runner, +47.54% realized return)
  - `BANDIT #2` (+72.06% runner, scaled out T1, T2, and trailing moonbag)
  - `BANDIT #1` (+41.04% runner)
  - `SI` (+11.71% runner)
- **Verified Defense**: Zero losses to rugs or cabal honeypots across >200 monitored candidates. Automatically screened out 20+ catastrophic scams (-99% to -100% dumps including `SK`, `s/acc`, `snowball`, `PUMP`, `RAY`).
- **Retest Pullback Gate & Dynamic Ratchet**: Verified flow absorption entries on pullbacks (5%–12%) with multi-tier locks (Tier 1 at +20%, Tier 2 at +48.5%, Trailing Moonbag).

---

## 2. Master Phased Sequence: Phase 12.88 through Phase 14

```
Phase 12.88 (ACTIVE) ───► Phase 12.89 ───► Phase 12.90 (168h Test) ───► Phase 12.9X ───► Phase 12.9Z ───► PHASE 13 (HOT WALLET)
First 12-Hour Run         Compounding       7-Day 24/7 Endurance         Calibration      Final Sign-Off      Real SOL on Mainnet
(SACC +84%, 11.25+ SOL)   Sizing Unlock     & Chrono-Regime Heatmap      Buffer           & Handoff           via Jito MEV Bundles
```

---

## Phase 12.88: Candidate Established Pre-Screening Unblock & Cross-Regime Run (Active)

- **Status**: Currently Executing Live 12-Hour Benchmark (Session `session-paper-12.88-01`).
- **Key Achievements**:
  - Decoupled preliminary in-memory gate evaluation from Stage 2 RugCheck verification, unblocking Established Runners (`SII`, `SACC`) while maintaining strict fail-closed protection against dev traps (`SIC`) and cabals (`s/acc`).
  - Implemented counterfactual opportunity tracking for expired/dropped candidates.
  - Added daemon idle heartbeat telemetry ensuring full 12-hour session duration accounting.
  - Verified live trades: `SACC` (+84.00%), `PUMPE` (+1.05%), `BSI` (+1.48%), `MEME` (+0.86%), `AMD` (-2.95% cut). Net session profit `+0.4722 SOL`.

---

## Phase 12.89: Established Compounding Sizing Unlock & 12-Hour Verification Run

- **Goal**: Unlock dynamic upward compounding sizing for Established Runners and verify in a dedicated 12-hour calibration session.
- **Scope & Deliverables**:
  1. **Established Sizing Ceiling Decoupling**:
     - In `paper-trading-daemon.ts`, remove the internal clamp that pins Established buys to `1.00 SOL`.
     - Allow `targetCohortSize` to scale dynamically with the wallet multiplier:
       $$\text{walletScale} = \min(1.25, \max(1.0, \text{currentCash} / 10.0))$$
       $$\text{establishedBaseSize} = \min(1.25, \text{round}(1.0 \times \text{walletScale}))$$
     - At $11.35\text{ SOL}$, Established entries will scale cleanly to **`1.13 SOL`** (up to **`1.25 SOL`**), compounding runner returns.
     - Retain defensive downsizing to `0.50 SOL` for elevated bundler/concentration risk.
  2. **12-Hour Verification Session**:
     - Execute a clean 12-hour run (`session-paper-12.89-01`).
     - Verify that Established buys execute at scaled sizes ($1.13 - 1.25\text{ SOL}$) and that Micro probes execute at scaled probe sizes ($0.28 - 0.35\text{ SOL}$).
  3. **Compounding Yield Audit**:
     - Measure net compounding uplift vs baseline flat sizing.

---

## Phase 12.90: The 168-Hour (7-Day 24/7) Endurance & Chrono-Regime Stress Test

- **Goal**: Execute a continuous 168-hour (7-day 24/7) paper trading test to profile the entire weekly market cycle, stress-test engine stability over 300,000+ ticks, and map market microstructure by hour and day.
- **Scope & Deliverables**:
  1. **168-Hour Continuous Daemon Orchestration**:
     - Launch `session-paper-12.90-endurance` with `--duration 168`.
     - Continuous in-memory execution with periodic state persistence and hourly telemetry heartbeats.
  2. **Chrono-Regime Microstructure Heatmap Profiling**:
     - Aggregate candidate observations, volume, spread, and win-rates across 24 hourly buckets and 7 daily buckets.
     - **Golden Hours Identification**: Pinpoint high-liquidity retail surge hours with maximal win-rate velocity (e.g. 10:00 AM – 2:00 PM PDT).
     - **Defensive / Trap Hours Identification**: Pinpoint illiquid graveyard hours dominated by sniper bots and cabal traps (e.g. 1:00 AM – 5:00 AM PDT).
     - **Day-of-Week Profiling**: Compare mid-week momentum (Tuesday–Thursday) against weekend volume contractions (Saturday–Sunday).
  3. **Long-Duration Infrastructure Stress Audit**:
     - Verify zero memory leaks across 7 continuous days (>300,000 ticks).
     - Verify API rate-limit resilience against DexScreener, Birdeye, and RugCheck over long time horizons.
     - Confirm candidate garbage collection keeps memory usage under 250MB.

---

## Phase 12.9X: Chrono-Regime Calibration Buffer

- **Goal**: Address any edge cases or micro-nuances uncovered during the 168-hour endurance test.
- **Potential Areas of Refinement**:
  - **Time-of-Day Adaptive Risk Filter**: Automatically tightening entry gates or requiring higher buyer dominance ratios during low-liquidity overnight regimes.
  - **Weekend Volatility Adjustments**: Calibrating pullback discount ratios for thinner weekend order books.
  - **Dynamic Ratchet Trailing Buffer Calibration**: Fine-tuning moonbag trailing buffers based on 7-day volatility data.

---

## Phase 12.9Z: Phase 12 Capstone Certification & Handoff

- **Goal**: Formal sign-off on Phase 12 Paper Trading System and executive approval to transition to live on-chain capital.
- **Exit Criteria**:
  - [ ] $\ge 5$ completed sessions with cumulative positive PnL ($\ge +15\%$ all-time return).
  - [ ] Zero catastrophic rug trap entries across all tested sessions.
  - [ ] Win rate on Established Runners $\ge 70\%$.
  - [ ] 168-hour endurance run completed with 0 unhandled fatal crashes or memory leaks.
  - [ ] Comprehensive Phase 12 Completion Memo published.

---

## Phase 13: Live Execution Engine & Hot Wallet Orchestration (Real SOL on Mainnet)

- **Goal**: Transition from simulated paper trading to autonomous live on-chain execution on Solana Mainnet using real SOL and private Jito MEV bundles.
- **Module Breakdown**:
  - **13.1: Encrypted Keypair & Hot Wallet Manager**:
    - Encrypted local keypair storage with environment-gated decryption.
    - Hard daily SOL loss circuit breaker (e.g. auto-halt if net loss exceeds $1.0\text{ SOL}$ in 24 hours).
    - Mandatory Gas Reserve enforcement (minimum $0.10\text{ SOL}$ reserved for transaction fees).
  - **13.2: Jito MEV Private Bundle Integration**:
    - Direct integration with Jito Block Engine endpoints.
    - Build private atomic bundles (Buy transaction + Jito tip transaction).
    - Eliminates public mempool exposure: **100% immune to sandwich attacks and front-running bots**.
    - Dynamic tip pricing based on network congestion.
  - **13.3: On-Chain Swap Execution Router**:
    - Dual-routing architecture:
      - **Jupiter V6 Swap API** for established multi-pool routing and optimal slippage.
      - **Direct Raydium AMM / pump.fun Bonding Curve** execution for instant low-latency entries.
    - Exact slippage bounding (max 1.5% on Established, max 2.5% on Micro probes).
  - **13.4: Automated SPL Token Account (ATA) Rent Reclamation**:
    - Automatic `closeAccount` instruction appended to the final moonbag sell transaction.
    - Recovers the $\sim 0.00204\text{ SOL}$ rent-exempt deposit on every exited token directly back into wallet cash.
  - **13.5: Emergency Manual Panic Button**:
    - Instant one-click liquidation CLI and Dashboard control to market-sell all open positions into SOL via Jito bundles immediately.

---

## Phase 14: Autonomous Cloud/VPS Fleet & Distributed Monitoring

- **Goal**: Containerized 24/7 cloud deployment with remote monitoring and mobile notifications.
- **Scope**:
  - Headless Docker containerization for Linux VPS (Ubuntu / Debian).
  - Telegram / Discord real-time execution bot:
    - Alerts on new entries, partial Tier 1/Tier 2 locks, moonbag trailing updates, and daily PnL summaries.
  - Remote Web Dashboard over secure reverse proxy (Cloudflare Zero Trust / Caddy with HTTPS).
