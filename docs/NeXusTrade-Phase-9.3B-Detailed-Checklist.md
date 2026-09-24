# NeXusTrade Phase 9.3B Detailed Checklist

Raydium diagnostics and Helius pressure cleanup

Last updated: July 2026

## Status

Implemented; validation complete.

Phase 9.3B is a cleanup phase after the first Raydium fallback validation batch. It should improve
diagnostics and reduce provider pressure before the project decides whether to collect more
Raydium data, move to Birdeye, add another fallback, or return to strategy/risk calibration.

Phase 9.3B must remain research-only and paper-safe.

## Final Validation Conclusion

Phase 9.3B validation completed on July 16, 2026 with smoke checks and three full TerminalRunner
runs.

Safety passed across the validation batch:

```text
mode = PAPER
shadowOnly = true
orders = 0
fills = 0
positions = 0
wallet loaded = no
transaction signing = disabled
transaction submission = disabled
paper BUY automation = disabled
```

Run summary:

```text
Test 1: Helius enabled, quota-exhausted behavior observed
Test 2: Helius enabled, quota-exhausted behavior observed
Test 3: Helius disabled
```

Provider findings:

```text
Helius:
  Free-plan credits were exhausted on July 16, 2026.
  Helius-enabled validation showed 100% rate-limited behavior.
  This was account-level quota exhaustion, not primarily an application bug.

Jupiter:
  Jupiter remained usable but pressured.
  Test 2 combined rate-limited = 52.42%
  Test 3 combined rate-limited = 49.91%

Raydium:
  Raydium diagnostics worked and classified failures.
  Full-run Raydium quote outcomes remained 0% OK.
  Test 2 Raydium errors = 1157, all RAYDIUM_UNAVAILABLE / preflight FAILED
  Test 3 Raydium errors = 1070, all RAYDIUM_UNAVAILABLE / preflight FAILED
```

Strategy and research findings:

```text
BUY = 0 across the validation batch
Test 2 strategy decisions = SKIP=466
Test 3 strategy decisions = SKIP=437
Missing quote improved when Helius was disabled but remained high:
  Test 2 missingQuote = 363 / 466 = 77.9%
  Test 3 missingQuote = 284 / 437 = 65.0%
Missing authority evidence remained broad without usable Helius evidence.
```

Decision:

```text
Do not move to paper BUY.
Do not continue unchanged Phase 9.3B validation.
Do not jump directly to Birdeye solely because Helius is exhausted.
Next phase should be Phase 9.3C: Helius fallback / RPC authority evidence.
```

Recommended Phase 9.3C direction:

```text
Primary: raw Solana RPC mint-account parsing for mint authority, freeze authority, decimals, supply, and token program.
Secondary: QuickNode DAS metadata/asset fallback.
Tertiary: Alchemy DAS fallback.
Optional later fallback: Shyft token info, rate-limited and selective only.
```

## Why This Phase Exists

Phase 9.3 implemented Raydium as a quote-only fallback and ran three validation runs.

Safety passed:

```text
validRuns = 3/3
oneSession = yes
mode = PAPER
orders = 0
fills = 0
positions = 0
wallet loaded = no
transaction signing = disabled
transaction submission = disabled
paper BUY automation = disabled
```

Raydium improved quote coverage, but its operational health was weak:

```text
Raydium total rows = 595
Raydium OK = 7.7311%
Raydium ERROR = 91.7647%
Raydium liveRateLimited = 0%
Raydium quoteSourceTypes = CACHE:3 | LIVE:23
Raydium fallbackReasons = JUPITER_COOLDOWN:15 | JUPITER_RATE_LIMITED:11
```

Quote coverage improved versus Phase 9.2B:

```text
Decision-level missingQuote:
Phase 9.2B = 311 / 468 = 66.45%
Phase 9.3  = 115 / 270 = 42.59%

Mint-level missingQuote:
Phase 9.2B = 15 / 35 = 42.86%
Phase 9.3  =  4 / 24 = 16.67%

Jupiter liveRateLimited:
Phase 9.2B = 15.92%
Phase 9.3  =  8.53%

Jupiter combinedRateLimited:
Phase 9.2B = 44.68%
Phase 9.3  = 24.66%
```

But Helius became the new pressure problem:

```text
Helius aggregate liveRateLimited = 54.5614%
Test 2 Helius liveRateLimited = 100%
Test 3 Helius liveRateLimited = 100%
```

Interpretation:

```text
Raydium fallback path exists.
Raydium quote coverage is not healthy enough yet.
MissingQuote improved but still matters.
RISK_NOT_PASS is now the dominant decision blocker.
Helius metadata/risk evidence pressure is now a major provider bottleneck.
```

## Updated Raydium Docs Notes

Use the current Raydium docs index before implementation:

```text
https://docs.raydium.io/llms.txt
https://docs.raydium.io/mcp
```

The current Raydium docs index lists these relevant surfaces:

```text
Route API v2 compute quote:
Compute swap quote (base input)
Calculate expected output amount when swapping a fixed input amount.
Useful for displaying a preview before transaction building.

Route API v2 transaction build:
Build swap transaction (base input)
Requires a successful compute response from /compute/swap-base-in.

API v3 mint price:
Get mint prices
Retrieve current USD prices for mint tokens.
Cached 5 seconds.

API v3 pool preflight:
Get pools by token mint
Filter pools by one or two token mints.
Mint ordering normalized internally.
Cached 60 seconds.

Aggregator integration:
Discover Raydium pools, quote across CPMM / CLMM / AMM v4, and route atomic swaps.
```

Implementation interpretation:

```text
Route API v2 /compute/swap-base-in = executable-style quote evidence
API v3 /mint/price = price enrichment, not quote evidence
API v3 /pools/info/mint = Raydium route/pool preflight, not quote evidence
Transaction build endpoints = forbidden in Phase 9.3B
```

Do not treat Raydium mint price as a successful quote. It can only support diagnostics such as:

```text
Raydium recognizes the mint
Raydium has a cached USD price
Raydium API v3 is reachable
```

## Non-Goals

Phase 9.3B must not:

- enable paper BUY automation,
- call `paper:execute`,
- create orders, fills, or positions,
- load wallets,
- sign transactions,
- submit transactions,
- call Raydium transaction build endpoints,
- call Raydium LaunchLab transaction submit endpoints,
- use Raydium mint price as quote evidence,
- use Raydium pool preflight as quote evidence,
- change strategy score weights,
- change strategy thresholds,
- promote a shadow-entry profile,
- add Birdeye,
- add Titan,
- add Autobahn,
- add Meteora or Orca quote adapters,
- add live trading behavior,
- persist raw provider payloads by default,
- log API keys, headers, wallet data, serialized transactions, or raw signed data.

## Success Criteria

Phase 9.3B is successful when:

```text
Raydium errors are classified by reason category
Raydium success=false message is captured in sanitized provider context
Raydium HTTP status is visible in provider context
Raydium quote request direction, txVersion, slippageBps, and amount category are visible
Raydium pool-preflight can identify likely no-route cases before quote compute
Raydium mint-price check can identify known/unknown mints without being treated as quote evidence
Raydium no-route behavior is distinguished from provider/mapping failures
Helius metadata/risk pressure is reduced or at least accurately classified
TerminalRunner/analytics/research reports show Raydium error categories
TerminalRunner/analytics/research reports show Helius live-vs-suppressed pressure
orders/fills/positions remain 0
paper BUY automation remains disabled
wallet loaded = no
transaction signing = disabled
transaction submission = disabled
```

Target measurement goals for the next validation batch:

```text
Raydium UNKNOWN error share decreases materially
Raydium classified no-route/unsupported-token share is visible
Helius liveRateLimited drops below the Phase 9.3 aggregate of 54.56%, or suppression/cooldown rows explain why it did not
MissingQuote does not regress materially from Phase 9.3 mint-level 16.67%
Provider reports still show Jupiter live and combined rate limits separately
```

## Runtime Defaults

Recommended Phase 9.3B defaults:

```text
RAYDIUM_DIAGNOSTICS_ENABLED=true
RAYDIUM_PRECHECK_ENABLED=true
RAYDIUM_PRECHECK_TTL_MS=60000
RAYDIUM_MINT_PRICE_DIAGNOSTICS_ENABLED=false
RAYDIUM_CAPTURE_SANITIZED_ERROR_CONTEXT=true
RAYDIUM_MAX_ERROR_MESSAGE_LENGTH=240

HELIUS_METADATA_CACHE_ENABLED=true
HELIUS_RISK_EVIDENCE_CACHE_ENABLED=true
HELIUS_METADATA_CACHE_TTL_MS=3600000
HELIUS_RISK_EVIDENCE_CACHE_TTL_MS=3600000
HELIUS_BACKOFF_ENABLED=true
HELIUS_BACKOFF_BASE_COOLDOWN_MS=60000
HELIUS_BACKOFF_MAX_COOLDOWN_MS=600000
HELIUS_SKIP_LOW_PRIORITY_DURING_COOLDOWN=true
```

Implementation may choose shorter Helius TTLs if existing evidence proves metadata changes more
often than expected, but do not keep hammering Helius every cycle for the same mints.

## Raydium Error Classification

Add a normalized Raydium quote failure category.

Recommended enum:

```text
RaydiumQuoteFailureCategory =
  NO_ROUTE
  UNSUPPORTED_MINT
  UNSUPPORTED_TOKEN_PROGRAM
  BAD_AMOUNT
  BAD_REQUEST
  RATE_LIMITED
  RAYDIUM_UNAVAILABLE
  HTTP_ERROR
  RESPONSE_NOT_SUCCESSFUL
  SCHEMA_INVALID
  MAPPER_ERROR
  TIMEOUT
  UNKNOWN
```

Classification rules:

```text
HTTP 400 / validation-style message -> BAD_REQUEST or BAD_AMOUNT
HTTP 404 / no route-style message -> NO_ROUTE
HTTP 429 -> RATE_LIMITED
HTTP 5xx -> RAYDIUM_UNAVAILABLE
success=false with route/no pool wording -> NO_ROUTE
success=false with token/mint wording -> UNSUPPORTED_MINT
success=false with token program / Token-2022 wording -> UNSUPPORTED_TOKEN_PROGRAM
success=false with amount/slippage/input wording -> BAD_AMOUNT or BAD_REQUEST
schema parse failure -> SCHEMA_INVALID
mapper exception -> MAPPER_ERROR
request timeout -> TIMEOUT
unrecognized success=false -> RESPONSE_NOT_SUCCESSFUL
unrecognized exception -> UNKNOWN
```

ProviderHealth context should include sanitized fields only:

```text
operation = quote
raydiumFailureCategory
httpStatus
raydiumSuccess
raydiumMessage
requestInputMint
requestOutputMint
requestAmountRawLength
requestAmountMagnitudeBucket
slippageBps
txVersion
quotePriority
quoteFallbackReason
quoteProviderOrder
quoteAttemptedProviders
raydiumPreflightStatus
raydiumPoolsFound
raydiumMintPriceKnown
```

Do not include:

```text
headers
API keys
wallet addresses
serialized transactions
full raw payloads by default
large route plans
```

## Raydium Pool Preflight

Use Raydium API v3 pool-by-token-mint as an optional preflight before quote compute.

Purpose:

```text
Avoid hammering quote compute when Raydium likely has no pool/route.
Classify no-route cases earlier.
Measure whether quote failures correlate with missing Raydium pools.
```

Behavior:

```text
If preflight disabled:
  current Phase 9.3 quote behavior remains.

If preflight enabled and no pool found:
  skip Raydium quote compute for that request.
  record Raydium provider health as DEGRADED or ERROR only if appropriate.
  record router/provider context as raydiumFailureCategory=NO_ROUTE.
  do not fabricate a QuoteResult.

If preflight enabled and pool found:
  attempt Raydium quote compute.

If preflight itself fails:
  do not block the quote attempt unless failure indicates rate limit/cooldown.
  record preflight failure separately from quote failure.
```

Cache:

```text
cache key = inputMint | outputMint, normalized both directions when docs confirm ordering
ttl = 60000 ms by default
store pool count and product type summary when available
do not persist raw pool payloads
```

Acceptance tests:

- preflight no-pool result skips Raydium quote compute when enabled,
- preflight pool-found result allows quote compute,
- preflight failure does not become fake missing quote,
- preflight cache prevents duplicate API v3 calls for the same mint pair,
- preflight context appears in ProviderHealth,
- quote result is never fabricated from pool preflight alone.

## Raydium Mint Price Diagnostics

Use Raydium API v3 mint price only as optional diagnostics.

Purpose:

```text
Determine whether Raydium recognizes the mint.
Compare quote failures where Raydium has a price versus no price.
Support provider-health interpretation without using price as executable quote evidence.
```

Behavior:

```text
If RAYDIUM_MINT_PRICE_DIAGNOSTICS_ENABLED=false:
  do nothing.

If enabled:
  request price for candidate output mint and optionally SOL input mint.
  cache for 5000 ms or longer if needed to respect provider pressure.
  record raydiumMintPriceKnown=true/false.
  never set QuoteResult from mint price alone.
```

Acceptance tests:

- mint-price known is reported separately from quote success,
- missing mint price does not fail the quote router,
- mint price cannot satisfy risk price-impact evidence,
- no strategy score changes occur from mint price diagnostics.

## Helius Pressure Cleanup

Phase 9.3B should reduce avoidable repeated Helius metadata/risk calls.

Observed problem:

```text
Phase 9.3 aggregate Helius liveRateLimited = 54.56%
Test 2 Helius liveRateLimited = 100%
Test 3 Helius liveRateLimited = 100%
```

Recommended approach:

```text
Add in-memory metadata cache by mint.
Add in-memory risk-evidence cache by mint.
Add Helius provider-operation backoff.
Skip low-priority Helius calls during cooldown.
Record cache hits and cooldown skips separately from live rate limits.
Do not convert missing Helius evidence into PASS.
Keep unknown authority evidence as WARN.
```

ProviderHealth context additions:

```text
heliusEvidenceSource = LIVE | CACHE | SKIPPED_COOLDOWN | UNAVAILABLE
heliusEvidenceType = TOKEN_METADATA | RISK_EVIDENCE
heliusCacheStatus = HIT | MISS | BYPASS
heliusCooldownSkipped = true | false
heliusFallbackReason = RATE_LIMITED | COOLDOWN | UNAVAILABLE | NONE
```

Acceptance tests:

- repeated metadata requests for the same mint can hit cache,
- repeated risk-evidence requests for the same mint can hit cache,
- a Helius rate-limit response starts cooldown,
- low-priority requests are skipped during cooldown,
- skipped cooldown is not counted as live Helius rate limit,
- cached unknown authority remains WARN, not PASS,
- risk engine behavior remains deterministic.

## Reporting Updates

Update these reports to include Raydium and Helius diagnostics:

```text
TerminalRunner provider pressure
analytics:report provider health
calibration:report provider impact
research:aggregate provider pressure
research:interpret provider interpretation
providers:smoke
```

New report fields:

```text
raydiumFailureCategoryCounts
raydiumPreflightStatusCounts
raydiumPoolsFoundCount
raydiumMintPriceKnownCount
heliusEvidenceSourceCounts
heliusCacheHits
heliusCooldownSkips
heliusLiveRateLimited
heliusCombinedRateLimited
```

Reports should answer:

```text
Are Raydium errors mostly no-route, unsupported mint, bad request, or provider outage?
Did pool preflight reduce useless quote calls?
Did Helius cache/backoff reduce live rate limiting?
Did missingQuote improve, stay flat, or regress?
Did RISK_NOT_PASS remain the dominant blocker?
```

## Proposed Files

Add:

```text
backend/src/providers/raydium/RaydiumErrorClassifier.ts
backend/src/providers/raydium/RaydiumErrorClassifier.test.ts
backend/src/providers/raydium/RaydiumPreflightCache.ts
backend/src/providers/raydium/RaydiumPreflightCache.test.ts
backend/src/providers/raydium/RaydiumPoolPreflightService.ts
backend/src/providers/raydium/RaydiumPoolPreflightService.test.ts
backend/src/providers/raydium/raydium.pool.schemas.ts
backend/src/providers/raydium/raydium.pool.mappers.ts
backend/src/providers/raydium/raydium.mintPrice.schemas.ts
backend/src/providers/raydium/raydium.mintPrice.mappers.ts
backend/src/providers/helius/HeliusEvidenceCache.ts
backend/src/providers/helius/HeliusEvidenceCache.test.ts
backend/src/providers/helius/HeliusBackoffPolicy.ts
backend/src/providers/helius/HeliusBackoffPolicy.test.ts
```

Modify:

```text
backend/src/providers/raydium/RaydiumAdapter.ts
backend/src/providers/raydium/RaydiumAdapter.test.ts
backend/src/providers/raydium/raydium.schemas.ts
backend/src/providers/raydium/raydium.mappers.ts
backend/src/providers/config/providerConfig.ts
backend/src/config/env.test.ts
backend/src/providers/ProviderRegistry.ts
backend/src/providers/ProviderPressureClassifier.ts
backend/src/providers/ProviderPressureClassifier.test.ts
backend/src/providers/helius/HeliusAdapter.ts
backend/src/providers/helius/helius.mappers.ts
backend/src/providers/MarketDataService.ts
backend/src/risk/RiskEvidenceRefreshService.ts
backend/src/risk/RiskAssessmentWriter.ts
backend/src/terminal-runner/TerminalRunSummary.ts
backend/src/analytics/AnalyticsReportService.ts
backend/src/analytics/AnalyticsReportFormatter.ts
backend/src/calibration/ProviderImpactAnalyzer.ts
backend/src/calibration/CalibrationReportFormatter.ts
backend/src/research/CrossRunResearchService.ts
backend/src/research/ResearchAggregateReportFormatter.ts
backend/src/research-interpretation/ProviderInterpretationService.ts
backend/src/scripts/providers-smoke.ts
docs/Provider-Architecture.md
docs/Provider-Strategy-Phase9Plus.md
docs/ROADMAP_Phase9Plus.md
docs/Structure_Phase9Plus.md
docs/DECISIONS_Phase9Plus.md
docs/Phase-9-Planning-Inputs.md
```

No DB migration is expected. If implementation proves persistent provider diagnostics are required,
stop and write a migration note before adding columns.

## Implementation Result

Phase 9.3B implementation added:

```text
Raydium quote failure classifier
Raydium API v3 pool preflight service with TTL cache
Raydium API v3 mint-price diagnostic mapper/schema
sanitized Raydium provider-health context
Helius metadata/risk evidence cache
Helius getAsset backoff and cooldown skip behavior
provider-pressure counts for Raydium failures/preflight and Helius evidence sources/cache
TerminalRunner, analytics, calibration, research aggregate, and research interpretation report fields
focused unit tests for Raydium classifier/preflight/cache and Helius cache/backoff/adapter behavior
```

No DB migration was added. Provider diagnostics continue to use existing `ProviderHealth.contextJson`
with sanitized, bounded context fields.

Safety boundary after implementation:

```text
paper BUY automation = disabled
orders/fills/positions = not created by this phase
wallet loading = disabled
transaction signing = disabled
transaction submission = disabled
Raydium transaction build endpoints = not called
Raydium mint price = diagnostics only, not quote evidence
Raydium pool preflight = diagnostics/route precheck only, not quote evidence
```

Verification performed during implementation:

```text
corepack pnpm --filter @nexustrade/backend typecheck
corepack pnpm --filter @nexustrade/backend test -- src/providers
```

Both passed.

## Implementation Checklist

### 1. Config

- [x] Add Raydium diagnostic config:
  - `RAYDIUM_DIAGNOSTICS_ENABLED`
  - `RAYDIUM_PRECHECK_ENABLED`
  - `RAYDIUM_PRECHECK_TTL_MS`
  - `RAYDIUM_MINT_PRICE_DIAGNOSTICS_ENABLED`
  - `RAYDIUM_CAPTURE_SANITIZED_ERROR_CONTEXT`
  - `RAYDIUM_MAX_ERROR_MESSAGE_LENGTH`
- [x] Add Helius cache/backoff config:
  - `HELIUS_METADATA_CACHE_ENABLED`
  - `HELIUS_RISK_EVIDENCE_CACHE_ENABLED`
  - `HELIUS_METADATA_CACHE_TTL_MS`
  - `HELIUS_RISK_EVIDENCE_CACHE_TTL_MS`
  - `HELIUS_BACKOFF_ENABLED`
  - `HELIUS_BACKOFF_BASE_COOLDOWN_MS`
  - `HELIUS_BACKOFF_MAX_COOLDOWN_MS`
  - `HELIUS_SKIP_LOW_PRIORITY_DURING_COOLDOWN`
- [x] Validate positive TTLs and cooldowns.
- [x] Add env tests for defaults, explicit overrides, and invalid values.

### 2. Raydium Error Classifier

- [x] Implement `RaydiumErrorClassifier`.
- [x] Classify by HTTP status, provider error code, `success=false`, `msg`, schema failure, mapper
      failure, timeout, and unknown failure.
- [x] Keep classification deterministic and string-based.
- [x] Add focused tests for major Raydium failure categories.

### 3. Raydium Response Context

- [x] Preserve sanitized `success`, `msg`, and HTTP status when a Raydium response is unsuccessful.
- [x] Do not persist raw route plans or large payloads.
- [x] Add `raydiumFailureCategory` and `raydiumMessage` to ProviderHealth context.
- [x] Keep error messages bounded by `RAYDIUM_MAX_ERROR_MESSAGE_LENGTH`.
- [x] Keep sensitive fields out of Raydium diagnostic context by construction.

### 4. Raydium Pool Preflight

- [x] Add API v3 pool-by-token-mint schema and mapper.
- [x] Add preflight service with in-memory TTL cache.
- [x] Wire preflight before `swap-base-in` when enabled.
- [x] Classify no-pool preflight as `NO_ROUTE`.
- [x] Ensure preflight failure does not fabricate quote evidence.
- [x] Add tests for no-pool, pool-found, and cache-hit paths.

### 5. Raydium Mint Price Diagnostics

- [x] Add API v3 mint-price schema and mapper.
- [x] Keep disabled by default unless implementation review chooses otherwise.
- [x] When enabled, record whether mint price exists.
- [x] Do not turn mint price into `QuoteResult`.
- [x] Preserve this as diagnostics only; validation will determine whether more tests are needed.

### 6. Helius Cache And Backoff

- [x] Add metadata cache keyed by mint.
- [x] Add risk-evidence cache keyed by mint.
- [x] Add per-operation Helius backoff after rate-limit responses.
- [x] Skip low-priority metadata/risk calls during cooldown.
- [x] Record cache hits and cooldown skips distinctly.
- [x] Preserve conservative authority semantics:
  - absent/unknown Helius authority evidence remains `WARN`,
  - never infer confident disabled authority from missing evidence.

### 7. Provider Pressure Metrics

- [x] Extend provider-pressure summary types with:
  - `raydiumFailureCategoryCounts`,
  - `raydiumPreflightStatusCounts`,
  - `heliusEvidenceSourceCounts`.
- [x] Keep existing `liveRateLimited` and `combinedRateLimited` split.
- [x] Keep old Phase 9.2B/9.3 archives loadable when new fields are absent by merging optional maps as empty.

### 8. Report Formatting

- [x] Add compact report suffixes for:
  - Raydium failure categories,
  - Raydium preflight status,
  - Helius evidence source,
  - Helius cache/cooldown behavior.
- [x] Avoid bloating normal reports with raw payloads.
- [x] Include enough detail to answer whether Raydium errors are expected no-route failures or real
      adapter/provider failures.

### 9. Provider Smoke

- [x] Update `providers:smoke` to include:
  - Raydium quote compute smoke,
  - optional Raydium pool preflight smoke,
  - optional Raydium mint price smoke,
  - Helius cache/backoff diagnostic summary if Helius is enabled.
- [x] Keep smoke in `PAPER` mode.
- [x] Keep wallet/signing/submission disabled.

Note: `providers:smoke` now prints compact provider diagnostics from the smoke window, including
Raydium failure/preflight counts and Helius evidence/cache counts. It still does not load a wallet,
sign, submit, or treat diagnostics as quote evidence.

### 10. Tests

Run focused tests:

```powershell
corepack pnpm --filter @nexustrade/backend test -- Raydium
corepack pnpm --filter @nexustrade/backend test -- Helius
corepack pnpm --filter @nexustrade/backend test -- ProviderPressureClassifier
corepack pnpm --filter @nexustrade/backend test -- QuoteProviderRouter
```

Run full verification:

```powershell
corepack pnpm verify
```

## Validation Runbook

After implementation, run one smoke:

```powershell
cd U:\Projects\NeXusTrade-Otis

corepack pnpm verify

$env:PROVIDERS_ENABLED = "DEXSCREENER,JUPITER,HELIUS,RAYDIUM"

corepack pnpm providers:smoke
```

Then run one short TerminalRunner smoke:

```powershell
corepack pnpm db:reset:paper

$run = "phase9.3B-smoke-$(Get-Date -Format 'yyyyMMdd-HHmm')"

corepack pnpm terminal:run `
  --max-runtime-minutes=20 `
  --interval-ms=60000 `
  --output-dir="data\$run"
```

If the smoke is healthy, run one or two full validation runs:

```powershell
corepack pnpm db:reset:paper

$run = "phase9.3B-test1-$(Get-Date -Format 'yyyyMMdd-HHmm')"

Start-Transcript -Path "data\$run-transcript.txt"

corepack pnpm terminal:run `
  --max-runtime-minutes=120 `
  --interval-ms=60000 `
  --output-dir="data\$run"

Write-Host ""
Write-Host "Waiting 60 minutes so watchlist returns can mature..."
Start-Sleep -Seconds 3600

corepack pnpm watchlist:returns --once

corepack pnpm analytics:report --once | Tee-Object "data\$run-analytics-tail60.txt"

corepack pnpm calibration:report --once --max-hold-minutes=120 | Tee-Object "data\$run-calibration-tail60.txt"

corepack pnpm shadow:calibrate --once | Tee-Object "data\$run-shadow-calibrate-tail60.txt"

Stop-Transcript

$archive = "data\archive\phase9.3B\test1-$run"

New-Item -ItemType Directory -Force -Path $archive

Copy-Item "data\$run" $archive -Recurse -Force
Copy-Item "data\$run*.txt" $archive -Force
Copy-Item data\nexus_paper.db* $archive -Force

Write-Host "Archive Folder: $archive"
```

After full runs, aggregate:

```powershell
corepack pnpm research:aggregate --once `
  --label-run=T1:data/archive/phase9.3B/test1-<RUN_FOLDER>

corepack pnpm research:interpret --once `
  --label-run=T1:data/archive/phase9.3B/test1-<RUN_FOLDER>

corepack pnpm research:interpret --once `
  --dedupe-mode=first_per_mint `
  --label-run=T1:data/archive/phase9.3B/test1-<RUN_FOLDER>

corepack pnpm research:interpret --once `
  --dedupe-mode=best_per_mint `
  --label-run=T1:data/archive/phase9.3B/test1-<RUN_FOLDER>
```

For two full runs, pass both `--label-run` values.

## Exit Gate

Phase 9.3B ends only after:

```text
Raydium error categories are visible in reports
Raydium no-route / unsupported / provider-failure cases are distinguishable
Helius cache/backoff behavior is visible in reports
one provider smoke passes
one short TerminalRunner smoke passes
one or two validation runs complete
research:aggregate completes
research:interpret completes in decision, first_per_mint, and best_per_mint modes
```

Final review must choose one next step:

```text
Proceed to Phase 9.31 provider-aware quote confidence experiments
Proceed to Phase 9.26 counterfactual risk/decision analysis
Proceed to Phase 9.4 Birdeye selective enrichment
Evaluate another quote fallback before Birdeye
Collect one more Phase 9.3B run
```

Do not proceed to paper BUY or Phase 9.4 automatically.

## Known Limitations

- Raydium may legitimately lack routes for many newly launched meme tokens.
- Raydium API v3 mint price is cached price evidence, not executable quote evidence.
- Raydium pool preflight can reduce useless quote attempts but cannot prove executable output.
- Helius cache can reduce pressure but may preserve stale unknown evidence for the cache TTL.
- Better provider diagnostics may reveal that strategy/risk calibration remains the main blocker.
- Phase 9.3B does not solve authority evidence quality; it only reduces repeated pressure and
  reports unknowns more clearly.

## Handoff To Later Phases

Potential next phases:

```text
Phase 9.26 - Counterfactual risk/decision analysis
Phase 9.31 - Provider-aware quote confidence experiments
Phase 9.4  - Birdeye selective enrichment
Phase 9.5  - Autobahn/Titan access-gated quote fallback evaluation
Phase 9.6  - Meteora/Orca pool-specific quote adapters
```

Phase 9.3B should make the next choice evidence-driven:

```text
If Raydium errors are mostly no-route: pool-aware routing or another fallback may matter.
If Raydium errors are mostly bad requests: fix adapter parameters before more long runs.
If Helius pressure remains high: Birdeye or another metadata/risk source may matter.
If provider uncertainty drops but RISK_NOT_PASS dominates: Phase 9.26 counterfactual/risk analysis.
If quote/risk evidence improves and profiles still fail: return to entry/exit calibration.
```
