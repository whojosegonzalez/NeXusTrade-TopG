# H3 Provider Time And Budget Contract

Status: implementation contract for the approved isolated H3 change, 2026-09-17. This documents
existing budget/evidence meanings and the new admission controls. It grants no operational,
research, PAPER or live authority. See the [checklist](./NeXusTrade-Phase-10.6H-H3-Detailed-Checklist.md)
and [verification record](./Phase-10.6H-H3-Verification.md).

## Admission API And Ownership

`ProviderRateLimiter(clock?, sleep?, maxQueuedRequests = 1024)` retains the existing positional
clock/sleep injection. `waitForSlot(provider, cap, { signal?, maxQueueWaitMs? })` returns
`{ waitedMs, delayed }`. The optional HTTP request controls use the same names. Omitting controls
adds no queue deadline. A zero wait budget is already expired, even when capacity is free.

The default clock is `performance.now()`. Injected samples must be finite, nonnegative and
nondecreasing. Durations may be fractional milliseconds. A positive safe-integer cap bounds
reservations in `(t - 60000, t]`; exactly 60000 ms expires the oldest reservation. Zero preserves
explicit unlimited mode. First use binds the provider's cap, including zero; a later conflicting
cap fails without resetting history. No audited registry caller supplies conflicting caps.

Admission synchronously prunes, checks and reserves before resolving. Eligible queued callers
are FIFO. Each provider has its own wake; waiting entries share the instance-wide bound of 1024.
Immediate admissions do not count against that bound. An initial burst up to the cap is allowed;
this is neither pacing nor an in-flight concurrency limit. Idle queues release wakes/listeners
but retain unexpired reservations. Wait diagnostics measure actual monotonic time spent queued;
an immediately admitted call reports zero.

The sleep injection may accept a second `AbortSignal`; implementations should cancel their own
timer when it aborts. Legacy one-argument sleepers remain supported, but their underlying work
cannot be forcibly cancelled. Stale callbacks are ignored. Early wakes recheck capacity; repeated
early resolution at the same monotonic sample fails with `ADMISSION_SCHEDULER_FAILED` after the
second wake, preventing an injected immediately resolving sleeper from spinning indefinitely.

| Owner / constructors                                                                                | Budget and reset scope                                                                                                                                                                                                                                                   | Cache / retry behavior                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProviderRegistry.createProviderRegistry`                                                           | Creates one limiter unless injected. All 10 HTTP clients in enabled branches receive it. Jupiter price/swap share JUPITER; Raydium trade/API-v3 share RAYDIUM. Separate provider keys remain independent. Separate registries share only an explicitly injected limiter. | Every dispatched HTTP retry reacquires a reservation. No automatic refund after admission.                                                                                                        |
| Direct HTTP construction                                                                            | `rateLimiter` remains optional; omission explicitly bypasses general admission. `rateLimitPerMinute` alone does not enforce capacity.                                                                                                                                    | Caller abort still works without a limiter. No new per-request limiter is silently created.                                                                                                       |
| `DirectMeasurementCohortGateway`                                                                    | Frozen V3 direct DexScreener client omits the general limiter and disables retries. Its runner/protocol owns scheduling.                                                                                                                                                 | Source inspected only in isolation; factory/collector not executed or changed.                                                                                                                    |
| `DirectExploratoryCohortGateway`                                                                    | Frozen V2 direct DexScreener/Jupiter clients omit the general limiter and disable retries; factory loads environment and is excluded from H3 execution.                                                                                                                  | Historical protocol/evidence remains unchanged.                                                                                                                                                   |
| `BirdeyeBudgetTracker` / registry / adapter                                                         | New tracker per Birdeye adapter constructed by registry; no reset method. “Per run” therefore means this object's lifetime. Counts one accepted logical cache-miss reservation and its configured cost, before the retry wrapper. Price costs 3 nominal CU, overview 20. | Hit: no reservation or HTTP request. Refused reservation: no HTTP request. Retry: another wire request but no additional logical reservation. No billing, per-account or cross-process guarantee. |
| `QuoteBudgetPlanner.plan`                                                                           | Stateless selection per supplied candidate batch/cycle, using configured maximum and scores.                                                                                                                                                                             | Selection count is not wire count; router/cache/fallback can change work after selection.                                                                                                         |
| `JupiterDemandController`                                                                           | Instance-owned wall-clock window, operation/priority admission, minimum interval and adaptive backoff; created once per registry.                                                                                                                                        | Separate policy from the general limiter, preserved unchanged. Category/low-priority windows are not global entitlements.                                                                         |
| Quote scheduler, caches, single-flight, router/backoff; Helius and Raydium caches/backoff/preflight | Objects assembled by registry; their local TTLs, keys and lifetime control their own policy.                                                                                                                                                                             | Existing deduplication, fallback order and negative-cache behavior remain unchanged. No consolidated budget or cost model introduced.                                                             |

All production `new ProviderHttpClient` calls occur in the registry or the two direct cohort
gateways above. All production `new ProviderRateLimiter` calls occur in the registry. Test-only
constructors supply synthetic transports or stub methods. The seven retry-wrapper consumers are
DexScreener, Jupiter, Solana RPC, DAS metadata, Helius, Raydium and Birdeye adapters. They retain
their existing call signatures and retry defaults; none supplies new cancellation implicitly.
New callers using the retry helper must pass the same signal to the HTTP operation and supply
`provider` with the retry signal, so cancellation before the first attempt has an explicit owner.
Cancelling a generic operation that does not itself observe the signal cannot interrupt that
operation; the helper observes cancellation before attempts, after results, and during backoff.
This is not end-to-end cancellation for every adapter, router or research runner.

Repository default RPM values are ALCHEMY_DAS 60, BIRDEYE 60, DEXSCREENER 300, HELIUS 60,
JUPITER 60, MOCK 60000, QUICKNODE_DAS 60, RAYDIUM 60, RUGCHECK 60 and SOLANA_RPC 120.
These are configuration defaults, not verified account entitlements. Environment overrides,
retry/backoff defaults, quote/category limits and Birdeye limits are unchanged.

## Controls, Dispatch And Attempts

| Bounded control              | Meaning                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `ADMISSION_CANCELLED`        | Caller signal aborted. Caller-supplied reasons are not copied into diagnostics.              |
| `ADMISSION_DEADLINE`         | Monotonic queue deadline reached; cancellation/deadline is checked before granting capacity. |
| `ADMISSION_QUEUE_FULL`       | Instance-wide waiting-entry bound reached.                                                   |
| `ADMISSION_INVALID_CONFIG`   | Invalid cap/wait/bound, conflicting bound cap, or retry signal without an explicit provider. |
| `ADMISSION_INVALID_CLOCK`    | Invalid, backwards or throwing injected clock.                                               |
| `ADMISSION_SCHEDULER_FAILED` | Wake scheduling failed or repeatedly woke without clock progress.                            |

The limiter rejects with `ProviderAdmissionError`. HTTP converts these to the existing
`PROVIDER_UNAVAILABLE` error, `retryable: false`, bounded `error.message`, and
`diagnostics.admissionControl`; it adds no shared error enum or schema migration. Retry signal
without an owner is rejected before operation invocation. Queue cancellation consumes no slot;
abort after admission prevents fetch when observable but does not refund the reservation.

If fetch was never invoked, `httpAttempts` is empty. Once invoked, the existing attempt envelope
records one attempt even on abort/timeout/failure. An in-flight local cancellation uses the
legacy NETWORK_ERROR attempt outcome with a nonretryable PROVIDER_UNAVAILABLE failure code;
the result's admission diagnostic distinguishes the control. Actual HTTP 429 remains RATE_LIMITED.
Retry numbering is consecutive across actual returned attempts. Local controls do not retry.
Ordinary retries retain linear `retryBackoffMs * retryNumber` and the configured maximum.

Transport timeout starts after admission and covers headers/body reading. The caller signal
and timeout share an internal controller: the first observed abort reason wins. Success,
HTTP error, body failure, abort and timeout clear the transport timer and caller listener.
Injected noncooperative fetch/body promises are observed to avoid later unhandled rejections;
the caller can settle promptly, but the helper cannot stop arbitrary injected work internally.

## Legacy Time And Consumer Inventory

| Boundary / source                                    | Actual current meaning                                                                                                                                                                                                 | Limit / consumer implication                                                                                                                                                                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared `provider-results.ts`                         | `fetchedAt` defaults to a local Date when omitted; latency defaults to zero.                                                                                                                                           | These defaults do not establish source-event time or complete request duration.                                                                                                                                                                                                |
| HTTP invocation                                      | `fetchedAt` and elapsed wall-clock start are captured before queue admission.                                                                                                                                          | Local observation-start proxy, not exchange/provider publication time.                                                                                                                                                                                                         |
| Limiter admission                                    | `waitedMs` is monotonic queued duration, also surfaced as the existing positive `rateLimiterWaitMs` on ordinary HTTP responses.                                                                                        | Admission and fetch dispatch are different instants; no new persisted timestamps are added. Caught failures preserve legacy omission of this attempt field.                                                                                                                    |
| Response headers/body                                | Success and non-2xx response latency stop at headers, before reading the body. Caught errors calculate elapsed time at catch. Malformed JSON remains successful text at HTTP level; adapters validate their envelopes. | Success excludes body duration; a body failure includes it. Wall-clock jumps can distort or make legacy latency negative. H3 does not silently correct those fields.                                                                                                           |
| Adapter mappers                                      | HTTP fetchedAt is passed into provider snapshots; some response payloads may contain separate event/slot information.                                                                                                  | Missing provider event time remains unknown. A blockchain slot is not automatically a wall-clock timestamp.                                                                                                                                                                    |
| Retry wrapper                                        | Returns the terminal operation result with accumulated, renumbered returned HTTP attempts.                                                                                                                             | Terminal fetchedAt/latency is not aggregate operation duration. Adapter mappings can drop successful attempt details: the Birdeye fixture makes two wire requests but retains only the first failed HTTP attempt. H3 characterizes and defers this existing observability gap. |
| Birdeye cache                                        | Cached original fetchedAt is retained; hit latency is zero.                                                                                                                                                            | Cache retrieval does not refresh evidence age. No source publication time is invented.                                                                                                                                                                                         |
| `MarketDataService` → `CandidateEnrichmentService`   | Enrichment captures its own start Date; composed snapshots preserve their individual adapter data. Candidate enrichment uses concurrent workers and forwards results.                                                  | The outer fetchedAt is not a common source-event time for all constituent evidence. Fallback ordering is unchanged.                                                                                                                                                            |
| `ProviderHealthService` → `ProviderHealthRepository` | Health consumes latency, status and attempt summaries. Repository assigns local `timestampMs` at insertion when omitted.                                                                                               | Persistence time is distinct from observation or durable disk completion. Health context does not automatically copy all result diagnostics; bounded error message remains available.                                                                                          |
| Frozen V3 gateway → runner → archive/analyzer        | Gateway maps result fetchedAt to observedAt; runner serializes that observation proxy into legacy `sourceTimestamp` fields and tests anchor timing using observedAt.                                                   | Field name does not prove provider-origin event time. Preserve frozen interpretation/bytes and archive identity; do not backfill or reinterpret as genuine source time.                                                                                                        |

The four timing fixtures cover queued/headers/body timing, caught body failure with wall-clock
jumps, malformed JSON fallback, and cache/retry timing. Existing adapter/config/health fixtures
and unchanged H1/H2 suites provide compatibility evidence, not permission to recollect data.

## Future Versioned Timing Model (Documentation Only)

A separately designed envelope should distinguish provider event time (nullable with source and
precision), local invocation/observation, admission, dispatch, headers, body completion and writer
persistence. Capture monotonic durations within one process clock domain and explicit wall-clock
instants with provenance. Represent each retry attempt separately and keep operation duration,
cached-evidence age and retrieval duration distinct. Clock skew and missing source timestamps
must remain explicit unknowns; do not subtract unrelated clocks.

Changing these meanings needs a new envelope/schema version, producer and reader compatibility
tests, a defined transition policy and downstream evidence review. Existing records cannot be
backfilled with events never captured. Do not rewrite V2/V3 JSON or infer source timestamps from
ingestion/persistence times. Research-sampling/provider/evidence changes require a separately
approved outcome-aware research protocol; future pilot semantics belong in 10.7A/10.8B.

Deferred work includes distributed/account quotas, wire/CU accounting policy, complete adapter
attempt propagation, end-to-end cancellation through routers, and the versioned timing envelope.
H3 fixes local concurrent admission; it does not prove measurement capability or profitability.
