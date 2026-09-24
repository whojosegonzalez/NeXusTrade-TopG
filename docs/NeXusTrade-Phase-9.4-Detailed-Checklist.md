# NeXusTrade Phase 9.4 Detailed Checklist

Birdeye selective market-data enrichment

Last updated: August 2026

## Status

Implemented; validation complete.

Phase 9.4 adds Birdeye as a selective market-data enrichment provider. It should improve price,
volume, liquidity, and market-activity evidence for high-intent candidates without treating Birdeye
as executable quote evidence and without enabling paper BUY automation.

Implementation note:

```text
Birdeye provider identity, config, adapter, cache, budget guardrails, selective TerminalRunner
enrichment, provider smoke checks, diagnostics, analytics, calibration, aggregate, and
interpretation reporting were implemented in Phase 9.4.
```

Validation conclusion:

```text
Operational integration passed.
Budget guardrails passed.
Provider safety passed.
Attribution/reporting is partial.
Paper BUY readiness remains no.
Next phase: Phase 9.4A validation truthing and attribution integrity.
```

Detailed closeout:

- [NeXusTrade-Phase-9.4-Conclusion-and-9.4A-Prep.md](./NeXusTrade-Phase-9.4-Conclusion-and-9.4A-Prep.md)

## Current Baseline

Latest Phase 9.3C current baseline:

```text
Archive:
data/archive/phase9.3C/current-baseline-phase9.3C-current-baseline-20260803-1852

Runtime: about 120 minutes
orders/fills/positions = 0
missingAuthorityEvidenceCount = 0
missingAuthority = 0
SOLANA_RPC liveRateLimited = 0%

JUPITER combinedRateLimited = 73.71%
missingQuote = 433 / 500 strategy rows
RAYDIUM ok = 10.74%
RAYDIUM error = 86.29%
```

Interpretation:

```text
Authority evidence is no longer the bottleneck.
Quote and market-data confidence remain the bottleneck.
Raydium helps occasionally, but not enough to replace missing or pressured Jupiter quote evidence.
```

## Why This Phase Exists

Phase 9.4 exists because the system needs richer market evidence before changing strategy rules or
moving toward paper BUY automation.

Birdeye can help with:

```text
current token price
price and volume snapshot
token overview across selected frames
liquidity and market activity
buy/sell pressure
trade count and unique-wallet activity
post-run missed-opportunity analysis
selective high-intent candidate enrichment
```

Birdeye should not be used as:

```text
an executable quote provider
a price-impact provider
a replacement for Jupiter route quotes
a broad scanner source for every candidate
a reason to enable paper BUY automation
```

## External Research Summary

Current Birdeye docs relevant to Phase 9.4:

```text
Base URL:
https://public-api.birdeye.so

Authentication:
X-API-KEY header
x-chain: solana header

Standard/free account constraints:
30,000 CUs/month
1 RPS
no overage
no WebSocket access
```

Standard-accessible endpoints that matter:

```text
/defi/price
  3 CU
  current single-token price

/defi/price_volume/single
  8 CU
  current price and selected-window volume

/defi/token_overview
  20 CU
  broad token market-intelligence snapshot
  supports frames such as 1m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 24h

/defi/v3/token/market-data
  10 CU
  focused token market data

/defi/v3/token/exit-liquidity
  15 CU
  focused exit-liquidity evidence

/utils/v1/credits
  used for current account credit visibility
```

Endpoints to defer on Standard/free unless a later phase explicitly needs them:

```text
batch/multiple endpoints
WebSocket endpoints
Token Trade Data Single if account access does not permit it
Token Metadata Single if account access does not permit it
OHLCV except for narrow diagnostics because old OHLCV endpoints are 35 CU/request
```

## Phase 9.4 Philosophy

Birdeye calls must be scarce and intentional.

Default rule:

```text
Do not call Birdeye from broad discovery.
Do not call Birdeye for every scanner candidate.
Do call Birdeye only after cheap filters have created high-intent candidates.
```

Recommended first-pass enrichment gates:

```text
decision = WATCH
or score >= 50
or risk = PASS
or missingQuote = true but DexScreener liquidity/volume is promising
or candidate appears in missed-opportunity / shadow observation analysis
```

Recommended per-run budget:

```text
BIRDEYE_MAX_REQUESTS_PER_RUN = 60
BIRDEYE_MAX_CU_PER_RUN = 1200
BIRDEYE_RATE_LIMIT_PER_MINUTE = 60
BIRDEYE_MIN_SCORE = 50
BIRDEYE_MAX_CANDIDATES_PER_CYCLE = 2
BIRDEYE_CACHE_TTL_MS = 300000
```

These defaults intentionally spend less than a full day of the Standard monthly CU budget in one
validation run.

## Non-Goals

Phase 9.4 must not:

- enable paper BUY automation,
- call `paper:execute`,
- create orders,
- create fills,
- create positions,
- load wallets,
- sign transactions,
- submit transactions,
- use Birdeye WebSockets,
- use Birdeye batch endpoints,
- use Birdeye as executable quote evidence,
- change default strategy thresholds,
- promote a profile,
- log API keys or raw sensitive provider payloads.

## Provider Model

Add provider:

```text
BIRDEYE
```

Capabilities:

```text
PRICE
TOKEN_METADATA, only if token overview fields can be mapped safely
LIQUIDITY, only if a defensible DexPairSnapshot can be produced
```

Preferred first-pass implementation:

```text
BirdeyeAdapter implements PriceProvider.
BirdeyeAdapter optionally implements TokenMetadataProvider from token_overview identity fields.
Birdeye overview/market activity fields are stored in compact raw/reference context first.
Do not add a new shared MARKET_DATA capability unless existing interfaces become too awkward.
```

Rationale:

```text
Existing shared types already support TokenPriceSnapshot, TokenMetadataSnapshot, and DexPairSnapshot.
Phase 9.4 should avoid a migration-heavy data model expansion unless validation proves it is needed.
```

## Environment And Config

Add config:

```text
BIRDEYE_API_KEY
BIRDEYE_BASE_URL=https://public-api.birdeye.so
BIRDEYE_RATE_LIMIT_PER_MINUTE=60
BIRDEYE_TIMEOUT_MS, optional provider-specific override only if the existing timeout model supports it cleanly

BIRDEYE_ENABLED=true
BIRDEYE_PRICE_ENABLED=true
BIRDEYE_TOKEN_OVERVIEW_ENABLED=true
BIRDEYE_MARKET_DATA_ENABLED=false
BIRDEYE_EXIT_LIQUIDITY_ENABLED=false
BIRDEYE_CREDITS_CHECK_ENABLED=true

BIRDEYE_CACHE_ENABLED=true
BIRDEYE_CACHE_TTL_MS=300000
BIRDEYE_MAX_REQUESTS_PER_RUN=60
BIRDEYE_MAX_CU_PER_RUN=1200
BIRDEYE_MAX_CANDIDATES_PER_CYCLE=2
BIRDEYE_MIN_SCORE=50
BIRDEYE_OVERVIEW_FRAMES=1m,5m,15m,30m,1h
```

Provider defaults:

```text
PROVIDERS_ENABLED=DEXSCREENER,JUPITER,RAYDIUM,SOLANA_RPC,QUICKNODE_DAS,BIRDEYE
```

Optional Helius smoke:

```text
Helius credits may be available again, but do not put Helius back into long-run defaults just
because credits reset. SOLANA_RPC remains the default authority provider. Helius can be tested in a
separate provider smoke or short metadata/risk comparison run.
```

## Selection Policy

Create a small selector that decides which candidates can spend Birdeye budget.

Candidate inputs:

```text
TokenRadar
latest RiskAssessment
latest StrategyDecision
latest TokenEnrichmentSnapshot
score attribution
missingQuote flag
liquidity/volume/age fields from DexScreener
provider budget state
```

Selection order:

```text
1. WATCH decisions with risk PASS.
2. High-scoring SKIP decisions with blockers=score_threshold_only or unresolved_strategy_gate.
3. PASS risk candidates with missingQuote and promising DexScreener liquidity/volume.
4. Missed-opportunity candidates during report-only replay.
```

Hard caps:

```text
per cycle candidate cap
per run request cap
per run CU cap
1 RPS-compatible limiter
cache lookup before live call
```

## Data Mapping

Map `/defi/price` to:

```text
TokenPriceSnapshot.priceUsd
TokenPriceSnapshot.source = BIRDEYE
TokenPriceSnapshot.confidence = MEDIUM or HIGH when response is complete
```

Map `/defi/token_overview` to compact enrichment context:

```text
symbol
name
price
liquidity
marketCap
fdv
holder count
trade count by selected frame
buy/sell count by selected frame
buy/sell volume by selected frame
unique wallet activity by selected frame
price change by selected frame
last trade time
```

Map to `DexPairSnapshot` only if Birdeye response includes pair-like context that can be represented
without lying:

```text
dexId
pairAddress
baseMint
quoteMint
liquidityUsd
volume5m / volume1h / volume24h
pairCreatedAt
```

If Birdeye returns token-level aggregate data rather than pair data:

```text
Do not force it into DexPairSnapshot.
Keep it as Birdeye market context in provider-health/report context first.
```

## Provider Health And Diagnostics

Record ProviderHealth rows for:

```text
BIRDEYE:price
BIRDEYE:token-overview
BIRDEYE:market-data, if enabled
BIRDEYE:credits, if enabled
```

Context fields:

```text
birdeyeEndpoint
birdeyeCuCost
birdeyeCuBudgetRemainingEstimate
birdeyeCacheStatus = HIT | MISS | BYPASS
birdeyeSelectionReason
birdeyeFrames
birdeyePriceAvailable
birdeyeLiquidityAvailable
birdeyeVolumeAvailable
birdeyeTradeActivityAvailable
birdeyeFailureCategory
```

Failure categories:

```text
BIRDEYE_NOT_CONFIGURED
BIRDEYE_RATE_LIMITED
BIRDEYE_CU_BUDGET_EXHAUSTED
BIRDEYE_UNAUTHORIZED
BIRDEYE_FORBIDDEN
BIRDEYE_BAD_REQUEST
BIRDEYE_UNAVAILABLE
BIRDEYE_TIMEOUT
BIRDEYE_INVALID_RESPONSE
BIRDEYE_ACCESS_DENIED_FOR_ENDPOINT
```

## Reporting Work

Update reports to include:

```text
Birdeye request count
Birdeye estimated CU spent
Birdeye live/cached/skipped counts
Birdeye endpoint distribution
Birdeye failure distribution
Birdeye selected-candidate reasons
Birdeye effect on missing market data
Birdeye effect on score attribution
Birdeye-enriched vs non-Birdeye candidate outcomes
```

Do not claim Birdeye fixed executable quote confidence.

Instead report:

```text
missingExecutableQuote
marketDataAvailable
birdeyePriceAvailable
birdeyeOverviewAvailable
```

This distinction matters because Birdeye price/overview evidence can improve market confidence, but
it does not prove route execution, slippage, or price impact.

## Strategy Boundary

Phase 9.4 may add report-only attribution such as:

```text
wouldHaveHadMarketDataWithBirdeye = true
birdeyeMomentumSignal = POSITIVE | NEUTRAL | NEGATIVE | UNKNOWN
birdeyeBuySellPressure = POSITIVE | NEUTRAL | NEGATIVE | UNKNOWN
```

Phase 9.4 must not:

```text
change StrategyScoringService default weights
change BUY/WATCH thresholds
turn Birdeye momentum into BUY
turn Birdeye missing data into FAIL
```

If Birdeye evidence appears useful, promote it later through a separate calibration/promotion phase.

## Helius Policy

Helius is available again if credits have reset, but Phase 9.4 should not reintroduce Helius as a
high-volume dependency.

Recommended policy:

```text
SOLANA_RPC remains default authority evidence.
Helius may be enabled in provider smoke.
Helius may be used for low-volume metadata/risk comparison if explicitly configured.
Long validation runs should keep Helius disabled unless the test is specifically named as a Helius comparison.
```

Reason:

```text
Phase 9.3C proved authority evidence no longer needs Helius.
Birdeye Standard also has a tight free budget.
Running both expensive providers broadly would recreate the credit-exhaustion problem.
```

## Implementation Chunks

Status: chunks 1-8 implemented. Phase 9.4 is ready for provider smoke and validation runs.

### Chunk 1 - Docs And Config

Tasks:

- Add `BIRDEYE` to shared provider names.
- Add Birdeye API key/base URL/rate limit config.
- Add Birdeye runtime flags and budget settings.
- Add disabled-provider reason when `BIRDEYE` is requested without `BIRDEYE_API_KEY`.
- Update provider docs and `.env` documentation if present.
- Add config tests for valid, missing, and disabled Birdeye setups.

Acceptance:

```text
PROVIDERS_ENABLED including BIRDEYE works when BIRDEYE_API_KEY is set.
BIRDEYE is disabled with a clear reason when key is missing.
Default providers do not include BIRDEYE unless explicitly configured.
```

### Chunk 2 - Birdeye Schemas And Mapper

Tasks:

- Add `backend/src/providers/birdeye/birdeye.schemas.ts`.
- Add `backend/src/providers/birdeye/birdeye.mappers.ts`.
- Validate `/defi/price` responses.
- Validate `/defi/token_overview` responses conservatively.
- Map price to `TokenPriceSnapshot`.
- Map overview identity fields to `TokenMetadataSnapshot` only when safe.
- Keep unsupported fields in compact sanitized context.

Acceptance:

```text
Mapper tests cover complete response, missing optional fields, invalid response, and zero/empty values.
No raw API key or raw unbounded payload is logged.
```

### Chunk 3 - Birdeye Cache And Budget

Tasks:

- Add in-memory cache keyed by endpoint + mint + frames.
- Add per-run budget tracker for request count and estimated CU usage.
- Add selection reasons.
- Add budget-exhausted skip behavior.
- Record cache hits separately from live calls.

Acceptance:

```text
Repeated same-mint enrichment hits cache.
Budget exhaustion skips Birdeye calls without failing the pipeline.
ProviderHealth shows cache/budget context.
```

### Chunk 4 - Birdeye Adapter

Tasks:

- Add `backend/src/providers/birdeye/BirdeyeAdapter.ts`.
- Implement `PriceProvider.getPrice`.
- Optionally implement token overview fetch helper.
- Use headers:

```text
X-API-KEY: <key>
x-chain: solana
```

- Use configured base URL and rate limit.
- Classify 401/403/429/5xx failures.
- Fail closed when account package cannot access an endpoint.

Acceptance:

```text
providers:smoke can run a Birdeye price check on wrapped SOL.
Birdeye 429 is reported as rate-limited.
Birdeye access denial is reported as endpoint/package access denied.
```

### Chunk 5 - Provider Registry And MarketDataService

Tasks:

- Register `BirdeyeAdapter` when enabled and configured.
- Decide provider ordering:

```text
Price providers:
  DEXSCREENER/JUPITER existing behavior first unless Phase 9.4 explicitly scopes Birdeye-first.

Metadata providers:
  SOLANA_RPC
  QUICKNODE_DAS
  ALCHEMY_DAS
  HELIUS if enabled
  BIRDEYE if overview metadata mapping is implemented
```

- Avoid causing Birdeye calls during broad scanner enrichment unless selector allows it.

Acceptance:

```text
Birdeye is present in registry when enabled.
Broad scanner run does not spend Birdeye budget on every candidate.
```

### Chunk 6 - Selective Enrichment Service

Tasks:

- Add a service such as `BirdeyeSelectiveEnrichmentService`.
- Select high-intent candidates from latest strategy/risk/radar rows.
- Enrich at most configured candidates per cycle.
- Write evidence into existing snapshots or provider-health context without migration if possible.
- Keep database writes optional and narrowly scoped.

Acceptance:

```text
High-intent candidates are enriched.
Low-score broad scanner candidates are skipped.
Skipped due to budget is reported, not treated as provider failure.
```

### Chunk 7 - Reports

Tasks:

- Update analytics report provider health section.
- Update calibration provider impact section.
- Update research aggregate provider pressure.
- Update research interpretation provider diagnostics.
- Add Birdeye-enriched candidate outcome comparison.

Acceptance:

```text
Reports can answer:
  Did Birdeye run?
  How much budget did it spend?
  Which candidates received Birdeye evidence?
  Did Birdeye reduce missing market data?
  Did Birdeye-enriched candidates perform differently?
```

### Chunk 8 - Scripts And Smoke Tests

Tasks:

- Update `providers:smoke` with optional Birdeye checks.
- Add a short Birdeye-only smoke path.
- Ensure missing key results in skipped/disabled, not crash.
- Add validation runbook section.

Acceptance:

```text
corepack pnpm verify passes.
providers:smoke passes with BIRDEYE enabled and key present.
providers:smoke passes with BIRDEYE disabled when key absent.
```

## Validation Plan

Before long validation:

```powershell
cd U:\Projects\NeXusTrade-Otis

corepack pnpm verify

$env:PROVIDERS_ENABLED = "DEXSCREENER,JUPITER,RAYDIUM,SOLANA_RPC,QUICKNODE_DAS,BIRDEYE"

corepack pnpm providers:smoke
```

One short smoke:

```powershell
corepack pnpm db:reset:paper

$run = "phase9.4-smoke-$(Get-Date -Format 'yyyyMMdd-HHmm')"

corepack pnpm terminal:run --max-runtime-minutes=15 --interval-ms=60000 --output-dir="data\$run"
```

Full validation:

```text
Run one 120-minute validation first.
Wait 60 minutes for tail maturity.
Run watchlist, analytics, calibration, and shadow calibration reports.
Archive the run.
Review CU usage and provider pressure.
Only run two more validations if the first run shows Birdeye is healthy and budget usage is safe.
```

Recommended validation provider set:

```text
DEXSCREENER,JUPITER,RAYDIUM,SOLANA_RPC,QUICKNODE_DAS,BIRDEYE
```

Optional Helius comparison provider set:

```text
DEXSCREENER,JUPITER,RAYDIUM,SOLANA_RPC,QUICKNODE_DAS,HELIUS,BIRDEYE
```

Use the optional Helius set only for a named comparison run.

## Success Criteria

Phase 9.4 succeeds when:

```text
corepack pnpm verify passes.
providers:smoke can verify Birdeye with no secrets in output.
Birdeye is disabled cleanly when no API key is configured.
Birdeye live calls respect 1 RPS and per-run CU budget.
Birdeye calls are selective, not broad-scanner-wide.
ProviderHealth reports Birdeye endpoint, cache, CU estimate, failure category, and selection reason.
Reports show Birdeye-enriched vs non-Birdeye outcomes.
missingAuthority remains 0 or near 0 with SOLANA_RPC.
orders/fills/positions remain 0.
paper BUY automation remains disabled.
Phase 9.4 conclusion decides whether to proceed to Phase 9.5, 9.6, 9.26, or provider-aware scoring research.
```

## Expected Outcomes

Expected:

```text
Birdeye improves market-data availability for a small number of high-intent candidates.
Birdeye does not solve executable quote availability by itself.
Jupiter/Raydium quote pressure remains visible.
Reports become better at explaining whether missing quote and missing market data are separate problems.
```

Possible outcomes:

```text
Outcome A: Birdeye Standard budget is enough for high-intent enrichment.
  Continue with selective Birdeye and analyze enriched outcomes.

Outcome B: Birdeye data is useful but budget is too tight.
  Keep it as report-only/manual enrichment until upgrade is justified.

Outcome C: Birdeye does not improve decision quality.
  Do not expand Birdeye usage; move to quote-provider alternatives.

Outcome D: Birdeye shows strong market signals but no executable quotes.
  Plan provider-aware quote confidence or counterfactual analysis before strategy changes.
```

## Information Needed From User

Before implementation validation:

```text
BIRDEYE_API_KEY added to .env locally.
Confirmation whether Birdeye account is still Standard/free.
Optional: whether Helius should be included in a separate comparison smoke after credits reset.
```

Do not paste API keys into chat.

## References

- Birdeye data accessibility by package: https://docs.birdeye.so/docs/data-accessibility-by-packages
- Birdeye compute unit cost: https://docs.birdeye.so/docs/compute-unit-cost
- Birdeye Token Overview endpoint: https://docs.birdeye.so/reference/get-defi-token_overview
- Birdeye Price Volume Single endpoint: https://docs.birdeye.so/reference/get-defi-price_volume-single
- Birdeye pricing / Standard free tier: https://beta-bds.birdeye.so/pricing
