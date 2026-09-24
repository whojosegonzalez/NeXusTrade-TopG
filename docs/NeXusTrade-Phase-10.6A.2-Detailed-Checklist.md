# NeXusTrade Phase 10.6A.2 Detailed Implementation Checklist

## V3 Measurement-Only Cohort Collector

Status: Implemented on 2026-09-04 after the one separately approved V3 static validation returned
`MEASUREMENT_PROTOCOL_DRAFT_READY_FOR_SEPARATE_COLLECTION_CHECKLIST_REVIEW`. The implementation was
verified only with an injected fake gateway, fake clock, and temporary synthetic test roots. It
created no named launch record, real archive root, scheduler, collection, or provider call and grants
no database/runtime, strategy, PAPER, wallet, signing, submission, order, fill, position, or
live-trading authority.

## 1. Purpose And Strict Question

Phase 10.6A.2 answers only this implementation question:

```text
Can an isolated collector implement the pinned V3 measurement-availability protocol exactly, with
outcome-blind selection, direct DEXSCREENER-only observations, safe immutable archives, and no
strategy or execution surface?
```

It is not a strategy study, score/risk adjustment, threshold change, candidate pre-registration,
Phase 10.6C study, return/target/stop analysis, provider experiment, dashboard extension, PAPER
operation, or collection authorization.

The pre-implementation planning result could be only one of:

```text
MEASUREMENT_COLLECTOR_CHECKLIST_READY_FOR_SEPARATE_IMPLEMENTATION_APPROVAL
PROTOCOL_FIDELITY_REVIEW_REQUIRED
HUMAN_REVIEW_REQUIRED
```

The ready result authorized only the completed synthetic-only collector implementation. It never
authorized provider use, a named archive root, an external scheduler, data collection, Phase 10.6C,
strategy changes, PAPER, wallet actions, signing, submission, orders, fills, positions, promotion, or
live trading.

## 2. Fixed Evidence, Protocol, And Authority Pins

All planning and any future implementation must use only these pinned local records:

```text
V3 protocol path
docs/research-protocols/phase10.6a-exploratory-cohort.v3.json

V3 protocol SHA-256
dd57285927474e3e646bd4a52c5d37fbb550d5cb73f836db69b02827c5360458

V3 static-validation fingerprint
b992982000ac2e0fb51cd7944a979adc0114f77a6845b3d36a3d88b9eab3e4e6

V3 static result
MEASUREMENT_PROTOCOL_DRAFT_READY_FOR_SEPARATE_COLLECTION_CHECKLIST_REVIEW
```

The only V2 facts relevant here are the V3 record's already-pinned audit fingerprint, V2 root/protocol
identity, and three aggregate availability signatures. This phase must not parse, compare, write, or
otherwise inspect the V2 archive.

No later observation, label, return, target, stop, P/L, MFE, MAE, score, risk output, strategy
decision, candidate claim, mint, unit, slot, timestamp, raw payload, URL, header, credential-like
value, database value, or V2 artifact hash may enter a planning decision, selection rule, or future
measurement interpretation.

## 3. Non-Negotiable Safety Boundary

- During planning and completed synthetic-only implementation verification: zero external/provider/RPC/
  HTTP calls; zero archive access; zero database, cache, repository, session, scanner, runtime,
  scheduler, wallet, transaction, or execution action. Source-controlled documentation/code changes
  and temporary synthetic test fixtures are the only permitted writes.
- A future real V3 collection requires, in order: this committed checklist, separate collector
  implementation approval, synthetic-only verification, a separate named-root launch record and
  explicit user authorization, then separate external-scheduler authorization. None is implied here.
- The existing V2 collector, immutable V2 archive, disabled task, V2 launch record, and V2 closeout
  task are out of scope. They must not be modified, reused, resumed, or scheduled by V3.
- BUY=90 and WATCH=70 remain unchanged. F65E@v1 remains closed. No strategy default, risk, score,
  target, stop, one-/two-minute monitoring, provider default, PAPER behavior, or execution behavior
  may change.
- The eventual collector may use only V3-pinned direct `DEXSCREENER` capabilities. It must add no
  provider, Jupiter call, router, proxy, generic endpoint, API-key requirement, raw-payload retention,
  retry, fallback, dynamic budget, or hidden scheduler.
- Later observations and labels are literally absent. The collector must not schedule a post-anchor
  request or calculate a return, target/stop result, P/L, MFE, MAE, or any performance fact.

## 4. Frozen V3 Collection Contract

### 4.1 Population and outcome-blind selection

| Contract item             | Fixed requirement                                                                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery universe        | `ALL_CANONICAL_SOLANA_MINTS_FROM_UNMODIFIED_DISCOVERY_UNIVERSE` from exactly one direct `discoverTokens(100)` request.                                          |
| Selection time            | `SLOT_ANCHOR_MINUS_16_MINUTES`; no measurement value or missingness may affect selection.                                                                       |
| Identity                  | Base58 canonical 32-byte Solana mint, required source kind, and required UTC first-received timestamp.                                                          |
| Deterministic selection   | `SHA256(phase10.6a-exploratory-cohort.v3\|canonicalMint\|slotId)`, lexicographically lowest hash.                                                               |
| Technical-validity anchor | Canonical identity plus selection-time source metadata only. Missing price, liquidity, or momentum components must not erase a technically valid sampling unit. |
| Deduplication             | One canonical mint per cohort and at most one unit per non-overlapping two-hour slot. A duplicate is excluded and never replaced.                               |
| Forbidden inputs          | BUY/WATCH/SKIP, F65E, later labels/returns, risk/strategy facts, measurement values, and measurement missingness.                                               |

The future collector must record a canonical slot ledger for every attempted slot. It must not
backfill, catch up, resample, substitute a mint, or extend the fixed calendar because data are missing.

### 4.2 Exact timing and direct-observation schedule

For each canonical two-hour slot, an external invocation may start exactly at anchor−16 minutes and
must finish at anchor. The next invocation must begin only for the following canonical slot; overlap is
prohibited.

| Scheduled time    | Permitted action                                                                                             | Fixed condition                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Anchor−16 minutes | One direct DEXSCREENER `DISCOVERY` request: `discoverTokens(100)`; canonicalize and select at most one unit. | One category request per minute, concurrency one, timeout 10 seconds, retry 0, fallback prohibited. |
| Anchor−15 minutes | One direct `MARKET_CONTEXT/BEST_PAIR` request for the selected canonical mint only.                          | Source must be observed within 60 seconds of this scheduled snapshot.                               |
| Anchor−10 minutes | One direct `MARKET_CONTEXT/BEST_PAIR` request.                                                               | Same fixed freshness rule.                                                                          |
| Anchor−5 minutes  | One direct `MARKET_CONTEXT/BEST_PAIR` request.                                                               | Same fixed freshness rule.                                                                          |
| Anchor            | One direct `MARKET_CONTEXT/BEST_PAIR` request, then end the invocation.                                      | Liquidity uses this snapshot; local calculations use only declared snapshots.                       |
| After anchor      | No request, sleep, label, return, or performance calculation.                                                | Prohibited.                                                                                         |

No request may be made before its scheduled observation time to recover a later miss. If the process
reaches a snapshot too late to satisfy the 60-second limit, it must make no retroactive request and
retain the exact applicable availability code.

### 4.3 Measurement facts and missingness

The future unit contract may retain only sampling identity/partition/slot and these decision-time facts,
each as either a finite value or a V3 eight-code missingness record with exact category, source
identifier, and source timestamp when available.

| Field          | Value/derivation                                            | Required source and freshness                                              | Missing-component action                                                             |
| -------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `LIQUIDITY`    | Finite non-negative USD `BEST_PAIR.liquidityUsd` at anchor. | `MARKET_CONTEXT/BEST_PAIR`, no more than 60 seconds from anchor.           | Record the declared code; do not drop or replace the valid unit.                     |
| `MOMENTUM_5M`  | `((PRICE_AT_0 / PRICE_AT_NEGATIVE_5) - 1) * 100`.           | Positive finite `BEST_PAIR.priceUsd` at −5 and 0, each within 60 seconds.  | Record the declared code when either component is absent, stale, invalid, or failed. |
| `MOMENTUM_15M` | `((PRICE_AT_0 / PRICE_AT_NEGATIVE_15) - 1) * 100`.          | Positive finite `BEST_PAIR.priceUsd` at −15 and 0, each within 60 seconds. | Record the declared code when either component is absent, stale, invalid, or failed. |

`-10` is a mandatory provenance/continuity snapshot even though it is not a formula input. Its value or
missingness must not trigger selection, replacement, or a formula change.

The only availability enum is: `AVAILABLE_AT_ANCHOR`, `NOT_REQUESTED`,
`UNAVAILABLE_AT_ANCHOR`, `STALE_AT_ANCHOR`, `BUDGET_EXHAUSTED`, `PROVIDER_ERROR`, `UNSUPPORTED`, and
`INVALID_VALUE`.

### 4.4 Provider, pacing, and budget contract

| Category         | Direct provider/capability                         | Cohort cap |
| ---------------- | -------------------------------------------------- | ---------: |
| `DISCOVERY`      | DEXSCREENER / `discoverTokens(100)`                |        168 |
| `MARKET_CONTEXT` | DEXSCREENER / `getBestPairForToken(canonicalMint)` |        672 |

Each category is one request per minute and concurrency one. Timeout is 10 seconds; retry count is
zero; fallback, backoff, provider expansion, raw-payload retention, and generic routing are prohibited.
The source inventory may retain safe aggregate category/capability/availability/latency counts and a
hash of sanitized provenance only. It must retain no raw payload, URL, header, credential, request body,
or provider configuration.

### 4.5 Calendar, gates, and lifecycle fidelity

The calendar is 168 attempted slots across 14 consecutive UTC dates, planned 96 valid units, minimum
72 valid units, and one unit per slot. Partition by
`SHA256(phase10.6a-exploratory-cohort.v3\|canonicalMint\|slotId)`: even final digit is `DISCOVERY` and
odd is `VALIDATION`.

Completion requires the frozen 96-valid-unit plan plus at least 32 valid units and four UTC dates in
each partition, at least eight UTC dates overall, at least 72 distinct mints, no duplicate mint, and no
UTC date above 20% of valid units. At canonical slot index 167, a failure of any fixed gate is
insufficiency evidence, not a reason to change the calendar or requirements.

For each objective and partition, availability is exactly
`(AVAILABLE_AT_ANCHOR / VALID_UNITS_IN_PARTITION) * 100`, must be at least 90%, and needs at least four
UTC dates of support. Provenance and freshness/missingness must be consistent. A data-quality stop is
only a V3-declared clock-order, manifest-schema, secret-like-content, or provider-budget-exhaustion
condition.

Before collector code begins, implementation review must map V3's normal completion and terminal
archive lifecycle onto existing safe archive semantics without adding an undocumented result code,
implicit closeout, or automatic extension. If it cannot be derived directly and unambiguously from the
pinned V3 source plus approved generic immutable-archive semantics, stop as
`PROTOCOL_FIDELITY_REVIEW_REQUIRED`; do not amend V3 or implement a collector informally.

### 4.6 Archive, lock, and launch-record contract

The future archive root must match only:

```text
data/archive/phase10.6a/measurement-v3-YYYYMMDD-HHmmZ/
```

It must contain only these V3-named artifacts:

```text
cohort-manifest.v1.json
units.v1.ndjson
source-inventory.v1.json
collection-summary.v1.json
```

The future collector must create the root, acquire an exclusive `wx` lock, and only then write initial
artifacts. It validates active files, hashes, schemas, protocol/launch identity, and slot consistency
under its owned lock before provider construction or a call. A simultaneous opener fails with no
artifact write or provider call. A duplicate current-slot invocation fails unchanged with zero calls.

An unreadable, hash-invalid, or structurally inconsistent root releases only the current lock and makes
zero provider calls and zero archive writes. A parseable, internally consistent stale-lock root may
receive only a bounded terminal closeout with no provider call; it may never resume, overwrite evidence,
or insert a replacement. Final artifacts are canonical, hashed, immutable, and idempotently readable.

A future source-controlled launch record may contain only the named root, matching V3 SHA, start time,
fixed authorization reference, and non-secret operator metadata. It must contain no credential,
provider configuration, URL, schedule command, arbitrary environment value, or execution instruction.

## 5. Future Isolated Implementation Boundary

After separate implementation approval, create only:

```text
backend/src/research-measurement-cohort/
backend/src/scripts/research-measurement-cohort-collect.ts
docs/research-launches/phase10.6a-measurement-v3.schema.json
```

Root and backend package manifests may add only one named collection command. Do not modify or import
the V2 runner/archive/gateway, dashboard, generic runtime, scanner, watchlist, strategy, risk, PAPER,
database, wallet, transaction, session, order, fill, or position modules. The direct gateway may use
only the existing narrow DEXSCREENER capability behind an injected interface; it must not construct a
generic router or a Jupiter capability.

The future CLI must default-deny all use. Before named-root approval it may accept no production
configuration that can reach a provider. Its eventual invocation must require exactly the fixed V3
protocol path and matching source-controlled launch record, optional one `--format=markdown|json`, and
optional one `--once`. It must reject archive overrides, output/write/save, environment, provider,
HTTP/URL, database/runtime, scanner, strategy/risk/score/threshold/target/stop, monitor, scheduler,
wallet, signing, submission, PAPER, live, execution, order, fill, position, balance, include/phase/
cohort, and generic configuration options.

## 6. Synthetic-Only Test Plan

All tests use injected fake clock, fake direct gateway, temporary test roots, and synthetic launch/
protocol bytes. They make zero real provider/RPC/HTTP calls and never access the V2 or a future real V3
archive.

Required tests:

1. Exact V3 SHA/static-result and launch parser acceptance; reject wrong, omitted, duplicate, absolute,
   traversal, provider, scheduler, archive-override, write, runtime, and execution options before a
   source read or gateway construction.
2. Dependency isolation: no V2 collector/archive/gateway, generic runtime, Jupiter, database, strategy,
   PAPER, wallet, transaction, session, order/fill/position import; no raw-payload/credential/URL
   retention.
3. Deterministic selection/partitioning: score, risk, measurement, missingness, and later-fact
   mutations cannot change the selected unit.
4. Exact fake-clock sequence: discovery at −16; market snapshots at −15/−10/−5/0; no early/late
   compensating request, post-anchor request, or overlap; actual counts never exceed one per minute,
   one concurrent, 168 discovery, or 672 market requests.
5. Direct liquidity mapping; exact 5-/15-minute formulas; −10 continuity storage; every invalid,
   missing, stale, provider-error, and budget-exhausted component retains only an allowed code and
   never erases a valid unit or triggers replacement.
6. All gates: safe source inventory, 90% per-objective/per-partition availability, date support,
   concentration, deduplication, and frozen 96/72/32/4/8/20 requirements.
7. Archive lifecycle: lock before initial artifacts, concurrent opener refusal, duplicate current-slot
   no-write refusal, parseable stale-lock bounded closeout, unreadable archive zero-write/zero-provider
   refusal, immutable finalization, and idempotent final-root reads.
8. Interruption and canonical slot index 167: no resume/retry/catch-up/replacement or automatic
   extension; only a bounded source-derived terminal result.
9. Deterministic Markdown/JSON with `generatedAt` omitted and `contentFingerprint` blanked from the
   SHA-256 preimage, literal zero database/runtime/session/execution facts, and secret-scan coverage.

## 7. Required Future Verification

After separate implementation approval and before any named-root request, run only synthetic/local
verification:

```text
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm --filter @nexustrade/backend exec vitest run src/research-measurement-cohort/
corepack pnpm check:secrets
```

Do not run a real V3 collector, provider smoke test, archive creation, scheduler action, or named-root
launch as part of implementation verification.

## 8. Implementation Sequence

Update this checklist immediately after each completed task with a checked box and concise note. No
checkbox grants a later authority by implication.

### A. Freeze collector fidelity before source changes

- [x] Reconfirm the V3 SHA, static-validation fingerprint/result, timing/caps/formulas, and exact
      source-derived lifecycle mapping. Normal immutable states are generic `COLLECTING` and
      `COHORT_COMPLETE`; V3's two literal terminal outcomes remain unchanged. A parseable stale lock
      is bounded at anchor plus the source-declared 60-second freshness allowance; a malformed root
      fails closed without an archive write or provider call. No new V3 collection value was added.
- [x] Record literal zero execution state and the prohibition on V2 reuse, later labels, provider
      expansion, retry, fallback, raw payloads, and automatic scheduling. The new source is isolated
      under `research-measurement-cohort`; it has no V2, later-label, strategy, PAPER, database, or
      execution import.

### B. Build only an isolated, default-deny collector after separate approval

- [x] Add isolated V3 types, strict launch schema, fixed protocol/launch identity guard, injected
      clock/gateway, and default-deny CLI. Do not modify V2 or strategy/execution modules. The only
      command requires the pinned V3 path, one named source-controlled launch record, and `--once`.
- [x] Implement exact selection, −16/−15/−10/−5/0 timing, direct DEXSCREENER-only budget accounting,
      fact mapping, formulas, declared missingness, no later observations, and no replacement/catch-up.
      The narrow real gateway is constructed only after protocol and launch identity checks pass.
- [x] Implement safe immutable archive/lock lifecycle only after all collector inputs validate. The
      root is created, then an exclusive `wx` lock is acquired before initial artifacts are written;
      unreadable state fails closed and stale parseable state may only finalize as insufficient.

### C. Prove all behavior synthetically

- [x] Add the Section 6 fake-clock/fake-gateway/temporary-root tests; do not read a real V3 archive or
      call a provider. The focused suite has 10 passing tests covering default-deny scope, V3 launch
      identity, deterministic selection/partitioning, exact four-snapshot timing, formulas,
      missingness, concurrent/duplicate locks, malformed/stale archives, and completion gates.
- [x] Run every Section 7 command successfully and record focused results. `corepack pnpm format:check`,
      `corepack pnpm lint`, `corepack pnpm typecheck`, the focused collector Vitest command, and
      `corepack pnpm check:secrets` all passed on 2026-09-04. No real collector, provider smoke,
      archive creation, scheduler action, or named root was run.

### D. Separate operational authority after implementation

- [x] Present implementation source, test results, launch schema, run duration, and every fixed request
      for separate review. The implementation was reviewed, committed, and separately approved before
      the named-root record was created.
- [x] Obtain separate explicit approval for one named root and source-controlled launch record; validate
      that record locally without a provider call. The approved anchor is 2026-09-04 14:00 PDT
      (`2026-09-04T21:00:00.000Z`), with root
      `data/archive/phase10.6a/measurement-v3-20260904-2100Z/` and source-controlled record
      `docs/research-launches/phase10.6a-measurement-v3-20260904-2100Z.json`. Scheduler authority
      remains deliberately absent. The initially prepared uncommitted 20:00Z record was superseded
      before any scheduler, collector, provider, or archive action.
- [x] Obtain separate external-scheduler authorization and provide a runbook. Do not arm it before the
      named-root authorization. The user separately authorized the external scheduler on 2026-09-04;
      the source-controlled V3 runbook fixes the 1:44 PM PDT start, 168 two-hour triggers, one
      instance, no catch-up/retry/restart, and the single permitted command. The user registered and
      armed that operator-owned task on 2026-09-04 for the exact named root. Do not modify or rerun it
      manually while collection remains active.
- [ ] After a separately authorized collection ends, document only final root, hashes, bounded counts,
      quality/availability facts, and zero execution state. Require separate archive-only analysis
      approval; do not begin Phase 10.6C.

## 9. Acceptance Gates

```text
pinned V3 source/static result and every collection-affecting mapping = exact
new V3 collector isolated; V2 collector/archive/task untouched = yes
provider surface = direct DEXSCREENER DISCOVERY and MARKET_CONTEXT only
caps/pacing/timeout/retry/fallback = 168 / 672 / 1-per-minute / 10s / 0 / prohibited
selection uses later, score, risk, strategy, measurement value, or missingness = no
post-anchor observations, labels, returns, target/stop, P/L, MFE, or MAE = absent
archive/launch/root/scheduler authority during implementation = absent
database/runtime/session/PAPER/wallet/signing/submission/orders/fills/positions = 0 / 0 / 0
BUY=90 / WATCH=70, F65E closure, and strategy defaults = unchanged
```

Only a separate completed checklist, implementation approval, synthetic verification, named-root
authorization, and external-scheduler authorization can permit a future V3 observation. This phase
cannot authorize Phase 10.6C or move the project toward execution directly.
