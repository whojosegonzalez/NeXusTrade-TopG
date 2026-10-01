# NeXusTrade Phase 9.4C Detailed Checklist

Adaptive Jupiter demand control and free-tier evidence

Last updated: August 2026

## Status

Implementation complete. Runtime validation is pending.

```text
9.4A.1 archive and reporting truthing       -> complete
9.4A.2 adapter correctness and diagnostics  -> complete
9.4B   quote-pressure reduction             -> implemented; runtime validation complete
9.4C   adaptive Jupiter demand control      -> implemented; runtime validation pending
9.5    additional quote-provider evaluation -> deferred until 9.4C decision
```

## Objective

Reduce upstream Jupiter `429` responses through one application-wide, adaptive request budget. Keep
the successful Phase 9.4B Raydium venue guard, success cache, negative cache, and quote provenance
unchanged.

```text
Current: local per-provider/per-operation pacing + cooldown + Raydium demand controls.
Observed: Jupiter still returned about 23% live 429s in both full Phase 9.4B validations.
9.4C: one shared Jupiter price/quote budget + adaptive slowdown + explicit priority-aware deferral.
```

This is a provider-pressure phase. It does not change strategy scoring or authorize paper BUY.

## Evidence From Phase 9.4B

All runs were PAPER/shadow-only with `orders=0`, `fills=0`, `positions=0`, and no wallet,
signing, or submission.

```text
Full validation 1: 110 cycles
  Jupiter liveRateLimited=23.00%, combinedRateLimited=72.08%
  Jupiter schedulerWait=560613ms, avoidedLiveCalls=3516
  Raydium avoidedLiveCalls=2986, venueGuardSkips=2792

Full validation 2: 111 cycles
  Jupiter liveRateLimited=23.08%, combinedRateLimited=76.73%
  Jupiter schedulerWait=597369ms, avoidedLiveCalls=4385
  Raydium avoidedLiveCalls=3962, venueGuardSkips=3675
```

Conclusion:

```text
Raydium demand control passed: repeated no-route/no-pool probes are mostly avoided.
Jupiter controls are observable and avoid demand, but a fixed 1100ms per-operation interval
did not lower actual live 429 frequency enough.
```

The likely gap is application-side demand shaping: Jupiter price and quote calls can still compete
for one account-level allowance. This is an inference to test, not a claim about Jupiter internals.

## Safety Boundary

Phase 9.4C may:

- Add a process-local Jupiter controller shared by price and quote calls.
- Add adaptive interval/cooldown behavior after actual Jupiter rate-limit evidence.
- Add bounded, priority-aware local deferral before a live Jupiter request.
- Preserve router fallback to Raydium only under the existing policy.
- Add sanitized controller telemetry to ProviderHealth, runner, analytics, calibration, aggregate,
  and interpretation reports.
- Add configuration parsing, tests, provider smoke coverage, and documentation.

Phase 9.4C must not:

- Add a provider or change quote order. Keep `JUPITER -> RAYDIUM`.
- Enable Helius in Phase 9.4C validation runs.
- Change scanner, risk, strategy, shadow, exit, or promotion thresholds.
- Treat Birdeye price as executable quote evidence.
- Add a migration or persist a budget across processes.
- Enable paper BUY/SELL, wallet loading, transaction building, signing, or submission.
- Log API keys, raw URLs, raw headers, raw bodies, or raw payloads.

## Locked Decisions

```text
Jupiter access:                  existing free/keyed configuration only
Paid Jupiter comparison:         outside implementation and validation
Controller scope:                one instance per ProviderRegistry/process
Shared operations:               Jupiter quote and price consume one budget
Scheduling:                      no background queue across runner cycles
Budget exhaustion:               return classified local deferral immediately
429 behavior:                    use sanitized Retry-After when available; otherwise adapt locally
Recovery:                        decay adaptive level only after consecutive live successes
Priority:                        preserve high-priority work before low-priority research work
Helius:                          disabled; Solana RPC + QuickNode DAS keep authority/metadata evidence
Persistence:                     ProviderHealth context and run artifacts only
```

`combinedRateLimited` is historical context, not a primary Phase 9.4C success metric. It includes
intentional cooldown and local budget deferrals, which are not upstream rate limits.

## Proposed Defaults

```text
JUPITER_DEMAND_CONTROLLER_ENABLED=true
JUPITER_DEMAND_WINDOW_MS=60000
JUPITER_DEMAND_MAX_LIVE_REQUESTS_PER_WINDOW=48
JUPITER_DEMAND_BASE_MIN_INTERVAL_MS=1250
JUPITER_DEMAND_MAX_INTERVAL_MS=15000
JUPITER_DEMAND_ADAPTIVE_ENABLED=true
JUPITER_DEMAND_RATE_LIMIT_MULTIPLIER=2
JUPITER_DEMAND_SUCCESS_DECAY_COUNT=4
JUPITER_DEMAND_MAX_LOW_PRIORITY_REQUESTS_PER_WINDOW=12
JUPITER_DEMAND_DEFER_LOW_PRIORITY_FIRST=true
JUPITER_DEMAND_RESPECT_RETRY_AFTER=true
```

Rationale:

- `48` requests per rolling minute reserves headroom below the documented 60 RPM free keyed limit.
- `1250ms` is below one request per second and applies across both price and quote work.
- Low-priority work defers first; deferral is never reported as a successful quote.
- The controller resets when the process exits, preserving the current research-safe model.

Reject invalid negative values, zero-length windows, invalid multipliers, and a base interval above
the configured maximum. Preserve current behavior when the controller is disabled.

## Required Telemetry

Every outcome must store sanitized structured context equivalent to:

```text
jupiterDemandAction =
  LIVE_ALLOWED
  DEFERRED_WINDOW_BUDGET
  DEFERRED_LOW_PRIORITY_BUDGET
  DEFERRED_ADAPTIVE_BACKOFF
  COOLDOWN_SKIP
  DEFERRED_MIN_INTERVAL

jupiterDemandOperation = QUOTE | PRICE
jupiterDemandPriority = HIGH | NORMAL | LOW
jupiterDemandWindowLimit
jupiterDemandWindowUsed
jupiterDemandEffectiveIntervalMs
jupiterDemandAdaptiveLevel
jupiterDemandRetryAfterMs
jupiterDemandDeferredReason
jupiterDemandSavedLiveCall = true|false
```

Rules:

- `RATE_LIMITED` means an upstream Jupiter response, never a local controller decision.
- Count local deferrals separately from success cache, negative cache, existing cooldown, Raydium
  venue guard, and Raydium negative cache.
- Retain current `LIVE`, `CACHE`, and `NONE` quote provenance.
- Never record secrets or raw network values.

## Implementation Completion Notes

Completed in August 2026:

- One `JupiterDemandController` is created per `ProviderRegistry` and injected into both the
  Jupiter price adapter and the Jupiter quote path.
- A first 30-minute smoke found that immediate min-interval rejection starved same-cycle normal
  quote batches. The controller now serializes normal/high-priority calls inside the active process
  at its bounded effective interval; low-priority work and rolling-window exhaustion still defer
  immediately. The smoke must be rerun before full validations.
- Price/diagnostic work is `LOW` priority; quote-router calls retain their existing contextual
  priority. Both consume the same rolling window and effective interval.
- Controller-enabled Jupiter requests do not use immediate provider retries after a live `429`.
  The next eligible request is governed by the controller's adaptive interval and sanitized
  Retry-After duration instead.
- A controller-local quote deferral is a classified `PROVIDER_UNAVAILABLE` result, never an
  upstream `RATE_LIMITED` result. The router may continue to its existing Raydium fallback.
- The existing Raydium scheduler remains active; Jupiter's old quote-scheduler lane is disabled
  only while the shared controller is enabled.
- Provider Health and analytics expose local deferrals separately from upstream rate limits.
- Focused deterministic controller, configuration, router-pressure, and full-workspace tests pass.

Runtime validation remains deliberately PAPER/shadow-only with Helius disabled. It must establish
whether the controller lowers Jupiter live `429`s without materially reducing useful quote coverage.

## Planned Files

### Add

```text
backend/src/providers/jupiter/JupiterDemandController.ts
backend/src/providers/jupiter/JupiterDemandController.test.ts
```

A small `JupiterDemandTypes.ts` is allowed only if it clarifies controller/report contracts.

### Modify

```text
backend/src/providers/config/providerConfig.ts
backend/src/providers/config/providerConfig.test.ts
backend/src/providers/ProviderRegistry.ts
backend/src/providers/jupiter/JupiterAdapter.ts
backend/src/providers/quotes/QuoteProviderRouter.ts
backend/src/providers/quotes/QuotePriority.ts
backend/src/providers/quotes/QuoteScheduler.ts
backend/src/providers/ProviderPressureClassifier.ts
backend/src/providers/ProviderPressureClassifier.test.ts
backend/src/terminal-runner/TerminalRunSummary.ts
backend/src/terminal-runner/TerminalRunSummary.test.ts
backend/src/analytics/AnalyticsReportService.ts
backend/src/analytics/AnalyticsReportFormatter.ts
backend/src/research/CrossRunResearchService.ts
backend/src/research/ResearchAggregateTypes.ts
backend/src/research/ResearchAggregateReportFormatter.ts
backend/src/research-interpretation/ProviderInterpretationService.ts
backend/src/scripts/providers-smoke.ts
backend/src/scripts/quote-diagnose.ts
docs/Provider-Strategy-Phase9Plus.md
docs/ROADMAP_Phase9Plus.md
docs/DECISIONS_Phase9Plus.md
docs/Structure_Phase9Plus.md
docs/Phase-9-Planning-Inputs.md
```

The implementation may compose the existing `QuoteScheduler` into the controller or simplify it,
but it must not leave two independent Jupiter throttles.

## Implementation Chunks

### Chunk 1 - Config And Access Classification

Add `JupiterDemandControllerConfig` under existing quote/provider resilience configuration.

Requirements:

```text
parse all defaults
validate budget, window, interval, multiplier, and success-decay values
validate baseMinIntervalMs <= maxIntervalMs
derive accessMode=KEYED|KEYLESS only from key presence
never print or inspect the key value
```

Tests:

```text
defaults and disabled mode parse
invalid values reject
base interval above max rejects
access mode contains no key material
```

### Chunk 2 - Shared Controller

Create one `JupiterDemandController` in `ProviderRegistry`. Inject it into all Jupiter price and
quote paths.

Responsibilities:

```text
one rolling request window across Jupiter PRICE and QUOTE
one effective interval across both operations
per-window low-priority accounting
tryAcquire(operation, priority) -> ALLOWED or DEFERRED with immutable diagnostics
recordLiveOutcome(status, retryAfterMs?)
increase adaptive level after real 429
use Retry-After only as sanitized duration
decay only after configured consecutive successful live calls
```

The controller must not sleep indefinitely, queue background work, retry a 429 itself, share state
between processes, or convert local deferral into cache evidence.

Deterministic-clock tests:

```text
price and quote consume one shared budget
window expiry restores capacity
low-priority work defers before retained high-priority capacity
429 raises effective interval and adaptive level
Retry-After never lowers wait
successes decay gradually
disabled controller always allows
no secret/header value is retained
```

### Chunk 3 - Router And Adapter Integration

For Jupiter quote requests, preserve this order:

```text
success cache
-> deterministic negative cache
-> existing cooldown/backoff
-> Jupiter demand-controller decision
-> live Jupiter request if allowed
-> record live outcome
-> existing Raydium fallback when appropriate
```

For direct Jupiter price requests:

```text
price cache if available
-> shared controller decision
-> live price request if allowed
-> record live outcome
```

Local deferral behavior:

```text
quote: classified local provider-unavailable result with jupiterDemandAction
price: classified local provider-unavailable result with jupiterDemandAction
router: may continue to existing Raydium fallback
reports: local deferral, never upstream RATE_LIMITED
```

Reuse the existing priority model. Document every call site selection; price-only/diagnostic
enrichment must be lower priority than risk/strategy quote evidence.

Tests:

```text
cache bypasses controller
window defer prevents live Jupiter HTTP
deferred quote preserves fallback provenance
deferred price prevents live Jupiter HTTP
real 429 updates controller
live success updates recovery
Phase 9.4B Raydium behavior is unchanged
```

### Chunk 4 - Scheduler Consolidation

Make the controller the sole authority for Jupiter's effective interval.

```text
Jupiter price and quote do not get separate 1100ms lanes
Raydium retains Phase 9.4B scheduler behavior
cache/negative-cache/venue-guard/cooldown skips do not consume a Jupiter budget token
local deferral finishes the current cycle; it does not wait or carry background work forward
```

### Chunk 5 - Reporting And Interpretation

Add at least:

```text
jupiterLiveAllowedCount
jupiterWindowBudgetDeferredCount
jupiterLowPriorityDeferredCount
jupiterAdaptiveBackoffDeferredCount
jupiterControllerRateLimitObservedCount
jupiterEffectiveIntervalMsMin/Max/Average
jupiterAdaptiveLevelMax
jupiterSharedWindowUsage
```

TerminalRunner, analytics, calibration, cross-run aggregation, and interpretation must distinguish:

```text
upstream Jupiter 429
existing quote-router cooldown
window-budget deferral
low-priority deferral
adaptive-backoff deferral
success cache
negative cache
Raydium venue guard
Raydium negative cache
```

A local low-priority deferral is not proof Jupiter could not quote a mint. A high-priority deferral
must remain visible in blocker reporting.

Tests:

```text
classifier separates new actions
summary merge handles them
older archived summaries load without fields
formatters remain compact and sanitized
```

### Chunk 6 - Diagnostics And Safety

Extend `providers:smoke` and `quote:diagnose` with compact state:

```text
controller enabled/disabled
access mode KEYED|KEYLESS
effective interval
window usage
adaptive level
local deferral count
upstream 429 count
```

Both commands remain PAPER-only, wallet-free, signing-free, submission-free, and bounded to known
routes. A local deferral must be reported clearly; only genuine required-provider failure keeps a
nonzero smoke exit.

### Chunk 7 - Documentation And Validation

Update the Phase 9+ docs to record:

```text
9.4B conclusion: Raydium accepted; fixed Jupiter pacing insufficient
9.4C scope and no-paid-tier decision
Helius excluded from 9.4C quote-pressure validation
Phase 9.5 deferred until a 9.4C evidence decision
```

Validation order:

```text
1. corepack pnpm verify
2. providers:smoke with DEXSCREENER,JUPITER,RAYDIUM,SOLANA_RPC,QUICKNODE_DAS,BIRDEYE
3. quote:diagnose --once --mode=all
4. one 30-minute PAPER/shadow-only TerminalRunner smoke on a reset DB
5. two 2-hour PAPER/shadow-only TerminalRunner validations on reset DBs
6. 60-minute watchlist tail plus analytics/calibration/shadow-calibration reports per full run
7. compare against both Phase 9.4B full archives
```

## Acceptance Criteria

Implementation:

```text
full verify passes
provider smoke passes
known-route quote diagnose passes
all demand outcomes are observable and sanitized
orders/fills/positions remain zero
```

Runtime:

```text
safetyStatus=PASS for smoke and both full runs
Jupiter liveRateLimited materially below the Phase 9.4B ~23% baseline
target <=10% across both full runs
window/adaptive deferrals explicitly counted
high-priority quote evidence does not collapse from local control
Raydium venue-guard/negative-cache savings remain visible
no provider or strategy safety regression
```

The phase may still prove a genuine free-tier capacity ceiling. Its closeout must choose one:

```text
A. stay on free Jupiter with controller
B. tune controller and collect another controlled batch
C. authorize a separately documented $25/month Jupiter Developer-tier comparison
D. proceed to Phase 9.5 only because controlled Jupiter evidence remains insufficient
```

No result authorizes paper BUY.

## Known Limitations

- One process-local controller cannot coordinate separate Node processes.
- Local throttling cannot guarantee an upstream API never returns 429.
- A tighter budget trades lower-priority breadth for cleaner high-priority evidence.
- It cannot create a Jupiter or Raydium route where none exists.
- Helius is intentionally excluded; test its recovered quota only in a separate metadata experiment.
- A paid tier might increase capacity, but Phase 9.4C must first measure free-tier efficiency.

## Completion Gate

Phase 9.4C completes after implementation acceptance, one smoke, two full validations, and a
documented evidence decision. Phase 9.5 does not start automatically.
