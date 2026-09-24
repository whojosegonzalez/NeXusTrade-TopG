# NeXusTrade Phase 9.4B Detailed Checklist

Quote-pressure reduction, demand control, and venue-aware Raydium probing

Last updated: August 2026

## Status

Implementation and runtime validation complete. Phase 9.4C is the selected Jupiter refinement.

Phase 9.4B follows the completed Phase 9.4A truthing work:

```text
9.4A.1 Archive and reporting truthing       -> implemented and smoke-validated
9.4A.2 Adapter correctness and diagnostics  -> implemented and short-runtime validated
9.4A.3 Persistence hardening                -> deferred; not needed now
9.4B Quote-pressure reduction               -> implemented; runtime validated
```

## Implementation Record

Completed in August 2026:

- Added local per-provider quote scheduling, process-local single-flight request joining, and a
  bounded deterministic-failure cache.
- Added a separate Raydium negative cache and a conservative DexScreener-venue guard. Missing
  venue evidence still allows a probe by default; a strict evidence requirement is opt-in.
- Preserved provider order `JUPITER -> RAYDIUM`, quote provenance, attempt-journal semantics, and
  existing success-cache behavior.
- Added demand-action, scheduler, single-flight, negative-cache, venue-guard, and avoided-live-call
  telemetry to provider smoke, TerminalRunner, analytics, and cross-run research output.
- Added focused unit coverage. Provider smoke, quote diagnose, one short smoke, and two full
  TerminalRunner validations completed safely.
- No schema migration, strategy change, provider expansion, wallet use, signing, submission, order,
  fill, or position behavior was added.

## Objective

Reduce avoidable quote-provider pressure without changing strategy behavior, adding providers,
or enabling paper execution.

```text
Phase 9.4A.2 evidence
  -> Jupiter remains pressured
  -> Raydium fallback is mostly no-route/no-pool for discovered mints
  -> Birdeye and Solana RPC are healthy
  -> existing telemetry is good enough

Phase 9.4B response
  -> pace Jupiter demand
  -> remove duplicate quote requests
  -> avoid immediate retry loops
  -> separate success cache from negative/unavailable evidence
  -> suppress implausible Raydium probes with venue evidence
  -> preserve diagnostics and safety boundaries
```

The goal is not to make every candidate quotable. The goal is to stop wasting live quote attempts
when the system already has enough evidence to wait, reuse, or skip a provider intelligently.

## Evidence From Phase 9.4A.2

Short validation archive:

```text
archive = data/archive/phase9.4A.2/short-phase9.4A.2-short-20260806-1255
duration = 30 minutes
cycles = 29
safetyStatus = PASS
mode = PAPER
shadowOnly = true
orders/fills/positions = 0
TokenRadar total = 26
Risk total = 553
Strategy total = 229
Strategy by decision = WATCH 6, SKIP 223, BUY 0
```

Provider evidence:

```text
Birdeye total = 64
Birdeye failures = NONE
Birdeye rateLimited = 0%

Solana RPC total = 2488
Solana RPC failures = NONE
Solana RPC rateLimited = 0%

Jupiter total = 732
Jupiter liveRateLimited ~= 20.31%
Jupiter combinedRateLimited ~= 58.47%
Jupiter cacheHits = 151
Jupiter cooldownSkips = 389

Raydium total = 858
Raydium quote OK = 0 in runtime-discovered mint flow
Raydium failures = NO_ROUTE 429
Raydium preflight = NO_POOL 429
```

Control-route quote diagnostics were healthy:

```text
SOL -> USDC router quote = OK through Jupiter
SOL -> USDC direct Raydium quote = OK
SOL -> USDC Raydium preflight = FOUND
HTTP attempt timeline = present and sanitized
latest attempt vs last successful quote = present
```

Conclusion:

```text
Raydium adapter is not broadly malformed.
Runtime Raydium fallback is mostly futile for discovered mints without Raydium pool evidence.
Jupiter demand is still bursty enough to trigger significant rate limiting.
```

## Safety Boundary

Phase 9.4B may:

- Add provider-aware quote scheduling and local pacing.
- Add single-flight request joining for in-process duplicate quote requests.
- Split quote cache behavior into successful quote cache and negative/unavailable quote evidence.
- Add Raydium no-pool/no-route negative caching.
- Add DexScreener venue-aware suppression of Raydium probes.
- Adjust retry behavior so deterministic failures and rate limits are not retried immediately.
- Add provider-pressure diagnostics for scheduler waits, joined requests, negative cache hits, and
  venue-guard skips.
- Update TerminalRunner summaries and research reports to expose the new pressure-reduction counts.
- Update tests and documentation.

Phase 9.4B must not:

- Add a new provider.
- Change quote-provider order. Keep `JUPITER -> RAYDIUM`.
- Treat Birdeye price or overview as executable quote evidence.
- Change scanner, risk, strategy, shadow-entry, or promotion thresholds.
- Promote any strategy profile.
- Enable paper BUY, paper SELL, live trading, wallet loading, transaction building, signing, or
  submission.
- Add a DB migration unless implementation proves existing `ProviderHealth.contextJson` cannot
  capture required diagnostic counts.
- Store raw provider URLs, headers, API keys, request bodies, responses, or transaction-like content.

Provider-health and system-log diagnostic writes remain allowed. Trading-state writes must remain
unchanged: no orders, fills, positions, or paper execution.

## Success Criteria

Phase 9.4B succeeds when one smoke validation and at least two short TerminalRunner validations show:

```text
safetyStatus = PASS
orders/fills/positions = 0
provider smoke passes
quote:diagnose known route still passes
Jupiter liveRateLimited decreases versus Phase 9.4A.2 baseline
Jupiter combinedRateLimited decreases versus Phase 9.4A.2 baseline
Raydium live no-route probes decrease versus Phase 9.4A.2 baseline
Raydium venueGuardSkips or negativeCacheHits are visible
quote availability does not collapse because of over-throttling
ProviderHealth clearly separates:
  scheduler wait
  single-flight join
  success cache hit
  negative cache hit
  cooldown skip
  venue guard skip
  live provider call
```

Baseline to compare against:

```text
Jupiter liveRateLimited ~= 20.31%
Jupiter combinedRateLimited ~= 58.47%
Jupiter cooldownSkips = 389
Raydium runtime quote OK = 0
Raydium failures = NO_ROUTE 429
Raydium preflight = NO_POOL 429
```

Recommended acceptance targets:

```text
Jupiter liveRateLimited < 10%
Jupiter combinedRateLimited < 35%
Raydium NO_POOL live attempts reduced by at least 50%
orders/fills/positions = 0
no strategy promotion
```

If market conditions make exact rate comparisons noisy, the phase can still pass if diagnostics prove
that quote demand is being paced, joined, cached, or skipped for explicit reasons.

## Locked Design Decisions

```text
Provider order:             JUPITER -> RAYDIUM
Jupiter pacing:             local per-provider scheduler, default enabled
Jupiter min interval:       1100ms default for quote calls
Immediate Jupiter 429 retry: no
Retry-After/header support: use sanitized derived fields from ProviderHttpAttempt when available
Single-flight scope:        process-local, in-memory, no persistence
Success quote cache:        keep existing cache behavior, configurable TTL
Negative quote cache:       new short-lived cache for deterministic no-route/unavailable evidence
Raydium venue guard:        use DexScreener pair/venue evidence before live Raydium compute probe
Raydium no-pool cache:      cache NO_POOL/NO_ROUTE evidence longer than raw quote cache
Birdeye price:              market-data enrichment only, never executable quote evidence
Persistence:                existing ProviderHealth.contextJson only unless proven insufficient
Validation:                 provider smoke, quote diagnose, one short smoke, then 2-3 full tests
```

## Proposed Defaults

Add these defaults in provider config:

```text
QUOTE_SCHEDULER_ENABLED = true
QUOTE_SCHEDULER_JUPITER_MIN_INTERVAL_MS = 1100
QUOTE_SCHEDULER_RAYDIUM_MIN_INTERVAL_MS = 250
QUOTE_SINGLE_FLIGHT_ENABLED = true
QUOTE_SINGLE_FLIGHT_TTL_MS = 15000
QUOTE_NEGATIVE_CACHE_ENABLED = true
QUOTE_NEGATIVE_CACHE_TTL_MS = 120000
QUOTE_NEGATIVE_CACHE_MAX_ENTRIES = 1000
RAYDIUM_VENUE_GUARD_ENABLED = true
RAYDIUM_NEGATIVE_CACHE_TTL_MS = 300000
RAYDIUM_NEGATIVE_CACHE_MAX_ENTRIES = 1000
RAYDIUM_REQUIRE_DEXSCREENER_RAYDIUM_VENUE = false
RAYDIUM_SKIP_WHEN_DEXSCREENER_VENUE_ABSENT = true
```

Interpretation:

- `RAYDIUM_REQUIRE_DEXSCREENER_RAYDIUM_VENUE=false` avoids blocking all Raydium attempts solely
  because DexScreener evidence is absent.
- `RAYDIUM_SKIP_WHEN_DEXSCREENER_VENUE_ABSENT=true` means skip Raydium only when DexScreener pair
  evidence exists and none of the observed venues look Raydium-compatible.
- Compatible venue matching should be conservative and configurable. Start with venue labels that
  contain `raydium`, `raydium-clmm`, `raydium-cpmm`, or equivalent DexScreener `dexId` values
  observed in local data.

## Proposed Files To Add

```text
backend/src/providers/quotes/QuoteScheduler.ts
backend/src/providers/quotes/QuoteScheduler.test.ts
backend/src/providers/quotes/QuoteSingleFlight.ts
backend/src/providers/quotes/QuoteSingleFlight.test.ts
backend/src/providers/quotes/QuoteNegativeCache.ts
backend/src/providers/quotes/QuoteNegativeCache.test.ts
backend/src/providers/raydium/RaydiumVenueGuard.ts
backend/src/providers/raydium/RaydiumVenueGuard.test.ts
backend/src/providers/raydium/RaydiumNegativeCache.ts
backend/src/providers/raydium/RaydiumNegativeCache.test.ts
```

Optional if the implementation becomes clearer with a separate type module:

```text
backend/src/providers/quotes/QuoteDemandTypes.ts
```

## Proposed Files To Modify

```text
backend/src/providers/config/providerConfig.ts
backend/src/providers/config/providerConfig.test.ts
backend/src/providers/ProviderRegistry.ts
backend/src/providers/ProviderHealthService.ts
backend/src/providers/ProviderPressureClassifier.ts
backend/src/providers/ProviderPressureClassifier.test.ts
backend/src/providers/quotes/QuoteProviderRouter.ts
backend/src/providers/quotes/QuoteProviderRouter.test.ts
backend/src/providers/quotes/index.ts
backend/src/providers/raydium/RaydiumAdapter.ts
backend/src/providers/raydium/RaydiumAdapter.test.ts
backend/src/providers/raydium/RaydiumPoolPreflightService.ts
backend/src/scripts/providers-smoke.ts
backend/src/terminal-runner/TerminalRunSummary.ts
backend/src/terminal-runner/TerminalRunSummary.test.ts
docs/Provider-Strategy-Phase9Plus.md
docs/ROADMAP_Phase9Plus.md
docs/DECISIONS_Phase9Plus.md
docs/Structure_Phase9Plus.md
docs/Phase-9-Planning-Inputs.md
```

## Implementation Chunks

### Chunk 1 - Config And Types

Add config interfaces:

```text
QuoteSchedulerConfig
QuoteSingleFlightConfig
QuoteNegativeCacheConfig
RaydiumVenueGuardConfig
RaydiumNegativeCacheConfig
```

Wire them into `QuoteResilienceConfig` and `RaydiumProviderConfig` as appropriate.

Validation requirements:

- Parse booleans and positive integers.
- Reject invalid TTLs, intervals, and max-entry values.
- Preserve existing defaults when env vars are not present.
- Keep old env vars working.

Tests:

```text
providerConfig.test.ts
  default scheduler enabled
  default single-flight enabled
  default negative cache enabled
  invalid scheduler interval rejected
  invalid negative-cache TTL rejected
  Raydium venue guard defaults stable
```

### Chunk 2 - Quote Scheduler

Create `QuoteScheduler`.

Responsibilities:

```text
Serialize or delay live quote calls per provider.
Use provider-specific min intervals.
Return waitMs diagnostics.
Do not sleep for cache hits, negative cache hits, cooldown skips, or disabled providers.
Respect AbortSignal only if the existing code already has one; otherwise keep it simple.
```

Expected API shape:

```text
await scheduler.schedule(provider, operation, () => provider.getQuote(request))
```

Diagnostics to expose:

```text
quoteSchedulerEnabled
quoteSchedulerWaitMs
quoteSchedulerProvider
quoteSchedulerOperation
```

ProviderHealth status:

- Do not create standalone rows just for waiting unless the wait materially delays a live call.
- Prefer adding scheduler diagnostics to the provider result/router context for the live attempt.

Tests:

```text
first call does not wait
second same-provider call waits until min interval
different provider has independent interval
disabled scheduler does not wait
diagnostic waitMs is captured
```

### Chunk 3 - Single-Flight Quote Joining

Create `QuoteSingleFlight`.

Responsibilities:

```text
Join identical in-flight quote requests by provider + request key + operation.
Avoid duplicate live provider calls during one TerminalRunner cycle.
Expire/clean entries after completion or TTL.
Never share failures beyond the in-flight call itself unless negative cache decides to store them.
```

Expected API shape:

```text
singleFlight.run(provider, request, () => liveCall())
```

Diagnostics:

```text
quoteSingleFlightJoined = true|false
quoteSingleFlightKeyHash = short non-sensitive hash
quoteSingleFlightWaiters = number
```

Tests:

```text
same request joins one live call
different amount does not join
different slippage does not join
different provider does not join
failure propagates to all joined callers
entry removed after completion
```

### Chunk 4 - Negative Quote Cache

Create `QuoteNegativeCache`.

Responsibilities:

```text
Cache deterministic quote-unavailable evidence separately from successful quote results.
Do not cache transient rate limits as route failures.
Do not cache unknown/provider-unavailable failures longer than configured short TTL.
Attach reason, provider, failure code, fallback reason, and created/expires timestamps.
Keep bounded max entries.
```

Cacheable categories:

```text
RAYDIUM NO_ROUTE
RAYDIUM NO_POOL
deterministic BAD_REQUEST / unsupported mint / unsupported token program
known provider unavailable for the same request only when explicitly configured
```

Non-cacheable categories:

```text
RATE_LIMITED
TIMEOUT
network failure
unknown provider failure
schema/mapping error unless explicitly deterministic
```

Diagnostics:

```text
quoteNegativeCacheStatus = HIT|MISS|SET|DISABLED
quoteNegativeCacheReason
quoteNegativeCacheProvider
quoteNegativeCacheAgeMs
quoteNegativeCacheTtlMs
```

Tests:

```text
stores deterministic no-route
does not store rate limit
expires by TTL
evicts by max entries
provider/request key isolation
ProviderHealth context gets negative-cache hit
```

### Chunk 5 - Raydium Venue Guard

Create `RaydiumVenueGuard`.

Responsibilities:

```text
Inspect existing enrichment/DexScreener pair evidence before live Raydium quote attempts.
Suppress Raydium only when evidence strongly says the token has no Raydium-compatible venue.
Avoid suppressing when evidence is absent or ambiguous unless config explicitly says so.
Return a structured decision and reason.
```

Decision model:

```text
ALLOW
SKIP_NO_RAYDIUM_VENUE
SKIP_NEGATIVE_CACHE
UNKNOWN_ALLOW
DISABLED_ALLOW
```

Suggested reason fields:

```text
raydiumVenueGuardDecision
raydiumVenueGuardReason
raydiumVenueGuardMatchedVenue
raydiumVenueGuardObservedVenues
```

Implementation notes:

- Prefer structured fields already stored in `TokenRadar.enrichmentSnapshotJson` or normalized
  DexScreener pair data.
- If the data shape is awkward, add a small parser/helper close to the guard.
- Do not invent Raydium route evidence from token names or symbols.
- Do not suppress Jupiter based on Raydium venue evidence.

Tests:

```text
allows when Raydium venue exists
skips when non-Raydium venues exist and no Raydium venue exists
allows when pair evidence missing
allows when disabled
handles unknown/malformed enrichment safely
```

### Chunk 6 - Router Integration

Modify `QuoteProviderRouter` to apply the controls in this order:

```text
1. success quote cache
2. negative quote cache
3. backoff/cooldown skip
4. venue guard for provider-specific skips
5. single-flight join
6. scheduler
7. live provider call
8. cache success or cache deterministic negative evidence
9. journal latest attempt / last success
10. ProviderHealth context write
```

Important behavior:

- Success cache remains the fastest path.
- Negative cache and venue guard should not overwrite last successful quote evidence.
- Single-flight should wrap the actual live call, not cache reads.
- Scheduler should pace only live calls.
- Deterministic Raydium no-route/no-pool should avoid repeated compute calls.
- Jupiter rate limits should create backoff/cooldown, not negative route evidence.

Router ProviderHealth should expose:

```text
quoteDemandAction =
  SUCCESS_CACHE_HIT
  NEGATIVE_CACHE_HIT
  COOLDOWN_SKIP
  VENUE_GUARD_SKIP
  SINGLE_FLIGHT_JOIN
  SCHEDULED_LIVE_CALL
  LIVE_CALL

quoteDemandSavedLiveCall = true|false
quoteDemandProvider
quoteDemandReason
```

Tests:

```text
cache hit bypasses scheduler/single-flight
negative cache hit bypasses live call
cooldown skip bypasses live call
venue guard skip bypasses Raydium live call
single-flight joins duplicate live quote
scheduler paces uncached live quote
last successful quote remains visible after negative cache hit
fallback reasons remain stable
```

### Chunk 7 - Raydium Integration

Modify Raydium adapter/preflight integration to:

```text
Consult Raydium negative cache before compute quote when available.
Set negative cache after NO_POOL/NO_ROUTE deterministic failures.
Add venue-guard diagnostics when Raydium is skipped before compute.
Preserve existing control-route quote:diagnose behavior.
Preserve direct Raydium known-route quote success.
```

Do not:

- Call Raydium transaction endpoints.
- Treat preflight as quote evidence.
- Turn no-pool into success.

Tests:

```text
NO_POOL preflight sets negative cache
negative cache suppresses repeated compute attempts
control route with pool still succeeds
venue guard skip returns provider failure with stable diagnostics
```

### Chunk 8 - Reporting And Diagnostics

Extend `ProviderPressureClassifier` and `TerminalRunSummary` with:

```text
quoteDemandActionCounts
quoteSchedulerWaitMsTotal
quoteSchedulerWaitMsAverage
quoteSingleFlightJoinCount
quoteNegativeCacheHitCount
quoteNegativeCacheReasonCounts
raydiumVenueGuardDecisionCounts
raydiumVenueGuardReasonCounts
raydiumNegativeCacheHitCount
liveQuoteCallsAvoidedEstimate
```

Providers smoke should print a compact line when any of these are nonzero:

```text
quoteDemand=SUCCESS_CACHE_HIT:...|NEGATIVE_CACHE_HIT:...|VENUE_GUARD_SKIP:...
schedulerWaitMs=...
singleFlightJoins=...
negativeCache=...
raydiumVenueGuard=...
```

Analytics and TerminalRunner reports should make it easy to compare:

```text
before = Phase 9.4A.2 baseline
after = Phase 9.4B run
Jupiter rate pressure
Raydium futile probes
quote availability
strategy decisions
missed opportunities
safety counters
```

Tests:

```text
classifier aggregates demand actions
classifier aggregates venue guard decisions
summary prints compact demand diagnostics
unknown fields do not crash older reports
```

### Chunk 9 - Validation Runbook

After implementation, run:

```powershell
corepack pnpm verify
corepack pnpm providers:smoke
corepack pnpm quote:diagnose --once --mode=all
```

Then run one short 30-minute TerminalRunner smoke:

```powershell
corepack pnpm db:reset:paper
corepack pnpm terminal:run --max-runtime-minutes=30 --interval-ms=60000 --output-dir="data\<run>"
corepack pnpm analytics:report --once
```

If the short run is safe and diagnostics appear, run two or three full validations:

```text
2 hours TerminalRunner
60-minute tail
analytics:report
calibration:report --max-hold-minutes=120
shadow:calibrate
archive DB + transcripts + runner outputs
```

Compare against Phase 9.4A.2 and Phase 9.4 baselines.

## Acceptance Test Checklist

Config:

- [ ] Defaults parse.
- [ ] Invalid intervals/TTLs rejected.
- [ ] Existing env vars still work.

Quote scheduler:

- [ ] Same-provider live calls are paced.
- [ ] Different providers are independent.
- [ ] Cache hits do not wait.
- [ ] Wait diagnostics are recorded.

Single-flight:

- [ ] Duplicate live quote joins one provider call.
- [ ] Distinct quote keys do not join.
- [ ] Failures propagate and cleanup.

Negative cache:

- [ ] Deterministic no-route/no-pool is cached.
- [ ] Rate limits are not cached as no-route.
- [ ] TTL and max-entry eviction work.

Raydium venue guard:

- [ ] Raydium venue allows.
- [ ] Known non-Raydium venues skip.
- [ ] Missing/ambiguous evidence allows.
- [ ] Diagnostics include observed venues and decision.

Router:

- [ ] Execution order matches the locked design.
- [ ] Last successful quote survives later failed/skipped attempts.
- [ ] Fallback reason stays accurate.
- [ ] ProviderHealth distinguishes all demand actions.

Reporting:

- [ ] Provider smoke includes compact 9.4B counts.
- [ ] TerminalRunner summary includes demand-action counts.
- [ ] Analytics provider health includes demand-action counts.

Safety:

- [ ] `orders = 0`.
- [ ] `fills = 0`.
- [ ] `positions = 0`.
- [ ] No wallet, signing, transaction building, or submission.
- [ ] No strategy threshold/profile changes.

## Known Limitations

- A local scheduler cannot eliminate all upstream rate limits if multiple processes run at once.
- Single-flight is process-local and will not dedupe across separate terminals.
- Venue guard depends on available DexScreener pair evidence; absent evidence must remain
  conservative.
- Raydium no-pool/no-route can change over time as pools appear; negative-cache TTL must stay
  short enough for newly created pools.
- This phase still does not solve strategy profitability. It makes quote evidence cheaper and more
  reliable.
- This phase does not enable paper BUY. A separate promotion/paper-pilot decision remains required.

## Phase 9.4B Completion Criteria

Phase 9.4B is complete when:

```text
Implementation chunks 1-8 complete.
Unit tests and full verify pass.
providers:smoke passes.
quote:diagnose known route passes.
At least one short runtime validation passes.
At least two full validations are reviewed, unless the short validation reveals a clear defect.
Docs record aggregate comparison against Phase 9.4A.2.
Decision is made:
  proceed to Phase 9.5 provider expansion
  or run additional 9.4B tuning
  or start strategy/promotion review only if evidence unexpectedly justifies it
```

No Phase 9.4B result should authorize paper BUY by itself.

## Runtime Validation Conclusion

Validated August 10-11, 2026:

```text
short smoke = PASS
full validations = 2
PAPER/shadow-only safety = PASS
orders/fills/positions = 0

Raydium controls = accepted
  venue guard and negative cache avoided thousands of futile live probes

Jupiter fixed scheduler = insufficient by itself
  full run 1 liveRateLimited = 23.00%
  full run 2 liveRateLimited = 23.08%
```

The next step is not another unchanged 9.4B run, Helius re-enablement, provider expansion, or a
paid Jupiter tier. Proceed to Phase 9.4C for a process-wide adaptive Jupiter budget that separates
intentional local deferral from upstream rate limiting.
