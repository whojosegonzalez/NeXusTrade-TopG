# NeXusTrade Phase 10.6A.1 Detailed Implementation Checklist

## Status and decision

- [x] Create the launch-blocking reliability checklist and cross-reference it in the Phase 9+ handoff documents.
- [x] Obtain explicit approval to implement this patch. Planning this document does not authorize a code change, scheduler arming, archive creation, provider call, or collection run.
      Note: the user explicitly approved implementation while retaining the separate no-run/no-scheduler-arming boundary.
- [x] Implement and verify the patch before arming the already authorized 10.6A external scheduler.
      Note: implemented with local fake-clock/fake-gateway tests only; no authorized archive root was created and no live request was made.

Phase 10.6A.1 is a narrow reliability repair to the implemented Phase 10.6A V2 collector. It preserves the frozen V2 population, timing, direct-provider, no-retry, request-budget, feature, label, archive, and safety contracts. It solves only an archive-lifecycle issue: a missed external two-hour invocation must be durably visible and must not prevent an otherwise terminal cohort from closing deterministically.

The scoped launch remains `data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z`, with cohort start `2026-08-21T00:00:00.000Z`. This checklist does not start it.

## Fixed safety boundary

Phase 10.6A.1 may change only the isolated exploratory-cohort collector, its CLI parsing, archive ledger logic, focused tests, launch runbook, and Phase 9+ handoff documents.

It must not:

- change the bytes, SHA, or fingerprint of `docs/research-protocols/phase10.6a-exploratory-cohort.v2.json`;
- alter any V2 sampling, request cap, provider, discovery, route, feature, label, date, concentration, or data-quality value;
- introduce retries, catch-up discovery, replacements, fallback providers, generic runtime reuse, database access, sessions, strategy decisions, or one-/two-minute monitoring;
- make a provider/RPC/HTTP request while reconciling missed slots or running the explicit closeout mode;
- create an order, fill, position, wallet action, signing, submission, PAPER action, or execution surface;
- arm an operating-system task, launch a background process, create the authorized archive root, or begin collection.

Existing normal `--once` behavior remains one current scheduled observation only. The repair records why an already elapsed external opportunity was missed; it never recreates that observation later.

## Problem statement

The V2 operator schedule owns 168 independent invocations. If a middle invocation does not start, a later normal invocation derives its current slot from the clock and can collect it, but the prior elapsed slot has no archive row. The current finalization condition is based on `slots.length`, so a missing row can leave the root `COLLECTING` forever after the final possible slot. If the final normal invocation itself is missed, there is no later normal slot to trigger a closeout.

The repair is therefore an auditable zero-request ledger reconciliation plus a deliberately separate, provider-free post-window closeout. It does not turn an external scheduling miss into a collected market unit.

## Locked V1 repair contract

### Canonical schedule and ledger rows

- The canonical V2 schedule has exactly 168 indexes, `0` through `167`.
- Index `i` has `slotId` `SLOT_${(i + 1).toString().padStart(3, "0")}` and `anchorAt = cohortStartAt + ((i + 1) * 2 hours)`.
- Before a normal invocation can make its current provider-backed observation for index `n`, it must reconcile every unrepresented elapsed index `0..n-1` in ascending index order.
- Each reconciled row is a safe, aggregate-only `PAUSE_WINDOW` row with reason `EXTERNAL_INVOCATION_MISSED`, no `selectedMint`, no candidate/unit, and `discoveryCounts` exactly `{ returned: 0, canonical: 0, technicallyValid: 0 }`.
- Reconciliation must append only canonical rows. It must not remove, rewrite, infer raw payload facts, select a replacement, or make a provider call.
- Existing valid rows remain authoritative, including a pre-existing `PAUSE_WINDOW` row. A row is represented solely by its canonical `slotIndex`.

### Strict existing-state validation

Before any normal provider call and before any provider-free finalizer writes, the collector must fail closed with `EXPLORATORY_COHORT_DATA_QUALITY_STOP` if the archive ledger contains any of the following:

- duplicate `slotIndex` or duplicate `slotId`;
- an index outside `0..167`;
- a `slotId` or `anchorAt` that does not match its canonical index;
- a represented index greater than or equal to the current normal invocation index;
- an impossible row shape, including a unit that does not reference a `VALID_UNIT` slot;
- an unsupported outcome/state combination or malformed existing archive that cannot be proven internally consistent.

No repair is allowed for those conditions. If an archive cannot be parsed, hash-validated, or structurally proven internally consistent, the collector must release only the lock it owns, make zero provider calls and zero archive writes, and return `EXPLORATORY_COHORT_DATA_QUALITY_STOP` for manual review. It must not finalize, rewrite, or otherwise mutate unreadable or unverified evidence.

Only a parseable, hash-validated, structurally consistent active archive may receive the bounded terminal data-quality closeout already defined by Phase 10.6A. That closeout must preserve the original valid evidence and use the ordinary atomic finalization path.

### Normal invocation lifecycle

- Acquire the exclusive archive lock before inspecting or mutating active state.
- Validate existing state and reconcile eligible elapsed missed slots while retaining that lock.
- Persist an active checkpoint that includes the reconciliation before constructing or calling the direct DEXSCREENER/Jupiter gateway.
- Continue the existing single current-slot collection path unchanged: one discovery request, fixed direct quote evidence as applicable, no retry/fallback/replacement, and the frozen V2 cap accounting.
- A normal current slot can be `VALID_UNIT`, `PAUSE_WINDOW`, or the existing safe data-quality stop only under the already frozen rules. A reconciled missed row is never a current collected slot.
- Determine terminality from represented canonical slot index, not ledger-row count. Once index `167` is represented, finalize `COHORT_COMPLETE` only if the pre-existing V2 completion rule is satisfied; otherwise finalize `COHORT_INCOMPLETE`.

### Explicit provider-free closeout mode

Add one separately named CLI mode, `--finalize-missed-slots`. It is an operational closeout, not a collection invocation.

- It is mutually exclusive with `--once` and requires the same pinned V2 `--protocol`, approved `--archive-root`, and output `--format` inputs.
- It accepts only the named source-controlled launch record for the approved root and only an existing active archive root. It cannot initialize a root.
- It may run no earlier than `cohortStartAt + 337 hours + 1 minute` (the final expected normal-process exit plus one minute).
- It must not construct a gateway, load provider credentials/configuration, make HTTP/RPC/provider calls, access a database/runtime/session, or produce any strategy/execution action.
- Under the exclusive lock, it validates the existing state, appends every missing canonical index through `167` as `PAUSE_WINDOW` / `EXTERNAL_INVOCATION_MISSED`, and finalizes `COHORT_INCOMPLETE` with the ordinary safe archive-finalization contract.
- A valid finalized root returns the pre-existing final state without a write. A missing root, fresh/conflicting lock, early invocation, non-active root that is not validly finalized, malformed state, wrong launch record, or protocol/root mismatch fails closed.
- This mode is not a retry, cannot reopen a final archive, and cannot ever yield `COHORT_COMPLETE`.

## Implementation tasks

### 1. Inventory and types

- [x] Read the current `ExploratoryCohortRunner`, archive service, config parser, CLI entrypoint, types, and focused tests. Confirm the ordinary slot path currently derives `slotIndex` from the clock and finalizes by ledger length.
      Note: inventory confirmed the exact row-count terminality and unconditional CLI gateway construction that this patch replaces.
- [x] Add a small explicit invocation-mode type with exactly `COLLECT_SLOT` and `FINALIZE_MISSED_SLOTS`; reject unknown or combined modes.
- [x] Add the safe `EXTERNAL_INVOCATION_MISSED` pause reason to the archive type contract. Do not introduce a market-data field, raw response field, or free-form error payload.
- [x] Add canonical schedule helpers shared by reconciliation and ordinary-slot validation, rather than duplicating slot id and anchor arithmetic.
- [x] Document, in code comments where useful, that `PAUSE_WINDOW` rows are availability records, not candidates and not later-outcome labels.

### 2. Archive lock and checkpoint mechanics

- [x] Retain exclusive ownership from opening an active root through reconciliation/checkpoint and the current-slot decision. Do not use a commit helper that removes the lock before the subsequent provider call.
- [x] Add an active-state checkpoint writer that atomically writes only the valid active manifest/ledger artifacts and retains the lock.
- [x] Preserve the established initial-root lock-before-artifact ordering and stale-lock closeout behavior from 10.6A.
- [x] Keep finalization atomic and make it the only lifecycle operation that removes a successfully owned lock.
- [x] Ensure any thrown error after lock acquisition removes only the lock owned by this process and never deletes user/archive data.
      Note: lock records now carry an ownership nonce; unverified evidence releases only an owned lock and receives no archive write.

### 3. Reconciliation and terminality

- [x] Validate all existing active rows before reconciliation and before normal provider gateway construction.
- [x] Append exact canonical missed rows for every elapsed, absent index before the current index. Persist them in ascending order.
- [x] Checkpoint after reconciliation and before any provider call so a crash cannot silently erase the availability evidence.
- [x] Replace row-count terminality with canonical-index terminality. Preserve V2 `96` valid-unit completion logic and all incomplete/data-quality outcomes.
- [x] Ensure the final normal slot, index `167`, finalizes an archive even when one or more earlier normal invocations were missed.
      Note: persisted active artifacts include canonical preimage hashes for manifest, units, and sources before the first ordinary gateway call.

### 4. Provider-free finalizer and CLI guard

- [x] Parse `--finalize-missed-slots` strictly and reject it with `--once`, duplicate occurrences, runtime/provider options, output files, unapproved roots, or unpinned protocol inputs.
- [x] Validate the same launch record/root/protocol tuple before runner construction.
- [x] Route the finalizer through a dedicated runner path which never calls normal `deriveSlot` for an out-of-window clock and never constructs the direct gateway.
- [x] Enforce the post-window time boundary using the injected clock; report a bounded, sanitized failure code for an early finalizer attempt.
- [x] Append only missing canonical rows, finalize incomplete, and emit the existing bounded markdown/JSON result format with explicit zero provider/database/runtime counters.
- [x] Keep the current launch guard’s default-deny behavior for every root other than the explicitly authorized one.

### 5. Runbook and documentation

- [x] Update the named operator runbook only after implementation passes verification. Keep it unarmed during implementation.
- [x] Add the one provider-free external closeout invocation at `2026-09-04T01:01:00.000Z`; it must use `--finalize-missed-slots`, have no retry/catch-up, and run only after the scheduled normal invocations.
- [x] State that the normal 168 process schedule is unchanged and that the finalizer is a no-provider archive closeout, not a 169th market-observation slot.
- [x] Update the 10.6A checklist completion notes, roadmap, decisions, planning inputs, and structure document with verification evidence and the new lifecycle rule.
- [x] Do not mark Phase 10.6A live collection complete. Scheduler arming remains a separate, explicit post-implementation approval.
      Note: documentation is prepared for review only; no task has been registered, armed, or run.

## Required automated tests

### Parsing and isolation

- [x] Normal `--once` remains accepted exactly once; duplicate `--once` is rejected.
- [x] `--finalize-missed-slots` is accepted only once and is rejected with `--once`, duplicates, wrong root, invalid protocol, external/runtime/provider options, or output writes.
- [x] The finalizer path proves zero gateway construction, zero provider/RPC/HTTP calls, zero database/session/runtime calls, and zero execution/wallet/signing/submission actions.

### Reconciliation correctness

- [x] An ordinary slot after one missed earlier invocation records one canonical `PAUSE_WINDOW` row before the current normal-slot provider call.
- [x] Several noncontiguous missed indexes are appended exactly once, in index order, with zero discovery counts and no selected mint/unit.
- [x] A second invocation never duplicates already reconciled rows.
- [x] A duplicate normal invocation for the same current slot returns `EXPLORATORY_COHORT_ARCHIVE_CONFLICT`, makes zero provider calls, and leaves every existing archive artifact byte-for-byte unchanged.
- [x] A crash after checkpoint and before a provider call preserves reconciled availability rows and makes no duplicate row on restart.
- [x] Reconciliation itself makes zero provider calls; the only ordinary provider calls are the frozen current-slot calls.

### Fail-closed evidence integrity

- [x] Duplicate index, duplicate slot id, mismatched anchor, out-of-range index, future row, malformed pause row, and orphan/non-`VALID_UNIT` candidate each stop before any provider call.
- [x] An unreadable, hash-invalid, or structurally unprovable archive returns `EXPLORATORY_COHORT_DATA_QUALITY_STOP`, releases only its owned lock, makes zero archive writes/provider calls, and leaves every original artifact byte-for-byte unchanged.
- [x] A pre-existing valid pause row is retained and is not converted to a candidate or a new collection attempt.
- [x] Lock contention, stale locks, and concurrent first-open behavior retain the existing 10.6A safety guarantees.

### Terminal lifecycle and finalizer

- [x] Index `167` finalizes incomplete when any earlier canonical rows are missed, even though ledger count is not the former expected count.
- [x] Index `167` still uses the unchanged V2 completion rule when the valid-unit threshold is met.
- [x] Finalizer is rejected one minute before its fixed boundary and succeeds at the boundary for an existing active root.
- [x] Finalizer fills all absent indexes through `167`, produces only canonical zero-request pause rows, and finalizes `COHORT_INCOMPLETE`.
- [x] Finalizer refuses a missing root, never creates initial artifacts, and makes zero provider calls.
- [x] Finalizer returns a valid finalized root without a write and never reopens it.
- [x] Finalizer refuses malformed state or conflicting/fresh lock without attempting repair or provider access.

### Regression verification

- [x] Run the focused exploratory-cohort tests.
      Note: `ExploratoryCohortRunner.test.ts` now has 17 fake-clock/fake-gateway cases; the backend suite passed 114 files / 386 tests.
- [x] Run `corepack pnpm verify` after implementation.
      Note: passed 2026-08-19: formatting, lint, workspace typechecks, all tests, and secret scan succeeded.
- [x] Run `corepack pnpm format:check`, `corepack pnpm check:secrets`, and `git diff --check` after all documentation updates.
- [x] Record exact command outcomes and test counts in this checklist and the Phase 9+ handoff documents.
      Note: final verification recorded backend 114 files / 386 tests, frontend 2 / 4, and shared 4 / 13. No live collection command or provider call was run.

## Acceptance gate

Phase 10.6A.1 is implementation-complete only when all of the following are true:

1. A missed external slot is represented by a canonical, zero-request `PAUSE_WINDOW` row before any later ordinary provider call.
2. An archive finalizes from terminal canonical index presence, not from `slots.length`.
3. The post-window closeout is strictly existing-root, provider-free, default-deny, and can only finalize incomplete.
4. No V2 protocol bytes or collection-affecting values changed.
5. All focused tests and the full verification suite pass, with no provider call made by local test/validation paths other than explicitly mocked test doubles.
6. The operator runbook remains unarmed unless the user separately authorizes scheduler arming after this patch is implemented and verified.

## Deferred work

Phase 10.6A.1 does not analyze a cohort, change the planned Phase 10.6B archive-only analysis, create a successor hypothesis, or authorize Phase 10.6C, Phase 10.7, dashboard changes, PAPER operations, or live execution. Any ordinary operational incident beyond the fixed missed-slot ledger and finalizer behavior requires a separately reviewed change rather than an improvisation during collection.
