# NeXusTrade Phase 9.2 Detailed Checklist

Quote cache, Jupiter backoff, and provider fallback framework

Last updated: July 2026

## Status

Implemented.

Phase 9.2 is a provider-resilience phase. It should reduce wasteful Jupiter quote demand, make
rate-limit behavior explicit, and create a clean fallback framework before adding Raydium, Birdeye,
Titan, Autobahn, Meteora, or Orca adapters.

## Implementation Progress

- [x] Checklist created and active docs updated.
- [x] Quote request identity implemented.
- [x] In-memory quote cache implemented.
- [x] Quote backoff policy implemented.
- [x] Quote priority model implemented.
- [x] Jupiter-only quote router implemented.
- [x] Provider config options added.
- [x] MarketDataService quote integration wired.
- [x] Provider health context improved for cache hits and cooldown skips.
- [x] Unit/integration tests added.
- [x] Documentation marked implemented.
- [x] Verification passed.

Verification:

```text
corepack pnpm verify = passed
shared tests = 4 files, 12 tests passed
backend tests = 60 files, 210 tests passed
secret check = passed
```

## Why This Phase Exists

Phase 9.1 aggregated the first valid Phase 9 TerminalRunner batch:

```text
validRuns = 3/3
observedDecisions = 277
uniqueMints = 13
Jupiter rateLimited = 52.67%
readiness = PROMISING_RESEARCH
controlledPaperPilotRecommended = no
paperBuyAutomationEnabled = no
```

Jupiter remains a meaningful bottleneck, but the next move should not be to spray requests across
more APIs. The safer next step is to:

- avoid duplicate quote calls,
- pause intelligently after provider rate limits,
- prioritize high-intent quote requests,
- preserve missing-quote evidence,
- prepare a fallback contract that future providers can use,
- keep research outputs auditable.

## Non-Goals

Phase 9.2 must not:

- enable paper BUY automation,
- run `paper:execute` from TerminalRunner,
- load wallets,
- sign transactions,
- submit transactions,
- add live-trading behavior,
- change strategy score weights,
- change strategy thresholds,
- promote any profile,
- add Raydium, Birdeye, Titan, Autobahn, Meteora, or Orca adapters,
- require a paid provider plan,
- persist raw provider API payloads by default,
- log API keys or authorization headers,
- add a database migration unless implementation proves it is unavoidable.

## Source Of Truth

Current provider surfaces:

```text
backend/src/providers/MarketDataService.ts
backend/src/providers/ProviderRegistry.ts
backend/src/providers/ProviderHealthService.ts
backend/src/providers/http/ProviderHttpClient.ts
backend/src/providers/http/providerRateLimiter.ts
backend/src/providers/jupiter/JupiterAdapter.ts
backend/src/providers/interfaces/QuoteProvider.ts
shared/src/market/quote.types.ts
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
```

## Implementation Chunks

### 1. Add Quote Request Identity

Create a small utility that normalizes quote requests into stable cache keys.

Proposed file:

```text
backend/src/providers/quotes/QuoteRequestKey.ts
```

Requirements:

- Include provider name.
- Include `inputMint`.
- Include `outputMint`.
- Include `amountRaw`.
- Include `side` when present.
- Include `slippageBps` when present.
- Include `onlyDirectRoutes` when present.
- Include `maxAccounts` when present.
- Sort or serialize fields deterministically.
- Do not include API keys, timestamps, raw payloads, or warning text.

Acceptance tests:

- Same request produces the same key.
- Different amount produces a different key.
- Different slippage produces a different key.
- Different provider produces a different key.
- Optional undefined fields do not create unstable keys.

### 2. Add In-Memory Quote Cache

Create an in-memory quote cache for process-local reuse.

Proposed file:

```text
backend/src/providers/quotes/QuoteCache.ts
```

Default behavior:

```text
enabled = true
ttlMs = 15000
maxEntries = 1000
staleReads = false
```

Cache entry fields:

```text
key
provider
request
result
storedAtMs
expiresAtMs
hitCount
```

Result metadata:

```text
cacheStatus = MISS | HIT | EXPIRED | DISABLED
cacheAgeMs
cacheTtlMs
```

Rules:

- Cache only successful quote results in the first pass.
- Do not cache raw provider payloads unless raw payload logging is already enabled elsewhere.
- Do not persist cache entries to the database.
- Do not share cache across processes.
- Evict expired entries opportunistically.
- Evict oldest entries when `maxEntries` is exceeded.
- Return cached quote data without mutating trading state.

Acceptance tests:

- First request misses and stores a successful quote.
- Repeated identical request within TTL returns a cache hit.
- Request after TTL expires misses.
- Different quote request does not hit the previous cache entry.
- Max-entry eviction removes older entries.
- Disabled cache always misses.

### 3. Add Quote Backoff Policy

Add a small provider-level cooldown manager for rate-limited quote behavior.

Proposed file:

```text
backend/src/providers/quotes/QuoteBackoffPolicy.ts
```

Default behavior:

```text
enabled = true
baseCooldownMs = 30000
maxCooldownMs = 120000
multiplier = 2
jitterPct = 10
successReset = true
```

Cooldown scope:

```text
provider + operation
```

For Phase 9.2, `operation` should at least support:

```text
quote
```

Rules:

- When a quote result is rate-limited, record a cooldown for that provider operation.
- Consecutive rate limits increase cooldown up to `maxCooldownMs`.
- A successful live quote resets the cooldown for that provider operation.
- Cooldown state is in-memory only.
- Cooldown skips should be visible in provider health context.
- Cooldown skips must not be counted as successful quote evidence.

Acceptance tests:

- No cooldown before a rate-limit result.
- Rate-limit result creates cooldown.
- Consecutive rate limits increase cooldown.
- Cooldown expires after the expected time.
- Successful quote resets cooldown.
- Cooldown state is isolated by provider and operation.

### 4. Add Quote Priority

Add a simple priority model so future quote callers can declare intent.

Proposed file:

```text
backend/src/providers/quotes/QuotePriority.ts
```

Priority levels:

```text
CRITICAL - future open paper position exits
HIGH     - risk and strategy candidates near entry eligibility
NORMAL   - ordinary scanner/risk/strategy enrichment
LOW      - broad research enrichment or bulk refreshes
```

Phase 9.2 rules:

- Existing callers may default to `NORMAL` if no explicit priority is supplied.
- Risk quote probes should be `HIGH` when practical.
- Strategy entry quote checks should be `HIGH` when practical.
- Scanner enrichment may remain `NORMAL`.
- Future paper exit quote checks should be reserved as `CRITICAL`, but Phase 9.2 does not enable
  automated paper exits.
- During an active cooldown, `LOW` and `NORMAL` requests may be skipped before hitting Jupiter.
- During an active cooldown, `HIGH` and `CRITICAL` requests may try another enabled fallback
  provider when available. In Phase 9.2, no fallback provider exists yet, so they should return a
  clear unavailable result instead of silently pretending a quote exists.

Acceptance tests:

- Default priority is `NORMAL`.
- Priority is carried into provider health context.
- Low-priority quote request can be skipped during cooldown.
- High-priority quote request preserves failure provenance when no fallback is available.

### 5. Add Quote Router / Fallback Framework

Introduce a wrapper that owns cache, backoff, priority, and future fallback ordering.

Proposed file:

```text
backend/src/providers/quotes/QuoteProviderRouter.ts
```

Responsibilities:

- Receive a `QuoteRequest`.
- Receive optional `QuoteRequestContext`.
- Check cache.
- Check backoff/cooldown.
- Select enabled quote providers in configured order.
- Call the provider.
- Store successful live quotes in cache.
- Record provider health with cache/backoff/fallback context.
- Return a normal `ProviderResult<QuoteResult>`.

Suggested context shape:

```text
priority
stage
sessionId
candidateMint
reason
allowStaleCache
```

Suggested fallback metadata:

```text
providerOrder
attemptedProviders
selectedProvider
fallbackAttempted
fallbackUsed
confidence = HIGH | MEDIUM | LOW | NONE
quoteSource = LIVE | CACHE | SKIPPED_COOLDOWN | UNAVAILABLE
```

Phase 9.2 provider order:

```text
JUPITER
```

Future provider order:

```text
JUPITER -> RAYDIUM -> AUTOBAHN/TITAN -> METEORA/ORCA
```

Rules:

- Do not silently replace Jupiter with DexScreener price data and call it a quote.
- Missing quote remains missing quote.
- Cached quote should preserve original provider source.
- Cache hits should not create fake provider success rows that hide live provider pressure.
- Cooldown skips should be recorded as explicit provider-health evidence.
- The router should be injectable/testable without network calls.

Acceptance tests:

- Jupiter-only router returns Jupiter live quote when available.
- Jupiter-only router returns cache hit when available.
- Jupiter-only router reports unavailable when cooled down and no fallback exists.
- Fallback metadata remains present even when no fallback is used.
- Provider failure provenance is preserved.

### 6. Integrate Router Into MarketDataService

Update quote enrichment so quote calls pass through the router.

Primary integration target:

```text
backend/src/providers/MarketDataService.ts
```

Supporting target:

```text
backend/src/providers/ProviderRegistry.ts
```

Implementation guidance:

- Keep existing price, liquidity, metadata, and risk evidence flows unchanged.
- Route only `buyQuoteRequest` and `sellQuoteRequest` through the new quote router.
- Preserve the current `TokenEnrichmentSnapshot.buyQuote` and `.sellQuote` fields.
- Preserve existing warnings behavior.
- Do not change provider adapter contracts unless needed.
- Prefer wrapping `QuoteProvider` rather than rewriting `JupiterAdapter`.

Acceptance tests:

- Enrichment still succeeds with price/liquidity/metadata/risk evidence only.
- Buy quote uses the router.
- Sell quote uses the router.
- Cached quote appears as quote data without breaking snapshot shape.
- Missing quote still produces warnings and no quote field.

### 7. Add Config Options

Extend provider config with quote-resilience options.

Proposed env vars:

```text
QUOTE_CACHE_ENABLED=true
QUOTE_CACHE_TTL_MS=15000
QUOTE_CACHE_MAX_ENTRIES=1000
QUOTE_BACKOFF_ENABLED=true
QUOTE_BACKOFF_BASE_COOLDOWN_MS=30000
QUOTE_BACKOFF_MAX_COOLDOWN_MS=120000
QUOTE_BACKOFF_MULTIPLIER=2
QUOTE_BACKOFF_JITTER_PCT=10
QUOTE_SKIP_LOW_PRIORITY_DURING_COOLDOWN=true
```

Config rules:

- Validate integer fields.
- Validate booleans.
- Validate `QUOTE_BACKOFF_MULTIPLIER >= 1`.
- Validate `QUOTE_BACKOFF_JITTER_PCT >= 0`.
- Keep defaults conservative.
- Document that config contains no secrets.

Acceptance tests:

- Defaults parse.
- Explicit valid overrides parse.
- Invalid TTL fails clearly.
- Invalid multiplier fails clearly.
- Invalid boolean fails clearly.

### 8. Improve Provider Health Context

Use existing `ProviderHealthService.recordResult()` context support and avoid schema changes.

Provider-health context should include, when available:

```text
operation = quote
quotePriority
quoteStage
quoteCacheStatus
quoteSource
quoteCacheAgeMs
quoteBackoffActive
quoteCooldownRemainingMs
quoteFallbackAttempted
quoteFallbackUsed
quoteProviderOrder
quoteAttemptedProviders
```

Rules:

- Do not log API keys.
- Do not log raw route payloads by default.
- Do not log entire candidate snapshots.
- Keep context JSON compact.

Acceptance tests:

- Cache hit context is present.
- Cooldown skip context is present.
- Live quote context is present.
- No raw API key-like values are written.

### 9. Keep TerminalRunner Shadow-First

TerminalRunner should benefit from the provider framework but not change its safety boundary.

Required behavior:

- `terminal:run` stays shadow-only by default.
- `paper:execute` remains excluded.
- Wallet loading remains disabled.
- Transaction signing remains disabled.
- Transaction submission remains disabled.
- Existing one-session-per-run behavior remains.
- Existing output artifacts remain compatible with `research:aggregate`.

Optional reporting improvement:

- Add cache/backoff fields to TerminalRunner provider-pressure summaries when those fields are
  available from ProviderHealth context.

Acceptance tests:

- TerminalRunner safety test still proves no paper execution.
- TerminalRunner summary still includes provider pressure.
- TerminalRunner output remains JSON-compatible.

### 10. Update Research And Analytics Reports Only If Low Risk

Do not turn Phase 9.2 into a reporting rewrite.

Allowed:

- Add cache-hit and cooldown-skip counts to existing provider impact summaries when easy.
- Add quote-source counts to `research:aggregate` when derived from ProviderHealth context.

Deferred:

- Deep provider dashboards.
- Per-candidate quote lineage tables.
- Persistent quote history.
- Paid-provider comparisons.

Acceptance tests:

- Existing analytics tests still pass.
- Existing calibration tests still pass.
- Existing research aggregate tests still pass.

### 11. Documentation Updates

Update:

```text
docs/ROADMAP_Phase9Plus.md
docs/DECISIONS_Phase9Plus.md
docs/Structure_Phase9Plus.md
docs/Phase-9-Planning-Inputs.md
docs/Provider-Strategy-Phase9Plus.md
```

Required notes:

- Phase 9.2 is the provider-resilience framework.
- New provider adapters are deferred to 9.3+.
- Jupiter stays primary in 9.2.
- Missing quote remains explicit evidence, not a negative quality assumption by itself.
- Birdeye Standard remains selective enrichment because of 1 RPS and 30,000 CU/month limits.
- Titan and Autobahn remain access-gated.

## Proposed File Additions

These names can be adjusted during implementation if the existing code points to a cleaner local
pattern.

```text
backend/src/providers/quotes/QuoteRequestKey.ts
backend/src/providers/quotes/QuoteCache.ts
backend/src/providers/quotes/QuoteBackoffPolicy.ts
backend/src/providers/quotes/QuotePriority.ts
backend/src/providers/quotes/QuoteProviderRouter.ts
backend/src/providers/quotes/index.ts
backend/src/providers/quotes/*.test.ts
```

Likely modified files:

```text
backend/src/providers/MarketDataService.ts
backend/src/providers/ProviderRegistry.ts
backend/src/providers/config/providerConfig.ts
backend/src/providers/MarketDataService.test.ts
backend/src/providers/config/providerConfig.test.ts
backend/src/terminal-runner/*
backend/src/analytics/*
backend/src/research/*
```

## Implementation Order

1. Add quote key, cache, backoff, and priority types with unit tests.
2. Add quote router with Jupiter-only behavior and unit tests.
3. Add provider config options and tests.
4. Wire router into provider registry and `MarketDataService`.
5. Add provider health context for cache/backoff/fallback outcomes.
6. Update TerminalRunner provider-pressure summaries only if the data is already easy to derive.
7. Update analytics/research reports only if low-risk and testable.
8. Update docs.
9. Run verification.

## Verification Commands

Required:

```bash
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm check:secrets
```

Or:

```bash
corepack pnpm verify
```

Useful smoke checks:

```bash
corepack pnpm providers:smoke
corepack pnpm terminal:run --cycles=2 --interval-ms=60000 --output-dir=data/phase9.2-smoke
corepack pnpm research:aggregate --once \
  --label-run=T1:data/archive/phase9/test1-phase9-test1-20260709-2344 \
  --label-run=T2:data/archive/phase9/test2-phase9-test2-20260710-0919 \
  --label-run=T3:data/archive/phase9/test3-phase9-test3-20260710-1729
```

## Post-Implementation Validation Plan

After Phase 9.2 implementation passes local verification, run a fresh three-test batch similar to
Phase 9:

```powershell
corepack pnpm db:reset:paper

$run = "phase9.2-test1-$(Get-Date -Format 'yyyyMMdd-HHmm')"
corepack pnpm terminal:run --max-runtime-minutes=120 --interval-ms=60000 --output-dir="data\$run"
```

Archive each run under:

```text
data/archive/phase9.2/
```

Then compare:

```bash
corepack pnpm research:aggregate --once \
  --label-run=T1:data/archive/phase9.2/test1-... \
  --label-run=T2:data/archive/phase9.2/test2-... \
  --label-run=T3:data/archive/phase9.2/test3-...
```

Success is not measured by paper P/L in Phase 9.2. Success is measured by:

- lower duplicate live quote pressure,
- fewer avoidable Jupiter rate-limit hits,
- clearer cache/backoff/fallback provider-health context,
- no safety-boundary regression,
- no strategy default changes,
- no paper execution rows,
- research reports still usable.

## Known Limitations After Phase 9.2

Expected remaining limitations:

- Jupiter may still rate-limit high-intent quote requests.
- No alternate live quote provider exists until Raydium or another adapter is added.
- Cache can reduce duplicate calls but cannot create fresh route confidence.
- In-memory cache does not help across separate processes.
- Missing quote evidence can still affect risk/strategy confidence.
- Strategy timing and drawdown instability remain separate research problems.

## Handoff To Later Phases

Phase 9.3:

```text
Add Raydium direct quote fallback if Phase 9.2 evidence shows the framework is working and Jupiter
pressure remains a material blocker.
```

Phase 9.4:

```text
Add Birdeye selective enrichment for top candidates, shadow-observed candidates, open paper
positions, and missed-opportunity analysis if CU budget supports it.
```

Phase 9.5:

```text
Evaluate Autobahn and Titan aggregate quote fallback after access is confirmed.
```

Phase 9.6:

```text
Evaluate Meteora and Orca pool-specific adapters after pair/pool context is tracked deliberately.
```

Phase 10:

```text
Dashboard should consume TerminalRunner and research aggregate artifacts, including provider
pressure, cache, backoff, and fallback metrics when available.
```
