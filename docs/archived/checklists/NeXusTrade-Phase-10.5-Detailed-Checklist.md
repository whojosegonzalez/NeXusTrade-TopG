# NeXusTrade Phase 10.5 Detailed Implementation Checklist

## Human Review And Pre-Registration Gate

Status: Implemented 2026-08-19. Every completed task includes a concise completion note.

## 1. Purpose And Fixed Initial Outcome

Phase 10.5 turns the completed Phase 10.4 archive brief into a disciplined human-review gate. It is
not a new data-collection, strategy-tuning, provider, execution, or paper-operations phase. Its
purpose is to make the next permitted research decision explicit and source-traceable:

```text
Does the completed evidence support one materially different, pre-registered shadow study?
```

For the initial approved Phase 9.28 / 9.29 brief, the required result is:

```text
NO_STUDY_AUTHORIZED
```

The reason is already recorded: the only attribution conclusion is `NO_DEFENSIBLE_HYPOTHESIS`; the
seven exact-coverage candidates are concentrated in Test3 (85.71% selected and 100% non-target),
and the independent-label, concentration, leave-one-out-direction, and narrow-predicate gates
failed. Phase 10.5 must preserve that conclusion rather than manufacture a profile from observed
outcomes.

Phase 10.5 can be marked complete when a reviewer can reproduce the completed evidence, record the
reasoned default-deny decision, and verify that no Phase 10.6 collection, PAPER execution, or
strategy change was authorized. A hypothetical later pre-registration is only a separately approved
possibility and is never the initial output of this phase.

## 2. Non-Negotiable Safety Boundary

Every Phase 10.5 work item must preserve all of the following:

- Zero external/provider/RPC/HTTP calls, including no browser, loopback server, Vite dependency, or
  provider diagnostic.
- No scanner, risk, strategy, shadow-observation, watchlist-return, session, TerminalRunner, or
  runtime command. Phase 10.5 must not collect any market observation.
- No active or archived database access: no database reads, writes, migrations, pragmas, seed/reset
  commands, or access to `data/nexus_paper.db*`.
- No runtime filesystem write. The review command, if implemented, reads only its explicit record
  and completed archive JSON, then emits Markdown or JSON to standard output. It creates no report,
  session, archive, cache, manifest, checkpoint, or review artifact. A human-authored review record
  is a separately reviewed source-controlled document, not CLI output.
- No wallet loading, signing, transaction construction, submission, orders, fills, positions,
  balances, PAPER BUY/SELL, exposure, or execution control.
- No default strategy/profile/threshold/exit/quote-budget/provider/monitoring change. The normal
  research baseline remains BUY=90 / WATCH=70, and PAPER execution remains disabled.
- No continuation of unchanged F65E@v1, no threshold widening, no one-/two-minute monitoring work,
  and no new shadow study from this phase alone.
- No API key, authorization header, environment value, private URL, raw provider payload, or
  credential-shaped text may be accepted in a review record or emitted in output.
- No automatic hypothesis generation, feature ranking, predicate search, counterfactual
  recommendation, promotion decision, or Phase 10.6 authorization.

Later 3/5/15-minute labels remain labels for evidence review only. They must never be copied into a
candidate study's entry predicate, score rule, threshold, or selection input.

## 3. Required Starting Evidence And Explicit Scope

The initial review is locked to the completed Phase 10.4 brief with this immutable evidence identity:

```text
archive root
  data/archive

included phases
  phase9.28
  phase9.29

required cohort
  phase9.29/combined-valid-three-20260818-1539

ResearchBriefV1 content fingerprint
  5fb59e2bf4472ea4da2a516d1298398491b812d1a3ae811d745aa46d5ee308c7
```

The review may use only the same six canonical structured JSON inputs validated by Phase 10.4: five
Phase 9.28 `TERMINAL_RUNNER_SUMMARY` reports and the named Phase 9.29
`FAST_ENTRY_ATTRIBUTION_REPORT`. It must reject a changed fingerprint, absent source, report
ambiguity, unrecognized JSON, transcript, legacy cleanup copy, active-data root, or database rather
than attempting to supplement evidence.

The reviewer must state the following facts before selecting an outcome:

| Required evidence fact       | Initial value                              | Required interpretation                               |
| ---------------------------- | ------------------------------------------ | ----------------------------------------------------- |
| Exact 3/5/15 coverage        | 7 candidates                               | Adequate timing coverage does not cure concentration. |
| Later labels                 | 3 target-first / 3 stop-first / 1 max-hold | Labels are descriptive only, never entry inputs.      |
| Selected-run concentration   | 85.71% Test3                               | Fails the 40% maximum gate.                           |
| Non-target-run concentration | 100% Test3                                 | Fails the 40% maximum gate.                           |
| Recorded conclusion          | `NO_DEFENSIBLE_HYPOTHESIS`                 | The initial review must not override it.              |

## 4. Review Outcomes And Authority Model

Document the following future `ResearchReviewGateV1` outcome statuses:

```text
NO_STUDY_AUTHORIZED
PRE_REGISTRATION_CANDIDATE_REJECTED
HUMAN_REVIEW_REQUIRED
PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL
```

The initial implementation accepts only `NO_STUDY_AUTHORIZED`; it rejects any candidate
pre-registration and every other status. The other documented statuses require a separately
approved scope expansion after independently sufficient completed evidence exists.

The initial record must use `NO_STUDY_AUTHORIZED`, cite the Phase 10.4 fingerprint and recorded
attribution conclusion, list all failed gates, and state that unchanged F65E@v1 collection remains
prohibited.

`HUMAN_REVIEW_REQUIRED` is permitted only for a bounded, source-traceable ambiguity that does not
make input unsafe. Missing scope, inconsistent source counts/conclusions, unsafe record content, or
unsupported report types must fail closed with a nonzero error rather than selecting this status.

## 5. Future Candidate Pre-Registration Contract (Documentation Only)

This section defines a future candidate only. It must not be used to create one from the current
brief unless independent completed evidence later satisfies every gate below.

If a human later submits a candidate, a future `ShadowStudyPreRegistrationV1` must contain all
fields below before any later review gate may return
`PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL`:

```text
studyId                         # named, versioned, unique; never F65E@v1
evidenceFingerprint             # exact ResearchBriefV1 fingerprint
decisionTimeEvidenceCitations   # archive-relative sources and fact keys only
materialDifference              # fixed explanation of how the study differs from F65E@v1
entryPredicate                  # fixed decision-time-only rule; no later labels or returns
hardSafetyConstraints           # fixed risk/liquidity/age/quote/impact constraints
populationAndExclusions         # fixed before collection; no broadening after results
collectionPlan                  # proposed Phase 10.6 shadow-only duration/runs/horizons
primaryOutcomeAndLabels         # labels are evaluation-only and fixed before collection
promotionGates                  # fixed sample, concentration, stability, and outcome gates
stopConditions                  # data-quality/safety abort conditions, not trading exits
prohibitedChanges               # thresholds/defaults/execution/provider/monitoring remain unchanged
```

Any future validator and reviewer must reject a candidate when any condition below is true:

- its evidence citation is a later label, return, MFE/MAE, post-decision observation, or outcome
  comparison rather than a decision-time fact;
- it merely relabels, narrows, widens, or otherwise reuses F65E@v1's same stored-fact profile;
- it changes the normal BUY=90 / WATCH=70 defaults, enables execution, or depends on a provider,
  wallet, or runtime change;
- it uses a threshold, score, feature subset, or exception chosen because it separates the seven
  current labels;
- it lacks independent multi-run and multi-mint support in completed evidence, or a failed
  concentration/leave-one-out gate is treated as passing; or
- its collection plan, labels, gates, or stop conditions remain selectable after collection begins.

“Materially different” means a fixed research question and entry-predicate family that cannot be
reduced to “run F65E@v1 again,” “collect more,” “widen/lower the score,” or “retain whichever
decision-time feature happened to win in Test3.” The submitted record must explain why its
decision-time evidence is independently supported, and the mechanical validator can verify only
that the explanation cites valid sources; it must not decide that the explanation is economically
true.

The initial Phase 10.5 implementation deliberately does not parse or generically validate this
candidate contract. Its review record must omit `candidatePreRegistration` entirely. Adding a
candidate-capable validator requires separately approved scope, independently sufficient evidence,
and new tests; this documentation is not authorization to add one opportunistically.

## 6. Command, Record, And Error Contract

The planned command is a local read-only review gate:

```text
pnpm research:review-gate -- \
  --archive-root=data/archive \
  --include-phase=phase9.28 \
  --include-phase=phase9.29 \
  --include-cohort=phase9.29/combined-valid-three-20260818-1539 \
  --review-record=docs/research-reviews/phase10.5-initial.v1.json \
  --format=markdown
```

`--review-record` must be exactly one existing repository-relative JSON document under
`docs/research-reviews/`; it is a human-authored, source-controlled input and must not be generated
by this command. It must contain no private reviewer identity, credentials, provider data, or free-
form configuration. The command recomputes the matching `ResearchBriefV1` in memory from the same
explicit archive scope and verifies its fingerprint before assessing the record. The initial record
SHA-256 is pinned at runtime as
`07b9d4311747452ca3f539d2e26ba68ce90b9fc8db9f9e4cd5585678e8f2193f`; a legitimate changed record
must use a separately approved versioned path and corresponding implementation/documentation update.

### 6.1 Supported arguments

- Exactly one `--archive-root=data/archive`.
- One or more unique known `--include-phase=phase9.28|phase9.29` values.
- Exactly one `--include-cohort=phase9.29/<direct-archive-directory>` when Phase 9.29 is selected.
- Exactly one `--review-record=docs/research-reviews/<direct-file>.json` with strict repository
  containment and no traversal, URL, absolute, environment, or credential-shaped value.
- Optional exactly-once `--format=markdown|json`, default `markdown`.
- Optional exactly-once `--once` as a compatibility no-op only.

### 6.2 Rejected arguments and inputs

- Reject all output/write options and all database, runtime, provider, environment, session,
  strategy, score, threshold, target, stop, observation, monitor, wallet, sign, submit, paper,
  live, order, fill, position, balance, URL, and HTTP options by explicit prefix denylist.
- Reject duplicate, empty, unavailable, traversal-shaped, URL-shaped, or out-of-scope roots,
  phases, cohorts, review records, and formats.
- Reject a review record whose scope/fingerprint/input inventory differs from the recomputed brief.
- Reject unrecognized record versions, unknown fields, every status except the initial
  `NO_STUDY_AUTHORIZED` status, and every `candidatePreRegistration` field. Generic candidate
  validation is explicitly deferred.
- Reject report ambiguity rather than choosing by timestamp, filename, or filesystem order.

### 6.3 Bounded error contract

All invalid input and fail-closed conditions must return a nonzero exit with exactly one public code
before any Markdown or JSON gate output:

```text
RESEARCH_REVIEW_INVALID_SCOPE
RESEARCH_REVIEW_INVALID_RECORD
RESEARCH_REVIEW_UNSUPPORTED_EVIDENCE
RESEARCH_REVIEW_SOURCE_INCONSISTENCY
```

Error detail may identify only sanitized repository- or archive-relative paths and a bounded field
name. It must not emit raw source payloads, host paths, reviewer-private fields, credentials, or a
second machine-readable code.

## 7. Versioned Review Contract

Implement typed, Zod-validated internal and serialized contracts under a dedicated
`backend/src/research-review-gate/` module. The first output version is `ResearchReviewGateV1`; the
input record version is `ResearchReviewRecordV1`. `ShadowStudyPreRegistrationV1` remains documented
only until later approved scope explicitly adds its validator.

`ResearchReviewGateV1` must contain:

```text
contractVersion
generatedAt                         # audit field only
contentFingerprint                  # canonical content excludes generatedAt
briefFingerprint
scope                               # same explicit archive/phase/cohort selection
inputInventory                      # brief sources plus review-record hash; relative paths only
safety                              # all Phase 10.5 side-effect counters/booleans fixed zero/false
evidenceSummary                     # recorded counts, gates, concentration, conclusion
reviewAssertions                    # bounded human-authored assertions with source citations
outcome                              # allowed status, reasons, source-traceable failed checks
candidatePreRegistration            # always absent in this implementation
nextPermittedAction                 # fixed, non-promotable language
warnings
```

The initial `evidenceSummary` must transfer the Phase 10.4 recorded outcome rather than reanalyze
or rank features. Each `reviewAssertions` entry is fully mechanical:

```text
factKey       # enum: EXACT_COVERAGE | LATER_LABELS | SELECTED_RUN_CONCENTRATION |
              #       NON_TARGET_RUN_CONCENTRATION | RECORDED_CONCLUSION | FAILED_GATES |
              #       UNCHANGED_F65E_PROHIBITED
assertionCode # enum: CONFIRMS_COUNT | CONFIRMS_LABEL_BOUNDARY | CONFIRMS_GATE_FAILURE |
              #       CONFIRMS_DEFAULT_DENY | CONFIRMS_PROHIBITION
note          # optional sanitized plain text, maximum 240 characters
```

The schema fixes which `assertionCode` values may accompany each `factKey`, requires the initial
record to cover every listed fact key, and rejects unknown fields. No free-form rule, threshold,
classifier, provider instruction, execution instruction, or candidate predicate is allowed.

All output paths must be relative to the repository or `data/archive` as appropriate. Arrays/maps
must have documented stable sort keys. `contentFingerprint` must SHA-256 canonical gate content
with `generatedAt` omitted and its own field serialized as the empty string in the hash preimage.

## 8. Required Markdown And Human Review Protocol

Markdown and JSON must derive from the same validated `ResearchReviewGateV1` object. Required
Markdown order:

1. **Safety and scope** — fixed no-side-effect state and brief/review-record fingerprints.
2. **Evidence identity** — exact completed archive inputs and source-conclusion identity.
3. **Data-quality and gate ledger** — missing facts, concentration, all failed and passed gates.
4. **Decision-time evidence boundary** — state that decision-time facts were reviewed separately
   from later labels; do not repeat a candidate-level label matrix here.
5. **Human review assertions** — each assertion and archive-relative citation; no unbounded prose.
6. **Outcome** — default-deny status and every blocking reason.
7. **Candidate pre-registration** — `ABSENT`; generic candidate validation is deferred.
8. **Next permitted action** — fixed prohibition/authority language.

The initial fixed next-action text is:

```text
No new study is authorized. Do not collect unchanged F65E@v1 data, alter defaults or thresholds,
enable PAPER execution, call providers, or begin Phase 10.6. A later distinct study requires a
separate explicitly approved Phase 10.6 implementation plan.
```

When reviewing a gate in conversation, Codex/reviewer must state scope and limitations first; keep
decision-time facts separate from labels; state concentration/gate failures before any pattern; state
the recorded/default-deny outcome; and state prohibited actions. It may not convert a descriptive
observation into a study predicate.

## 9. Implementation Sequence

### A. Documentation and fixed review fixture

- [x] Add this detailed checklist to the roadmap, decision log, planning inputs, and structure
      inventory before source work begins.
- [x] Create the initial source-controlled `ResearchReviewRecordV1` fixture with
      `NO_STUDY_AUTHORIZED`; cite the Phase 10.4 fingerprint and every failed gate. Do not create a
      candidate pre-registration for the current evidence.
- [x] Record the required fixture facts: six structured sources, five runner summaries, one
      attribution report, seven candidates, 3/3/1 labels, 85.71%/100% Test3 concentration, and
      `NO_DEFENSIBLE_HYPOTHESIS`.

Completion note (2026-08-19): The approved checklist is linked in all Phase 9+ handoff documents.
The initial source-controlled record is
`docs/research-reviews/phase10.5-initial.v1.json`; it carries only the approved Phase 10.4
fingerprint, fixed mechanical assertions, and all seven recorded failed attribution gates. It omits
any candidate pre-registration.

### B. Safe config and record catalog

- [x] Add `ResearchReviewGateConfig` and parser tests for explicit archive scope, one bounded review
      record, format, containment, ambiguity, and every rejected write/network/runtime option.
- [x] Reuse `ResearchBriefV1` assembly in memory or extract only its safe archive discovery and
      fingerprint interfaces. Do not parse dashboard output, browser state, active databases, or
      arbitrary JSON.
- [x] Add a strict review-record loader that allows only the declared JSON schema under
      `docs/research-reviews/`, rejects unknown fields, and hashes its source deterministically.
- [x] Add deterministic inventory/sort rules before implementing a formatter.

Completion note (2026-08-19): `ResearchReviewGateConfig` accepts only the approved Phase 9.28/9.29
scope and the fixed source-controlled initial record. The implementation reuses the in-memory
`ResearchBriefV1` builder, reads only the six canonical archive JSON sources plus the review record,
and deterministically hashes/sorts every output inventory entry.

### C. Gate assembly and validation

- [x] Add Zod contracts for the default-deny record, mechanical assertions, and output gate. Validate
      every record before it reaches a formatter. Defer generic candidate-pre-registration validation.
- [x] Recompute the explicit Phase 10.4 brief in memory and reject any record scope, fingerprint,
      input-inventory, count, concentration, gate, or recorded-conclusion mismatch.
- [x] Build evidence summary, data-quality/gate ledger, mechanical assertions, default-deny outcome,
      absent candidate field, and next-action sections as separate typed fields.
- [x] Enforce the default-deny outcome: the current fingerprint can only yield
      `NO_STUDY_AUTHORIZED`, never a candidate or Phase 10.6 authorization.
- [x] Reject candidate-pre-registration fields outright. Defer generic candidate rules until a later
      separately approved scope.
- [x] Add credential-pattern rejection over normalized records and both formatted outputs.

Completion note (2026-08-19): `ResearchReviewRecordV1` is strict, requires every fixed assertion
fact key and its compatible assertion code, bounds/sanitizes optional notes, and rejects unknown
fields, credential-like content, candidates, and non-default-deny outcomes. The assembled gate
recomputes and pins the completed Phase 10.4 evidence fingerprint before producing output.

### D. CLI and output

- [x] Add `backend/src/scripts/research-review-gate.ts` and root/backend `research:review-gate`
      package scripts.
- [x] Implement deterministic Markdown and JSON formatters from one validated gate object, writing
      only to standard output.
- [x] Include a top-level no-side-effect statement and the fixed default-deny next-action text.
- [x] Keep dashboard, frontend, provider, database, runtime, and Paper Operations Dashboard changes
      out of scope.

Completion note (2026-08-19): `pnpm research:review-gate -- ...` emits one validated Markdown or
JSON gate to standard output only. Both manual modes reproduce content fingerprint
`2846a8509f523104417e460d0bc0a6812d161f393ade666b73faea5caa19828b` and the required
`NO_STUDY_AUTHORIZED` result.

### E. Documentation and closeout

- [x] Update Phase 10.5 handoff docs with the actual record path/hash, gate fingerprint, command,
      verification output, and initial `NO_STUDY_AUTHORIZED` result.
- [x] Confirm no archive cleanup, archive move, data collection, provider call, database access,
      session, order, fill, position, wallet action, signing, submission, or strategy/default change
      occurred.

Completion note (2026-08-19): The initial record is
`docs/research-reviews/phase10.5-initial.v1.json` with SHA-256
`07b9d4311747452ca3f539d2e26ba68ce90b9fc8db9f9e4cd5585678e8f2193f`. The approved command in
Section 6 produced gate fingerprint
`2846a8509f523104417e460d0bc0a6812d161f393ade666b73faea5caa19828b` in both formats. No archive
or runtime state was modified.

- [x] Mark tasks complete only after the full test and verification plan passes.

Completion note (2026-08-19): `corepack pnpm verify` passed: format, lint, typecheck, 110 backend
test files / 360 tests, 4 shared test files / 13 tests, 2 frontend test files / 4 tests, and the
secret scan.

Closeout note (2026-08-19): The test plan now matches the implemented compatibility behavior:
`--once` is accepted once and a duplicate is rejected. The runtime also pins the initial
source-controlled review-record SHA-256 before parsing it, so a legitimate revision requires a new
approved versioned record path and corresponding implementation/documentation update.

## 10. Test And Verification Plan

### 10.1 Config and catalog tests

- [x] Reject missing/duplicate roots, phase includes, cohorts, review records, formats, and
      traversal/escape paths, URL-shaped values, and Phase 9.29 ambiguity. Accept one compatibility
      `--once` no-op; reject duplicate `--once` options.
- [x] Reject output/write, database, provider, runtime, execution, wallet, signing, submission,
      strategy, threshold, target/stop, observation, monitoring, environment, and HTTP options.
- [x] Prove the record loader cannot leave `docs/research-reviews/`, cannot accept unknown fields,
      and never parses a transcript, legacy copy, dashboard export, database, or arbitrary JSON.

### 10.2 Evidence and outcome tests

- [x] Verify the initial record/brief fixture has the exact Phase 10.4 fingerprint, six inputs,
      5-run / 1-attribution-report / 7-candidate inventory, 3/3/1 labels, 85.71% / 100%
      concentration, all recorded gates, and `NO_DEFENSIBLE_HYPOTHESIS`.
- [x] Verify the initial output is exactly `NO_STUDY_AUTHORIZED`, lists each blocking gate, contains
      no candidate pre-registration, and explicitly blocks Phase 10.6.
- [x] Verify a changed brief fingerprint, source hash, count, conclusion, gate detail, or record
      citation fails closed with the documented inconsistency/record code.
- [x] Verify every candidate-pre-registration field and every non-default-deny status is rejected.
      Generic candidate-validator tests are deferred with the validator itself.
- [x] Verify every output identity/path is allowlisted and relative; candidate facts never contain
      provider payloads, account data, wallet data, or credential-like text.

### 10.3 Determinism and no-side-effect tests

- [x] Inject two clocks and prove `generatedAt` differs while content fingerprint, canonical JSON
      excluding `generatedAt`, and Markdown excluding its audit line remain stable. The raw JSON may
      differ only at `generatedAt`.
- [x] Spy on `fetch` and relevant provider/runtime construction paths; assert none are invoked.
- [x] Hash/mtime the six archive JSON sources and the review record before/after a gate build; assert
      they are unchanged. Assert gate modules contain no write-capable filesystem dependency and the
      CLI produces no output file.
- [x] Verify every invalid scope/record/error class prints exactly one bounded public error code and
      no partial Markdown or JSON gate output.

### 10.4 End-to-end acceptance run

- [x] Run the explicit initial command in Markdown and JSON modes.
- [x] Verify both formats have the same canonical fingerprint and reproduce the default-deny
      `NO_STUDY_AUTHORIZED` output with no candidate pre-registration.
- [x] Run `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm check:secrets`, and
      `pnpm verify` after final code and documentation changes.

## 11. Acceptance Gates

Phase 10.5 may be marked implemented only when all conditions hold:

```text
explicit completed archive scope and review record only = yes
brief fingerprint equals approved source fingerprint = yes
active/archived database reads and writes = 0 / 0
provider/RPC/HTTP calls = 0
runtime/scanner/risk/strategy/session commands = 0
filesystem writes by research:review-gate = 0
orders/fills/positions/wallet/signing/submission = 0 / 0 / 0 / 0 / 0 / 0
strategy/default/threshold/provider/monitoring changes = 0
credential-like record or output content = 0
initial fixture outcome = NO_STUDY_AUTHORIZED
candidate pre-registration in initial fixture = absent
Phase 10.6 authorization by this phase = 0
```

A successful initial default-deny result is the intended completion condition. It is not a failure to
be “fixed” by collecting more unchanged F65E@v1 runs, broadening criteria, or enabling PAPER
execution.

## 12. Explicit Deferrals

Phase 10.5 does not include:

- Phase 10.6 shadow collection, active data loading, archive or active database adapters, generic
  report ingestion, transcript parsing, or generated review-output writes;
- any new provider, provider configuration, quote adapter, network call, scanner, runtime, session,
  monitoring loop, or one-/two-minute observation mechanism;
- a successor profile, F65E@v1 continuation, threshold widening, strategy tuning, promotion,
  collection authorization, or automated natural-language recommendation;
- Phase 10.7 promotion review, Phase 10.8A Paper Operations Dashboard, Phase 10.8B PAPER pilot,
  Phase 10.9 assessment, live-readiness work, or live trading; and
- PAPER BUY/SELL, orders, fills, positions, balances, P/L, wallet access, signing, submission, or
  any execution control.

The next action after a completed default-deny Phase 10.5 is to preserve the `NO_STUDY_AUTHORIZED`
record. Only a later, separately approved planning effort with independently sufficient completed
evidence may revisit whether a materially different Phase 10.6 shadow study is worth proposing.
