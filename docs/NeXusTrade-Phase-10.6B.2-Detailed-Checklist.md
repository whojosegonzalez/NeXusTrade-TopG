# NeXusTrade Phase 10.6B.2 Detailed Implementation Checklist

## Measurement-Only Protocol Design And Static Review

Status: Planning checklist created on 2026-09-04 after the completed Phase 10.6B.1 real-archive audit
returned "MEASUREMENT_REVISION_READY_FOR_SEPARATE_PROTOCOL_REVIEW". The approved local-only
implementation is complete: it added one pinned V3 draft and its isolated static validator. The one
separately approved real V3 stdout-only static validation passed on 2026-09-04 with
`MEASUREMENT_PROTOCOL_DRAFT_READY_FOR_SEPARATE_COLLECTION_CHECKLIST_REVIEW`. This document continues
to authorize no provider call, archive read, collection, scheduler, database/runtime action, strategy
change, PAPER action, wallet action, signing, submission, order, fill, position, or live-trading action.

## 1. Purpose And Strict Question

Phase 10.6B.2 must answer only this design question:

```text
Can one versioned, measurement-only successor protocol be specified concretely enough to preserve the
V2 study's safety and outcome-blindness while testing the three replicated decision-time measurement
limitations found by the completed Phase 10.6B.1 audit?
```

It is not a strategy redesign, signal search, provider experiment, profitability study, entry-rule
selection, target/stop study, candidate pre-registration, Phase 10.6C design, or collection approval.
It must not use future collection results to choose its design.

The only allowed implementation result is exactly one of:

```text
MEASUREMENT_PROTOCOL_DRAFT_READY_FOR_SEPARATE_COLLECTION_CHECKLIST_REVIEW
NO_DEFENSIBLE_MEASUREMENT_PROTOCOL_DRAFT
HUMAN_REVIEW_REQUIRED
```

The ready result means only that a human-reviewed draft protocol and its static validator may be
presented for a separate collection-checklist decision. It does not authorize collection, a collector
implementation, named archive root, provider call, scheduler, Phase 10.6C, strategy, PAPER, wallet,
signing, submission, order, fill, position, or promotion.

## 2. Fixed Evidence Basis And Label Boundary

The design may cite only this completed, bounded record. It must not reopen, parse, or aggregate the
V2 archive during planning or implementation:

```text
archive root
data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z

Phase 10.6B.1 content fingerprint
843d1d27aee452f7fcccb000128fec10a38d0fbe80652fc9eb50511a9447b486

cohort-manifest.v1.json     0d462555a476cbec4c983d259f6ea3c96a3ef65486a9de7484b65fb2b690f48b
units.v1.ndjson             feb8515e0adf50ac86660bbfd378133b45303ed9a4ef57e0d0d73536f0542a9c
source-inventory.v1.json    766b8315366b13372fa33218b3b483e359055d88a9f7d5f53ff8de560866212a
collection-summary.v1.json  a6bab14209e5c0d0a16a76617866144e1349d862d7446751d699c8b890fb2940
V2 protocol SHA-256         2662a4cbc1d3458d55b64f9c4cc826561aad1cb6f6b5faf11079194377f5a0ed
```

The only evidence facts a V3 draft may name are these aggregate decision-time signatures:

| Field        |       Discovery |      Validation | Signature                                          | UTC-date support |
| ------------ | --------------: | --------------: | -------------------------------------------------- | ---------------: |
| LIQUIDITY    | 26/46 available | 21/50 available | UNAVAILABLE_AT_ANCHOR / MARKET_CONTEXT / BEST_PAIR |                9 |
| MOMENTUM_5M  |  0/46 available |  0/50 available | UNSUPPORTED / MARKET_CONTEXT / BEST_PAIR           |                9 |
| MOMENTUM_15M |  0/46 available |  0/50 available | UNSUPPORTED / MARKET_CONTEXT / BEST_PAIR           |                9 |

No later observation, return, positive/negative label, target, stop, P/L, MFE, MAE, score, risk
decision, candidate, mint, unit ID, slot, raw timestamp, raw source hash, provider payload, URL, or
credential-like fact may appear in the V3 draft, validator input, tests, output, or decision rule.

## 3. Non-Negotiable Safety And Authority Boundary

- Zero external/provider/RPC/HTTP calls; zero database, cache, repository, session, scanner, runtime,
  dashboard, or filesystem writes outside ordinary source-controlled documentation and code changes.
  The eventual validator may read only its one named draft protocol source and fixed local constants;
  it outputs bounded Markdown or JSON only to stdout.
- No collector, gateway, provider adapter, provider registry/router, generic runtime, scheduler,
  watchlist, strategy, risk, PAPER, wallet, transaction, order, fill, position, or database module may
  be imported, constructed, modified, or invoked. The existing V2 collector and immutable archive are
  not modified or reused for a new run.
- BUY=90 / WATCH=70 remains unchanged. F65E@v1 remains closed. No score, attribution, risk fact,
  target, stop, provider default, one-/two-minute monitoring, or strategy default changes are allowed.
- A successor protocol must be measurement-only. It may not add a BUY/WATCH/SKIP predicate, candidate
  rule, later-label selection input, performance gate, profitability claim, transaction behavior, or
  promotion criterion.
- No provider expansion, fallback, router, proxy, generic endpoint, raw payload retention, API-key
  requirement, retry, dynamic budget, or hidden scheduler is permitted. If a future design cannot be
  concrete within an explicitly approved direct-provider scope, it must return no-draft or human-review;
  it must not invent a new provider surface.
- The 10.6B.1 result identifies measurement objectives only. It does not determine a technical remedy,
  provider request shape, cadence, budget, collection population, observation horizon, collection size,
  or success claim. Each such value must be fixed before a protocol-draft-ready result.

## 4. Required Successor Protocol Draft Contract

If separately approved for implementation, this phase may add exactly one versioned draft at:

```text
docs/research-protocols/phase10.6a-exploratory-cohort.v3.json
```

It must use contractVersion "3", protocolId "EXPLORATORY_COHORT_MEASUREMENT@v3", and authorityStatus
"NOT_AUTHORIZED_FOR_COLLECTION". It must supersede the exact V2 path and SHA above without changing or
overwriting V2. The JSON must be strict with no unbounded additional properties; every
collection-affecting value must be explicit, finite, and immutable in the file.

| Required section               | Required fixed content                                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sourceEvidence                 | Exact Phase 10.6B.1 fingerprint, V2 root/identity, and only the three aggregate signatures above.                                                                                           |
| purpose                        | OUTCOME_BLIND_MEASUREMENT_AVAILABILITY; no strategy validation, profitability claim, candidate, or promotion.                                                                               |
| populationAndAnchor            | Concrete universe, canonical identity, technical-validity anchor, sampling seed, slot/deduplication rule, and outcome-blind exclusions.                                                     |
| measurementObjectives          | Exactly the three field IDs; each has decision-time path, type, eight-code missingness enum, provenance, timestamp/freshness rule, and no-selection-input statement.                        |
| measurementMethod              | One exact decision-time method per objective, explicitly direct observation or fixed local calculation. A local calculation can use only pre-anchor facts declared in the draft.            |
| providerPlan                   | Existing approved direct category/capability mapping, request shape, per-minute/cohort cap, concurrency, timeout, retry count 0, fallback PROHIBITED, and raw-payload retention PROHIBITED. |
| collectionPlan                 | Fixed cadence, slot count, planned/minimum units, partitions, date/concentration ceilings, source inventory, archive grammar, retention, and no catch-up/replacement rule.                  |
| dataQualityAndMeasurementGates | Fixed 90%-per-partition availability calculation, date support, provenance consistency, freshness, missingness, stop condition, and bounded insufficiency result.                           |
| outcomeBoundary                | Later observations are explicitly ABSENT or labels-only; neither form can be a selection input, success predicate, or protocol mutation trigger.                                            |
| safety and downstreamAuthority | Literal zero execution state, unchanged BUY/WATCH/F65E, and separate validation/collection/analysis gates.                                                                                  |

The draft must not delete a deficient field, change a missingness code's meaning, loosen the 90%
coverage gate, substitute a strategy proxy, or use a different result window to call V2 evidence
adequate. If a field cannot be measured under the fixed safety boundary, the protocol must state that
explicitly and choose the no-draft or human-review result.

## 5. Measurement Semantics And Pre-Registration Rules

For each objective, a draft must pre-register:

1. Exact decision-time timestamp and maximum source-to-anchor age.
2. Exact source category and source identifier, with no inferred provenance.
3. Exact finite value schema, unit/sign/nullability, and the V2 availability enum.
4. Exact direct-observation or local-calculation formula. A calculation declares every pre-anchor
   input, timestamp/freshness, and absent-component rule; post-anchor facts and labels are prohibited.
5. Fixed request count/cap/concurrency/timeout/retry/fallback behavior. Undocumented defaults are not
   permitted.
6. Aggregate-only archive evidence for availability, provenance, date support, partition coverage, and
   data-quality stops; raw payloads and credentials are prohibited.
7. Fixed success, insufficiency, and stop outcomes. None may mutate the protocol while running,
   promote a strategy, or authorize Phase 10.6C.

The draft must state literally:

```text
V3 measurement availability can validate only a data-collection capability.
It cannot validate a strategy, reproduce a return effect, create a candidate, or promote trading.
```

## 6. Planned Static Validator And CLI Contract

Only after separate implementation approval may this phase add one isolated local validator:

```text
pnpm research:measurement-protocol:validate --
  --protocol=docs/research-protocols/phase10.6a-exploratory-cohort.v3.json
```

It may read the named source-controlled draft and hard-pinned constants only. It makes zero
provider/RPC/HTTP calls, database/runtime/session accesses, archive reads/writes, scheduler changes,
or execution actions. It emits one bounded stdout document and no files.

Supported arguments are exactly one --protocol=<repository-relative-path>, optional exactly-once
--format=markdown|json, and optional exactly-once --once. It rejects archive, output, write, save,
environment, provider, HTTP, URL, database, runtime, scanner, strategy, risk, score, threshold,
target, stop, monitor, scheduler, wallet, signing, submission, PAPER, live, execution, order, fill,
position, balance, include, phase, cohort, and generic configuration options.

Public fail-closed codes:

```text
MEASUREMENT_PROTOCOL_INVALID_SCOPE
MEASUREMENT_PROTOCOL_UNSUPPORTED_DRAFT
MEASUREMENT_PROTOCOL_SOURCE_INCONSISTENCY
```

The only positive status is
MEASUREMENT_PROTOCOL_DRAFT_READY_FOR_SEPARATE_COLLECTION_CHECKLIST_REVIEW. Validator success
authorizes neither provider use, collector implementation, collection, Phase 10.6C, PAPER, nor
execution.

## 7. Planned Isolation, Tests, And Verification

The allowed implementation directory is limited to:

```text
backend/src/research-measurement-protocol/
backend/src/scripts/research-measurement-protocol-validate.ts
```

Root and backend package.json may add only the named validation script. No existing collection,
provider, database, runtime, scheduler, strategy, PAPER, dashboard, wallet, or execution source may
be modified.

Required synthetic-only tests:

1. Exact parser acceptance plus duplicate/forbidden-option rejection before a source read.
2. Exact V3 path, strict JSON schema, version, V2/B.1 source evidence, and no production override.
3. Rejection of omitted/dynamic population, anchor, method, cap, retry/fallback, freshness, quality,
   archive, or downstream-authority values.
4. Rejection of later-label selection input, strategy/candidate/return/target/stop/PAPER/wallet/
   execution content, provider expansion, raw-payload retention, fallback, retry, or gate weakening.
5. One fully concrete passing synthetic draft, deterministic Markdown/JSON, and zero-side-effect facts.
6. Static dependency tests proving no collector/gateway/provider/database/runtime/strategy/PAPER/
   wallet/execution imports and no file-write API.
7. Canonical JSON determinism with generatedAt omitted and contentFingerprint blanked from the
   SHA-256 preimage, plus secret-scan coverage.

Required verification before review:

```text
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm --filter @nexustrade/backend exec vitest run src/research-measurement-protocol/MeasurementProtocolValidator.test.ts
corepack pnpm check:secrets
```

Do not validate a real V3 draft during implementation. A separate approval is required for that
stdout-only static validation, and a successful result still cannot authorize collection.

## 8. Implementation Sequence

Update this checklist immediately after each completed task with a checked box and concise note.
Planning and implementation approval are separate; neither authorizes real static validation or any
collection action.

### A. Freeze the protocol-design boundary

- [x] Record the Phase 10.6B.1 result and create this detailed planning checklist.
      Note: only three bounded availability signatures are an allowed evidence basis; strategy,
      label, execution, and collection authority remain default-deny.
- [x] Define strict V3 draft enums, schema, source-evidence pin, canonical fingerprint, bounded
      static-validation statuses, and error contract.
      Note: the isolated validator pins V3 bytes, all Phase 10.6B.1/V2 identities, the three exact
      aggregate signatures, canonical JSON excluding `generatedAt` with `contentFingerprint` blanked,
      and only the three documented public fail-closed codes.
- [x] Decide and pre-register one exact method for every objective, or return no-draft/human-review.
      Note: LIQUIDITY is one direct `MARKET_CONTEXT/BEST_PAIR` observation at anchor; each momentum
      fact is one fixed local return from the four pre-anchor `BEST_PAIR.priceUsd` snapshots at
      -15/-10/-5/0 minutes. All calls remain future-only, direct DEXSCREENER, fixed-cap, no-retry,
      no-fallback observations and are not selection inputs.

### B. Create a strictly static measurement-only draft path

- [x] Add only the V3 draft and isolated validator after separate implementation approval; do not
      modify a collector or provider adapter.
      Note: added the fixed V3 source, `research-measurement-protocol` static-only code, one wrapper,
      and one named package command. No collection, adapter, gateway, scheduler, archive, or runtime
      source was changed.
- [x] Enforce concrete outcome-blind population, timing, fact semantics, provider budget, missingness,
      archive, quality, safety, and downstream sections.
      Note: strict schemas and semantic checks require all fixed V3 values, including four source-time
      snapshots, 168/672 caps, 90% per-objective/per-partition gates, immutable retention, and every
      separate downstream approval gate.
- [x] Enforce that no measurement field or value becomes a candidate, score, risk, strategy, or later
      label predicate.
      Note: the source fixes descriptive-only field semantics, declares no labels or later observations,
      and rejects non-false objective `selectionInput` values.
- [x] Emit deterministic stdout-only Markdown/JSON with literal zero counters and a separate-collection
      checklist boundary.
      Note: static results report zero provider/HTTP, archive, database, filesystem-write, runtime,
      scheduler, session, and execution counters; output remains non-authorizing.

### C. Prove the static boundary

- [x] Add temporary synthetic draft fixtures only; do not read a real archive or V3 draft.
      Note: the five-test suite constructs complete in-memory V3-shaped fixtures with injected expected
      hashes. It does not instantiate the production service or read the source-controlled V3 draft.
- [x] Add schema, source-evidence, provider-boundary, missingness, gate, forbidden-content, isolation,
      determinism, bounded-disclosure, and zero-side-effect tests.
      Note: synthetic checks cover exact arguments, strict structure, source inconsistency, complete
      objective methods, no provider-expansion/retry/authority relaxation, no write APIs or prohibited
      imports, deterministic fingerprinting, stdout safety facts, and zero `fetch` calls.
- [x] Run the five focused verification commands without provider calls, archive access, or real-draft
      static validation.
      Note: on 2026-09-04, `format:check`, `lint`, `typecheck`, the focused five-test Vitest command,
      and `check:secrets` all passed. The real V3 CLI command was deliberately not run.

### D. Separate review and future authority

- [x] Present V3 bytes, source-evidence pins, validator command, and all collection-affecting values
      for separate explicit approval before one real static validation.
      Note: after source review and commit, explicit approval was supplied for only the fixed V3 command
      on 2026-09-04; it did not authorize any downstream collection or execution action.
- [x] Run only the separately approved stdout-only static validation. Do not create a collector,
      scheduler, archive root, or provider call from the result.
      Note: `corepack pnpm research:measurement-protocol:validate --
--protocol=docs/research-protocols/phase10.6a-exploratory-cohort.v3.json --format=markdown`
      returned `MEASUREMENT_PROTOCOL_DRAFT_READY_FOR_SEPARATE_COLLECTION_CHECKLIST_REVIEW` with
      fingerprint `b992982000ac2e0fb51cd7944a979adc0114f77a6845b3d36a3d88b9eab3e4e6` and literal zero
      provider/HTTP, archive, database, filesystem-write, runtime, scheduler, session, and execution
      counters.
- [ ] If static validation succeeds, require a separate V3 collection checklist, collector
      implementation approval, synthetic-only verification, named archive-root authorization, and
      external scheduler authorization before any new observation. Do not begin Phase 10.6C.

## 9. Acceptance Gates

```text
evidence input = only the fixed Phase 10.6B.1 aggregate measurement record
V2 archive access, provider/RPC/HTTP calls, database/runtime/session actions = 0 / 0 / 0
new collector/gateway/provider adapter/scheduler/execution surface = absent
provider expansion, retry, fallback, raw-payload retention = absent
later-label, candidate, strategy, score, risk, target, stop, P/L, or promotion input = absent
BUY=90 / WATCH=70, F65E@v1 closure, strategy defaults, PAPER disabled = unchanged
validator success authorizes collection, Phase 10.6C, PAPER, wallet, or promotion = no
```

A collection can be considered only after every separate authority gate in Section 8D. This phase is a
documentation and static-review step; it cannot move the project toward execution directly.
