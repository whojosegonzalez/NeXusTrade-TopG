# NeXusTrade Phase 10 Detailed Implementation Checklist

Local Research Dashboard and Archive Explorer

Status: Implemented 2026-08-18; Phase 10.3 presentation closeout completed 2026-08-18. This
checklist records the verified first-pass scope, boundaries, presentation refinements, and deferrals.

## 1. Purpose And Fixed Outcome

Phase 10 makes completed research evidence inspectable locally. It does **not** assert that a
strategy is profitable, authorize another threshold experiment, or move the project closer to
execution by itself.

The delivered first pass is a local, read-only dashboard that can:

- browse canonical archived runs, cohorts, structured reports, and provider-pressure summaries;
- compare `TARGET_FIRST`, `STOP_FIRST`, and `MAX_HOLD` result labels visually;
- inspect one candidate's decision-time score attribution, risk, age, liquidity, volume, momentum,
  quote/price-impact, provider-provenance, and repeated-attention facts where stored;
- show data provenance, missingness, and whether a value is a decision-time fact or a later outcome
  label; and
- show the fixed safety state: `PAPER` / shadow-only, BUY=90, WATCH=70, execution disabled.

Phase 10 is complete only when the approved archive fixture can be exported deterministically,
opened in the local UI, navigated through the above evidence surfaces, and verified not to invoke
providers or mutate any archive or database.

## 2. Non-Negotiable Safety Boundary

Every Phase 10 work item must preserve all of the following:

- Zero external/provider/RPC HTTP calls. Loopback static-asset requests from the browser to the
  local Vite server are allowed; they must remain on `localhost`, `127.0.0.1`, or `::1` and must
  not proxy, redirect, or initiate an external request.
- No scanner cycles, risk evaluation, strategy evaluation, session creation, or runtime monitoring.
- No database writes, migrations, seed/reset commands, archive mutations, or changes to
  `data/nexus_paper.db`.
- No wallet loading, signing, transaction construction, submission, orders, fills, positions,
  balances, or any `paper BUY` / `paper SELL` control.
- No strategy-default, threshold, exit, quote-budget, or one-/two-minute monitoring change.
- No API keys, authorization headers, environment values, private URLs, or raw provider payloads in
  exported dashboard data, source control, browser logs, or UI.
- The normal production research baseline remains BUY=90 / WATCH=70. `PAPER` execution remains
  disabled.

The dashboard is an evidence viewer. A future research proposal may be informed by what it shows,
but no dashboard filter, comparison, or chart is an entry predicate or a promotion decision.

The exporter itself is offline. The only permitted network-shaped traffic in the local dashboard is
the browser's loopback retrieval of Vite-served static assets and generated JSON; it is not a
provider, RPC, or external HTTP call.

## 3. Starting Evidence And Canonical Inputs

Use structured artifacts before raw databases and raw databases before text. Terminal transcripts
are not a dashboard data source.

| Evidence need                | Canonical Phase 10 input                                                      | Fallback                                  | Required disclosure                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------- |
| Archive/run library          | TerminalRunner structured JSON and archive directory metadata                 | none                                      | archive path, phase, label, time range, source-file version                            |
| Cohort and provider pressure | `research:aggregate`, `research:truth`, and `research:interpret` JSON reports | TerminalRunner summary fields             | report type/version and missing report state                                           |
| Fast-exit result labels      | `shadow:fast-exit-validate` and `shadow:fast-feature-attribute` JSON reports  | archived PAPER database, opened read-only | fixed 10/15/15 label contract and exact 3/5/15 coverage                                |
| Candidate decision facts     | `shadow:fast-feature-attribute` JSON report                                   | a whitelisted read-only archive query     | source column/report and `MISSING`, never inferred                                     |
| Score attribution            | persisted attribution/decision snapshot fields                                | none                                      | original decision time and original BUY/WATCH thresholds                               |
| Provider pressure            | structured provider-health and report summaries                               | none                                      | live provider, local controller, cache, and skipped/not-selected facts remain distinct |

For the Phase 9.28 / 9.29 example surface, the fixed source cohort is:

```text
data/archive/phase9.28/test1-phase9.28-test1-20260817-1921
data/archive/phase9.28/test2-phase9.28-test2-20260817-2203
data/archive/phase9.28/test3-phase9.28-test3-20260818-1153
data/archive/phase9.29/combined-valid-three-20260818-1539
```

It must reproduce the known descriptive result, without creating a strategy recommendation:

```text
selected candidates = 7
primary labels = 3 TARGET_FIRST / 3 STOP_FIRST / 1 MAX_HOLD
Phase 9.29 result = NO_DEFENSIBLE_HYPOTHESIS
```

The normal real-export command is bounded and auditable. It uses `data/archive` as the only archive
root and requires one or more explicit phase includes; it never exports every phase by default:

```text
pnpm dashboard:export -- --archive-root=data/archive \
  --include-phase=phase9.28 \
  --include-phase=phase9.29 \
  --include-cohort=phase9.29/combined-valid-three-20260818-1539 \
  --output-dir=frontend/public/research-dashboard-data
```

`--include-phase` is repeatable, must match a direct child of the supplied archive root, and is
recorded in the manifest. An absent, duplicate, traversal-shaped, or unavailable include is an
error. `--include-cohort` is optional only when a selected phase has one canonical report; it uses
`<phase>/<direct-archive-directory>` and resolves any report ambiguity. The first real export is
restricted to `phase9.28`, `phase9.29`, and the final
`phase9.29/combined-valid-three-20260818-1539` cohort; adding another phase or named cohort is an
explicit checklist/doc update, not an implicit archive-wide scan.

## 4. Archive Cleanup Contract

The `data/` root is reserved for the active local PAPER database and explicitly current working
artifacts. Completed run snapshots and reports belong under `data/archive/<phase>/`.

Completed during Phase 10 planning on 2026-08-18:

- moved 16 legacy Phase 9.27 / 9.28 root run-snapshot folders to
  `data/archive/phase9.27/legacy-root-artifacts-20260818/run-snapshots/` and
  `data/archive/phase9.28/legacy-root-artifacts-20260818/run-snapshots/`;
- moved 66 legacy loose Phase 9.27 / 9.28 reports to the matching
  `legacy-root-artifacts-20260818/root-reports/` folders; and
- retained `data/nexus_paper.db`, `data/nexus_paper.db-shm`, and `data/nexus_paper.db-wal` in
  place. They are not Phase 10 input and must not be read by the dashboard exporter.

The catalog must exclude `legacy-root-artifacts-*` by default. Those files are recoverable root
cleanup copies, not additional independent runs or canonical report locations. It must also ignore
`*.db-wal`, `*.db-shm`, active root databases, text transcripts, and unrecognized JSON.

Before moving future data, verify the resolved source and destination are inside the workspace,
that the destination does not exist, and that the destination phase matches the artifact. Move;
never overwrite or delete as part of cleanup. Record the count, source root, destination, date, and
whether an archived byte-identical copy already existed in the handoff docs or archive manifest.

## 5. Locked First-Pass Architecture

Use a static local dashboard plus a one-way archive exporter. Do not add a long-running backend
server, a browser-to-SQLite bridge, a provider adapter, or an application database.

```text
canonical completed archives (read-only)
  -> backend ArchiveCatalogBuilder / DashboardExportService
  -> explicit generated dashboard data directory (write-only output)
  -> local Vite + React dashboard (read-only fetch of generated JSON)
```

### 5.1 Dashboard workspace

- Turn `frontend/` into the `@nexustrade/research-dashboard` workspace using Vite, React,
  TypeScript, and plain local CSS/CSS modules. Do not add Tailwind, shadcn, or a component system in
  this first pass.
- Add `frontend` to `pnpm-workspace.yaml`, create `frontend/package.json`, and give it its own
  `dev`, `build`, `typecheck`, `lint`, and `test` scripts. Do not make it inherit the backend
  package's NodeNext-oriented TypeScript assumptions.
- Create Vite-compatible frontend TypeScript configuration: browser DOM libraries, ES module output,
  `moduleResolution: "Bundler"`, and `jsx: "react-jsx"`; keep Vite/tooling configuration in a
  separate config appropriate to Vite. The dashboard must not import backend Node runtime config.
- Use Vitest + React Testing Library + `@testing-library/jest-dom` with `jsdom` as the first-pass
  frontend test environment. Keep exporter tests in the backend Vitest suite.
- Use semantic HTML, native tables, and small local SVG/CSS charts. Avoid a chart library unless a
  concrete required comparison cannot be expressed accessibly with those primitives.
- Add a root `dashboard:dev`, `dashboard:build`, and `dashboard:export` script only after their
  package-local implementations exist. None may route to an execution command.
- Put generated data in an ignored, explicit output directory under `frontend/public/` (for
  example `frontend/public/research-dashboard-data/`). The repository contains only an empty
  `.gitkeep`/README explaining how to generate it; generated research data is never committed.

### 5.2 Backend exporter

- Add `backend/src/research-dashboard/` and a narrow `dashboard-export` script. It may import
  archive readers and report schemas only; it must not import provider registries, execution,
  wallet, scanner, session, risk-runner, or strategy-runner modules.
- Require `--archive-root`, at least one `--include-phase`, and `--output-dir`; accept an explicit
  `--include-cohort` only to resolve a selected phase's report ambiguity. Reject archive-wide default
  export, active DB paths, `data/nexus_paper.db`, runtime/session options, execution flags, URLs,
  duplicate/traversal-shaped includes, and unknown flags.
- Traverse the archive root deterministically, reject ambiguous canonical report matches, and use
  `better-sqlite3` only with a read-only, existing-file connection when a whitelisted database
  fallback is necessary. Never run migrations, pragmas that mutate, or writes.
- Emit a versioned `manifest.v1.json` plus normalized, small JSON resources. The manifest records
  `generatedAt`, exporter version, requested phase includes, input paths, SHA-256 fingerprints,
  report kinds, record counts, warnings, and a safety summary. It must not include absolute host
  paths; use archive-root relative paths only.
- `generatedAt` is an RFC 3339 UTC display/audit field and is the sole volatile manifest field.
  Define `contentFingerprint` as SHA-256 over canonical manifest and resource content with
  `generatedAt` omitted. Sort all arrays/maps by documented stable keys before serializing. Golden
  tests either compare this canonical form or inject a fixed clock; they must never fail merely
  because real export time changed.
- Export only an allowlisted research schema. Redact any unknown nested configuration, headers,
  environment variables, free-form provider response, address other than a public mint identifier,
  and values that look like credentials. Failing closed is required: unrecognized sensitive fields
  cause an exporter error, not a broader export.

### 5.3 Normalized browser contracts

Define Zod-validated JSON contracts shared between exporter and frontend:

- `DashboardManifestV1`: contract version, `generatedAt`, `contentFingerprint`, requested phase
  includes, export metadata, safety state, phases, report inventory, skipped inputs, and counts.
- `ArchiveRunV1`: phase, stable archive-relative ID, run label, time range where available, mode,
  source report references, validity/safety facts, and provider-pressure summary.
- `CohortV1`: stable cohort ID, member run IDs, membership rule description, candidate/mint counts,
  label counts, concentration summaries, and conclusions exactly as reported.
- `CandidateV1`: public mint identifier, run/cohort IDs, decision timestamp, decision-time feature
  groups, score components/threshold context, provenance, presence/missingness markers, and a
  separately nested `outcomeLabel` object.
- `ProviderPressureV1`: provider/stage/counts only, explicitly separating live upstream attempts,
  local rate/budget deferrals, cache behavior, venue guards, unavailable evidence, and unknown.

Keep numbers as source precision plus display metadata; do not round in the exporter. Do not
synthesize a missing feature, add a score, infer provider provenance, or recompute a result label.

## 6. Required UI Surfaces

### 6.1 Global shell and safety state

- [ ] Display a persistent read-only research banner: `PAPER` / shadow-only, `Execution disabled`,
      `BUY=90`, `WATCH=70`, and the manifest generation time.
- [ ] Display the selected archive root as a relative path and the manifest version/fingerprint.
- [ ] Provide a clear empty state for no generated data and a stale/invalid-manifest state. Both
      states contain export instructions only; neither launches a command.
- [ ] Do not render a trade ticket, account balance, connect-wallet control, start/stop control,
      strategy settings form, or action that changes data.

### 6.2 Archive library

- [x] Browse phases, canonical archive runs, combined reports, structured report types, run labels,
      dates when available, and validation/safety state.
- [x] Filter only the displayed evidence by phase, report kind, run, and availability. Filters are
      local UI state and never saved to a database or converted into a strategy rule.
- [ ] Exclude legacy cleanup copies by default and show a count/warning if they were skipped.
- [ ] Link each record to its archive-relative provenance and source kind; do not expose absolute
      local paths or raw report/transcript downloads.

### 6.3 Run and provider-pressure view

- [ ] Show run facts, candidate/decision counts, safety counters, and available report inventory.
- [x] Show provider-pressure grouped by provider and pipeline stage, with labels that distinguish
      upstream failure/rate limit from cache, local controller, budget non-selection, and venue guard.
- [x] Treat unavailable or missing measurements as `NOT_REPORTED`; never display zero by default.
- [ ] Include a source/report hover or adjacent disclosure for each aggregate.

### 6.4 Cohort and outcome comparison

- [ ] Show cohort membership, validity, selected-candidate and unique-mint counts, concentration,
      and the report conclusion exactly as recorded.
- [ ] For fast-exit cohorts, show `TARGET_FIRST`, `STOP_FIRST`, and `MAX_HOLD` counts in a compact
      comparison chart and an accessible table.
- [ ] Clearly label every outcome as a later observation. Outcome filters may be used to inspect an
      archived analytical cohort, but are never shown as a proposed selection input or “winning rule.”
- [ ] Surface the Phase 9.29 `NO_DEFENSIBLE_HYPOTHESIS` conclusion and its reason without an action
      to create or run a successor profile.

### 6.5 Candidate inspector

- [ ] Open a candidate from a cohort/run without changing the URL data source or running analysis.
- [ ] Present decision-time facts in separate score, risk, market/liquidity, momentum, quote/impact,
      provenance, and repeated-attention panels.
- [x] Show the original decision timestamp, decision, score, and BUY/WATCH threshold context before
      any outcome section.
- [ ] Render absent facts as `MISSING` with source context, not as zero/false/pass.
- [ ] Put the later 3/5/15-minute observations and primary label in a visually separate
      “Outcome label (not an entry input)” section.
- [ ] Show the candidate's source report/database table reference and extraction warning when the
      normalized record used a fallback.

## 7. Implementation Sequence

### A. Documentation, cleanup, and fixtures

- [x] Relocate clearly completed loose Phase 9.27/9.28 root artifacts to phase archives without
      touching the active PAPER database.
- [x] Record the cleanup convention and the Phase 10 boundary in the active handoff documents.
- [x] Use the approved immutable Phase 9.28 / 9.29 structured archive set as the exporter fixture,
      with no duplicate synthetic archive. The fixture exposes five canonical Phase 9.28 run
      summaries, one explicitly named Phase 9.29 attribution cohort, and all three primary labels;
      the exporter projects an allowlisted schema and rejects credential-shaped output. Completed
      2026-08-18.
- [x] Document fixture provenance and expected counts: explicit `phase9.28`, `phase9.29`, and
      `phase9.29/combined-valid-three-20260818-1539`; five runs, one cohort, seven candidates, and
      3 `TARGET_FIRST` / 3 `STOP_FIRST` / 1 `MAX_HOLD`. Completed 2026-08-18 in this checklist and
      the Phase 10 handoff documents.

### B. Catalog and exporter contracts

- [x] Implement `DashboardExportConfig` with strict argument validation and input/output path
      containment checks, a required repeatable `--include-phase` allowlist, optional ambiguity
      resolving `--include-cohort`, and no archive-wide default. Completed 2026-08-18.
- [x] Implement `ArchiveCatalogBuilder` to locate only canonical structured reports and apply the
      archive-cleanup exclusions. Completed 2026-08-18; the approved Phase 9.28/9.29 structured
      sources require no archive-database fallback, so no raw database reader was introduced.
- [x] Implement known Phase 9.28 TerminalRunner-summary and Phase 9.29 attribution-report adapters
      with per-record provenance and explicit missingness. Completed 2026-08-18; unsupported report
      types are not generically scraped.
- [x] Implement normalized shared Zod contracts, allowlisted projection, credential-pattern
      rejection, stable IDs, deterministic sort order, and a `contentFingerprint` that excludes only
      `generatedAt`. Completed 2026-08-18.
- [x] Implement `DashboardExportService`, text summary, JSON writer, and a thin
      `dashboard-export` CLI script. Completed 2026-08-18; its only write is to the explicit
      generated dashboard-data directory.
- [x] Add root/backend package scripts and ensure the exporter has no provider/runtime imports.
      Completed 2026-08-18.

### C. Frontend foundation

- [x] Add `frontend` to `pnpm-workspace.yaml`; create `frontend/package.json`, Vite entry/config,
      Vite-compatible TypeScript configs (`moduleResolution: "Bundler"`, `jsx: "react-jsx"`), and
      package-local dev/build/typecheck/lint/test scripts. Completed 2026-08-18.
- [x] Add Vitest + React Testing Library + `@testing-library/jest-dom` with `jsdom`, an ignored
      generated data directory, and a static sample-free empty state. Completed 2026-08-18.
- [x] Implement a manifest loader that validates before rendering, reports contract mismatch and
      missing files safely, and never fetches outside the local generated-data base path. Completed
      2026-08-18; it allowlists the three known static JSON resources.
- [x] Implement the global safety banner, archive-library navigation, local display filters, and
      accessible tables before adding charts. Completed 2026-08-18; URL state remains intentionally
      deferred because it is not needed for a static first pass.

### D. Evidence views

- [x] Implement run/provider-pressure, cohort/outcome, and candidate-inspector surfaces in that
      order. Completed 2026-08-18.
- [x] Add compact native visualizations with text/table equivalents, source disclosures,
      color-independent outcome labels, and no claim of predictive value. Completed 2026-08-18;
      native `<meter>` elements avoid an unnecessary chart dependency.
- [x] Add empty/partial/report-not-supported states so missing generated data, unmatched filters,
      absent provider pressure, and absent supported cohorts are disclosed without fabricated fields.
      Completed 2026-08-18.

### E. Hardening and closeout

- [x] Phase 10.3: preserve the Decision-time facts columns in a keyboard-focusable horizontal-scroll
      table region. Completed 2026-08-18; this browser-only layout change leaves decision-time facts
      and later outcome labels exactly as archived and visually separate.
- [x] Phase 10.2: preserve every provider-pressure metric in a keyboard-focusable horizontal-scroll
      table region and collapse each full archive source path behind a native details disclosure.
      Completed 2026-08-18; this is a browser-only layout change with no exporter or archive change.
- [x] Phase 10.1: expose archived cohort member runs, all three recorded concentration summaries,
      and each pre-registered gate/result/detail. This is display-only and leaves the Phase 9.29
      `NO_DEFENSIBLE_HYPOTHESIS` conclusion unchanged. Completed 2026-08-18.
- [x] Phase 10.1: expose existing provider stage, upstream rate-limit/error, cooldown, quote-budget,
      controller-deferral, and venue-guard facts. Fields absent from a source record render as
      `NOT_REPORTED`, not zero. Completed 2026-08-18.
- [x] Phase 10.1: add local-only run, report-kind, and provider-pressure-availability filters, and
      place the archived decision, score, fixed BUY/WATCH context, and recorded reason before the
      later outcome label in the candidate inspector. Completed 2026-08-18.
- [x] Phase 10.1: add exporter and component assertions for every new disclosure. Completed
      2026-08-18.
- [x] Assess generated-data size limits and stable run/cohort splitting. The approved export is
      92,763 bytes of candidate data and 113,131 bytes total, so no practical split or new server is
      justified. Reassess only if a future explicit archive export materially exceeds this first-pass
      footprint. Completed 2026-08-18.
- [x] Add a README runbook: export existing archives, launch locally, refresh data manually, and
      explain that the dashboard is read-only. Completed 2026-08-18 in `frontend/README.md`.
- [x] Update the roadmap, decision log, planning inputs, structure inventory, and frontend README
      with actual files, commands, verification output, and deferred work. Completed 2026-08-18.
- [x] Conduct a local UI/evidence smoke review against the generated Phase 9.28/9.29 data: rendered
      component assertions covered the safety state, local phase filtering, source/missingness
      disclosure, provider-pressure wording, later-label separation, and absence of controls; Vite
      served the page and manifest over `127.0.0.1` only. No strategy conclusion was made. Completed
      2026-08-18.

## 8. Test And Verification Plan

### Exporter tests

- [x] Config tests reject absent/duplicate archive roots and output paths, missing/duplicate/invalid
      phase includes, active database paths, output escape/traversal, runtime/execution flags, URLs,
      and unknown flags. Completed 2026-08-18.
- [x] Catalog tests verify deterministic direct-archive discovery, `legacy-root-artifacts-*`
      exclusion, explicit cohort bounding, unavailable-phase rejection, and ambiguous Phase 9.29
      report failure. The implementation reads only known JSON locations and does not parse a
      transcript. Completed 2026-08-18.
- [x] Adapter tests cover structured run/provider/cohort data, all three outcome labels,
      decision-time/outcome separation, unavailable-feature missingness, source paths, and stable
      IDs using the approved immutable archive fixture. Completed 2026-08-18.
- [x] Read-only safety tests prove no `fetch` is invoked and assert source report and archived
      database hashes/timestamps remain unchanged before and after export. Completed 2026-08-18.
- [x] Redaction tests inject credential-shaped content and assert the allowlisted exporter fails
      closed. Completed 2026-08-18.
- [x] Golden-manifest coverage proves deterministic canonical `contentFingerprint` behavior across
      two `generatedAt` values and confirms the expected 3/3/1 primary-label totals. Completed
      2026-08-18.

### Frontend tests

- [x] Manifest-loader tests cover valid, missing, malformed/incompatible, and partial generated
      data, while asserting the fixed local-resource allowlist. Completed 2026-08-18.
- [x] Component tests verify the persistent safety banner, archive filtering, provider-pressure
      labels, outcome-label separation, candidate missingness, source disclosure, and absence of
      execution controls. Completed 2026-08-18.
- [x] Accessibility coverage uses semantic headings, labels, selects, tables, native meters with
      text counts, visible keyboard focus, and non-color outcome names. Completed 2026-08-18.
- [x] Frontend test setup verifies Vitest + React Testing Library + `jsdom` loads dashboard
      components under the Vite/Bundler configuration without backend Node assumptions. Completed
      2026-08-18.
- [x] Production build passes against generated data. Because generated data is intentionally
      ignored, a no-data build also succeeds and the viewer displays a clear local export instruction
      at runtime rather than failing a static compilation. Completed 2026-08-18.

### Repository verification and manual smoke

- [x] Run backend and frontend test suites: 103 backend files / 339 tests and 2 frontend files / 4
      tests passed on 2026-08-18.
- [x] Run `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm check:secrets`, and normal
      repository verification after the final code/docs change. Completed 2026-08-18; results are
      recorded below.
- [x] Re-run complete repository verification after Phase 10.1. Formatting, lint, typechecks, all
      test suites (103 backend files / 339 tests and 2 frontend files / 4 tests), and the secret
      scan passed 2026-08-18. Intentionally ignored regenerated dashboard JSON is also excluded from
      source-format checks; it remains produced only by the explicit archive exporter.
- [x] Export `data/archive` using explicit `phase9.28`, `phase9.29`, and the named Phase 9.29
      cohort into the local generated-data directory. It produced 5 runs / 1 cohort / 7 candidates
      with content fingerprint `b02e16f3c19f3f016ff94b2405c072606a207dba767d3e51d583110c9b6147e5`
      after the Phase 10.1 allowlisted-contract addition. Completed 2026-08-18.
- [x] Serve the dashboard locally and verify the static page and manifest over `127.0.0.1`; rendered
      component tests verify archive browsing, provider wording, 3/3/1 comparison, decision-time
      facts, outcome separation, and disabled execution state. Completed 2026-08-18.
- [x] Confirm the export summary, manifest safety contract, and no-side-effect tests report zero
      provider calls, database writes, sessions, orders/fills/positions, and wallet/signing/
      submission behavior. Completed 2026-08-18.

## 9. Phase 10 Acceptance Gates

All gates must pass before Phase 10 is marked implemented:

```text
archive input = completed archives only; active PAPER DB excluded
archive/database mutation = 0
external/provider/RPC HTTP calls = 0
loopback Vite static-asset requests = allowed only on localhost / 127.0.0.1 / ::1
sessions/orders/fills/positions = 0 / 0 / 0 / 0
wallet loading/signing/submission = 0 / 0 / 0
execution controls rendered = 0
strategy/threshold/monitoring changes = 0
credential leakage in generated data = 0
Phase 9.28 fixture labels = 3 TARGET_FIRST / 3 STOP_FIRST / 1 MAX_HOLD
Phase 9.29 conclusion displayed = NO_DEFENSIBLE_HYPOTHESIS
```

The dashboard must preserve report ambiguity rather than hiding it. Missing data, invalid runs,
concentration warnings, and unsupported report types are successful disclosures, not UI failures to
be papered over.

## 10. Explicit Deferrals

Phase 10 does not include:

- a live dashboard, continuous refresh, websocket feed, or runtime-control plane;
- a wallet, account, portfolio, order, fill, position, balance, P&L, or paper execution surface;
- a dashboard control that starts TerminalRunner, scanner, risk, strategy, observations, or a
  provider diagnostic;
- strategy tuning, a Phase 9.30 experiment, threshold widening, low-latency monitoring, or a
  successor hypothesis;
- additional provider integrations, provider subscription changes, or provider calls to enrich an
  archive; and
- database schema changes unless the exporter cannot read existing archived data through its
  read-only schema. Any such discovery requires a separate decision before change.

The next decision after Phase 10 is a human review of newly inspectable structured evidence. Only
then may the project consider whether a distinct, evidence-supported shadow-study phase is worth
planning.

## Implementation Notes

### 2026-08-18 - Exporter Foundation Complete

`shared/src/research-dashboard.ts` defines the versioned browser contracts. The new
`backend/src/research-dashboard/` exporter accepts only the canonical archive root and an explicit
Phase 9.28 / 9.29 allowlist, with the final Phase 9.29 combined cohort selected explicitly. It reads
only structured JSON, emits four sanitized local JSON resources, contains no provider/runtime import,
and rejects credential-like exported content. Focused exporter tests passed: 5 tests verify argument
safety, bounded selection, deterministic fingerprint behavior across different `generatedAt` values,
zero `fetch` calls, and unchanged report/database hashes.

### 2026-08-18 - Local Dashboard Foundation And Evidence Views Complete

`frontend/` is now a Vite + React + TypeScript workspace using Bundler module resolution and
Vitest/React Testing Library/jsdom. `dashboardData.ts` validates the manifest/resources and fetches
only the three loopback static JSON resources. The UI has a persistent PAPER/shadow-only safety
banner, archive library, local display filters, provider-pressure table, outcome comparison with
native meter/table equivalents, and a candidate inspector that separates decision-time facts from
later outcome labels. Frontend typecheck, four frontend tests, and a production Vite build passed.
The final static-server smoke served the page and manifest from `127.0.0.1` only; no browser request
left loopback.

### 2026-08-18 - Phase 10 Closeout

The final bounded export selected `phase9.28`, `phase9.29`, and
`phase9.29/combined-valid-three-20260818-1539`, producing 5 runs, 1 attribution cohort, and 7
candidates. Its canonical content fingerprint is
`b02e16f3c19f3f016ff94b2405c072606a207dba767d3e51d583110c9b6147e5`; `generatedAt` is intentionally
excluded from that fingerprint. The generated data remains ignored under
`frontend/public/research-dashboard-data/`.

The final test suites passed with 103 backend files / 339 tests and 2 frontend files / 4 tests. The
normal repository verification command is recorded in the Phase 10 handoff documentation. No
strategy default, threshold, monitoring cadence, provider integration, active database, execution,
wallet, signing, or submission behavior changed. Future work is a human review of the now
inspectable evidence—not an automatically authorized successor study.

### 2026-08-18 - Phase 10.1 Evidence-Fidelity Closeout

Phase 10.1 is a presentation-only refinement of the static, archive-only contract. It records run
and cohort report kinds and separates the already archived provider facts for upstream rate limits/errors,
cooldowns, quote-budget non-selection, controller deferrals, and Raydium venue guards. The browser
now has local phase/run/report-kind/provider-evidence filters; its cohort view exposes member runs,
the three recorded concentration distributions, and all pre-registered gates; and its candidate
inspector presents the original decision, score, fixed `BUY=90`/`WATCH=70` context, and reason before
the later outcome label. Missing optional pressure evidence remains explicitly `NOT_REPORTED`.

Focused exporter and component tests cover those disclosures. This patch adds no source, provider
call, database access, session, execution surface, wallet behavior, strategy/default change, or
outcome-derived selection input.

### 2026-08-18 - Phase 10.2 Provider-Table Presentation Closeout

The provider-pressure table keeps all reported columns but uses one keyboard-focusable horizontal
scroll region instead of forcing the page to fit every column. Its provenance column now shows a
compact `Show source path` disclosure; the full archive-relative path remains available inside the
native details element without inflating each default row. Component coverage verifies the scroll
region and closed disclosure. This browser-only layout pass changes no generated data, exporter,
archive input, runtime, provider, database, strategy, or execution behavior.

### 2026-08-18 - Phase 10.3 Candidate-Table Presentation Closeout

The Decision-time facts table now uses the same keyboard-focusable horizontal-scroll treatment as
the provider table. This preserves every decision-time family, fact, value, availability, and source
without squeezing or wrapping a wide evidence row, while keeping the later outcome label below it as
a separate non-input section. Component coverage verifies the region. No archive, generated data,
exporter, provider, database, strategy, or execution behavior changed.
