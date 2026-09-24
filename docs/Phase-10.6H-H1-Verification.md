# Phase 10.6H H1 Verification Record

Status: **H1 engineering acceptance complete, 2026-09-10.** All 245 synthetic tests across five
files and all required source checks pass. Read with the
[H1 checklist](./NeXusTrade-Phase-10.6H-Detailed-Checklist.md) and
[10.6B.3 contract](./NeXusTrade-Phase-10.6B.3-Detailed-Checklist.md).

The first containment batch is committed as `d747af6d2366a734be47d13cbac72057177f2d10`.
At the original verification checkpoint, this closeout was the uncommitted working patch on that
revision in branch `isolation`; that verification performed no merge, push, operational integration,
production identity binding, or real archive run. Subsequent status (2026-09-16): the user committed
and pushed H1 as `a0bfdf9e685c9de63729d276f5ffd053c59cb1f3`. H2 work remains in the isolated
checkout; no merge or operational integration has occurred. The unchanged H1 suite still passes 245 tests.
The source snapshot fingerprint below identifies the tested implementation independently of a later commit.

## Isolation Established For H1

- Development worktree: `U:\Projects\H1s\isolation`. Operational checkout:
  `U:\Projects\NeXusTrade-Otis`. Git metadata/history is shared; source files are separate.
  The earlier isolation audit checked 628 tracked source/documentation/script paths with no
  resolved escapes or shared file identities with their operational counterparts.
- Dependencies were provisioned into this worktree using the frozen lockfile, `--ignore-scripts`,
  a local `.pnpm-store`, local caches, and `--package-import-method copy`. All 879 checked dependency
  links resolved inside the worktree. Lifecycle scripts, including shared-Git Husky installation,
  were disabled. No package versions or manifest requirements changed. Closeout only reformats the
  lockfile, with parsed YAML equality checked before writing it.
- Runtime/tools: Node `24.17.0`, Vitest `4.1.11`, TypeScript `5.9.3`, Prettier `3.8.4`.
  Provisioning used available pnpm `11.19.0` with automatic manager replacement disabled; the
  declared `pnpm@11.8.0` remains unchanged. Package downloads were provisioning only.
- Fixtures use owned synthetic repositories under `.tmp/h1/`. The development worktree has no
  `data/archive` directory. Test cleanup verifies owned paths and removes fixture links before
  their directories. Real Windows directory junctions and file symlinks were tested without skips.
- A local `.env` exists and was not read for closeout. The
  [dedicated configuration](../backend/vitest.measurement-analysis.config.ts) disables environment
  loading with `envDir: false`, uses one Node worker with no watch, and selects only analyzer tests.
  Earlier default-runner passes are not evidence of environment-file isolation.
- Tests use an injected synthetic identity. The CLI entrypoint source is imported only under
  fixture-root/identity mocks and guarded filesystem spies; the production command is never run.
  Source review of the collector is read-only: no collector module is imported or invoked by the
  analyzer tests. No provider, network, database, scheduler, PAPER, wallet, or operational archive
  access is part of verification. Existing operational changes are not overwritten.

Isolation separates files and dependencies, not hardware. Keep checks bounded during collection.
Do not switch, merge, reset, install, or execute from the operational checkout. Its frozen final
invocation remains September 18 at 18:44 UTC / 11:44 AM PDT, with the 19:00 UTC / noon PDT anchor;
calendar time alone does not establish finality.

## Implemented Fixes And Contract Review

1. The first batch enforces the fixed archive root, regular filesystem components, no symlink or
   junction along archive/protocol ancestry, and matching resolved paths. It reproduced nine
   containment failures before the fix. Unbound identity and invalid arguments deny before source
   or archive filesystem operations; unexpected filesystem errors remain bounded.
2. The loader now accepts legitimate `NO_SELECTION` and duplicate-mint `SKIP_UNIT_WITH_REASON`
   slots without inventing replacement units. It rejects selected slots with no technical candidate,
   invalid selection reasons, non-32-byte base58 mints, and incorrect frozen selection hashes.
3. Final inventory rejects more than 96 units, discovery counts inconsistent with attempted slots,
   and market-context counts above four per valid unit, in addition to the existing 168/672 caps.
   A `COHORT_COMPLETE` assertion must satisfy its frozen completion gates. These checks validate
   producer structure; source inventory remains aggregate evidence, not a per-unit causal join.
4. Momentum validation preserves the producer's current-input-before-prior-input missingness and
   timestamp propagation, including `INVALID_VALUE` on finite-price ratio overflow. Non-anchor
   liquidity is rejected. Price must be finite and positive; liquidity finite and nonnegative.
   Available source freshness is inclusive at plus/minus 60 seconds. Numerical values are used only
   to validate structure/formulas and are discarded before capability aggregation.
5. Source-ledger dates now normalize valid offset timestamps to UTC. Markdown now includes the
   protocol, root, four artifact hashes, analysis status, and every availability enum count, within
   the five permitted sections. JSON's existing bounded schema and canonical fingerprint are retained.
6. The frozen protocol's Section 5.1 independence gate already includes maximum 20% date share.
   10.6B.3 Section 5.3 previously omitted it from the summary decision tree. That wording now matches
   the existing service: a failed minimum/independence gate means `MEASUREMENT_EVIDENCE_INSUFFICIENT`.
   No service threshold, status-selection logic, protocol byte, or collection policy was retuned.
7. The planned 96-unit target differs from the 72-unit assessment minimum. A valid final archive
   with 72–95 units can be assessed if every minimum and objective gate passes. The collector's
   insufficient outcome does not alone determine analysis status: frozen stale-lock recovery can
   finalize insufficient even with otherwise sufficient evidence. It is therefore not required to
   have 168 slots, and an insufficient outcome is not automatically rejected when completion gates
   pass. Operational finality remains a separately reviewed prerequisite.
8. Numeric mutations must preserve every aggregate report field and decision. Raw artifact hashes
   and the content fingerprint must change when those bytes change. The Section 8 wording explicitly
   excludes those identity fields from aggregate-equivalence assertions.

The pinned protocol is unchanged:
`dd57285927474e3e646bd4a52c5d37fbb550d5cb73f836db69b02827c5360458`.
The production identity remains `undefined`. V3 can assess measurement capability only; V2 remains
`NO_DEFENSIBLE_HYPOTHESIS`. H1 supplies neither a candidate nor PAPER authority.

## Section 8 Requirement Matrix

Test references:

- **Base**: [MeasurementCohortAnalysis.test.ts](../backend/src/research-measurement-cohort-analysis/MeasurementCohortAnalysis.test.ts), 75 cases.
- **Integrity**: [MeasurementCohortAnalysisIntegrity.test.ts](../backend/src/research-measurement-cohort-analysis/MeasurementCohortAnalysisIntegrity.test.ts), 115 cases.
- **Gates/report**: [MeasurementCohortAnalysisGates.test.ts](../backend/src/research-measurement-cohort-analysis/MeasurementCohortAnalysisGates.test.ts), 26 cases.
- **Dependencies**: [MeasurementCohortAnalysisDependencies.test.ts](../backend/src/research-measurement-cohort-analysis/MeasurementCohortAnalysisDependencies.test.ts), 22 cases.
- **CLI**: [MeasurementCohortAnalysisCli.test.ts](../backend/src/research-measurement-cohort-analysis/MeasurementCohortAnalysisCli.test.ts), 7 cases.

Shared fixture builders moved to
[MeasurementCohortAnalysis.test-support.ts](../backend/src/research-measurement-cohort-analysis/MeasurementCohortAnalysis.test-support.ts).
Parameterized names identify independent cases; some cases also loop over every enum/counter/partition.
All error names below have the prefix `MEASUREMENT_COHORT_ANALYSIS_`.

| 10.6B.3 requirement                   | Named evidence                                                                                                                                                                                                                                             | Expected result / closure                                                                                                                                                                                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Strict CLI                         | Base `accepts only its small fixed CLI surface before any archive action`, prohibited option families; Integrity `H1 strict parser` accepted/default/order and malformed argument matrices; CLI scope failure                                              | `INVALID_SCOPE`, no filesystem action or stdout. Complete.                                                                                                                                                                                                            |
| 2. Identity guard / success           | Base `default-denies production before resolving or opening the active archive` and injected-identity success; CLI identity failure and both successful formats                                                                                            | `IDENTITY_NOT_REGISTERED` before exists/stat/realpath/list/read; matching synthetic identity succeeds. Complete.                                                                                                                                                      |
| 3. Containment / finality / artifacts | Base `filesystem containment`, missing artifacts, active/extra states, all external artifact mismatches; Integrity `rejects a real file symlink for %s`, final-state/internal-inventory matrices, malformed JSON                                           | Root/lock/containment uses `ARCHIVE_NOT_FINAL`; invalid artifacts/final assertions use `SOURCE_INCONSISTENCY`. File symlinks and directory junctions exercised. Complete.                                                                                             |
| 4. Coherent rewrite                   | Base `fails closed for every externally registered artifact mismatch and coherent rewrite`                                                                                                                                                                 | Recomputed internal hashes cannot replace external identity; `SOURCE_INCONSISTENCY`. Complete.                                                                                                                                                                        |
| 5. Semantic integrity                 | Integrity `rejects %s with a matching external fixture identity`, safety matrices, duplicate mint with repaired references, canonical mint, valid no-selection/skip, caps, label-shaped members, source hash/provenance, value/missingness/freshness cases | Labels use `LABEL_QUARANTINE_VIOLATION`; other incoherent evidence uses `SOURCE_INCONSISTENCY`. Positive edge cases prevent rejecting legitimate frozen shapes. Complete.                                                                                             |
| 6. Frozen gates                       | Gates/report `H1 frozen gate boundaries`, including `matches every numeric gate to the frozen source-controlled protocol`; Integrity signed freshness matrix                                                                                               | 71/72 and 95/96 units, 71/72 mints, 7/8 dates, 31/32 partition units, 3/4 partition dates, 20% concentration, each objective/partition below/exactly/above 90%, 3/4 objective dates, 60000/60001 ms, and zero denominators. All three statuses established. Complete. |
| 7. Numerical independence             | Gates/report paired numeric mutations at 0 and 6 unavailable-liquidity facts                                                                                                                                                                               | Every aggregate field and status equal before/after; identity/fingerprint change; no numeric sentinel exposed. Both confirmed and not-confirmed examples. Complete.                                                                                                   |
| 8. Canonical reports                  | Gates/report `independently reconstructs the fingerprint and canonical JSON regardless of time or input order`; `emits the same bounded identity, counters, ledgers and outcome in exactly five Markdown sections`                                         | Independent SHA-256 preimage, stable key/enum/partition/date ordering, zero counters, five sections, bounded output, and no raw unit/source identifiers or numerical values. Complete.                                                                                |
| 9. Dependency/API boundary            | Dependencies audits every production module/entrypoint and installed Zod static closure; prohibited local-edge and dynamic/global/API negative fixtures                                                                                                    | Rejects collector/V2/provider/database/PAPER imports, env/network/write/scheduler/process access outside permitted entrypoint channels. Dedicated harness avoids env loading. Complete within limits below.                                                           |
| 10. CLI channels                      | CLI `emits only %s stdout on successful synthetic analysis`; `emits a bounded stderr-only %s failure`                                                                                                                                                      | One stdout write on success; one bounded stderr line and exit 1 for identity/scope/hash/missing/label failures, no sensitive path/argument disclosure, no archive write or generated report. Complete.                                                                |

## Formatting Baseline And Scope

The earlier full-format failure comprised 644 files whose mismatch was CRLF checkout conversion alone
and one lockfile with additional formatting differences. Closeout restored 639 remaining tracked
files only after verifying that LF-normalized bytes exactly equaled their committed Git blobs.
Already edited H1 files were formatted separately. Those checkout restorations produce no content
patch to the collector, frozen launch/runbook, providers, database, or other unrelated source.

[.gitattributes](../.gitattributes) now pins text checkouts to LF and retains the exact V3 protocol
`-text` exception. [pnpm-lock.yaml](../pnpm-lock.yaml) has formatting-only changes; parsed YAML
before/after is deeply equal, with no dependency version/resolution or manifest changes. The full
format check passes without weakening its file scope. Local ignored caches are excluded.

These tooling/checkout changes make this closeout patch broader than an analyzer-only integration.
Keep them out of the operational checkout through V3 closeout. Review integration separately and
preserve the analyzer's tested dependencies through the final report. Git may initially show stale
stat-only modifications after checkout restoration; the content diff is the review scope.

## Verification And Reproduction

Run from the isolated worktree with its installed dependencies only. These commands are direct
local-binary equivalents of the five 10.6B.3 Section 9 commands; they avoid Corepack changes to shared
host state and exclude only ignored local caches. Inspect each command's exit code independently.

```powershell
$env:TEMP = Join-Path (Get-Location) '.tmp\h1'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
node node_modules/vitest/vitest.mjs run --config backend/vitest.measurement-analysis.config.ts
node node_modules/typescript/bin/tsc -p backend/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p shared/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p frontend/tsconfig.app.json --noEmit
node node_modules/typescript/bin/tsc --noEmit --module NodeNext --target ES2022 --skipLibCheck --strict backend/vitest.measurement-analysis.config.ts
node node_modules/eslint/bin/eslint.js . --ignore-pattern .pnpm-store/** --ignore-pattern .tmp/**
node node_modules/prettier/bin/prettier.cjs . --check --ignore-path .gitignore --ignore-path .prettierignore
node scripts/check-secrets.mjs
git -c core.safecrlf=false diff --check
```

| Check                                               | Closeout result                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Dedicated analyzer suite                            | **245/245 passed**, five files, no skips; final source run 2026-09-10, about seven seconds. |
| Backend, shared, frontend typechecks                | Passed.                                                                                     |
| Dedicated harness typecheck                         | Passed.                                                                                     |
| Full repository lint                                | Passed.                                                                                     |
| Full repository formatting                          | Passed after the baseline repair above.                                                     |
| Secret scan and whitespace diff check               | Passed.                                                                                     |
| Changed documentation relative links                | Passed.                                                                                     |
| Frozen protocol SHA / undefined production identity | Verified; unchanged.                                                                        |

Source snapshot fingerprint: `1618bc2d51ba9e26f6f9537ac1ee725d392361e0ac1b333cec680d725b69c50d`.
Its preimage is the UTF-8 concatenation of `relative/path<TAB>sha256(raw bytes)<LF>` rows sorted
lexicographically by path, for all `.ts` files directly inside
`backend/src/research-measurement-cohort-analysis/`, the analyzer entrypoint
`backend/src/scripts/research-measurement-cohort-analyze.ts`, the dedicated Vitest configuration,
`.gitattributes`, and `pnpm-lock.yaml`. Documentation is excluded to avoid a self-reference.
This records the tested working patch; attach the eventual commit to the review when committing it.

## Verification Limits

- No operational/archive result or collector end-to-end behavior is inferred from synthetic tests.
  Pure gate fixtures deliberately isolate thresholds; some combinations (such as high date share
  with otherwise sufficient counts) cannot arise under valid frozen slots. Loader acceptance is
  established separately by temporary archive fixtures.
- The dependency audit walks static production imports/exports, the installed Zod ESM closure,
  and explicit prohibited APIs/dynamic access. It is a regression check, not an adversarial JavaScript
  sandbox or proof about every possible reflective construct. It does not execute the host runtime's
  internal implementation. H4's broader repository boundary/CI work remains separate.
- Filesystem inspection is not an atomic snapshot and cannot prevent concurrent path swapping.
  Immutable finalization, trusted read-only handling, and externally bound hashes remain required.
- The broad backend/runtime/database suites were intentionally not run. H2 must separately establish
  native SQLite binding readiness and its own isolated test allowlist; H1 does not establish that.

## H1 Closeout Checklist

- [x] Complete parser, final-state/file-symlink, semantic-integrity, safety, identity, and provenance cases.
- [x] Complete population/date/partition/objective/freshness boundaries and document frozen-contract interpretations.
- [x] Establish numerical independence, canonical fingerprint, and Markdown/JSON output requirements.
- [x] Complete dependency/API and synthetic CLI channel evidence with no real archive access.
- [x] Resolve the full formatting baseline while preserving committed frozen bytes and operational files.
- [x] Pass the dedicated tests, four typechecks, full lint/format, secret scan, and diff checks.
- [x] Map all ten requirements and synchronize the parent H1 and 10.6B.3 Section C acceptance boxes.

No user test or command is outstanding to close H1 engineering acceptance. Review and commit this
patch on the isolated branch; do not merge it into the operational checkout during collection.
The [H2 detailed checklist](./NeXusTrade-Phase-10.6H-H2-Detailed-Checklist.md) is ready for review,
with implementation approval still pending. Final-state review, final artifact binding, and one
real stdout-only analysis remain the separate 10.6B.3 Section D gates after collection finishes.
