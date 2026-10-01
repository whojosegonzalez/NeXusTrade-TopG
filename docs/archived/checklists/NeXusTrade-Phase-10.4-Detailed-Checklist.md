# NeXusTrade Phase 10.4 Detailed Implementation Checklist

## Local Research Brief Generator And Analyst Review Protocol

Status: Implemented 2026-08-19. Archive-only and read-only.

## 1. Purpose And Fixed Outcome

Phase 10.4 makes completed research evidence reviewable directly from a deterministic local brief,
so a reviewer or Codex can analyze a named archive set without relying on visual dashboard
inspection. It is an evidence-reading phase, not a data-collection, strategy, execution, or
hypothesis-creation phase.

The delivered first pass must provide a `research:brief` command that accepts an explicit completed
archive scope and writes a bounded, human-readable Markdown brief or equivalent sanitized JSON to
standard output only. The brief must be sufficient for a reviewer to answer:

```text
What evidence was included?
What is known, missing, concentrated, or inconsistent?
What conclusion is already supported by the recorded evidence?
What is the next permitted action, if any?
```

For the initial Phase 9.28 / 9.29 fixture, the required conclusion is the already-recorded
`NO_DEFENSIBLE_HYPOTHESIS`. The brief must state why: 7 exact-coverage candidates, 3
`TARGET_FIRST`, 3 `STOP_FIRST`, 1 `MAX_HOLD`, 85.71% of selected candidates from Test3, and every
non-target label from Test3. It may not substitute a new conclusion, recommend a threshold, or
create a successor profile.

Phase 10.4 is complete only when a named archive set can be read deterministically, summarized with
traceable source facts and explicit missingness, and reviewed through the fixed protocol below with
zero external or runtime side effects.

## 2. Non-Negotiable Safety Boundary

Every Phase 10.4 work item must preserve all of the following:

- Zero external/provider/RPC HTTP calls, including no browser, loopback, or Vite dependency. This
  is a local CLI, not a dashboard surface.
- No scanner, risk, strategy, shadow-observation, watchlist-return, session, or runtime command.
- No database access of any kind in the first pass: no active database reads, archive database
  reads, writes, migrations, pragmas, seed/reset commands, or changes to `data/nexus_paper.db*`.
  Phase 10.4 reads known structured archive JSON only.
- No filesystem write in the first pass. The command emits to standard output; it creates no report
  directory, session, archive artifact, cache, manifest, or checkpoint. Shell redirection is an
  operator action outside this command and is not part of the supported workflow.
- No wallet loading, signing, transaction construction, submission, orders, fills, positions,
  balances, paper BUY/SELL, or execution control.
- No strategy-default, score/threshold, exit, quote-budget, provider, or one-/two-minute monitoring
  change. The normal research baseline remains BUY=90 / WATCH=70 and PAPER execution remains
  disabled.
- No API key, authorization header, environment value, private URL, raw provider payload, or
  credential-shaped text may be accepted as input or emitted in a brief.
- No automatic hypothesis, ranking, classifier, threshold search, counterfactual recommendation,
  promotion recommendation, or study-launch decision.

The brief may summarize later labels only inside explicitly marked outcome-analysis sections. Later
outcomes, MFE/MAE, return, and post-decision observations must never appear as a proposed entry
input or be used to derive a new predicate.

## 3. Starting Evidence And Explicit Scope

The initial approved fixture is the existing completed Phase 9.28 / 9.29 evidence set:

```text
archive root
  data/archive

included phase
  phase9.28
  phase9.29

required named cohort
  phase9.29/combined-valid-three-20260818-1539
```

The brief must use only canonical structured JSON discovered under that explicit scope:

| Evidence                                 | Canonical structured source            | Brief use                                                               |
| ---------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| Run safety and provider pressure         | Phase 9.28 TerminalRunner summary JSON | run inventory, duration/cycles, safety state, provider-pressure context |
| Candidate decision-time facts and labels | Phase 9.29 fast-entry attribution JSON | candidate evidence matrix; later labels in the separate outcome section |
| Concentration and gate results           | Phase 9.29 fast-entry attribution JSON | recorded run shares and defensibility-gate ledger                       |
| Recorded conclusion                      | Phase 9.29 fast-entry attribution JSON | conclusion and blocking reason verbatim or safely bounded paraphrase    |

The first pass must reject rather than broaden its scope when any input is absent, ambiguous,
unrecognized, outside `data/archive`, under `legacy-root-artifacts-*`, a transcript, a database, or
a non-canonical JSON report. It must not scan every archive phase by default.

## 4. Command And Selection Contract

Add a root script and thin backend entrypoint named `research:brief`. Its supported command shape is:

```text
pnpm research:brief -- \
  --archive-root=data/archive \
  --include-phase=phase9.28 \
  --include-phase=phase9.29 \
  --include-cohort=phase9.29/combined-valid-three-20260818-1539 \
  --format=markdown
```

### 4.1 Supported arguments

- Exactly one `--archive-root=<path>`, resolving to the canonical `data/archive` directory within
  the repository.
- One or more repeatable `--include-phase=<direct-phase-name>` values. Each value must be unique,
  a direct child of the supplied archive root, and recorded in the brief scope.
- Optional exactly-once `--include-cohort=<phase>/<direct-archive-directory>`. It is required when
  a selected phase has ambiguous supported reports, including Phase 9.29.
- Optional exactly-once `--format=markdown|json`, defaulting to `markdown`.
- Optional `--once` only as a compatibility no-op with other local research commands. It must not
  create a loop, monitoring process, or session.

### 4.2 Rejected arguments and inputs

- Reject duplicate, empty, traversal-shaped, absolute-outside-repository, URL-shaped, or unavailable
  roots, phase includes, cohorts, and formats.
- Reject every output/write option, including `--output`, `--output-dir`, `--file`, `--write`, and
  `--save`.
- Reject database, runtime, provider, environment, session, strategy, score, threshold, target,
  stop, observation, monitor, wallet, sign, submit, paper, live, and execution options by explicit
  prefix denylist.
- Reject report ambiguity rather than selecting by newest timestamp, filesystem order, or filename
  guesswork.
- Reject a scope that lacks a recognized Phase 9.29 attribution report when it claims to request a
  Phase 9.29 analytical conclusion.

The parser and catalog must use path containment checks after resolution. A string containing
`data/archive` is not sufficient proof of containment.

### 4.3 Bounded CLI error contract

All rejected input and fail-closed source conditions must return a nonzero exit and exactly one
stable public error code before any Markdown or JSON brief output. The supported initial codes are:

```text
RESEARCH_BRIEF_INVALID_SCOPE
RESEARCH_BRIEF_AMBIGUOUS_REPORT
RESEARCH_BRIEF_UNSUPPORTED_REPORT
RESEARCH_BRIEF_SOURCE_INCONSISTENCY
```

`RESEARCH_BRIEF_INVALID_SCOPE` covers invalid, unsafe, unavailable, or incomplete argument scope;
`RESEARCH_BRIEF_AMBIGUOUS_REPORT` covers more than one eligible report without the required explicit
cohort; `RESEARCH_BRIEF_UNSUPPORTED_REPORT` covers a selected report that is not a recognized
supported schema; and `RESEARCH_BRIEF_SOURCE_INCONSISTENCY` covers critical recorded-count or
recorded-conclusion disagreement. Error text may add sanitized archive-relative context, but must
not add host paths, source payload fragments, credentials, or a second machine-parseable code.

## 5. Versioned Brief Contract

Implement typed, Zod-validated internal and serialized contracts under a dedicated
`backend/src/research-brief/` module. The first version is `ResearchBriefV1`.

### 5.1 Required brief fields

```text
contractVersion
generatedAt                 # display/audit field only
contentFingerprint          # canonical content excludes generatedAt
scope                       # archive root relative path, explicit phase/cohort includes
inputInventory              # relative source path, recognized report kind, SHA-256
safety                      # all Phase 10.4 side-effect counters/booleans fixed to zero/false
dataQuality                 # included/skipped/unsupported/ambiguous/missing facts
runInventory                # canonical run identity, mode, shadow-only/safety, time/cycle facts
providerPressureContext     # aggregate context, not a candidate predicate
candidateEvidence           # decision-time facts with source/missingness, separately nested label
outcomeAnalysis             # later labels and exact-coverage facts only
concentrationAndGates       # recorded source-run shares and each recorded gate/result/detail
recordedConclusion          # status, reason, source report
reviewProtocol              # fixed permitted next-action language
warnings
```

All paths must be relative to `data/archive`; never emit absolute host paths. All arrays/maps must
have documented stable sort keys. `contentFingerprint` must be SHA-256 over canonical brief content
after omitting `generatedAt` and setting `contentFingerprint` itself to `""` in the hash preimage to
avoid a self-referential hash.

### 5.2 Data-quality and missingness contract

- Preserve `MISSING`, `UNAVAILABLE_AT_DECISION_TIME`, unsupported report type, skipped legacy copy,
  and report ambiguity as explicit state. Do not convert any to zero, false, pass, or an inferred
  fact.
- Source facts retain report-relative provenance and, where present in the source, the original
  source timestamp/availability marker.
- Candidate identity may include only the Phase 10 `DashboardCandidate` public fields: deterministic
  `id`, `runId`, and `cohortId`; archived `mintAddress`; optional archived `symbol`; archived
  `decisionId`; and archived `decidedAt`. This is the explicit allowlist from
  `shared/src/research-dashboard.ts`; do not introduce a generic identity object or a
  `strategyDecisionId` alias. Do not add balances, wallet/account data, raw provider response, or
  free-form configuration.
- Provider pressure is contextual. Keep upstream rate limits/errors, cache, cooldown, budget,
  controller, venue-guard, and unavailable fields distinct. It must not be joined into a candidate
  score or conclusion predicate.
- If known reports disagree on a critical recorded count or conclusion, fail closed with a bounded
  inconsistency error. Do not choose a preferred report.

### 5.3 Recorded-conclusion rule

`recordedConclusion.status` is strictly one of:

```text
NO_DEFENSIBLE_HYPOTHESIS
DATA_INSUFFICIENT
HUMAN_REVIEW_REQUIRED
```

The generator may carry `NO_DEFENSIBLE_HYPOTHESIS` only when it is the unmodified recorded outcome
of a supported attribution report. It may emit `DATA_INSUFFICIENT` for valid-but-incomplete scoped
evidence and `HUMAN_REVIEW_REQUIRED` for a bounded, non-promotable inconsistency that does not make
the input unsafe. It must never emit `BUY`, `WATCH`, `SELL`, `PROMOTE`, `READY_TO_TRADE`, or
`PRE_REGISTER_SUCCESSOR_HYPOTHESIS`.

## 6. Markdown And JSON Output Requirements

Markdown is designed for a concise conversational review. JSON is the exact structured equivalent;
both formats must derive from the same validated `ResearchBriefV1` object.

### 6.1 Required Markdown order

1. **Safety and scope** — archive root, explicit includes, source fingerprint, fixed PAPER/
   execution-disabled state, and the statement that the command made zero side effects.
2. **Evidence inventory** — supported source count/type, skipped/unavailable inputs, and source
   paths.
3. **Data-quality findings** — exact coverage, missing decision-time facts, unknown provenance,
   report ambiguity, and provider-pressure availability.
4. **Decision-time evidence** — bounded candidate matrix or group summary. Every row must identify
   decision-time availability and source. It must contain no outcome value in this section.
5. **Outcome analysis (labels only)** — exact 3/5/15 coverage and the later-label counts, visibly
   marked “not entry inputs.”
6. **Concentration and gate ledger** — selected/target/non-target source-run shares plus every
   pre-registered gate and its recorded result/detail.
7. **Recorded conclusion** — the allowed status, blocking reasons, and source report.
8. **Review protocol** — a fixed checklist of what Codex/reviewer may state next, including that no
   strategy, threshold, collection, or execution action is authorized by this brief.

No Markdown table may silently omit a failed gate, missing value, unsupported report, or label
category that is present in source data. Use bounded values and rows; if a future scope is too large,
emit a deterministic summary plus a count of omitted rows, never an arbitrary truncation.

### 6.2 Fixed reviewer/Codex protocol

When a user asks to review a generated brief, the response must use this order:

1. State scope and data-quality limitations.
2. State decision-time facts separately from later labels.
3. State concentration/gate results and whether the conclusion is recorded or data-insufficient.
4. State the permitted next action exactly: archive review only, `NO_DEFENSIBLE_HYPOTHESIS`, or
   human review required.
5. State prohibited actions: no strategy default/profile/threshold change, no unchanged F65E
   collection, no execution enablement, and no provider/runtime command.

The reviewer may explain an observed pattern only as descriptive evidence. It must say when a
pattern is concentrated, missing, or not independently supported. It must not infer profitability
or construct an unstated rule from a brief.

## 7. Implementation Sequence

### A. Documentation and fixtures

- [x] Add Phase 10.4 to the roadmap, decision log, planning inputs, structure inventory, and this
      checklist before source work begins.
- [x] Reuse the immutable Phase 9.28/9.29 canonical structured archive fixture. Do not create a
      synthetic replacement, modify an archive, or read an archive database.
- [x] Record fixture expectations: five canonical Phase 9.28 runner summaries, one explicitly named
      Phase 9.29 attribution report, seven candidates, 3/3/1 labels, `NO_DEFENSIBLE_HYPOTHESIS`,
      selected concentration 85.71% Test3, and non-target concentration 100% Test3.

Implementation note (2026-08-19): The source fixture remains unchanged. The catalog inventories five
Phase 9.28 TerminalRunner JSON summaries and the single explicitly named Phase 9.29 attribution
report; it never opens an archive database.

### B. Config and safe catalog

- [x] Add `ResearchBriefConfig` and parser tests for explicit roots/phases/cohorts/formats, strict
      containment, ambiguity, and all rejected active/write/network options.
- [x] Reuse or extract only the safe, canonical JSON archive discovery rules already proved by the
      dashboard catalog. Do not make a generic JSON scraper.
- [x] Add `ResearchBriefCatalog` only if reuse would weaken type boundaries. It must exclude legacy
      cleanup copies, transcripts, databases, active data roots, and unknown reports.
- [x] Add input inventory hashing and deterministic discovery/sort rules before any formatter work.

Implementation note (2026-08-19): `ResearchBriefCatalog` is a separate read-only catalog because the
dashboard exporter owns a generated-data write path. It discovers only direct Phase 9.28
`runner-output/*.json` summaries and JSON in the explicit Phase 9.29 cohort, excludes the legacy
cleanup copy, and records SHA-256 inventory entries with archive-relative paths.

### C. Brief assembly

- [x] Add Zod contracts and adapters for known Phase 9.28 TerminalRunner and Phase 9.29 attribution
      reports. Validate every normalized record before it reaches a formatter.
- [x] Build run/provider context, decision-time candidate evidence, later-label analysis,
      concentration/gate ledger, and recorded conclusion as separate typed sections.
- [x] Enforce source availability/missingness and decision-time/outcome separation at adapter
      boundaries; no formatter may repair or infer a missing value.
- [x] Add the fixed conclusion/status resolver. It may transfer recorded conclusions or produce the
      two non-promotable status values only; it may not calculate a successor recommendation.
- [x] Add credential-pattern rejection over the final normalized brief and both output formats.

Implementation note (2026-08-19): `ResearchBriefV1` is Zod-validated before formatting. Candidate
facts cite the attribution report rather than copying its raw feature-path field, preventing absolute
host-path disclosure. Later labels live only in `outcomeAnalysis`; provider pressure is a separate
aggregate context. The only initial recorded conclusion is the source `NO_DEFENSIBLE_HYPOTHESIS`.

### D. CLI and review output

- [x] Add `backend/src/scripts/research-brief.ts` and root/backend `research:brief` package scripts.
- [x] Implement deterministic Markdown and JSON formatters from the same brief object, writing only
      to standard output.
- [x] Include an unmissable top-level safety statement and a final fixed “next permitted action”
      section in both formats.
- [x] Keep frontend/dashboard changes out of scope. The dashboard may later link to a manually
      produced brief, but Phase 10.4 does not fetch, serve, or render one.

Implementation note (2026-08-19): `research:brief` imports only the dedicated archive-only module.
It accepts the explicit scope, reads local JSON, and writes the one formatted result to stdout; its
entrypoint reports a single bounded error code to stderr on a rejected or fail-closed input.

### E. Documentation and closeout

- [x] Update the Phase 10.4 handoff docs with actual command, source schema, fixture fingerprint,
      verification output, and the first brief conclusion after implementation.
- [x] Confirm no cleanup or archive move is needed. Do not move, delete, or rename source archives
      merely to make the brief catalog simpler.
- [x] Mark implementation tasks complete only after the full test/verification plan passes.

Closeout note (2026-08-19): The actual command is the command in Section 4 with
`--format=markdown` or `--format=json`. Both modes produced fingerprint
`5fb59e2bf4472ea4da2a516d1298398491b812d1a3ae811d745aa46d5ee308c7` from six immutable structured
JSON sources: five `TERMINAL_RUNNER_SUMMARY` reports and one `FAST_ENTRY_ATTRIBUTION_REPORT`. The
first brief reproduces 7 exact-coverage candidates, the 3/3/1 label counts, Test3 selected and
non-target concentration of 85.71% and 100%, respectively, and the recorded
`NO_DEFENSIBLE_HYPOTHESIS` conclusion. No archive cleanup, move, deletion, or rename is needed.

## 8. Test And Verification Plan

### 8.1 Config and catalog tests

- [x] Reject missing/duplicate roots, empty/duplicate/unknown phase includes, invalid formats,
      traversal/escape paths, URL-shaped values, and Phase 9.29 ambiguity without the named cohort.
- [x] Reject all output/write, database, provider, runtime, execution, wallet, signing, submission,
      strategy, threshold, target/stop, observation, and monitoring options.
- [x] Prove canonical discovery is stable, ignores `legacy-root-artifacts-*`, and rejects unknown
      JSON rather than parsing it opportunistically.

### 8.2 Data and conclusion tests

- [x] Verify the normalized initial brief has 5 runs, 1 attribution report, 7 candidates, 3
      `TARGET_FIRST` / 3 `STOP_FIRST` / 1 `MAX_HOLD`, the Test3 concentration values, all recorded
      gates, and `NO_DEFENSIBLE_HYPOTHESIS` with its recorded reason.
- [x] Verify every candidate decision-time fact retains availability and source provenance, while
      later labels appear only under `outcomeAnalysis`.
- [x] Verify missing/unavailable facts, absent supported report, conflicting conclusion/count, and
      unsupported report are surfaced as explicit bounded states or fail-closed errors with the
      exact documented public error code.
- [x] Verify provider-pressure context remains distinct and does not appear in any candidate-score or
      proposed-predicate field.
- [x] Verify a credential-shaped normalized value fails before Markdown or JSON output.

### 8.3 Determinism and safety tests

- [x] Inject two clocks and prove `generatedAt` differs while `contentFingerprint`, canonical JSON
      with `generatedAt` omitted, and Markdown content excluding the audit line remain stable. The
      full raw JSON is expected to differ only at `generatedAt`.
- [x] Spy on `fetch` and relevant provider/runtime construction paths; assert none are invoked.
- [x] Hash every structured source before and after a brief build; assert byte hash and mtime are
      unchanged. Assert no file is created under `data/`, `data/archive/`, or the repository output
      tree.
- [x] Verify the CLI writes only standard output and returns a nonzero exit with exactly one
      documented error code for invalid scope, ambiguous report, unsupported report, or source
      inconsistency; it must not leave a partial output file.

Implementation note (2026-08-19): The focused suite has 12 passing tests. It uses two injected
clocks, hashes and mtimes all six structured sources before/after a build, spies on `fetch`, asserts
the brief modules contain no write API, captures CLI output through its stdout seam, and covers all
four public error codes. Full repository verification remains pending.

### 8.4 End-to-end acceptance run

- [x] Run the explicit initial command in Markdown and JSON modes.
- [x] Verify both modes represent the same canonical fingerprint, input inventory, 3/3/1 labels,
      concentration/gate results, and `NO_DEFENSIBLE_HYPOTHESIS` conclusion.
- [x] Run `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm check:secrets`, and
      `pnpm verify` after final code and documentation changes.

Verification note (2026-08-19): `corepack pnpm verify` passed: 107 backend test files / 351 tests,
4 shared test files / 13 tests, and 2 frontend test files / 4 tests. Formatting, linting, type
checks, and the secret scan also passed.

## 9. Acceptance Gates

Phase 10.4 may be marked implemented only when all conditions hold:

```text
explicit completed archive scope only = yes
active/archived database reads and writes = 0 / 0
provider/RPC/HTTP calls = 0
runtime/scanner/risk/strategy/session commands = 0
filesystem writes by research:brief = 0
orders/fills/positions/wallet/signing/submission = 0 / 0 / 0 / 0 / 0 / 0
strategy/default/threshold/provider/monitoring changes = 0
credential-like brief content = 0
initial fixture = 5 runs / 1 attribution report / 7 candidates / 3-3-1 labels
initial conclusion = recorded NO_DEFENSIBLE_HYPOTHESIS
new successor profile or study authorization = 0
```

The brief must be deterministic, source-traceable, and candid about missingness/concentration. A
concentrated or insufficient result is a successful report, not a reason to broaden selection or
collect more unchanged F65E@v1 tests.

## 10. Explicit Deferrals

Phase 10.4 does not include:

- archive-database adapters, active-database reads, generic report ingestion, transcript parsing, or
  archival output writes;
- dashboard integration, Vite/static serving, browser automation, continuous refresh, or a
  scheduler;
- provider diagnostics, new providers, quote adapters, provider configuration changes, or network
  calls;
- Phase 9.30, a new hypothesis, F65E@v1 continuation, threshold widening, strategy tuning, or a
  successor profile;
- PAPER BUY/SELL, orders, fills, positions, balances, P&L, wallet access, signing, submission, or
  live-trading readiness work; and
- automatic natural-language recommendations. Codex may analyze a generated brief in conversation,
  but the fixed review protocol and evidence gates remain controlling.

The next decision after Phase 10.4 is a human review of a source-traceable brief. Only a separate,
explicitly approved planning phase may propose a materially distinct shadow study, and only if its
evidence is independently supported.
