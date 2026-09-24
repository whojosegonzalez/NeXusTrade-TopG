# Main Into Isolation — Integration Record

Current handoff update (2026-09-18): integration was committed as `b8a91fc` and pushed by the user; isolation including H1-H3 and H4 planning was then merged into main at `63f5378`. Isolation `3b7b229` and that main merge had identical trees at H4 start. H4 was implemented in the locked isolation worktree, passed local and user-supplied hosted checks, and merged through PR #5 at `88921e9`; see the [final acceptance record](./Phase-10.6H-H4-Verification.md). The record below preserves the historical pre-commit checkpoint and B.3 provenance; its pending-merge wording describes that earlier checkpoint. No historical analyzer run is attributed to H1 or H4.

Date: 2026-09-18. PR #3: **base isolation, compare main**.

Status: **Conflicts resolved and combined-source verification passed locally. Merge commit and
push remain pending user review.** Main and its operational checkout were not updated.

## Inputs And Scope

- Isolation parent: `f8f8d4c` (H3), with H1 `a0bfdf9` and H2 `ff6d586` in its history.
- Main target: `ae5c940` (bounded slot-ledger repair), including `6f8ae85` (final identity binding).
- These match the two commits shown in the user-created PR. No remote fetch was performed.
- Starting isolation tree was clean. `git merge --no-commit --no-ff main` prepared integration;
  worktree-specific Git metadata required elevated access because it lives in the shared Git
  directory. All source/dependency/fixture work remained in `U:\Projects\H1s\isolation`.
- No production analyzer invocation, operational archive read, scheduler operation, provider call,
  database migration, operational checkout modification, commit or push occurred.

## Conflict Decisions

| File                                        | Resolution                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MeasurementCohortAnalysisLoader.ts`        | Combine main's strictly ordered, unique absolute slot coordinates and allowed gaps with H1's canonical mint, selection hash, duplicate-mint skip, technical-count, path and other integrity guards. Validate anchors against each row's actual slotIndex.                                                                                              |
| `MeasurementCohortAnalysis.test.ts`         | Retain H1's full suite, filesystem observations and isolated fixture helpers. Add main's exact production-identity assertion and missing-slot/invalid-ledger regression. Test unbound denial via explicit test-only identity injection now that production is bound.                                                                                   |
| `MeasurementCohortAnalysis.test-support.ts` | Extend the synthetic helper to omit a requested slot coordinate while preserving absolute IDs, anchors, hashes and 96 valid units. Keep owned temporary repository/protocol paths.                                                                                                                                                                     |
| B.3 detailed checklist                      | Preserve H1's historical synthetic evidence and main's binding/repair/report record. Explicitly distinguish the two source histories instead of retroactively attributing the real run to H1.                                                                                                                                                          |
| `pnpm-lock.yaml`                            | Retain isolation's exact tested lockfile. Main differs semantically: autoInstallPeers false, removed testing-library DOM peer resolution and Linux libc metadata. Those incidental dependency changes are unrelated to binding/loader repair; do not import them as a conflict-resolution shortcut. No install or lockfile regeneration was performed. |

Main's identity and CLI files merge unchanged, including all four approved artifact hash literals,
fixed production root/protocol and test-only identity injection. CLI arguments cannot override
identity/root/protocol/output scope. The production identity is now bound in isolation; do not
run the production command as an integration test.

## Historical B.3 Provenance — Not A New Analysis

The supplied main-branch conversation reports V3 finalized on September 12 and the user disabled
the scheduler. Main's committed B.3 checklist records final-state review, binding, a failed run,
the synthetic repair and a separately approved successful replacement run on September 18.
Neither archive finality nor scheduler state was independently inspected in this task.

Binding is represented by `6f8ae85`. The conversation says the successful replacement ran with
the repair still uncommitted; that repair and report documentation were subsequently committed
as `ae5c940`. Thus record the execution as **6f8ae85 plus the approved uncommitted repair later
recorded in ae5c940**, not as a run of the integrated source. No independent machine-level
snapshot of the historical execution was supplied; committed code and the conversation establish
the documented lineage, not proof of every runtime/dependency byte at execution time.

Main's recorded report fingerprint is
`3cafcf1655e1bdf6bd71fc6a7b5f84e2aa86f9ac5aa4faefb3513bba683caeca`.
It reports `MEASUREMENT_CAPABILITY_NOT_CONFIRMED`, archive identity/finality matched, 96 distinct
valid units from 97 recorded slots, 58/38 partition counts and 9/8 partition UTC dates. Liquidity
availability was 60.344828% / 63.157895%, below the frozen 90% threshold. Both momentum objectives
passed their specified gates. The recorded zero side-effect counters apply to that bounded report;
they do not mean the analyzer performed no filesystem reads.

H1 was completed in isolation but was absent from main's historical execution. The requirement
to integrate its verification before binding was not fulfilled in that source lineage. Preserve
that historical limitation; this merge and its synthetic checks do not change the historical
run, recompute its report or retroactively certify it under the integrated loader.

## Combined-Source Verification

The dependency isolation probe checked 866 links and the native SQLite module using an in-memory
query. Existing owned `.tmp/h3` temporary storage and `.tmp/h2` SQLite fixtures were used, with
the unchanged dedicated harnesses. No owned SQLite fixtures remain after cleanup.

| Check                                                | Result                                                                                                                                                                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Analyzer/H1 dedicated suite                          | **247 passed, five files**: original 245 cases plus the two main binding/slot-ledger cases. All default-deny, path containment, strict validation, gate, dependency and synthetic CLI-channel coverage retained. |
| H2 dedicated suite                                   | **194 passed, 22 files**, unchanged.                                                                                                                                                                             |
| H3 dedicated suite                                   | **98 passed, 20 files**, unchanged.                                                                                                                                                                              |
| Backend/shared/frontend TypeScript checks            | Passed.                                                                                                                                                                                                          |
| All three dedicated harness TypeScript checks        | Passed.                                                                                                                                                                                                          |
| Repository ESLint, Prettier, secret scan             | Passed.                                                                                                                                                                                                          |
| Working/index diff checks and conflict-marker review | Passed.                                                                                                                                                                                                          |

Commands from the isolation root:

```powershell
$env:TEMP = Join-Path (Get-Location) '.tmp\h3'
$env:TMP = $env:TEMP
node node_modules/vitest/vitest.mjs run --config backend/vitest.measurement-analysis.config.ts
node node_modules/vitest/vitest.mjs run --config backend/vitest.h2.config.ts
node node_modules/vitest/vitest.mjs run --config backend/vitest.h3.config.ts
node node_modules/typescript/bin/tsc -p backend/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p shared/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p frontend/tsconfig.app.json --noEmit
node node_modules/typescript/bin/tsc --noEmit --module NodeNext --target ES2022 --skipLibCheck --strict backend/vitest.measurement-analysis.config.ts backend/vitest.h2.config.ts backend/vitest.h3.config.ts
node node_modules/eslint/bin/eslint.js . --ignore-pattern .pnpm-store/** --ignore-pattern .tmp/**
node node_modules/prettier/bin/prettier.cjs . --check --ignore-path .gitignore --ignore-path .prettierignore
node scripts/check-secrets.mjs
git diff --check
git diff --cached --check
```

## Source Identity

Integrated analyzer runtime fingerprint:
`3e804650b527d2a365f82312b0765164bb5e7e81e6610be788f3f53c8b6f45d8`.
Select all `.ts` files in `backend/src/research-measurement-cohort-analysis` whose filenames do
not contain `.test`, plus `backend/src/scripts/research-measurement-cohort-analyze.ts`. Sort their
repository-relative forward-slash paths; hash each raw file with SHA-256; hash UTF-8 rows
`path<TAB>hash<LF>` including the final newline. This excludes documentation/tests and does not
claim to fingerprint the whole historical execution environment.

| File     | Main ae5c940 raw SHA-256                                           | Integrated raw SHA-256                                             |
| -------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Identity | `82bfae2b42948a21fb4020dd2642ea4cda5080aa333ba4094a8f6335a25a0b5b` | Same                                                               |
| CLI      | `6ba070636bd8f516b0e4be010d852f192140fc0dc9e2b0f9b063da99629a2007` | Same                                                               |
| Loader   | `08be1bdbbf56b71c35d2497b08f4294e3c4e43ba43e16984dba09786a02680e3` | `7a6cdb123ee18ba499c5f8a0abe3d6e5ee04ef0d502b50a280ae5780719305eb` |

The isolated frozen protocol still hashes to
`dd57285927474e3e646bd4a52c5d37fbb550d5cb73f836db69b02827c5360458`.
The protocol, launch, runbook, collectors, H2/H3 code/tests and manifests were not edited.

## Review And Next Work

Review the local staged merge and commit it on isolation, then push isolation. This records main
as a merge parent without updating main. GitHub may then recognize PR #3 as already integrated;
if it remains open with no remaining changes, close it as completed. Do not use the web conflict
editor to push isolation's changes into the PR's source branch, main.

Next prepare H4's detailed checklist, obtain implementation approval, implement and verify in
isolation. The later isolation-into-main review is a separate direction and decision. Begin the
proposed B.4 measurement-remediation decision from the unified baseline afterward. H-05/H-06
are finding IDs covered by H1/H4, not additional H5/H6 packages. No new protocol, collection,
PAPER activity or real analyzer rerun is authorized by this integration record.
