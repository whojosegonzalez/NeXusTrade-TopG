# NeXusTrade Phase 10.5A Detailed Implementation Checklist

## Research Restart Criteria And Exploratory Cohort Design

Status: Implemented 2026-08-19. The protocol validator is local, stdout-only, and non-authorizing.
No market data was collected.

## 1. Purpose And Required Outcome

Phase 10.5A is a planning-only research restart gate after Phase 10.5's
`NO_STUDY_AUTHORIZED` result. It must define a broad, outcome-blind exploratory measurement protocol
that could later produce independent evidence. It must not revive the closed F65E@v1 study, invent a
successor profile, or use the seven Phase 9.29 labels to choose a new entry rule.

Its single required output is a source-controlled `ExploratoryCohortProtocolV1` design record with
this fixed authority state:

```text
NOT_AUTHORIZED_FOR_COLLECTION
```

The record must state that Phase 10.6A collection remains unavailable until the user separately
approves its detailed checklist and explicitly authorizes that collection. A completed Phase 10.5A
design is neither strategy validation nor profitability evidence, and it cannot authorize Phase
10.6B, Phase 10.6C, Phase 10.7, a PAPER pilot, or any execution action.

## 2. Non-Negotiable Safety Boundary

Every Phase 10.5A work item must preserve all of the following:

- Zero external/provider/RPC/HTTP calls, including browser, Vite, loopback-server, provider-smoke,
  provider-diagnostic, or quote-diagnostic calls.
- No scanner, risk, strategy, shadow-observation, watchlist-return, session, TerminalRunner, or
  market runtime command. The sole permitted Phase 10.5A CLI, if implemented, is the local static
  `research:protocol:validate` validator defined in Section 4.1; it collects no market observation.
- No active or archived database read/write, migration, pragma, reset, seed, or access to
  `data/nexus_paper.db*`.
- No runtime filesystem write: no report, archive, manifest, cache, checkpoint, generated dataset,
  session, or local data artifact. The only permitted change is a reviewed source-controlled protocol
  document; it is not runtime command output.
- No wallet loading, signing, transaction construction, submission, orders, fills, positions,
  balances, PAPER BUY/SELL, exposure, P/L, or execution control.
- No strategy/profile/default/threshold/exit/quote-budget/provider/monitoring change. The normal
  research baseline remains BUY=90 / WATCH=70 and PAPER execution remains disabled.
- No continuation of unchanged F65E@v1, no score-band widening/lowering, no one-/two-minute
  monitoring change, and no collection under this phase.
- No API key, authorization header, environment value, private URL, raw provider payload, or
  credential-shaped text in the protocol, checklist, examples, or output.
- No hypothesis generation, feature ranking, predicate search, counterfactual recommendation,
  promotion decision, or authorization for a downstream phase.

The protocol may define future evaluation labels and later observation horizons only. Those labels
must never be collection eligibility, sampling, deduplication, split, exclusion, or selection inputs.

## 3. Locked Starting Evidence And Design Question

Phase 10.5A starts from the completed Phase 10.4/10.5 evidence identity:

```text
ResearchBriefV1 fingerprint
  5fb59e2bf4472ea4da2a516d1298398491b812d1a3ae811d745aa46d5ee308c7

ResearchReviewGateV1 fingerprint
  2846a8509f523104417e460d0bc0a6812d161f393ade666b73faea5caa19828b

Phase 10.5 outcome
  NO_STUDY_AUTHORIZED

Phase 9.29 conclusion
  NO_DEFENSIBLE_HYPOTHESIS
```

The fixed design question is:

```text
Can a broad, outcome-blind observational cohort gather enough independent decision-time evidence
to let a later archive-only review decide whether any distinct study is defensible?
```

The answer from Phase 10.5A is only whether the protocol is complete and safe to consider for a
separate collection proposal. It is never whether a strategy should enter, BUY, WATCH, skip, promote,
or execute.

## 4. Required `ExploratoryCohortProtocolV1` Contract

If Phase 10.5A is implemented, create exactly one human-authored, source-controlled protocol under
`docs/research-protocols/`, such as:

```text
docs/research-protocols/phase10.6a-exploratory-cohort.v1.json
```

It must be JSON validated by one strict, versioned schema. Manual review supplements but never
replaces deterministic validation. It is planning input only; no command may generate, overwrite, or
modify it. Unknown fields, missing required values, placeholder values such as `TBD`, credential-like
text, absolute paths, URLs, and runtime options must invalidate it.

`ExploratoryCohortProtocolV1` must contain every field below:

```text
contractVersion
protocolId                         # named/versioned; never F65E@v1
authorityStatus                    # literal NOT_AUTHORIZED_FOR_COLLECTION
sourceEvidence                     # both Phase 10.4/10.5 fingerprints and relative citations
purpose                            # observational evidence only; not strategy validation
population                         # outcome-blind inclusion and objective exclusion rules
samplingPlan                       # deterministic, bounded, outcome-blind selection method
independencePlan                   # mint/window/date targets and concentration limits
deduplicationPlan                  # canonical mint and market-window rules
decisionTimeSchema                 # allowlisted fields, provenance, timestamps, missingness
providerBudgetPlan                 # per-provider request/concurrency/backoff caps and no-secret rule
observationPlan                    # later horizons/labels, timestamp basis, missing-result handling
splitPlan                           # deterministic discovery/validation assignment before collection
dataQualityStops                   # fixed stop/abort and incomplete-cohort conditions
archiveContract                    # future Phase 10.6A artifact names and relative paths only
analysisBoundary                   # what Phase 10.6B may inspect, never a conclusion or predicate
prohibitedChanges                  # defaults/execution/providers/monitoring remain unchanged
downstreamAuthority                # Phase 10.6A/10.6B/10.6C gates remain separate
```

All field values that would alter selection, independence, cost, freshness, duration, or a later
interpretation must be fixed concrete values. They cannot be prose placeholders, environment
variables, command-line overrides, or chosen after any future observation is seen.

### 4.1 Required local protocol validator

Phase 10.5A must implement one local, stdout-only validation surface:

```text
pnpm research:protocol:validate -- \
  --protocol=docs/research-protocols/phase10.6a-exploratory-cohort.v1.json \
  --format=markdown
```

The validator accepts exactly one repository-relative protocol path from the approved
`docs/research-protocols/` catalog, optional exactly-once `--format=markdown|json`, and optional
exactly-once compatibility `--once`. It rejects duplicate or traversal-shaped paths, URLs, output/
write options, database/runtime/provider/environment/session/strategy/score/threshold/observation/
monitor/wallet/sign/submit/paper/live/order/fill/position/balance/HTTP options, and every protocol
value outside the strict schema.

It reads only the selected protocol document and the already source-controlled Phase 10.4/10.5
identity constants needed to verify its citations. It makes zero provider/RPC/HTTP calls, database
reads or writes, runtime actions, filesystem writes, sessions, orders, fills, positions, wallet
actions, signing, or submission. It writes one deterministic Markdown or JSON validation result to
standard output only. `ProtocolValidationV1` must expose the protocol SHA-256, audit-only
`generatedAt`, and `contentFingerprint`; canonical validation content omits `generatedAt` and uses
an empty `contentFingerprint` field in its own hash preimage. Its only statuses are:

```text
PROTOCOL_READY_FOR_SEPARATE_COLLECTION_APPROVAL
PROTOCOL_INVALID
HUMAN_REVIEW_REQUIRED
```

`PROTOCOL_READY_FOR_SEPARATE_COLLECTION_APPROVAL` means only that the design is mechanically
complete and may be submitted for a separate Phase 10.6A checklist/approval. It does not authorize
collection, Phase 10.6B, Phase 10.6C, strategy/default changes, PAPER execution, or promotion.

Invalid input must fail closed before output with exactly one bounded public code:

```text
RESEARCH_PROTOCOL_INVALID_SCOPE
RESEARCH_PROTOCOL_INVALID_RECORD
RESEARCH_PROTOCOL_SOURCE_INCONSISTENCY
```

## 5. Locked V1 Defaults

The first `ExploratoryCohortProtocolV1` must use exactly these values. Any change requires a new
versioned protocol path, updated checklist/decision documentation, validator expectations, and
separate approval; it must not be changed while or after a cohort is collected.

| Design area                     | Locked V1 default                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol identity               | `EXPLORATORY_COHORT@v1`; authority `NOT_AUTHORIZED_FOR_COLLECTION`.                                                                                                                                                                                                                                                                                                                                |
| Discovery universe              | All canonical Solana mint identifiers first emitted by the existing, unmodified discovery universe during an enrollment slot. No score, risk, strategy decision, BUY/WATCH/SKIP classification, later outcome, or F65E fact participates.                                                                                                                                                          |
| Technical-validity anchor       | The earliest source-received discovery event with a canonical base58 32-byte mint identifier, non-empty source-kind enum, and finite UTC receive timestamp. The future decision-time anchor is the slot-selection timestamp, not a later horizon.                                                                                                                                                  |
| Sampling seed and cadence       | Public non-secret seed `phase10.6a-exploratory-cohort.v1`; contiguous 2-hour UTC enrollment slots. At each slot end select the eligible mint with the lexicographically lowest SHA-256 of `seed                                                                                                                                                                                                    | canonicalMint | slotId`; select at most one unit per slot, with no post-slot backfill.                                                                                                            |
| Cohort size                     | Planned 96 units; minimum viable 72 units; no more than 168 attempted slots across 14 consecutive UTC dates. Fewer than 72 valid units is `INCOMPLETE_EXPLORATORY_COHORT`.                                                                                                                                                                                                                         |
| Windows and concentration       | Slot ID is `[UTC start, UTC start + 2 hours)`. Require at least 8 UTC dates; no canonical mint may repeat; no UTC date may contain more than 20% of valid units; no slot may contain more than one valid unit.                                                                                                                                                                                     |
| Decision-time fields            | The exact allowlist and missingness vocabulary in Section 5.1. Every field has value-or-missingness, availability, source kind, source-relative identifier, and source timestamp when available.                                                                                                                                                                                                   |
| Freshness                       | Price, quote availability, quote price impact: <=60 seconds old at anchor. Liquidity, 5-minute/1-hour volume, 5-minute/15-minute momentum: <=300 seconds old. A stale required value is recorded as `STALE_AT_ANCHOR`, never refreshed beyond the fixed budget.                                                                                                                                    |
| Provider categories and budgets | Only `DISCOVERY`, `MARKET_CONTEXT`, `QUOTE_IMPACT`, and `LATER_OBSERVATION`. Each: max 1 request/minute, concurrency 1, timeout 10 seconds, retry count 0, no backoff because retries are prohibited. Cohort caps: 1,000 discovery; 96 market-context; 96 quote-impact; 384 later-observation requests. No undeclared fallback provider.                                                           |
| Later observations              | Observe descriptive price snapshots at 3m +/-30s, 5m +/-30s, 15m +/-60s, and 60m +/-300s after anchor. Record numeric return when a valid snapshot exists; label only `OBSERVED_ON_TIME`, `OBSERVED_LATE`, `MISSING`, or `INVALID`. No target/stop label or trading result is declared.                                                                                                            |
| Discovery/validation split      | SHA-256 of `phase10.6a-exploratory-cohort.v1                                                                                                                                                                                                                                                                                                                                                       | canonicalMint | slotId`; even final hexadecimal digit = `DISCOVERY`, odd = `VALIDATION`. Require at least 32 valid units and 4 UTC dates in each partition; otherwise mark the cohort incomplete. |
| Archive contract                | Future root `data/archive/phase10.6a/exploratory-cohort-v1-YYYYMMDD-HHmmZ/`; fixed files `cohort-manifest.v1.json`, `units.v1.ndjson`, `source-inventory.v1.json`, and `collection-summary.v1.json`. All paths are archive-relative. Retain immutable archives indefinitely; never store raw provider payloads, headers, or credentials.                                                           |
| Data-quality stops              | Immediately stop for manifest-schema, secret-like-content, or clock-order violation. Pause the affected 2-hour slot after one upstream rate-limit/error event, record missingness, and do not retry. Stop the cohort if required-anchor stale/missing rate exceeds 25% after 24 valid units, or any provider budget is exhausted. Mark incomplete for size, split, date, or concentration failure. |

### 5.1 Exact decision-time and missingness schema

The V1 decision-time allowlist is exactly:

```text
unitId, canonicalMint, anchorAt, slotId, partition
discovery.sourceKind, discovery.firstObservedAt
market.assetAgeSeconds, market.priceUsd, market.liquidityUsd
market.volume5mUsd, market.volume1hUsd
market.momentum5mPct, market.momentum15mPct
quote.available, quote.priceImpactBps
risk.blockerCodes, attention.repeatedAttentionCount
```

Every field uses one of these availability/missingness codes:

```text
AVAILABLE_AT_ANCHOR
NOT_REQUESTED
UNAVAILABLE_AT_ANCHOR
STALE_AT_ANCHOR
BUDGET_EXHAUSTED
PROVIDER_ERROR
UNSUPPORTED
INVALID_VALUE
```

V1 types are fixed: `unitId`, `canonicalMint`, `slotId`, `partition`, `discovery.sourceKind`, and
`discovery.firstObservedAt` are non-empty strings; timestamps are ISO-8601 UTC strings;
`market.assetAgeSeconds` and `attention.repeatedAttentionCount` are non-negative integers; all other
market/quote facts are finite numbers; `quote.available` is boolean; and `risk.blockerCodes` is a
lexically sorted string array. Every field provenance uses one of exactly `DISCOVERY`,
`MARKET_CONTEXT`, `QUOTE_IMPACT`, or `LATER_OBSERVATION`, plus a relative source identifier and its
timestamp when available.

`risk.blockerCodes` and `attention.repeatedAttentionCount` are descriptive only. They cannot alter
population eligibility, sample selection, partition assignment, replacement, provider priority, or
future strategy behavior. Strategy scores, strategy decisions, score components, wallet/account
facts, raw payloads, and later observations are not V1 decision-time fields.

## 6. Population, Sampling, And Independence Requirements

### 6.1 Broad observational population

The future population must begin from an existing, unmodified discovery universe, not a strategy
decision. Its inclusion predicate may use only collection-time facts needed to identify and safely
record a discovered mint, such as a canonical mint address, first-observed timestamp, and declared
technical validity. It must not require or prefer:

- BUY, WATCH, SKIP, score, score component, threshold band, F65E classification, later label,
  return, MFE/MAE, price change, or target/stop state;
- a feature selected because it separates the current seven labels;
- a provider response chosen after inspecting a later result; or
- a wallet, account, transaction, balance, liquidity action, or execution state.

The protocol must enumerate every objective exclusion. Permitted exclusions are limited to malformed
or non-canonical identifiers, duplicate sampling units, unavailable required collection-time anchor
facts, and a predeclared technical/safety stop. A missing optional market fact is recorded as missing;
it must not silently exclude the unit.

### 6.2 Deterministic outcome-blind sampling

The protocol must freeze one deterministic selection method before collection. It must specify:

- the source universe and a collection-time anchor timestamp;
- a public non-secret protocol seed and hash/canonical-order procedure;
- a fixed sampling cadence or bounded intake quota that does not depend on score or later outcome;
- the maximum number of units per mint, market window, calendar date, and provider budget period;
- a finite planned cohort size and a minimum viable cohort size; and
- an `INCOMPLETE_EXPLORATORY_COHORT` outcome when the minimum cannot be reached without changing
  the frozen protocol.

No retry, replacement, quota refill, or sampling change may be triggered by a later label. A unit
lost to an objective technical stop is retained in the manifest with its reason; it is not replaced
unless the frozen sampling plan explicitly provides an outcome-blind replacement rule.

### 6.3 Independence and deduplication

The protocol must fix, before collection:

- a canonical mint identity and one observation unit per mint within the entire cohort unless an
  explicitly documented distinct market-window rule is justified without outcome evidence;
- market-window boundaries, timezone, calendar-date rule, and non-overlap requirement;
- minimum distinct windows and dates, maximum per-window and per-date share, and maximum
  concentration for any mint, provider-provenance class, or technical-exclusion class;
- the treatment of re-listed, wrapped, renamed, bridged, and unresolved mint identifiers; and
- the exact manifest fields that allow a later reviewer to recompute each concentration measure.

The design must prefer an incomplete cohort over relaxed deduplication or concentration limits. It
must never alter the normal BUY=90 / WATCH=70 strategy defaults to satisfy a cohort count.

## 7. Decision-Time Evidence And Later-Label Boundary

### 7.1 Allowlisted decision-time record

For every future accepted observational unit, the protocol must freeze an allowlisted
`ExploratoryDecisionTimeEvidenceV1` schema. Each field must carry its value or explicit missingness,
availability-at-anchor-time, source kind, source-relative provenance identifier, and source timestamp
when available. The allowlist may include only facts available at or before the anchor time:

```text
identity and anchor             canonical mint, unit id, anchor time, market-window id
discovery provenance            source kind, first-seen time, discovery availability/missingness
age and market facts            age, liquidity, volume, price, momentum, if available then
risk evidence                   recorded risk facts and blockers, descriptive only
quote/impact evidence           quote availability, freshness, price-impact evidence, descriptive only
provider provenance             source kind/status/category, request budget category, missingness
attention evidence              repeated-attention facts when already available at anchor time
strategy context                recorded score/decision only as descriptive context, never eligibility
```

The future schema must name each field, type, unit, allowable range, source kind, freshness rule,
and missingness code. It must not store raw headers, raw provider payloads, credentials, account
data, wallet data, or post-anchor observations in the decision-time object.

### 7.2 Quote freshness and missingness

The protocol must define fixed freshness thresholds separately for price, liquidity/volume, quote,
and price-impact evidence. A stale or unavailable field is recorded with a bounded missingness code,
not transformed into zero, inferred from a later value, or silently removed. The future collector may
not retry beyond its frozen provider budget merely to make a record complete.

### 7.3 Later observation labels

Later observations are evaluation-only. The protocol must fix their horizon list, due-time tolerance,
price/quote source preference, fallback behavior, and bounded label/missingness vocabulary before
collection. It must state conspicuously:

```text
Later outcomes and labels are not entry, inclusion, sampling, deduplication, exclusion, split,
replacement, or collection-control inputs.
```

The first exploratory cohort must not declare a target/stop profile or treat a later return as a
trading result. Phase 10.6B may use later labels only to assess evidence quality and whether a new,
materially distinct study is worth proposing.

## 8. Provider-Budget And Operational-Safety Design

Phase 10.5A must define a future provider budget plan without making a call. It must name only
approved provider categories and public configuration identifiers, never endpoints, keys, private
URLs, or headers. Before Phase 10.6A may be proposed, the protocol must freeze:

- maximum requests per provider per minute, collection window, and full cohort;
- maximum concurrency, retry count, exponential-backoff bounds, cooldown handling, and timeout;
- the priority order for required anchor facts versus optional descriptive enrichment;
- an explicit no-fallback rule when a missing fact would otherwise require an undeclared provider;
- per-provider pressure/missingness categories recorded in the future manifest; and
- hard provider-pressure stop conditions and the resulting `INCOMPLETE_EXPLORATORY_COHORT` or
  `DATA_QUALITY_STOPPED` state.

Provider budgets must be justified only from documented public limits and pre-existing archive
pressure evidence. They cannot be enlarged in response to candidate scarcity, later labels, or a
desire to reach the planned cohort size.

## 9. Discovery/Validation Split And Downstream Analysis Boundary

The protocol must assign every future unit to `DISCOVERY` or `VALIDATION` before any later horizon is
observed. Assignment must be deterministic from the protocol version, canonical mint, and fixed
market-window identifier using a public non-secret hashing rule. A mint may never appear in both
partitions.

The split plan must fix the partition ratio, minimum independent mint/window/date counts per
partition, concentration ceilings, and `INCOMPLETE_EXPLORATORY_COHORT` behavior. It must prevent:

- choosing a split after labels exist;
- moving a unit between partitions after collection;
- selecting a feature/predicate in `DISCOVERY` and reporting its apparent result as validation; and
- combining partitions to bypass an independence or concentration failure.

Phase 10.6B is archive-only and may decide only one of:

```text
NO_DEFENSIBLE_HYPOTHESIS
DATA_INSUFFICIENT
PRE_REGISTRATION_CANDIDATE_REJECTED
HUMAN_REVIEW_REQUIRED
PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL
```

`PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL` means only that the completed exploratory cohort
supports drafting a separate, materially distinct candidate record. It never authorizes additional
collection, PAPER execution, a strategy/default change, promotion, or Phase 10.6C. A future
candidate remains subject to a separate approved pre-registration record and an independently
approved Phase 10.6C checklist with explicit user authorization.

## 10. Data Quality, Stop Conditions, And Future Archive Contract

The protocol must define bounded, non-trading stop conditions for malformed IDs, duplicate identity,
clock/timestamp inconsistency, provider-budget exhaustion, excessive stale/missing required anchors,
unsupported source provenance, collection-window violation, and any manifest-schema mismatch.

For each condition, it must fix one action:

```text
RECORD_MISSINGNESS
SKIP_UNIT_WITH_REASON
PAUSE_WINDOW
STOP_COHORT_DATA_QUALITY
MARK_COHORT_INCOMPLETE
```

It must not include a transaction, target, stop-loss, position, or P/L action. It must define an
archive-only future `ExploratoryCohortManifestV1`, `ExploratoryUnitV1`, and provenance inventory with
relative paths, SHA-256 source hashes, canonical sort keys, and no secret/raw-payload fields. The
future archive root, file names, and retention boundary must be fixed before Phase 10.6A approval.

## 11. Phase 10.5A Implementation Sequence

### A. Documentation and authority record

- [x] Add this checklist to the roadmap, decision log, planning inputs, and structure inventory.
- [x] Create one source-controlled `ExploratoryCohortProtocolV1` design record with
      `NOT_AUTHORIZED_FOR_COLLECTION`; it must contain no candidate, provider credential, or runtime
      command.
- [x] Cite the completed Phase 10.4/10.5 fingerprints and state the preserved
      `NO_STUDY_AUTHORIZED` / `NO_DEFENSIBLE_HYPOTHESIS` boundary.
- [x] Record explicitly that Phase 10.5A does not authorize Phase 10.6A, 10.6B, 10.6C, Phase 10.7,
      Paper Operations, a paper pilot, or a strategy change.

### B. Freeze the observational design

- [x] Define broad outcome-blind population/inclusion/exclusion and prove it contains no score,
      classification, later-label, return, or F65E-based condition.
- [x] Fix deterministic sampling, cohort targets, window/date boundaries, canonical mint identity,
      deduplication, independence/concentration requirements, and incomplete-cohort behavior.
- [x] Freeze the decision-time field allowlist, provenance, timestamp/freshness rules, missingness
      vocabulary, and allowed descriptive strategy context.
- [x] Freeze later horizon/label definitions as evaluation-only facts and remove every possible path
      from a later outcome back into eligibility, sampling, or collection control.
- [x] Define a deterministic discovery/validation split before collection and its minimum partition
      independence requirements.

### C. Future collection safety contract

- [x] Freeze provider categories, request/concurrency/retry/backoff/cooldown limits, no-fallback
      rules, and provider-pressure classifications without making a provider call.
- [x] Freeze data-quality stop conditions, bounded actions, archive schemas, relative-path rules,
      source hashing, canonical sort rules, and retention expectations.
- [x] Add the strict stdout-only `research:protocol:validate` command, config, schema, formatter,
      bounded error contract, package scripts, and tests. It must validate design only and cannot
      start, configure, or prepare a collection runtime.
- [x] Define the exact Phase 10.6A command/config surface only as a future proposal. Do not add a
      collection script, environment variable, provider adapter, database migration, or market
      runtime config in Phase 10.5A.

### D. Protocol review and downstream gates

- [x] Perform a mechanical review that rejects placeholders, mutable values, outcome-derived
      selection, threshold/default changes, F65E reuse, secret-like text, and any execution surface.
- [x] Verify `research:protocol:validate` returns only a non-authorizing design status and cannot
      write a protocol, data artifact, archive, manifest, or configuration file.
- [x] Verify the protocol describes an exploratory measurement cohort, not a strategy-validation,
      promotion, or paper-trading cohort.
- [x] Document the separate approval required for Phase 10.6A collection and the archive-only
      Phase 10.6B decision boundary.

### E. Closeout

- [x] Update Phase 10.5A handoff documentation with the actual protocol path/hash, frozen fields,
      explicit non-authority result, and verification output. The frozen protocol is
      `docs/research-protocols/phase10.6a-exploratory-cohort.v1.json` with SHA-256
      `748a159464ddfae3d7821e5e18bc690d87c2ac82cf2d89b596a11f4612fce152`.
      `research:protocol:validate` returned
      `PROTOCOL_READY_FOR_SEPARATE_COLLECTION_APPROVAL` with content fingerprint
      `2a21ec935618ebf7f7fed628c7f276474a104fb55dcb9f45f4a721bf4e9833e5`.
- [x] Confirm no provider/RPC/HTTP call, database access, runtime command, archive/data write,
      session, order, fill, position, wallet action, signing, submission, threshold/default change,
      or monitoring change occurred. The command reported zero for every counter and false for every
      wallet/signing/submission flag.
- [x] Mark tasks complete only after the documentation/schema verification plan passes. Do not begin
      Phase 10.6A merely because this design is complete. `corepack pnpm verify` passed on
      2026-08-19: format, lint, all workspace typechecks, 113 backend test files / 368 tests,
      4 shared test files / 13 tests, 2 frontend test files / 4 tests, and the secret scan.

## 12. Test And Verification Plan

### 12.1 Protocol schema and content checks

- [x] Validate the strict protocol shape, version, authority literal, required concrete fields,
      relative paths, source-evidence fingerprints, and canonical ordering.
- [x] Reject unknown fields, placeholders, empty values, absolute/traversal/URL paths,
      credential-like text, public/private endpoint details, environment references, and arbitrary
      runtime configuration.
- [x] Reject every score, classification, F65E, later-label, return, MFE/MAE, target/stop, or
      outcome-derived condition in population, sampling, exclusion, replacement, split, or provider
      budget fields.
- [x] Verify the validator accepts the exact approved protocol path and one `--once`, rejects a
      duplicate `--once` and every other path/option family, and emits one deterministic stdout-only
      Markdown or JSON result with exactly one bounded public error code on failure.
- [x] Inject two clocks and prove `generatedAt` differs while the protocol SHA-256, canonical JSON
      excluding `generatedAt`, and validation content fingerprint remain stable. The full raw JSON
      may differ only at `generatedAt`.

### 12.2 Design-integrity checks

- [x] Verify all collection-affecting caps, time windows, provider budgets, horizons, missingness
      codes, split assignments, concentration ceilings, and stop actions are concrete and immutable.
- [x] Verify future labels are evaluation-only and that the first exploratory protocol declares no
      entry predicate, strategy profile, target, stop-loss, execution behavior, or promotion gate.
- [x] Verify the deterministic split cannot place one mint in both partitions and does not use later
      facts.
- [x] Verify the protocol makes incomplete data a stated outcome instead of relaxing independence,
      deduplication, provider-budget, or threshold boundaries.

### 12.3 No-side-effect and documentation checks

- [x] Spy/static-check any Phase 10.5A implementation for zero provider/RPC/HTTP calls, database
      access, market-runtime construction, filesystem data writes, session creation, orders, fills,
      positions, wallet access, signing, and submission.
- [x] Hash/mtime every reviewed archive/document input before and after any local design validation;
      assert they are unchanged and no file appears under `data/` or `data/archive/`.
- [x] Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm check:secrets`, and
      `pnpm verify` after final approved Phase 10.5A documentation/code changes.

## 13. Acceptance Gates

Phase 10.5A may be marked complete only when all conditions hold:

```text
source-controlled ExploratoryCohortProtocolV1 exists = yes
authorityStatus = NOT_AUTHORIZED_FOR_COLLECTION
Phase 10.4 / 10.5 evidence fingerprints cited exactly = yes
strict stdout-only protocol validator passes = yes
validator result = PROTOCOL_READY_FOR_SEPARATE_COLLECTION_APPROVAL only
population/sampling/split use later labels or strategy thresholds = no
all collection-affecting parameters are concrete and immutable = yes
deduplication, independence, missingness, provenance, horizons, and stops fixed = yes
provider/RPC/HTTP calls = 0
database reads and writes = 0 / 0
market runtime commands and filesystem data writes = 0 / 0
orders/fills/positions/wallet/signing/submission = 0 / 0 / 0 / 0 / 0 / 0
strategy/default/threshold/provider/monitoring changes = 0
Phase 10.6A collection authorization by Phase 10.5A = 0
```

A complete design that remains `NOT_AUTHORIZED_FOR_COLLECTION` is the expected success condition.
It is not a failure to be repaired by collecting more F65E@v1 data, lowering/widening thresholds,
loosening independence, or enabling PAPER execution.

## 14. Explicit Deferrals

Phase 10.5A does not include:

- Phase 10.6A observational collection, live provider/RPC access, active data loading, database
  adapters, session/runtime surfaces, archive/data writers, or generated cohort artifacts;
- a successor profile, F65E@v1 continuation, score/threshold change, strategy tuning, hypothesis
  selection, promotion, collection authorization, or automated natural-language recommendation;
- Phase 10.6B archive analysis, a generic candidate pre-registration validator, Phase 10.6C shadow
  validation, Phase 10.7 promotion review, Phase 10.8A Paper Operations Dashboard, Phase 10.8B
  paper pilot, Phase 10.9 assessment, live-readiness work, or live trading; and
- PAPER BUY/SELL, orders, fills, positions, balances, P/L, wallet access, signing, submission, or
  execution controls.

The next action after a complete Phase 10.5A protocol is to preserve its non-authority state. A
separate Phase 10.6A detailed checklist and explicit user approval are required before any future
exploratory collection can begin.
