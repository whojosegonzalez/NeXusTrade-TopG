# Phase 10.6H H4 Detailed Implementation Checklist

## Enforced Boundaries And Development Workflow

Status: **H4 engineering acceptance complete; PR #5 merged into main at `88921e9`. Closeout recorded 2026-09-23.**

User approved implementation from checklist commit `3b7b229`. Main `63f5378` contains that commit with an identical tree; this work remains in isolation. Progress: [H4 verification record](./Phase-10.6H-H4-Verification.md).

Baseline: `b8a91fc` on `isolation`, `U:\Projects\H1s\isolation`; clean before this documentation
task. This merge includes main's binding/slot-ledger repair and isolation's H1-H3 improvements.
Prior integration evidence: **247 analyzer/H1, 194 H2, 98 H3 tests**, plus required static checks.
Those counts are historical evidence, not tests rerun while drafting this plan.

Read with the [parent checklist](./NeXusTrade-Phase-10.6H-Detailed-Checklist.md),
[integration record](./Phase-10.6H-Main-Isolation-Integration.md),
[H3 time/budget contract](./Phase-10.6H-H3-Provider-Time-And-Budget-Contract.md), and
[development plan](./Post-V3-Development-Plan.md). H-06 is a finding addressed here; H-05 was
addressed by H1. There are no separately defined H5/H6 packages.

Hosted closeout: corrected head `bde0d7c` follows implementation `3119487`; user supplied all four Ubuntu/Windows push/PR checks green and confirmed merge. Local Git confirms `88921e9`. See the [verification record](./Phase-10.6H-H4-Verification.md) for evidence provenance and missing run URLs.

## 1. Outcome, Scope And Approval

Deliver automated dependency checks, an audited synthetic verification command and CI workflow,
a read-only analytics dependency surface, explicit versioned readers for two existing analytics
JSON projections, and a small decomposition of the existing analytics report module. Preserve
supported report behavior, stored bytes, accounting, research gates and provider policy.

- [x] Inspect integrated source and prepare this bounded plan.
- [x] **H4-AUTH:** Record user approval of D1-D9, the reviewed revision and H4-00 through H4-07.
- [x] Record any material scope/behavior deviation for review before implementing it. Routine
      choices inside the approved contract do not require repeated approval. No material scope or report-behavior deviation was introduced; hosted acceptance remains open.

No collector, real archive analysis, scheduler, provider call, operational database, migration,
PAPER activity, B.4 research or main deployment is authorized by this plan. Production analyzer
identity is already bound: never use its real command as a test. Work remains in isolation.

## 2. Inspected Findings And Bounded Responses

| Source at baseline                                           | Finding                                                                                                                                                | H4 response                                                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eslint.config.js`                                           | General lint/type-import rules; no whole-project dependency policy.                                                                                    | Add a versioned dependency-policy manifest and executable checker with adversarial fixtures. Retain H1/H3 specialized guards.                        |
| Analyzer `MeasurementCohortAnalysisDependencies.test.ts`     | H1 already checks runtime import closure and prohibited APIs, including dynamic access.                                                                | Preserve its stronger analyzer policy; reuse proven logic only if equivalence is tested. No weakening into a generic folder rule.                    |
| H2/H3 dedicated configs/setup                                | Audited suites, environment/network guards and owned SQLite fixtures already exist.                                                                    | Compose them as separate test processes; introduce a dedicated H4 allowlist rather than broadening old harnesses.                                    |
| Root `package.json` / absent `.github`                       | `verify` delegates to blanket workspace tests; no checked-in CI workflow was found.                                                                    | Add a named isolated verification entrypoint and checked-in workflow. Leave legacy `verify` clearly distinguished until its entire suite is audited. |
| `research-dashboard/DashboardExportService.test.ts`          | Reads named Phase 9 archives/databases and writes below frontend public output.                                                                        | Explicitly exclude from automated synthetic CI. Do not run it merely because its name ends in test.ts.                                               |
| `.npmrc` / `pnpm-lock.yaml`                                  | auto-install-peers=false conflicts with the retained lockfile's autoInstallPeers=true. Integration intentionally retained isolation's tested lockfile. | Prove a clean frozen-lockfile installation with an explicit setting matching the lockfile. Do not regenerate dependencies to make CI pass.           |
| `analytics/AnalyticsReportService.ts`                        | Roughly 830 lines; accepts the entire Repositories object, reads rows, decodes JSON and aggregates reports.                                            | Restrict its declared dependency to used read methods; extract local reader/types and pure quote-budget aggregation along existing seams.            |
| `db/utils/json.ts`                                           | Generic parseJson<T> is a cast, not runtime validation.                                                                                                | Do not globally redefine it. Introduce validated, versioned projection readers at the two selected analytics consumers.                              |
| Analytics `readStrategySnapshot` / `readQuoteBudgetEvidence` | Already use unknown and defensive field checks, but have no explicit reader-version contract; malformed/partial data follows local fallbacks.          | Characterize existing behavior before replacing these readers. Do not misreport them as wholly unvalidated.                                          |
| H2 `PaperOperationRepository`                                | Operation intent/results already undergo runtime validation and relationship checks.                                                                   | Preserve this H2 boundary; no replacement or schema change needed here.                                                                              |
| Frozen V2/V3 archive services                                | Some cast-based persisted readers remain.                                                                                                              | Inventory as frozen/deferred debt; do not sweep them into this analytics refactor.                                                                   |

## 3. Approved Decisions

| ID                         | Proposed decision                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 — Scope                 | H4 first release protects the analyzer boundary, existing H2/H3 harness boundaries and the selected analytics reader/calculator boundary. Inventory the rest of the dependency graph and record exact existing exceptions/debt; do not claim every architectural weakness is repaired.                                                                                                                                                                           |
| D2 — Dependency policy     | Resolve relative imports, workspace aliases and re-exports through the TypeScript configuration. Check transitive runtime reachability, type-only edges separately, side-effect imports, dynamic import/require and computed loading. Unknown runtime resolution fails in protected roots. Prohibit provider/DB/execution/bootstrap access from the analyzer and pure analytics calculators. Retain H1's explicit read-only filesystem/API allowlist.            |
| D3 — Read-only analytics   | Introduce a named interface exposing only the repository read methods actually used by AnalyticsReportService. Existing composition may pass structurally compatible repositories, but service code sees only that interface. Pure calculations receive readonly projected facts, not repositories or database handles. Types restrict accidental access; they are not a security sandbox.                                                                       |
| D4 — JSON readers          | Support the current unversioned persisted representation as an explicitly named legacy reader contract, version 0. Select the reader version at the API boundary; unsupported reader versions return a bounded unsupported-version outcome. No new persisted envelope/tag or writer is introduced. Validate each consumed projection from unknown with existing Zod or equivalent explicit checks.                                                               |
| D5 — Compatibility         | Preserve current accepted partial fields, string/number rules, array filtering, fallback behavior, grouping/order, limits, null handling, rounding and report output. Readers distinguish missing, malformed JSON, invalid projected fields and unsupported reader version internally without exposing payloads. Compatible optional-field defects must not discard other usable fields. Unsupported future versions must never be silently parsed as legacy v0. |
| D6 — Decomposition         | Extract analytics report types, the two persisted-JSON readers, and quote-budget aggregation into focused local modules. Keep the existing service export usable by existing callers. No generic framework, mass module move or cross-study utility extraction. Preserve enum initialization and report keys; do not narrow metrics or alter economic meaning.                                                                                                   |
| D7 — Reproducible workflow | Use the existing Node 24.17.0/pnpm 11.8.0 baseline initially, frozen lockfile and explicit peer-setting alignment. No package upgrades. CI provisioning may download locked dependencies and approved native builds; test execution must use synthetic transports and owned fixtures. Verify native SQLite loads before suites. Pin workflow actions to verified immutable revisions during implementation.                                                      |
| D8 — CI scope and evidence | Use fresh hosted runners, no operational credentials/archive mounts, read-only repository permissions, no deployment or pull_request_target execution. Proposed jobs: static checks plus isolated suites on Windows and Linux. Windows exercises junction semantics; Linux must exercise equivalent symlink cases. A checked-in workflow/local pass is distinct from an observed hosted green run.                                                               |
| D9 — Sequence              | Complete isolated H4 implementation/verification, then review isolation-to-main integration. Proposed B.4 planning follows the unified engineering baseline by user preference. H4 supplies no protocol or measurement conclusion and does not require H5/H6 to be invented.                                                                                                                                                                                     |

## 4. Dependency And Reader Contracts

### Protected dependency map

| Consumer                                                    | Permitted dependencies                                                                                                                                                     | Prohibited capabilities                                                                                                                                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B.3 analyzer runtime/entrypoint                             | Existing analyzer-local modules, audited Zod closure and H1-approved read-only builtins; bounded stdout/stderr at entrypoint.                                              | Providers, DB, collector/runtime/execution modules, environment loading, network, filesystem writes, subprocess/scheduler APIs; indirect/re-export routes too.                                      |
| New analytics JSON readers and pure quote-budget calculator | Local readonly fact types and pure validation dependencies.                                                                                                                | Repository implementations, DB schema runtime, provider implementations, runners, environment, filesystem/network, current-time reads or writes.                                                    |
| Analytics report service                                    | Explicit read facade, existing configuration/types, pure calculations, existing provider-pressure projection through a documented audited edge and injected/default clock. | Repository mutations, DB factory/bootstrap, execution commands or provider transport. Existing schema enum imports require explicit documentation; do not silently classify all db imports as pure. |
| Test/config/workflow entrypoints                            | Exact audited fixtures, mocks, owned filesystem/SQLite helpers, required test tools.                                                                                       | Real archives/providers/default DB/env/scheduler; no blanket test-folder exemption from execution safeguards.                                                                                       |

Record each exception by source/target, runtime/type distinction, reason and owner. Freeze the
initial debt inventory; new edges are errors unless individually reviewed. No broad wildcard
allowances, folder-name-only assurance, or suppressions added just to pass the checker. A new
unresolved dependency or shared-module modification must invalidate the relevant closure check.

### First persisted-JSON reader targets

| Stored input                             | Consumer and projection                                                                                                             | Required compatibility evidence                                                                                                                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| StrategyDecisionRecord.inputSnapshotJson | Analytics readStrategySnapshot: tokenRadar display/liquidity/age fields, risk flags/result, strategy factors and maxPriceImpactPct. | Null/empty/malformed JSON; object vs array; missing nested objects; finite numeric fields; string-only financial text; mixed factor/string arrays; blocking-factor names/fallback; unrelated fields ignored. |
| RiskAssessmentRecord.rawProviderDataJson | Analytics readQuoteBudgetEvidence: quoteBudget selected/reason/rank/signals and presence of enrichment.buyQuote.                    | Invalid required selected/reason excludes the quote-budget projection; invalid optional fields preserve remaining valid evidence; rank buckets and buyQuote presence retain exact legacy behavior.           |

Reader version identifies interpretation, not evidence provenance. Unknown fields are ignored only
where the legacy projection already ignores them; do not validate/reject an entire historical
snapshot just because one optional field is unusable. Keep bounded internal diagnostic codes and
test them; no new report columns, automatic repair, backfill or database write is part of H4.
Other JSON consumers remain explicitly inventoried debt. Future writer/envelope versions need
their own producer-reader compatibility design and approval.

## 5. Ordered Implementation Checklist

### H4-00 — Authorization, baseline and resumable evidence

- [x] Record H4-AUTH, reviewed commit, branch and current user changes.
- [x] Recheck real source/dependency/fixture/cache paths and symlink/junction containment.
- [x] Create `docs/Phase-10.6H-H4-Verification.md` with batch status, next action, exact commands,
      failures, limitations and acceptance matrix. Update after every verified batch.
- [x] Create a dedicated H4 harness with env loading/watch disabled and owned `.tmp/h4` output.
      Reuse H2 fixture safety helpers if appropriate; do not modify H1-H3 suites to hide failures.
- [x] Record baseline analytics service/formatter output from synthetic fixtures before refactoring.

### H4-01 — Inventory before enabling execution

- [x] Generate/read the workspace import graph and classify runtime, type-only, re-export and
      dynamic edges. Locate composition roots, repositories, pure modules and known exceptions.
- [x] Enumerate every candidate test file and transitive dependency before adding it to CI.
      Record included/excluded file names and reasons. Start from the existing dedicated suites.
- [x] Audit AnalyticsReportService.test.ts and its fixture chain; redirect SQLite to an owned root.
      Never invoke default analytics CLI/bootstrap for baseline characterization.
- [x] Inventory persisted JSON producers/readers and select only the two Section 4 projections.
      Record legacy fixtures from source/synthetic inputs, never copied operational rows.
- [x] Publish the protected dependency map and explicit debt inventory before enforcing it.

### H4-02 — Enforce architecture rules

- [x] Implement a versioned policy plus executable checker, using the installed TypeScript parser
      and resolver where possible. Keep diagnostics deterministic and bounded.
- [x] Cover transitive imports, barrel re-exports, aliases, side effects, cycles, type-only imports,
      dynamic/computed loading, unresolved runtime targets and workspace/path escape.
- [x] Preserve H1 analyzer API/path checks and H3 provider test boundaries; prove the general
      checker cannot make previously forbidden imports/APIs acceptable.
- [x] Add mutation fixtures that introduce forbidden direct and indirect edges and fail the command
      with nonzero exit; do not edit production source to run negative tests.

### H4-03 — Narrow read interfaces and capture projections

- [x] List exact analytics repository methods/arguments and required row fields; introduce the
      read-only facade without changing query order, selection, limits or session handling.
- [x] Add compile-time negative fixtures proving writes/unlisted methods are unavailable through
      the facade, plus runtime spies showing report generation calls reads only.
- [x] Project readonly calculation facts at the boundary. Avoid leaking repository objects into
      the extracted pure calculator or adding mutable global state.
- [x] Preserve service construction compatibility and test all changed call sites.

### H4-04 — Versioned runtime readers

- [x] Implement the two explicitly versioned legacy readers from unknown inputs with bounded
      outcomes and typed projections; cover null, malformed and partially valid input.
- [x] Preserve the exact legacy acceptance/fallback matrix established before edits. Do not infer
      source timestamps, coerce numeric strings where previously rejected, or silently use zero
      for unknown values unless that is the documented existing output behavior.
- [x] Refuse unsupported reader versions explicitly. Do not add schema migrations, persisted
      tags, new writers or change the global parseJson helper's contract.
- [x] Wire only the selected analytics consumers and verify no raw sensitive payload appears in
      errors/diagnostics or new report output.

### H4-05 — Targeted module decomposition

- [x] Extract report types, validated readers and pure quote-budget aggregation; retain public
      service imports/exports used by existing callers.
- [x] Keep injected clock behavior, report ordering, empty-case handling, rank buckets, counts,
      provider summaries, row limits and numerical output unchanged on compatible fixtures.
- [x] Compare before/after structured reports and formatted output with fixed clocks and stable
      synthetic IDs. Validate results independently of helper implementation details.
- [x] Run dependency enforcement against the extracted modules; record all deliberate retained
      coupling instead of widening the approved boundary to accommodate it.

### H4-06 — Isolated verification runner and hosted CI

- [x] Add a named root command (proposed `verify:isolated`) that runs the audited checks, fails on
      the first failing child, reports exact commands and cleans only owned fixture paths.
- [x] Keep legacy blanket `verify` clearly marked as unaudited for this purpose; do not call it in
      CI or advertise complete test coverage. List omitted suites and their outstanding prerequisites.
- [x] Prove clean frozen-lockfile install with explicit auto-install-peers=true alignment and
      allowed native builds. Document exact invocation/version; no silent lockfile regeneration,
      global package-manager change or operational dependency reuse.
- [x] Add pinned hosted CI jobs for static checks and Windows/Linux isolated suites, bounded job
      timeouts/concurrency and least permissions. Avoid credentials, operational mounts and
      source-controlled runtime launch commands. Dependency download is separate from test I/O.
- [x] Block unexpected test network/env/default-DB access, including alternate reachable transports
      in admitted tests; a fetch stub alone is not proof against node:http/subprocess/network APIs.
- [x] Verify both platform paths/cleanup and native SQLite. A platform-specific omission needs an
      explicit equivalent test, not a silent skip. Do not assume Windows-only local tests prove Linux.
- [x] Observe hosted results when pushed for review. If unavailable, record workflow as unverified
      and leave hosted CI acceptance open; do not claim H4 fully complete from YAML alone.

### H4-07 — Review, provenance and handoff

- [x] Complete T01-T16 below with exact named cases, commands, counts, source fingerprint and tool
      versions. Distinguish locally passed checks from observed hosted results.
- [x] Rerun integrated analyzer/H1, H2 and H3 suites and full required static checks; investigate
      regressions without weakening binding, containment, accounting, concurrency or frozen gates.
- [x] Review changes to package scripts/tool config separately from production code. No dependency
      upgrade, lockfile churn, archive/protocol/collector/operational change may enter unnoticed.
- [x] Sync parent checklist, roadmap, structure and handoff. Record remaining architectural/reader
      debt without expanding H4 into a framework rewrite or claiming all persistence is validated.
- [x] Leave a reviewable patch; commits/push/main merge follow the agreed user workflow. Record
      hosted-CI follow-up if a push is still needed. Proceed to B.4 only as separately planned.

## 6. Required Acceptance Matrix

| ID  | Cases                                                                                             | Acceptance                                                                              |
| --- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| T01 | Allowed runtime/type imports and explicit existing exceptions.                                    | Valid source passes; policy documents real scope.                                       |
| T02 | Direct, transitive, barrel and alias routes into provider/DB/execution from protected pure roots. | All prohibited routes fail with source/edge diagnostics.                                |
| T03 | Dynamic/computed import, require, unresolved dependency, cycles and path escape.                  | No unreviewed runtime escape; cycles terminate deterministically.                       |
| T04 | Forbidden analyzer write/network/env/subprocess/global APIs, renamed imports.                     | H1 protection retained; mutation probes fail.                                           |
| T05 | Read facade write/unlisted-method use; pure calculator receives repository or DB handle.          | Compile-time rejection and runtime read-only call evidence.                             |
| T06 | Both JSON readers: missing/null/empty, syntax error, primitive/array root, nested wrong types.    | Bounded classified results; no unchecked casts presented as validation.                 |
| T07 | Partial historical records, mixed arrays, optional fields, extra unrelated fields.                | Original usable projections/fallbacks preserved.                                        |
| T08 | Supported legacy reader v0 and unsupported reader version; malicious/sensitive payload.           | Explicit version selection/refusal; no data leakage or new stored format.               |
| T09 | Query inputs/order, latest/session selection, empty rows, MAX_REPORT_ROWS and fixed time.         | Same service behavior and reports on synthetic fixtures.                                |
| T10 | Quote budget grouping/rank boundaries, count/percentage/rounding and missing evidence.            | Pure extraction matches independent expected aggregates.                                |
| T11 | Existing caller imports, structured and formatted reports.                                        | Compatible interfaces and deterministic output, no unrelated metric changes.            |
| T12 | Forbidden real fetch/http, env, default DB, archive root and redirected fixtures.                 | Fails before access; owned cleanup cannot escape its root.                              |
| T13 | Clean locked install, peer-setting alignment and native SQLite across proposed platforms.         | Reproducible without dependency/lockfile changes; exact evidence recorded.              |
| T14 | Runner child failure and cleanup; CI events/permissions/secrets/commands.                         | Failures produce nonzero status; no unsafe workflow entrypoint or hidden broad tests.   |
| T15 | Analyzer/H1, H2, H3 plus H4 and static checks.                                                    | Prior protections retained; counts map to named coverage, no unexplained skips.         |
| T16 | Hosted Windows/Linux executions and source/status review.                                         | Observed green runs at identified revision; otherwise explicitly pending, not complete. |

## 7. Files, Verification And Completion

Expected implementation surfaces: root package scripts, new boundary checker/policy and fixtures,
`.github/workflows/` isolated verification workflow, `backend/vitest.h4.config.ts`, owned H4
setup/tests, AnalyticsReportService and focused new analytics-local modules. Existing composition
sites change only as needed for the read facade. Exact new names can be selected during implementation.
No new dependency is expected: TypeScript, Zod, Vitest and existing SQLite fixtures are available.

After H4 approval and harness audit, run the new isolated command plus the individual diagnostics
it wraps. Required static commands are the backend/shared/frontend TypeScript checks, all four
dedicated harness typechecks, repository ESLint, repository Prettier check, secret scan and git
diff check. Preserve the exact H1/H2/H3 commands in the integration record. Record each exit code.
Do not run `pnpm test`, legacy `pnpm verify`, provider smoke, collector, database reset/migrate,
terminal bootstrap or the bound production analyzer to verify this phase.

- [x] D1-D9 and all approved batches implemented with evidence.
- [x] T01-T16 mapped to named passing results; hosted acceptance is not inferred from local passes.
- [x] Supported historical projections/report behavior preserved; unvalidated consumers listed as debt.
- [x] Dependency policy blocks forbidden paths and admits only reviewed exceptions.
- [x] Reproducible guarded CI exists and has been observed at the recorded revision.
- [x] Current docs identify the completed integration commit and preserve B.3 historical provenance.
- [x] User review/main integration remains separate from engineering completion and research authority.

The next research step remains the proposed **10.6B.4 — Measurement Remediation Decision**.
Its possible outcomes are no justified new measurement protocol or a draft requiring separate
approval. H4 does not authorize a V4 collector, revise the failed 90% gate, create a hypothesis,
advance 10.6C, or permit PAPER/live execution.
