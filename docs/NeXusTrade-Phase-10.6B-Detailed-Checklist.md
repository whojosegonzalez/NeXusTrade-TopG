# NeXusTrade Phase 10.6B Detailed Implementation Checklist

## Exploratory Cohort Archive Analysis And Hypothesis Decision

Status: Implemented on 2026-08-30 with synthetic fixtures only, including the approved archive-identity
closeout patch. After the provider-free closeout succeeded, the separately authorized stdout-only run
against the completed archive returned `NO_DEFENSIBLE_HYPOTHESIS` on 2026-09-03 PDT (report audit
timestamp `2026-09-04T05:57:39.245Z`). The report verified `archiveIdentity: MATCHED`; it did not
authorize a successor study, collection, strategy change, PAPER action, or execution behavior.
This checklist was deliberately written before the first Phase 10.6A collection so that the analysis,
label, candidate catalog, and decision gates could not be changed after observing the cohort. The
archive metadata below remains the immutable input identity record. The real-run closeout at the end
of this checklist records the resulting bounded decision; neither the implementation nor that result
authorizes a provider call, collection, or execution action.

## 1. Purpose And Required Outcome

Phase 10.6B is a single-archive, archive-only evaluation of a finalized Phase 10.6A V2 exploratory
cohort. Its research question is:

```text
Does the completed outcome-blind cohort contain independently replicated, decision-time-only evidence
for exactly one materially distinct future shadow-study predicate, or does it instead show insufficient
or non-defensible evidence?
```

It is not a strategy backtest, profitability claim, target/stop study, promotion review, or execution
surface. The analysis may compare later observations only as labels against decision-time facts. It
must never re-run collection selection, change a collection fact, or use a later observation as a
future entry input.

The future command may return only one of the V2-allowed outcomes below:

```text
DATA_INSUFFICIENT
NO_DEFENSIBLE_HYPOTHESIS
PRE_REGISTRATION_CANDIDATE_REJECTED
HUMAN_REVIEW_REQUIRED
PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL
```

`PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL` means only that a human may draft one separate,
versioned `ShadowStudyPreRegistrationV1` record and request approval for a Phase 10.6C checklist. It
does not authorize that record, another collection, a strategy/default/threshold change, PAPER
execution, an order, a fill, a position, a wallet action, signing, submission, or promotion.

## 2. Non-Negotiable Safety And Authority Boundary

Every Phase 10.6B implementation and run must preserve all of the following:

- It reads only one explicitly named finalized Phase 10.6A V2 archive and the pinned protocol source
  record. It makes zero external/provider/RPC/HTTP calls, including no browser, loopback, Vite,
  adapter, health, smoke, quote, or discovery call.
- It makes zero database reads or writes, migrations, pragmas, repository calls, session reads or
  writes, scanner/runtime invocation, cache access, dashboard export, filesystem write, report file,
  manifest, checkpoint, or generated-data write. Markdown or JSON goes to standard output only.
- It must not construct or invoke the collector, scanner, watchlist, strategy, risk, PAPER, exit,
  session, terminal, quote-diagnostic, provider registry, provider router, or any generic runtime
  service.
- It must not load environment values, API keys, wallets, accounts, balances, private keys, or local
  provider configuration. It must not construct, sign, submit, simulate, or request a transaction.
- BUY=90 / WATCH=70 remains unchanged, PAPER execution stays disabled, and F65E@v1 remains closed.
  No score, score attribution, threshold, risk rule, provider default, exit, target, stop, or one-/
  two-minute monitoring setting may change.
- It may not write, echo, hash, or accept a credential, header, URL, raw provider payload, host path,
  request body, response body, wallet/account fact, or unbounded free-form configuration.
- No output may recommend a trade, rank a live token, name a BUY/WATCH/SELL decision, calculate P/L,
  MFE, MAE, target/stop ordering, or present a candidate as executable.

The command is an evidence reader only. A malformed, non-final, unsafe, or inconsistent archive must
fail closed before emitting an analysis result.

## 3. Fixed Input Scope And Archive Integrity

The initial implementation supports exactly this one direct, named archive root:

```text
data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z
```

The archive must contain exactly these finalized files and no `collection.lock` or temporary artifact:

```text
cohort-manifest.v1.json
units.v1.ndjson
source-inventory.v1.json
collection-summary.v1.json
```

Before any analysis result, the implementation must verify all of the following from structured JSON
only:

1. The archive path is repository-contained, direct, and matches the V2 grammar; no alternate root,
   phase, archive union, glob, URL, symlink escape, database, or report path is accepted.
2. The manifest pins
   `docs/research-protocols/phase10.6a-exploratory-cohort.v2.json` and SHA-256
   `2662a4cbc1d3458d55b64f9c4cc826561aad1cb6f6b5faf11079194377f5a0ed`.
3. The manifest has no active lock, has a final outcome, and its `finalFileHashes` values match the
   canonical bytes of `units.v1.ndjson`, `source-inventory.v1.json`, and
   `collection-summary.v1.json` exactly. The manifest's whole-file SHA-256 is an output inventory
   fact only; it cannot self-authenticate inside `finalFileHashes`. After those internal checks, all
   four raw artifact hashes, including the manifest, must match the approved source-code literals
   recorded below; a self-consistent rewrite fails closed.
4. The launch identity, archive root, fixed caps, four horizon definitions, deterministic partition,
   and immutable V2 identity agree across the manifest, units, summary, and source inventory.
5. Every safety counter is zero and every execution/wallet/signing/submission flag is false. Any
   nonzero or true value is a source inconsistency, never evidence for a candidate.
6. Each source record has only the V2-allowed category/provider/capability values, `requestCount=1`,
   `attemptCount=1`, a bounded outcome code, an allowed latency bucket, and a canonical SHA-256 of
   its sanitized provenance preimage. Raw payload, network, credential, host, or request text fails
   closed.
7. Units are canonically ordered by `unitId`, have unique `unitId` and canonical mint, retain the
   immutable split assignment, and contain only the V2 allowlisted decision-time facts plus separately
   nested later observations.

The archive outcome controls the first result gate:

| Final archive state                                                                                                    | Required Phase 10.6B result                                        |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `COHORT_COMPLETE` and all integrity checks pass                                                                        | Continue to fixed quality and candidate gates.                     |
| `COHORT_INCOMPLETE`, `COHORT_STOPPED_DATA_QUALITY`, or `HUMAN_REVIEW_REQUIRED` with valid final files                  | `DATA_INSUFFICIENT`; preserve the recorded stop/incomplete reason. |
| `COLLECTING`, an active lock, missing final file, unexpected outcome, invalid schema, unsafe content, or hash mismatch | Fail closed with one bounded public error before analysis output.  |

An incomplete cohort is valid research evidence but is never a reason to relax a count, date,
concentration, split, label, feature, or validation gate.

### 3.1 Current finalized archive reference (metadata only)

The one permitted future analysis input has already finalized as `COHORT_COMPLETE`. This reference
records immutable file identity only; it does not evaluate any label, feature, candidate, or gate:

```text
archive root                    data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z
protocol SHA-256                2662a4cbc1d3458d55b64f9c4cc826561aad1cb6f6b5faf11079194377f5a0ed
cohort-manifest.v1.json         0d462555a476cbec4c983d259f6ea3c96a3ef65486a9de7484b65fb2b690f48b
units.v1.ndjson                 feb8515e0adf50ac86660bbfd378133b45303ed9a4ef57e0d0d73536f0542a9c
source-inventory.v1.json        766b8315366b13372fa33218b3b483e359055d88a9f7d5f53ff8de560866212a
collection-summary.v1.json      a6bab14209e5c0d0a16a76617866144e1349d862d7446751d699c8b890fb2940
```

The archive has no `collection.lock`. Its scheduled provider-free operator closeout remains a
separate no-write confirmation; it must not reopen, replace, extend, or otherwise alter this archive.

## 4. Planned Command, Scope Parsing, And Error Contract

After separate checklist approval and after a final archive exists, the implemented command accepts
only this strict local invocation:

```text
pnpm research:exploratory-cohort:analyze -- \
  --archive-root=data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z \
  --format=markdown
```

Supported arguments are exactly:

- exactly one `--archive-root=data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z`;
- optional exactly-once `--format=markdown|json`, default `markdown`; and
- optional exactly-once `--once` as a compatibility no-op only.

The parser must reject duplicate, empty, traversal-shaped, absolute-outside-repository, symlink-
escaping, URL-shaped, missing, active, legacy, non-V2, multi-root, phase-include, cohort-include,
output/write, environment, database, runtime, provider, HTTP, session, strategy, score, threshold,
target, stop, wallet, signing, submission, PAPER, order, fill, position, balance, monitor, or generic
configuration options before reading the archive.

All invalid or fail-closed source states must return a nonzero exit with exactly one public code and
no Markdown/JSON analysis object:

```text
EXPLORATORY_ANALYSIS_INVALID_SCOPE
EXPLORATORY_ANALYSIS_UNSUPPORTED_ARCHIVE
EXPLORATORY_ANALYSIS_SOURCE_INCONSISTENCY
EXPLORATORY_ANALYSIS_ARCHIVE_NOT_FINAL
```

Error detail may name one sanitized archive-relative path or bounded field identifier. It must never
emit source content, a host path, an endpoint, a credential-shaped string, or a second machine-
parseable code.

## 5. Decision-Time And Later-Label Boundary

### 5.1 Allowed candidate-input field catalog

Only these finite decision-time facts may appear in the fixed Phase 10.6B candidate catalog:

```text
market.assetAgeSeconds
market.liquidityUsd
market.volume5mUsd
market.volume1hUsd
market.momentum5mPct
market.momentum15mPct
quote.priceImpactBps
```

Each value must be finite, have `AVAILABLE_AT_ANCHOR`, and meet the V2 recorded freshness/provenance
requirements. `market.priceUsd` is required collection evidence but is not a candidate feature.
`discovery`, `quote.available`, `risk.blockerCodes`, `attention.repeatedAttentionCount`, provider
provenance, source outcome codes, latency, availability itself, and all score/strategy/PAPER facts
are descriptive or quality context only; none may be a predicate input.

The implementation must reject a catalog extension, a conjunction/disjunction, a score band, a
hand-selected numeric threshold, a missingness predicate, or a feature created from outcome labels.
It must not normalize, impute, winsorize, transform, cluster, rank, model, or learn a feature beyond
the exact quantile construction below.

### 5.2 Fixed primary label

The sole candidate-evaluation label is derived from the already-collected 60-minute observation:

```text
POSITIVE_60M       minutesAfterAnchor=60, availability=OBSERVED_ON_TIME,
                   finite returnPct > 0
NON_POSITIVE_60M   minutesAfterAnchor=60, availability=OBSERVED_ON_TIME,
                   finite returnPct <= 0
UNUSABLE_60M       missing, invalid, late, absent, duplicate, non-finite, or otherwise invalid 60m label
```

`UNUSABLE_60M` is explicit missingness and is excluded only from rate denominators. It is never
converted to a loss, a zero return, an inferred observation, or a feature value. The 3/5/15-minute
observations may appear only in a separately marked descriptive label-quality section. No target,
stop, trading result, P/L, MFE, MAE, or later-return threshold is defined or computed.

### 5.3 Structural separation rule

The analysis contract must represent `decisionTimeEvidence`, `primaryLabelAnalysis`, and
`secondaryLabelDescription` as distinct typed branches. A candidate descriptor can cite only a
decision-time field path, its deterministic discovery threshold, partition, and archive-relative
unit IDs/counts. Later labels may support only effect, coverage, and validation calculations; they
must never be serialized as a predicate field or written into a future entry rule.

## 6. Pre-Registered Quality, Independence, And Label Gates

These gates are evaluated before catalog selection. They are fixed for V1 and may not be loosened
after collection.

| Gate                       | Exact requirement                                                                                                                                                                              | Failure result                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Cohort completion          | Manifest outcome is `COHORT_COMPLETE`, exactly 96 valid units, no repeated mint, at least 8 UTC dates, at least 32 units and 4 dates in each partition, and no UTC date over 20% of all units. | `DATA_INSUFFICIENT`                  |
| Split reconstruction       | Recompute `SHA256("phase10.6a-exploratory-cohort.v2\|canonicalMint\|slotId")` for every unit; even final hex digit is `DISCOVERY`, odd is `VALIDATION`; no mint appears in both partitions.    | `DATA_INSUFFICIENT`                  |
| Primary-label coverage     | In each partition, usable 60-minute labels are at least `ceil(0.90 * partitionValidUnitCount)`.                                                                                                | `DATA_INSUFFICIENT`                  |
| Primary-label support      | In each partition, there are at least 8 `POSITIVE_60M` and 8 `NON_POSITIVE_60M` labels.                                                                                                        | `DATA_INSUFFICIENT`                  |
| Label-date concentration   | In each partition, no UTC date supplies more than 35% of that partition's usable 60-minute labels.                                                                                             | `DATA_INSUFFICIENT`                  |
| Archive/source consistency | Manifest, units, summary, source inventory, hashes, safety counters, caps, and canonical ordering agree exactly.                                                                               | Bounded source error, not an outcome |

All percentages use exact integer numerators/denominators and are displayed to two decimals only after
the gate decision. UTC date is the first ten characters of the unit's anchor UTC timestamp. There is
no leave-one-run rule because this deliberately independent collection has no inherited TerminalRunner
run identity; the split, mint, slot, and UTC-date gates are the applicable independence evidence.

## 7. Fixed Candidate Catalog And Discovery Selection

### 7.1 Quantile construction without outcome input

For each permitted field separately, form a sorted ascending vector of finite available **DISCOVERY**
values from all valid discovery units, before consulting any 60-minute label. For vector length `n`:

```text
Q1 = values[floor(0.25 * (n - 1))]
Q3 = values[ceil(0.75 * (n - 1))]
```

Do not interpolate, round, alter ties, exclude values based on labels, or derive a validation
threshold. A field is catalog-eligible only when finite available values cover at least 90% of valid
units in both `DISCOVERY` and `VALIDATION` partitions.

For every eligible field, evaluate exactly these two single-feature rules and no others:

```text
<FIELD_ID>__LOW_V1   decision-time <field> <= discovery Q1
<FIELD_ID>__HIGH_V1  decision-time <field> >= discovery Q3
```

The complete V1 catalog is therefore fourteen fixed rule IDs: `AGE`, `LIQUIDITY`, `VOLUME_5M`,
`VOLUME_1H`, `MOMENTUM_5M`, `MOMENTUM_15M`, and `QUOTE_IMPACT`, each with `LOW_V1` and `HIGH_V1`.
If the required source field is unavailable, both of that field's rules are recorded as unavailable;
they are not replaced.

### 7.2 Discovery selection gate

For a rule, evaluate only usable 60-minute labels with a finite available field value. Its comparison
group is all other such units in the same partition that do not satisfy the rule. A rule is discovery-
eligible only when all conditions below hold:

```text
rule support >= 8 usable units
comparison support >= 24 usable units
rule spans >= 4 UTC dates
no one UTC date supplies >35% of rule support
discovery positive-rate difference
  = POSITIVE_60M rate(rule) - POSITIVE_60M rate(comparison) >= 0.20
```

The analyzer may use discovery labels only to choose one member of this pre-registered catalog. It
must record every catalog rule, feature coverage, threshold, support, rate, and ineligible reason;
it must not hide losing rules or search a new threshold.

If multiple discovery-eligible rules exist, select exactly one using this fixed order:

1. largest discovery positive-rate difference;
2. larger rule support;
3. lexicographically smaller rule ID.

If no rule is discovery-eligible, return `NO_DEFENSIBLE_HYPOTHESIS`, not a candidate or a request for
more collection. A selected discovery rule is not a positive outcome and must be labelled
`UNCONFIRMED_DISCOVERY_SIGNAL` until it passes every validation gate.

## 8. Held-Validation And Pre-Registration Gates

Apply the one selected discovery rule and its exact discovery threshold to `VALIDATION` without
recomputing quantiles, changing direction, choosing another feature, joining fields, or inspecting a
new catalog. A candidate is rejected unless every condition below passes:

| Gate                         | Exact validation requirement                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Feature coverage             | Finite available source field covers at least 90% of valid validation units.                                                                                                                     |
| Rule support                 | At least 8 usable labelled units satisfy the frozen rule; at least 24 usable labelled units form its comparison group.                                                                           |
| Date support                 | Rule support spans at least 4 UTC dates and no one UTC date supplies more than 35% of its rule support.                                                                                          |
| Effect direction and size    | `POSITIVE_60M` rate(rule) minus rate(comparison) is at least +0.15.                                                                                                                              |
| Exact statistical check      | One-sided Fisher exact test for a greater positive rate has `p <= 0.05`, using the 2x2 count table and the upper hypergeometric tail; no normal approximation, resampling, or optional stopping. |
| Leave-one-date-out stability | Removing each validation UTC date in turn leaves a finite rule/comparison denominator and a strictly positive positive-rate difference.                                                          |
| No prohibited reuse          | Descriptor contains one allowed field and comparator only, no F65E, score, classification, risk, provider-pressure, later fact, or default/threshold change.                                     |

Failure after a discovery rule was selected returns `PRE_REGISTRATION_CANDIDATE_REJECTED`. The report
must identify the fixed failed gate, not a proposed rescue such as a different threshold, feature,
date range, provider, label horizon, target/stop, or larger cohort.

Only a rule passing every discovery and validation gate may return
`PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL`. This result must contain a non-authorizing,
source-traceable candidate descriptor with exactly:

```text
catalogRuleId
decisionTimeField
comparator
discoveryThreshold
discoveryEvidence                 # bounded aggregate counts/rates only
validationEvidence                # bounded aggregate counts/rates/Fisher p only
archiveCitations                  # archive-relative files, unit IDs, and field paths only
materialDifference                # fixed statement: one decision-time feature, not F65E@v1
requiredNextRecord                # ShadowStudyPreRegistrationV1 is still human-authored
nextPermittedAction               # separate approval only; no collection or execution
```

The descriptor is stdout-only and is not a `ShadowStudyPreRegistrationV1` record. A future human-
authored record must still supply its own fixed population, safety constraints, collection plan,
labels, promotion gates, and stop conditions, then receive separate approval before any Phase 10.6C
implementation or collection work.

## 9. Analysis Result And Output Contract

The planned versioned output is `ExploratoryCohortAnalysisV1`. Markdown and JSON must derive from the
same Zod-validated object, have deterministic lexical ordering, and contain:

```text
contractVersion
generatedAt                         # display/audit only
contentFingerprint                  # canonical content omits generatedAt and blanks this field
archiveIdentity                     # MATCHED status, archive-relative root, V2 SHA, launch identity hash only
inputInventory                      # four relative paths and SHA-256 values
safety                              # all analysis counters zero/false
archiveIntegrity                    # final-state/hash/schema/safety/cap verification
cohortQuality                       # fixed count, split, date, concentration, and label gates
decisionTimeCoverage                # aggregate finite/missing coverage per catalog field
secondaryLabelDescription           # 3/5/15m descriptive availability only
primaryLabelAnalysis                # 60m-only aggregate label counts and rates
catalogLedger                       # all fourteen fixed rule IDs and deterministic outcomes
selectedDiscoveryRule               # absent or one unconfirmed rule
validationLedger                    # absent or one frozen-threshold validation result
outcome                             # one V2-allowed status and fixed reasons
candidateDescriptor                 # absent except the non-authorizing ready result
nextPermittedAction
warnings
```

All paths are archive-relative. Unit IDs may appear only inside bounded archive citations for the one
ready descriptor; mint, symbol, URL, provider payload, wallet/account, and raw request data are not
output fields. The report must preserve missingness rather than treating it as zero, no, loss, or
failure. `contentFingerprint` must hash canonical JSON after omitting `generatedAt` and setting
`contentFingerprint` to `""` in the hash preimage.

Every valid outcome must end with this fixed authority statement:

```text
This archive-only result does not authorize a strategy change, collection, Phase 10.6C validation,
PAPER execution, promotion, order, fill, position, wallet action, signing, or submission.
```

## 10. Proposed Isolated Architecture

Implemented after separate checklist approval and one Phase 10.6A archive is final. The module depends
only on Node crypto/filesystem primitives, Zod, narrow local analysis value types, and the pinned V2
protocol parser:

```text
ExploratoryCohortAnalysisConfig       strict one-archive CLI parser
ExploratoryCohortArchiveLoader        read-only final-artifact/hash/schema verifier
ExploratoryCohortQualityService       counts, split, date, label, and safety gates
ExploratoryCohortCatalogService       fixed quantiles/catalog/discovery selection only
ExploratoryCohortValidationService    frozen-rule held validation and exact Fisher calculation
ExploratoryCohortAnalysisService      result-state composition without runtime authority
ExploratoryCohortAnalysisFormatter    deterministic stdout Markdown/JSON only
research-exploratory-cohort-analyze   thin CLI entrypoint
```

It must not import the Phase 10.6A collector or gateway. A fake archive fixture is the only test
source; tests may never call a provider or read an actual database/archive outside their controlled
temporary fixture.

## 11. Implementation Sequence

During implementation, update this checklist immediately after each completed task with a checked
box and concise verification note. Do not implement or run Phase 10.6B before the user separately
approves this checklist and a Phase 10.6A archive is final.

### A. Freeze analysis authority and contracts

- [x] Create this pre-collection detailed checklist and update Phase 10+ handoff documentation.
      Note: the fixed label, candidate catalog, discovery/validation gates, and non-authorizing
      positive outcome are documented before the first Phase 10.6A collection.
- [x] Reconcile the checklist's final-artifact contract with the completed authorized archive without
      reading labels for an outcome or candidate decision.
      Note: on 2026-08-30, the exact named root, four immutable artifact hashes, no-lock state, and
      `COHORT_COMPLETE` status were recorded as input identity only. Phase 10.6B was unimplemented
      at that time; it was later implemented and then separately run against the immutable archive on
      2026-09-03 PDT under explicit authorization.
- [x] Add typed, strict schema contracts for the finalized V2 archive and `ExploratoryCohortAnalysisV1`.
      Note: `research-exploratory-analysis` accepts only bounded V2 structures and a Zod-validated
      `ExploratoryCohortAnalysisV1` result.
- [x] Implement the strict CLI parser, bounded public errors, archive containment, and finality checks.
      Note: the parser accepts only the named root, one optional format, and one compatibility `--once`;
      all other authority-bearing options fail closed with one public code.
- [x] Pin the V2 protocol SHA, archive file names, canonical source-hash preimage, and output
      fingerprint procedure without accepting overrides.
      Note: the loader verifies the pinned protocol bytes, four fixed artifact names, sanitized source
      hash preimage, and the fingerprint preimage that omits `generatedAt` and blanks its own field.

### A.1 Approved archive-identity closeout patch

- [x] Hard-pin the approved SHA-256 values for `cohort-manifest.v1.json`, `units.v1.ndjson`,
      `source-inventory.v1.json`, and `collection-summary.v1.json` in the isolated analysis module.
      Note: the production CLI has no identity override; test fixtures can inject a temporary expected
      identity through the loader constructor only.
- [x] Compare all four raw artifacts with the approved identity after the normal structural, canonical,
      protocol, source, safety, and summary checks.
      Note: an identity mismatch returns `EXPLORATORY_ANALYSIS_SOURCE_INCONSISTENCY` before any report.
- [x] Emit `archiveIdentity.status: MATCHED` in JSON and `Archive identity: MATCHED` in Markdown only
      after all approved hashes match.

### B. Build the isolated archive reader and gate services

- [x] Implement read-only canonical archive loading, hash verification, source-inventory validation,
      zero-safety validation, and explicit missingness preservation.
      Note: the loader has no write API and fails closed for active, malformed, non-canonical, unsafe,
      unexpected, or inconsistent synthetic artifacts.
- [x] Implement exact cohort completion, split reconstruction, date/concentration, and primary-label
      coverage/support gates with no fallback interpretation.
      Note: every gate is evaluated before catalog selection; valid incomplete final cohorts return
      `DATA_INSUFFICIENT` without a relaxed rule.
- [x] Implement the fourteen-rule decision-time catalog and outcome-blind discovery quantiles.
      Note: all seven fields and both fixed directions are emitted even when unavailable.
- [x] Implement discovery rule selection, frozen held-validation, one-sided exact Fisher test, and
      leave-one-date-out stability without alternative rule search.
      Note: the validation ledger can assess only the single deterministic discovery selection.
- [x] Implement only the five V2-allowed outcome states and the default-deny candidate descriptor.
      Note: only a held-validation-passing single-feature result can emit the non-authorizing descriptor.

### C. Add deterministic tests and verification

- [x] Add synthetic finalized-archive fixtures only; prove no test reads a database or performs a
      provider/RPC/HTTP call.
      Note: the focused suite creates and removes temporary synthetic archives only; no real archive,
      provider, database, or runtime command was invoked.
- [x] Test invalid scope, unsafe option, active/non-final archive, hash mismatch, unsafe archive text,
      source-hash mismatch, source/summary inconsistency, duplicate mint, and split mismatch failures.
      Note: all listed synthetic cases fail closed with the bounded contract code or fixed gate result.
- [x] Test an injected matching identity, each of the four individual expected-hash mismatches, and a
      coherently rewritten synthetic archive with recomputed internal hashes.
      Note: only the matching injected identity passes; every mismatch and the coherent rewrite fail
      closed with `EXPLORATORY_ANALYSIS_SOURCE_INCONSISTENCY`.
- [x] Test `DATA_INSUFFICIENT` for every fixed quality/label coverage/support/date gate without
      changing a collection threshold or adding a unit.
      Note: synthetic completion, split, coverage, support, date-concentration, and incomplete-final
      cases retain the fixed catalog and return no selected rule.
- [x] Test deterministic quantiles, all fourteen ledger rows, tie-breaking, unavailable fields, no
      discovery rule, validation rejection, Fisher boundary, leave-one-date-out failure, and the sole
      non-authorizing ready result.
- [x] Test that later labels cannot appear in a predicate/threshold and that validation never selects
      a second rule or recomputes the discovery threshold.
      Note: candidate descriptors contain only an allowlisted decision-time path, and validation is
      asserted to use the selected discovery rule.
- [x] Test byte-stable canonical output after excluding `generatedAt` and blanking
      `contentFingerprint` in the hash preimage; test Markdown/JSON agreement and stdout-only output.
- [x] Add static dependency tests proving zero collector/gateway/provider/database/session/strategy/
      PAPER/wallet/execution imports and zero filesystem-write paths.
- [x] Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, the focused synthetic suite, and
      `pnpm check:secrets`.
      Note: all passed on 2026-08-30. The repository-wide `pnpm test` and `pnpm verify` wrappers were
      deliberately not run because this implementation approval permits synthetic fixtures only and
      those unrelated wrappers include database/runtime tests. No collector or analyzer command was run.

### D. Separate analysis-run approval and downstream boundary

- [x] After a Phase 10.6A archive is final, present its relative root and immutable file hashes for
      explicit user approval before a Phase 10.6B run.
      Note: the named root and all four hard-pinned SHA-256 values were presented and the user then
      separately authorized the one archive-only analysis run.
- [x] Run only the approved archive-only command and preserve its stdout outside the command if the
      operator chooses; do not write or alter the source archive.
      Note: the user ran the named Markdown command after the 2026-09-03 provider-free closeout. Its
      report states zero provider/RPC/HTTP, database, filesystem-write, runtime, session, or execution
      actions and reports `archiveIdentity: MATCHED`.
- [x] If the result is ready, draft no record automatically. Require a separate human-authored
      pre-registration, a separately approved Phase 10.6C checklist, and explicit collection approval.
      Note: the actual result was `NO_DEFENSIBLE_HYPOTHESIS`, so no candidate record, Phase 10.6C
      checklist, collection, or successor authorization was created.

## 12. Acceptance Gates

Phase 10.6B implementation may be presented for review when the completed implementation tasks and
the following statements remain true:

```text
one final V2 archive is the only supported analysis scope = yes
provider/RPC/HTTP calls, database reads/writes, filesystem writes, and runtime actions = 0
decision-time facts and later labels are structurally separate = yes
candidate catalog, quantiles, selection, validation, and rejection gates are fixed before collection = yes
F65E@v1, score/default/threshold changes, target/stop, P/L, and execution inputs = absent
only a held-validation-passing single-feature descriptor can be positive = yes
positive result authorizes collection, execution, or promotion = no
```

The real run required—and received—separate user approval for the named archive. Implementation
approval did not substitute for analysis-run approval, and its `NO_DEFENSIBLE_HYPOTHESIS` outcome does
not substitute for separate approval of any future work.

## 13. Real Archive Analysis Closeout

The one approved archive-only Markdown run was performed by the user after the provider-free closeout.
The analyzer report is terminal stdout, not an archive artifact. Its audit identity was:

```text
generatedAt                    2026-09-04T05:57:39.245Z
contentFingerprint             5b57410a3fa9164ba2671f7fb118fdda65985802b56411f67e4835f1fdde39b6
archiveIdentity                MATCHED
final archive state            COHORT_COMPLETE
analysis status                NO_DEFENSIBLE_HYPOTHESIS
next permitted action          PRESERVE_ARCHIVE_NO_SUCCESSOR_STUDY_AUTHORIZED
```

All fixed quality gates passed: 96 valid units; deterministic partitions of 46 discovery and 50
validation units; complete primary-label coverage; 8/8 primary-label support; and label-date
concentration of 18/35. The fixed 60-minute label was positive for 8 discovery and 12 validation
units. The 3/5/15-minute observations were reported only as availability facts and were not used as
selection inputs.

The catalog made no defensible discovery selection. `LIQUIDITY`, `MOMENTUM_5M`, and `MOMENTUM_15M`
were unavailable under their fixed coverage rules; the eligible age, volume, and quote-impact rules
also failed their pre-registered discovery gates. No rule advanced to held validation. In particular,
the preliminary high-`VOLUME_1H` difference was not a passing signal and is not a candidate.

This is a valid default-deny research outcome. Preserve the immutable archive and the retained stdout
report. Do not create Phase 10.6C, a successor protocol, collection, strategy/default/threshold
change, PAPER action, wallet action, signing, submission, order, fill, position, or promotion from
this result.
