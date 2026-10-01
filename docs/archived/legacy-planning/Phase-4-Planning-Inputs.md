# Phase 4 Planning Inputs

Phase 4 goal: discover, dedupe, normalize, and store token candidates in `TokenRadar` without strategy decisions, risk pass/fail decisions, orders, fills, positions, wallets, signing, or trades.

This file captures the useful Phase 3 handoff points for planning that work. It is a historical planning snapshot; the current Phase 4 scanner implementation is documented in [architecture/scanner.md](./architecture/scanner.md).

## 1. Current File Tree After Phase 3

Ignored local files such as `.env`, `node_modules/`, `.git/`, and `data/nexus_paper.db` are omitted.

```text
NeXusTrade-Otis/
├─ .editorconfig
├─ .env.example
├─ .gitignore
├─ .node-version
├─ .npmrc
├─ .nvmrc
├─ .prettierignore
├─ .prettierrc
├─ eslint.config.js
├─ package.json
├─ pnpm-lock.yaml
├─ pnpm-workspace.yaml
├─ README.md
├─ tsconfig.base.json
├─ backend/
│  ├─ drizzle.config.ts
│  ├─ package.json
│  ├─ tsconfig.json
│  ├─ drizzle/
│  │  ├─ 0000_tense_aqueduct.sql
│  │  └─ meta/
│  │     ├─ _journal.json
│  │     └─ 0000_snapshot.json
│  └─ src/
│     ├─ index.ts
│     ├─ config/
│     │  ├─ env.test.ts
│     │  ├─ env.ts
│     │  ├─ liveModeGuard.ts
│     │  └─ loadEnvFile.ts
│     ├─ db/
│     │  ├─ connection.test.ts
│     │  ├─ connection.ts
│     │  ├─ DatabaseFactory.ts
│     │  ├─ DatabaseMode.test.ts
│     │  ├─ DatabaseMode.ts
│     │  ├─ index.ts
│     │  ├─ migratePaper.ts
│     │  ├─ migrations.ts
│     │  ├─ resetPaper.ts
│     │  ├─ repositories/
│     │  │  ├─ FillRepository.ts
│     │  │  ├─ helpers.ts
│     │  │  ├─ index.ts
│     │  │  ├─ OrderRepository.ts
│     │  │  ├─ PositionRepository.ts
│     │  │  ├─ ProviderHealthRepository.ts
│     │  │  ├─ repositories.test.ts
│     │  │  ├─ RepositoryFactory.ts
│     │  │  ├─ RiskAssessmentRepository.ts
│     │  │  ├─ SessionRepository.ts
│     │  │  ├─ SnapshotRepository.ts
│     │  │  ├─ StrategyDecisionRepository.ts
│     │  │  ├─ SystemLogRepository.ts
│     │  │  └─ TokenRadarRepository.ts
│     │  ├─ schema/
│     │  │  ├─ enums.ts
│     │  │  ├─ equitySnapshots.ts
│     │  │  ├─ fills.ts
│     │  │  ├─ index.ts
│     │  │  ├─ orders.ts
│     │  │  ├─ positions.ts
│     │  │  ├─ positionSnapshots.ts
│     │  │  ├─ providerHealth.ts
│     │  │  ├─ riskAssessments.ts
│     │  │  ├─ sessions.ts
│     │  │  ├─ strategyDecisions.ts
│     │  │  ├─ systemLogs.ts
│     │  │  └─ tokenRadar.ts
│     │  ├─ seeds/
│     │  │  └─ seedPaperDatabase.ts
│     │  ├─ testing/
│     │  │  ├─ createTestDatabase.ts
│     │  │  ├─ databaseSmokeTest.ts
│     │  │  └─ databaseTestHelpers.ts
│     │  └─ utils/
│     │     ├─ ids.ts
│     │     ├─ json.test.ts
│     │     ├─ json.ts
│     │     ├─ money.test.ts
│     │     ├─ money.ts
│     │     ├─ paths.ts
│     │     ├─ timestamps.test.ts
│     │     └─ timestamps.ts
│     ├─ health/
│     │  ├─ healthCheck.test.ts
│     │  └─ healthCheck.ts
│     ├─ logging/
│     │  └─ logger.ts
│     ├─ providers/
│     │  ├─ MarketDataService.test.ts
│     │  ├─ MarketDataService.ts
│     │  ├─ ProviderHealthService.test.ts
│     │  ├─ ProviderHealthService.ts
│     │  ├─ ProviderRegistry.ts
│     │  ├─ config/
│     │  │  └─ providerConfig.ts
│     │  ├─ dexscreener/
│     │  │  ├─ dexscreener.mappers.test.ts
│     │  │  ├─ dexscreener.mappers.ts
│     │  │  ├─ dexscreener.schemas.ts
│     │  │  └─ DexScreenerAdapter.ts
│     │  ├─ helius/
│     │  │  ├─ helius.mappers.test.ts
│     │  │  ├─ helius.mappers.ts
│     │  │  ├─ helius.schemas.ts
│     │  │  └─ HeliusAdapter.ts
│     │  ├─ http/
│     │  │  ├─ ProviderHttpClient.test.ts
│     │  │  ├─ ProviderHttpClient.ts
│     │  │  ├─ providerRateLimiter.test.ts
│     │  │  ├─ providerRateLimiter.ts
│     │  │  └─ providerRetry.ts
│     │  ├─ interfaces/
│     │  │  ├─ index.ts
│     │  │  ├─ LiquidityProvider.ts
│     │  │  ├─ PriceProvider.ts
│     │  │  ├─ PriorityFeeProvider.ts
│     │  │  ├─ ProviderAdapter.ts
│     │  │  ├─ QuoteProvider.ts
│     │  │  ├─ RiskEvidenceProvider.ts
│     │  │  ├─ TokenDiscoveryProvider.ts
│     │  │  └─ TokenMetadataProvider.ts
│     │  └─ jupiter/
│     │     ├─ jupiter.mappers.test.ts
│     │     ├─ jupiter.mappers.ts
│     │     ├─ jupiter.schemas.ts
│     │     └─ JupiterAdapter.ts
│     └─ scripts/
│        └─ providers-smoke.ts
├─ docs/
│  ├─ DECISIONS.md
│  ├─ NeXusTrade-Phase-1-Detailed-Checklist.md
│  ├─ NeXusTrade-Phase-2-Detailed-Checklist.md
│  ├─ Phase-4-Planning-Inputs.md
│  ├─ Provider-Architecture.md
│  ├─ ROADMAP.md
│  ├─ Structure.md
│  ├─ architecture/
│  │  └─ database.md
│  └─ phase-notes/
│     └─ phase-2-database-layer.md
├─ frontend/
│  └─ README.md
├─ scripts/
│  └─ check-secrets.mjs
└─ shared/
   ├─ package.json
   ├─ tsconfig.json
   └─ src/
      ├─ config.ts
      ├─ index.ts
      ├─ modes.test.ts
      ├─ modes.ts
      ├─ market/
      │  ├─ enrichment.types.test.ts
      │  ├─ enrichment.types.ts
      │  ├─ liquidity.types.ts
      │  ├─ metadata.types.ts
      │  ├─ price.types.ts
      │  ├─ priority-fee.types.ts
      │  ├─ quote.types.ts
      │  ├─ risk-evidence.types.ts
      │  ├─ token.types.test.ts
      │  └─ token.types.ts
      └─ providers/
         ├─ provider-errors.ts
         ├─ provider-results.test.ts
         ├─ provider-results.ts
         └─ provider.types.ts
```

## 2. MarketDataService Methods Available

File: `backend/src/providers/MarketDataService.ts`

Public class:

```ts
class MarketDataService {
  constructor(registry: ProviderRegistry);

  enrichToken(request: TokenEnrichmentRequest): Promise<ProviderResult<TokenEnrichmentSnapshot>>;
}
```

Request shape:

```ts
interface TokenEnrichmentRequest {
  readonly mintAddress: TokenMintAddress;
  readonly buyQuoteRequest?: QuoteRequest;
  readonly sellQuoteRequest?: QuoteRequest;
}
```

`enrichToken()` currently tries the first successful provider for each capability:

- price through `registry.getPriceProviders()`
- best pair through `registry.getLiquidityProviders()`
- metadata through `registry.getTokenMetadataProviders()`
- risk evidence through `registry.getRiskEvidenceProviders()`
- optional buy quote through `registry.getQuoteProviders()`
- optional sell quote through `registry.getQuoteProviders()`

Return shape:

```ts
ProviderResult<TokenEnrichmentSnapshot>;
```

`TokenEnrichmentSnapshot` contains:

- `identity`
- optional `price`
- optional `bestPair`
- optional `metadata`
- optional `riskEvidence`
- optional `buyQuote`
- optional `sellQuote`
- `sourcesUsed`
- `warnings`
- `fetchedAt`

Important Phase 4 note: `MarketDataService` does not discover candidates and does not store anything in `TokenRadar`. Phase 4 should call discovery providers first, then call `enrichToken()` for each deduped mint, then persist the normalized candidate fields through `TokenRadarRepository`.

## 3. TokenDiscoveryProvider Outputs

File: `backend/src/providers/interfaces/TokenDiscoveryProvider.ts`

Interface:

```ts
interface TokenDiscoveryProvider extends ProviderAdapter {
  readonly discoverTokens: (limit?: number) => Promise<ProviderResult<readonly TokenIdentity[]>>;
}
```

Output wrapper:

```ts
ProviderResult<readonly TokenIdentity[]>;
```

`TokenIdentity` fields:

- `chainId: "solana"`
- `mintAddress: TokenMintAddress`
- optional `symbol`
- optional `name`
- optional `decimals`
- optional `logoUri`
- optional `tokenProgram`

Current implementation:

- `DexScreenerAdapter.discoverTokens(limit = 20)`
- Uses DexScreener token profiles endpoint.
- Filters to `chainId === "solana"`.
- Validates Solana mint-like base58 strings.
- Returns `chainId`, `mintAddress`, and optional `logoUri` when the profile has an icon.

Important Phase 4 note: discovery output is intentionally lightweight. It is not enough to store a fully useful radar candidate by itself. Phase 4 should enrich each discovered mint to get price, pair address, liquidity, volume, symbol/name, and raw evidence for `TokenRadar`.

## 4. DexScreener Recent-Pair/Discovery Method Status

File: `backend/src/providers/dexscreener/DexScreenerAdapter.ts`

Implemented methods:

- `getPairsForToken(mintAddress)`
- `getBestPairForToken(mintAddress)`
- `getPrice(mintAddress)`
- `discoverTokens(limit = 20)`

Implemented discovery endpoint:

- `GET /token-profiles/latest/v1`
- Current method name: `discoverTokens`
- Current operation label for health records: `token-profiles-latest`

Not implemented yet:

- Dedicated recent-pair endpoint support.
- DexScreener `recent-updates` token profile endpoint.
- DexScreener WebSocket discovery.
- Cursor/pagination support.
- Per-endpoint DexScreener rate limits.

Best-pair selection is deterministic:

1. Higher `liquidityUsd`
2. Higher `volume24h`
3. Newer `pairCreatedAt`
4. Lexicographic `pairAddress`

Important Phase 4 note: DexScreener pair lookup endpoints are documented around 300 requests/minute, while token profile endpoints are documented around 60 requests/minute. The current config has one global `DEXSCREENER_RATE_LIMIT_PER_MINUTE` value. Phase 4 should either keep discovery polling at or below 60/minute or add per-endpoint rate-limit controls before a high-frequency scanner loop.

## 5. Provider Smoke-Test Output

Command:

```bash
corepack pnpm providers:smoke --strict
```

Last observed output with local DexScreener/Jupiter/Helius configuration:

```text
MODE: PAPER
Providers requested: DEXSCREENER, JUPITER, HELIUS
Providers enabled: DEXSCREENER, JUPITER, HELIUS
Wallet loaded: no
Transaction signing: disabled
Transaction submission: disabled

DEXSCREENER pairs: ok (best pair Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE)
JUPITER price: ok (price 73.41251214814422)
JUPITER quote: ok (out 7342044)
HELIUS metadata: ok (metadata SOL)
MarketDataService enrichment: ok (sources DEXSCREENER, JUPITER, HELIUS)
ProviderHealth writes: ok
SystemLog writes: ok

Result: provider smoke check passed
```

Safety properties confirmed by the script:

- Mode must be `PAPER`.
- Wallet loaded: no.
- Transaction signing: disabled.
- Transaction submission: disabled.
- No orders, fills, positions, or trades are created by the smoke script.

## 6. TokenRadarRepository Methods

File: `backend/src/db/repositories/TokenRadarRepository.ts`

Public methods:

```ts
createRadarEntry(input: CreateRadarEntryInput): TokenRadarRecord;

upsertRadarEntry(input: CreateRadarEntryInput): TokenRadarRecord;

getRadarEntryById(id: string): TokenRadarRecord | undefined;

findRadarEntryByMint(sessionId: string, mintAddress: string): TokenRadarRecord | undefined;

listRadarEntries(sessionId: string, filter?: RadarEntryListFilter): TokenRadarRecord[];

updateRadarStatus(id: string, status: TokenRadarStatus, notes?: string): TokenRadarRecord;
```

`RadarEntryListFilter` fields:

- optional `status`
- optional `mintAddress`
- optional `limit`

Dedup behavior:

- `upsertRadarEntry()` dedupes by `sessionId`, `mintAddress`, `source`, and `pairAddress`.
- The database has a matching unique index: `uq_token_radar_session_mint_source_pair`.
- When an existing row is found, `firstSeenAtMs` is preserved as the earliest value, `createdAtMs` is preserved, and `updatedAtMs` is refreshed.

Current `token_radar` columns:

- `id`
- `sessionId`
- `mintAddress`
- optional `symbol`
- optional `name`
- optional `pairAddress`
- `source`
- `firstSeenAtMs`
- `discoveredAtMs`
- optional `priceUsd`
- optional `priceSol`
- optional `liquidityUsd`
- optional `volume5mUsd`
- optional `volume1hUsd`
- optional `ageSeconds`
- `status`
- optional `notes`
- optional `rawDataJson`
- `createdAtMs`
- `updatedAtMs`

Current statuses:

- `DISCOVERED`
- `WATCHING`
- `REJECTED`
- `APPROVED`
- `BOUGHT`
- `IGNORED`
- `ERROR`

Important Phase 4 note: for scanner-only work, use `DISCOVERED`, `WATCHING`, `IGNORED`, and `ERROR` as needed. Avoid `APPROVED`, `BOUGHT`, strategy decisions, risk decisions, orders, fills, and positions in Phase 4.

## 7. Current Config/Env Options

Config is loaded by `backend/src/config/env.ts`, which calls `backend/src/providers/config/providerConfig.ts`.

The backend loads the root `.env` file through Node 24 `process.loadEnvFile()` when reading real `process.env`.

Current provider defaults:

- `PROVIDERS_ENABLED`: `DEXSCREENER,JUPITER,HELIUS`
- `PROVIDER_TIMEOUT_MS`: `10000`
- `PROVIDER_MAX_RETRIES`: `2`
- `PROVIDER_RETRY_BACKOFF_MS`: `250`
- `ENABLE_PROVIDER_RAW_PAYLOAD_LOGGING`: `false`
- `WRITE_PROVIDER_HEALTH`: `true`

Provider base URLs:

- `DEXSCREENER_BASE_URL`: `https://api.dexscreener.com`
- `JUPITER_PRICE_BASE_URL`: `https://api.jup.ag/price/v3`
- `JUPITER_SWAP_BASE_URL`: `https://api.jup.ag/swap/v1`
- `HELIUS_RPC_BASE_URL`: `https://mainnet.helius-rpc.com`
- `RUGCHECK_BASE_URL`: `https://api.rugcheck.xyz`

Provider rate limits:

- `DEXSCREENER_RATE_LIMIT_PER_MINUTE`: current default `300`
- `JUPITER_RATE_LIMIT_PER_MINUTE`: current default `60`
- `HELIUS_RATE_LIMIT_PER_MINUTE`: current default `60`
- `RUGCHECK_RATE_LIMIT_PER_MINUTE`: current default `60`
- `MOCK`: hardcoded `60000`

Provider keys:

- `DEXSCREENER_API_KEY`: accepted by config but not required by current adapter.
- `JUPITER_API_KEY`: required to enable Jupiter.
- `HELIUS_API_KEY`: required to enable Helius.
- `RUGCHECK_API_KEY`: accepted by config, but RugCheck remains deferred.

Provider enable/disable behavior:

- DexScreener and Mock can enable without keys.
- Jupiter is disabled if `JUPITER_API_KEY` is missing.
- Helius is disabled if `HELIUS_API_KEY` is missing.
- RugCheck is always disabled for now with reason: API contract deferred.
- `providers:smoke --strict` treats missing requested key-backed providers as failures.

## 8. Known Provider Limitations From Phase 3

- Phase 3 provider code is read-only. It does not load wallets, sign transactions, submit transactions, create orders, create fills, create positions, or run a scanner loop.
- `MarketDataService.enrichToken()` enriches one mint at a time and does not persist candidates.
- `MarketDataService.enrichToken()` returns warnings for partial provider failures. It does not score, rank, approve, reject, or decide.
- Discovery currently exists only through `TokenDiscoveryProvider.discoverTokens()`, implemented by DexScreener token profiles.
- DexScreener discovery currently uses token profiles, not recent pairs. Phase 4 may need a stronger discovery source if the scanner needs pair-first candidate data.
- DexScreener WebSocket streaming is documented but not implemented.
- DexScreener profile endpoints have lower documented limits than pair lookup endpoints; the current limiter is provider-wide, not endpoint-specific.
- Jupiter metadata is partial because the adapter derives only what is available from Price v3 responses.
- Jupiter quote support only fetches quotes. It does not build swap transactions.
- Helius risk evidence currently exposes authority evidence only. It is not a risk-engine decision.
- Helius metadata and priority-fee support require `HELIUS_API_KEY`.
- RugCheck is deferred.
- No provider cache exists yet.
- No scanner session orchestration exists yet.
- No candidate normalization-to-`TokenRadar` mapper exists yet.
- `TokenRadar.rawDataJson` can store redacted provider/enrichment context, but Phase 4 should keep it compact and use `stringifyJson()` so secrets are redacted.

## Phase 4 Suggested Shape

A clean Phase 4 implementation can stay inside these boundaries:

1. Create a scanner/discovery service that calls `registry.getTokenDiscoveryProviders()`.
2. Dedupe discovered mints in memory by mint address before enrichment.
3. Call `MarketDataService.enrichToken({ mintAddress })` for each mint.
4. Normalize `TokenEnrichmentSnapshot` into `CreateRadarEntryInput`.
5. Persist through `TokenRadarRepository.upsertRadarEntry()`.
6. Keep candidate status at `DISCOVERED`, `WATCHING`, `IGNORED`, or `ERROR`.
7. Write scanner/provider logs through `SystemLogRepository`.
8. Do not call strategy, risk pass/fail, order, fill, position, wallet, signing, or transaction code.
