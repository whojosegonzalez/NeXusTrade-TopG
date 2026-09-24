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

## Repo Layout

- `backend`: TypeScript backend service foundation.
- `shared`: Shared types and execution-mode helpers.
- `frontend`: Placeholder for the future dashboard.
- `docs`: Roadmap, decisions, checklist, and structure documentation.
- `scripts`: Local safety and automation scripts.
- `data`: Local data directory; database files are ignored.

See [docs/Structure.md](./docs/Structure.md) for the full file inventory.
