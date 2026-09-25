# NeXusTrade-Otis

NeXusTrade is a local-first Solana meme-coin trading research and automation project.

The first milestone is live-data paper trading: real token, quote, liquidity, and metadata inputs with simulated buys and sells, complete records, and no transaction signing. Live trading is disabled during early development.

Nothing in this repository is financial advice. Treat all future live-trading work as experimental and high risk.

## Quick Start

Requirements:

- Node.js 24 LTS
- pnpm

```bash
pnpm install
pnpm verify
pnpm dev:backend
```

The backend defaults to `PAPER` mode. `LIVE` mode refuses to start during early development.

## Local Database

Phase 2 adds a local SQLite persistence layer using Drizzle ORM and `better-sqlite3`.

Paper-mode database files live under `data/` and are ignored by Git:

- `data/nexus_paper.db`
- `data/nexus_paper.db-wal`
- `data/nexus_paper.db-shm`

Useful commands:

```bash
pnpm db:generate
pnpm db:migrate:paper
pnpm db:seed:paper
pnpm db:smoke:paper
pnpm db:reset:paper
```

`db:reset:paper` only targets the paper database. There is intentionally no live reset command. `LIVE` database access remains guarded and does not enable live trading.

## Provider Smoke Tests

Phase 3 adds read-only provider adapters for live market data. The provider smoke test is paper-only, does not load a wallet, and does not create orders, fills, or positions.

```bash
pnpm providers:smoke
pnpm providers:smoke --mint=So11111111111111111111111111111111111111112
pnpm providers:smoke --strict
```

DexScreener runs without a key. Jupiter and Helius are skipped unless `JUPITER_API_KEY` and `HELIUS_API_KEY` are set in local `.env`.

The backend loads the root `.env` file with Node 24's built-in environment-file support; no `dotenv` package is required.

## Scanner-Only Discovery

Phase 4 adds a paper-only scanner that discovers token candidates, deduplicates by mint address, enriches through `MarketDataService`, and upserts candidates into `TokenRadar`.

```bash
pnpm scanner:discover --once
pnpm scanner:discover --once --dry-run
pnpm scanner:discover --session-id=session_123
pnpm scanner:discover --interval-ms=60000 --limit=25 --concurrency=3
```

Without `--once`, `pnpm scanner:discover` runs continuously. The scanner creates or reuses `PAPER` sessions only, writes `SystemLog` and `ProviderHealth` records, and never loads wallets, signs transactions, submits transactions, or creates risk decisions, strategy decisions, orders, fills, or positions.

## Risk Evaluation

Phase 5 adds a paper-only deterministic risk engine that evaluates existing scanner candidates, refreshes evidence, probes quotes, writes `RiskAssessment` records, and updates TokenRadar only within risk-safe bounds.

```bash
pnpm risk:evaluate --once
pnpm risk:evaluate --once --dry-run
pnpm risk:evaluate --session-id=session_123
pnpm risk:evaluate --status=DISCOVERED,WATCHING --since-hours=24 --limit=50 --concurrency=3
```

When no session ID is supplied, risk evaluation uses the latest `PAPER` + `RUNNING` session with eligible TokenRadar candidates. It never auto-creates sessions and never creates strategy decisions, orders, fills, positions, wallet activity, signing, or transaction submission.

## Strategy Evaluation

Phase 6 adds a paper-only rule-based strategy engine that evaluates `WATCHING` TokenRadar candidates with latest risk assessments, writes `StrategyDecision` records, and updates TokenRadar to `APPROVED` only after stored `BUY` decisions.

```bash
pnpm strategy:evaluate --once
pnpm strategy:evaluate --once --dry-run
pnpm strategy:evaluate --session-id=session_123
pnpm strategy:evaluate --status=WATCHING --since-hours=24 --limit=50 --max-buy-decisions=5
```

Strategy evaluation uses `PASS_OR_ELIGIBLE_WARN` risk eligibility, prevents duplicate `BUY` decisions per session and mint at the application layer, and never creates orders, fills, positions, wallet activity, signing, or transaction submission.

## Paper Execution

Phase 7 adds a paper-only BUY execution engine that consumes `StrategyDecision(BUY)` plus matching `TokenRadar(APPROVED)` rows, creates simulated orders, fills, and open positions, decrements paper cash, and marks TokenRadar as `BOUGHT`.

```bash
pnpm paper:execute --once
pnpm paper:execute --once --dry-run
pnpm paper:execute --session-id=session_123
pnpm paper:execute --buy-sol=0.01 --limit=10
```

Paper execution requires a `PAPER` + `RUNNING` session and never auto-creates sessions. It prevents duplicate open positions per session and mint, rejects missing prices or insufficient cash with `Order(REJECTED)`, and still never loads wallets, signs transactions, submits transactions, or performs live swaps.

## Paper Sell Execution

Phase 7.5 adds paper-only SELL execution for closing open positions, restoring paper cash, and storing realized P/L.

```bash
pnpm paper:sell --once --sell-all
pnpm paper:sell --once --mint=<mint>
pnpm paper:sell --once --sell-all --dry-run
```

Plain `pnpm paper:sell --once` fails by design because SELL runs require an explicit trigger. The SELL engine uses fresh quote/price evidence when available, can use cached TokenRadar price only when explicitly enabled, and never loads wallets, signs transactions, submits transactions, completes sessions, or creates snapshots.

## Session Management

Phase 8 adds a paper-only SessionManager for equity snapshots, position snapshots, unrealized P/L,
target/drawdown tracking, and BUY gating.

```bash
pnpm session:manage --once --dry-run
pnpm session:manage --once
pnpm session:manage --once --session-id=session_123
pnpm session:manage --once --target-sol=0.25 --max-drawdown-pct=3
```

SessionManager keeps gated sessions `RUNNING`, sets `Session.terminationReason` when target or
drawdown rules are reached, blocks future paper BUYs, and leaves manual `paper:sell` available. It
does not auto-sell, close positions, complete sessions, load wallets, sign transactions, or submit
transactions.

## Automated Paper Exits

Phase 8.5 adds a paper-only ExitManager for session-level automated exits from SessionManager
signals.

```bash
pnpm exits:manage --once --dry-run
pnpm exits:manage --once
pnpm exits:manage --once --target-action=sell-all
pnpm exits:manage --once --drawdown-action=sell-all
pnpm exits:manage --once --target-action=sell-all --complete-session-on-exit=true
```

Observe-only is the default. Automated liquidation requires a matching explicit `sell-all` action
for `TARGET_REACHED` or `MAX_DRAWDOWN`. ExitManager reuses the PaperSell service layer, can
optionally complete a fully closed gated session, and never loads wallets, signs transactions,
submits transactions, performs partial exits, or evaluates stop-loss/trailing/max-hold rules.

## Analytics And Forward Returns

Phase 8.7 adds paper-only research instrumentation for strategy calibration and missed-opportunity
analysis.

```bash
pnpm strategy:evaluate --once --buy-score-threshold=75
pnpm watchlist:returns --once
pnpm analytics:report --once
```

The default strategy BUY threshold remains `90`; `75` is an explicit paper calibration setting.
Watchlist returns persist forward-return observations for 3-minute through 12-hour horizons, and
analytics reports summarize funnels, score buckets, near misses, missed opportunities, provider
health, and Jupiter rate limiting. These commands do not load wallets, sign transactions, submit
transactions, or create live trades.

## Phase 11: Dynamic Ratchet Exit Engine & Live Scanner

Phase 11 introduces real-time pool discovery across Raydium AMM pools and an asymmetric dynamic ratchet stop-loss engine:

- Anti-rug safety screening (LP burn verification, freeze/mint authority renunciation, liquidity depth).
- Multi-tier ratchet state machine: `-12.0%` initial soft floor, `+0.5%` scratch break-even arming, `-8.0%` dip recovery grace hold, `+20.0%` Tier 1 floor lock, and `+45.0%` Tier 2 trailing floor.

## Phase 12: Interactive Trading Dashboard & Control Plane

Phase 12 adds a 3-page interactive visual control plane and quantitative two-stage strategy funnel:

### 1. Visual Control Plane (React + Vite)

- **Settings View**: Solana RPC wallet balance and SPL token holdings audit, Max Concurrent Positions slider (1–10), position sizing, gas reserve calculator, profit goal mode toggle (`% Gain Goal` vs `Final SOL Balance`), and strategy threshold tuners.
- **Active Session View**: Real-time telemetry banner (PnL, session timer), 5-stat metric counter grid (Open, Closed, W/L/Scratch), live position cards with ratchet tier badges & stop distance meter, manual exit controls, watchlist radar table, and session controls (`PAUSE`, `RESUME`, `START EXITING`, `EMERGENCY STOP`).
- **Past Sessions View**: Historical session ledger and cumulative equity curve progression chart with trade drill-down.

### 2. Strategy Radar & Buy Gate Funnel

- **Stage 1 (Watchlist Radar)**: Screener admitting baseline safe pairs (liquidity $\ge \$2,500$, LP burn $\ge 90\%$, txns $\ge 10$) and auto-evicting stagnant pairs ($> 20\text{m}$).
- **Stage 2 (Buy Gate Confirmation)**: Confirms 5 quantitative signals (maturity age 5m–15m, depth balance $0.15 \le \text{L/MC} \le 0.30$, flow absorption $\text{Buys} \ge 1.5 \times \text{Sells}$, volume surge $\ge \$2,500$, dev dump protection $\le 5\%$) before triggering simulated buys.

### Running the Dashboard & Daemon

```powershell
# Start the React Interactive Dashboard
pnpm dev:frontend

# Start the Paper Trading Daemon
pnpm daemon:paper --session-id=session_123 --max-positions=3 --position-size-sol=1.0
```

## Repo Layout

- `backend`: TypeScript backend service foundation.
- `shared`: Shared data contracts, schemas, and execution-mode helpers.
- `frontend`: Interactive 3-page React dashboard and control plane.
- `docs`: Roadmap, decisions, checklist, and structure documentation.
- `scripts`: Local safety and automation scripts.
- `data`: Local data directory; database files are ignored.

See [docs/Structure.md](./docs/Structure.md) for the full file inventory.
