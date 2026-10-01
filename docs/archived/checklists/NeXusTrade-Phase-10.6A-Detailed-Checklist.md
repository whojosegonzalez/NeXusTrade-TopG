# NeXusTrade Phase 10.6A Detailed Implementation Checklist

## Exploratory Cohort Collection

Status: Implemented 2026-08-19. One separately authorized V2 collection began on 2026-08-21 and
finalized `COHORT_COMPLETE` on 2026-08-29; its repeating collector task is disabled. The collector
was verified with injected fakes before that one run. No additional provider/RPC/HTTP collection is
authorized, and the completed archive must remain unchanged pending separate Phase 10.6B approval.

## 1. Purpose And Required Outcome

Phase 10.6A is the first phase permitted to collect live market observations after the closed
Phase 9.28/9.29 studies. It is an observational data-collection phase only. It must implement the
already validated `ExploratoryCohortProtocolV2` exactly; it must not create a strategy decision,
entry predicate, candidate pre-registration, profitability claim, or execution action.

The sole required outcome is one immutable, complete, or explicitly incomplete archive under the
fixed Phase 10.6A archive pattern. The archive must support a later separate Phase 10.6B
archive-only assessment. It must never itself return a trading recommendation, promotion result, or
authorization for Phase 10.6B, Phase 10.6C, PAPER execution, or any wallet action.

The collection starts only from this frozen source record:

```text
protocol path
  docs/research-protocols/phase10.6a-exploratory-cohort.v2.json

protocol SHA-256
  2662a4cbc1d3458d55b64f9c4cc826561aad1cb6f6b5faf11079194377f5a0ed

Phase 10.5A validator result
  PROTOCOL_READY_FOR_SEPARATE_COLLECTION_APPROVAL

Phase 10.5A validator fingerprint
  1fbe8a70792d872c7199d7182d095f13cce7c9908939526b44ecc7e2f872c283
```

`PROTOCOL_READY_FOR_SEPARATE_COLLECTION_APPROVAL` is a design-completeness result only. This
checklist must still be approved, implemented, verified, and separately authorized before the first
provider call.

## 2. Non-Negotiable Safety And Authority Boundary

Every Phase 10.6A implementation and collection run must preserve all of the following:

- It may make only the allowlisted, bounded live market calls in Section 6 after the user explicitly
  authorizes a named archive root. No browser, local dashboard, Vite server, diagnostic, smoke, or
  unrelated provider command may make a call under this phase.
- It must use a new isolated collector. It must not construct or invoke `ScannerRunner`,
  `WatchlistReturnRunner`, `TerminalRunner`, a session manager, risk runner, strategy runner, paper
  runner, exit manager, quote-diagnostic runner, or any generic runtime orchestration surface.
- No active or archived SQLite/database read or write, migration, seed, reset, pragma, repository,
  Drizzle client, session, TokenRadar row, strategy decision, order, fill, position, or system-log
  record is allowed. `data/nexus_paper.db*` is out of scope.
- No wallet loading, private-key access, transaction construction, signing, submission, order,
  fill, position, balance, PAPER BUY/SELL, exposure, P/L, or execution control is allowed.
- The research baseline remains BUY=90 / WATCH=70 and PAPER execution remains disabled. No score,
  strategy profile, threshold, exit, default, quote-budget, provider-default, one-minute, or
  two-minute monitoring change is allowed.
- No unchanged F65E@v1 continuation and no score-band widening/lowering is allowed. Scores,
  BUY/WATCH/SKIP classifications, risk outcomes, and later observations must never determine
  population membership, selection, replacement, priority, split, or collection duration.
- No API key, authorization header, environment value, private URL, raw provider payload, response
  body, request body, credential-shaped text, or full provider path may be written to the archive,
  standard output, logs, error messages, tests, documentation, or dashboard export.
- The only runtime filesystem writes are the fixed Phase 10.6A archive artifacts in the explicitly
  authorized new archive root and short-lived atomic-write temporary files removed before command
  completion. No report, cache, checkpoint, session, database, generated dashboard data, or file
  outside that root may be written.
- The collector must return only bounded collection states. It must not rank features, choose a
  hypothesis, tune a predicate, issue a counterfactual recommendation, or create a candidate record.

Later 3/5/15/60-minute values are labels only. They must be stored separately from decision-time
facts and must never feed a collection control path.

`ExploratoryCohortProtocolV1` is preserved as its original non-authorizing design record. V2
supersedes it only for this proposed collection: the V2 hash record fixes caps that cover every
attempted slot without adding a retry, fallback, replacement, or wider cohort.

## 3. Frozen V2 Collection Contract

The collector must use the following operational values exactly. They supplement the frozen Phase
10.5A protocol without modifying it. Any change requires a new versioned protocol/collection
checklist, fresh validation, and separate approval before collection.

| Area                           | Locked V2 collection value                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run cadence                    | 168 maximum contiguous UTC slots of 120 minutes. The first V2 cohort must start at `00:00Z` in an explicitly authorized archive root. One external collector invocation owns one slot; it starts at that slot's end minus 60 seconds and exits after its +60-minute observation.                                                                                                                                  |
| Slot schedule                  | Discovery request at slot end minus 60 seconds; deterministic selection and decision-time anchor at slot end; later observations at +3m, +5m, +15m, and +60m. The operator-owned scheduler may start the next invocation only at the next slot's end minus 60 seconds, after the prior invocation exits. A call that cannot start by tolerance is not made and is `MISSING`.                                      |
| Population                     | Call the existing unmodified `DEXSCREENER` discovery capability exactly as `discoverTokens(100)` at the scheduled instant. The population is the canonical identities from that one fixed request. Record only safe aggregate counts returned before canonicalization, after canonicalization, and after technical validity; no local ranking, score, liquidity, price, symbol, chain, return, or outcome filter. |
| Technical validity             | A candidate needs a canonical base58 32-byte Solana mint, non-empty provider source kind, and finite source-received UTC timestamp. Invalid identities remain in the slot ledger with a reason and are not replaced.                                                                                                                                                                                              |
| Deterministic selection        | Deduplicate only by canonical mint in the discovery response; select the eligible mint with the lexicographically lowest SHA-256 of `phase10.6a-exploratory-cohort.v2\|canonicalMint\|slotId`. Select at most one mint per slot.                                                                                                                                                                                  |
| Required valid anchor facts    | Canonical mint, slot ID, anchor UTC timestamp, partition, discovery provenance/time, and a finite positive USD market price. A selected unit missing one is recorded as `SKIP_UNIT_WITH_REASON`, never replaced, and does not count as valid.                                                                                                                                                                     |
| Optional decision-time facts   | Asset age, liquidity, volume, momentum, quote availability/impact, risk blockers, and repeated attention use the Phase 10.5A availability vocabulary. Missing optional facts never alter eligibility or cause a replacement.                                                                                                                                                                                      |
| Provider mapping               | `DISCOVERY` = `DEXSCREENER` discovery capability; `MARKET_CONTEXT` = `DEXSCREENER` best-pair capability; `QUOTE_IMPACT` = direct `JUPITER` quote capability with no router fallback; `LATER_OBSERVATION` = `DEXSCREENER` best-pair capability. No other provider or capability is permitted.                                                                                                                      |
| Cross-category provider pacing | At most one network request per actual provider during any rolling 60-second interval, in addition to the Phase 10.5A category caps. The discovery and market-context requests are separated by at least 60 seconds.                                                                                                                                                                                              |
| Quote probe                    | Quote-only, non-executable wrapped-native-SOL to selected mint probe for 100,000,000 lamports with 100 bps slippage. It uses the direct JUPITER adapter's normal quote-route resolution, not a generic provider router or fallback. It must not create a swap transaction, load a wallet, sign, submit, or save raw quote content.                                                                                |
| Provider limits                | Each category: one request per minute, concurrency one, 10-second timeout, retry count zero, and no backoff/fallback. Cohort caps: discovery 168; market context 168; quote impact 168; later observation 672. These cover every one of 168 attempted slots and all four observations per attempt; budget exhaustion stops the cohort.                                                                            |
| Later labels                   | At +3m and +5m allow 30 seconds; at +15m allow 60 seconds; at +60m allow 300 seconds. Record only `OBSERVED_ON_TIME`, `OBSERVED_LATE`, `MISSING`, or `INVALID`, plus a numeric return only when both positive anchor and observed USD prices are valid.                                                                                                                                                           |
| Partition                      | SHA-256 of `phase10.6a-exploratory-cohort.v2\|canonicalMint\|slotId`; even final hexadecimal digit is `DISCOVERY`, odd is `VALIDATION`. No mint may occur in both partitions.                                                                                                                                                                                                                                     |
| Completion                     | Stop with `COHORT_COMPLETE` only at 96 valid units, at least 8 UTC dates, at least 32 valid units and 4 UTC dates in each partition, no repeated mint, and no date exceeding 20% of valid units.                                                                                                                                                                                                                  |
| Incomplete result              | `COHORT_INCOMPLETE` when 168 slots finish without completion, when fewer than 72 valid units exist, or any size/split/date/concentration rule fails. It is evidence, not an invitation to relax a rule.                                                                                                                                                                                                           |

The V2 source does not request a live risk-evidence capability. `risk.blockerCodes` is
recorded as `NOT_REQUESTED` and has no value. `attention.repeatedAttentionCount` is available only
as the non-negative number of duplicate raw discovery emissions for the selected canonical mint in
its own pre-deduplication slot response; otherwise it is `UNSUPPORTED`. Neither fact affects the
selection or partition.

## 4. Permitted Command And Archive Scope

Phase 10.6A may add exactly one collection CLI after the user approves implementation:

```text
pnpm research:exploratory-cohort:collect -- \
  --protocol=docs/research-protocols/phase10.6a-exploratory-cohort.v2.json \
  --archive-root=data/archive/phase10.6a/exploratory-cohort-v2-YYYYMMDD-HHmmZ \
  --once \
  --format=markdown
```

The command must accept exactly the approved V2 protocol path, exactly one new archive root matching
the V2 `YYYYMMDD-HHmmZ` grammar, optional exactly-once `--once`, and optional exactly-once
`--format=markdown|json`. It must reject every other path, duplicate option, URL, traversal,
output/write, database, session, scanner, strategy, score, threshold, target, stop, monitoring,
wallet, signing, submission, paper, live, order, fill, position, balance, environment, provider,
network, or arbitrary runtime option.

`--once` is not a dry run. It is the only V2 runtime mode: one process starts at the designated UTC
slot end minus 60 seconds, anchors at slot end, waits through +60 minutes, finalizes that slot, and
exits. An operator-owned scheduler outside the application may invoke only the next slot after that
exit and only after the user authorizes the named archive root. The project must not add an internal daemon, one-minute or
two-minute polling loop, auto-start behavior, cron configuration, or background process.

Before the first collection call, the operator must make a source-controlled launch record that
states the exact archive root, its UTC start date, the protocol SHA-256, and the explicit user
authorization reference. The collector must copy only that safe identity into the manifest. It must
not create a root for an unregistered start date, resume a completed root, or alter a launch record.

The launch record path is exactly:

```text
  docs/research-launches/phase10.6a-exploratory-cohort-v2-YYYYMMDD-HHmmZ.json
```

Its timestamp must exactly match the archive-root timestamp. The first V2 launch record must use
`00:00Z`; that start policy is narrower than, and does not replace, the protocol's general archive
grammar. Its strict schema must contain only a
contract version, that archive root, UTC start timestamp, protocol path/SHA-256, Phase 10.5A
validation fingerprint, literal `USER_AUTHORIZED_FOR_ONE_OBSERVATIONAL_COLLECTION`, and a bounded
non-secret authorization reference. It must reject unknown fields, placeholder values, URLs,
absolute paths, credentials, provider configuration, candidate data, strategy/default values, and
runtime overrides. The collector resolves this path from `--archive-root`; it must not accept a
separate launch-record option.

Public collection errors must contain exactly one bounded code and no provider content:

```text
EXPLORATORY_COHORT_INVALID_SCOPE
EXPLORATORY_COHORT_PROTOCOL_INCONSISTENCY
EXPLORATORY_COHORT_ARCHIVE_CONFLICT
EXPLORATORY_COHORT_PRECONDITION_UNMET
EXPLORATORY_COHORT_DATA_QUALITY_STOP
EXPLORATORY_COHORT_PROVIDER_BUDGET_EXHAUSTED
```

## 5. Isolated Collector Architecture

The implementation must be a new `research-exploratory-cohort` module with explicit dependency
injection. It may depend only on narrow shared value types, node time/crypto/filesystem primitives,
the frozen protocol validator/schema, and explicit provider capability interfaces. It must not
import database, repositories, Drizzle, sessions, scanner, strategy, risk, paper, exit, terminal,
watchlist, or dashboard modules.

Required components are:

```text
ExploratoryCohortCollectionConfig      strict CLI parsing, launch-root checks, no unsafe options
ExploratoryCohortProtocolGuard         validates the exact frozen protocol/hash before any call
ExploratoryCohortClock                 injected UTC slot and observation scheduler
ExploratoryCohortProviderGateway       direct allowlisted capability calls, pacing, timeout, no retry
ExploratoryCohortSelectionService      canonical identity, dedupe, deterministic selection/partition
ExploratoryCohortEvidenceMapper        value/missingness/provenance mapping with no raw payloads
ExploratoryCohortArchiveService         fixed-schema atomic archive writes and immutable finalization
ExploratoryCohortCollectionRunner       composes one slot without strategy or execution authority
ExploratoryCohortReportFormatter        bounded stdout Markdown/JSON only
research-exploratory-cohort-collect     CLI entrypoint
```

The provider gateway must construct only direct `DEXSCREENER` and `JUPITER` capability adapters with
raw-payload logging and provider-health persistence disabled. It may use already configured local
provider credentials where an adapter requires them, but it must never require, display, persist,
hash, test, or transmit a credential outside the adapter's normal request header. If a required
adapter is unavailable, no fallback provider is allowed. The run records bounded missingness or
fails its precondition as appropriate.

V2 must not use the generic `ProviderRegistry` or quote router. It must use only direct injected
capability adapters behind the new gateway, so a fallback, retry, cache persistence,
provider-health write, or execution-related behavior cannot enter through a generic runtime.

## 6. Collection Sequence And Evidence Boundaries

### 6.1 Preflight before any provider call

The collector must, in this order:

1. Parse and validate the narrow CLI configuration without reading a database or provider.
2. Validate the frozen protocol path, protocol SHA-256, source-evidence fingerprints, and launch
   record against the approved archive root.
3. Create a new archive root only if it does not exist and acquire its exclusive `collection.lock`
   before writing any artifact; otherwise validate a non-final manifest for the same root and reject
   conflict, completed, mismatched, or duplicate-slot use.
4. Verify that the direct discovery and market-context capability is locally available without
   printing configuration values. If unavailable, write a safe precondition outcome with no provider
   call and stop before the slot begins.
5. After the new-root lock is acquired, write the initial manifest containing fixed contract identity,
   zero counters, planned slots, and prohibited authority flags. The initial manifest must not contain
   any provider response.

The preflight must not call a health endpoint, probe, smoke test, quote endpoint, or discovery
endpoint. A locally unavailable optional quote capability is recorded as `NOT_REQUESTED` only after
the selected unit is formed; it does not authorize a fallback.

### 6.2 Slot discovery and selection

At slot end minus 60 seconds, make exactly one `DEXSCREENER` discovery capability request as
`discoverTokens(100)`. Preserve only each returned canonical identity, source kind, source-received
timestamp, count of duplicate raw appearances, and the safe aggregate returned/pre-canonical/
post-canonical/technically-valid counts; discard the raw response.

At slot end, canonicalize and deduplicate the response, apply only the technical-validity rule, then
select one mint by the frozen hash rule. Persist the complete safe slot ledger in the manifest,
including zero-selection, invalid-identity, duplicate, rate-limit, and provider-error outcomes.
No refill, retry, replacement, ranking, score, or later fact is permitted.

If the discovery request rate-limits or errors, record `PAUSE_WINDOW` and its bounded code, make no
further provider call for that slot, and do not retry. The next scheduled slot remains governed by
the same frozen plan.

### 6.3 Decision-time evidence

For a selected mint, at slot end make at most one direct `DEXSCREENER` market-context request and,
if locally available, one direct `JUPITER` quote-impact request. The first must occur at least 60
seconds after the discovery call. A finite positive USD price with source timestamp no more than 60
seconds old is required for a valid unit. Liquidity, volume, and momentum have the 300-second
freshness rule; quote availability and price impact have the 60-second rule.

The mapper must capture only the Phase 10.5A allowlisted decision-time fields, availability code,
source category, source-relative identifier, source timestamp when available, and sanitized provider
name/operation/outcome. It must never store request URLs, endpoint names, raw bodies, headers,
symbols, pair labels, account facts, score/strategy values, or source payloads.

`quote.available` is true only when the direct quote result is successful and has a finite,
non-negative price-impact value. Convert a percent representation to basis points only by multiplying
by 10,000; otherwise record the defined missingness reason. Quote evidence is descriptive only and
does not create a hypothetical order or influence selection.

### 6.4 Later observations are labels only

For each valid unit, schedule exactly one direct `DEXSCREENER` best-pair request at each frozen
horizon. If the scheduler cannot start that request by its stated tolerance, do not call the
provider; record `MISSING` with a bounded window-expired reason. If it starts on time but returns
after the tolerance, record `OBSERVED_LATE`; a valid positive price may still produce a numeric
return. Invalid/missing/non-positive prices record `INVALID` or `MISSING` and no return.

All later observation data must reside under a `laterObservations` object, never under
`decisionTime`. No later record may be available to the selection, provider budget, deduplication,
partition, duration, or stop-condition decision for its own or any later slot, except its own fixed
missingness accounting.

## 7. Archive Contract And Lifecycle

The permitted root is exactly:

```text
data/archive/phase10.6a/exploratory-cohort-v2-YYYYMMDD-HHmmZ/
```

Only these finalized files may remain in the root:

```text
cohort-manifest.v1.json
units.v1.ndjson
source-inventory.v1.json
collection-summary.v1.json
```

`cohort-manifest.v1.json` must include the protocol path/SHA, launch identity, fixed settings,
archive version, all attempted slot states, selected-unit IDs, counters, budget ledger, concentration
ledger, data-quality actions, final state, and SHA-256 hashes of the other finalized files. It must
state `executionDisabled=true`, all execution counters zero, and all strategy/default values
unchanged.

`units.v1.ndjson` must use a canonical lexical `unitId` order after finalization. Each row contains
only the frozen decision-time schema, selection/hash inputs, partition, later observations, and safe
missingness/provenance. It must not contain a candidate recommendation, score, strategy decision,
wallet, transaction, raw payload, request/header, or credential field.

`source-inventory.v1.json` must contain only aggregate, sanitized provider provenance: allowed
provider/capability IDs, category, request count, attempt count, bounded outcome code, timestamp,
latency bucket, and source hash. It must not contain URLs, hostnames, endpoint paths, raw response
data, or configuration values.

`collection-summary.v1.json` must contain final counts, labels/missingness, partitions, dates,
concentration, provider-budget use, stop/incomplete reasons, safety counters, and a literal
non-authorizing outcome. It must not compute target/stop, P/L, MFE/MAE, strategy performance, or
hypothesis result.

Before creating any active artifact, the collector must acquire an exclusive, archive-root-local
`collection.lock` containing only the safe root and slot identity. A concurrent first opener may
create the directory but must fail on the `wx` lock before it can write an initial artifact. An
existing lock, a different process holding the root, or a previously recorded slot must fail closed
before any provider call.
During collection, each write must use a bounded temporary file in the same archive root, validate
the complete target schema, atomically replace only the active artifact, and delete its temporary
file. Finalization canonicalizes, hashes, removes the short-lived lock, and makes the four finalized
files immutable: any future write, append, resume, overwrite, archive-root reuse, or duplicate-slot
use must fail closed. A crash/interruption records `COHORT_INCOMPLETE`; it never triggers a slot
retry or unit replacement.

## 8. Data-Quality And Stop Rules

The collector must implement the frozen V2 actions exactly:

| Condition                                                                                                               | Required action                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Protocol hash, launch identity, manifest schema, safe-content, clock order, or archive-hash mismatch                    | Stop before/at detection with `EXPLORATORY_COHORT_DATA_QUALITY_STOP`; finalize a bounded stopped archive when a root exists. |
| Discovery/market/quote/later provider rate limit or provider error                                                      | Record the appropriate availability/outcome, pause only the affected slot, make no retry, and do not use a fallback.         |
| Any provider category budget exhausted                                                                                  | Stop with `EXPLORATORY_COHORT_PROVIDER_BUDGET_EXHAUSTED`; finalize without further calls.                                    |
| Required anchor stale/missing rate exceeds 25% after 24 valid units                                                     | Stop with `COHORT_STOPPED_DATA_QUALITY`; do not relax price/freshness requirements.                                          |
| Optional fact unavailable/stale/unsupported                                                                             | Record the exact availability code and continue only if required anchor facts remain valid.                                  |
| Duplicate mint, duplicate slot, invalid identity, insufficient slots, split/date/concentration failure, or interruption | Retain safe reason and finalize `COHORT_INCOMPLETE`; no replacement or extension beyond 168 slots.                           |

No action may increase a budget, change a provider, retry a call, widen a window, lower a threshold,
extend the slot/date maximum, or create a new candidate to repair an incomplete cohort.

## 9. Bounded Results And Downstream Authority

The runtime may emit only one of these collection outcomes:

```text
COLLECTING
COHORT_COMPLETE
COHORT_INCOMPLETE
COHORT_STOPPED_DATA_QUALITY
HUMAN_REVIEW_REQUIRED
```

Every result must include this literal boundary:

```text
No strategy, collection expansion, Phase 10.6B analysis, Phase 10.6C validation, PAPER execution,
default change, promotion, order, fill, position, wallet action, signing, or submission is authorized.
```

`COHORT_COMPLETE` means only that the fixed observational archive is ready to be preserved and may
be considered by a separately approved, archive-only Phase 10.6B analysis checklist. It does not
say a hypothesis is defensible or authorize an additional cohort. `COHORT_INCOMPLETE` and
`COHORT_STOPPED_DATA_QUALITY` are valid research outcomes and do not permit collection changes.

## 10. Phase 10.6A Implementation Sequence

During implementation, update this checklist immediately after each completed task with a checked
box and a concise verification note. Do not start a live run merely because implementation tasks are
complete.

### A. Freeze authority and collection configuration

- [x] Add this checklist to the roadmap, decision log, planning inputs, and structure inventory.
      Note: V2 planning and implementation handoffs now identify the immutable V1 supersession.
- [x] Add a source-controlled Phase 10.6A launch-record schema that binds one archive root, UTC
      start, protocol path/SHA, Phase 10.5A validation fingerprint, and explicit user authorization
      reference without credentials at the fixed `docs/research-launches/` path.
      Note: added `phase10.6a-exploratory-cohort-v2.schema.json`; no launch record exists yet.
- [x] Implement strict collection config parsing and reject every non-allowlisted option before any
      provider, filesystem, or archive action.
      Note: the CLI accepts only V2, one `YYYYMMDD-0000Z` first-run root, one `--once`, and format.
- [x] Implement the protocol guard and pin the exact V2 protocol SHA, source fingerprints, V2
      defaults, immutable V1 supersession record, and non-authorizing authority boundary.
      Note: hash and strict protocol-schema validation occur before launch/archive/provider work.

### B. Build the isolated observation collector

- [x] Add the new archive-only collector module, narrow direct provider gateway, injected clock,
      deterministic selection/partition services, evidence mapper, archive service, and formatter.
      Note: one external invocation owns one slot from end-minus-60 seconds through +60 minutes.
- [x] Prove the module has no database/repository/session/scanner/strategy/risk/paper/terminal/
      watchlist/dashboard imports and no wallet/signing/submission dependency.
      Note: static no-import tests cover the runner; the gateway constructs direct adapters only.
- [x] Implement exact provider-category caps, cross-category actual-provider pacing, timeout,
      concurrency, no-retry, no-fallback, and safe missingness behavior.
      Note: V2 168/168/168/672 caps, 60-second actual-provider pacing, and no retries/fallbacks are fixed.
- [x] Implement the fixed quote-only probe and prove it cannot construct, sign, submit, or persist a
      transaction or raw quote.
      Note: it uses the direct JUPITER quote adapter with fixed SOL amount/slippage and normal
      adapter route resolution; no generic provider router or fallback is constructed.

### C. Implement archive lifecycle and quality stops

- [x] Implement new-root preflight, exclusive cross-process archive lock, atomic active-artifact
      writes, canonical finalization, hashes, immutable closeout, duplicate-root/slot refusal, and
      no-resume-after-finalization behavior.
      Note: the `wx` lock is acquired before first-root artifacts are written; a concurrent first
      opener fails without overwriting them, and a stale lock finalizes as `COHORT_INCOMPLETE` before
      a new provider call, including a crash between lock acquisition and initial artifacts.
- [x] Implement safe slot ledger, canonical unit rows, source inventory, collection summary, and
      strict omission of raw provider/configuration/credential data.
      Note: source records have fixed `attemptCount=1` and a SHA-256 of sanitized provenance only;
      final summaries include partition/date/concentration, later-label/missingness, provider-budget,
      stop, and zero-safety aggregates. Archive writers reject credential/network/raw-payload-shaped
      text and retain safe aggregates only.
- [x] Implement all required/optional missingness, freshness, interruption, budget, rate-limit,
      provider-error, stale-anchor, split, date, concentration, and incomplete/stop outcomes.
      Note: missed horizons make no request; fixed-cap exhaustion stops and finalizes the archive.
- [x] Keep later observation labels structurally and temporally separate from decision-time facts.
      Note: each unit stores labels only under `laterObservations` after decision-time evidence.

### D. Add tests and pre-live verification

- [x] Add config/launch/protocol tests for scope, duplicate flags, unsafe options, V2-only path,
      archive conflict, source inconsistency, and no-provider preflight failure.
      Note: local fake tests pass with no live adapter invocation.
- [x] Add deterministic fake-clock/fake-provider tests for every slot, selection, partition, quote,
      horizon, missingness, pacing, budget, stop, and incomplete branch.
      Note: tests cover exact `discoverTokens(100)`, four horizons, expired windows, cap stop, locks, and stale crash closeout.
- [x] Add archive contract tests for canonical ordering, atomic finalization, hashes, immutability,
      cross-process lock and duplicate-slot refusal, no raw values, and source/archive mtime
      preservation outside the approved new root.
      Note: temp-root tests confirm first-root concurrent-lock refusal, stale no-artifact crash
      closeout, active/final artifact lifecycle, source hash/attempt fields, final aggregate summary
      schema, and no provider call on lock cases.
- [x] Add static/spy tests for zero database, session, scanner, strategy, risk, paper, wallet,
      signing, submission, order, fill, position, and fallback/retry behavior.
      Note: static source coverage rejects forbidden orchestration imports and router construction.
- [x] Rerun `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm check:secrets`, and
      `pnpm verify` after the evidence-fidelity closeout patch. Do not run a live provider command
      during development verification.
      Note: `corepack pnpm verify` passed 2026-08-19 after Phase 10.6A.1: backend 114 files / 386
      tests, frontend 2 / 4, shared 4 / 13; no live provider command was run.

### E. Separate live-run authorization and closeout

- [x] Update handoff docs with the implemented command, protocol/launch schemas, source hashes,
      archive contract, exact safety counts, and verification output.
      Note: roadmap, decision log, planning inputs, and structure inventory identify the implementation.
- [x] Present the completed implementation checklist and test evidence to the user. Obtain explicit
      authorization for one named archive root before the first provider call.
      Note: implementation completion does not supply a root or live-run authorization.
- [x] Before a live run, create and validate the one source-controlled launch record; verify the
      planned root is new and no active/archived database, session, strategy, paper, or wallet path
      can be reached.
      Note: `phase10.6a-exploratory-cohort-v2-20260821-0000Z.json` passed the narrow local
      config/launch/protocol guard on 2026-08-19. The approved root was absent; validation made zero
      provider calls, database reads, or filesystem writes. The external scheduler runbook is prepared
      but no task has been armed or run.
- [x] Implement Phase 10.6A.1 before scheduler arming to ledger missed external invocations as
      canonical zero-request availability rows, authenticate active evidence, use terminal slot index
      finalization, and provide the one strict provider-free closeout path.
      Note: V2 protocol bytes and normal collection values remain unchanged; no scheduler or collection
      was started by implementation.
- [x] After any authorized collection ends, record only its archive path, hashes, bounded outcome,
      exact counts, and safety facts. Do not analyze it or begin Phase 10.6B without separate approval.
      Note: `data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z` finalized
      `COHORT_COMPLETE` on 2026-08-29 with 96 valid units from 100 attempted slots, 382 on-time and
      2 missing later observations, zero database/execution safety counters, and immutable final file
      hashes recorded in the Phase 10.6B checklist. The collector task is disabled; no analysis command
      has been implemented or run, and the scheduled provider-free confirmation remains separate.

## 11. Test And Acceptance Gates

Phase 10.6A implementation may be presented for live-run approval only when all of the following
are true:

```text
frozen Phase 10.6A V2 protocol SHA and V1 supersession identity validated exactly = yes
new isolated collector has no database/session/strategy/execution imports = yes
provider allowlist = DEXSCREENER discovery/market/later plus direct JUPITER quote only
per-category and actual-provider pacing/budgets/retries/fallbacks fixed = yes
population/selection/split use score, risk, strategy, or later facts = no
valid unit required-anchor and optional-fact behavior fixed = yes
3m/5m/15m/60m labels are separate from decision-time facts = yes
archive root/file schemas/canonical hashes/immutable finalization fixed = yes
raw payloads, URLs, headers, credentials, database data, and execution data stored = no
unit, adversarial, deterministic-clock, archive, and no-side-effect tests pass = yes
format/lint/typecheck/test/secret scan/verify pass = yes
provider/RPC/HTTP calls during development verification = 0
database reads/writes during collector runtime = 0 / 0
orders/fills/positions/wallet/signing/submission during collector runtime = 0 / 0 / 0 / 0 / 0 / 0
explicit user authorization for the named archive root before first call = required
```

The expected implementation success condition is readiness for a separate user-authorized,
observational collection. It is not an authorization to run immediately and not a reason to revisit
F65E@v1, alter score thresholds, widen a profile, or enable PAPER execution.

## 12. Explicit Deferrals

Phase 10.6A does not include:

- Phase 10.6B archive analysis, hypothesis attribution, feature ranking, candidate
  pre-registration, or any `PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL` result;
- Phase 10.6C shadow validation, Phase 10.7 promotion review, Phase 10.8A Paper Operations
  Dashboard, a paper pilot, live readiness, or live trading;
- an additional collection universe, F65E@v1 continuation, score profile/default/threshold/exit
  change, quote-budget expansion, fallback provider, retry policy, shorter polling loop, or
  collection extension; and
- PAPER BUY/SELL, transactions, orders, fills, positions, balances, P/L, wallet access, signing,
  submission, or execution controls.

The next action after completing implementation is to request explicit authorization for one named
archive root. The next action after a completed or incomplete collection is to preserve the archive
unchanged until a separate Phase 10.6B checklist is approved.
