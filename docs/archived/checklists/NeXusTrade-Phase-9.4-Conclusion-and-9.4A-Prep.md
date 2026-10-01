# NeXusTrade Phase 9.4 Conclusion And Phase 9.4A Prep

Birdeye validation conclusion and next-phase preparation.

Last updated: August 2026

## Status

Phase 9.4 is operationally validated. Phase 9.4A is the next planned phase and should focus on
validation truthing, reporting integrity, quote evidence attribution, and adapter correctness before
runtime quote-pressure refactors.

## Phase 9.4 Aggregate

Archive:

```text
data/archive/phase9.4/aggregate-phase9.4-20260804-2016
```

Aggregate result:

```text
validRuns = 3/3
observedDecisions = 115
uniqueMints = 14
orders/fills/positions = 0
readiness = PROMISING_RESEARCH
controlledPaperPilotRecommended = no
```

Provider result:

```text
BIRDEYE total = 444
BIRDEYE liveRateLimited = 0%
BIRDEYE combinedRateLimited = 0%
BIRDEYE cacheHits = 244
BIRDEYE failures = NONE:378 | BIRDEYE_CU_BUDGET_EXHAUSTED:66
JUPITER liveRateLimited = 22.2381%
JUPITER combinedRateLimited = 69.7326%
RAYDIUM errors = 94.5019%
SOLANA_RPC missingAuthority = 0
```

Interpretation:

```text
Birdeye adapter/integration = PASS
Birdeye cache = PASS
Birdeye budget guardrails = PASS
Birdeye external rate limiting = PASS
Birdeye budget skip classification = NEEDS FIX
Birdeye attribution reporting = INCOMPLETE
Quote pipeline correctness/efficiency = NEEDS WORK
Strategy promotion = NOT READY
Controlled paper pilot = NO
```

## Key Corrections

The Phase 9.4 aggregate should not be interpreted as broad threshold validation.

Important concentration facts:

```text
BUY55 and BUY65 selected the same observed BUY set.
64 / 115 observed decisions came from WONKA.
86.75% of target-first wins came from Test2.
72.29% of target-first wins came from WONKA.
```

This means:

```text
Do not lower BUY thresholds from this aggregate.
Do not enable paper BUY automation.
Do not run another unchanged Phase 9.4 batch.
Do not add another quote provider before correcting the measurement and quote path.
```

The useful conclusion is:

```text
Phase 9.4 proved selective Birdeye enrichment can run safely.
Phase 9.4 did not prove the current strategy is profitable or promotable.
```

## Phase 9.4A Direction

Phase 9.4A should be split into two ordered parts.

### Phase 9.4A.1 - Archive And Reporting Truthing

This part should be read-only and operate on existing Phase 9.4 archives before changing provider
behavior.

Detailed checklist:

- [NeXusTrade-Phase-9.4A.1-Detailed-Checklist.md](./NeXusTrade-Phase-9.4A.1-Detailed-Checklist.md)

Scope:

```text
report truncation visibility
full-session row counts
decision-level, first-per-mint, and best-per-mint views
buy-versus-sell quote attribution
quote-versus-price-impact attribution
Birdeye CU attribution
Birdeye budget-skip classification
unique enriched mints
enriched versus eligible-control outcomes
leave-one-run-out analysis
leave-one-mint-out analysis
blocker classification
scenario-portfolio audit
```

Reports must always disclose:

```text
rowsAvailable
rowsEvaluated
rowsDisplayed
displayLimit
displayTruncated
```

The goal is not `missingQuote = 0`. Some tokens genuinely have no supported route. The goal is:

```text
unclassifiedMissingQuote ~= 0
```

Split quote evidence into:

```text
buyQuoteAvailable
sellQuoteAvailable
roundTripQuoteAvailable
buyPriceImpactAvailable
sellPriceImpactAvailable
roundTripImpactAvailable
buyQuoteFailureReason
sellQuoteFailureReason
quotePresentButImpactMissing
```

### Phase 9.4A.2 - Adapter Correctness And Diagnostics

After historical report truthing, add targeted adapter corrections and diagnostics.

Scope:

```text
Raydium pool preflight request fix
Raydium top-level msg error parsing
deterministic Raydium failure classification
HTTP attempt telemetry
quote:diagnose command
latestQuoteAttempt versus lastSuccessfulQuote evidence
```

`quote:diagnose` should be read-only and should not write risk assessments, strategy decisions,
orders, fills, or positions.

Target diagnostic shape:

```powershell
corepack pnpm quote:diagnose `
    --mint=<mint> `
    --amount-sol=0.01 `
    --providers=JUPITER,RAYDIUM `
    --repeat=3 `
    --interval-ms=1200 `
    --json
```

It should test:

```text
SOL -> token
token -> SOL
```

And report:

```text
normalized request
request-key hash
provider order
cache lookup
raw attempts
HTTP status
rate-limit headers
preflight result
provider message
failure classification
route found
output amount
price impact
```

## Phase 9.4A Acceptance Gates

Phase 9.4A is split into A1 archive truthing and A2 runtime adapter diagnostics. A1 is complete.
A2 implementation and short validation are complete. Phase 9.4B is the selected next phase.

Phase 9.4A validation is complete when:

```text
All reports disclose truncation.
Full-session counts match database counts.
Buy, sell, and round-trip quote coverage are separate.
Quote and price-impact availability are separate.
Birdeye budget skips are not classified as provider failures.
Exact estimated Birdeye CU is reported.
Unique enriched mints are reported.
Enriched versus eligible-control outcomes are reported.
Leave-Test2-out and leave-WONKA-out analyses exist.
Scenario-portfolio calculations have dedicated tests.
Raydium control-route preflight succeeds with the documented full parameter set.
quote:diagnose --once exposes router, Raydium, and preflight evidence.
ProviderHealth includes sanitized HTTP attempts, Raydium detail codes, and latest-vs-last-success
quote diagnostics.
Unknown or unexplained quote-failure share is near zero.
orders/fills/positions remain 0.
```

Phase 9.4A.2 validation result:

```text
run = phase9.4A.2-short-20260806-1255
safetyStatus = PASS
orders/fills/positions = 0
quote:diagnose known route = healthy
runtime Raydium fallback = mostly NO_ROUTE after NO_POOL preflight
runtime Jupiter pressure = still material
Phase 9.4A.3 = deferred
Phase 9.4B = next
```

## Phase 9.4B Direction

Phase 9.4B follows Phase 9.4A and should focus on quote-provider pressure and runtime demand
control. Because A2 showed Raydium no-route/no-pool outcomes dominate for discovered mints, start
with demand reduction and venue-aware Raydium probe suppression before adding another provider.

Detailed checklist:

- [NeXusTrade-Phase-9.4B-Detailed-Checklist.md](./NeXusTrade-Phase-9.4B-Detailed-Checklist.md)

Recommended order:

```text
B1 Jupiter scheduler and provider-aware retries
B2 remove unnecessary demand and duplicate sell enrichment
B3 single-flight request joining and cache split
B4 preserve latest attempt and last successful quote evidence separately
B5 Raydium negative caching, circuit breaker, and venue-aware routing
```

Phase 9.4B is complete when:

```text
Jupiter raw 429 rate <= 5%.
Jupiter requests are visibly paced rather than bursty.
Rate-limit retries respect provider reset timing.
Duplicate sell enrichment is removed.
Single-flight joins are measurable.
Repeated WATCHING candidates follow a refresh cadence.
No-route results are negatively cached.
Latest-attempt and last-successful evidence are separate.
Risk-stage duration decreases materially.
Every residual missing quote has a classified reason.
orders/fills/positions remain 0.
```

## Provider Documentation Notes

Current external docs relevant to the next phases:

```text
Jupiter Free tier = 1 RPS and 60 RPM, shared across most Swap/Price/Token requests.
Jupiter exposes x-ratelimit-remaining, x-ratelimit-current, and x-ratelimit-reset.
Raydium /pools/info/mint requires mint1, poolType, poolSortField, sortType, pageSize, and page.
Raydium API envelopes expose a top-level msg field.
Birdeye /defi/price costs 3 CU.
Birdeye /defi/token_overview costs 20 CU.
```

References:

- Jupiter rate limits: https://developers.jup.ag/docs/portal/rate-limits
- Raydium pools by token mint: https://docs.raydium.io/api-reference/api-v3-endpoints/pools/get-pools-by-token-mint
- Raydium API v3 overview: https://docs.raydium.io/api-reference/api-v3/overview
- Birdeye compute unit cost: https://docs.birdeye.so/docs/compute-unit-cost
