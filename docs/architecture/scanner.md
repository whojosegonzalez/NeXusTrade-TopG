# Scanner Architecture

Phase 4 adds scanner-only discovery. The scanner discovers Solana token candidates, deduplicates them by mint address, enriches each unique mint through `MarketDataService`, normalizes the result, and stores scanner candidates in `TokenRadar`.

The scanner is intentionally not a risk engine, strategy engine, paper exchange, wallet runner, or trading executor.

## Runtime Modes

The scanner command is:

```bash
pnpm scanner:discover
```

By default, the command runs continuously in `PAPER` mode. It creates or reuses a paper session, runs a discovery cycle, sleeps for the configured interval, and repeats until stopped.

Useful one-shot and dry-run commands:

```bash
pnpm scanner:discover --once
pnpm scanner:discover --once --dry-run
pnpm scanner:discover --session-id=session_123
pnpm scanner:discover --interval-ms=60000
pnpm scanner:discover --limit=25
pnpm scanner:discover --concurrency=3
```

The script refuses non-paper modes. It does not load a wallet, sign transactions, submit transactions, create orders, create fills, or create positions.

## Runtime Defaults

Defaults:

- `intervalMs`: `60000`
- `limit`: `25`
- `concurrency`: `3`
- `once`: `false`
- `dryRun`: `false`

Validation bounds:

- `intervalMs`: `10000` to `3600000`
- `limit`: `1` to `100`
- `concurrency`: `1` to `10`

Unknown or invalid CLI options fail fast before provider calls or database writes.

## Session Policy

When no `--session-id` is supplied, the scanner creates a `PAPER` session with:

- `status`: `RUNNING`
- `startingBalanceLamports`: `0`
- `currentCashLamports`: `0`
- no target profit
- no max drawdown
- scanner runtime config stored in `configSnapshotJson`

When `--session-id` is supplied, the scanner only reuses sessions that are:

- `mode`: `PAPER`
- `status`: `CREATED` or `RUNNING`

A `CREATED` session is marked `RUNNING` before the cycle begins. `COMPLETED`, `FAILED`, and `CANCELLED` sessions are rejected. `PAUSED` reuse is deferred to a later SessionManager phase.

Phase 4 intentionally leaves scanner sessions `RUNNING`; completion semantics are deferred.

## Pipeline

Each scanner cycle runs:

```text
DISCOVER
DEDUPE
ENRICH
NORMALIZE
UPSERT
LOG
```

The scanner uses these boundaries:

- Discovery uses `TokenDiscoveryProvider` adapters from `ProviderRegistry`.
- Enrichment uses `MarketDataService.enrichToken()`.
- Normalization uses `RadarCandidateMapper`.
- Persistence uses `TokenRadarRepository.upsertRadarEntry()`.
- Activity and errors are written to `SystemLog`.
- Provider status is written indirectly through Phase 3 provider adapters and `ProviderHealthService`.

## Discovery Source

Phase 4 discovery uses the existing token discovery provider interface. The implemented live discovery source is DexScreener token profiles through `DexScreenerAdapter.discoverTokens()`.

Deferred discovery sources:

- DexScreener recent pairs
- DexScreener WebSockets
- Helius Streams
- Pump.fun adapters
- QuickNode Metis
- Birdeye

## Deduplication

Candidates are deduplicated in memory by `mintAddress` before enrichment. The scanner records raw, unique, and duplicate counts in cycle logs.

The current cycle limit is applied after provider aggregation and before deduplication. Discovery logs also retain the raw provider candidate count before limiting.

## TokenRadar Mapping

Phase 4 stores scanner candidates with status `DISCOVERED` when enrichment succeeds and `ERROR` when enrichment fails.

Mapping rules:

- `source`: discovery provider name
- `pairAddress`: best pair address from enrichment, when available
- `firstSeenAtMs`: best pair creation time when available, otherwise discovery time
- `discoveredAtMs`: current cycle timestamp
- `ageSeconds`: derived from pair creation time when available
- numeric fields are stored as decimal strings
- `rawDataJson` stores a compact, redacted discovery and enrichment summary

Phase 4 does not set `APPROVED` or `BOUGHT` statuses.

## Dry Run

Dry-run mode still allows:

- provider discovery
- provider enrichment
- `SystemLog` writes
- `ProviderHealth` writes
- auto-created or reused scanner sessions

Dry-run mode skips `TokenRadar` writes.

## Safety Boundary

Scanner tests assert that Phase 4 creates none of these records:

- `RiskAssessment`
- `StrategyDecision`
- `Order`
- `Fill`
- `Position`

The command output also states that wallet loading, transaction signing, and transaction submission are disabled.

## Known Limitations

- Discovery currently uses DexScreener token profiles only.
- No recent-pair or streaming discovery source exists yet.
- No candidate ranking or risk scoring exists yet.
- No provider result cache exists yet.
- Continuous scanner lifecycle management is minimal until the SessionManager phase.
- DexScreener token profile endpoints have lower documented rate limits than pair lookup endpoints, so high-frequency polling should wait for endpoint-specific rate-limit controls.
