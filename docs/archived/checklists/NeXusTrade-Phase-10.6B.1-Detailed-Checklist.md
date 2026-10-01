# NeXusTrade Phase 10.6B.1 Detailed Implementation Checklist

## Decision-Time Measurement And Missingness Audit

Status: Closed on 2026-09-04. After synthetic-only implementation verification, the user separately
approved one stdout-only audit of the named V2 archive. It returned
`MEASUREMENT_REVISION_READY_FOR_SEPARATE_PROTOCOL_REVIEW` with immutable identity `MATCHED` and
literal zero audit side-effect counters.

This checklist is deliberately narrower than Phase 10.6B. It does not revisit feature effects or
later outcomes. It asks only whether the immutable V2 archive has decision-time measurement evidence
that can justify drafting a separate, measurement-only protocol revision for review.

## 1. Purpose And Required Outcome

Phase 10.6B.1 answers this question:

```text
Using only archived decision-time availability, bounded missingness, sanitized provenance,
source-inventory, date, and partition facts, is there a replicated measurement limitation specific
enough to justify drafting a separate measurement-only collection protocol revision?
```

It is not a strategy analysis, hypothesis-selection pass, target/stop study, profitability claim,
provider test, or collection authorization. It must not calculate, aggregate, compare, or display a
later return, later-observation availability, positive/negative label, candidate effect, threshold,
score, risk decision, P/L, MFE, MAE, target/stop ordering, or token ranking.

The implemented audit may return exactly one bounded status:

```text
MEASUREMENT_REVISION_READY_FOR_SEPARATE_PROTOCOL_REVIEW
NO_ACTIONABLE_MEASUREMENT_CHANGE
MEASUREMENT_EVIDENCE_INSUFFICIENT
HUMAN_REVIEW_REQUIRED
```

`MEASUREMENT_REVISION_READY_FOR_SEPARATE_PROTOCOL_REVIEW` means only that a human may draft one
separate, versioned, measurement-only protocol for review. It is not a protocol, a new provider,
collection, candidate, Phase 10.6C authorization, strategy/default/threshold change, PAPER action,
wallet action, signing, submission, order, fill, position, promotion, or live-trading authority.

## 2. Non-Negotiable Safety And Authority Boundary

Every implementation and eventual run must preserve all of the following:

- It reads only the one named finalized V2 archive, the pinned V2 protocol source, and hard-pinned
  archive-identity literals. It makes zero external/provider/RPC/HTTP calls, including browser,
  loopback, Vite, adapter, health, smoke, quote, discovery, or provider-config calls.
- It makes zero database reads or writes, migrations, pragma calls, repository calls, cache access,
  session reads/writes, scanner/runtime calls, dashboard exports, filesystem writes, report files,
  manifests, checkpoints, generated-data writes, or scheduler changes. Markdown or JSON goes only to
  stdout.
- It must not import, construct, or invoke the collector, collector gateway, scanner, watchlist,
  strategy, risk service, PAPER service, exit service, session service, quote diagnostic, provider
  registry/router, generic runtime, or the Phase 10.6B analysis loader/service/formatter. The latter
  interpret later observations and therefore are not an allowed dependency for this audit.
- It must not load environment values, API keys, credentials, wallets, accounts, balances, private
  keys, or local provider configuration. It must not construct, sign, simulate, submit, or request a
  transaction.
- It may decode a parent NDJSON object only to project its permitted decision-time fields, but must
  not schema-parse, validate, materialize into an audit type, iterate, count, branch on, emit, or
  otherwise interpret any member of `laterObservations`; `returnPct`, `minutesAfterAnchor`, later
  availability, and later reason are label data and prohibited. The raw artifact identity check may
  cover the whole immutable file, but the audit's unit projection must treat the top-level
  `laterObservations` property as opaque and discard it without inspecting its contents.
- It may not calculate a score, score attribution, risk rule, strategy decision, profile, threshold,
  effect size, correlation, Fisher result, candidate, recommendation to trade, or a future entry
  predicate. It may not change BUY=90 / WATCH=70, F65E@v1 closure, strategy defaults, targets, stops,
  provider defaults, or one-/two-minute monitoring.
- It may not output a canonical mint, unit ID, slot ID, raw source timestamp, source hash, raw
  provider payload, URL, host, request/response text, credential-like content, wallet/account fact,
  or an unbounded free-form value. Output uses only bounded aggregate counts, percentages, UTC dates,
  fixed field IDs, fixed availability/provenance enums, and sanitized source-inventory enums.

Any malformed, non-final, unsafe, identity-mismatched, structurally inconsistent, or label-accessing
state must fail closed before emitting an audit report.

## 3. Fixed Input Scope And Immutable Identity

The first implementation supports exactly one repository-relative archive root:

```text
data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z
```

It accepts exactly these final artifacts and no active `collection.lock`, temporary artifact, archive
union, glob, alternate root, database, report, symlink escape, URL, or absolute path:

```text
cohort-manifest.v1.json
units.v1.ndjson
source-inventory.v1.json
collection-summary.v1.json
```

The implementation must hard-pin these raw SHA-256 values in source without a production override:

```text
protocol SHA-256                2662a4cbc1d3458d55b64f9c4cc826561aad1cb6f6b5faf11079194377f5a0ed
cohort-manifest.v1.json         0d462555a476cbec4c983d259f6ea3c96a3ef65486a9de7484b65fb2b690f48b
units.v1.ndjson                 feb8515e0adf50ac86660bbfd378133b45303ed9a4ef57e0d0d73536f0542a9c
source-inventory.v1.json        766b8315366b13372fa33218b3b483e359055d88a9f7d5f53ff8de560866212a
collection-summary.v1.json      a6bab14209e5c0d0a16a76617866144e1349d862d7446751d699c8b890fb2940
```

Before any audit result, it must verify all of the following:

1. The root is repository-contained, direct, non-symlinked, and exactly the approved path.
2. The V2 protocol bytes and SHA, launch root/start/identity, final outcome, final-file inventory,
   final-file hashes, zero safety counters, and immutable archive identity agree.
3. The manifest, source inventory, and collection summary are schema-valid for their decision-time
   and safety/provenance portions. The implementation may verify opaque later-observation container
   presence only; it may not inspect any nested later-observation member or summary label count.
4. Every output decision-time fact uses the fixed V2 source-category/source-identifier pair,
   availability enum, required timestamp for available provider facts, finite available value, and no
   value for an unavailable fact. Available fact freshness must meet V2's 60- or 300-second limit.
5. Every source-inventory record has only the V2 provider/category/capability shape, request count 1,
   attempt count 1, bounded sanitized outcome code, allowed latency bucket, and a valid sanitized
   provenance hash. The audit must validate all records but must exclude `LATER_OBSERVATION` records
   from its aggregation and output.

A raw artifact mismatch, a self-consistent rewritten archive, unexpected file, unsafe text, secret-like
content, active lock, non-final state, nonzero safety counter, unsupported provenance pair, or any
later-label interpretation is a bounded source inconsistency, never an audit conclusion.

## 4. Allowed Decision-Time Projection

The audit may project only the following V2 facts. It must never output their numeric/boolean values;
only availability and bounded provenance aggregates are permitted.

| Audit field ID    | Fixed V2 path                         | Required source pair           |
| ----------------- | ------------------------------------- | ------------------------------ |
| `ASSET_AGE`       | `decisionTime.market.assetAgeSeconds` | `MARKET_CONTEXT` / `BEST_PAIR` |
| `ANCHOR_PRICE`    | `decisionTime.market.priceUsd`        | `MARKET_CONTEXT` / `BEST_PAIR` |
| `LIQUIDITY`       | `decisionTime.market.liquidityUsd`    | `MARKET_CONTEXT` / `BEST_PAIR` |
| `VOLUME_5M`       | `decisionTime.market.volume5mUsd`     | `MARKET_CONTEXT` / `BEST_PAIR` |
| `VOLUME_1H`       | `decisionTime.market.volume1hUsd`     | `MARKET_CONTEXT` / `BEST_PAIR` |
| `MOMENTUM_5M`     | `decisionTime.market.momentum5mPct`   | `MARKET_CONTEXT` / `BEST_PAIR` |
| `MOMENTUM_15M`    | `decisionTime.market.momentum15mPct`  | `MARKET_CONTEXT` / `BEST_PAIR` |
| `QUOTE_AVAILABLE` | `decisionTime.quote.available`        | `QUOTE_IMPACT` / `QUOTE`       |
| `QUOTE_IMPACT`    | `decisionTime.quote.priceImpactBps`   | `QUOTE_IMPACT` / `QUOTE`       |

The only allowed availability codes are the frozen V2 enum:

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

`AVAILABLE_AT_ANCHOR` means only that a valid decision-time fact was retained. It is not a favorable
market condition, a trading signal, or proof that a field should appear in a future protocol.

## 5. Fixed Aggregate Evidence Contract

The deterministic report may contain only these bounded aggregate sections, sorted lexicographically
by their declared enum keys and then UTC date where applicable:

1. **Archive identity and safety** — contract version, relative root, V2 protocol SHA, four artifact
   SHA values, `archiveIdentity: MATCHED`, final archive state, and literal zero/false safety facts.
2. **Field availability ledger** — for each of the nine audit fields and each fixed partition:
   total decision-time units, `AVAILABLE_AT_ANCHOR` count, count by every availability enum, and
   availability percentage rounded to six decimal places. No fact value, mint, unit, or slot appears.
3. **Missingness provenance ledger** — for each audit field, partition, availability code, fixed
   source category, and fixed source identifier: count and number of distinct UTC anchor dates. Rows
   with count zero are omitted; the row universe is bounded by the fixed field/provenance enums.
4. **Date-distribution ledger** — for each audit field and UTC anchor date: total units,
   available-at-anchor count, unavailable count, and availability percentage. It is bounded by the
   V2 fourteen consecutive UTC dates and must not include a time of day, mint, slot, or label.
5. **Decision-time source-inventory ledger** — aggregate only `DISCOVERY`, `MARKET_CONTEXT`, and
   `QUOTE_IMPACT` records by UTC date, category, provider, capability, outcome code, and latency
   bucket. It must not include `LATER_OBSERVATION`, raw hashes, raw timestamps, or payload facts.
6. **Systemic-deficiency ledger** — one fixed row per catalog field (`AGE`, `LIQUIDITY`,
   `VOLUME_5M`, `VOLUME_1H`, `MOMENTUM_5M`, `MOMENTUM_15M`, `QUOTE_IMPACT`) with the original 10.6B
   90%-per-partition coverage result, the dominant missingness signature if one exists, date support,
   and a mechanical qualification status. This is a measurement record, not a rule or threshold.

No result may include later-observation, candidate, score, strategy, risk, return, price, liquidity,
volume, momentum, quote-impact value, or outcome-derived field. The report may name a field but never
display its observed numerical or boolean contents.

## 6. Fixed Mechanical Qualification And Outcome Rules

For every one of the seven catalog fields, the audit must compute the original Phase 10.6B field
coverage requirement without invoking Phase 10.6B code:

```text
coverage passes in a partition iff AVAILABLE_AT_ANCHOR count >= ceil(90% of that partition's units)
```

A field has a **systemic, attributable measurement deficiency** only when all conditions below hold:

1. It fails the fixed 90% coverage requirement in at least one partition.
2. Within every failing partition, at least 80% of its unavailable facts share exactly one signature:
   `(availability, sourceCategory, sourceIdentifier)`.
3. The dominant signature is `UNSUPPORTED` or `UNAVAILABLE_AT_ANCHOR`; `NOT_REQUESTED`,
   `STALE_AT_ANCHOR`, `BUDGET_EXHAUSTED`, `PROVIDER_ERROR`, and `INVALID_VALUE` never qualify as a
   measurement-revision basis on their own.
4. The dominant signature occurs across at least 8 distinct UTC anchor dates in the complete cohort.
5. The same field/provenance pair is structurally valid under the V2 decision-time schema and no
   source-inventory, safety, identity, or label-quarantine check has failed.

The result selection is fixed and does not inspect later labels:

| Condition                                                                                                               | Required status                                           | Required next permitted action                        |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------- |
| One or more systemic, attributable measurement deficiencies                                                             | `MEASUREMENT_REVISION_READY_FOR_SEPARATE_PROTOCOL_REVIEW` | `DRAFT_MEASUREMENT_ONLY_PROTOCOL_FOR_SEPARATE_REVIEW` |
| No catalog field fails coverage, or every gap is attributable only to non-qualifying transient codes                    | `NO_ACTIONABLE_MEASUREMENT_CHANGE`                        | `PRESERVE_ARCHIVE_NO_NEW_PROTOCOL_AUTHORIZED`         |
| A valid final archive lacks the fixed partition/date evidence needed to evaluate the qualification rule                 | `MEASUREMENT_EVIDENCE_INSUFFICIENT`                       | `PRESERVE_ARCHIVE_MEASUREMENT_CONCLUSION_DEFERRED`    |
| Two or more qualifying signatures tie for a failing partition, or deterministic attribution cannot select one signature | `HUMAN_REVIEW_REQUIRED`                                   | `PRESERVE_ARCHIVE_HUMAN_REVIEW_REQUIRED`              |
| Any malformed, unsafe, non-final, inconsistent, identity-mismatched, or label-accessing source state                    | no report; bounded nonzero error                          | none                                                  |

For the tie rule, a signature ties only when its count equals the maximum count in the same
field/partition. The audit must not break that tie by later label, source outcome preference, a
provider preference, a field value, a manual override, or a new threshold.

Even a ready result must name only the qualifying field IDs and aggregate signatures. It must not
state how to change a provider, adapter, request budget, sampling rule, technical anchor, cadence,
population, score, threshold, risk rule, target, stop, or collection cap. Those choices belong only
in a later separately reviewed protocol-design phase.

## 7. Planned CLI, Scope Parsing, And Error Contract

The future command is intentionally strict:

```text
pnpm research:exploratory-cohort:measurement-audit -- \
  --archive-root=data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z \
  --format=markdown
```

Supported arguments are exactly:

- exactly one approved `--archive-root=<relative-path>`;
- optional exactly-once `--format=markdown|json`, defaulting to `markdown`; and
- optional exactly-once `--once` as a compatibility no-op.

The parser must reject duplicate, empty, traversal-shaped, absolute, symlink, multi-root, phase,
cohort, include, output, write, save, file, environment, database, runtime, scanner, strategy, risk,
provider, HTTP, URL, session, score, threshold, target, stop, observation, monitor, wallet, signing,
submission, PAPER, live, execution, order, fill, position, balance, or generic configuration options
before resolving the archive.

Every invalid or fail-closed source state must emit exactly one bounded public code and no Markdown or
JSON audit object:

```text
EXPLORATORY_MEASUREMENT_AUDIT_INVALID_SCOPE
EXPLORATORY_MEASUREMENT_AUDIT_UNSUPPORTED_ARCHIVE
EXPLORATORY_MEASUREMENT_AUDIT_SOURCE_INCONSISTENCY
EXPLORATORY_MEASUREMENT_AUDIT_LABEL_QUARANTINE_VIOLATION
```

`EXPLORATORY_MEASUREMENT_AUDIT_LABEL_QUARANTINE_VIOLATION` is mandatory if any implementation path
attempts to inspect a later-observation member or constructs a typed later-label value. It must not
fall back to Phase 10.6B, a permissive parser, or a partial report.

## 8. Planned Module Boundaries

Implementation must use a new isolated directory:

```text
backend/src/research-exploratory-measurement-audit/
```

Planned files and responsibilities:

| File                                                                   | Responsibility                                                                                                                     |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ExploratoryMeasurementAuditTypes.ts`                                  | Strict `DecisionTimeMeasurementAuditV1` schemas, fixed enums, output safety literals, and canonical report types.                  |
| `ExploratoryMeasurementAuditIdentity.ts`                               | The one approved root, V2 protocol identity, four raw artifact hashes, and fixed artifact names; no overrides in production.       |
| `ExploratoryMeasurementAuditConfig.ts`                                 | Exact CLI parsing and safe root resolution.                                                                                        |
| `ExploratoryMeasurementAuditErrors.ts`                                 | The four bounded public error codes.                                                                                               |
| `ExploratoryMeasurementAuditLoader.ts`                                 | Read-only identity/integrity validation and decision-time-only unit projection; later-observation containers are opaque/discarded. |
| `ExploratoryMeasurementAuditService.ts`                                | Pure availability, provenance, date/partition, source-inventory aggregation, systemic-deficiency, and outcome selection logic.     |
| `ExploratoryMeasurementAuditFormatter.ts`                              | Deterministic Markdown/JSON stdout formatter with no label-bearing fields.                                                         |
| `ExploratoryMeasurementAuditCli.ts`                                    | Thin stdout-only composition root with literal zero side-effect counters.                                                          |
| `ExploratoryMeasurementAudit.test.ts`                                  | Synthetic-fixture, label-quarantine, safety, deterministic-output, and fail-closed coverage.                                       |
| `backend/src/scripts/research-exploratory-cohort-measurement-audit.ts` | Thin CLI script entrypoint.                                                                                                        |

Root and backend `package.json` may add only the named
`research:exploratory-cohort:measurement-audit` script. No existing collector, analyzer, provider,
database, runtime, frontend, scheduler, strategy, or execution file may be modified for this phase.

## 9. Output Determinism And Disclosure Rules

The JSON contract must use `contractVersion: "1"`, an audit-only `generatedAt`, and a SHA-256
`contentFingerprint`. The fingerprint preimage is canonical JSON with `generatedAt` omitted and
`contentFingerprint` set to the empty string. All count maps, ledgers, artifact inventories, and
warning arrays must have documented canonical order.

Markdown and JSON must disclose, before all other sections:

```text
archiveIdentity: MATCHED
provider/RPC/HTTP calls: 0
database reads/writes: 0/0
filesystem writes: 0
runtime/session/order/fill/position actions: 0/0/0/0
wallet loaded / signing / submission: false / false / false
later-label members interpreted: 0
```

The report must also disclose that source-inventory aggregate co-occurrence is not a per-unit causal
join. A source record can contextualize a date/category/capability but cannot prove why a particular
field for a particular unit was unavailable unless the field's own bounded availability/provenance
signature states it.

No report value may be used as a candidate predicate, provider recommendation, strategy signal, or
authorization. A ready status must explicitly state that it supports only a separate human-reviewed
measurement-protocol draft.

## 10. Required Synthetic Tests And Verification

All tests must create controlled temporary fixtures copied from source-controlled protocol material.
They must never read the real V2 archive, call a provider, load an environment value, access a
database/runtime, create a scheduler, or write outside their temporary fixture roots.

Required test coverage:

1. Strict parser acceptance for only the named root, one format, and one compatibility `--once`;
   reject duplicate `--once` and every forbidden option family.
2. Root containment, symlink, unexpected-file, active-lock, non-final, V2-protocol mismatch, each
   individual hard-pinned artifact mismatch, and a coherently rewritten fixture with recomputed
   internal hashes all fail closed.
3. Matching injected fixture identity passes; the production CLI exposes no identity override.
4. Zero-safety state, source-inventory sanitization/hash checks, provider category/capability shape,
   fixed fact provenance, availability/value consistency, and freshness checks all fail closed when
   invalid.
5. Every audit field and availability enum appears in the deterministic aggregate ledger; numeric and
   boolean fact values, mint, unit, slot, raw timestamp, source hash, and raw payload text never
   appear in JSON or Markdown.
6. Coverage tests prove the fixed 90%-per-partition calculation, 80% dominant-signature rule,
   allowed qualifying codes, 8-date support, transient-code rejection, tie-to-human-review outcome,
   no-actionable outcome, and evidence-insufficient outcome.
7. Source-inventory tests prove that `LATER_OBSERVATION` rows are hash-validated but excluded from
   every output aggregate and outcome condition.
8. Label-quarantine tests create otherwise source-consistent fixtures with divergent 3/5/15/60-minute
   values, availability, timestamps, and reasons. After each fixture receives its matching injected
   identity, its decision-time measurement ledgers and outcome must agree; no output may contain a
   later-label field name or value.
9. Static dependency tests prove no imports of collector/gateway/provider/database/runtime/strategy/
   PAPER/wallet/execution modules or any Phase 10.6B loader/service/formatter. The only permitted
   `laterObservations` reference is the audited loader's opaque top-level discard boundary; no code
   may reference `returnPct`, later availability enums, or horizon values.
10. Determinism tests prove canonical JSON excluding `generatedAt` and blanking `contentFingerprint`
    is byte-stable, Markdown/JSON agreement, fixed aggregate order, stdout-only output, and zero
    side-effect counters.

Required implementation verification, before review:

```text
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm --filter @nexustrade/backend exec vitest run src/research-exploratory-measurement-audit/ExploratoryMeasurementAudit.test.ts
corepack pnpm check:secrets
```

Do not run the future audit against the real archive during implementation. Do not use broad
repository test wrappers if they invoke database/runtime surfaces outside this synthetic-only phase.

## 11. Implementation Sequence

Update this checklist immediately after each completed task with a checked box and concise
verification note. Do not implement or run the audit until the user separately approves this detailed
checklist. Implementation approval will not authorize a real-archive audit run.

### A. Freeze authority, scope, and report contract

- [x] Create this detailed planning checklist and update Phase 10+ handoff documentation.
      Note: the checklist fixes the one immutable V2 root, identity, label quarantine, bounded
      measurement-only outcomes, and downstream default-deny boundary before any audit code exists.
- [x] Add strict audit enums, schemas, hard-pinned identity, canonical fingerprint procedure, and
      bounded error contract without a production override.
      Note: the isolated module fixes the one root, V2 SHA, all four artifact SHAs, bounded status and
      error enums, and the canonical preimage that omits `generatedAt` and blanks `contentFingerprint`.
- [x] Implement exact CLI parsing, safe root containment, and explicit rejection of all write,
      provider, database, runtime, strategy, monitoring, and execution options.
      Note: `research:exploratory-cohort:measurement-audit` accepts only the fixed relative root, one
      format, and one compatibility `--once`; it has no output-file or identity-override surface.

### B. Build the isolated decision-time-only reader and audit services

- [x] Implement a label-quarantined loader that verifies the immutable V2 identity and projects only
      the allowed decision-time facts, safe manifest fields, and non-later source inventory.
      Note: the loader lexically discards the opaque top-level `laterObservations` container before
      parsing a decision-time unit or summary projection; it does not construct or retain a typed
      later-label value.
- [x] Implement strict safety, provenance, availability/value, freshness, source-hash, and
      source-inventory validation; fail closed before any report on inconsistency.
      Note: active/non-final/unsafe/identity-mismatched artifacts, unsupported source pairs, invalid
      provenance hashes, bad safety counters, stale available facts, and inconsistent summary facts
      emit bounded nonzero errors before formatting.
- [x] Implement deterministic availability, provenance, date/partition, and source-inventory
      aggregate ledgers without retaining individual-unit output rows.
      Note: output contains only bounded enum/date/count rows; decision-time values, mints, unit IDs,
      slots, source hashes, timestamps, payloads, and label fields are excluded.
- [x] Implement the fixed 90% coverage, 80% dominant signature, 8-date support, tie, qualification,
      outcome, and default-deny next-action rules without a candidate or protocol recommendation.
      Note: a ready result can name only a systemic measurement deficiency and preserves the separate
      human protocol-design gate.
- [x] Implement deterministic Markdown/JSON stdout formatting and explicit label-quarantine
      disclosure.
      Note: both formats report `archiveIdentity: MATCHED`, literal zero action counters, and
      `later-label members interpreted: 0` before aggregate evidence.

### C. Prove isolation, determinism, and label quarantine

- [x] Add controlled temporary synthetic fixtures only; prove the focused suite does not read the
      real archive or invoke a provider, database, runtime, scheduler, or execution surface.
      Note: all seven focused tests create and remove only isolated temporary fixture roots and copy
      source-controlled V2 protocol bytes; no test uses the named archive root.
- [x] Add identity, containment, unsafe source, finality, source-hash, provenance, freshness, and
      zero-safety fail-closed tests.
      Note: the suite covers parser scope rejection, active/unexpected archives, each four-file
      identity mismatch, a self-consistently rewritten fixture, source hash corruption, and stale
      available decision-time evidence.
- [x] Add coverage, dominant-signature, date-support, transient-code, no-actionable,
      evidence-insufficient, and tie-to-human-review outcome tests.
      Note: synthetic evidence exercises all four bounded outcomes and the frozen coverage,
      dominance, qualifying-code, and date rules.
- [x] Add label-divergence and static dependency tests proving later labels cannot affect the audit
      ledger, outcome, fingerprint preimage apart from whole-file identity, or output text.
      Note: fixtures with deliberately divergent opaque label containers have identical decision-time
      ledgers and outcome while retaining distinct whole-file identities.
- [x] Add deterministic-output, Markdown/JSON agreement, bounded-disclosure, stdout-only, and
      zero-side-effect tests.
      Note: fixed audit times preserve the canonical fingerprint, JSON round-trips, Markdown reports
      the quarantine counter, and static checks reject prohibited imports and write APIs.
- [x] Run the five focused verification commands in Section 10 without a real-archive audit run.
      Note: 2026-09-04 passed `format:check`, `lint`, `typecheck`, the focused 7-test Vitest suite,
      and `check:secrets`; no real-archive audit command was run.

### D. Separate run approval and downstream boundary

- [x] Present the exact root, four immutable file hashes, fixed command, and audit safety boundary
      for separate explicit user approval before any real-archive audit run.
      Note: the user explicitly approved the one fixed V2 root after review of the hard-pinned,
      stdout-only implementation.
- [x] Run only the separately approved stdout-only command; preserve its stdout outside the source
      archive and do not alter the archive.
      Note: the 2026-09-04 Markdown run verified all four exact artifacts, returned
      `archiveIdentity: MATCHED`, and made 0 provider/RPC/HTTP calls, database reads/writes,
      filesystem writes, runtime/session/order/fill/position actions, and wallet/signing/submission
      actions. The archive remains unchanged.
- [x] If the result is measurement-revision-ready, draft no protocol automatically. Require a
      separate human-authored protocol, detailed collection checklist, static validation, and named
      collection authorization. Do not create Phase 10.6C work from this audit.
      Note: the result is measurement-revision-ready for replicated `LIQUIDITY`, `MOMENTUM_5M`, and
      `MOMENTUM_15M` availability signatures only. No protocol, collection, candidate, Phase 10.6C,
      strategy, PAPER, or execution work was created.

## 12. Acceptance Gates

The implementation may be presented for review only when all completed implementation tasks and the
following statements remain true:

```text
supported archive roots = exactly one hard-pinned V2 root
raw artifact identity = all four hashes matched before report
provider/RPC/HTTP calls, database reads/writes, filesystem writes, runtime actions = 0 / 0 / 0 / 0
later-observation members interpreted, output, or used in any condition = 0
decision-time fact values, mints, unit IDs, slots, and raw provider material in output = 0
measurement revision ready authorizes protocol, collection, candidate, Phase 10.6C, PAPER, or promotion = no
BUY/WATCH defaults, F65E closure, strategy, targets/stops, and monitoring settings changed = no
```

After implementation, the audit still requires separate explicit approval for the named immutable
archive. Any audit result remains research documentation only and cannot authorize a successor study,
provider expansion, strategy change, PAPER execution, or live trading.

## 13. Implementation Closeout

Phase 10.6B.1 is implemented and verified with synthetic fixtures only. The new isolated audit module
hard-pins the approved V2 protocol and four raw archive artifacts, produces Markdown or JSON only on
stdout, and denies every provider, database, runtime, scheduler, archive-write, strategy, PAPER,
wallet, signing, submission, order, fill, and position surface.

The separately approved production command ran once against
`data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z` at
`2026-09-04T07:54:50.351Z`, with content fingerprint
`843d1d27aee452f7fcccb000128fec10a38d0fbe80652fc9eb50511a9447b486`. It matched the pinned V2
protocol and all four exact archive hashes. It found three systemic, attributable measurement
deficiencies: `LIQUIDITY` was `UNAVAILABLE_AT_ANCHOR` in every unavailable fact across both
partitions and nine UTC dates; `MOMENTUM_5M` and `MOMENTUM_15M` were `UNSUPPORTED` in every unit
across both partitions and nine UTC dates.

The result is `MEASUREMENT_REVISION_READY_FOR_SEPARATE_PROTOCOL_REVIEW`, which authorizes only a
separate human-reviewed measurement-protocol draft. It does not authorize collection, Phase 10.6C,
strategy/default/threshold changes, PAPER execution, or any wallet or transaction action.
