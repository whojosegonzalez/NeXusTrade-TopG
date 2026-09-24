# NeXusTrade Phase 10.6B.3 Detailed Implementation Checklist

## V3 Final Measurement Capability Analysis And Remediation Decision

Status: Implementation, source-only final identity binding, and the focused synthetic slot-ledger
integrity repair are complete. On 2026-09-18, the separately approved replacement stdout-only run
matched the exact pinned V3 archive and produced `MEASUREMENT_CAPABILITY_NOT_CONFIRMED`: frozen
liquidity availability failed in both partitions, while cohort sufficiency and both momentum
objectives passed. This is a non-authorizing measurement-protocol finding only. The archive,
protocol, scheduler, strategy, and execution state remain unchanged.

H1 engineering verification was separately completed on isolation in `a0bfdf9` (245 tests); that implementation was not present in the historical main-branch run. See the [integration record](./Phase-10.6H-Main-Isolation-Integration.md) for combined-source validation and provenance.

Phase 10.6B.3 is deliberately a post-collection, archive-only measurement-capability assessment. It
does not reinterpret the interim Sep 9 operational-quality snapshot as a strategy finding, does not
amend the active V3 protocol/root/schedule, and does not pre-register a V4 successor.

## 1. Purpose And Strict Question

After the named V3 archive is final and immutably bound, Phase 10.6B.3 asks only:

```text
Did the frozen V3 measurement-only cohort meet its pre-registered decision-time measurement
availability, freshness, provenance, population-independence, and safety gates; if not, what
bounded final archive facts must be preserved for a separate human measurement-protocol decision?
```

It is not a profitability analysis, strategy validation, signal search, token ranking, provider test,
candidate selection, Phase 10.6C study, threshold/risk/target/stop decision, PAPER pilot, or live
readiness review. It may never calculate or use returns, later labels, P/L, MFE, MAE, target/stop
ordering, BUY/WATCH/SKIP, score, risk, strategy decision, or a measurement value as a selection input.

The final analyzer may emit exactly one of these non-authorizing statuses:

```text
MEASUREMENT_CAPABILITY_CONFIRMED
MEASUREMENT_CAPABILITY_NOT_CONFIRMED
MEASUREMENT_EVIDENCE_INSUFFICIENT
```

| Status                                 | Mechanical meaning                                                                                                              | Only permitted next action                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `MEASUREMENT_CAPABILITY_CONFIRMED`     | The immutable final V3 archive satisfies every frozen V3 capability, independence, provenance, freshness, and zero-safety gate. | Preserve the archive and require a separate research-governance decision; no strategy or collection follows automatically.             |
| `MEASUREMENT_CAPABILITY_NOT_CONFIRMED` | The final archive is internally valid and sufficient to evaluate, but one or more frozen V3 measurement gates fail.             | Preserve the final deficiency ledger; a separate human may decide whether a new measurement-only protocol-planning phase is warranted. |
| `MEASUREMENT_EVIDENCE_INSUFFICIENT`    | The archive is valid and final but lacks the frozen minimum population/partition/date evidence required to classify capability. | Preserve the archive; no replacement, extension, protocol, or collection is authorized.                                                |

No status authorizes a V4 protocol, provider expansion, provider retry/fallback, additional collection,
Phase 10.6C, strategy/default/threshold change, PAPER operation, session, order, fill, position, P/L,
wallet, signing, submission, or live-trading action.

## 2. Non-Negotiable Safety And Authority Boundary

Implementation, synthetic verification, final identity binding, and a later real run must preserve all
of the following:

- Zero provider/RPC/HTTP calls, including DEXSCREENER, Jupiter, browser, loopback, adapter, health,
  smoke, quote, discovery, or provider-configuration calls.
- Zero database reads/writes, migrations, cache access, runtime/scanner/watchlist action, session
  action, dashboard export, scheduler change, filesystem/archive write, generated report file, or
  checkpoint. Markdown or JSON is emitted only to stdout.
- No imports, construction, or invocation of the V3 collector/gateway, any provider adapter/router,
  database, runtime, strategy, risk, PAPER, session, order, fill, position, wallet, signing,
  submission, scanner, watchlist, quote diagnostic, or Phase 10.6B/10.6B.1 analyzer module.
- No environment loading, credential/API-key access, wallet/account/balance access, transaction
  simulation, signing, submission, or market request.
- No active-archive read by Phase 10.6B.3. Before the archive is final and separately approved, its
  production CLI must fail closed before opening the archive. Synthetic tests use only temporary test
  fixtures.
- No raw provider payload, URL, host, mint, unit ID, slot ID, selection hash, raw source timestamp,
  source hash, numerical price/liquidity/momentum value, credential-like content, or unbounded free
  text may appear in stdout.
- Later labels are absent by V3 design. Even so, the reader must reject rather than parse any
  `laterObservations`, return, target, stop, P/L, score, risk, strategy, or label-shaped member in a
  V3 unit or summary. The analyzer must not rely on V3's absence of labels as permission to add such
  a projection later.
- BUY=90 / WATCH=70, F65E@v1 closure, strategy defaults, targets, stops, monitoring cadence, and
  PAPER-disabled state remain unchanged.

An active lock, non-final archive, unknown final artifact, identity mismatch, unsafe content,
nonzero safety counter, prohibited field, schema inconsistency, or unexpected dependency is a
fail-closed error, never an analysis result.

## 3. Fixed Future Input Scope And Identity-Binding Gate

The only eventual production root is exactly:

```text
data/archive/phase10.6a/measurement-v3-20260904-2100Z/
```

The only accepted V3 protocol source is exactly:

```text
docs/research-protocols/phase10.6a-exploratory-cohort.v3.json
SHA-256: dd57285927474e3e646bd4a52c5d37fbb550d5cb73f836db69b02827c5360458
```

The analyzer will accept only a final root with no `collection.lock`, no temporary files, and exactly
these final artifacts:

```text
cohort-manifest.v1.json
units.v1.ndjson
source-inventory.v1.json
collection-summary.v1.json
```

The four final V3 SHA-256 values are intentionally unknown while the collection is active. Therefore:

1. Initial implementation must expose no production identity override and must default-deny with
   `MEASUREMENT_COHORT_ANALYSIS_IDENTITY_NOT_REGISTERED` before it reads an archive.
2. Synthetic tests may inject a complete expected identity for temporary fixture roots only.
3. After V3 reaches a final state, a separate, source-only identity-binding review may record the
   protocol SHA and four raw artifact hashes as code literals. It requires its own explicit approval,
   source review, and commit; it does not write or alter the archive.
4. Only after that binding, a separate explicit approval may permit one stdout-only run against this
   exact root. A self-consistently rewritten archive must fail because its raw artifact hashes differ
   from the registered literals.

No glob, phase/cohort include flag, archive-root override, identity-file override, URL, absolute path,
symlink escape, alternate protocol, alternate launch record, or archive union is permitted.

## 4. Final-Archive Integrity And Allowed Projection

Before any aggregate or status, the future reader must verify all of the following without writing:

1. Repository containment, direct non-symlinked root/artifact paths, exact artifact set, no active
   lock, and a final archive outcome of either `COHORT_COMPLETE` or
   `MEASUREMENT_COHORT_DATA_INSUFFICIENT`.
2. Exact V3 protocol bytes/SHA; manifest launch root/start/protocol identity; final summary; final
   artifact inventory; manifest/summary hashes; and all four registered raw artifact SHA literals.
3. Immutable lifecycle consistency: strictly ascending, unique absolute slot IDs/indices with each
   anchor calculated from its own slot index; a bounded unrecorded coordinate is permissible and is
   never a catch-up/replacement row. Duplicate, unordered, mismatched-ID, mismatched-anchor, or
   replacement/catch-up evidence fails closed. Maximum attempted slots remains 168 and request counts
   remain within the fixed 168 `DISCOVERY` / 672 `MARKET_CONTEXT` caps.
4. Literal zero/false database, session, order, fill, position, wallet, signing, and submission facts
   in manifest and final summary.
5. V3 unit schema and safe projection consistency: one canonical identity, one partition, one UTC
   anchor date, `DEXSCREENER_TOKEN_PROFILE` selection kind, four fixed price snapshots
   (`-15/-10/-5/0`), and no prohibited label-shaped member.
6. The three permitted objectives only: `LIQUIDITY`, `MOMENTUM_5M`, and `MOMENTUM_15M`; `LIQUIDITY`
   is always `MARKET_CONTEXT` / `BEST_PAIR`; available momentum is `LOCAL` / `FORMULA`, while
   unavailable momentum inherits `MARKET_CONTEXT` / `BEST_PAIR` from its failed price snapshot;
   the eight-code availability enum, finite value rule for availability, no value for missingness,
   and 60-second freshness limits remain frozen.
7. Sanitized source-inventory shape only: `DEXSCREENER`, `DISCOVER_TOKENS` / `BEST_PAIR`, category,
   one request/attempt, bounded outcome code and latency bucket, and a valid SHA-256 source hash.
   Raw hashes are validated but never emitted.

The permitted analysis projection is limited to aggregate counts by objective, partition, UTC date,
availability code, fixed provenance pair, provider category/capability/outcome/latency bucket, and
frozen gate result. Numerical measurement values are validated only for type/finite consistency and
are immediately discarded; they are never aggregated, ranked, correlated, emitted, or used for a
status.

## 5. Frozen Mechanical Gate Evaluation

Phase 10.6B.3 must reproduce only the gates already fixed in V3; it may not add a remedial threshold
or tune a gate based on the final data.

### 5.1 Cohort sufficiency and independence

```text
maximum attempted slots              = 168
minimum valid units                  = 72
planned valid units                  = 96
minimum distinct mints               = 72
minimum UTC dates                    = 8
maximum valid-unit share per UTC day = 20%
minimum valid units per partition    = 32
minimum UTC dates per partition      = 4
```

The report must distinguish “minimum evidence for assessment” from “planned capability target.” It
must not invent a replacement for a missed/invalid slot or silently treat a larger final cohort as a
reason to loosen a gate.

### 5.2 Objective capability gates

For each objective and each partition:

```text
availabilityPct = (AVAILABLE_AT_ANCHOR / VALID_UNITS_IN_PARTITION) * 100
passes availability iff availabilityPct >= 90
passes date support iff AVAILABLE_AT_ANCHOR appears on >= 4 UTC dates in that partition
passes provenance iff every fact has its frozen V3 category/source-identifier pair
passes freshness iff every available fact is within 60 seconds of its scheduled observation
```

The report must include every availability enum count, but it may never use the reason code to infer
a provider fix, retry, routing choice, selection predicate, strategy condition, or market claim.

### 5.3 Status selection

```text
SOURCE INCONSISTENCY / UNSAFE / NONFINAL / UNBOUND IDENTITY -> bounded error, no report
valid units < 72 OR distinct mints < 72 OR UTC dates < 8 OR either partition has < 32 units
  OR either partition has < 4 UTC dates OR any UTC date exceeds 20% of valid units
                                                               -> MEASUREMENT_EVIDENCE_INSUFFICIENT
otherwise every objective passes every frozen gate              -> MEASUREMENT_CAPABILITY_CONFIRMED
otherwise                                                       -> MEASUREMENT_CAPABILITY_NOT_CONFIRMED
```

H1 source-contract review: date concentration belongs to the frozen independence requirements in
Section 5.1 and the pinned protocol. The explicit 20% branch above repairs an omission in this
summary; it preserves the existing service classification and does not retune a gate. The planned
96-unit target is reported separately: 72–95 units can support an assessment if every minimum and
objective gate passes. A collector `COHORT_COMPLETE` assertion requires 96 units and its completion
gates; an insufficient collector outcome can also result from stale-lock recovery and is not itself
the analyzer's capability decision. Final-state eligibility still requires the separate Section D review.

`MEASUREMENT_CAPABILITY_NOT_CONFIRMED` must identify only the failed frozen gate IDs and aggregate
availability/provenance counts. It must explicitly state that no particular V4 design, provider,
cadence, population, request cap, or collection is selected.

## 6. Deterministic Stdout Report Contract

Markdown and JSON must contain the same bounded content, sorted by declared enum order, then
partition, then UTC date. JSON uses `contractVersion: "1"`, an audit-only `generatedAt`, and a
`contentFingerprint`; its canonical preimage omits `generatedAt` and sets `contentFingerprint` to
the empty string.

The report must disclose first:

```text
archiveIdentity: MATCHED
archiveFinality: MATCHED
provider/RPC/HTTP calls: 0
database reads/writes: 0/0
filesystem writes: 0
runtime/session/order/fill/position actions: 0/0/0/0
wallet loaded / signing / submission: false / false / false
later-label members interpreted: 0
```

Permitted sections are exactly:

1. **Identity and safety** — relative root, V3 protocol SHA, four artifact hashes, final archive
   outcome, final `analysisStatus`, and literal zero safety counters.
2. **Cohort sufficiency** — attempted slots, valid units, distinct mints, partition totals, UTC-date
   count, date concentration, and frozen sufficiency/independence gate booleans.
3. **Objective availability ledger** — for each objective/partition: total units, every availability
   enum count, availability percent, date support, and frozen availability/provenance/freshness gate
   booleans. Never emit a measurement value or row-level observation.
4. **Missingness and source-evidence ledger** — bounded aggregate counts by objective, partition,
   availability, fixed provenance pair, UTC date; and source inventory by date/category/capability/
   outcome/latency. Never emit a raw timestamp/hash, mint, URL, or payload.
5. **Final gate ledger** — the exact failed/pass frozen gate IDs and a fixed next-action sentence for
   the selected non-authorizing status.

The report must never use causal language about a specific provider response and a specific unit. It
must explain that source-inventory aggregates contextualize collection health but do not create a
per-unit causal join.

## 7. Planned Isolated Module And CLI

Implementation must use a new isolated directory:

```text
backend/src/research-measurement-cohort-analysis/
```

| File                                                         | Responsibility                                                                          |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `MeasurementCohortAnalysisTypes.ts`                          | Strict V3 final-archive schemas, fixed enums, projected aggregate/report types.         |
| `MeasurementCohortAnalysisIdentity.ts`                       | Exact root/protocol/artifact names and default-deny production identity binding.        |
| `MeasurementCohortAnalysisConfig.ts`                         | Strict no-root-override CLI parser.                                                     |
| `MeasurementCohortAnalysisErrors.ts`                         | Bounded public error codes only.                                                        |
| `MeasurementCohortAnalysisLoader.ts`                         | Read-only finality, raw identity, safe projection, and label-shaped-content quarantine. |
| `MeasurementCohortAnalysisService.ts`                        | Pure frozen-gate calculations and status selection.                                     |
| `MeasurementCohortAnalysisFormatter.ts`                      | Canonical Markdown/JSON stdout formatting and fingerprint.                              |
| `MeasurementCohortAnalysisCli.ts`                            | Thin composition root with literal zero side-effect counters.                           |
| `MeasurementCohortAnalysis.test.ts`                          | Temporary-fixture, identity, quarantine, and deterministic-output tests.                |
| `backend/src/scripts/research-measurement-cohort-analyze.ts` | Thin stdout/stderr entrypoint.                                                          |

Root and backend `package.json` may add only:

```text
research:measurement-cohort:analyze
```

The eventual command accepts only optional exactly-once `--format=markdown|json` (default
`markdown`) and one compatibility `--once`. It accepts no archive, protocol, identity, output, write,
save, environment, provider, HTTP, URL, database, runtime, strategy, score, risk, target, stop,
monitor, scheduler, wallet, signing, submission, PAPER, live, session, order, fill, position, or
generic configuration option.

Until final identity binding is deliberately added, any invocation must fail before opening an archive:

```text
MEASUREMENT_COHORT_ANALYSIS_IDENTITY_NOT_REGISTERED
```

Other public error codes are bounded and emit no report object:

```text
MEASUREMENT_COHORT_ANALYSIS_INVALID_SCOPE
MEASUREMENT_COHORT_ANALYSIS_ARCHIVE_NOT_FINAL
MEASUREMENT_COHORT_ANALYSIS_SOURCE_INCONSISTENCY
MEASUREMENT_COHORT_ANALYSIS_LABEL_QUARANTINE_VIOLATION
```

## 8. Synthetic-Only Test Plan

All tests use injected fake identity, fixed clock, source-controlled V3 bytes, and temporary fixture
roots only. They must not read the active real V3 root, access a provider, construct a gateway, load
environment values, access a database/runtime, create a task, or write outside temporary fixtures.

Required tests:

1. Strict parser accepts only one optional format and one `--once`; rejects duplicates and every
   disallowed option family before a source or archive read.
2. Production identity is unset by default and rejects before archive access; synthetic injected
   identity can pass a matching temporary final fixture.
3. Root containment, symlink, unexpected artifact, active lock, nonfinal manifest, wrong final state,
   missing final summary, and each individual artifact hash mismatch fail closed.
4. A coherently rewritten fixture with recomputed internal manifest/summary hashes still fails against
   its injected external raw identity.
5. V3 protocol/launch/archive-root mismatch; bad final inventory; a valid bounded unrecorded slot;
   duplicate, unordered, mismatched-ID, or mismatched-anchor slot evidence; duplicate mint;
   replacement or catch-up shape; cap excess; invalid source inventory; nonzero safety counter;
   invalid availability value shape; stale available fact; wrong provenance; and prohibited
   label-shaped member are covered with the permitted/pass or fail-closed behavior respectively.
6. Pure-gate fixtures prove all three result statuses, the exact 90% objective gate, 60-second
   freshness, four-date objective support, 72/96 unit distinction, 72 distinct mints, eight-date
   independence, 20% date concentration, and 32-unit/four-date partition requirements.
7. A fixture where availability is below gate but numerical values differ must preserve the same
   aggregate report/status, except byte-derived archive identity and content fingerprint; a fixture
   with changed numeric values but identical availability must not
   expose those values in Markdown or JSON.
8. Output tests prove deterministic canonical JSON excluding `generatedAt` and blanking
   `contentFingerprint`, Markdown/JSON agreement, bounded order, literal zero counters, and absence
   of mints, IDs, raw hashes/timestamps, URLs, labels, scores, risk, strategy, price, liquidity, and
   momentum values.
9. Static dependency tests reject imports of the collector/gateway/provider/database/runtime/strategy/
   PAPER/wallet/execution modules and reject environment loading, network APIs, write APIs, scheduler
   APIs, and use of V2 analyzer modules.
10. CLI tests prove stdout-only success and bounded stderr-only failures with no archive write,
    generated report, or identity override.

## 9. Required Implementation Verification

Before review, run only these local synthetic/source checks:

```text
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm --filter @nexustrade/backend exec vitest run --config vitest.measurement-analysis.config.ts
corepack pnpm check:secrets
```

Do not run the future analyzer against the active V3 root during implementation. Do not contact a
provider, inspect/alter the scheduler, create a binding from interim data, or run a broad workflow
that reaches database/runtime/PAPER behavior.

For H1 worktree verification, use the dedicated configuration above to disable Vite environment-file
loading. Set temporary paths and exclude local dependency caches as recorded in the
[H1 verification record](./Phase-10.6H-H1-Verification.md). That record provides direct local-binary
equivalents when provisioning Corepack would affect shared host state.

## 10. Implementation Sequence

Update this checklist immediately after each completed task with a checked box and concise note.
Synthetic-only implementation was approved and completed as recorded below. Final-state review,
source-only identity binding, and the real analyzer run retain their separate Section D gates.
The H1 closeout below records synthetic-only implementation and verification; it performs no real run.

### A. Freeze final-only scope and handoff documentation

- [x] Create this detailed Phase 10.6B.3 planning checklist and update Phase 9+ handoff documents.
      Note: the checklist is limited to the one future final V3 root, frozen protocol SHA, final-only
      identity binding, deterministic aggregate capability assessment, and default-deny downstream
      boundary. It neither reads nor modifies the active V3 archive.
- [x] Obtain separate implementation approval before adding any analyzer source or package script.
      Note: the user explicitly approved synthetic-only Phase 10.6B.3 implementation on 2026-09-09;
      that approval excludes the active archive, final identity binding, and real analyzer run.
- [x] Reconfirm at implementation start that the active V3 root/schedule remains outside the working
      scope and that production identity binding is intentionally unset.
      Note: implementation reads only source-controlled protocol material and temporary test fixtures.
      It does not inspect, alter, or open the active named root.

### B. Implement only an isolated, default-deny analyzer after approval

- [x] Add strict types, identity/config/error modules, and a production identity-unregistered guard;
      do not modify collector, protocol, provider, database, runtime, strategy, PAPER, or scheduler
      modules.
      Note: the new isolated module pins the exact future V3 root/protocol SHA but leaves the four
      production artifact hashes undefined. The CLI rejects with
      `MEASUREMENT_COHORT_ANALYSIS_IDENTITY_NOT_REGISTERED` before resolving an archive.
- [x] Add read-only finality/integrity validation and label-shaped-content quarantine; project only
      bounded V3 availability/provenance/population/source-inventory aggregates.
      Note: the reader validates final-only artifact shape, protocol/launch/root identity, raw
      injected identity hashes, slot/unit/source consistency, frozen V3 provenance/freshness, zero
      safety facts, and label/unsafe-content quarantine before discarding every numerical value.
- [x] Add pure frozen-gate service and deterministic formatters; no numerical field aggregation,
      causal provider join, remediation recommendation, or candidate logic.
      Note: the service emits only frozen sufficiency, availability, date-support, provenance,
      freshness, missingness, and aggregate source ledgers. Its canonical fingerprint excludes
      `generatedAt` and blanks `contentFingerprint` in the hash preimage.
- [x] Add the one stdout-only CLI/script with no archive/protocol/identity/output override surface.
      Note: `research:measurement-cohort:analyze` accepts only `--format=markdown|json` and one
      compatibility `--once`; the production identity guard remains intentionally active.

### C. Prove the boundary with synthetic fixtures only

- [x] Complete every Section 8 requirement with named temporary-fixture tests and injected identities.
      Note: completed 2026-09-10 with 245 tests across five files. The
      [H1 requirement matrix](./Phase-10.6H-H1-Verification.md#section-8-requirement-matrix) maps all
      ten requirements to named cases, bounded errors, source fixes, and verification limits.
- [x] Run all five Section 9 verification commands and record results here. Do not read the active
      V3 root or run the production CLI.
      Note: on 2026-09-09, `format:check`, `lint`, `typecheck`, the focused 11-test Vitest suite,
      and `check:secrets` all passed. `git diff --check` also passed. No analyzer invocation against
      the active V3 root, provider call, scheduler action, database/runtime action, or archive write
      occurred.
- [x] Present implementation source, test evidence, exact default-deny behavior, and the still-unbound
      identity state for review. Implementation approval does not authorize a real analysis.
      Note: implementation source is committed in `3d5b711` and its handoff status in `bdbf60f`.
      H1 verification was completed separately in isolation (later committed as `a0bfdf9`). Main performed the Section D approvals and run without that implementation; the integrated source must be validated independently.

- [x] Complete H1 and rerun the required Section 9 checks for the resulting revision. Record each
      requirement's test evidence and any remaining source-contract ambiguity. Do not change frozen
      V3 gates to make a test pass or use active-archive observations to resolve ambiguity.
      Note: completed 2026-09-10 on `d747af6` plus the uncommitted H1 closeout patch. All 245 tests,
      full repository formatting, lint, backend/shared/frontend and harness typechecks, secret scan,
      and diff checks pass. The [verification record](./Phase-10.6H-H1-Verification.md) records
      contract interpretations, the formatting-baseline repair, and source identity. At that H1 checkpoint, production identity remained undefined; no real archive was read or operational checkout changed.

- [x] Repair the absolute slot-coordinate validation using temporary synthetic fixtures only.
      Note: approved on 2026-09-18 after the one real analysis attempt failed closed with
      `MEASUREMENT_COHORT_ANALYSIS_SOURCE_INCONSISTENCY`. The repair must accept a bounded
      unrecorded coordinate while still rejecting duplicate, unordered, mismatched-ID, and
      mismatched-anchor slot evidence. Completed with separate ledger/unit duplicate guards and a
      13-test focused synthetic suite; it did not reread the final archive or run the production CLI.
- [x] Run the approved focused repair verification and record its evidence.
      Note: on 2026-09-18, the 13-test `MeasurementCohortAnalysis.test.ts` suite, backend
      typecheck, lint, secret scan, and `git diff --check` all passed. These checks used only
      source and temporary fixture data; no production analyzer invocation, provider, database,
      scheduler, or archive action occurred.

### D. Finalization, identity binding, and one real run remain separate

- [x] After the V3 scheduler has completed its frozen collection, perform only a separately approved
      read-only final-state/lock/scheduler review. Do not add a slot, retry, replacement, closeout,
      or manual collector invocation.
      Note: completed before final identity binding. The archive was final and unlocked; no collector,
      scheduler, provider, or archive action was performed.
- [x] After Section C verification completion, obtain separate approval to capture the four final
      artifact SHA-256 values, add the reviewed source-only production identity binding, and commit
      it. Do not write to the archive.
      Note: main binding was committed as `6f8ae85`; H1 was completed only on isolation, not integrated into the source used for this historical action. The production identity now permits only the
      exact V3 root and the four reviewed artifact hashes.
- [x] Obtain separate explicit approval for one stdout-only analysis of the exact final root. Run no
      other archive, provider, scheduler, strategy, PAPER, or execution command.
      Note: one approved 2026-09-18 attempt read the exact pinned archive and failed closed with
      `MEASUREMENT_COHORT_ANALYSIS_SOURCE_INCONSISTENCY` before it emitted a report. It caused zero
      provider, database, runtime, scheduler, archive-write, or execution actions. After the
      synthetic repair, one separately approved replacement run succeeded against the same exact
      pinned root and emitted JSON to stdout only.
- [x] Record final report identity, status, bounded gate facts, and literal zero side-effect counters
      in handoff documentation. Do not draft a V4 protocol or begin Phase 10.6C automatically.
      Note: the replacement report recorded `archiveIdentity: MATCHED`, `archiveFinality: MATCHED`,
      the source-controlled four-artifact V3 identity, and content fingerprint
      `3cafcf1655e1bdf6bd71fc6a7b5f84e2aa86f9ac5aa4faefb3513bba683caeca`. Its final archive outcome
      was `MEASUREMENT_COHORT_DATA_INSUFFICIENT`, but the frozen assessment population gates passed:
      97 recorded slots, 96 distinct valid units, 58/38 Discovery/Validation units, 9/8 partition
      UTC dates, and 12.5% maximum date share. `LIQUIDITY_AVAILABILITY` failed at 60.344828% in
      Discovery and 63.157895% in Validation against the frozen 90% gate; liquidity date support,
      provenance, and freshness passed. Both momentum objectives passed all frozen availability,
      date-support, provenance, and freshness gates. The non-authorizing result is
      `MEASUREMENT_CAPABILITY_NOT_CONFIRMED`, with next action
      `PRESERVE_FINAL_DEFICIENCY_LEDGER_FOR_SEPARATE_HUMAN_MEASUREMENT_PROTOCOL_DECISION`.
      Literal provider/database/filesystem/runtime/session/order/fill/position counters were zero;
      wallet loading, signing, and submission were false, and no later-label member was interpreted.

## 11. Acceptance Gates

```text
active V3 protocol/root/scheduler modified by this phase = no
real V3 archive read during implementation = no
production analyzer before final literal identity binding = default-deny
strict absolute slot-coordinate validation, including bounded unrecorded-slot coverage = required
allowed production root after binding = exactly measurement-v3-20260904-2100Z
provider/RPC/HTTP, database, runtime, scheduler, archive-write, session, execution actions = 0
strategy/score/risk/return/label/P&L/numerical measurement value used or emitted = no
all capability results derive only from frozen V3 gates = yes
any capability result authorizes V4, collection, Phase 10.6C, PAPER, or promotion = no
```

Only after separate implementation approval, synthetic verification, finalization, source-reviewed
identity binding, and a separate exact-root run approval may Phase 10.6B.3 inspect the completed V3
archive. Its result remains research governance evidence, never authority to trade.
