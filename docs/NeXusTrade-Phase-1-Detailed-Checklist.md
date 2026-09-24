# NeXusTrade Phase 1 Detailed Checklist

Phase 1 establishes the safe project foundation for NeXusTrade. It does not build the database, scanner, provider adapters, strategy engine, paper exchange, dashboard, wallet loading, or live trading.

## Definition of Done

- [x] Monorepo structure exists with `backend`, `shared`, `frontend`, `docs`, `scripts`, and `data`.
- [x] Node.js 24 and pnpm are documented as the runtime and package manager targets.
- [x] TypeScript strict mode is configured.
- [x] Shared execution modes are defined with `PAPER` as the default.
- [x] Backend startup validates config and blocks `LIVE` mode.
- [x] Vitest tests cover modes, env loading, live-mode guard, and health checks.
- [x] Prettier, ESLint, EditorConfig, Husky, and lint-staged are configured.
- [x] Secret protection blocks local env files, wallet files, key material, and obvious private key content.
- [x] `docs/Structure.md`, `docs/ROADMAP.md`, and `docs/DECISIONS.md` document the foundation.
- [x] README explains the paper-first milestone and quick start.

## Verification Notes

- 2026-06-20: `pnpm verify` passed.
- 2026-06-20: Default backend startup passed in `PAPER` mode.
- 2026-06-20: Explicit `NEXUSTRADE_MODE=PAPER` startup passed.
- 2026-06-20: Explicit `NEXUSTRADE_MODE=LIVE` refused to start with the expected Phase 1 safety message.
- Local caveat: verification ran on Node.js `v22.20.0`, while the repository target is Node.js 24 LTS. pnpm emitted engine warnings, but checks passed.

## Verification Commands

```bash
pnpm install
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm check:secrets
pnpm verify
pnpm dev:backend
NEXUSTRADE_MODE=PAPER pnpm dev:backend
NEXUSTRADE_MODE=LIVE pnpm dev:backend
```

The expected `LIVE` result is:

```text
LIVE mode is disabled during early development.
Use PAPER mode while the paper-trading engine is under development.
```

## Out of Scope

- Drizzle schema implementation.
- SQLite database creation.
- Migrations and repositories.
- Jupiter, DexScreener, Helius, or RugCheck integrations.
- Token scanner.
- Risk engine.
- Strategy engine.
- PaperExchange.
- P/L target logic.
- Dashboard UI.
- Wallet loading.
- Live trading.
