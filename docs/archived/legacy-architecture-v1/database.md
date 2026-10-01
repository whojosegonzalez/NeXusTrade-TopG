# Database Architecture

NeXusTrade uses a local-first SQLite database layer for paper-trading research and future live-trading auditability. The backend owns the database implementation details, while future scanner, risk, strategy, execution, analytics, and dashboard modules should use repository methods instead of raw ORM calls.

## Mode-Specific Files

Database paths are selected by execution mode:

- `PAPER`: `data/nexus_paper.db`
- `LIVE`: `data/nexus_live.db`
- `BACKTEST`: `data/nexus_backtest.db`

The files are physically separated so paper runs, future live trading, and future backtests cannot accidentally share records. `LIVE` and `BACKTEST` database access remain guarded in Phase 2.

## SQLite Settings

Every opened connection enables:

- `PRAGMA foreign_keys = ON`
- `PRAGMA journal_mode = WAL`
- `PRAGMA busy_timeout = 5000`
- `PRAGMA synchronous = NORMAL`

WAL improves local read/write behavior. Foreign keys keep parent/child trading records coherent. The busy timeout reduces local write-lock failures.

## Storage Conventions

- Timestamps use integer Unix milliseconds with UTC semantics.
- SOL balances, fees, and P/L values use integer lamports.
- Token amounts and USD values use decimal strings.
- Raw provider evidence, quote snapshots, and contextual logs use JSON text.
- JSON helpers redact sensitive-looking fields before storage.

## Core Tables

The initial schema covers:

- `sessions`
- `token_radar`
- `risk_assessments`
- `strategy_decisions`
- `orders`
- `fills`
- `positions`
- `position_snapshots`
- `equity_snapshots`
- `system_logs`
- `provider_health`

These tables are intentionally broader than Phase 2 runtime behavior because later phases need a stable audit trail for scanning, risk checks, decisions, simulated fills, positions, equity, logs, and provider reliability.

## Repository Boundary

Repository classes live under `backend/src/db/repositories`. They provide create/read/update/list methods and hide raw Drizzle calls from higher-level business logic. This keeps later provider, scanner, strategy, paper exchange, analytics, and dashboard code from coupling directly to database query details.
