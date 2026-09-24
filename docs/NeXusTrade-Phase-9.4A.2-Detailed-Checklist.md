# NeXusTrade Phase 9.4A.2 Detailed Checklist

Adapter correctness and diagnostics

Last updated: August 2026

## Status

Implemented and short-runtime validated.

Phase 9.4A.2 is the runtime half of Phase 9.4A:

```text
9.4A.1 Archive and reporting truthing  -> implemented and smoke-validated
9.4A.2 Adapter correctness and diagnostics -> implemented and validated
9.4B Quote-pressure reduction           -> planned next
```

The Phase 9.4A.1 archive truthing smoke selected this work because the evidence is now
classifiable, but the Raydium adapter and generic quote telemetry are not yet trustworthy enough
to decide whether provider-pressure reduction or another provider is the next best step.

## Implementation Closeout Notes

Phase 9.4A.2 implemented the runtime adapter and diagnostics surface without changing strategy,
provider order, paper execution, wallet behavior, or database schema.

Implemented:

```text
Raydium API v3 preflight now sends mint1, mint2, poolType, poolSortField, sortType,
pageSize, and page.
Raydium compute failure envelopes now read top-level msg before compatibility fallbacks.
Documented REQ_* messages receive stable raydiumFailureDetail values.
ProviderResult now carries additive sanitized httpAttempts and diagnostics.
ProviderHttpClient records endpoint-id attempt telemetry without raw URLs, headers, or keys.
withProviderRetries preserves ordered attempt telemetry across retries.
ProviderHealth context now includes compact HTTP attempt summaries.
QuoteAttemptJournal records latest attempt separately from last successful quote.
QuoteProviderRouter updates the journal on live success, cache hit, cooldown skip, provider
failure, fallback, and final unavailable paths.
ProviderPressureClassifier aggregates Raydium detail, preflight detail, HTTP attempt, and
latest-vs-last-success diagnostics.
providers:smoke prints compact A2 diagnostic counts.
quote:diagnose --once provides a bounded PAPER-mode router/Raydium/preflight diagnostic command.
```

Validation completed during implementation:

```text
backend typecheck passed
focused backend Vitest coverage passed, including provider diagnostics paths
```

Final validation before Phase 9.4B:

```text
corepack pnpm verify passed
corepack pnpm providers:smoke passed
corepack pnpm quote:diagnose --once --mode=all passed during implementation
one short 30-minute TerminalRunner validation passed
```

Short runtime validation:

```text
run = phase9.4A.2-short-20260806-1255
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
Watchlist returns = 100, observed = 25
Birdeye total = 64, failures = NONE, rateLimited = 0%
Jupiter total = 732, liveRateLimited ~= 20.31%, combinedRateLimited ~= 58.47%
Raydium total = 858, raydiumFailures = NO_ROUTE 429, raydiumPreflight = NO_POOL 429
Solana RPC total = 2488, rpcFailures = NONE, rateLimited = 0%
```

Validation conclusion:

```text
Adapter correctness evidence is now usable.
Raydium is not broadly failing from malformed requests in this run.
Raydium fallback is mostly unavailable because discovered mints lack Raydium pair-pool routes.
Jupiter remains the main quote-pressure bottleneck.
Birdeye and Solana RPC behaved well under the 30-minute validation.
Phase 9.4A.3 is not needed now.
Proceed to Phase 9.4B.
```

## Objective

Make every quote outcome technically explainable without changing the strategy, quote-provider
order, or execution behavior.

```text
Correct Raydium API v3 preflight request
  -> parse documented Raydium error envelopes
  -> classify deterministic failures precisely
  -> retain sanitized HTTP-attempt evidence
  -> distinguish latest quote attempt from last successful quote
  -> expose a bounded one-shot diagnostic command
  -> make the evidence visible in existing research reports
```

The goal is not `missingQuote = 0`. Some tokens genuinely have no route or unsupported token
program. The goal is:

```text
unclassifiedMissingQuote ~= 0
```

## Evidence And Current State

Phase 9.4A.1 established, from the three archived Phase 9.4 runs:

```text
orders/fills/positions = 0
decisionRows = 2458
missingQuote = 2037
unclassifiedMissingQuote = 0 in archive classification
Birdeye budget skips = 66 policy/guardrail skips
Birdeye provider failures = 0
dominant run = T2, 87.78% of target-first wins
dominant mint = WONKA, 71.11% of target-first wins
recommendation = proceed to Phase 9.4A.2
```

Current runtime gaps:

```text
Raydium API v3 preflight sends only mint1 and mint2.
The current documented pool endpoint also requires poolType, poolSortField, sortType,
pageSize, and page.
Raydium quote envelopes can put an error code/message in top-level msg, but the adapter only
looks inside data.
ProviderHealth captures the final provider result, not the full retry/HTTP-attempt sequence.
The quote cache retains a successful result, but reports cannot clearly see the later failed or
cooldown-skipped attempt that followed it.
```

## Current Official Raydium Contract

Validate the implementation against the current official pages immediately before coding. The
implementation must use the API contract, not assumptions copied from historical run output.

- [Raydium Route API V2 overview](https://docs.raydium.io/api-reference/route-api-v2/overview)
- [Raydium API v3 pool lookup by mint](https://docs.raydium.io/api-reference/api-v3-endpoints/pools/get-pools-by-token-mint)
- [Raydium API v3 overview](https://docs.raydium.io/api-reference/api-v3/overview)

The documented read-only quote request is:

```text
GET https://transaction-v1.raydium.io/compute/swap-base-in

inputMint     required
outputMint    required
amount        required, integer smallest units of the input mint
slippageBps   required, 0 through 10000
txVersion     required, V0 or LEGACY
```

The documented API v3 pair-pool preflight request is:

```text
GET https://api-v3.raydium.io/pools/info/mint

mint1         required
mint2         optional for a one-mint lookup, supplied for the pair preflight
poolType      required, default Phase 9.4A.2 value = all
poolSortField required, default Phase 9.4A.2 value = liquidity
sortType      required, default Phase 9.4A.2 value = desc
pageSize      required, default Phase 9.4A.2 value = 5
page          required, default Phase 9.4A.2 value = 1
```

Raydium documents both success and failure envelopes at the top level:

```text
success = true  -> data contains endpoint data
success = false -> msg contains the documented error code/message
```

The compute endpoint remains quote-only. Transaction creation endpoints are forbidden in this
phase.

## Safety Boundary

Phase 9.4A.2 may:

- Make bounded live provider calls through existing quote adapters.
- Correct API v3 preflight parameters and Raydium response parsing.
- Add sanitized runtime telemetry to `ProviderHealth.contextJson` and `SystemLog`.
- Add bounded in-memory diagnostic state for quote attempts.
- Add a one-shot `quote:diagnose` command and optional ignored output artifacts.
- Extend reports with aggregated diagnostic counts.
- Update tests and documentation.

Phase 9.4A.2 must not:

- Change the quote-provider order: keep `JUPITER -> RAYDIUM`.
- Change scanner/risk/strategy thresholds, score weights, profiles, or promotion gates.
- Treat Birdeye price/overview as executable quote evidence.
- Add a provider, migration, wallet loading, signing, transaction build, submission, or live swap.
- Create a paper order, fill, position, or session.
- Call Raydium `/transaction/*` endpoints.
- Enable paper BUY or paper SELL automation.
- Store API keys, authorization headers, full request URLs, unbounded payloads, or transaction-like
  content in logs, telemetry, or output artifacts.

The command is read-only with respect to trading state. Provider-health and system-log telemetry
writes are permitted operational diagnostics; core trading tables must remain unchanged.

## Locked Design Decisions

```text
Raydium compute quote:     use only GET /compute/swap-base-in.
Raydium preflight:         API v3 pair lookup, fully parameterized from current docs.
Preflight meaning:         diagnostic route/pool evidence, never quote evidence.
Failure model:             stable broad category plus a precise deterministic detail code.
HTTP telemetry:            sanitized per attempt, including retries, no headers/payloads/URLs.
Latest vs last success:    retain separately in bounded in-memory quote diagnostic state and in
                           sanitized router health context for each relevant event.
Rate signals:               retain only derived Retry-After/rate-limit fields; never raw headers.
Round trip:                 optional diagnostic-only buy-then-sell probe, disabled by default.
Persistence:               existing ProviderHealth.contextJson only; no migration.
Diagnostic CLI:            one-shot, PAPER mode, no Session creation, no scanner/risk/strategy.
Validation:                provider smoke plus one short TerminalRunner run after unit coverage.
Next phase:                Phase 9.4B only after diagnostic evidence is correct and complete.
```

## Proposed Files

Add:

```text
backend/src/providers/quotes/QuoteAttemptJournal.ts
backend/src/providers/quotes/QuoteAttemptJournal.test.ts
backend/src/quote-diagnostics/QuoteDiagnoseConfig.ts
backend/src/quote-diagnostics/QuoteDiagnoseConfig.test.ts
backend/src/quote-diagnostics/QuoteDiagnoseTypes.ts
backend/src/quote-diagnostics/QuoteDiagnoseRunner.ts
backend/src/quote-diagnostics/QuoteDiagnoseReportFormatter.ts
backend/src/scripts/quote-diagnose.ts
```

Note: HTTP attempt telemetry was implemented directly inside `ProviderHttpClient` and
`providerRetry` rather than adding a separate telemetry helper file. The behavior remains additive
and sanitized.

Modify:

```text
shared/src/providers/provider-results.ts
backend/src/providers/http/ProviderHttpClient.ts
backend/src/providers/http/providerRetry.ts
backend/src/providers/config/providerConfig.ts
backend/src/providers/ProviderRegistry.ts
backend/src/providers/ProviderHealthService.ts
backend/src/providers/ProviderPressureClassifier.ts
backend/src/providers/quotes/QuoteProviderRouter.ts
backend/src/providers/quotes/index.ts
backend/src/providers/raydium/RaydiumAdapter.ts
backend/src/providers/raydium/RaydiumPoolPreflightService.ts
backend/src/providers/raydium/raydium.schemas.ts
backend/src/providers/raydium/RaydiumErrorClassifier.ts
backend/src/providers/raydium/*.test.ts
backend/src/scripts/providers-smoke.ts
backend/src/terminal-runner/TerminalRunSummary.ts
backend/src/analytics/*
backend/src/calibration/*
backend/src/research/*
backend/src/research-truthing/*
package.json
backend/package.json
docs/ROADMAP_Phase9Plus.md
docs/Structure_Phase9Plus.md
docs/DECISIONS_Phase9Plus.md
docs/Phase-9-Planning-Inputs.md
docs/Provider-Strategy-Phase9Plus.md
```

Use the existing code paths where practical:

```text
ProviderHttpClient
withProviderRetries
ProviderHealthService
ProviderPressureClassifier
QuoteProviderRouter
QuoteCache
RaydiumAdapter
RaydiumPoolPreflightService
RaydiumPreflightCache
providers:smoke
research:truth
```

Do not add a database migration.

## Runtime Defaults

Add explicit, validated Raydium preflight defaults. They should match the current docs and remain
overridable only for controlled diagnostics:

```text
RAYDIUM_PRECHECK_ENABLED=true
RAYDIUM_PRECHECK_TTL_MS=60000
RAYDIUM_PREFLIGHT_POOL_TYPE=all
RAYDIUM_PREFLIGHT_SORT_FIELD=liquidity
RAYDIUM_PREFLIGHT_SORT_TYPE=desc
RAYDIUM_PREFLIGHT_PAGE_SIZE=5
RAYDIUM_PREFLIGHT_PAGE=1
RAYDIUM_CAPTURE_SANITIZED_ERROR_CONTEXT=true
RAYDIUM_MAX_ERROR_MESSAGE_LENGTH=240
QUOTE_ATTEMPT_JOURNAL_ENABLED=true
QUOTE_ATTEMPT_JOURNAL_TTL_MS=300000
QUOTE_ATTEMPT_JOURNAL_MAX_ENTRIES=1000
```

Validation rules:

```text
poolType       = all | concentrated | standard | allFarm | concentratedFarm | standardFarm
poolSortField  = default | liquidity | volume24h | fee24h | apr24h | volume7d | fee7d |
                 apr7d | volume30d | fee30d | apr30d
sortType       = asc | desc
pageSize       = integer 1 through 1000
page           = integer >= 1
journal TTL    = positive integer milliseconds
journal size   = positive integer
```

Do not change existing rate-limit, retry, cache, or quote-provider-order defaults in this phase.
Provider-aware scheduling and demand reduction are Phase 9.4B work.

### Additional Adapter Rules

- Treat deterministic documented Raydium request errors, including missing/invalid required
  preflight parameters and unsupported request values, as nonretryable after one classified
  response. Transient HTTP, network, and rate-limit errors retain the existing bounded retry policy.
- Sanitize rate-limit hints into derived fields only: `rateLimitRemaining`, `rateLimitResetAtMs`, and
  `retryAfterMs`. Do not retain raw headers or raw response bodies.
- `quote:diagnose --round-trip` is opt-in. It may perform a buy quote followed by a sell quote using
  the successful buy output amount as the sell input. It must report each leg separately and remain
  quote-only, wallet-free, and non-persistent outside bounded diagnostics.

## Data Shapes

### Sanitized HTTP Attempt

Add an optional shared telemetry shape to `ProviderResult`. It must be additive so existing
adapters retain current behavior until they opt in.

```text
provider
operation                 quote | preflight | mint_price | other bounded identifier
endpointId                RAYDIUM_COMPUTE_SWAP_BASE_IN | RAYDIUM_POOL_PREFLIGHT | ...
method                    GET | POST
attemptNumber             1-based within one logical provider operation
outcome                   OK | HTTP_ERROR | TIMEOUT | NETWORK_ERROR | RATE_LIMITED |
                          INVALID_RESPONSE
statusCode                optional
latencyMs
rateLimiterWaitMs         optional
retryable
failureCode               optional normalized ProviderErrorCode
```

Never record:

```text
API keys
Authorization/x-api-key headers
Cookie headers
full query URLs
raw response bodies
wallets
private keys
transaction payloads
```

Public mint addresses remain in existing adapter request context only when needed for local
diagnosis. Aggregate reports should use counts and bounded examples, not unbounded row dumps.

### Raydium Failure Detail

Keep the current broad `raydiumFailureCategory` for report compatibility. Add a new optional,
stable `raydiumFailureDetail` for deterministic Raydium `msg` codes:

```text
NONE
REQ_INPUT_MINT_ERROR
REQ_OUTPUT_MINT_ERROR
REQ_AMOUNT_ERROR
REQ_SLIPPAGE_BPS_ERROR
REQ_TX_VERSION_ERROR
NO_ROUTE
UNSUPPORTED_TOKEN_PROGRAM
HTTP_4XX
HTTP_5XX
RATE_LIMITED
TIMEOUT
SCHEMA_INVALID
MAPPER_ERROR
UNKNOWN
```

Rules:

- A known top-level Raydium `msg` takes precedence over generic HTTP/body wording.
- `REQ_INPUT_MINT_ERROR` and `REQ_OUTPUT_MINT_ERROR` map to broad `UNSUPPORTED_MINT`.
- `REQ_AMOUNT_ERROR` and `REQ_SLIPPAGE_BPS_ERROR` map to broad `BAD_AMOUNT`.
- `REQ_TX_VERSION_ERROR` maps to broad `BAD_REQUEST`.
- A known explicit no-route/pool message maps to broad `NO_ROUTE`.
- `success=false` with a sanitized top-level `msg` must never be reported as unclassified.
- Preserve the original sanitized message only when the current capture flag is enabled.

### Quote Attempt Snapshot

Add a bounded in-memory `QuoteAttemptJournal` owned by `QuoteProviderRouter`. It is diagnostic
state, not a new cache and not a source of trade pricing.

```text
requestKey                 existing normalized request key, never printed as a secret
latestAttempt:
  attemptedAt
  provider
  sourceType               LIVE | CACHE | NONE
  outcome                  SUCCESS | FAILURE | COOLDOWN_SKIP
  fallbackReason
  failureCode              optional
  raydiumFailureCategory   optional
  raydiumFailureDetail     optional
  httpAttemptCount
  lastHttpStatus           optional

lastSuccessfulQuote:
  succeededAt
  provider
  sourceType               LIVE | CACHE
  outputAmountRaw
  estimatedPriceImpactPct  optional
  fallbackReason
  ageMs
```

Rules:

- Every router call updates `latestAttempt`, including cache hits and cooldown skips.
- Only a successful quote updates `lastSuccessfulQuote`.
- A failed live call must not erase `lastSuccessfulQuote`.
- The journal is TTL-bounded and size-bounded, and evicts oldest/expired entries deterministically.
- A stale `lastSuccessfulQuote` is diagnostic evidence only. It must not convert a later failed
  quote attempt into usable live quote evidence.
- Phase 9.4B may later split caches and retain richer state. Phase 9.4A.2 only exposes the
  evidence needed to diagnose the current behavior.

## Command Surface

Add root and backend scripts:

```json
{
  "quote:diagnose": "pnpm --filter @nexustrade/backend quote:diagnose"
}
```

Primary shape:

```bash
pnpm quote:diagnose --once
```

Supported options:

```text
--once                           required; loop mode is not supported
--input-mint=<mint>              default SOL wrapped mint
--output-mint=<mint>             default USDC mint
--amount-raw=<integer>           default 100000000
--slippage-bps=<integer>         default 100
--mode=router|raydium|preflight|all
--json
--output-dir=<ignored-data-path>
--session-id is forbidden
```

Behavior:

- Require `PAPER` mode.
- Validate mint addresses, positive integer amount, and slippage range before any provider call.
- `router` exercises the normal `JUPITER -> RAYDIUM` route once.
- `raydium` calls the direct quote adapter once.
- `preflight` calls only the direct API v3 pair lookup once.
- `all` runs those bounded probes in the documented order and prints each result separately.
- Do not invoke scanner, enrichment, risk, strategy, shadow, reports, session creation, paper buy,
  paper sell, or exit services.
- Write ProviderHealth/SystemLog operational evidence only when normal provider health writing is
  enabled. Do not create Session rows.
- `--json` produces stable, sanitized JSON. `--output-dir` writes only bounded text/JSON artifacts
  under an ignored `data/` path.

Expected report sections:

```text
Safety Boundary
Configured Provider Order
Input Contract
Raydium Preflight Contract
Per-Probe Result
HTTP Attempt Timeline
Raydium Failure Classification
Latest Attempt Versus Last Successful Quote
ProviderHealth Write Summary
Recommended Next Action
```

## Implementation Chunks

### Chunk 1 - Configuration, Shared Types, And Command Skeleton

Tasks:

- Extend `RaydiumProviderConfig` with the validated preflight parameters.
- Add bounded `QuoteAttemptJournal` configuration to quote resilience configuration or a focused
  quote diagnostics configuration, following the repository's current config style.
- Add parser tests for valid defaults, valid overrides, and every invalid enum/range.
- Add `QuoteDiagnoseConfig`, runner, formatter, script, and package scripts.
- Update `.env.example` only if it already exists and only with non-secret default settings.

Acceptance:

```text
No API key is needed for this phase.
Existing environments keep their current behavior except for corrected preflight parameters.
Invalid diagnostic command options fail before a network call.
quote:diagnose rejects non-PAPER mode and --session-id.
```

### Chunk 2 - Correct Raydium API v3 Preflight Contract

Tasks:

- Update `RaydiumPoolPreflightService` to pass every required current API v3 query parameter.
- Keep `mint1=inputMint` and `mint2=outputMint`; the API normalizes pair ordering internally.
- Use the locked defaults: `all`, `liquidity`, `desc`, `5`, `1`.
- Parse the documented outer envelope explicitly, including top-level `success` and `msg`.
- Preserve `FOUND`, `NO_POOL`, `FAILED`, and `DISABLED` semantics.
- Record sanitized preflight evidence:

```text
raydiumPreflightStatus
raydiumPreflightCacheStatus
raydiumPreflightPoolType
raydiumPreflightSortField
raydiumPreflightSortType
raydiumPreflightPageSize
raydiumPreflightPage
raydiumPoolsFound
raydiumPreflightFailureDetail
```

- Keep preflight as diagnostic only. A `FOUND` pool must not be represented as a successful compute
  quote; a `NO_POOL` must not suppress a direct compute diagnostic when `quote:diagnose --mode=all`
  explicitly asks for both probes.

Acceptance:

```text
The mocked request URL exactly matches the documented parameter set.
SOL -> USDC smoke preflight returns a parseable result when the remote API is available.
An API v3 success=false/msg response becomes FAILED with a sanitized message/detail.
No preflight result becomes executable quote evidence.
```

### Chunk 3 - Parse Raydium Compute Failure Envelopes Correctly

Tasks:

- Update `raydiumQuoteEnvelopeSchema` to include optional top-level `msg`.
- Read `msg` from the outer envelope before considering nested data fields.
- Retain nested `data.msg`/`data.message` only as a compatibility fallback.
- Update `RaydiumErrorClassifier` with a stable detail-code classifier for documented
  `REQ_*_ERROR` strings and known no-route/token-program wording.
- Include broad category, detail, sanitized message, HTTP status, and retryability in the adapter's
  provider-health context.
- Ensure an HTTP-success `success=false` response remains an adapter failure rather than a schema
  failure when the envelope is valid.

Acceptance:

```text
success=false + top-level REQ_AMOUNT_ERROR -> BAD_AMOUNT + REQ_AMOUNT_ERROR.
success=false + top-level REQ_SLIPPAGE_BPS_ERROR -> BAD_AMOUNT + REQ_SLIPPAGE_BPS_ERROR.
success=false + top-level REQ_INPUT_MINT_ERROR -> UNSUPPORTED_MINT + REQ_INPUT_MINT_ERROR.
success=false + top-level REQ_OUTPUT_MINT_ERROR -> UNSUPPORTED_MINT + REQ_OUTPUT_MINT_ERROR.
success=false + top-level REQ_TX_VERSION_ERROR -> BAD_REQUEST + REQ_TX_VERSION_ERROR.
known no-route message -> NO_ROUTE with an explainable detail.
unknown but valid failure envelope -> existing broad category plus UNKNOWN detail, never false success.
```

### Chunk 4 - Capture Sanitized HTTP Attempt Telemetry

Tasks:

- Add an additive optional `httpAttempts` field to provider results.
- Have `ProviderHttpClient` produce one sanitized attempt record for every HTTP call.
- Have `withProviderRetries` preserve ordered attempt records across retries without mutating the
  original result.
- Assign stable endpoint identifiers rather than recording full URLs.
- Include rate-limiter waiting time when available, HTTP status, latency, normalized outcome,
  retryability, and normalized provider error code.
- Add the final summarized attempt evidence to `ProviderHealth.contextJson`:

```text
httpAttemptCount
httpAttemptOutcomes
httpEndpointIds
httpStatusCodes
httpFinalOutcome
httpFinalStatusCode
```

- Do not write the full timeline to every terminal log; retain detailed attempts only in bounded
  diagnostic output and the individual ProviderHealth context needed for analysis.

Acceptance:

```text
One successful HTTP request has one attempt record.
Retryable failure followed by success preserves both records in order.
Final failure after retry exhaustion reports the full attempt count and final outcome.
Telemetry has no header, API-key, raw-payload, wallet, or full-URL field.
Existing adapters without telemetry remain type-safe and unchanged.
```

### Chunk 5 - Latest Attempt And Last Successful Quote Evidence

Tasks:

- Add `QuoteAttemptJournal` and expose a narrow read-only diagnostics interface from
  `QuoteProviderRouter`.
- Update the journal before every router return path: cache hit, cooldown skip, provider failure,
  direct-provider success, fallback success, and final all-provider failure.
- Record the last successful quote only on success.
- Add sanitized latest/last-success snapshots to router ProviderHealth context where a router row
  is written.
- Do not alter `QuoteCache` semantics, quote price selection, or strategy evidence consumption.

Acceptance:

```text
A live success followed by cooldown skip retains both distinct snapshots.
A cache hit is visible as latestAttempt=CACHE and does not overwrite the prior live success price.
A failed fallback attempt does not delete the last successful quote.
Expired journal entries are not returned.
Journal size stays within the configured bound.
```

### Chunk 6 - Build The Read-Only Quote Diagnostic Command

Tasks:

- Implement `quote:diagnose` with the command contract above.
- Use the normal provider registry and normal config to make its output representative of runtime
  behavior.
- Include direct Raydium preflight and direct Raydium compute probes without calling any transaction
  endpoint.
- Return nonzero only when a requested probe fails unexpectedly; a legitimate no-route should be
  a successful diagnostic execution with an explicit classified outcome, not a CLI crash.
- Add optional text and JSON artifact output with stable ordering and bounded examples.
- Add a short `providers:smoke` diagnostic summary for preflight parameters, failure detail, and
  HTTP attempt totals, but keep the existing smoke output compact.

Acceptance:

```text
quote:diagnose --once --mode=all runs without a Session row.
The command cannot reach paper execution, sell, wallet, signing, or submission code paths.
The JSON output is machine-readable and contains no secrets.
SOL -> USDC can prove the full known-good request contract.
A supplied archive/discovered mint can produce a classified unsupported/no-route/API failure report.
```

### Chunk 7 - Surface Aggregated Diagnostics In Existing Reports

Tasks:

- Extend `ProviderPressureClassifier` with compact counts for:

```text
raydiumFailureDetail
raydiumPreflightFailureDetail
httpEndpointIds
httpAttemptOutcomes
httpStatusCodes
httpAttemptCount
quoteLatestAttemptOutcome
quoteLastSuccessfulProvider
quoteLatestVsLastSuccessDivergence
```

- Add small sections or compact lines to TerminalRunner, analytics, calibration, research
  aggregate, research interpretation, and research truthing reports where provider diagnostics are
  already summarized.
- Keep all historical report fields stable. New fields must be additive.
- Include explicit labels separating:

```text
live provider failure
router cache hit
router cooldown skip
known no-route/unsupported route
preflight diagnostic result
last successful quote retained only as diagnostic state
```

Acceptance:

```text
Reports can distinguish a Raydium API parameter error from no route and provider outage.
Reports can identify when the latest quote failed but a prior success remains only as stale
diagnostic evidence.
No report calls a Birdeye market-data row executable quote evidence.
```

### Chunk 8 - Tests And Documentation

Add focused tests for:

```text
Raydium preflight full parameter URL and config validation
API v3 success=false top-level msg parsing
Raydium compute top-level msg parsing
documented REQ_* failure detail classification
existing broad failure-category compatibility
HTTP telemetry for success, HTTP failure, timeout, and retry sequence
no raw URL/header/API key in telemetry
QuoteAttemptJournal latest attempt versus last successful quote behavior and eviction
QuoteProviderRouter final failure/cooldown/cache paths
quote:diagnose argument parsing and PAPER/no-session boundary
ProviderPressureClassifier aggregation of additive diagnostic fields
provider smoke output remains successful for a known supported mint pair
```

Documentation tasks:

- Update the Phase 9+ roadmap, structure, decisions, planning inputs, and provider strategy.
- Record the Raydium documentation URLs and validated request contract.
- Record that Phase 9.4A.2 may make bounded quote calls but changes no trade state.
- Add a concise post-implementation validation runbook and a Phase 9.4B handoff section.

## Validation Plan

### Automated Verification

```powershell
cd U:\Projects\NeXusTrade-Otis

corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm check:secrets
```

### Provider Smoke

Use the existing local provider configuration. No new key is required.

```powershell
corepack pnpm providers:smoke
```

Expected:

```text
PAPER mode
wallet loaded = no
transaction signing = disabled
transaction submission = disabled
Raydium quote and preflight diagnostics show classified, sanitized evidence
no Order, Fill, or Position is created
```

### Quote Diagnostic Smoke

Known route:

```powershell
corepack pnpm quote:diagnose --once `
  --input-mint=So11111111111111111111111111111111111111112 `
  --output-mint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v `
  --amount-raw=100000000 `
  --slippage-bps=100 `
  --mode=all
```

Expected:

```text
preflight request contains all required documented parameters
router/direct/preflight output is separately labeled
attempt telemetry is present and sanitized
latest attempt and last successful quote are separately visible
no Session, Order, Fill, or Position is created
```

### Short Runtime Validation

After unit coverage and smoke pass, run one fresh 30-minute TerminalRunner validation with the
normal shadow-only profile. Do not run a multi-hour batch until the short run demonstrates that
new telemetry is readable and non-noisy.

Record:

```text
Raydium preflight status and failure detail distribution
Raydium compute failure detail distribution
HTTP endpoint/outcome/status distribution
latest-versus-last-success divergence count
Jupiter live/combined rate limiting
missingQuote and unclassifiedMissingQuote classification
orders/fills/positions = 0
```

The Phase 9.4A.2 conclusion selected Phase 9.4B as the next phase. It does not authorize paper BUY.

Phase 9.4A.3 is not a scheduled next step. Create that narrow persistence-hardening phase only if
this validation proves that `ProviderHealth.contextJson` and the bounded in-memory journal cannot
retain the required latest-attempt, last-success, or optional round-trip evidence safely. Otherwise
proceed directly to the Phase 9.4B decision gate.

The short validation did not prove that additional persistence is required, so Phase 9.4A.3 remains
deferred.

## Success Criteria

Phase 9.4A.2 succeeds when:

```text
The full repository verification suite passes.
Raydium preflight matches the current API v3 contract and no longer omits required parameters.
Raydium top-level msg is parsed and sanitized.
Known Raydium REQ_* messages receive stable broad category and precise detail classification.
Every retries-enabled HTTP result can report a bounded ordered attempt sequence.
Router diagnostics keep latest quote attempt and last successful quote separate.
quote:diagnose gives a complete one-shot diagnostic output in PAPER mode.
The diagnostic command creates no Session, Order, Fill, Position, wallet, signature, or transaction.
ProviderHealth/report output distinguishes parameter errors, no-route, router cooldown, cache,
and provider failure.
Existing research fields remain backward compatible.
The short validation keeps orders/fills/positions at zero.
```

## Non-Goals

```text
No strategy tuning.
No profile promotion.
No new provider integration.
No Jupiter scheduling or retry-policy changes.
No duplicate-demand removal, cache redesign, single-flight joining, circuit breaker, or negative
caching. Those are Phase 9.4B work.
No executable quote guarantee.
No paper BUY, paper SELL, live trade, wallet, signing, or submission.
```

## Handoff To Phase 9.4B

Phase 9.4B may start only when Phase 9.4A.2 can supply:

```text
validated Raydium preflight request shape
reliable deterministic Raydium failure distribution
HTTP attempt/retry evidence by endpoint
latest-attempt versus last-success evidence
one short runtime validation with clean safety counts
a clear explanation of whether quote pressure is internal demand, provider limits, legitimate
unsupported routes, or a remaining adapter defect
```

Phase 9.4B should then address quote demand and reliability in its documented order:

```text
Jupiter scheduler and provider-aware retries
duplicate quote-demand reduction
single-flight joins and cache separation
durable latest attempt versus last success evidence
Raydium negative caching/circuit breaker/venue-aware routing
```

If no-route outcomes dominate after A.2, Phase 9.4B should first use existing DexScreener pair and
venue evidence to avoid implausible Raydium probes before considering any new quote provider.

## Final Safety Reminder

Phase 9.4A.2 is adapter repair and measurement, not a trading phase.

```text
No paper BUY.
No paper SELL.
No live trading.
No wallet.
No signing.
No transaction submission.
No database migration.
```
