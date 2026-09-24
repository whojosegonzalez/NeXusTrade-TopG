# NeXusTrade Phase 2 Detailed Checklist

Phase 2 builds the local database layer for NeXusTrade using SQLite, Drizzle ORM, and `better-sqlite3`. It is focused on persistence only.

## Definition of Done

- [x] Drizzle ORM is installed and configured in the backend.
- [x] `better-sqlite3` is installed and configured in the backend.
- [x] SQLite database files are stored under `data/` and ignored by Git.
- [x] Database paths are selected by execution mode.
- [x] `PAPER` mode writes to `data/nexus_paper.db`.
- [x] `LIVE` mode is reserved for `data/nexus_live.db` and remains guarded.
- [x] `BACKTEST` mode is reserved for `data/nexus_backtest.db` and remains guarded.
- [x] WAL mode, foreign keys, busy timeout, and `synchronous=NORMAL` are configured.
- [x] Initial database schema is created.
- [x] Drizzle migration tooling is configured.
- [x] A migration creates all Phase 2 tables from an empty paper database.
- [x] Repository classes exist so business logic does not depend directly on raw ORM calls everywhere.
- [x] Repository implementations can create, read, update, and list core records.
- [x] A database seed/smoke path creates a realistic fake paper session.
- [x] Tests verify schema creation, repository behavior, mode-specific DB selection, PRAGMAs, JSON helpers, timestamp helpers, and money helpers.
- [x] `docs/Structure.md` is updated for Phase 2 files.
- [x] The repo remains runnable and tested.

## Verification Notes

- 2026-06-21: `pnpm typecheck` passed.
- 2026-06-21: `pnpm test` passed.
- 2026-06-21: `pnpm db:generate` generated the initial migration.
- 2026-06-21: `pnpm db:migrate:paper` created/updated `data/nexus_paper.db`.
- 2026-06-21: `pnpm db:smoke:paper` inserted and read back a realistic paper scenario.
- 2026-06-21: `pnpm dev:backend` opened the migrated paper database and wrote a startup system log.
- Local caveat: verification currently runs on Node.js `v22.20.0`, while the repository target is Node.js 24 LTS. pnpm emits engine warnings, but checks pass.

## Out of Scope

- Real Solana provider adapters.
- Jupiter quote calls.
- DexScreener calls.
- Helius calls.
- Token scanner loop.
- Risk engine scoring logic.
- Strategy engine logic.
- Paper buy/sell execution.
- P/L target enforcement.
- GUI dashboard.
- Wallet loading.
- Live trade signing or submission.
