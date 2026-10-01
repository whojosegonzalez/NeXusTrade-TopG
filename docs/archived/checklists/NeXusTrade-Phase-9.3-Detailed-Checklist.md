# NeXusTrade Phase 9.3 Detailed Checklist

Raydium quote fallback

Last updated: July 2026

## Status

Implemented; validation pending.

Phase 9.3 adds Raydium as the first direct quote fallback behind the existing `QuoteProvider`
interface and quote router. It should improve quote confidence when Jupiter is rate-limited,
cooling down, or unavailable.

Phase 9.3 must remain research-only and paper-safe.

Implementation status:

```text
Raydium quote adapter = implemented
Raydium transaction endpoints = not called
Raydium API key requirement = none
quote provenance = implemented
fallback reason reporting = implemented
provider pressure source/fallback counts = implemented
paper BUY automation = disabled
wallet loading/signing/submission = disabled
validation runs = pending
```

## Why This Phase Exists

Phase 9.25 interpreted the cleaned Phase 9.2B research data:

```text
decision mode observed decisions = 468
unique mints = 35
missingQuote = 311 / 468
Jupiter liveRateLimited = 15.92%
Jupiter combinedRateLimited = 44.68%
cacheHits = 159
cooldownSkips = 1311
top blocker = RISK_NOT_PASS
selected recommendation = Phase 9.3 Raydium fallback
paper BUY automation = disabled
```

Dedupe checks reduced repeated-token amplification but did not remove the quote-confidence issue:

```text
first_per_mint missingQuote = 15 / 35
best_per_mint missingQuote = 15 / 35
```

Interpretation:

```text
Provider quote uncertainty is still real.
Repeated decisions amplified it, but did not invent it.
RISK_NOT_PASS remains the dominant blocker.
```

Phase 9.3 should answer:

```text
Can Raydium reduce missingQuote evidence?
Can Raydium reduce dependence on Jupiter during cooldown/rate-limit windows?
Does better quote coverage improve risk/strategy evidence quality?
Or are rejected/skipped candidates mostly blocked by non-provider evidence?
```

## Raydium Source Notes

Official Raydium Trade API docs describe:

```text
GET https://transaction-v1.raydium.io/compute/swap-base-in
```

for exact-input quote computation, with required query parameters:

```text
inputMint
outputMint
amount
slippageBps
txVersion
```

The same docs also describe transaction serialization endpoints:

```text
POST https://transaction-v1.raydium.io/transaction/swap-base-in
POST https://transaction-v1.raydium.io/transaction/swap-base-out
```

Phase 9.3 must use only the quote computation endpoint. It must not call transaction serialization
endpoints.

Reference:

- https://docs.raydium.io/raydium/for-developers/trade-api

## Credentials

No Raydium API key is required for the first Phase 9.3 implementation.

Add no `RAYDIUM_API_KEY` requirement unless the official API behavior changes during
implementation. If Raydium later introduces authenticated quote access, handle that in a separate
Phase 9.3B or Phase 9.4 planning update.

User action needed before implementation:

```text
None.
```

Optional `.env` change after implementation:

```text
PROVIDERS_ENABLED=DEXSCREENER,JUPITER,HELIUS,RAYDIUM
```

If `PROVIDERS_ENABLED` is absent, Phase 9.3 may choose to include `RAYDIUM` in the default provider
set. The implementation decision should be explicit and tested.

## Non-Goals

Phase 9.3 must not:

- enable paper BUY automation,
- call `paper:execute`,
- load wallets,
- sign transactions,
- submit transactions,
- call Raydium transaction serialization endpoints,
- execute swaps,
- create orders, fills, or positions,
- change production strategy score weights,
- change default strategy thresholds,
- promote any profile,
- add Birdeye,
- add Titan,
- add Autobahn,
- add Meteora or Orca,
- add paid provider dependencies,
- persist raw provider API payloads by default,
- log API keys, headers, raw transactions, or wallet data,
- add a database migration unless implementation proves it is unavoidable.

## Source Of Truth

Current provider surfaces:

```text
shared/src/providers/provider.types.ts
shared/src/market/quote.types.ts
backend/src/providers/interfaces/QuoteProvider.ts
backend/src/providers/config/providerConfig.ts
backend/src/providers/ProviderRegistry.ts
backend/src/providers/MarketDataService.ts
backend/src/providers/quotes/QuoteProviderRouter.ts
backend/src/providers/quotes/QuoteCache.ts
backend/src/providers/quotes/QuoteBackoffPolicy.ts
backend/src/providers/ProviderHealthService.ts
backend/src/providers/http/ProviderHttpClient.ts
backend/src/providers/http/providerRateLimiter.ts
backend/src/providers/jupiter/JupiterAdapter.ts
```

Current `QuoteRequest` fields:

```text
inputMint
outputMint
amountRaw
side
slippageBps
onlyDirectRoutes
maxAccounts
```

Current `QuoteResult` fields:

```text
inputMint
outputMint
inputAmountRaw
outputAmountRaw
inputAmountUi
outputAmountUi
estimatedPriceImpactPct
routeSummary
minimumOutAmountRaw
contextSlot
source
fetchedAt
rawReferenceId
provenance
```

Raydium Phase 9.3 should support exact-input quote requests only:

```text
QuoteRequest.amountRaw -> Raydium amount
QuoteRequest.inputMint -> Raydium inputMint
QuoteRequest.outputMint -> Raydium outputMint
QuoteRequest.slippageBps -> Raydium slippageBps
txVersion = V0 by default
```

## Files

Add:

```text
backend/src/providers/raydium/raydium.schemas.ts
backend/src/providers/raydium/raydium.mappers.ts
backend/src/providers/raydium/raydium.mappers.test.ts
backend/src/providers/raydium/RaydiumAdapter.ts
backend/src/providers/raydium/RaydiumAdapter.test.ts
```

Modify:

```text
shared/src/providers/provider.types.ts
shared/src/market/quote.types.ts
backend/src/providers/config/providerConfig.ts
backend/src/providers/ProviderRegistry.ts
backend/src/providers/quotes/QuoteProviderRouter.ts
backend/src/providers/quotes/QuoteProviderRouter.test.ts
backend/src/providers/ProviderRegistry.test.ts
backend/src/config/env.test.ts
backend/src/scripts/providers-smoke.ts
docs/Provider-Architecture.md
docs/Provider-Strategy-Phase9Plus.md
docs/ROADMAP_Phase9Plus.md
docs/Structure_Phase9Plus.md
docs/Phase-9-Planning-Inputs.md
docs/DECISIONS_Phase9Plus.md
```

No DB migration is expected.

## Runtime Defaults

Recommended Phase 9.3 config:

```text
RAYDIUM_BASE_URL=https://transaction-v1.raydium.io
RAYDIUM_RATE_LIMIT_PER_MINUTE=60
RAYDIUM_TX_VERSION=V0
```

Provider enablement:

```text
Default provider order:
DEXSCREENER
JUPITER
HELIUS
RAYDIUM

Default quote provider order:
JUPITER
RAYDIUM
```

Rules:

- `RAYDIUM` should not require an API key.
- `RAYDIUM` should be disabled only when omitted from `PROVIDERS_ENABLED`, if explicit provider
  enablement is configured.
- If default providers are updated, tests must assert the new default includes `RAYDIUM`.
- If default providers are not updated, the Phase 9.3 validation runbook must explicitly set
  `PROVIDERS_ENABLED=DEXSCREENER,JUPITER,HELIUS,RAYDIUM`.
- Quote cache remains per provider.
- Quote backoff remains per provider and operation.
- A Jupiter cooldown should not automatically cool down Raydium.

## Quote Provenance Contract

Phase 9.3 must make quote provenance explicit in normalized quote evidence.

Provider identity and quote acquisition mode should be separate concepts:

```text
quoteProvider = JUPITER | RAYDIUM
quoteSourceType = LIVE | CACHE
fallbackReason = NONE | JUPITER_RATE_LIMITED | JUPITER_COOLDOWN | JUPITER_UNAVAILABLE | ROUTER_POLICY | FORCED_PROVIDER
```

Do not encode cache state as fake provider names:

```text
avoid: CACHE_JUPITER
avoid: CACHE_RAYDIUM
use: quoteProvider=JUPITER, quoteSourceType=CACHE
use: quoteProvider=RAYDIUM, quoteSourceType=CACHE
```

When no quote is available, reports may display:

```text
quoteProvider = NONE
quoteSourceType = NONE
fallbackReason = <best known reason>
```

but no `QuoteResult` should be fabricated.

Recommended shared type additions:

```text
QuoteSourceType = LIVE | CACHE
QuoteFallbackReason =
  NONE
  JUPITER_RATE_LIMITED
  JUPITER_COOLDOWN
  JUPITER_UNAVAILABLE
  ROUTER_POLICY
  FORCED_PROVIDER

QuoteProvenance:
  quoteProvider
  quoteSourceType
  fallbackReason
  attemptedProviders
  providerOrder
```

`QuoteResult` should carry optional provenance so risk, strategy, analytics, calibration, and
research interpretation can later answer:

```text
Which provider produced this quote?
Was it live or cached?
Was Raydium used because Jupiter was rate-limited, cooling down, unavailable, policy-selected, or forced?
```

## Implementation Chunks

### 1. Provider Name And Config

Add `RAYDIUM` to provider names:

```text
shared/src/providers/provider.types.ts
```

Add Raydium config:

```text
ProviderApiKeys:
  no required Raydium key

ProviderBaseUrls:
  raydiumTrade

DEFAULT_BASE_URLS:
  raydiumTrade = https://transaction-v1.raydium.io

DEFAULT_RATE_LIMITS:
  RAYDIUM = 60
```

Add env parsing:

```text
RAYDIUM_BASE_URL
RAYDIUM_RATE_LIMIT_PER_MINUTE
RAYDIUM_TX_VERSION
```

Acceptance tests:

- `RAYDIUM` is a valid `ProviderName`.
- `RAYDIUM` can be requested without an API key.
- invalid `RAYDIUM_BASE_URL` fails config validation.
- `RAYDIUM_RATE_LIMIT_PER_MINUTE` must be positive.
- Raydium default tx version is `V0`.

### 1B. Quote Provenance Types

Update `shared/src/market/quote.types.ts`.

Add normalized quote provenance types:

```text
QuoteSourceType
QuoteFallbackReason
QuoteProvenance
```

Extend `QuoteResult` with optional provenance:

```text
provenance?: QuoteProvenance
```

Rules:

- Keep `QuoteResult.source` as the provider identity.
- Use `QuoteResult.provenance.quoteProvider` for explicit report-friendly provider identity.
- Use `QuoteResult.provenance.quoteSourceType` for `LIVE` versus `CACHE`.
- Use `QuoteResult.provenance.fallbackReason` only when the router knows why fallback happened.
- Do not add fake provider names for cache state.

Acceptance tests:

- Shared quote types compile with existing Jupiter quote mapping.
- Raydium quote mapping can attach `quoteProvider=RAYDIUM` and `quoteSourceType=LIVE`.
- Cached quote results can return `quoteSourceType=CACHE` while preserving the original provider.

### 2. Raydium Schema

Create `raydium.schemas.ts` for the quote response shape.

Minimum accepted quote response fields:

```text
success
id
data.inputMint
data.outputMint
data.inputAmount
data.outputAmount
data.otherAmountThreshold
data.slippageBps
data.priceImpactPct
data.routePlan
```

Route plan fields to capture when available:

```text
poolId
inputMint
outputMint
feeMint
feeRate
feeAmount
```

Rules:

- Treat `success=false` as provider failure.
- Treat missing `data` as invalid response.
- Treat missing output amount as invalid response.
- Preserve raw payload only when raw payload logging is enabled.

Acceptance tests:

- Parses a valid `swap-base-in` response.
- Rejects `success=false`.
- Rejects missing output amount.
- Allows route plans with unknown extra fields.

### 3. Raydium Mapper

Create `raydium.mappers.ts`.

Map Raydium quote to `QuoteResult`:

```text
inputMint = data.inputMint
outputMint = data.outputMint
inputAmountRaw = data.inputAmount
outputAmountRaw = data.outputAmount
minimumOutAmountRaw = data.otherAmountThreshold
estimatedPriceImpactPct = data.priceImpactPct
source = RAYDIUM
fetchedAt = http fetchedAt
rawReferenceId = id
routeSummary = routePlan mapped to QuoteRouteHop[]
provenance.quoteProvider = RAYDIUM
provenance.quoteSourceType = LIVE
provenance.fallbackReason = NONE unless router overrides it
```

Route summary mapping:

```text
label = poolId
inputMint = hop.inputMint
outputMint = hop.outputMint
```

Rules:

- Do not infer UI amounts unless decimals are known.
- Do not fabricate `contextSlot`.
- `priceImpactPct` should be numeric when Raydium returns a number or numeric string.
- Preserve warnings from the HTTP layer.

Acceptance tests:

- Maps output amount, minimum out, price impact, route summary, and reference id.
- Handles numeric-string `priceImpactPct`.
- Handles an empty route plan.
- Adds Raydium live quote provenance.

### 4. Raydium Adapter

Create `RaydiumAdapter.ts` implementing `QuoteProvider`.

Request:

```text
GET /compute/swap-base-in
query:
  inputMint
  outputMint
  amount
  slippageBps
  txVersion
```

Rules:

- Implement `QUOTE` only.
- Use `withProviderRetries`.
- Record provider health with operation `quote`.
- Use `ProviderHttpClient`.
- Return `ProviderResult<QuoteResult>`.
- Do not implement transaction serialization.
- Do not require or load wallet information.
- Do not sign or submit transactions.
- `onlyDirectRoutes` and `maxAccounts` are ignored by Raydium in Phase 9.3; add a warning if they
  are supplied and not supported.

Acceptance tests:

- Builds the correct GET request path/query.
- Returns mapped quote result on valid response.
- Returns provider failure on invalid response.
- Records provider health on success/failure when health service is supplied.
- Does not call any transaction endpoint.

### 5. Provider Registry Wiring

Update `ProviderRegistry.ts`.

Rules:

- Instantiate `RaydiumAdapter` when `RAYDIUM` is enabled.
- Use the configured Raydium base URL and rate limit.
- Raydium should be included in quote providers after Jupiter.
- Helius remains preferred for metadata.
- DexScreener behavior is unchanged.
- Jupiter metadata remains disabled by default.

Acceptance tests:

- Registry includes Raydium when requested.
- Registry omits Raydium when not requested.
- Quote provider router provider order is Jupiter then Raydium when both are enabled.
- Raydium does not affect metadata provider ordering.

### 6. Quote Router Fallback Observability

Update `QuoteProviderRouter` only if needed to make fallback success visible.

Required behavior:

```text
Jupiter cache hit -> return cached Jupiter quote; do not call Raydium
Jupiter live success -> return Jupiter quote; do not call Raydium
Jupiter rate-limited/failure -> try Raydium
Jupiter cooldown skip -> try Raydium unless all providers are cooling down
Raydium success -> return Raydium quote
Raydium failure -> return the final structured failure
```

Provider health context should preserve:

```text
quoteProviderOrder
quoteAttemptedProviders
quoteFallbackAttempted
quoteFallbackUsed
quoteProvider = JUPITER | RAYDIUM | NONE
quoteSourceType = LIVE | CACHE | NONE
quoteFallbackReason = NONE | JUPITER_RATE_LIMITED | JUPITER_COOLDOWN | JUPITER_UNAVAILABLE | ROUTER_POLICY | FORCED_PROVIDER
```

Acceptance tests:

- Raydium is attempted after Jupiter rate limit.
- Raydium is attempted after Jupiter cooldown skip.
- Raydium is not attempted after Jupiter cache hit.
- Raydium success sets `QuoteResult.source = RAYDIUM`.
- Raydium success records `quoteProvider=RAYDIUM`.
- Cached Jupiter success records `quoteProvider=JUPITER` and `quoteSourceType=CACHE`.
- Cached Raydium success records `quoteProvider=RAYDIUM` and `quoteSourceType=CACHE`.
- Raydium fallback after Jupiter rate limit records `fallbackReason=JUPITER_RATE_LIMITED`.
- Raydium fallback after Jupiter cooldown records `fallbackReason=JUPITER_COOLDOWN`.
- Raydium fallback after Jupiter unavailable/error records `fallbackReason=JUPITER_UNAVAILABLE`.
- Router health rows make fallback usage measurable.

### 7. Provider Smoke

Update `providers:smoke` output.

Rules:

- Raydium smoke should request a tiny SOL -> USDC quote or configurable mint pair.
- No wallet is required.
- No transaction endpoint is called.
- Strict mode should require Raydium only when `RAYDIUM` is requested/enabled.
- Missing Raydium key must not fail because no key is required.

Acceptance tests:

- Smoke output lists Raydium when enabled.
- Smoke output keeps wallet/signing/submission disabled.
- Strict smoke handles Raydium without an API key.

### 8. Reports And Analytics

Existing provider-pressure reports should automatically include `RAYDIUM` once provider health rows
exist.

Verify these surfaces:

```text
terminal:run
analytics:report
calibration:report
research:aggregate
research:interpret
providers:smoke
```

Expected new report fields/evidence:

```text
RAYDIUM total
RAYDIUM liveRateLimited
RAYDIUM error
Raydium quote success/failure counts
quote fallback used count
quote provider distribution: JUPITER | RAYDIUM | NONE
quote source type distribution: LIVE | CACHE | NONE
Raydium fallback reason distribution
missingQuote before/after comparison
```

Acceptance tests:

- TerminalRunner summaries can include `RAYDIUM`.
- Phase 9.25 interpretation can include `RAYDIUM` provider rows from future runs.
- Reports can distinguish Jupiter live quotes, Jupiter cached quotes, Raydium live quotes, Raydium
  cached quotes, and no-quote outcomes.
- Reports can summarize why Raydium was used.
- Existing Phase 9.2B archives still load even without Raydium rows.

### 9. Documentation

Update:

```text
Provider-Architecture.md
Provider-Strategy-Phase9Plus.md
ROADMAP_Phase9Plus.md
Structure_Phase9Plus.md
Phase-9-Planning-Inputs.md
DECISIONS_Phase9Plus.md
```

Documentation must state:

```text
Raydium quote fallback only
no Raydium API key needed for first pass
quote endpoint only
transaction endpoint forbidden in Phase 9.3
paper BUY automation disabled
validation compares Phase 9.2B/9.25 baseline to post-Raydium runs
quote provenance is recorded with normalized quotes
Raydium fallback reason is recorded when Raydium is attempted or used
Phase 9.3 has an explicit exit gate before Phase 9.4
```

## Safety Acceptance Criteria

Phase 9.3 passes safety if:

```text
mode = PAPER
wallet loaded = no
transaction signing = disabled
transaction submission = disabled
Raydium transaction endpoint calls = 0
orders = 0
fills = 0
positions = 0
paper BUY automation = disabled
strategy defaults unchanged
risk defaults unchanged
no raw payload logging by default
no new API keys required
```

## Verification Commands

Required:

```bash
corepack pnpm verify
```

Focused:

```bash
corepack pnpm --filter @nexustrade/backend test -- raydium
corepack pnpm --filter @nexustrade/backend test -- ProviderRegistry QuoteProviderRouter providerConfig
corepack pnpm --filter @nexustrade/backend typecheck
```

Provider smoke after implementation:

```powershell
corepack pnpm providers:smoke --strict
```

If strict smoke is too broad for the local `.env`, use the normal smoke first:

```powershell
corepack pnpm providers:smoke
```

## Post-Implementation Validation Runbook

After Phase 9.3 implementation, run one short smoke:

```powershell
cd U:\Projects\NeXusTrade-Otis

corepack pnpm verify
corepack pnpm providers:smoke
corepack pnpm terminal:run --once --output-dir=data/phase9.3-smoke
```

Then run three full validation runs using the existing Phase 9 TerminalRunner pattern:

```powershell
corepack pnpm db:reset:paper

$run = "phase9.3-test1-$(Get-Date -Format 'yyyyMMdd-HHmm')"

corepack pnpm terminal:run `
  --max-runtime-minutes=120 `
  --interval-ms=60000 `
  --output-dir="data\$run"

Write-Host "Waiting 60 minutes so watchlist returns can mature..."
Start-Sleep -Seconds 3600

corepack pnpm watchlist:returns --once
corepack pnpm analytics:report --once | Tee-Object "data\$run-analytics-tail60.txt"
corepack pnpm calibration:report --once --max-hold-minutes=120 | Tee-Object "data\$run-calibration-tail60.txt"
corepack pnpm shadow:calibrate --once | Tee-Object "data\$run-shadow-calibrate-tail60.txt"

$archive = "data\archive\phase9.3\test1-$run"
New-Item -ItemType Directory -Force -Path $archive
Copy-Item "data\$run" $archive -Recurse -Force
Copy-Item "data\$run-*.txt" $archive -Force
Copy-Item data\nexus_paper.db* $archive -Force
Write-Host "Archive Folder: $archive"
```

Repeat for `test2` and `test3` at different market windows.

After three runs:

```powershell
corepack pnpm research:aggregate --once `
  --label-run=T1:data/archive/phase9.3/test1-<run-label> `
  --label-run=T2:data/archive/phase9.3/test2-<run-label> `
  --label-run=T3:data/archive/phase9.3/test3-<run-label>

corepack pnpm research:interpret --once `
  --label-run=T1:data/archive/phase9.3/test1-<run-label> `
  --label-run=T2:data/archive/phase9.3/test2-<run-label> `
  --label-run=T3:data/archive/phase9.3/test3-<run-label>
```

## Success Criteria

Compare Phase 9.3 against the Phase 9.2B / Phase 9.25 baseline:

```text
baseline observed decisions = 468
baseline unique mints = 35
baseline missingQuote decision-level = 311 / 468
baseline missingQuote first_per_mint = 15 / 35
baseline missingQuote best_per_mint = 15 / 35
baseline Jupiter liveRateLimited = 15.92%
baseline Jupiter combinedRateLimited = 44.68%
```

Phase 9.3 succeeds if:

```text
missingQuote percentage decreases in decision-level analysis
missingQuote percentage decreases or does not worsen in deduped mint-level analysis
Raydium quote success rate > 0
Raydium fallback used count > 0 when Jupiter rate limits, cooldowns, or failures occur
Jupiter liveRateLimited does not increase materially
ProviderHealth clearly attributes provider pressure by JUPITER vs RAYDIUM
normalized QuoteResult records quote provider and live/cache source type
Raydium fallback reason is recorded when Raydium is attempted or used
research:interpret produces improved quote-confidence analysis
orders/fills/positions remain 0
paper BUY automation remains disabled
wallet loaded = no
transaction signing = disabled
transaction submission = disabled
Raydium transaction endpoint calls = 0
```

Phase 9.3 is useful even if strategy quality still requires Phase 9.26 or later calibration work,
but it should not be considered complete until quote coverage, provenance, fallback reasons, and
safety have all been measured.

## Exit Gate

Phase 9.3 ends only after:

```text
Raydium quote fallback is implemented
one provider/TerminalRunner smoke passes
three Phase 9.3 validation runs complete
research:aggregate completes across the three Phase 9.3 runs
research:interpret completes across the three Phase 9.3 runs
Phase 9.3 results are compared against the Phase 9.2B / Phase 9.25 baseline
```

The final Phase 9.3 review must choose one primary next step:

```text
Remain on Raydium and collect more data
Proceed to Phase 9.26 counterfactual decision analysis
Proceed to Phase 9.31 provider-aware quote confidence experiments
Proceed to Phase 9.4 Birdeye selective enrichment
Evaluate another quote fallback before Birdeye
```

Do not automatically proceed to Phase 9.4 only because it is next on the roadmap. Phase 9.3
validation should decide whether Birdeye is still the highest-value next phase.

## Known Limitations

- Raydium fallback may not cover every token route Jupiter can quote.
- Raydium may have undocumented or changing public endpoint rate limits.
- Raydium quote success does not prove execution quality.
- Raydium `swap-base-in` is exact-input only.
- Phase 9.3 does not compare actual swap execution outcomes.
- Better quote coverage may still leave `RISK_NOT_PASS` as the dominant blocker.

## Handoff To Later Phases

Possible next phases after Phase 9.3:

```text
Phase 9.26 - Counterfactual Decision Analysis
Phase 9.31 - Provider-aware quote confidence experiments
Phase 9.4  - Birdeye selective enrichment
Phase 9.5  - Autobahn/Titan access-gated quote fallback evaluation
Phase 9.6  - Meteora/Orca pool-specific quote adapters
```

The post-Raydium validation should decide the next step based on evidence:

```text
If missingQuote drops and strategy blockers remain: Phase 9.26
If Raydium helps but still lacks coverage: Phase 9.31 or Phase 9.5
If quote coverage improves enough for interpretation: tune profiles or counterfactuals
If provider errors dominate: provider hardening before strategy work
```
