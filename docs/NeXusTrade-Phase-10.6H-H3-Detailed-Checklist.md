# Phase 10.6H H3 Detailed Implementation Checklist

Current handoff update (2026-09-18): H3 was committed as `f8f8d4c`. The original closeout record below describes its pre-commit checkpoint. Main integration and V3/B.3 provenance are tracked separately in the [integration record](./Phase-10.6H-Main-Isolation-Integration.md).

## Provider Concurrency And Measurement Semantics

Status: **Isolated engineering acceptance complete, 2026-09-17. Patch uncommitted/unmerged.**
The user approved D1-D9 and H3-00 through H3-06 at committed checklist revision `f46eb26`.
Progress and resume instructions: [H3 verification record](./Phase-10.6H-H3-Verification.md).

Planning baseline: `ff6d586` (`Complete H2 accounting, schema, and reconciliation hardening`),
branch `isolation`, worktree `U:\Projects\H1s\isolation`. The working tree was clean before this
documentation task. The user reports H2 committed and pushed, without merging into main; local
HEAD confirms the H2 commit. No remote fetch or operational checkout inspection was needed.

Read with the [parent improvement checklist](./NeXusTrade-Phase-10.6H-Detailed-Checklist.md),
[H2 verification record](./Phase-10.6H-H2-Verification.md), and
[Post-V3 Development Plan](./Post-V3-Development-Plan.md).

## 1. Outcome And Authorization

H3 must prevent concurrent waiting callers from exceeding the general limiter's configured
rolling-minute capacity, make admission/cancellation/deadline behavior explicit, and document
budget ownership and timestamp meaning without silently redefining existing evidence.

- [x] Inspect existing source and prepare this detailed plan for review.
- [x] **H3-AUTH:** Record user approval of D1-D9 below, the exact reviewed revision, and bounded
      implementation scope. User implementation approval received on 2026-09-17; operational integration remains excluded.
- [x] Return material changes to rate policy, budget units, retry/fallback behavior, timestamp
      contracts or isolation scope for review. Routine implementation choices within approved
      decisions do not require approval for every checkbox.

H1 and H2 engineering acceptance are complete. Their recorded 245 and 194 passing tests are prior
evidence, not new test runs performed while drafting H3. H3 provides no research hypothesis,
measurement-capability conclusion, trading candidate or PAPER/live authority.

## 2. Source Findings To Preserve And Verify

| Surface                                                 | Finding at `ff6d586`                                                                                                                                                                    | H3 consequence                                                                                                                                                 |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/src/providers/http/providerRateLimiter.ts`     | After sleeping, `waitForSlot` refreshes timestamps and appends without rechecking capacity. Waiters can reserve the same newly available capacity.                                      | Reproduce H-03 using deferred fake sleepers, then retain a normal passing regression. This is source analysis; no reproduction was run for this planning task. |
| `providerRateLimiter.test.ts`                           | One sequential limit-one case uses a sleep function that immediately advances time.                                                                                                     | Preserve it, but add a scheduler that releases concurrent waiters together and can inspect unresolved promises.                                                |
| `ProviderRegistry.ts`                                   | One limiter is created per registry construction unless injected; HTTP clients within that registry share it. Jupiter price/swap and Raydium clients share provider keys.               | State the actual instance scope. Separate registries/processes do not automatically share capacity.                                                            |
| `ProviderHttpClient.ts`                                 | Admission precedes fetch; `AbortSignal.timeout(timeoutMs)` is created after waiting. Optional limiter omission bypasses admission.                                                      | Preserve existing transport-timeout semantics; queue deadlines must be separately named. Audit every constructor and optional bypass.                          |
| `providerRetry.ts`                                      | Retries call the operation again, accumulate/renumber attempts, and use linear backoff.                                                                                                 | Each actual HTTP retry must reacquire admission. Cancellation must not trigger a retry. Do not change retry counts/backoff/fallback defaults.                  |
| `birdeye/BirdeyeAdapter.ts` / `BirdeyeBudgetTracker.ts` | A cache miss reserves request/CU budget once before `withProviderRetries`; a cache hit skips reservation. Tracker counters are synchronous and instance-owned.                          | Characterize the existing reservation unit and lifetime. It is not proof of a hard cap on actual wire requests or billed CU across retries/processes.          |
| `quotes/QuoteBudgetPlanner.ts`                          | Separate quote-selection policy exists.                                                                                                                                                 | Inventory its relationship to HTTP admission; do not turn selection limits into a new global rate budget.                                                      |
| `ProviderHttpClient.ts` / shared result types           | `fetchedAt` is captured at invocation before queueing. Successful `latencyMs` includes queue time through headers and excludes body reading; caught failures measure through the catch. | Document these legacy meanings and differences. Do not rename them into source time or silently recalculate historical values.                                 |

Configured source defaults currently include DEXSCREENER 300 RPM, SOLANA_RPC 120, MOCK 60,000,
and 60 for ALCHEMY_DAS, BIRDEYE, HELIUS, JUPITER, QUICKNODE_DAS, RAYDIUM and RUGCHECK.
These are repository defaults, not verified provider/account entitlements. Preserve configuration
values, overrides, provider/category caps, endpoint selection and economic assumptions.

## 3. Proposed Decisions For Approval

Approving H3 should explicitly accept this table. Record deviations before implementation.

| ID                           | Proposed contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 — Ownership               | One rolling-minute budget per provider key per limiter instance. A registry shares its injected/default instance among its HTTP clients. Separate registries must deliberately receive the same instance to share; there is no host-wide, account-wide, cross-worker or cross-process guarantee. No distributed coordinator is added.                                                                                                                                                                                                                                                                                                                                                           |
| D2 — Admission               | FIFO among eligible queued callers for each provider; independent providers can progress independently. Prune expired reservations and reserve one slot synchronously before resolving admission. Recheck on every wake. At time `t`, reservations in `(t - 60,000 ms, t]` must not exceed the configured positive integer cap. Expiration exactly at 60,000 ms frees capacity. Preserve initial bursts up to the cap; do not add pacing or an in-flight concurrency limit.                                                                                                                                                                                                                     |
| D3 — Queue lifecycle         | Proposed local resource bound: at most 1,024 waiting entries per limiter instance, excluding already admitted entries. Queue-full rejects before reservation and transport. This is a new local resource safeguard for approval, not a provider RPM change. At most one scheduled capacity wake per provider; remove aborted/expired entries and clean timers/listeners. Preserve legacy callers with optional control arguments. No new environment knob is required.                                                                                                                                                                                                                          |
| D4 — Cancellation/deadline   | Add optional caller cancellation and a separately named queue-wait deadline/budget. Existing callers get no new queue timeout by default. Already-aborted/expired callers cannot reserve. Abort before admission removes the entry without consuming a slot; abort after admission prevents dispatch when observable but does not refund that reservation. Admission is the linearization point. If deadline and capacity become eligible together, check cancellation/deadline first; `now >= deadline` is expired. Transport timeout remains the existing post-admission timeout.                                                                                                             |
| D5 — Retry/control outcomes  | Local cancellation, queue deadline, queue-full and invalid limiter configuration are bounded, distinguishable, nonretryable control outcomes. Do not manufacture an HTTP attempt when fetch was never invoked. Preserve existing attempt schema and actual-attempt numbering; carry bounded local-control diagnostics through the existing result/diagnostics envelope. Audit normalization so abort cannot become a retryable network failure. Once dispatched, failures/429/timeouts consume admission; retries reacquire it. Backoff cancellation must stop promptly.                                                                                                                        |
| D6 — Time and configuration  | Use an injected monotonic elapsed-time clock for admission/deadlines; retain wall-clock dates for legacy result fields. Accumulate actual monotonic waiting time for `waitedMs`, not just the first planned sleep. Early/spurious wakeups recheck capacity. Define the injected clock as nondecreasing and reject invalid samples; avoid busy loops on backward time. Preserve zero as an explicit unlimited compatibility value; reject negative/nonfinite/fractional/unsafe caps. A provider key binds its cap on first use, including zero; conflicting later caps on the same instance fail explicitly instead of silently resetting history. Inventory callers before enabling this check. |
| D7 — Budget preservation     | Keep general RPM, quote-selection, endpoint/category and Birdeye per-run reservation units distinct. Document who creates/resets each counter and whether retries/cache hits consume it. Preserve existing Birdeye reservation-before-retry behavior in H3; correcting it into a hard wire-request/CU cap would need a separately approved policy change. No invented cost model, refund, automatic budget reset or claim of cross-process enforcement.                                                                                                                                                                                                                                         |
| D8 — Timestamp compatibility | Deliver a reviewed timestamp/measurement-semantics document. Preserve current `fetchedAt`, `latencyMs`, persisted JSON, schema and frozen archive meanings. A future additive, versioned timing envelope may be proposed, but its runtime/persistence rollout is not part of H3 approval. Unknown source timestamps remain unknown; receipt or persistence time cannot substitute for source observation.                                                                                                                                                                                                                                                                                       |
| D9 — Integration             | Implement only in the physically isolated checkout with independent dependencies and synthetic tests. No live provider probes, `.env` reads, operational DB/archive/scheduler access, default runtime bootstrap, migrations, collection, merge or deployment. Separate V3 closeout and integration gates remain in force.                                                                                                                                                                                                                                                                                                                                                                       |

Capacity is reserved at admission, immediately before the supported HTTP dispatch path. An admitted
caller that stalls or cancels can conservatively waste capacity. H3 must not claim that arbitrary
callers delaying dispatch still provide a hard cap on remote-server arrival times. Bound queue
resources and clean them up without weakening the reservation invariant.

## 4. Measurement Semantics Deliverable

Proposed document: `docs/Phase-10.6H-H3-Provider-Time-And-Budget-Contract.md` (not created yet).

| Concept                            | Required definition                                                                             | Compatibility rule                                                                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source observation                 | Provider-declared event/sample time, with provenance and known/unknown state.                   | Never infer it from a client clock. Identify adapters that omit or transform it.                                                                     |
| Invocation / queue entry           | Client begins an operation before admission.                                                    | Current HTTP `fetchedAt` corresponds to invocation, not necessarily fresh provider evidence. Cache/adapter result construction needs its own audit.  |
| Admission / request start          | Reservation granted / fetch invoked; record them as distinct events in the proposed model.      | Use monotonic durations for waiting; wall-clock instants for externally interpretable dates. Do not subtract unrelated clock domains.                |
| Response headers / body completion | Headers available versus body consumed/parsed.                                                  | Current successful latency stops before body reading. Do not present it as complete request duration.                                                |
| Persistence                        | A writer stores a record, with the writer's clock/provenance.                                   | A repository timestamp alone does not prove source freshness, response time or durable disk completion.                                              |
| Retry / cache                      | Separate attempt times, aggregate operation time, cached evidence age and cache retrieval time. | Cached source/fetch time must not become current simply because the cache was read. Preserve existing behavior until a versioned change is approved. |

- [x] Trace transport → adapter → enrichment/health diagnostics → downstream writer/readers using
      source and synthetic fixtures only. Record actual meanings and unknowns for each boundary.
- [x] Inventory specialized collector limits/timestamps as frozen compatibility dependencies;
      do not edit or run frozen collectors to establish H3.
- [x] Record known limitations, clock skew, wall-clock jumps, retries, missing source time and
      why the proposed future envelope cannot be backfilled from incomplete historical evidence.
- [x] Specify version/reader compatibility and required research approval for any future timestamp,
      sampling, evidence-format or provider-surface change. Route future protocol requirements to
      the applicable research design or 10.7A/10.8B; H3 does not create that protocol.

## 5. Invariants

| ID        | Required invariant                                                                                                        | Primary evidence          |
| --------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| H3-INV-01 | Positive-cap rolling-window reservations never oversubscribe under concurrent wakes.                                      | T01–T04                   |
| H3-INV-02 | Eligible same-provider waiters are FIFO; unrelated providers do not block each other.                                     | T03/T05                   |
| H3-INV-03 | Every queued request settles once; cancellation/deadline/full-queue outcomes have no unintended transport or reservation. | T06–T09                   |
| H3-INV-04 | Actual dispatches/retries acquire admission; local control outcomes are not counted as HTTP attempts or retried.          | T10/T11                   |
| H3-INV-05 | Budget units, ownership/reset scope and unsupported sharing are explicit.                                                 | T05/T12                   |
| H3-INV-06 | Durations are monotonic and legacy timestamps/results retain their documented meanings.                                   | T04/T13                   |
| H3-INV-07 | Defaults, fallback policy, frozen evidence and H1/H2 behavior are preserved.                                              | T12–T15                   |
| H3-INV-08 | Verification has no real provider, credential, operational data or scheduler dependency.                                  | T14/T15 and harness audit |

## 6. Ordered Implementation Batches

### H3-00 — Establish approved isolation and harness

- [x] Record H3-AUTH, branch, HEAD and working-tree changes; preserve user work.
- [x] Recheck real paths for checkout, dependencies, links/junctions and fixture/cache output.
      A different branch in the operational checkout is not sufficient isolation.
- [x] Add a dedicated `backend/vitest.h3.config.ts`: explicit audited allowlist, environment loading
      disabled, no watch, local cache, deterministic fake timers/clock and explicit fake transport.
- [x] Fail unexpected global network calls and environment-file access. Audit transitive imports
      before adding adapter/registry tests; pure config parsing uses a supplied synthetic object.
- [x] Keep initial limiter/HTTP tests database-free. If health persistence integration requires
      SQLite, use explicitly owned temporary fixtures with verified native dependencies and cleanup;
      never bootstrap the normal runtime, default database, seed/reset command or provider registry
      with real configuration.
- [x] Record baseline existing test names, signatures and constructor behavior before edits.

### H3-01 — Reproduce H-03 and freeze contracts

- [x] Reproduce limit-one contention: consume capacity, queue at least two calls without advancing
      time, release both at the first boundary, and show only one should be admitted. Keep original
      failure evidence; convert it to a normal regression when fixed.
- [x] Characterize burst capacity, provider independence, exact expiration, waitedMs and unlimited
      mode. Do not use a fake sleep that advances time separately for each concurrent caller.
- [x] Inventory every limiter/HTTP constructor and retry wrapper, including same-provider shared
      endpoints, optional limiter bypass, independently constructed registries, quote/category
      budgets and Birdeye cache/reservation/retry paths.
- [x] Confirm D1-D9 against that inventory. Record an API/error mapping and ownership/reset matrix;
      resolve any existing same-instance conflicting caps before changing production behavior.
- [x] Record the implementation plan and evidence/resumption skeleton in
      `docs/Phase-10.6H-H3-Verification.md`; do not claim acceptance from a drafted checklist.

### H3-02 — Implement concurrent admission

- [x] Implement per-provider FIFO state and synchronous prune/check/reserve/resolve admission;
      no await may separate capacity validation from reservation.
- [x] Use a single owner for each provider's queue draining/wake scheduling. New arrivals cannot
      bypass eligible waiters, and one provider's sleepers cannot block another provider's pump.
- [x] Make early, late, duplicate and simultaneous wakes harmless. Avoid recursive microtask spins,
      repeated zero-delay timers, stale wake callbacks and unbounded timestamp/history retention.
- [x] Validate cap/clock inputs and conflicting configuration without resetting existing reservations.
      Preserve supported constructor usage or update every audited caller explicitly.
- [x] Return actual accumulated wait diagnostics and enforce the queue bound. Idle queues must
      release timers/listeners without losing unexpired reservations.

### H3-03 — Cancellation, deadlines and transport integration

- [x] Thread optional caller controls through limiter and HTTP calls without redefining the existing
      transport timeout. Validate queue-wait inputs and establish deadline priority before admission.
- [x] Cover abort before enqueue, while queued, at admission, before dispatch and in flight; settle
      once, remove listeners, and cancel/reschedule the provider wake as required.
- [x] Combine caller cancellation with transport timeout and clean up resources for success,
      HTTP error, network error, body-read error and cancellation. Keep no timer/listener leak.
- [x] Distinguish local admission controls from genuine HTTP attempts. Preserve existing actual
      attempt schema/counts and non-control error mapping; document any changed diagnostic shape.
- [x] Propagate cancellation through retry backoff and prevent any subsequent attempt. Preserve
      linear backoff, maximum retries, 429 handling and existing fallback order for ordinary failures.
- [x] Audit providers whose optional limiter is absent: retain documented explicit bypass for test
      or approved construction; do not silently create one isolated limiter per HTTP request.

### H3-04 — Budget ownership and measurement semantics

- [x] Demonstrate shared registry endpoints draw from one provider budget and independent providers
      remain independent. Demonstrate separate instances do not share unless explicitly injected.
- [x] Retain synthetic cache-hit/miss, Birdeye reservation and retry characterization. State both
      logical-operation reservations and actual HTTP attempts, without equating them or billing them.
- [x] Complete Section 4's time/budget contract and its consumer/source inventory.
- [x] Preserve legacy timestamp/latency output with characterization tests. Do not add a migration,
      rewrite old JSON or ship the proposed future timing envelope under this checklist.
- [x] Record deferred changes and operational limitations without claiming H3 fixes distributed
      quotas, all provider freshness issues or per-account billing enforcement.

### H3-05 — Caller compatibility and adversarial verification

- [x] Complete T01–T15 with named passing evidence; test assertions about pending promises and
      transport counts, not elapsed real-time thresholds or arbitrary sleeps.
- [x] Use separate same-instance concurrent callers and controlled barriers, plus multiple-instance
      controls. JavaScript single-threaded execution does not eliminate async admission races.
- [x] Run audited limiter/HTTP/retry/registry and affected adapter/config/health tests through the
      dedicated harness; record every included file and why it is safe. Do not blanket-enable all
      provider/collector/terminal tests by filename.
- [x] Rerun unchanged dedicated H1 and H2 suites as compatibility checks. Investigate regressions;
      never edit away expectations that protect frozen evidence or accounting invariants.
- [x] Run full required static checks and verify no frozen source, manifests, lockfile, launch,
      protocol, archive, scheduler or operational data changes entered the patch.

### H3-06 — Review, checkpoint and closeout

- [x] Review implementation against D1-D9, all invariants, cancellation race semantics, resource
      cleanup, caller coverage, defaults and known timestamp/budget limitations.
- [x] Record exact source revision/fingerprint, dependency versions, commands, named tests/counts,
      failure probes and limitations. Keep the verification record's resume section current after
      every batch; check boxes only when their evidence exists.
- [x] Sync the parent checklist, roadmap, structure and post-V3 handoff. Mark H3 engineering-complete
      only when every acceptance requirement passes; keep H4 and operational integration separate.
- [x] Leave a reviewable uncommitted patch unless separately asked to commit/push. No automatic
      merge, deployment, operational migration, provider probe or cohort launch.

## 7. Required Test Matrix

These requirements now have named passing evidence in the [verification record](./Phase-10.6H-H3-Verification.md). The final suite has 98 H3 cases with no skips or expected failures.

| ID  | Cases                                                                                                                | Acceptance                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| T01 | Retain sequential baseline; H-03 with multiple sleepers waking together.                                             | Original defect reproduced, then cap maintained across successive windows.                                            |
| T02 | Many arrivals, cap greater than one, full initial burst, several windows, newcomer during drain.                     | No rolling interval exceeds cap; no queue bypass.                                                                     |
| T03 | FIFO ties, head/middle/tail cancellation, multiple providers, provider idle then reuse.                              | Eligible order preserved; other providers progress; no stale wake state.                                              |
| T04 | Boundary minus one/exact/plus one; early/late/spurious wakes; long wait; wall-clock jump; invalid monotonic samples. | Defined expiration, accurate accumulated wait and no busy loop or premature admission.                                |
| T05 | Jupiter/Raydium shared endpoints, injected shared limiter, independent registries/instances.                         | Actual ownership scope demonstrated; no false global-quota claim.                                                     |
| T06 | Pre-aborted, queued abort, abort/admission race, after-admission/before-fetch abort.                                 | Single settlement; no phantom dispatch; exact reservation/refund policy.                                              |
| T07 | Queue deadline before/at capacity, transport timeout after admission, combined cancellation and timeout.             | Queue and network timeout remain distinct; cleanup and deterministic priority.                                        |
| T08 | Queue at bound/over bound; cancelled entries make room; failed timer/scheduler injection.                            | Bounded rejection and cleanup; no stranded promises or unhandled rejections.                                          |
| T09 | Zero cap, negative/fractional/nonfinite/unsafe values, conflicting per-provider caps, invalid wait inputs.           | Explicit compatible unlimited mode or bounded validation failure; no silent history reset.                            |
| T10 | Fake success, 429, retryable network failure, timeout, nonretryable error, exhausted retries.                        | Actual attempts reacquire admission; retry/backoff/attempt numbering unchanged.                                       |
| T11 | Abort/deadline/queue-full before fetch; cancellation during retry backoff and body read.                             | No invented HTTP attempt or retry storm; no timer/listener leak.                                                      |
| T12 | Birdeye hit/miss/reservation refusal/retries; quote/category budgets; config default snapshots.                      | Existing accounting units and defaults preserved; scope and reset boundaries explicit.                                |
| T13 | Queue wait, delayed headers/body, parse failure, retries, cache hit and missing source time.                         | Legacy fetchedAt/latency meanings characterized; unknown remains unknown; future envelope remains documentation only. |
| T14 | Unexpected real fetch/env/default runtime access; harness dependency audit and fixture cleanup.                      | Forbidden access fails without contacting services or operational data.                                               |
| T15 | Audited caller suites, unchanged H1/H2 suites, type/lint/format/secret checks and source-diff review.                | Compatible isolated patch with complete evidence and no frozen dependency drift.                                      |

## 8. File Ownership And Verification Commands

Expected existing implementation surfaces: `backend/src/providers/http/providerRateLimiter.ts`,
`ProviderHttpClient.ts`, `providerRetry.ts`, their tests, and audited registry/adapter composition
only where needed for controls and shared admission. Existing config/shared-result changes require
specific compatibility evidence; do not broaden the patch into new provider integrations or H4.
New likely files: dedicated H3 harness/setup, deterministic fake scheduler and focused tests,
verification record and time/budget contract. These names describe planned work, not files already built.

After H3-AUTH and H3-00, from the isolated workspace only:

```powershell
$env:TEMP = Join-Path (Get-Location) '.tmp\h3'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
node node_modules/vitest/vitest.mjs run --config backend/vitest.h3.config.ts
node node_modules/vitest/vitest.mjs run --config backend/vitest.measurement-analysis.config.ts
node node_modules/vitest/vitest.mjs run --config backend/vitest.h2.config.ts
node node_modules/typescript/bin/tsc -p backend/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p shared/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p frontend/tsconfig.app.json --noEmit
node node_modules/typescript/bin/tsc --noEmit --module NodeNext --target ES2022 --skipLibCheck --strict backend/vitest.h3.config.ts
node node_modules/eslint/bin/eslint.js . --ignore-pattern .pnpm-store/** --ignore-pattern .tmp/**
node node_modules/prettier/bin/prettier.cjs . --check --ignore-path .gitignore --ignore-path .prettierignore
node scripts/check-secrets.mjs
git diff --check
```

Check each exit result separately. H3 approval and harness construction are complete; these commands are the approved isolated verification recipe. Reconfirm H1/H2
fixture-root rules before compatibility runs. Dependency provisioning is local and scoped if needed;
do not change manifests/lockfiles or use shared operational dependencies merely to make tests pass.

## 9. Acceptance And Still-Separate Gates

- [x] H-03 fixed with a retained concurrency regression; H3-INV-01 through H3-INV-08 and T01–T15
      each have named passing evidence, not just a total test count.
- [x] D1-D9 implemented as approved; no missing cancellation path, timer/listener leak, unbounded
      queue, hidden per-request limiter or unsupported global-budget claim remains.
- [x] Budget/time contract records actual legacy semantics, unknowns and deferred versioned changes.
- [x] All required checks pass for the recorded source; H1/H2 and frozen dependencies are preserved.
- [x] User-facing status distinguishes isolated engineering completion from operational integration.

Keep the frozen V3 operational checkout unchanged through the final scheduled September 18 invocation,
finality review, evidence preservation, final archive identity binding and approved analyzer report.
Calendar completion alone is not merge authority. After those gates, compare main and isolation;
incorporate newer main changes in isolation if needed, resolve conflicts and revalidate before a
separately reviewed merge/deployment. Do not automatically merge main into isolation during H3.

H3 is not permission to run a new cohort, change a provider budget in the active cohort, migrate an
operational database or trade. H4, future research design, independent validation, promotion and the
named pilot protocol/approval remain separate requirements.
