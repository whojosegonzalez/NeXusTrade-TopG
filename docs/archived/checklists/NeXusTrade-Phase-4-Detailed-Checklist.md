# NeXusTrade Phase 4 Detailed Checklist

Phase 4 builds scanner-only mode. The scanner discovers Solana token candidates, deduplicates them, enriches them through the provider layer, normalizes them into `TokenRadar`, and stores scanner activity in the paper database. It does not score risk, create strategy decisions, create orders, create fills, create positions, load wallets, sign transactions, submit transactions, or execute trades.

## Definition of Done

- [x] Discovery providers return token candidates through `TokenDiscoveryProvider`.
- [x] Candidate discovery uses provider interfaces instead of direct vendor calls.
- [x] Candidates are deduplicated by mint address before enrichment.
- [x] Duplicate metrics are recorded.
- [x] Candidates are enriched through `MarketDataService`.
- [x] Enrichment uses configurable bounded concurrency.
- [x] Partial provider failures are preserved as warnings where possible.
- [x] Candidates are normalized into TokenRadar records.
- [x] TokenRadar numeric fields are stored as strings.
- [x] TokenRadar `firstSeenAtMs` uses pair creation time when available.
- [x] TokenRadar `discoveredAtMs` uses the current cycle timestamp.
- [x] TokenRadar `ageSeconds` is derived from pair creation time when available.
- [x] TokenRadar `rawDataJson` stores compact redacted discovery and enrichment summaries.
- [x] Candidates are persisted through `TokenRadarRepository.upsertRadarEntry()`.
- [x] Existing TokenRadar rows preserve original `firstSeenAtMs`.
- [x] Scanner supports continuous operation.
- [x] Scanner supports one-shot operation with `--once`.
- [x] Scanner supports dry-run mode with `--dry-run`.
- [x] Dry-run mode skips TokenRadar writes.
- [x] Scanner auto-creates paper sessions when no session ID is supplied.
- [x] Auto-created scanner sessions use zero starting and current balances.
- [x] Auto-created scanner sessions store scanner config in `configSnapshotJson`.
- [x] Scanner can reuse existing `PAPER` sessions in `CREATED` or `RUNNING` status.
- [x] Scanner marks reusable `CREATED` sessions as `RUNNING`.
- [x] Scanner rejects completed, failed, cancelled, paused, missing, and non-paper sessions.
- [x] Scanner writes SystemLog entries.
- [x] ProviderHealth entries are written indirectly by provider adapters.
- [x] Scanner never creates RiskAssessment records.
- [x] Scanner never creates StrategyDecision records.
- [x] Scanner never creates Order records.
- [x] Scanner never creates Fill records.
- [x] Scanner never creates Position records.
- [x] Scanner does not load wallets.
- [x] Scanner does not sign transactions.
- [x] Scanner does not submit transactions.
- [x] CLI runner exists at `backend/src/scripts/scanner-discover.ts`.
- [x] Backend package exposes `scanner:discover`.
- [x] Root package exposes `scanner:discover`.
- [x] Tests live under `backend/src/scanner/*.test.ts`.
- [x] Scanner tests cover config, discovery, dedupe, enrichment, mapping, persistence, session policy, dry-run behavior, and safety boundaries.
- [x] `docs/architecture/scanner.md` documents scanner behavior and limitations.
- [x] `docs/Structure.md`, `docs/ROADMAP.md`, and `docs/DECISIONS.md` are updated for Phase 4.
- [x] Phase 5 planning inputs document the risk-engine handoff.

## Verification Notes

- 2026-06-21: `corepack pnpm verify` passed.
- 2026-06-21: `corepack pnpm scanner:discover --once --dry-run` passed.
- 2026-06-21: `corepack pnpm scanner:discover --once` passed.
- 2026-06-21: Dry-run scanner discovered and enriched candidates while storing zero TokenRadar rows by design.
- 2026-06-21: Real one-shot scanner stored TokenRadar records and reported zero errors.
- 2026-06-21: Scanner command output confirmed wallet loading, transaction signing, and transaction submission were disabled.

Final dry-run scanner output:

```text
MODE: PAPER
Scanner once: yes
Scanner dry-run: yes
Interval ms: 60000
Candidate limit: 25
Enrichment concurrency: 3
Session: auto-create
Providers enabled: DEXSCREENER, JUPITER, HELIUS
Discovery providers: DEXSCREENER
Wallet loaded: no
Transaction signing: disabled
Transaction submission: disabled

Cycle summary: discovered=25 unique=25 enriched=25 stored=0 errors=0
```

Final one-shot scanner output:

```text
MODE: PAPER
Scanner once: yes
Scanner dry-run: no
Interval ms: 60000
Candidate limit: 25
Enrichment concurrency: 3
Session: auto-create
Providers enabled: DEXSCREENER, JUPITER, HELIUS
Discovery providers: DEXSCREENER
Wallet loaded: no
Transaction signing: disabled
Transaction submission: disabled

Cycle summary: discovered=25 unique=25 enriched=25 stored=25 errors=0
```

## Verification Commands

```bash
pnpm verify
pnpm scanner:discover --once --dry-run
pnpm scanner:discover --once
```

## Runtime Commands

```bash
pnpm scanner:discover
pnpm scanner:discover --once
pnpm scanner:discover --dry-run
pnpm scanner:discover --session-id=session_123
pnpm scanner:discover --interval-ms=60000
pnpm scanner:discover --limit=25
pnpm scanner:discover --concurrency=3
```

## Phase Notes

- Default scanner settings are `intervalMs=60000`, `limit=25`, and `concurrency=3`.
- Validation bounds are `intervalMs=10000..3600000`, `limit=1..100`, and `concurrency=1..10`.
- The default command without `--once` runs continuously until stopped.
- Phase 4 discovery uses DexScreener token profiles only.
- Recent-pair discovery, streaming discovery, and provider result caching are deferred.
- Scanner sessions intentionally remain `RUNNING`; completion semantics are deferred to the SessionManager phase.
- Dry-run mode still writes sessions and logs, but skips TokenRadar writes.
- Scanner-created TokenRadar rows use `DISCOVERED` for successful enrichment and `ERROR` for enrichment failures.
- Phase 4 does not set `APPROVED` or `BOUGHT`.
- Phase 4 scanner enrichment does not request Jupiter buy/sell quote probes, so quote price impact is not present in scanner rows by default.
- Phase 5 should consume TokenRadar candidates, refresh or collect risk evidence, and write RiskAssessment records without changing scanner-only responsibilities.

## Out of Scope

- Risk scoring.
- Risk pass/fail decisions.
- Strategy decisions.
- Paper buy/sell simulation.
- PaperExchange.
- P/L target enforcement.
- Dashboard UI.
- Wallet loading.
- Swap transaction construction.
- Transaction signing.
- Transaction submission.
- Live trading.
