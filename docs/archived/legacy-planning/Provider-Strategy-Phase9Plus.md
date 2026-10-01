# Provider Strategy Phase 9+

Active provider planning for Phase 9 and later.

Last updated: August 2026

## Purpose

This document captures how NeXusTrade should widen provider bottlenecks without turning Phase 9
into a provider-integration phase.

The current issue is not only Jupiter rate limiting. Jupiter quote availability affects quote
confidence and price-impact evidence, but strategy timing and drawdown behavior remain separate
research problems. Provider work should therefore improve observability, resilience, and evidence
quality before it changes trading behavior.

## Current Provider Roles

| Role                                         | Current providers | Future candidates                 | Notes                                                                                                  |
| -------------------------------------------- | ----------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Broad discovery and market data              | DexScreener       | Birdeye, GeckoTerminal            | Use for cheap monitoring, liquidity, volume, price, and post-run analytics.                            |
| Aggregated quote and route confidence        | Jupiter           | Autobahn, Titan                   | Use for high-intent candidates after cheap filters pass.                                               |
| Direct venue quote fallback                  | Raydium           | Orca and Meteora                  | Use when aggregate quotes rate-limit or when a known venue/pool is preferred.                          |
| Metadata, risk evidence, RPC, infrastructure | Helius            | QuickNode and other RPC providers | Use for token metadata, authority evidence, transactions, streams, and later execution infrastructure. |

## Current Account Constraints

Birdeye Standard is available and should be treated as selective enrichment only:

```text
included = 30000 CUs/month
rate limit = 1 RPS
overage = not allowed
WebSocket = no
```

Implication:

- Do not call Birdeye for every scanner candidate.
- Use Birdeye for top-scoring candidates, shadow-observed candidates, BUY-like candidates, open
  paper positions, missed-opportunity analysis, and calibration evidence.
- DexScreener remains the broad low-friction market-data source.

Titan and Autobahn should be treated as access-gated until working credentials and endpoint docs
are available:

- Titan: request systematic-trader or integration API access before planning an adapter.
- Autobahn: prefer hosted token/API access first; defer self-hosting until later infrastructure
  phases.

## Provider Ladder

Recommended runtime/provider decision ladder:

```text
1. Use a fresh cached quote or cached market snapshot when available.
2. Use DexScreener and later Birdeye for cheap price/liquidity/volume monitoring.
3. Use Helius for token metadata and risk evidence when available.
4. Use Jupiter for high-intent aggregate quotes only.
5. If Jupiter is unavailable or rate-limited, try Raydium direct quote only when the route is
   plausible and Raydium diagnostics are trustworthy.
6. If access exists, try Autobahn or Titan aggregate quote fallback.
7. For known pool routes, try Meteora or Orca pool-specific quote adapters.
8. If no quote is available, preserve missing-quote evidence instead of treating the candidate as bad.
```

The goal is not to spray requests across every provider. The goal is to reduce unnecessary quote
demand, then fall back deliberately for candidates that already passed cheap filters.

Quote provenance rule:

```text
quoteProvider = JUPITER | RAYDIUM | NONE
quoteSourceType = LIVE | CACHE | NONE
fallbackReason = NONE | JUPITER_RATE_LIMITED | JUPITER_COOLDOWN | JUPITER_UNAVAILABLE | ROUTER_POLICY | FORCED_PROVIDER
```

Provider identity and cache state should remain separate. For example, use
`quoteProvider=RAYDIUM` and `quoteSourceType=CACHE`, not `CACHE_RAYDIUM`.

## Phase Sequencing

### Phase 9

Build TerminalRunner and provider pressure reporting only. Implemented.

Phase 9 should report:

- quote attempts,
- quote successes,
- quote failures,
- rate-limited counts,
- degraded provider counts,
- cached quote hits when cache support exists,
- missing quote counts,
- candidates that moved favorably despite missing quotes.

Phase 9 should not add new external provider adapters unless explicitly re-scoped.

### Phase 9.1

Add read-only cross-run research aggregation and promotion-gate reporting. Implemented.

Phase 9.1 confirmed provider pressure remains material:

```text
Jupiter rateLimited = 52.67%
readiness = PROMISING_RESEARCH
controlledPaperPilotRecommended = no
paperBuyAutomationEnabled = no
```

### Phase 9.2

Add quote-budget and provider-resilience framework. Implemented:

- quote cache,
- rate-limit backoff,
- cooldown state for recent 429s,
- provider health-aware stage summaries,
- quote attempts only after cheap gates,
- per-provider fallback result contract.

Phase 9.2 keeps Jupiter as the only live quote provider and proves cache/backoff/router
behavior before adding new provider adapters.

### Phase 9.2B

Clean provider-pressure measurement before adding new providers. Implemented:

- distinguish live provider rate limits from quote-router cooldown skips,
- report cache hits, cooldown skips, and unavailable quote outcomes separately,
- reduce Jupiter `token-metadata-from-price` pressure,
- prefer Helius token metadata by default,
- increase research quote cache TTL to fit the 60-second TerminalRunner cadence,
- make Phase 9.2 archives load directly into `research:aggregate`.

Reason: Five Phase 9.2 runs showed quote cooldown skips worked, but cache hits were zero and most
live Jupiter pressure came from metadata, not quotes. Raydium would not address that metadata
pressure.

Implementation result:

```text
ProviderPressureClassifier separates live provider rows from router cache/cooldown rows.
Reports now show liveRateLimited, combinedRateLimited, cacheHits, and cooldownSkips separately.
PromotionGate cautions use live Jupiter rate limiting.
JUPITER_TOKEN_METADATA_ENABLED defaults to false.
Helius token metadata is preferred before optional Jupiter metadata fallback.
QUOTE_CACHE_TTL_MS defaults to 90000.
research:aggregate can load nested Phase 9.2 archive output folders directly.
```

### Phase 9.25

Add research interpretation and skipped-opportunity diagnostics. Implemented:

- high-scoring SKIP explanation,
- SKIP reason clustering,
- BUY/WATCH/SKIP decision attribution,
- explicit `blockers = none` handling as `score_threshold_only` or `unresolved_strategy_gate`,
- dedupe modes for decision-level, mint-level, first-per-mint, and best-per-mint reports,
- WARN condition outcome analysis,
- missing quote outcome analysis,
- market-window analytics,
- per-token missed-opportunity breakdowns,
- a final recommendation matrix choosing Phase 9.26, Phase 9.3, profile tuning, more data, or a
  separate controlled paper pilot review.

Reason: Once provider pressure is truthfully reported, the next highest-value work is explaining
which skipped candidates were actually promising and why.

Implementation result: `pnpm research:interpret --once` produces decision attribution, blocker
clusters, high-scoring SKIP review, WARN/missing-quote outcome analysis, market-window analysis,
per-token missed-opportunity summaries, and a recommendation matrix. The initial Phase 9.2B archive
smoke selected Phase 9.3 Raydium fallback because missing quote share remained high even after
Jupiter metadata pressure was removed.

Counterfactual decision analysis, such as "if quote existed then WATCH" or "if risk PASS then BUY,"
is valuable but should remain future Phase 9.26 or Phase 10 work.

### Phase 9.3

Add Raydium as the first direct `QuoteProvider` fallback. Implemented and first validation
reviewed. Phase
9.3 uses only the Raydium Trade API exact-input quote computation endpoint:

```text
GET https://transaction-v1.raydium.io/compute/swap-base-in
```

The first implementation should pass normalized quote request values as:

```text
inputMint
outputMint
amount
slippageBps
txVersion = V0
```

Phase 9.3 must not call Raydium transaction serialization endpoints, build transactions, load a
wallet, sign, submit, or enable paper BUY automation.

Reason: Phase 9.25 selected Raydium fallback because missing quote evidence remained high after
Jupiter metadata pressure was removed:

```text
decision mode missingQuote = 311 / 468
first_per_mint missingQuote = 15 / 35
best_per_mint missingQuote = 15 / 35
```

Raydium's Trade API is the closest fit for the existing normalized quote interface. No Raydium API
key is required for the first quote-only implementation unless validation proves otherwise.

Implementation result:

```text
RaydiumAdapter implemented behind QuoteProvider
quote provider order = JUPITER then RAYDIUM
fallback reasons recorded for Jupiter rate limit, cooldown, and unavailable outcomes
quote source type counts distinguish LIVE and CACHE quote evidence
provider pressure reports include Raydium rows when Raydium is used
transaction serialization endpoints remain out of scope
```

Phase 9.3 must make the experiment measurable:

```text
missingQuote percentage before/after
Raydium quote success count
Jupiter liveRateLimited before/after
quote provider distribution
quote live/cache distribution
Raydium fallback reason distribution
safety rows: orders/fills/positions remain zero
```

Phase 9.3 ends with an evidence decision, not an automatic jump to Phase 9.4:

```text
remain on Raydium and collect more data
proceed to Phase 9.26 counterfactual analysis
proceed to Phase 9.31 provider-aware quote confidence work
proceed to Phase 9.4 Birdeye selective enrichment
evaluate another quote fallback first
```

Validation result:

```text
Raydium fallback path exists.
Missing quote improved at both decision and mint level.
Raydium ERROR share was too high for confidence.
Helius live rate limiting became the next major provider-pressure issue.
Paper BUY remains disabled.
```

### Phase 9.3B

Add Raydium diagnostics and Helius pressure cleanup before provider expansion. Implemented;
validation complete.

Use current Raydium docs surfaces as:

```text
Route API v2 compute quote = quote evidence
API v3 mint price = price diagnostics only
API v3 pools by token mint = route/pool preflight only
transaction build endpoints = forbidden
```

Phase 9.3B should:

- classify Raydium quote errors by category,
- record sanitized Raydium `success=false` messages and HTTP status,
- add optional Raydium pool preflight before quote compute,
- add optional Raydium mint-price diagnostics without treating them as quote evidence,
- add Helius metadata/risk evidence cache and backoff,
- report Helius live calls, cache hits, cooldown skips, and live rate limits separately,
- keep paper BUY automation disabled.

Implementation result:

```text
Raydium error categories are recorded in ProviderHealth context and surfaced in reports.
Raydium API v3 pool preflight can skip obvious no-pool quote attempts without creating quote evidence.
Raydium API v3 mint price diagnostics can record known/unknown mint price without satisfying quote evidence.
Helius metadata/risk evidence can hit in-memory cache by mint.
Helius getAsset rate limits trigger operation backoff and low-priority cooldown skips.
TerminalRunner, analytics, calibration, research aggregate, research interpretation, and providers:smoke surface compact diagnostic counts.
No wallet, signing, transaction submission, paper BUY automation, or DB migration was added.
```

Validation result:

```text
Phase 9.3B safety passed across the validation batch.
Helius free-plan credits were exhausted on July 16, 2026.
Helius-enabled runs measured account-level quota exhaustion, not a recoverable application-side rate limit.
The no-Helius run remained safe but left authority evidence broadly unavailable.
Raydium failure diagnostics worked, but full-run Raydium quote outcomes remained 0% OK.
Raydium failures were consistently RAYDIUM_UNAVAILABLE with preflight FAILED for discovered candidate routes.
Jupiter remained usable but pressured, around 50% combined rate-limited in the final full runs.
```

Provider implication:

```text
Do not depend on Helius free-plan credits for long validation batches.
Do not expand immediately to paper BUY.
Do not treat Raydium as a healthy quote fallback yet.
Prioritize Phase 9.3C: raw Solana RPC authority evidence, then QuickNode DAS / Alchemy DAS metadata fallback.
```

### Phase 9.3C

Add Helius fallback / RPC authority evidence before Birdeye or paper BUY automation. Implemented;
provider validation and post-fix follow-up validation complete.

Provider order for authority evidence:

```text
SOLANA_RPC first
HELIUS only when explicitly enabled and available
RUGCHECK later if a selective security provider is added
```

Provider order for token metadata:

```text
SOLANA_RPC
QUICKNODE_DAS
ALCHEMY_DAS
HELIUS
JUPITER optional metadata fallback
```

Phase 9.3C implementation now:

- parse raw Solana mint accounts with `getAccountInfo`,
- distinguish mint authority `PRESENT`, `DISABLED`, and `UNKNOWN`,
- distinguish freeze authority `PRESENT`, `DISABLED`, and `UNKNOWN`,
- use QuickNode DAS and Alchemy DAS only as metadata/asset fallbacks in the first pass,
- defer Shyft and similar token-info providers until RPC + DAS validation proves a remaining gap,
- keep unknown authority evidence conservative,
- keep paper BUY automation disabled.

Validation note:

```text
SOLANA_RPC worked as the authority-evidence provider with 0% rate limiting and 22028 parsed
authority evidence rows across the first three runs. The first validation still showed
missingAuthority on every interpreted decision because the risk rule had not yet consumed explicit
DISABLED authority states as PASS evidence.

The July 19, 2026 follow-up validated the fix:

missingAuthorityEvidenceCount = 0
missingAuthority = 0
SOLANA_RPC authority evidence rows = 4005
SOLANA_RPC liveRateLimited = 0%
orders/fills/positions = 0

Phase 9.3C is accepted as the Helius authority-evidence fallback. The remaining issue is quote
coverage: Jupiter remained pressured and Raydium stayed unavailable for discovered candidate quotes.
```

Detailed checklist:

- [NeXusTrade-Phase-9.3C-Detailed-Checklist.md](./NeXusTrade-Phase-9.3C-Detailed-Checklist.md)

### Phase 9.4

Add Birdeye as a selective market-data enrichment provider. Implemented; validation complete.

Reason: Birdeye Standard is useful for deeper monitoring and post-run analytics, but its 1 RPS and
monthly CU limit make it unsuitable for broad scanning.

Phase 9.4 should use Birdeye only for high-intent candidates:

```text
WATCH decisions with risk PASS
score >= 50 report candidates
missingQuote candidates with promising DexScreener liquidity/volume
missed-opportunity analysis candidates
```

Birdeye should provide:

```text
current price
price/volume snapshot
token overview by selected frames
market activity diagnostics
selective post-run enrichment
```

Birdeye should not provide:

```text
executable quote evidence
price-impact evidence
paper BUY permission
strategy threshold changes
```

Detailed checklist:

- [NeXusTrade-Phase-9.4-Detailed-Checklist.md](./NeXusTrade-Phase-9.4-Detailed-Checklist.md)

Phase 9.4 validation conclusion:

```text
Birdeye operational integration passed.
Birdeye cache and budget guardrails passed.
Birdeye external rate limiting was 0%.
Birdeye budget skips need non-error classification.
Birdeye attribution reporting remains incomplete.
Strategy promotion remains denied.
```

Detailed closeout:

- [NeXusTrade-Phase-9.4-Conclusion-and-9.4A-Prep.md](./NeXusTrade-Phase-9.4-Conclusion-and-9.4A-Prep.md)

### Phase 9.4A

Make validation evidence trustworthy before changing runtime provider behavior.

Phase 9.4A.1 should be archive/reporting truthing:

```text
full-session row counts
truncation disclosure
buy/sell/round-trip quote attribution
quote versus price-impact attribution
exact Birdeye CU and enriched-mint attribution
leave-one-run-out and leave-one-mint-out analysis
clear blocker taxonomy
scenario-portfolio audit
```

Detailed checklist:

- [NeXusTrade-Phase-9.4A.1-Detailed-Checklist.md](./NeXusTrade-Phase-9.4A.1-Detailed-Checklist.md)

Implementation result:

```text
pnpm research:truth --once
Phase 9.4 T1/T2/T3 archive smoke passed safety
orders/fills/positions = 0
decisionRows = 2458
missingQuote = 2037
unclassifiedMissingQuote = 0
Birdeye budget skips = 66 policy/guardrail skips, not provider failures
Birdeye provider failures = 0
dominant run = T2, 87.78% of target-first wins
dominant mint = WONKA, 71.11% of target-first wins
```

Provider implication:

```text
Do not jump directly to more providers from Phase 9.4A.1.
Do not enable paper BUY.
Proceed to Phase 9.4A.2 adapter correctness and diagnostics.
```

Phase 9.4A.2 implements adapter correctness and diagnostics:

```text
Raydium preflight query parameters
Raydium top-level msg parsing
deterministic Raydium failure classification and nonretryable request errors
HTTP attempt telemetry
latestQuoteAttempt versus lastSuccessfulQuote evidence
derived rate-limit hints and opt-in round-trip quote:diagnose command
```

Implementation result:

```text
Raydium preflight now sends the full documented /pools/info/mint parameter set.
Raydium compute failures read top-level msg and classify documented REQ_* details.
Provider results carry sanitized httpAttempts and diagnostics.
ProviderHealth summarizes HTTP attempts without raw URLs, headers, or API keys.
QuoteAttemptJournal separates latest attempt from last successful quote.
quote:diagnose --once is available for bounded PAPER-mode diagnostics.
```

Detailed checklist:

- [NeXusTrade-Phase-9.4A.2-Detailed-Checklist.md](./NeXusTrade-Phase-9.4A.2-Detailed-Checklist.md)

Current Raydium contract to enforce:

```text
compute quote = GET /compute/swap-base-in
  inputMint, outputMint, amount, slippageBps, txVersion

pair preflight = GET /pools/info/mint
  mint1, mint2, poolType=all, poolSortField=liquidity, sortType=desc, pageSize=5, page=1

failure envelope = success=false with top-level msg
```

The preflight is diagnostic only. It must never become executable quote evidence, and Raydium
transaction endpoints remain forbidden. The new attempt telemetry must be sanitized, bounded, and
separate latest quote failure/cooldown evidence from the last successful quote retained only for
diagnosis.

Success target:

```text
unclassifiedMissingQuote ~= 0
```

The target is not zero missing quotes because some tokens legitimately have no supported route.

Validation result:

```text
phase9.4A.2-short-20260806-1255
safetyStatus = PASS
orders/fills/positions = 0
Raydium failures = NO_ROUTE after NO_POOL preflight
Jupiter remains pressured
Birdeye and Solana RPC healthy
Phase 9.4A.3 = deferred
Phase 9.4B = implemented; runtime validation pending
```

### Phase 9.4B

Reduce quote-provider pressure now that Phase 9.4A.2 made the measurements trustworthy enough for
the next runtime pass. Because A.2 showed no-route outcomes dominate Raydium fallback, first use
DexScreener pair/venue evidence to suppress implausible Raydium probes before adding another
provider. Phase 9.4A.3 remains conditional only if later evidence shows the bounded diagnostic
evidence cannot be retained in existing telemetry.

Detailed checklist:

- [NeXusTrade-Phase-9.4B-Detailed-Checklist.md](./NeXusTrade-Phase-9.4B-Detailed-Checklist.md)

Implementation completed in this order:

```text
Jupiter scheduler and provider-aware retries
remove duplicate sell enrichment and unnecessary quote demand
single-flight request joining and cache split
preserve latest attempt and last successful quote evidence
Raydium negative caching, circuit breaker, and venue-aware routing
```

### Phase 9.4C

Refine Jupiter demand before adding another quote source:

- use one process-wide Jupiter allowance across price and quote operations,
- adapt after actual 429 results or sanitized Retry-After hints,
- defer lower-priority research calls explicitly rather than treating them as provider failure,
- keep Phase 9.4B Raydium venue guard and negative cache intact,
- keep Helius disabled for quote-pressure validation,
- make a free-tier versus paid-tier decision only after the controlled evidence is reviewed.

Detailed checklist: [NeXusTrade-Phase-9.4C-Detailed-Checklist.md](./NeXusTrade-Phase-9.4C-Detailed-Checklist.md).

### Phase 9.5

Evaluate access-gated aggregate quote providers:

- Autobahn hosted API if a token is available,
- Titan DART/Gateway API if integration access is approved.

Self-hosted Autobahn should remain deferred unless hosted access is unavailable and the expected
benefit justifies infrastructure complexity.

### Phase 9.4D

Allocate the existing safe quote capacity before expanding providers:

- plan one bounded quote-candidate subset per risk batch from already stored local evidence,
- retain `JUPITER -> RAYDIUM`, the shared Jupiter controller, and the Raydium venue guard,
- record `QUOTE_BUDGET_NOT_SELECTED` as a local allocation outcome rather than provider failure,
- default to 20 selected candidates per TerminalRunner risk cycle, with deterministic local-only
  recency/liquidity/volume/age/prior-evidence attribution,
- preserve non-quote evidence refresh for unselected candidates and the unchanged router path for
  selected candidates,
- surface allocation separately in risk evidence, terminal counts, analytics, and research reports,
- compare selected-candidate quote coverage with Phase 9.4C before evaluating Phase 9.5 access.

Result: complete and runtime-validated. Across three full validations, allocation avoided an
estimated 1,814 quote calls while selected-candidate quote coverage was 96.44% and Jupiter
upstream rate limiting remained 0%. Keep `JUPITER -> RAYDIUM` and defer Phase 9.5/9.6 provider
expansion unless future selected-coverage evidence deteriorates. The next research step is
counterfactual strategy-gate analysis, not another quote provider.

Detailed checklist: [NeXusTrade-Phase-9.4D-Detailed-Checklist.md](./NeXusTrade-Phase-9.4D-Detailed-Checklist.md).

### Phase 9.6

Add pool-specific direct quote adapters:

- Meteora DLMM,
- Orca Whirlpools.

These are more pool-aware than Jupiter/Raydium-style route quotes and should come after the system
tracks pair/pool context more deliberately.

## Implementation Boundaries

Provider additions must preserve:

- `PAPER` default mode,
- no wallet loading,
- no signing,
- no transaction submission,
- no live DB access,
- no paper BUY enablement without a later strategy-promotion review,
- no raw API payload logging by default,
- no API keys in logs, reports, or generated artifacts.

## Open Planning Questions

- Should quote cache live in memory only at first, or should later phases persist it?
- Should Jupiter token metadata fallback stay disabled by default after Phase 9.2B?
- Which Birdeye endpoint mix provides the best value after Phase 9.4 validation?
- Does Titan grant quote-only access suitable for paper/shadow research?
- Does Autobahn hosted access support the endpoints needed for quote-only fallback?
- When should QuickNode or another RPC provider become necessary for reliability?

Resolved for Phase 9.3:

- Raydium API/auth model: public Raydium Trade API quote endpoint, no API key required for the
  first quote-only implementation.

## References

- [Provider Architecture](./Provider-Architecture.md)
- [Phase 9 Planning Inputs](./Phase-9-Planning-Inputs.md)
- [NeXusTrade Phase 9 Detailed Checklist](./NeXusTrade-Phase-9-Detailed-Checklist.md)
- [NeXusTrade Phase 9.2 Detailed Checklist](./NeXusTrade-Phase-9.2-Detailed-Checklist.md)
- [NeXusTrade Phase 9.2B Detailed Checklist](./NeXusTrade-Phase-9.2B-Detailed-Checklist.md)
- [NeXusTrade Phase 9.25 Detailed Checklist](./NeXusTrade-Phase-9.25-Detailed-Checklist.md)
- [NeXusTrade Phase 9.3 Detailed Checklist](./NeXusTrade-Phase-9.3-Detailed-Checklist.md)

## Phase 9.4C Jupiter Demand Control

Jupiter price and quote requests share one process-local adaptive demand budget. The default
controller is intentionally below the keyed free-tier request ceiling and defers low-priority
price/diagnostic work before it spends capacity reserved for quote evidence. Controller deferrals
are local policy outcomes, not upstream rate limits, and retain the existing `JUPITER -> RAYDIUM`
quote fallback path. No API keys, raw headers, or raw payloads are recorded.
