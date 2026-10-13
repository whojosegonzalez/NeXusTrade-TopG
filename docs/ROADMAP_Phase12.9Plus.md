# NeXusTrade Master Roadmap: Phase 12.9+

**Production Calibration, 168-Hour Chrono-Regime Stress Testing, and Mainnet Hot Wallet Orchestration**

_Last updated: 2026-10-12 (2026-10-13 UTC)_
_Predecessor Roadmap: [ROADMAP_Phase9_to_12.88.md](./ROADMAP_Phase9_to_12.88.md)_

---

## 1. Executive Context & Proven Baseline

As of October 12, 2026, the TopG automated Solana paper trading engine has completed its core algorithmic hardening through **Phase 12.93 (Turbo-Defense & Execution Hardening)**.

Across continuous multi-session testing with the simulated continuous virtual wallet, the system has achieved:

- **Verified Defense**: Zero losses to rugs or cabal honeypots across >370 monitored candidates. Automatically screened out 160+ catastrophic scams (-99% to -100% dumps including `NEAR`, `USELESS`, `GABOX`, `russIA`, `MarsX`, `KnightDog`).
- **High-Conviction Runner Extraction**:
  - `SACC` (+84.00% runner, +47.54% realized return)
  - `BANDIT #2` (+72.06% runner, scaled out T1, T2, and trailing moonbag)
  - `BANDIT #1` (+41.04% runner)
  - `CASINU` (+22.8% runner, +0.1141 SOL)
  - `AGENTCAT` (+22.0% runner, +0.1100 SOL)
  - `DOGGO` (+20.0% runner, +0.0987 SOL)
  - `Americaexe` (+20.0% runner, +0.0856 SOL)
- **Active Parallel 168-Hour Validation**:
  - **Fedora Laptop Control Node**: Continuous 24/7 endurance runner (`session-paper-fedora-phase1293`) initialized at 10.0000 SOL clean baseline inside `tmux`.
  - **Windows Desktop Production Node**: Chrono-regime scheduled trader (`07:00-18:00:PDT`) running on the Continuous Virtual Wallet (`8.4548 SOL` baseline).

---

## 2. Master Phased Sequence: Phase 12.88 through Phase 14

```
Phase 12.88 ──► Phase 12.89 ──► Phase 12.90-12.92 ──► Phase 12.93 (PROD) ──► Phase 12.9Z ──► PHASE 13 (HOT WALLET)
Decouple        Compounding     7-Day Scheduler &     Turbo-Defense          Final Sign-Off   Real SOL on Mainnet
Established     Sizing Unlock   Observation Analytics Moonbag & Fast Poll    & Handoff        via Jito MEV Bundles
[COMPLETED]     [COMPLETED]     [COMPLETED]           [ACTIVE IN RUNS]       [PENDING 7D]     [NEXT STAGE]
```

---

## Phase 12.88: Candidate Established Pre-Screening Unblock (Completed)

- **Status**: Completed & Verified.
- **Key Achievements**:
  - Decoupled preliminary in-memory gate evaluation from Stage 2 RugCheck verification, unblocking Established Runners (`SII`, `SACC`) while maintaining strict fail-closed protection against dev traps (`SIC`) and cabals (`s/acc`).
  - Implemented counterfactual opportunity tracking for expired/dropped candidates.
  - Added daemon idle heartbeat telemetry ensuring full session duration accounting.

---

## Phase 12.89: Established Compounding Sizing Unlock (Completed)

- **Status**: Completed & Verified.
- **Key Achievements**:
  - Removed internal clamp that pinned Established buys to `1.00 SOL`, allowing dynamic scaling with `walletScale` up to `1.25 SOL`.
  - Enforced `requireVerifiedHolders: true` across both Micro-Caps and Established candidates to eliminate unverified bot farms.
  - Added hardcoded symbol blacklist (`TEST`, `TESTCOIN`, `PUMP`, etc.) failing immediately with `REJECTED_BLACKLISTED_SYMBOL`.
  - Normalized initial price intake and outlier guards in `CounterfactualOpportunityTracker.ts`.

---

## Phase 12.90: Chrono-Regime 7-Day Scheduler & Continuous Virtual Wallet (Completed)

- **Status**: Completed & Operational.
- **Key Achievements**:
  - Implemented CLI `--schedule "HH:mm-HH:mm[:TZ]"` (e.g., `--schedule "07:00-18:00:PDT"`) with automatic startup, wall/active clock accounting, and end-of-window graceful cashout (`SCHEDULE_WINDOW_CONCLUDED`).
  - Built persistent Continuous Virtual Wallet (`.tmp/virtual-wallet.json`) tracking real-world multi-day balance compounding, all-time PnL, and session history across process restarts.
  - Added `--wallet-reset` flag for resetting wallet to fresh 10.0000 SOL baseline.

---

## Phase 12.91 & 12.92: Observational Strategy Analytics & Multi-Day Benchmarking (Completed)

- **Status**: Completed & Operational.
- **Key Achievements**:
  - Created `paper-observation-analytics.ts` (`pnpm daemon:analytics`) profiling all observed candidates across 4-hour, multi-day, or multi-week spans.
  - Forensic tracking of executed paper buys, pre-screen filtered candidates, missed winners ($\ge +15\%$), and avoided rugs ($\le -30\%$) with filter attribution.
  - Completed Day 1, Day 2, and Day 3 scheduled benchmarks on PC, and 61.8-hour continuous run on Fedora laptop (`session-paper-fedora-7d`).

---

## Phase 12.93: Turbo-Defense & Execution Hardening (Active in Production)

- **Status**: Fully Implemented, Backtested (+81.5% Historical Uplift), 100% Tests Passing, Deployed to Fedora Laptop & PC.
- **Key Achievements**:
  1. **Moonbag Capital-Preservation Guarantee**: Exits post-Tier-1 tranches immediately at $-2.0\%$ (`MOONBAG_PROTECTION_EXIT`), eliminating catastrophic cliff losses on remaining moonbag balances and guaranteeing net green trades.
  2. **Scaled-In Breakeven Blended Shield**: Pyramided trades instantly arm breakeven on blended cost basis, exiting at $0.0\%$ (`SCALED_BREAKEVEN_EXIT`) if momentum fades.
  3. **Universal Strict Pre-Breakeven Cut**: Exits any unconfirmed position dropping $\le -12.0\%$ (`UNCONFIRMED_PRE_BREAKEVEN_CUT`) regardless of peak gain, cutting illiquid bleeders early.
  4. **1500ms Parallel High-Frequency Poller**: Decoupled open position monitoring (1500ms ticker via `Promise.all`) from discovery scanning (5000ms), eliminating tick lag.
  5. **Calibrated Probe Sizing**: Base probe $0.50\text{ SOL}$ for Established and $0.35\text{ SOL}$ for Micro-Caps.

---

## Phase 12.9Z: Phase 12 Capstone Certification & Handoff

- **Goal**: Formal sign-off on Phase 12 Paper Trading System and executive approval to transition to live on-chain capital.
- **Exit Criteria**:
  - [x] $\ge 5$ completed sessions with verified multi-day persistence.
  - [x] Zero catastrophic rug trap entries across all tested sessions.
  - [x] Dynamic ratchet and Moonbag Capital Preservation verified in production.
  - [ ] Complete 168-hour endurance run on Fedora laptop (`session-paper-fedora-phase1293`).
  - [ ] Complete 7 scheduled day sessions on PC (`session-paper-12.93-day4` through Day 7).
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
