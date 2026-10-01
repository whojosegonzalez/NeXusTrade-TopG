# NeXusTrade Structure

This file documents every meaningful file created for the project foundation, including purpose, usage, important parameters, status, and test status.

Historical scope: this structure inventory is the primary record for Phases 1 through 8.93. Active
Phase 9+ file inventory continues in [Structure_Phase9Plus.md](./Structure_Phase9Plus.md).

## Root

#### .editorconfig

- Purpose: Standardizes indentation, line endings, final newlines, and whitespace behavior across editors.
- Usage: Read automatically by compatible editors.
- Important parameters: Uses UTF-8, LF line endings, two-space indentation, and final newlines.
- Status: Started.
- Tests: Covered indirectly by formatting checks.

#### .env.example

- Purpose: Shows safe local environment variables without real secrets.
- Usage: Copy values into a local `.env` when needed; do not commit real `.env` files.
- Important parameters: `NEXUSTRADE_MODE=PAPER`, `NODE_ENV=development`, future provider key placeholders.
- Status: Started.
- Tests: Covered by secret check allowlist for `.env.example`.

#### .gitignore

- Purpose: Keeps dependencies, build output, local databases, env files, logs, and key material out of git.
- Usage: Applied automatically by git.
- Important parameters: Allows `.env.example` while blocking `.env` variants.
- Status: Started.
- Tests: Covered by manual review and secret check.

#### .npmrc

- Purpose: Configures pnpm install behavior.
- Usage: Read by pnpm.
- Important parameters: Disables auto-installed peers, disables funding prompts, keeps engine checks non-blocking while Node 24 adoption settles locally.
- Status: Started.
- Tests: Pending install verification.

#### .node-version

- Purpose: Declares the Node.js runtime target for tools that read `.node-version`.
- Usage: Used by version managers.
- Important parameters: Node 24.
- Status: Started.
- Tests: Manual version check.

#### .nvmrc

- Purpose: Declares the Node.js runtime target for nvm-compatible tools.
- Usage: Run `nvm use` from the repo root.
- Important parameters: Node 24.
- Status: Started.
- Tests: Manual version check.

#### .prettierignore

- Purpose: Excludes generated or local-only files from Prettier.
- Usage: Read by Prettier commands.
- Important parameters: Ignores dependencies, build output, coverage, data files, and databases.
- Status: Started.
- Tests: Covered by `pnpm format:check`.

#### .prettierrc

- Purpose: Defines formatting rules.
- Usage: Read by Prettier commands and editor integrations.
- Important parameters: Semicolons, double quotes, trailing commas, 100-character print width.
- Status: Started.
- Tests: Covered by `pnpm format:check`.

#### eslint.config.js

- Purpose: Configures ESLint for JavaScript and TypeScript files.
- Usage: Run through `pnpm lint`.
- Important parameters: Uses ESLint recommended rules and TypeScript ESLint recommended rules.
- Status: Started.
- Tests: Covered by `pnpm lint`.

#### package.json

- Purpose: Root workspace package metadata and project scripts.
- Usage: Run `pnpm install`, `pnpm verify`, provider smoke tests, scanner discovery, risk evaluation, strategy evaluation, paper BUY execution, paper SELL execution, SessionManager, ExitManager, shadow observation, shadow exit simulation, shadow calibration, and package orchestration scripts from the root.
- Important parameters: Node >=24 target, pnpm 11.8.0 package manager, shared verify pipeline, database scripts, provider smoke script, scanner discovery script, risk evaluation script, strategy evaluation script, paper BUY script, paper SELL script, SessionManager script, ExitManager script, shadow observation script, shadow exit simulation script, and shadow calibration script.
- Status: Started.
- Tests: Covered by install and verify commands.

#### pnpm-lock.yaml

- Purpose: Locks dependency versions for reproducible workspace installs.
- Usage: Generated and maintained by `pnpm install`.
- Important parameters: Captures root, backend, shared, and transitive dependency resolutions.
- Status: Started.
- Tests: Covered by `pnpm install` and `pnpm verify`.

#### pnpm-workspace.yaml

- Purpose: Declares workspace packages.
- Usage: Read by pnpm.
- Important parameters: Includes `backend` and `shared`.
- Status: Started.
- Tests: Covered by `pnpm install`.

#### README.md

- Purpose: Human-facing project overview and quick start.
- Usage: Read before setup or development.
- Important parameters: Documents paper-first scope, live-trading safety warning, database commands, provider smoke commands, scanner discovery commands, risk evaluation commands, strategy evaluation commands, paper BUY execution commands, and paper SELL execution commands.
- Status: Started.
- Tests: Manual documentation review.

#### tsconfig.base.json

- Purpose: Shared strict TypeScript compiler settings.
- Usage: Extended by package-level TypeScript configs.
- Important parameters: Strict mode, NodeNext modules, exact optional properties, unchecked indexed access, shared package path aliases.
- Status: Started.
- Tests: Covered by `pnpm typecheck`.

## Backend

#### backend/package.json

- Purpose: Backend package metadata, scripts, and dependencies.
- Usage: Run through root scripts or `pnpm --filter @nexustrade/backend ...`.
- Important parameters: Depends on `@nexustrade/shared`, `zod`, and `tsx`; exposes database, provider smoke, backend dev, test, typecheck, scanner discovery, risk evaluation, strategy evaluation, paper BUY execution, paper SELL execution, SessionManager, ExitManager, shadow observation, shadow exit simulation, and shadow calibration scripts.
- Status: Started.
- Tests: Covered by backend test and typecheck commands.

#### backend/tsconfig.json

- Purpose: Backend TypeScript settings.
- Usage: Used by backend typecheck, tests, and development runner.
- Important parameters: Extends root strict config and includes Node/Vitest types.
- Status: Started.
- Tests: Covered by `pnpm --filter @nexustrade/backend typecheck`.

#### backend/src/index.ts

- Purpose: Backend startup entry point and Phase 1 boot check.
- Usage: Run through `pnpm dev:backend`.
- Important parameters: Reads environment through `loadAppConfig`, applies the live-mode guard, and prints startup status.
- Status: Started.
- Tests: Covered indirectly by config, guard, and health tests.

#### backend/src/config/env.ts

- Purpose: Validates environment variables and creates typed app config.
- Usage: Imported by backend startup and future services.
- Important parameters: Loads local root `.env` when reading `process.env`; defaults missing `NEXUSTRADE_MODE` to `PAPER`; validates `NODE_ENV`; rejects unknown modes.
- Status: Started.
- Tests: Covered by `backend/src/config/env.test.ts`.

#### backend/src/config/loadEnvFile.ts

- Purpose: Loads root `.env` through Node 24's built-in `process.loadEnvFile`.
- Usage: Called by `loadAppConfig()` only when using real `process.env`.
- Important parameters: Does not run for explicit test env objects and does not require `dotenv`.
- Status: Complete.
- Tests: Covered indirectly by config and provider smoke behavior.

#### backend/src/config/env.test.ts

- Purpose: Tests backend environment loading behavior.
- Usage: Run through `pnpm --filter @nexustrade/backend test`.
- Important parameters: Covers default paper mode, explicit paper mode, lowercase parsing, invalid mode rejection, and live-mode blocking.
- Status: Started.
- Tests: Test file.

#### backend/src/config/liveModeGuard.ts

- Purpose: Blocks live mode during Phase 1.
- Usage: Called during backend startup before any long-running service can begin.
- Important parameters: `LIVE_MODE_DISABLED_MESSAGE`.
- Status: Started.
- Tests: Covered by `backend/src/config/env.test.ts`.

#### backend/src/health/healthCheck.ts

- Purpose: Returns a basic backend health summary.
- Usage: Called by startup and future health endpoints.
- Important parameters: App name, mode, Node version, and `ok` status.
- Status: Started.
- Tests: Covered by `backend/src/health/healthCheck.test.ts`.

#### backend/src/health/healthCheck.test.ts

- Purpose: Tests backend health output.
- Usage: Run through `pnpm --filter @nexustrade/backend test`.
- Important parameters: Verifies app name, mode, Node version, and status.
- Status: Started.
- Tests: Test file.

#### backend/src/logging/logger.ts

- Purpose: Provides a small scoped console logger until the database-backed logger exists.
- Usage: Imported by backend startup and future backend modules.
- Important parameters: Emits ISO timestamp, log level, scope, message, and optional metadata.
- Status: Started.
- Tests: Pending direct unit tests; exercised by backend startup.

## Shared

#### shared/package.json

- Purpose: Shared package metadata and scripts.
- Usage: Imported as `@nexustrade/shared`.
- Important parameters: Exposes shared TypeScript source for Phase 1 development.
- Status: Started.
- Tests: Covered by shared test and typecheck commands.

#### shared/tsconfig.json

- Purpose: Shared package TypeScript settings.
- Usage: Used by shared typecheck and tests.
- Important parameters: Extends root strict config and includes Vitest types.
- Status: Started.
- Tests: Covered by `pnpm --filter @nexustrade/shared typecheck`.

#### shared/src/config.ts

- Purpose: Defines early shared app config types.
- Usage: Imported by backend configuration and future services.
- Important parameters: App name, execution mode, and Node environment.
- Status: Started.
- Tests: Covered indirectly by backend config tests.

#### shared/src/index.ts

- Purpose: Public barrel export for shared types and helpers.
- Usage: Imported by packages as `@nexustrade/shared`.
- Important parameters: Exports config and execution mode helpers.
- Status: Started.
- Tests: Covered by package typecheck.

#### shared/src/modes.ts

- Purpose: Defines execution modes and mode helpers.
- Usage: Used by config, guards, and future execution-mode routing.
- Important parameters: `PAPER`, `LIVE`, `BACKTEST`, default `PAPER`, parsing, and live detection.
- Status: Started.
- Tests: Covered by `shared/src/modes.test.ts`.

#### shared/src/modes.test.ts

- Purpose: Tests shared execution mode helpers.
- Usage: Run through `pnpm --filter @nexustrade/shared test`.
- Important parameters: Covers defaults, valid parsing, invalid parsing, and live-mode detection.
- Status: Started.
- Tests: Test file.

## Frontend

#### frontend/README.md

- Purpose: Documents why the frontend is a placeholder during Phase 1.
- Usage: Read before starting dashboard work.
- Important parameters: Vite initialization is deferred until paper-engine output exists.
- Status: Started.
- Tests: Manual documentation review.

## Docs

#### docs/DECISIONS.md

- Purpose: Records accepted technical decisions.
- Usage: Append future architecture decisions as the system evolves.
- Important parameters: Runtime, pnpm, strict TypeScript, execution modes, live-mode guard, frontend deferral.
- Status: Started.
- Tests: Manual documentation review.

#### docs/NeXusTrade-Phase-1-Detailed-Checklist.md

- Purpose: Tracks Phase 1 scope and verification commands.
- Usage: Use as the active implementation checklist for the foundation phase.
- Important parameters: Definition of done, verification commands, and out-of-scope list.
- Status: Started.
- Tests: Manual documentation review.

#### docs/ROADMAP.md

- Purpose: Captures the high-level project roadmap.
- Usage: Read before starting each phase.
- Important parameters: North star, phase list, active Phase 1 outcome.
- Status: Started.
- Tests: Manual documentation review.

#### docs/Structure.md

- Purpose: Documents every meaningful file created in the project.
- Usage: Update whenever files are added, removed, or materially changed.
- Important parameters: Purpose, usage, important parameters, status, and test status for each file.
- Status: Started.
- Tests: Manual documentation review.

## Scripts

#### scripts/check-secrets.mjs

- Purpose: Blocks accidental commits of env files, wallet files, key material, and obvious private key content.
- Usage: Run `pnpm check:secrets`; also called by the Husky pre-commit hook.
- Important parameters: Scans staged files when present, otherwise scans tracked and untracked non-ignored files.
- Status: Started.
- Tests: Covered by `pnpm check:secrets` and manual fake-secret validation later.

## Data

#### data/.gitkeep

- Purpose: Preserves the local data directory in git without committing databases.
- Usage: Future local database files live under `data/` and remain ignored.
- Important parameters: Empty placeholder only.
- Status: Started.
- Tests: Covered by git status review.

## Git Hooks

#### .husky/pre-commit

- Purpose: Runs formatting/linting on staged files and the secret check before commits.
- Usage: Installed by Husky after `pnpm install`.
- Important parameters: Runs `pnpm lint-staged` and `pnpm check:secrets`.
- Status: Started.
- Tests: Husky install completed during `pnpm install`; hook body pending commit-time validation.

## Phase 2 Database Layer

#### backend/drizzle.config.ts

- Purpose: Configures Drizzle Kit for SQLite migration generation.
- Usage: Run through `pnpm db:generate`.
- Important parameters: Schema entry `backend/src/db/schema/index.ts`, output `backend/drizzle`, paper DB `data/nexus_paper.db`.
- Status: Complete.
- Tests: Covered by `pnpm db:generate`.

#### backend/drizzle/0000_tense_aqueduct.sql

- Purpose: Initial SQL migration for all Phase 2 tables, indexes, and foreign keys.
- Usage: Applied through `pnpm db:migrate:paper`.
- Important parameters: Creates sessions, radar, risk, decisions, orders, fills, positions, snapshots, logs, and provider health tables.
- Status: Complete.
- Tests: Covered by migration, connection tests, repository tests, and smoke test.

#### backend/drizzle/meta/0000_snapshot.json

- Purpose: Drizzle schema snapshot for migration diffing.
- Usage: Maintained by Drizzle Kit.
- Important parameters: Tracks the generated Phase 2 schema state.
- Status: Complete.
- Tests: Covered by migration generation.

#### backend/drizzle/meta/\_journal.json

- Purpose: Drizzle migration journal.
- Usage: Maintained by Drizzle Kit.
- Important parameters: Records generated migration order.
- Status: Complete.
- Tests: Covered by migration generation.

#### backend/src/db/DatabaseFactory.ts

- Purpose: Creates mode-specific database contexts.
- Usage: Imported by startup, migrations, tests, seeds, and smoke scripts.
- Important parameters: Accepts execution mode, optional data directory, and guard flags.
- Status: Complete.
- Tests: Covered by connection and repository tests.

#### backend/src/db/DatabaseMode.ts

- Purpose: Resolves database paths and blocks guarded modes by default.
- Usage: Imported by database factory and tests.
- Important parameters: `PAPER`, `LIVE`, and `BACKTEST` path map; live/backtest guard messages.
- Status: Complete.
- Tests: Covered by `backend/src/db/DatabaseMode.test.ts`.

#### backend/src/db/DatabaseMode.test.ts

- Purpose: Tests database path resolution and mode guards.
- Usage: Run through `pnpm test`.
- Important parameters: Paper path, live guard, backtest guard, explicit override flags.
- Status: Complete.
- Tests: Test file.

#### backend/src/db/connection.ts

- Purpose: Opens `better-sqlite3`, applies SQLite PRAGMAs, and wraps the connection with Drizzle.
- Usage: Called by `DatabaseFactory`.
- Important parameters: Foreign keys on, WAL mode, busy timeout 5000, synchronous normal.
- Status: Complete.
- Tests: Covered by `backend/src/db/connection.test.ts`.

#### backend/src/db/connection.test.ts

- Purpose: Tests SQLite connection setup, PRAGMAs, table creation, and foreign-key enforcement.
- Usage: Run through `pnpm test`.
- Important parameters: Temporary migrated paper database.
- Status: Complete.
- Tests: Test file.

#### backend/src/db/index.ts

- Purpose: Public backend database barrel export.
- Usage: Imported by backend startup and future backend modules.
- Important parameters: Exports factory, connection, migrations, and repositories.
- Status: Complete.
- Tests: Covered by typecheck.

#### backend/src/db/migratePaper.ts

- Purpose: Applies migrations to the paper database.
- Usage: Run `pnpm db:migrate:paper`.
- Important parameters: Always targets `PAPER`.
- Status: Complete.
- Tests: Covered by `pnpm db:migrate:paper`.

#### backend/src/db/migrations.ts

- Purpose: Provides migration folder resolution, migration runner, and migration-readiness assertion.
- Usage: Used by migration scripts, startup, tests, and smoke test.
- Important parameters: Migrations folder `backend/drizzle`; checks for `sessions` table.
- Status: Complete.
- Tests: Covered by migration, startup, and smoke test.

#### backend/src/db/resetPaper.ts

- Purpose: Deletes only paper database files and reapplies migrations.
- Usage: Run `pnpm db:reset:paper`.
- Important parameters: Removes `nexus_paper.db`, `nexus_paper.db-wal`, and `nexus_paper.db-shm` only.
- Status: Complete.
- Tests: Covered by implementation safeguards; manual command available.

#### backend/src/db/schema/\*.ts

- Purpose: Defines Drizzle tables, indexes, foreign keys, enums, and inferred record types.
- Usage: Imported by Drizzle Kit, database connections, and repositories.
- Important parameters: Snake_case table/column names, TypeScript camelCase properties, lamports as integers, decimal strings, JSON text fields.
- Status: Complete.
- Tests: Covered by migration generation, connection tests, repository tests, and smoke test.

#### backend/src/db/repositories/\*.ts

- Purpose: Provides repository classes for sessions, radar tokens, risk assessments, strategy decisions, orders, fills, positions, snapshots, system logs, and provider health.
- Usage: Construct with `createRepositories(db)`.
- Important parameters: Create/read/update/list methods; raw Drizzle usage stays inside persistence layer.
- Status: Complete.
- Tests: Covered by `backend/src/db/repositories/repositories.test.ts`.

#### backend/src/db/repositories/repositories.test.ts

- Purpose: Tests repository behavior with a migrated database and seeded paper scenario.
- Usage: Run through `pnpm test`.
- Important parameters: Readback, updates, radar dedupe, JSON round trip.
- Status: Complete.
- Tests: Test file.

#### backend/src/db/seeds/seedPaperDatabase.ts

- Purpose: Inserts a realistic fake paper session and related trading records.
- Usage: Run `pnpm db:seed:paper` or import `seedPaperDatabase`.
- Important parameters: Creates radar, risk, decision, order, fill, position, snapshots, logs, and provider health.
- Status: Complete.
- Tests: Covered by repository tests and smoke test.

#### backend/src/db/testing/createTestDatabase.ts

- Purpose: Creates temporary migrated paper databases for integration tests.
- Usage: Imported by database tests.
- Important parameters: Uses OS temp directories and cleanup callback.
- Status: Complete.
- Tests: Covered by database test files.

#### backend/src/db/testing/databaseSmokeTest.ts

- Purpose: End-to-end paper database smoke test.
- Usage: Run `pnpm db:smoke:paper`.
- Important parameters: Runs migrations, seeds fake paper data, reads records back through repositories.
- Status: Complete.
- Tests: Smoke script itself passed.

#### backend/src/db/testing/databaseTestHelpers.ts

- Purpose: Shared database assertions for tests.
- Usage: Imported by connection tests.
- Important parameters: Table listing, foreign-key PRAGMA, WAL PRAGMA.
- Status: Complete.
- Tests: Covered by connection tests.

#### backend/src/db/utils/\*.ts

- Purpose: Provides IDs, JSON redaction/parsing, lamport/SOL conversion, path resolution, and timestamp helpers.
- Usage: Imported by repositories, seeds, smoke tests, and startup.
- Important parameters: Sensitive JSON keys are redacted; SOL conversion supports up to 9 decimal places.
- Status: Complete.
- Tests: Covered by utility tests.

#### backend/src/db/utils/\*.test.ts

- Purpose: Tests JSON, money, and timestamp helpers.
- Usage: Run through `pnpm test`.
- Important parameters: Redaction, JSON parse failure, SOL/lamport conversions, UTC ISO rendering.
- Status: Complete.
- Tests: Test files.

#### docs/NeXusTrade-Phase-2-Detailed-Checklist.md

- Purpose: Local Phase 2 checklist and verification notes.
- Usage: Read during Phase 2 review and handoff.
- Important parameters: Definition of done, verification notes, out-of-scope list.
- Status: Complete.
- Tests: Manual documentation review.

#### docs/NeXusTrade-Phase-3-Detailed-Checklist.md

- Purpose: Local Phase 3 checklist, verification notes, phase notes, and out-of-scope boundaries for the provider layer.
- Usage: Read during Phase 3 review, handoff, or provider-layer maintenance.
- Important parameters: Provider contracts, vendor adapters, provider health, MarketDataService, smoke-test commands, provider limitations, and no-trading boundary.
- Status: Complete.
- Tests: Manual documentation review.

#### docs/NeXusTrade-Phase-4-Detailed-Checklist.md

- Purpose: Local Phase 4 checklist, verification notes, runtime commands, phase notes, and out-of-scope boundaries for scanner-only mode.
- Usage: Read during Phase 4 review, handoff, or scanner maintenance.
- Important parameters: Discovery, dedupe, enrichment, TokenRadar persistence, session policy, dry-run behavior, scanner safety boundary, and Phase 5 handoff.
- Status: Complete.
- Tests: Manual documentation review.

#### docs/NeXusTrade-Phase-5-Detailed-Checklist.md

- Purpose: Local Phase 5 checklist, verification notes, runtime commands, phase notes, and out-of-scope boundaries for the first risk engine.
- Usage: Read during Phase 5 review, handoff, or risk-engine maintenance.
- Important parameters: Candidate selection, evidence refresh, quote probes, deterministic rules, scoring, RiskAssessment persistence, TokenRadar status transitions, dry-run behavior, and Phase 6 handoff.
- Status: Complete.
- Tests: Manual documentation review.

#### docs/NeXusTrade-Phase-6-Detailed-Checklist.md

- Purpose: Planned Phase 6 checklist for the first strategy engine.
- Usage: Read before implementing strategy evaluation.
- Important parameters: `PASS_OR_ELIGIBLE_WARN` source of truth, strict `PAPER` + `RUNNING` session policy, candidate selection, latest risk lookup, rule-based strategy scoring, StrategyDecision persistence, TokenRadar `APPROVED` updates after stored BUY decisions, duplicate BUY protection, dry-run behavior, safety boundaries, and Phase 7 handoff.
- Status: Complete.
- Tests: Manual documentation review.

#### docs/NeXusTrade-Phase-7-Detailed-Checklist.md

- Purpose: Planned Phase 7 checklist for the PaperExchange buy engine.
- Usage: Read before implementing paper execution.
- Important parameters: `StrategyDecision(BUY)` plus `TokenRadar(APPROVED)` candidate selection, strict `PAPER` + `RUNNING` session policy, default 0.01 SOL buy sizing, order/fill/position persistence, cash decrement, TokenRadar `BOUGHT` transition, dry-run behavior, duplicate-position protection, rejection handling, and no wallet/signing/submission boundary.
- Status: Complete.
- Tests: Manual documentation review.

#### docs/NeXusTrade-Phase-7.5-Detailed-Checklist.md

- Purpose: Locked Phase 7.5 checklist for the PaperExchange SELL engine and realized P/L.
- Usage: Read before implementing paper SELL execution.
- Important parameters: No first-pass DB migration, explicit `--sell-all` or `--mint` trigger policy, quote/price fallback hierarchy, existing-schema SELL audit mapping, open-position selection, realized P/L accounting, TokenRadar `WATCHING` transition after close, transaction-boundary guidance, dry-run behavior, safety boundaries, and Phase 8 handoff.
- Status: Complete.
- Tests: Manual documentation review.

#### docs/NeXusTrade-Phase-8-Detailed-Checklist.md

- Purpose: Locked Phase 8 checklist for SessionManager, snapshots, target tracking, drawdown tracking, and BUY gating.
- Usage: Read before implementing Phase 8 SessionManager.
- Important parameters: Standalone `pnpm session:manage --once` command, no first-pass DB migration, existing-schema snapshot mapping, `terminationReason`-based BUY gating, no automatic SELLs, valuation fallback hierarchy, session selection rules, failure codes, repository changes, and acceptance tests.
- Status: Complete.
- Tests: Manual documentation review.

#### docs/NeXusTrade-Phase-8.5-Detailed-Checklist.md

- Purpose: Locked Phase 8.5 checklist for automated session-level paper exits.
- Usage: Read before implementing ExitManager automation from SessionManager governance signals.
- Important parameters: Standalone `pnpm exits:manage --once` command, observe-only default, explicit `sell-all` actions for `TARGET_REACHED` and `MAX_DRAWDOWN`, direct PaperSell service reuse, optional session completion, dry-run no-write behavior, idempotency protections, and no stop-loss/trailing/live-execution boundary.
- Status: Complete.
- Tests: Manual documentation review.

#### docs/NeXusTrade-Phase-8.6-Detailed-Checklist.md

- Purpose: Locked Phase 8.6 checklist for stabilization, clean paper validation, database archive/reset, and Phase 9 handoff.
- Usage: Read before committing Phase 8/8.5 work, resetting local paper data, running clean validation, or planning TerminalRunner.
- Important parameters: No-new-feature boundary, archive and rollback procedures, reset procedure, deterministic and real-market validation tracks, command acceptance matrix, known limitation tracking, Phase 9 orchestration assumptions, and milestone sign-off criteria.
- Status: Complete.
- Tests: Manual documentation review.

#### docs/Phase-9-Planning-Inputs.md

- Purpose: Captures the Phase 8.6 through completed Phase 8.93 handoff details needed to plan TerminalRunner.
- Usage: Read before implementing continuous orchestration, scheduling, cycle summaries, and graceful shutdown.
- Important parameters: Current command surface, implemented `shadow:entries` surface, Phase 8.92B validation evidence, completed Phase 8.93 no-promotion decision, shadow-first Phase 9 command order, runtime defaults, session lifecycle, exit lifecycle, safety boundaries, logging surfaces, Phase 8.91 validation output, Phase 8.92 entry-gate handoff, known limitations, and Phase 9 planning questions.
- Status: Complete.
- Tests: Manual documentation review.

#### docs/architecture/database.md

- Purpose: Explains local database architecture and conventions.
- Usage: Read before changing schema, repositories, or database mode behavior.
- Important parameters: Mode-specific files, PRAGMAs, storage conventions, repository boundary.
- Status: Complete.
- Tests: Manual documentation review.

#### docs/architecture/risk-engine.md

- Purpose: Documents Phase 5 risk-engine architecture, command options, session policy, pipeline, rules, scoring model, status transitions, dry-run behavior, and safety boundaries.
- Usage: Read before changing risk evaluation or planning Phase 6 strategy integration.
- Important parameters: Paper-only runtime, no auto-created sessions, default selection window, quote probe, conservative authority evidence policy, and no-trading boundary.
- Status: Complete.
- Tests: Manual documentation review.

#### docs/phase-notes/phase-2-database-layer.md

- Purpose: Running notes for Phase 2 implementation decisions and caveats.
- Usage: Read during handoff or review.
- Important parameters: Dependency install notes, migration note, Node version caveat.
- Status: Complete.
- Tests: Manual documentation review.

## Phase 3 Provider Layer

#### shared/src/providers/\*.ts

- Purpose: Defines provider names, capabilities, structured errors, and `ProviderResult<T>`.
- Usage: Imported by backend adapters and future scanner/strategy code through `@nexustrade/shared`.
- Important parameters: `JUPITER`, `DEXSCREENER`, `HELIUS`, `RUGCHECK`, `MOCK`; `PRICE`, `QUOTE`, `TOKEN_METADATA`, `LIQUIDITY`, `TOKEN_DISCOVERY`, `RISK_EVIDENCE`, `PRIORITY_FEE`.
- Status: Complete.
- Tests: Covered by shared provider result tests.

#### shared/src/market/\*.ts

- Purpose: Defines normalized token, price, quote, pair/liquidity, metadata, risk-evidence, priority-fee, and enrichment contracts.
- Usage: Returned by provider adapters and consumed by `MarketDataService`.
- Important parameters: Solana mint validation, source attribution, fetched-at timestamps, and optional partial provider fields.
- Status: Complete.
- Tests: Covered by shared token and enrichment tests plus backend mapper tests.

#### backend/src/providers/config/providerConfig.ts

- Purpose: Parses provider runtime configuration from environment variables.
- Usage: Called by `loadAppConfig()`.
- Important parameters: `PROVIDERS_ENABLED`, provider base URLs, timeout/retry settings, rate limits, raw payload flag, API keys.
- Status: Complete.
- Tests: Covered by backend config tests.

#### backend/src/providers/http/\*.ts

- Purpose: Provides provider HTTP, retry, and rate-limit infrastructure.
- Usage: Used by all live provider adapters.
- Important parameters: Per-provider base URL, timeout, rate limit per minute, normalized provider errors.
- Status: Complete.
- Tests: Covered by HTTP client and rate limiter tests.

#### backend/src/providers/interfaces/\*.ts

- Purpose: Defines backend adapter interfaces for price, quote, metadata, liquidity, discovery, risk evidence, and priority fee.
- Usage: Implemented by vendor adapters and consumed by `ProviderRegistry` and `MarketDataService`.
- Important parameters: Methods return `ProviderResult<T>` and normalized shared contracts.
- Status: Complete.
- Tests: Covered indirectly by adapter and market-data service tests.

#### backend/src/providers/dexscreener/\*.ts

- Purpose: Implements DexScreener HTTP pair, best-pair, price-from-pair, and token profile discovery support.
- Usage: Enabled by default because the selected public endpoints do not require a key.
- Important parameters: Base URL, 300 rpm configured default, deterministic best-pair selection.
- Status: Complete.
- Tests: Covered by DexScreener mapper tests and provider smoke script.

#### backend/src/providers/jupiter/\*.ts

- Purpose: Implements Jupiter Price v3, quote, and partial metadata normalization.
- Usage: Enabled only when `JUPITER_API_KEY` is configured.
- Important parameters: `x-api-key`, price base URL, swap quote base URL.
- Status: Complete.
- Tests: Covered by Jupiter mapper tests and provider smoke script when configured.

#### backend/src/providers/helius/\*.ts

- Purpose: Implements Helius DAS metadata, authority evidence, and priority-fee normalization.
- Usage: Enabled only when `HELIUS_API_KEY` is configured.
- Important parameters: Helius RPC base URL and `api-key` query authorization.
- Status: Complete.
- Tests: Covered by Helius mapper tests and provider smoke script when configured.

#### backend/src/providers/ProviderHealthService.ts

- Purpose: Writes provider result status and provider logs through the Phase 2 repositories.
- Usage: Used by adapters and provider smoke script.
- Important parameters: Records status, latency, rate-limit state, error messages, and redacted context.
- Status: Complete.
- Tests: Covered by provider health service tests.

#### backend/src/providers/ProviderRegistry.ts

- Purpose: Builds and exposes configured provider adapters by capability.
- Usage: Used by smoke tests and future services.
- Important parameters: Skips missing key-backed providers in normal mode.
- Status: Complete.
- Tests: Covered indirectly by `MarketDataService` and smoke script typecheck.

#### backend/src/providers/MarketDataService.ts

- Purpose: Combines provider outputs into one `TokenEnrichmentSnapshot`.
- Usage: Future scanner-only mode should call this for token candidate enrichment.
- Important parameters: Partial provider failures become warnings when possible.
- Status: Complete.
- Tests: Covered by mocked market-data service tests.

#### backend/src/scripts/providers-smoke.ts

- Purpose: Runs a safe paper-only provider smoke check.
- Usage: Run `pnpm providers:smoke`, optionally with `--mint=...` or `--strict`.
- Important parameters: Writes ProviderHealth and SystemLog rows; does not use wallets, signing, transactions, orders, fills, or positions.
- Status: Complete.
- Tests: Typechecked; live network behavior covered by `pnpm providers:smoke` when network access is available.

#### docs/Provider-Architecture.md

- Purpose: Documents Phase 3 provider design rules, provider matrix, smoke-test behavior, and Phase 4 handoff.
- Usage: Read before changing providers or scanner integration.
- Important parameters: Credentials, capabilities, limitations, and raw payload logging rules.
- Status: Complete.
- Tests: Manual documentation review.

#### docs/Phase-4-Planning-Inputs.md

- Purpose: Captures the Phase 3 handoff details needed to plan Phase 4 candidate discovery and TokenRadar storage.
- Usage: Read before implementing scanner-only discovery, dedupe, enrichment, and candidate persistence.
- Important parameters: Current file tree, MarketDataService surface, TokenDiscoveryProvider output, DexScreener discovery status, smoke output, TokenRadarRepository methods, provider config, and known limitations.
- Status: Complete.
- Tests: Manual documentation review.

#### docs/Phase-5-Planning-Inputs.md

- Purpose: Captures Phase 4 handoff details and decision recommendations for the first risk engine.
- Usage: Read before writing the Phase 5 detailed checklist or implementing risk evaluation.
- Important parameters: Current file tree, scanner architecture, scanner runner and mapper behavior, TokenRadar and RiskAssessment repository methods, risk/enrichment types, Helius/DexScreener/Jupiter evidence fields, scanner safety tests, sample TokenRadar row, Phase 4 completion notes, and Phase 5 command/status/threshold recommendations.
- Status: Complete.
- Tests: Manual documentation review.

#### docs/Phase-6-Planning-Inputs.md

- Purpose: Captures Phase 5 handoff details and decision recommendations for the first strategy engine.
- Usage: Read before writing the Phase 6 detailed checklist or implementing strategy evaluation.
- Important parameters: Current file tree, risk engine architecture, risk runner/config/rule surfaces, RiskAssessment/StrategyDecision/TokenRadar repository methods, StrategyDecision schema fields and enum values, sample post-risk database rows, package scripts, safety tests, and Phase 6 command/status/rule recommendations.
- Status: Complete.
- Tests: Manual documentation review.

#### docs/Phase-7-Planning-Inputs.md

- Purpose: Captures Phase 6 handoff details and decision recommendations for PaperExchange.
- Usage: Read before writing the Phase 7 detailed checklist or implementing paper execution.
- Important parameters: StrategyDecision BUY output, TokenRadar APPROVED output, latest risk dependency, Order/Fill/Position schemas and repository methods, session cash fields and `updateSessionPnl()`, sample StrategyDecision row, execution boundary, migration assessment, and Phase 7 command/default recommendations.
- Status: Complete.
- Tests: Manual documentation review.

#### docs/Phase-7.5-Planning-Inputs.md

- Purpose: Captures Phase 7 handoff details needed for Phase 7.5 SELL execution and P/L planning.
- Usage: Read before planning position closing, realized P/L, unrealized P/L, or SELL simulation.
- Important parameters: Current paper execution output, runtime defaults, rejection reasons, open position fields, fill fields, session policy, and recommended Phase 7.5 direction.
- Status: Started.
- Tests: Manual documentation review.

#### docs/Phase-8-Planning-Inputs.md

- Purpose: Captures Phase 7.5 handoff details needed for Phase 8 SessionManager planning.
- Usage: Read before planning target control, stop-loss behavior, snapshots, or session completion.
- Important parameters: Current complete paper execution loop, SELL runtime behavior, execution records, accounting model, current limitations, paper DB hygiene, no automatic SELL integration in Phase 8, Phase 8 decisions, and recommended direction.
- Status: Started.
- Tests: Manual documentation review.

## Phase 4 Scanner-Only Mode

#### backend/src/scanner/ScannerConfig.ts

- Purpose: Defines scanner runtime defaults, validation bounds, CLI argument parsing, and config snapshots.
- Usage: Imported by the scanner CLI and runner tests.
- Important parameters: Defaults `intervalMs=60000`, `limit=25`, `concurrency=3`; validates interval, limit, and concurrency bounds; supports `--once`, `--dry-run`, `--session-id`, `--interval-ms`, `--limit`, and `--concurrency`.
- Status: Complete.
- Tests: Covered by `backend/src/scanner/ScannerConfig.test.ts`.

#### backend/src/scanner/ScannerConfig.test.ts

- Purpose: Tests scanner defaults, CLI parsing, and runtime validation.
- Usage: Run through `pnpm test`.
- Important parameters: Covers Phase 4 defaults, all supported command-line options, unknown option rejection, and invalid bound rejection.
- Status: Complete.
- Tests: Test file.

#### backend/src/scanner/ScannerDiscoveryService.ts

- Purpose: Aggregates token candidates from configured `TokenDiscoveryProvider` adapters.
- Usage: Called by `ScannerRunner.runCycle()`.
- Important parameters: Calls provider discovery through `ProviderRegistry`, records provider success/failure counts, logs discovery metrics, applies cycle limit, and exposes mint-address deduplication helper.
- Status: Complete.
- Tests: Covered by `backend/src/scanner/ScannerDiscoveryService.test.ts`.

#### backend/src/scanner/ScannerDiscoveryService.test.ts

- Purpose: Tests discovery aggregation, provider failure handling, limit behavior, and deduplication.
- Usage: Run through `pnpm test`.
- Important parameters: Uses mock discovery providers and verifies raw, unique, and duplicate counts.
- Status: Complete.
- Tests: Test file.

#### backend/src/scanner/CandidateEnrichmentService.ts

- Purpose: Enriches deduplicated scanner candidates through `MarketDataService`.
- Usage: Called by `ScannerRunner.runCycle()` after deduplication.
- Important parameters: Uses bounded concurrency and preserves provider warnings and structured provider results.
- Status: Complete.
- Tests: Covered by `backend/src/scanner/CandidateEnrichmentService.test.ts`.

#### backend/src/scanner/CandidateEnrichmentService.test.ts

- Purpose: Tests candidate enrichment with bounded concurrency.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies enrichment attempts and that configured concurrency is not exceeded.
- Status: Complete.
- Tests: Test file.

#### backend/src/scanner/mappers/RadarCandidateMapper.ts

- Purpose: Converts discovered and enriched candidates into `TokenRadarRepository` inputs.
- Usage: Called by `ScannerRunner.runCycle()` before persistence.
- Important parameters: Maps discovery provider source, best pair address, symbol/name, decimal string fields, first seen time, discovered time, age seconds, compact redacted raw data, and `ERROR` records for enrichment failures.
- Status: Complete.
- Tests: Covered by `backend/src/scanner/mappers/RadarCandidateMapper.test.ts`.

#### backend/src/scanner/mappers/RadarCandidateMapper.test.ts

- Purpose: Tests TokenRadar mapping for successful enrichment and enrichment failures.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies numeric string conversion, pair mapping, age derivation, redacted JSON summary, and `ERROR` status behavior.
- Status: Complete.
- Tests: Test file.

#### backend/src/scanner/TokenRadarPersistenceService.ts

- Purpose: Persists normalized scanner candidates into `TokenRadar`.
- Usage: Called by `ScannerRunner.runCycle()` after candidate mapping.
- Important parameters: Uses `TokenRadarRepository.upsertRadarEntry()`, writes scanner persistence logs, and skips TokenRadar writes in dry-run mode.
- Status: Complete.
- Tests: Covered by `backend/src/scanner/TokenRadarPersistenceService.test.ts`.

#### backend/src/scanner/TokenRadarPersistenceService.test.ts

- Purpose: Tests TokenRadar upsert behavior and dry-run behavior.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies first-seen preservation, refreshed discovery data, and skipped writes during dry runs.
- Status: Complete.
- Tests: Test file.

#### backend/src/scanner/ScannerRunner.ts

- Purpose: Orchestrates scanner sessions and scanner discovery cycles.
- Usage: Called by `backend/src/scripts/scanner-discover.ts` and tests.
- Important parameters: Auto-creates zero-balance `PAPER` sessions, reuses only `CREATED` or `RUNNING` paper sessions, supports one-shot and continuous loops, logs cycle summaries, and keeps scanner behavior separated from risk, strategy, order, fill, position, wallet, signing, and submission behavior.
- Status: Complete.
- Tests: Covered by `backend/src/scanner/ScannerRunner.test.ts`.

#### backend/src/scanner/ScannerRunner.test.ts

- Purpose: Tests the scanner pipeline, session policy, dry-run behavior, and safety boundary.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies auto-created paper sessions, existing session reuse, rejected completed sessions, TokenRadar writes, dry-run skips, scanner logs, and absence of risk assessment, strategy decision, order, fill, and position records.
- Status: Complete.
- Tests: Test file.

#### backend/src/scripts/scanner-discover.ts

- Purpose: CLI entry point for scanner-only discovery.
- Usage: Run `pnpm scanner:discover`, optionally with `--once`, `--dry-run`, `--session-id`, `--interval-ms`, `--limit`, or `--concurrency`.
- Important parameters: Enforces `PAPER` mode, runs migrations, builds repositories, provider health service, provider registry, `MarketDataService`, and `ScannerRunner`, prints safety status, handles `SIGINT`, and closes the paper database.
- Status: Complete.
- Tests: Covered by typecheck, scanner runner tests, and one-shot smoke validation when network access is available.

#### docs/architecture/scanner.md

- Purpose: Documents Phase 4 scanner-only architecture, commands, defaults, session policy, pipeline, dry-run behavior, safety boundary, and limitations.
- Usage: Read before changing scanner behavior or planning Phase 5 risk-engine integration.
- Important parameters: Paper-only runtime, default interval/limit/concurrency, reusable session policy, DexScreener token profile discovery limitation, and no-trading boundary.
- Status: Complete.
- Tests: Manual documentation review.

## Phase 5 Risk Engine

#### backend/src/risk/RiskConfig.ts

- Purpose: Defines Phase 5 risk runtime defaults, bounds, CLI parsing, and status validation.
- Usage: Imported by the risk CLI and tests.
- Important parameters: Defaults `statuses=DISCOVERED,WATCHING`, `sinceHours=24`, `limit=50`, `concurrency=3`, `probeAmountSol=0.01`, and supports `--once`, `--dry-run`, `--session-id`, `--status`, `--since-hours`, `--limit`, `--concurrency`, and `--probe-sol`.
- Status: Complete.
- Tests: Covered by `backend/src/risk/RiskConfig.test.ts`.

#### backend/src/risk/RiskConfig.test.ts

- Purpose: Tests risk defaults, CLI parsing, and runtime validation.
- Usage: Run through `pnpm test`.
- Important parameters: Covers accepted statuses, recency/limit/probe parsing, and invalid option rejection.
- Status: Complete.
- Tests: Test file.

#### backend/src/risk/RiskFlags.ts

- Purpose: Defines deterministic risk flag strings.
- Usage: Imported by risk rules, scoring, writer, and tests.
- Important parameters: Authority, liquidity, pair-age, quote, missing-pair, missing-liquidity, and missing-authority flags.
- Status: Complete.
- Tests: Covered indirectly by rule and scoring tests.

#### backend/src/risk/RiskCandidateSelector.ts

- Purpose: Selects eligible TokenRadar candidates for risk evaluation.
- Usage: Called by `RiskEvaluationService`.
- Important parameters: Never auto-creates sessions; uses explicit `PAPER` sessions or the latest `PAPER` + `RUNNING` session with eligible candidates; filters by status, recency, and limit.
- Status: Complete.
- Tests: Covered by `backend/src/risk/RiskCandidateSelector.test.ts`.

#### backend/src/risk/RiskCandidateSelector.test.ts

- Purpose: Tests risk candidate selection and no-auto-create session behavior.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies latest eligible running paper session, no eligible session failure, status filtering, and recency filtering.
- Status: Complete.
- Tests: Test file.

#### backend/src/risk/RiskEvidenceRefreshService.ts

- Purpose: Refreshes market, authority, and quote evidence before risk scoring.
- Usage: Called by `RiskEvaluationService`.
- Important parameters: Calls `MarketDataService.enrichToken()`, probes `0.01 SOL` buy quotes by default, probes sell quotes using buy quote output when available, and treats missing quotes as warnings.
- Status: Complete.
- Tests: Covered indirectly by risk runner tests.

#### backend/src/risk/rules/\*.ts

- Purpose: Implements deterministic authority, liquidity, pair-age, and price-impact rules.
- Usage: Called by `RiskScoringService`.
- Important parameters: Authority present fails; absent-or-unknown authority warns; liquidity below `$2,000` fails; liquidity `$2,000-$10,000` warns; pair age below 5 minutes fails; pair age 5-30 minutes warns; price impact above 15% fails; price impact 5-15% warns; missing quote warns.
- Status: Complete.
- Tests: Covered by `backend/src/risk/rules/RiskRules.test.ts`.

#### backend/src/risk/rules/RiskRules.test.ts

- Purpose: Tests deterministic Phase 5 risk rules.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies conservative authority handling, liquidity thresholds, pair-age thresholds, price-impact thresholds, and missing quote warning behavior.
- Status: Complete.
- Tests: Test file.

#### backend/src/risk/RiskScoringService.ts

- Purpose: Combines rule outputs into 0-100 scores and PASS/WARN/FAIL results.
- Usage: Called by `RiskEvaluationService`.
- Important parameters: Applies deductions, clamps scores to 0-100, maps score bands, and preserves rule severity so warning evidence cannot become a pass.
- Status: Complete.
- Tests: Covered by `backend/src/risk/RiskScoringService.test.ts`.

#### backend/src/risk/RiskScoringService.test.ts

- Purpose: Tests score calculation and result classification.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies unknown authority evidence produces WARN and severe deductions produce FAIL.
- Status: Complete.
- Tests: Test file.

#### backend/src/risk/RiskAssessmentWriter.ts

- Purpose: Writes RiskAssessment records and applies risk-safe TokenRadar status transitions.
- Usage: Called by `RiskEvaluationService`.
- Important parameters: Writes redacted evidence summaries, appends risk notes, maps FAIL to REJECTED, maps PASS/WARN to WATCHING, leaves UNKNOWN unchanged, and skips writes in dry-run mode.
- Status: Complete.
- Tests: Covered by risk runner tests.

#### backend/src/risk/RiskEvaluationService.ts

- Purpose: Orchestrates one risk evaluation batch.
- Usage: Called by `RiskRunner`.
- Important parameters: Selects candidates, refreshes evidence with bounded concurrency, scores risk, writes assessments, updates statuses, writes RISK logs, and returns a summary.
- Status: Complete.
- Tests: Covered by risk runner tests.

#### backend/src/risk/RiskRunner.ts

- Purpose: Provides the risk runner facade used by the CLI.
- Usage: Called by `backend/src/scripts/risk-evaluate.ts` and tests.
- Important parameters: Builds selector, refresh service, scoring, and writer for one-shot risk evaluation.
- Status: Complete.
- Tests: Covered by `backend/src/risk/RiskRunner.test.ts`.

#### backend/src/risk/RiskRunner.test.ts

- Purpose: Tests end-to-end risk runner behavior with a migrated test database.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies RiskAssessment writes, TokenRadar WATCHING update, note composition, dry-run skip behavior, and absence of strategy decisions, orders, fills, and positions.
- Status: Complete.
- Tests: Test file.

#### backend/src/scripts/risk-evaluate.ts

- Purpose: CLI entry point for Phase 5 risk evaluation.
- Usage: Run `pnpm risk:evaluate --once`, optionally with `--dry-run`, `--session-id`, `--status`, `--since-hours`, `--limit`, `--concurrency`, or `--probe-sol`.
- Important parameters: Enforces `PAPER` mode, runs migrations, builds repositories, provider health service, provider registry, `MarketDataService`, and `RiskRunner`, prints safety status, and closes the paper database.
- Status: Complete.
- Tests: Covered by typecheck, risk runner tests, and one-shot smoke validation when provider access is available.

## Phase 6 Strategy Engine

#### backend/src/strategy/StrategyConfig.ts

- Purpose: Defines Phase 6 strategy runtime defaults, bounds, CLI parsing, and status validation.
- Usage: Imported by the strategy CLI and tests.
- Important parameters: Defaults `status=WATCHING`, `riskPolicy=PASS_OR_ELIGIBLE_WARN`, `sinceHours=24`, `limit=50`, `maxBuyDecisions=5`, `minLiquidityUsd=10000`, `minVolume1hUsd=10000`, `maxPriceImpactPct=5`, `minPairAgeMinutes=30`, and `strategyName=phase6_first_pass`; supports all Phase 6 CLI options.
- Status: Complete.
- Tests: Covered by `backend/src/strategy/StrategyConfig.test.ts`.

#### backend/src/strategy/StrategyConfig.test.ts

- Purpose: Tests strategy defaults, CLI parsing, and runtime validation.
- Usage: Run through `pnpm test`.
- Important parameters: Covers supported command-line options, invalid status rejection, numeric bounds, empty strategy name rejection, and unknown option rejection.
- Status: Complete.
- Tests: Test file.

#### backend/src/strategy/StrategyCandidateSelector.ts

- Purpose: Selects eligible TokenRadar candidates for strategy evaluation.
- Usage: Called by `StrategyEvaluationService`.
- Important parameters: Never auto-creates sessions; requires explicit sessions to be `PAPER` + `RUNNING`; otherwise uses the latest `PAPER` + `RUNNING` session with eligible candidates; filters by status, recency, and limit; excludes candidates without latest RiskAssessment; loads existing decisions per mint.
- Status: Complete.
- Tests: Covered by `backend/src/strategy/StrategyCandidateSelector.test.ts`.

#### backend/src/strategy/StrategyCandidateSelector.test.ts

- Purpose: Tests strategy candidate selection and strict session policy.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies latest eligible running paper session, explicit `RUNNING` requirement, no auto-create behavior, WATCHING filtering, recency filtering, latest risk lookup, and missing risk exclusion.
- Status: Complete.
- Tests: Test file.

#### backend/src/strategy/rules/\*.ts

- Purpose: Implements deterministic Phase 6 strategy rules.
- Usage: Called by `StrategyScoringService`.
- Important parameters: Risk PASS gives +40, eligible WARN gives +20, ineligible risk blocks BUY, liquidity/volume/age/price-impact attractiveness points are applied, and duplicate BUY history is detected.
- Status: Complete.
- Tests: Covered by `backend/src/strategy/rules/StrategyRules.test.ts`.

#### backend/src/strategy/rules/StrategyRules.test.ts

- Purpose: Tests deterministic strategy rule modules.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies PASS and eligible WARN scoring, ineligible WARN/FAIL/UNKNOWN blocking, attractiveness thresholds, and duplicate BUY detection.
- Status: Complete.
- Tests: Test file.

#### backend/src/strategy/StrategyScoringService.ts

- Purpose: Combines strategy rules into a 0-100 score and final StrategyDecision.
- Usage: Called by `StrategyEvaluationService`.
- Important parameters: Reads risk flags, TokenRadar liquidity/volume/age, and compact risk rawProviderDataJson price-impact facts; applies BUY/WATCH/SKIP bands; downgrades BUY for ineligible risk, duplicate BUY, or max BUY cap.
- Status: Complete.
- Tests: Covered by `backend/src/strategy/StrategyScoringService.test.ts`.

#### backend/src/strategy/StrategyScoringService.test.ts

- Purpose: Tests score calculation and decision overrides.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies high-scoring BUY, eligible WARN WATCH, low-score SKIP, duplicate BUY downgrade, and max BUY cap downgrade.
- Status: Complete.
- Tests: Test file.

#### backend/src/strategy/StrategyEvaluationService.ts

- Purpose: Orchestrates one strategy evaluation batch.
- Usage: Called by `StrategyRunner`.
- Important parameters: Selects candidates, scores strategy, writes StrategyDecision rows, updates TokenRadar to APPROVED after stored BUY decisions, skips writes in dry-run mode, tracks duplicate/max-cap blocks, writes STRATEGY logs, and returns a summary.
- Status: Complete.
- Tests: Covered by strategy runner tests.

#### backend/src/strategy/StrategyRunner.ts

- Purpose: Provides the strategy runner facade used by the CLI.
- Usage: Called by `backend/src/scripts/strategy-evaluate.ts` and tests.
- Important parameters: Builds selector and evaluation service for one-shot strategy evaluation.
- Status: Complete.
- Tests: Covered by `backend/src/strategy/StrategyRunner.test.ts`.

#### backend/src/strategy/StrategyRunner.test.ts

- Purpose: Tests end-to-end strategy runner behavior with a migrated test database.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies BUY writes and APPROVED updates, WATCH/SKIP decisions, dry-run skip behavior, duplicate BUY protection, max BUY cap behavior, STRATEGY logs, and absence of orders, fills, positions, equity snapshots, and position snapshots.
- Status: Complete.
- Tests: Test file.

#### backend/src/scripts/strategy-evaluate.ts

- Purpose: CLI entry point for Phase 6 strategy evaluation.
- Usage: Run `pnpm strategy:evaluate --once`, optionally with `--dry-run`, `--session-id`, `--status`, `--since-hours`, `--limit`, `--max-buy-decisions`, `--strategy-name`, `--min-liquidity-usd`, `--min-volume-1h-usd`, `--max-price-impact-pct`, or `--min-pair-age-minutes`.
- Important parameters: Enforces `PAPER` mode, runs migrations, builds repositories and `StrategyRunner`, prints safety status, prints strategy summary, and closes the paper database.
- Status: Complete.
- Tests: Covered by typecheck, strategy runner tests, and one-shot smoke validation.

#### docs/architecture/strategy-engine.md

- Purpose: Documents Phase 6 strategy-engine architecture, command options, session policy, candidate selection, BUY eligibility, scoring, status transitions, duplicate BUY protection, dry-run behavior, and safety boundaries.
- Usage: Read before changing strategy evaluation or planning Phase 7 PaperExchange.
- Important parameters: Paper-only runtime, strict active-session policy, `PASS_OR_ELIGIBLE_WARN`, first-pass strategy score, TokenRadar APPROVED transition, application-level duplicate BUY protection, and no-execution boundary.
- Status: Complete.
- Tests: Manual documentation review.

## Phase 7 PaperExchange Buy Engine

#### backend/src/paper/PaperMath.ts

- Purpose: Provides Phase 7 decimal and lamport math helpers.
- Usage: Imported by PaperExchange config and fill construction.
- Important parameters: Parses SOL amounts into integer lamports, formats lamports as SOL strings, calculates slippage lamports, validates positive decimal prices, and calculates decimal token amounts without floating-point lamport accounting.
- Status: Complete.
- Tests: Covered indirectly by paper config and runner tests.

#### backend/src/paper/PaperExchangeConfig.ts

- Purpose: Defines Phase 7 paper execution defaults, bounds, CLI parsing, and runtime config validation.
- Usage: Imported by the paper execution CLI and tests.
- Important parameters: Defaults `buySolLamports=10000000`, `limit=10`, `baseFeeLamports=5000`, `priorityFeeLamports=0`, `slippageBps=100`, and `quoteSource=TOKEN_RADAR_PRICE`; supports `--once`, `--dry-run`, `--session-id`, `--buy-sol`, and `--limit`.
- Status: Complete.
- Tests: Covered by `backend/src/paper/PaperExchangeConfig.test.ts`.

#### backend/src/paper/PaperExchangeConfig.test.ts

- Purpose: Tests paper exchange defaults, CLI parsing, and runtime validation.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies default buy size and fees, supported CLI flags, invalid option rejection, and slippage bounds.
- Status: Complete.
- Tests: Test file.

#### backend/src/paper/PaperExecutionCandidateSelector.ts

- Purpose: Selects Phase 7 paper execution candidates from active sessions.
- Usage: Used by `PaperExecutionService`.
- Important parameters: Requires explicit sessions to be `PAPER` + `RUNNING`; when no session is supplied, finds the latest active paper session with `StrategyDecision(BUY)` plus matching `TokenRadar(APPROVED)` rows; loads latest risk assessment when available.
- Status: Complete.
- Tests: Covered by `backend/src/paper/PaperRunner.test.ts`.

#### backend/src/paper/PaperOrderFactory.ts

- Purpose: Builds paper BUY order input and order context.
- Usage: Used by `PaperExecutionService` before quote, fill, position, and cash writes.
- Important parameters: Creates `Order(CREATED)` with `mode=PAPER`, `side=BUY`, `requestedSolLamports`, `strategyDecisionId`, rejection or execution reason, and redacted raw context JSON.
- Status: Complete.
- Tests: Covered by `backend/src/paper/PaperRunner.test.ts`.

#### backend/src/paper/PaperFillFactory.ts

- Purpose: Builds simulated paper quote context and BUY fill input.
- Usage: Used by `PaperExecutionService` after candidate validation.
- Important parameters: Uses `TokenRadar.priceSol`, optional `priceUsd`, default fees, slippage bps, latest risk price-impact evidence when available, fallback `priceImpactBps=0`, integer lamport costs, and decimal string token amounts.
- Status: Complete.
- Tests: Covered by `backend/src/paper/PaperRunner.test.ts`.

#### backend/src/paper/PaperPositionFactory.ts

- Purpose: Builds open position input after a simulated BUY fill.
- Usage: Used by `PaperExecutionService`.
- Important parameters: Creates `Position(OPEN)` with average entry price, tokens held, cost basis, and fees paid from the simulated fill context.
- Status: Complete.
- Tests: Covered by `backend/src/paper/PaperRunner.test.ts`.

#### backend/src/paper/PaperExecutionService.ts

- Purpose: Coordinates Phase 7 paper BUY execution.
- Usage: Called by `PaperRunner`.
- Important parameters: Selects candidates, validates price, duplicate open positions, and cash, creates rejected orders for expected rejections, creates order/fill/position records on success, decrements `Session.currentCashLamports`, updates TokenRadar to `BOUGHT` last, writes `EXECUTION` logs, and honors dry-run write skipping.
- Status: Complete.
- Tests: Covered by `backend/src/paper/PaperRunner.test.ts`.

#### backend/src/paper/PaperRunner.ts

- Purpose: Provides the paper execution runner facade used by the CLI.
- Usage: Called by `backend/src/scripts/paper-execute.ts` and tests.
- Important parameters: Builds selector and execution service for one-shot paper execution.
- Status: Complete.
- Tests: Covered by `backend/src/paper/PaperRunner.test.ts`.

#### backend/src/paper/PaperRunner.test.ts

- Purpose: Tests end-to-end paper execution behavior with a migrated test database.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies successful order/fill/position/cash/BOUGHT flow, dry-run skip behavior, missing-price rejection, insufficient-cash rejection, duplicate-open-position rejection, strict explicit session policy, `EXECUTION` logs, and absence of SELL/closed-position/snapshot side effects.
- Status: Complete.
- Tests: Test file.

#### backend/src/scripts/paper-execute.ts

- Purpose: CLI entry point for Phase 7 paper execution.
- Usage: Run `pnpm paper:execute --once`, optionally with `--dry-run`, `--session-id`, `--buy-sol`, or `--limit`.
- Important parameters: Enforces `PAPER` mode, runs migrations, builds repositories and `PaperRunner`, prints safety status, prints paper execution summary, and closes the paper database.
- Status: Complete.
- Tests: Covered by typecheck, paper runner tests, and dry-run smoke validation.

#### docs/architecture/paper-exchange.md

- Purpose: Documents Phase 7 PaperExchange architecture, command options, session policy, candidate selection, simulated quote behavior, order lifecycle, cash updates, dry-run behavior, and safety boundaries.
- Usage: Read before changing paper execution or planning Phase 7.5 SELL/P&L work.
- Important parameters: Paper-only runtime, strict active-session policy, `BUY` + `APPROVED` selection, 0.01 SOL default buy size, integer lamport accounting, expected rejection reasons, TokenRadar `BOUGHT` final transition, and no-wallet/no-signing/no-submission boundary.
- Status: Complete.
- Tests: Manual documentation review.

## Phase 7.5 PaperExchange SELL Engine

#### backend/src/paper/PaperSellConfig.ts

- Purpose: Defines Phase 7.5 paper SELL runtime defaults, bounds, trigger validation, and CLI parsing.
- Usage: Imported by the paper SELL CLI and tests.
- Important parameters: Requires `--sell-all` or `--mint`; defaults `limit=10`, `baseFeeLamports=5000`, `priorityFeeLamports=0`, `slippageBps=100`, `allowCachedRadarPrice=false`, `maxCachedPriceAgeMs=60000`, and `quoteSource=MarketDataService`.
- Status: Complete.
- Tests: Covered by `backend/src/paper/PaperSellConfig.test.ts`.

#### backend/src/paper/PaperSellConfig.test.ts

- Purpose: Tests paper SELL config parsing and validation.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies missing-trigger rejection, sell-all parsing, mint parsing, conflicting trigger rejection, numeric bounds, and unknown option rejection.
- Status: Complete.
- Tests: Test file.

#### backend/src/paper/PaperSellCandidateSelector.ts

- Purpose: Selects Phase 7.5 SELL candidates from open paper positions.
- Usage: Used by `PaperSellExecutionService`.
- Important parameters: Requires explicit sessions to be `PAPER` + `RUNNING`; when no session is supplied, finds the latest active paper session with matching open positions; supports `SELL_ALL` and mint-scoped selection; rejects ambiguous mint selections.
- Status: Complete.
- Tests: Covered by `backend/src/paper/PaperSellRunner.test.ts`.

#### backend/src/paper/PaperSellValidationService.ts

- Purpose: Validates paper SELL sessions and positions.
- Usage: Used by `PaperSellExecutionService`.
- Important parameters: Rejects non-paper sessions, non-running sessions, non-open positions, invalid token size, and invalid cost basis with structured rejection codes.
- Status: Complete.
- Tests: Covered by `backend/src/paper/PaperSellRunner.test.ts`.

#### backend/src/paper/PaperSellQuoteService.ts

- Purpose: Resolves Phase 7.5 SELL quote or price evidence.
- Usage: Used by `PaperSellExecutionService`.
- Important parameters: Attempts exact sell quotes through `MarketDataService`, falls back to refreshed provider price, uses cached TokenRadar price only when explicitly enabled and fresh, stores fallback reason and warnings, and rejects missing/stale prices.
- Status: Complete.
- Tests: Covered by `backend/src/paper/PaperSellRunner.test.ts`.

#### backend/src/paper/PaperSellAccountingService.ts

- Purpose: Calculates SELL proceeds, slippage, fees, and realized P/L.
- Usage: Used by `PaperSellExecutionService`.
- Important parameters: Computes gross proceeds, net sell proceeds, sell fees, sell slippage, realized P/L, realized P/L bps, and total position fees.
- Status: Complete.
- Tests: Covered by `backend/src/paper/PaperSellRunner.test.ts`.

#### backend/src/paper/PaperSellOrderFactory.ts

- Purpose: Builds migration-free SELL order payloads and quote order context.
- Usage: Used by `PaperSellExecutionService`.
- Important parameters: Stores `side=SELL`, `requestedTokenAmount`, `positionId`, trigger context, selection context, position context, price policy, rejection details, and quote/accounting context in existing order fields.
- Status: Complete.
- Tests: Covered by `backend/src/paper/PaperSellRunner.test.ts`.

#### backend/src/paper/PaperSellFillFactory.ts

- Purpose: Builds migration-free SELL fill payloads.
- Usage: Used by `PaperSellExecutionService`.
- Important parameters: Stores token quantity, net sell proceeds in `solReceivedLamports`, fees, slippage, price impact, quote source, mint, side, gross proceeds, fallback details, and accounting context.
- Status: Complete.
- Tests: Covered by `backend/src/paper/PaperSellRunner.test.ts`.

#### backend/src/paper/PaperSellExecutionService.ts

- Purpose: Coordinates Phase 7.5 paper SELL execution.
- Usage: Called by `PaperSellRunner`.
- Important parameters: Selects candidates, validates sessions and positions, resolves quote/price evidence, calculates P/L, writes rejected orders for business rejections, creates SELL orders and fills, closes positions, updates session cash/P&L, moves TokenRadar to `WATCHING`, writes `EXECUTION` logs, and honors dry-run write skipping.
- Status: Complete.
- Tests: Covered by `backend/src/paper/PaperSellRunner.test.ts`.

#### backend/src/paper/PaperSellRunner.ts

- Purpose: Provides the paper SELL runner facade used by the CLI.
- Usage: Called by `backend/src/scripts/paper-sell.ts` and tests.
- Important parameters: Builds selector, quote service, and execution service for one-shot paper SELL execution.
- Status: Complete.
- Tests: Covered by `backend/src/paper/PaperSellRunner.test.ts`.

#### backend/src/paper/PaperSellRunner.test.ts

- Purpose: Tests end-to-end paper SELL behavior with a migrated test database.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies successful SELL close, dry-run skip behavior, missing-price rejection, cached fallback disabled behavior, stale cached fallback rejection, fresh cached fallback when explicitly enabled, mint-scoped selection, repeated-run idempotency, `EXECUTION` logs, and absence of snapshots.
- Status: Complete.
- Tests: Test file.

#### backend/src/scripts/paper-sell.ts

- Purpose: CLI entry point for Phase 7.5 paper SELL execution.
- Usage: Run `pnpm paper:sell --once --sell-all` or `pnpm paper:sell --once --mint=<mint>`, optionally with `--dry-run`, `--session-id`, `--limit`, `--slippage-bps`, fee overrides, or cached price fallback flags.
- Important parameters: Enforces `PAPER` mode, runs migrations, builds repositories, provider registry, market data service, and `PaperSellRunner`, prints safety status, prints SELL summary, and closes the paper database.
- Status: Complete.
- Tests: Covered by typecheck, paper SELL runner tests, and command validation.

#### docs/architecture/paper-sell-engine.md

- Purpose: Documents Phase 7.5 paper SELL architecture, command options, session policy, quote fallback, existing-schema storage, accounting model, dry-run behavior, safety boundaries, and known limitations.
- Usage: Read before changing paper SELL execution or planning Phase 8 SessionManager.
- Important parameters: Explicit trigger policy, no-migration first pass, quote/refreshed-price/cached-price hierarchy, realized P/L formula, TokenRadar `WATCHING` transition, snapshot deferral, and ordered-write limitation.
- Status: Complete.
- Tests: Manual documentation review.

## Phase 8 SessionManager

#### backend/src/session/SessionManagerConfig.ts

- Purpose: Defines Phase 8 SessionManager runtime defaults, bounds, CLI parsing, and validation.
- Usage: Imported by the SessionManager CLI and tests.
- Important parameters: Requires `--once`; supports `--dry-run`, `--session-id`, `--target-sol`, `--target-pct`, `--max-drawdown-sol`, and `--max-drawdown-pct`; defaults cached radar, entry price, and cost-basis valuation fallbacks on.
- Status: Complete.
- Tests: Covered by `backend/src/session/SessionManagerConfig.test.ts`.

#### backend/src/session/SessionManagerConfig.test.ts

- Purpose: Tests SessionManager config parsing and validation.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies required `--once`, supported options, invalid numeric rejection, unknown flag rejection, and runtime bounds.
- Status: Complete.
- Tests: Test file.

#### backend/src/session/SessionCandidateSelector.ts

- Purpose: Selects the SessionManager session.
- Usage: Used by `SessionManagerService`.
- Important parameters: Requires explicit sessions to exist and be `PAPER` + `RUNNING`; otherwise selects the latest running paper session; never auto-creates sessions.
- Status: Complete.
- Tests: Covered by `backend/src/session/SessionManagerRunner.test.ts`.

#### backend/src/session/PositionValuationService.ts

- Purpose: Values open positions for Phase 8 snapshots.
- Usage: Used by `SessionManagerService`.
- Important parameters: Attempts exact sell quote, refreshed provider price, cached TokenRadar price, position entry price, and cost-basis fallback; records valuation source, warnings, fallback reason, market value, and price context.
- Status: Complete.
- Tests: Covered by `backend/src/session/SessionManagerRunner.test.ts`.

#### backend/src/session/EquityCalculationService.ts

- Purpose: Calculates per-position and session-level equity facts.
- Usage: Used by `SessionManagerService`.
- Important parameters: Computes open position value, total equity, realized P/L, unrealized P/L, and per-position unrealized P/L bps using integer lamports.
- Status: Complete.
- Tests: Covered by `backend/src/session/SessionManagerRunner.test.ts`.

#### backend/src/session/TargetTrackingService.ts

- Purpose: Evaluates Phase 8 target-profit progress.
- Usage: Used by `SessionManagerService`.
- Important parameters: Supports runtime target SOL, runtime target percent, session target lamports, and session target bps with runtime overrides taking precedence.
- Status: Complete.
- Tests: Covered by `backend/src/session/SessionManagerRunner.test.ts`.

#### backend/src/session/DrawdownTrackingService.ts

- Purpose: Evaluates Phase 8 drawdown progress.
- Usage: Used by `SessionManagerService`.
- Important parameters: Computes peak equity from starting balance, prior peak snapshot, and current equity; supports runtime drawdown SOL, runtime drawdown percent, and session drawdown lamports.
- Status: Complete.
- Tests: Covered by `backend/src/session/SessionManagerRunner.test.ts`.

#### backend/src/session/SnapshotService.ts

- Purpose: Persists Phase 8 equity and position snapshots.
- Usage: Used by `SessionManagerService`.
- Important parameters: Creates one `EquitySnapshot` per non-dry-run cycle and one `PositionSnapshot` per open position; stores market value in `sellQuoteLamports` and valuation context in `rawQuoteJson`.
- Status: Complete.
- Tests: Covered by `backend/src/session/SessionManagerRunner.test.ts`.

#### backend/src/session/SessionManagerService.ts

- Purpose: Coordinates Phase 8 SessionManager execution.
- Usage: Called by `SessionManagerRunner`.
- Important parameters: Selects session, values open positions, calculates equity, evaluates target/drawdown gates, creates snapshots, updates `Session.unrealizedPnlLamports`, sets `Session.terminationReason`, writes `SESSION` logs, and honors dry-run write skipping.
- Status: Complete.
- Tests: Covered by `backend/src/session/SessionManagerRunner.test.ts`.

#### backend/src/session/SessionManagerRunner.ts

- Purpose: Provides the SessionManager runner facade used by the CLI.
- Usage: Called by `backend/src/scripts/session-manage.ts` and tests.
- Important parameters: Builds selector, valuation service, and SessionManager service for one-shot session management.
- Status: Complete.
- Tests: Covered by `backend/src/session/SessionManagerRunner.test.ts`.

#### backend/src/session/SessionManagerRunner.test.ts

- Purpose: Tests end-to-end SessionManager behavior with a migrated test database.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies snapshot creation, dry-run skip behavior, target gating, drawdown gating, existing gate preservation, fallback valuation, SESSION logs, and no order/fill/position-close side effects.
- Status: Complete.
- Tests: Test file.

#### backend/src/scripts/session-manage.ts

- Purpose: CLI entry point for Phase 8 SessionManager.
- Usage: Run `pnpm session:manage --once`, optionally with `--dry-run`, `--session-id`, target overrides, or drawdown overrides.
- Important parameters: Enforces `PAPER` mode, runs migrations, builds repositories, provider registry, market data service, and `SessionManagerRunner`, prints safety status, prints SessionManager summary, and closes the paper database.
- Status: Complete.
- Tests: Covered by typecheck, SessionManager runner tests, and command validation.

#### docs/architecture/session-manager.md

- Purpose: Documents Phase 8 SessionManager architecture, command options, session policy, valuation fallback, snapshot mapping, BUY gating, dry-run behavior, and safety boundaries.
- Usage: Read before changing SessionManager behavior or planning Phase 8.5 exits.
- Important parameters: Paper-only runtime, no auto-created sessions, no DB migration, `terminationReason` BUY gating, valuation fallback hierarchy, existing-schema snapshot mapping, no automatic SELL boundary, and Phase 8.5 handoff.
- Status: Complete.
- Tests: Manual documentation review.

## Phase 8.5 ExitManager

#### backend/src/exits/ExitManagerConfig.ts

- Purpose: Defines Phase 8.5 ExitManager runtime defaults, bounds, CLI parsing, validation, and PaperSell config mapping.
- Usage: Imported by the ExitManager CLI, runner tests, and config tests.
- Important parameters: Requires `--once`; supports `--dry-run`, `--session-id`, `--target-action`, `--drawdown-action`, `--complete-session-on-exit`, PaperSell fee/slippage/limit options, cached price fallback, and optional `exitContext`.
- Status: Complete.
- Tests: Covered by `backend/src/exits/ExitManagerConfig.test.ts`.

#### backend/src/exits/ExitManagerConfig.test.ts

- Purpose: Tests ExitManager config parsing and validation.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies observe defaults, sell-all action parsing, completion validation, numeric bounds, and unknown option rejection.
- Status: Complete.
- Tests: Test file.

#### backend/src/exits/ExitCandidateSelector.ts

- Purpose: Selects gated running paper sessions for automated exits.
- Usage: Used by `ExitManagerService`.
- Important parameters: Requires explicit sessions to exist and be `PAPER` + `RUNNING` + gated; implicit selection prefers supported gated sessions with open positions.
- Status: Complete.
- Tests: Covered by `backend/src/exits/ExitManagerRunner.test.ts`.

#### backend/src/exits/ExitTriggerService.ts

- Purpose: Resolves supported Phase 8.5 exit triggers from session termination reasons.
- Usage: Used by `ExitManagerService`.
- Important parameters: Supports `TARGET_REACHED` and `MAX_DRAWDOWN`; treats `NOT_TERMINATED` and unsupported reasons as no supported trigger.
- Status: Complete.
- Tests: Covered by `backend/src/exits/ExitManagerRunner.test.ts`.

#### backend/src/exits/ExitActionService.ts

- Purpose: Maps supported triggers plus runtime config to observe-only or sell-all actions.
- Usage: Used by `ExitManagerService`.
- Important parameters: `TARGET_REACHED` uses `targetAction`; `MAX_DRAWDOWN` uses `drawdownAction`; observe is the default.
- Status: Complete.
- Tests: Covered by `backend/src/exits/ExitManagerRunner.test.ts`.

#### backend/src/exits/ExitCompletionService.ts

- Purpose: Optionally completes a gated paper session after successful automated sell-all.
- Usage: Used by `ExitManagerService`.
- Important parameters: Completion is skipped in dry-run, disabled by default, requires sell-all action, blocks on rejections/failures, and requires no open positions remaining.
- Status: Complete.
- Tests: Covered by `backend/src/exits/ExitManagerRunner.test.ts`.

#### backend/src/exits/ExitManagerService.ts

- Purpose: Coordinates Phase 8.5 ExitManager execution.
- Usage: Called by `ExitManagerRunner`.
- Important parameters: Selects a gated session, evaluates trigger/action, reuses `PaperSellExecutionService` for sell-all, suppresses DB logs during dry-run, optionally completes the session, writes `EXECUTION` logs, and returns a CLI summary.
- Status: Complete.
- Tests: Covered by `backend/src/exits/ExitManagerRunner.test.ts`.

#### backend/src/exits/ExitManagerRunner.ts

- Purpose: Provides the ExitManager runner facade used by the CLI.
- Usage: Called by `backend/src/scripts/exits-manage.ts` and tests.
- Important parameters: Builds the ExitManager service for one-shot automated exit management.
- Status: Complete.
- Tests: Covered by `backend/src/exits/ExitManagerRunner.test.ts`.

#### backend/src/exits/ExitManagerRunner.test.ts

- Purpose: Tests end-to-end ExitManager behavior with a migrated test database.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies observe-only default, target sell-all, drawdown sell-all, dry-run no-write behavior, optional completion, completion blocking on SELL rejection, no-open-position completion, implicit selection, explicit session rejection, and safety boundaries.
- Status: Complete.
- Tests: Test file.

#### backend/src/scripts/exits-manage.ts

- Purpose: CLI entry point for Phase 8.5 ExitManager.
- Usage: Run `pnpm exits:manage --once`, optionally with `--dry-run`, `--session-id`, `--target-action=sell-all`, `--drawdown-action=sell-all`, `--complete-session-on-exit=true`, or PaperSell fee/slippage/fallback options.
- Important parameters: Enforces `PAPER` mode, runs migrations, builds repositories, provider registry, market data service, and `ExitManagerRunner`, prints safety status, prints ExitManager summary, and closes the paper database.
- Status: Complete.
- Tests: Covered by typecheck, ExitManager runner tests, and command validation.

#### docs/architecture/exit-manager.md

- Purpose: Documents Phase 8.5 ExitManager architecture, command options, session policy, PaperSell reuse, optional completion, dry-run behavior, logging, safety boundaries, and known limitations.
- Usage: Read before changing automated exit behavior or planning position-level exit phases.
- Important parameters: Paper-only runtime, observe-only default, explicit sell-all actions, direct PaperSell reuse, `EXECUTION` log scope with `PHASE_8_5_EXIT_MANAGER`, no DB migration, and no stop-loss/trailing/live-execution boundary.
- Status: Complete.
- Tests: Manual documentation review.

## Phase 8.7 Analytics And Forward Returns

#### backend/drizzle/0001_gifted_killmonger.sql

- Purpose: Adds the watchlist forward-return observation table.
- Usage: Applied through normal paper database migrations.
- Important parameters: Creates `watchlist_return_observations`, indexes due time/status/session/mint/decision/horizon, and prevents duplicate `(strategy_decision_id, horizon_minutes)` rows.
- Status: Complete.
- Tests: Covered by migration, connection tests, repository tests, analytics tests, and watchlist tests.

#### backend/src/db/schema/watchlistReturnObservations.ts

- Purpose: Defines the Drizzle schema for persisted watchlist forward-return observations.
- Usage: Imported by the database schema barrel and repository layer.
- Important parameters: Stores baseline price, observed price, liquidity/volume evidence, return percentages, status, error fields, and raw observation context.
- Status: Complete.
- Tests: Covered by migration and repository tests.

#### backend/src/db/repositories/WatchlistReturnObservationRepository.ts

- Purpose: Provides persistence methods for watchlist return observations.
- Usage: Used by `WatchlistReturnRunner` and analytics reporting.
- Important parameters: Create/upsert/get/list/list-due methods plus OBSERVED/FAILED/MISSED transitions.
- Status: Complete.
- Tests: Covered by `backend/src/db/repositories/repositories.test.ts`.

#### backend/src/watchlist/WatchlistReturnConfig.ts

- Purpose: Defines watchlist forward-return defaults, bounds, CLI parsing, and validation.
- Usage: Imported by the watchlist returns CLI.
- Important parameters: Defaults horizons to `3,5,15,30,60,120,240,360,480,720`, source decisions to `WATCH,SKIP,BUY`, `minScore=50`, and `maxLateMinutes=120`.
- Status: Complete.
- Tests: Covered by watchlist runner tests and typecheck.

#### backend/src/watchlist/WatchlistReturnRunner.ts

- Purpose: Schedules and observes watchlist forward-return rows.
- Usage: Called by `backend/src/scripts/watchlist-returns.ts`.
- Important parameters: Selects paper sessions with StrategyDecision rows, schedules one observation per horizon without duplicates, refreshes due observations through `MarketDataService`, calculates SOL/USD return percentages, and supports dry-run without writes.
- Status: Complete.
- Tests: Covered by `backend/src/watchlist/WatchlistReturnRunner.test.ts`.

#### backend/src/watchlist/WatchlistReturnFormatter.ts

- Purpose: Formats watchlist return summaries for text or JSON output.
- Usage: Called by the watchlist returns CLI.
- Important parameters: Reports selected decisions, scheduled rows, already scheduled rows, due rows, observed rows, missed rows, failed rows, and dry-run state.
- Status: Complete.
- Tests: Covered by typecheck and command tests.

#### backend/src/scripts/watchlist-returns.ts

- Purpose: CLI entry point for Phase 8.7 watchlist forward-return tracking.
- Usage: Run `pnpm watchlist:returns --once`, optionally with `--dry-run`, `--json`, `--session-id`, `--since-hours`, `--limit`, `--horizons`, `--source-decisions`, `--min-score`, or `--max-late-minutes`.
- Important parameters: Enforces `PAPER` mode, runs migrations, builds repositories, provider health service, provider registry, market data service, and `WatchlistReturnRunner`, then prints summary output.
- Status: Complete.
- Tests: Covered by typecheck and watchlist runner tests.

#### backend/src/analytics/AnalyticsConfig.ts

- Purpose: Defines analytics report defaults, bounds, CLI parsing, and validation.
- Usage: Imported by the analytics report CLI.
- Important parameters: Defaults `sinceHours=24`, `limit=250`, `scoreBucketSize=5`, `nearMissMinScore=50`, `providerSinceHours=24`, and `missedOpportunityLimit=20`.
- Status: Complete.
- Tests: Covered by analytics report tests and typecheck.

#### backend/src/analytics/AnalyticsReportService.ts

- Purpose: Builds a read-only paper analytics report.
- Usage: Called by `backend/src/scripts/analytics-report.ts`.
- Important parameters: Reports funnel counts, score buckets, near misses, missed opportunities from observed forward returns, provider health summaries, and Jupiter rate-limit counts without database writes.
- Status: Complete.
- Tests: Covered by `backend/src/analytics/AnalyticsReportService.test.ts`.

#### backend/src/analytics/AnalyticsReportFormatter.ts

- Purpose: Formats analytics reports for text or JSON output.
- Usage: Called by the analytics report CLI.
- Important parameters: Includes Session, Funnel, Score Buckets, Near Misses, Missed Opportunities, Provider Health, Jupiter Rate Limit Summary, and Recommended Next Run sections.
- Status: Complete.
- Tests: Covered by typecheck and analytics report tests.

#### backend/src/scripts/analytics-report.ts

- Purpose: CLI entry point for Phase 8.7 analytics reporting.
- Usage: Run `pnpm analytics:report --once`, optionally with `--json`, `--session-id`, `--since-hours`, `--limit`, `--score-bucket-size`, `--near-miss-min-score`, `--provider-since-hours`, or `--missed-opportunity-limit`.
- Important parameters: Enforces `PAPER` mode, runs migrations, builds repositories, generates a read-only report, and prints text or JSON output.
- Status: Complete.
- Tests: Covered by typecheck and analytics report tests.

#### backend/src/analytics/AnalyticsReportService.test.ts

- Purpose: Tests analytics report generation.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies funnel counts, score buckets, near misses, missed opportunities, provider health, Jupiter rate-limit summary, and read-only behavior.
- Status: Complete.
- Tests: Test file.

#### backend/src/watchlist/WatchlistReturnRunner.test.ts

- Purpose: Tests watchlist forward-return scheduling and observation.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies scheduling, due observation, return calculation, dry-run no-write behavior, and missing-baseline failure handling.
- Status: Complete.
- Tests: Test file.

## Phase 8.9 Shadow Entry And Exit Simulation

#### backend/src/shadow/ShadowConfig.ts

- Purpose: Defines Phase 8.9 shadow runtime defaults, CLI parsing, validation, and decision-source expansion.
- Usage: Imported by shadow CLI entrypoints, services, and tests.
- Important parameters: Defaults to BUY-only source decisions, optional `--include-shadow-scores`, `shadowScoreMin=55`, 1-minute style horizons, target/stop scenarios, simulated portfolio balance, and JSON/dry-run flags.
- Status: Complete.
- Tests: Covered by `backend/src/shadow/ShadowConfig.test.ts`.

#### backend/src/shadow/ShadowTypes.ts

- Purpose: Defines typed DTOs for shadow candidates, observed returns, exit outcomes, scenario summaries, portfolio trades, and reports.
- Usage: Shared across Phase 8.9 shadow services and formatters.
- Important parameters: Distinguishes observed returns from simulated exits and simulated portfolio P/L.
- Status: Complete.
- Tests: Covered by typecheck and shadow service tests.

#### backend/src/shadow/ShadowCandidateSelector.ts

- Purpose: Selects strategy decisions for shadow observation and exit simulation.
- Usage: Used by `ShadowExitReportService` and tests.
- Important parameters: Requires explicit sessions to be `PAPER` + `RUNNING`; otherwise selects the latest running paper session with strategy decisions; defaults to BUY decisions and can include score-qualified WATCH/SKIP candidates.
- Status: Complete.
- Tests: Covered by `backend/src/shadow/ShadowServices.test.ts`.

#### backend/src/shadow/ShadowObservationRunner.ts

- Purpose: Adapts Phase 8.9 shadow observation settings onto the existing watchlist return runner.
- Usage: Called by `backend/src/scripts/shadow-observe.ts`.
- Important parameters: Reuses `watchlist_return_observations`, supports high-frequency horizons, and expands source decisions only when shadow-score research is explicitly enabled.
- Status: Complete.
- Tests: Covered by `backend/src/shadow/ShadowServices.test.ts`.

#### backend/src/shadow/ShadowExitSimulator.ts

- Purpose: Simulates target, stop, max-hold, no-observation, and ambiguous exits from observed return rows.
- Usage: Used by `ShadowExitReportService`.
- Important parameters: Evaluates target/stop/max-hold scenario grids and reports first target/stop horizons plus best and worst observed returns.
- Status: Complete.
- Tests: Covered by `backend/src/shadow/ShadowServices.test.ts`.

#### backend/src/shadow/ShadowPortfolioSimulator.ts

- Purpose: Simulates run-level SOL balance outcomes from shadow exit results.
- Usage: Used by `ShadowExitReportService`.
- Important parameters: Applies configured starting balance, position size, session goal, max positions, and first scenario target/stop/max-hold settings without writing orders, fills, or positions.
- Status: Complete.
- Tests: Covered by `backend/src/shadow/ShadowServices.test.ts`.

#### backend/src/shadow/ShadowExitReportService.ts

- Purpose: Coordinates Phase 8.9 shadow exit reporting.
- Usage: Called by `backend/src/scripts/shadow-exits.ts`.
- Important parameters: Selects candidates, loads observed returns, simulates exits, simulates portfolio outcomes, and emits recommendations without database writes.
- Status: Complete.
- Tests: Covered by `backend/src/shadow/ShadowServices.test.ts`.

#### backend/src/shadow/ShadowReportFormatter.ts

- Purpose: Formats Phase 8.9 shadow exit reports for terminal text or JSON output.
- Usage: Called by `backend/src/scripts/shadow-exits.ts`.
- Important parameters: Includes session summary, candidate selection, scenario summaries, per-candidate outcomes, portfolio summary, and recommendations.
- Status: Complete.
- Tests: Covered by typecheck and shadow service tests.

#### backend/src/shadow/ShadowConfig.test.ts

- Purpose: Tests Phase 8.9 shadow config parsing and validation.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies defaults, list parsing, source decision expansion, invalid percentages, invalid decisions, and invalid balances.
- Status: Complete.
- Tests: Test file.

#### backend/src/shadow/ShadowServices.test.ts

- Purpose: Tests Phase 8.9 shadow selection, observation mapping, simulation, portfolio math, and safety boundaries.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies BUY-only selection, shadow-score inclusion, target-before-stop behavior, stop-before-target behavior, simulated portfolio results, and no order/fill/position writes.
- Status: Complete.
- Tests: Test file.

#### backend/src/scripts/shadow-observe.ts

- Purpose: CLI entry point for high-frequency shadow observation.
- Usage: Run `pnpm shadow:observe --once`, optionally with `--include-shadow-scores`, `--shadow-score-min`, `--horizons`, `--session-id`, `--json`, or `--dry-run`.
- Important parameters: Enforces `PAPER` mode, runs migrations, builds repositories and providers, reuses the watchlist observation runner, and prints wallet/signing/submission disabled status.
- Status: Complete.
- Tests: Covered by typecheck and shadow service tests.

#### backend/src/scripts/shadow-exits.ts

- Purpose: CLI entry point for shadow target/stop/max-hold exit simulation.
- Usage: Run `pnpm shadow:exits --once`, optionally with target, stop, max-hold, portfolio, session, shadow-score, JSON, or dry-run flags.
- Important parameters: Enforces `PAPER` mode, runs migrations, builds repositories, generates read-only shadow exit reports, and prints wallet/signing/submission disabled status.
- Status: Complete.
- Tests: Covered by typecheck and shadow service tests.

#### docs/NeXusTrade-Phase-8.9-Detailed-Checklist.md

- Purpose: Records Phase 8.9 implementation scope, safety boundary, runtime defaults, acceptance tests, and completion notes.
- Usage: Read before changing shadow observation or shadow exit simulation.
- Important parameters: Documents no-migration first pass, high-frequency observation rationale, simulated target/stop exits, simulated portfolio results, and Phase 9 handoff.
- Status: Complete.
- Tests: Manual documentation review.

#### docs/NeXusTrade-Phase-8.91-Detailed-Checklist.md

- Purpose: Documents cross-run Phase 8.9 calibration, unique-mint analysis, entry confirmation research, scenario portfolio grids, implementation notes, and next-batch test recommendations.
- Usage: Read before changing Phase 8.91 shadow calibration behavior or planning Phase 8.92 entry changes.
- Important parameters: Keeps Phase 8.91 paper-only and read-only; compares archived Phase 8.9 runs; evaluates decision-level versus unique-mint outcomes; simulates delayed entry confirmation; preserves no wallet/signing/submission/order/fill/position boundary; reserves behavior changes for Phase 8.92.
- Status: Complete.
- Tests: Manual documentation review.

#### docs/NeXusTrade-Phase-8.92-Detailed-Checklist.md

- Purpose: Documents Phase 8.92 calibrated shadow entry gates after final Phase 8.91 test analysis.
- Usage: Read before changing `shadow:entries` or Phase 9 execution readiness criteria.
- Important parameters: Keeps Phase 8.92 paper-only and read-only; documents Phase 8.91 final evidence; defines composable candidate profiles, confirmation horizons, early-drawdown modes, recovery-after-drawdown rules, first-entry versus latest-entry timing, target/stop/max-hold grids, simulated portfolio outputs, promotion bars, and the no-paper-execution safety boundary.
- Status: Complete.
- Tests: Manual documentation review.

#### docs/NeXusTrade-Phase-8.92B-Detailed-Checklist.md

- Purpose: Documents implemented Phase 8.92B shadow entry-gate report refinement after four fresh Phase 8.92 validation runs.
- Usage: Read before changing baseline reproduction semantics, normalized profile summaries, profile readiness criteria, or adding P007-P011 research profiles.
- Important parameters: Keeps Phase 8.92B paper-only and read-only; documents fresh Phase 8.92 evidence; fixes fresh-run P001 wording; separates normalized summaries from experimental diagnostics; adds WATCH-first, duplicate-attention, score 65-79, high-score, and hybrid research profiles; makes repeated attention strength-based; adds profile versioning, confidence, signal stability, and market-window concentration; preserves no-paper-execution boundaries.
- Status: Complete.
- Tests: Manual documentation review.

#### docs/NeXusTrade-Phase-8.93-Detailed-Checklist.md

- Purpose: Documents the completed Phase 8.93 Strategy Promotion review and no-promotion decision after the fresh Phase 8.92B validation batch.
- Usage: Read before changing strategy defaults, promoting any shadow research profile into paper strategy behavior, or allowing Phase 9 to orchestrate paper BUY behavior.
- Important parameters: Keeps promotion separate from research and orchestration; records the Phase 8.92B source datasets, no-order/no-fill/no-position safety result, `CANDIDATE_FOR_PROMOTION = 0`, low-confidence `PROMISING_RESEARCH` evidence, no strategy default changes, no `paper:execute` default automation, and a shadow-first TerminalRunner handoff.
- Status: Complete.
- Tests: Manual documentation review.

## Phase 8.91 Shadow Calibration

#### backend/src/shadow-calibration/ShadowCalibrationConfig.ts

- Purpose: Defines Phase 8.91 shadow calibration runtime defaults, CLI parsing, source labels, scenario grids, entry confirmation options, dedupe modes, and portfolio simulation bounds.
- Usage: Imported by `backend/src/scripts/shadow-calibrate.ts`, the report service, and config tests.
- Important parameters: Supports `--label-db`, `--db`, `--session-id`, target/stop/max-hold grids, confirmation horizon/min-return/drawdown grids, `minScore`, `sourceDecisions`, `dedupeMode`, and simulated portfolio sizing.
- Status: Complete.
- Tests: Covered by `backend/src/shadow-calibration/ShadowCalibrationConfig.test.ts`.

#### backend/src/shadow-calibration/ShadowCalibrationTypes.ts

- Purpose: Defines DTOs for Phase 8.91 raw run inputs, run summaries, decision outcomes, unique-mint outcomes, scenario portfolio summaries, entry confirmation summaries, candidate filter summaries, recommendations, and reports.
- Usage: Shared by the loader, report service, formatter, and tests.
- Important parameters: Distinguishes database-backed runs from report-only archive sources and separates simulated outcomes from trading records.
- Status: Complete.
- Tests: Covered by typecheck and shadow calibration service tests.

#### backend/src/shadow-calibration/ShadowRunLoader.ts

- Purpose: Loads active or archived Phase 8.9 data for shadow calibration.
- Usage: Called by `backend/src/scripts/shadow-calibrate.ts`.
- Important parameters: Accepts directories containing `nexus_paper.db`, direct `.db` paths, and report-only `.txt` sources; opens database sources read-only with SQLite `query_only = ON`; rejects live-looking paths and missing archives.
- Status: Complete.
- Tests: Covered by command smoke and typecheck.

#### backend/src/shadow-calibration/ShadowCalibrationReportService.ts

- Purpose: Generates the Phase 8.91 read-only cross-run shadow calibration report.
- Usage: Called by `backend/src/scripts/shadow-calibrate.ts` and service tests.
- Important parameters: Produces run inventory, mechanical validity, decision-level outcomes, unique-mint outcomes, target/stop/max-hold scenario grids, entry confirmation simulations, candidate filter analysis, confidence recommendations, and next-test plans without writing trading state.
- Status: Complete.
- Tests: Covered by `backend/src/shadow-calibration/ShadowCalibrationReportService.test.ts`.

#### backend/src/shadow-calibration/ShadowCalibrationReportFormatter.ts

- Purpose: Formats Phase 8.91 shadow calibration reports as PowerShell-readable text or JSON.
- Usage: Called by `backend/src/scripts/shadow-calibrate.ts`.
- Important parameters: Includes safety framing, config, aggregate counts, run summaries, outcome sections, recommendation evidence, and simulated-only wording.
- Status: Complete.
- Tests: Covered by typecheck and command smoke.

#### backend/src/scripts/shadow-calibrate.ts

- Purpose: CLI entry point for Phase 8.91 shadow calibration.
- Usage: Run `pnpm shadow:calibrate --once`, optionally with archived `--label-db` sources, `--json`, `--session-id`, scenario grids, confirmation grids, dedupe mode, and simulated portfolio options.
- Important parameters: Enforces `PAPER` mode, loads active or archived data through `ShadowRunLoader`, prints wallet/signing/submission disabled status, and emits text or JSON reports.
- Status: Complete.
- Tests: Covered by typecheck, shadow calibration tests, and archive smoke command.

#### backend/src/shadow-calibration/ShadowCalibrationConfig.test.ts

- Purpose: Tests Phase 8.91 config parsing and validation.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies `--label-db`, target/stop/confirmation grids, dedupe mode, duplicate label rejection, and invalid portfolio sizing.
- Status: Complete.
- Tests: Test file.

#### backend/src/shadow-calibration/ShadowCalibrationReportService.test.ts

- Purpose: Tests Phase 8.91 report generation.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies decision-level outcomes, unique-mint behavior, scenario portfolio summaries, entry confirmation outcomes, candidate filter rows, recommendations, and report-only archive handling.
- Status: Complete.
- Tests: Test file.

## Phase 8.92 Shadow Entry-Gate Experimentation

#### backend/src/shadow-entry/ShadowEntryConfig.ts

- Purpose: Defines Phase 8.92 shadow entry runtime defaults, CLI parsing, validation, profile selection, scenario grids, entry timing modes, early-drawdown modes, and portfolio settings.
- Usage: Imported by `backend/src/scripts/shadow-entries.ts`, report services, and config tests.
- Important parameters: Supports `--label-db`, `--db`, `--session-id`, `--profile`, `--profiles`, `--source-decisions`, `--entry-timing`, `--entry-timings`, confirmation grids, recovery grids, target/stop/max-hold grids, JSON output, and simulated portfolio sizing.
- Status: Complete.
- Tests: Covered by `backend/src/shadow-entry/ShadowEntryConfig.test.ts`.

#### backend/src/shadow-entry/ShadowEntryTypes.ts

- Purpose: Defines DTOs and enums for Phase 8.92 entry profiles, candidate inputs, gate outcomes, scenario rows, profile summaries, readiness statuses, and reports.
- Usage: Shared by the config, candidate loader, profile evaluator, report service, formatter, and tests.
- Important parameters: Keeps simulated entry outcomes separate from trading records and uses `CANDIDATE_FOR_PROMOTION` for non-executing readiness output.
- Status: Complete.
- Tests: Covered by typecheck and shadow-entry service tests.

#### backend/src/shadow-entry/ShadowEntryCandidateLoader.ts

- Purpose: Converts Phase 8.91 archived or active run data into normalized Phase 8.92 shadow-entry candidates.
- Usage: Called by `ShadowEntryReportService`.
- Important parameters: Reuses read-only shadow calibration run loading, preserves run labels, maps decision records and observed forward returns, and exposes trading-record counts for safety reporting.
- Status: Complete.
- Tests: Covered by `backend/src/shadow-entry/ShadowEntryReportService.test.ts`.

#### backend/src/shadow-entry/ShadowEntryProfile.ts

- Purpose: Defines immutable and experimental Phase 8.92 entry profiles and evaluates entry-gate outcomes.
- Usage: Called by `ShadowEntryReportService`.
- Important parameters: Includes versioned profiles `P001@v1` through `P011@v1`, including baseline raw BUY, score-confirmed, duplicate-attention, score-55 research, quote-control, recovery-after-drawdown, WATCH-first, duplicate-attention-confirmed, score 65-79, high-score, and WATCH duplicate-hybrid profiles.
- Status: Complete.
- Tests: Covered by `backend/src/shadow-entry/ShadowEntryProfile.test.ts`.

#### backend/src/shadow-entry/ShadowEntryReportService.ts

- Purpose: Generates the Phase 8.92 read-only shadow entry-gate experimentation report.
- Usage: Called by `backend/src/scripts/shadow-entries.ts` and service tests.
- Important parameters: Produces safety inventory, Phase 8.91-scoped P001 baseline reproduction, normalized profile summaries, experimental diagnostics, improvement versus P001, target/stop/max-hold scenario grids, best exit pairing, portfolio simulation, repeated-attention evidence, readiness status/confidence/stability, recommendations, and next-test plan without writing trading state.
- Status: Complete.
- Tests: Covered by `backend/src/shadow-entry/ShadowEntryReportService.test.ts`.

#### backend/src/shadow-entry/ShadowEntryReportFormatter.ts

- Purpose: Formats Phase 8.92 reports as PowerShell-readable text or JSON.
- Usage: Called by `backend/src/scripts/shadow-entries.ts`.
- Important parameters: Prints safety boundary, aggregate counts, baseline reproduction, normalized profile summaries, experimental diagnostics, scenario grids, readiness confidence/stability, recommendations, and paper-execution-disabled wording.
- Status: Complete.
- Tests: Covered by typecheck, backend tests, and archived baseline smoke.

#### backend/src/scripts/shadow-entries.ts

- Purpose: CLI entry point for Phase 8.92 shadow entry-gate experimentation.
- Usage: Run `pnpm shadow:entries --once`, optionally with archived `--label-db` sources, `--json`, `--session-id`, profile filters, timing modes, confirmation grids, drawdown modes, recovery options, and target/stop/max-hold grids.
- Important parameters: Enforces `PAPER` mode, runs migrations, loads active or archived data through the shadow-entry report service, prints wallet/signing/submission disabled status, and emits text or JSON reports.
- Status: Complete.
- Tests: Covered by typecheck, backend tests, and archived baseline smoke command.

#### backend/src/shadow-entry/ShadowEntryConfig.test.ts

- Purpose: Tests Phase 8.92 config parsing and validation.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies profile selection, timing modes, drawdown modes, recovery options, label-db parsing, and validation errors.
- Status: Complete.
- Tests: Test file.

#### backend/src/shadow-entry/ShadowEntryProfile.test.ts

- Purpose: Tests Phase 8.92 profile gate behavior.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies baseline BUY entry behavior, confirmation rejection, missed fast move classification, early-drawdown warnings/rejections, and recovery-after-drawdown outcomes.
- Status: Complete.
- Tests: Test file.

#### backend/src/shadow-entry/ShadowEntryReportService.test.ts

- Purpose: Tests Phase 8.92 report generation.
- Usage: Run through `pnpm test`.
- Important parameters: Verifies baseline reproduction, profile summaries, improvement versus P001, safety counts, readiness labels, and simulated-only behavior.
- Status: Complete.
- Tests: Test file.
