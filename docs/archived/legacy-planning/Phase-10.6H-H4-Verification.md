# H4 Verification And Resumption Record

Status: **H4 engineering acceptance closed; integrated into main through PR #5 at `88921e9`.** Closeout recorded 2026-09-23; implementation began 2026-09-18.

User approved D1-D9 and H4-00 through H4-07 from clean isolation `3b7b229`. Local main `63f5378` contains that commit with an identical source tree at the start; no Git synchronization mutation was needed. Implementation was performed in `U:\Projects\H1s\isolation`. The user subsequently committed, pushed and merged the implementation. This agent did not access operational archives/DBs or invoke the production analyzer, providers or scheduler.

## Final acceptance and merge

H4 implementation is `3119487`; the portable type-edge correction is `bde0d7ce54cffb8aea32d9a23bd3a006023bc47b`. The user supplied a GitHub screenshot showing all four checks green: Ubuntu and Windows, each for push and pull_request. The user then confirmed commit, push and merge. Local Git independently confirms merge `88921e951331c82047dd880e2213704c1d516830`, PR #5, with parents `63f5378` and `bde0d7c`. Before this documentation-only closeout, isolation HEAD and main had identical trees.

Evidence source: user-supplied final screenshot `codex-clipboard-b316e24f-8c85-4050-846f-1918f5926785.png`, user confirmation and local Git history. The checks are associated with the corrected PR head by that conversation sequence and merged parent; the screenshot itself does not display the SHA. Individual run URLs, run IDs, raw hosted logs and a separate post-merge main run were not retrieved. No such evidence is invented. T13/T16 are accepted on the supplied hosted results and confirmed integration, not inferred from local Windows tests. Original local test counts remain historical; the correction added four Node cases (27 total) without changing application suites.

The following CI failure/fix narrative and local command results are historical checkpoints. Final acceptance here supersedes their earlier pending wording. The source-fingerprint file remains the original implementation evidence; Git commits identify the final corrected source. These closeout documentation edits are not yet committed or included in `88921e9`.

## Hosted CI follow-up — PR #5 (historical)

User-supplied screenshots show commit `3119487` pushed on isolation and PR #5 open: Windows passed both push and pull-request checks; Ubuntu failed both. Ubuntu successfully installed dependencies and loaded in-memory SQLite, then failed the architecture checker on three `drizzle-orm/sqlite-core` type edges in fills.ts, orders.ts and paperOperations.ts. Full run URLs were not supplied. These observations supersede the earlier statement that no hosted results had been observed; H4 acceptance remained open at that checkpoint.

Cause: the type-file allowlist recorded a Windows pnpm virtual-store directory, including its shortened peer suffix. This is installation-layout metadata, not a portable dependency identity. The follow-up patch removes that physical-path entry and permits only the exact package specifier from those three source files, requiring successful contained resolution as an external package with matching package identity. Runtime permissions remain separate; unresolved packages, local aliases and other source files are still rejected.

Validation: 27 Node boundary/runner tests pass, including two synthetic pnpm layouts and negative runtime/source/unresolved/alias cases. The architecture checker passes all 44 protected module visits. `node scripts/verify-isolated.mjs static` exited 0: containment/native probe, architecture, backend/shared/frontend and harness typechecks, ESLint, Prettier, secret scan and diff check all passed. The unchanged application suites were not rerun for this checker-only correction; the subsequent hosted run passed, as recorded above. No production source, dependency version, lockfile or workflow action was changed. The prior source fingerprint describes the original H4 patch committed as `3119487`; it is historical evidence, not a fingerprint of this follow-up.

The user pushed the fix and merged PR #5 after the subsequent four checks passed. The action-runtime deprecation warning and runner-image migration notice were separate from the failed type-edge check; this correction does not claim to resolve those notices.

## Batch checkpoint

| Batch | Local result                                                                                                                                    | Outstanding                                                                 |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| H4-00 | Approved baseline, real paths/dependencies checked, dedicated guarded harness, two pre-refactor snapshots recorded.                             | None.                                                                       |
| H4-01 | 595 source modules inventoried; 51 admitted and 100 excluded tests named; static source closures, retained coupling and reader debt documented. | Future expansion requires review.                                           |
| H4-02 | Versioned exact-module/type policy, TS resolution, transitive/alias/barrel and capability checks; H1 stronger checks retained.                  | None.                                                                       |
| H4-03 | Exact read facade, compile-negative mutation/DB/calculator fixtures, runtime read proxies, fixed query/limit/latest-session checks.             | None.                                                                       |
| H4-04 | Legacy v0 readers with bounded diagnostics and optional-field salvage; no stored-format changes.                                                | Other readers explicitly deferred.                                          |
| H4-05 | Types, readers and pure quote aggregation extracted; original structured/text snapshots unchanged.                                              | None.                                                                       |
| H4-06 | Guarded runner, pinned workflow, clean locked Windows install and native SQLite verified.                                                       | Closed by supplied hosted Windows/Linux success.                            |
| H4-07 | Local combined suites/static checks passed; docs and conditional main handoff prepared.                                                         | Merged at `88921e9`; run URLs not captured (see evidence limitation above). |

See [boundary audit](./Phase-10.6H-H4-Boundary-Audit.md), [exact test/closure inventory](./Phase-10.6H-H4-Inventory.json), [source fingerprints](./Phase-10.6H-H4-Source-Fingerprint.json), [checklist](./NeXusTrade-Phase-10.6H-H4-Detailed-Checklist.md) and [main developer prompt](./Phase-10.6H-Main-Developer-Handoff.md).

## Commands and evidence

Local Windows: Node 24.17.0, pnpm 11.8.0, TypeScript 5.9.3, Vitest 4.1.11, better-sqlite3 12.11.1, SQLite 3.53.2. Dependency probe found 866 contained links. No package upgrade or lockfile change.

`node scripts/verify-isolated.mjs` runs the commands below sequentially, stopping at the first nonzero exit. The final complete run exited 0 on 2026-09-19 with 23 Node cases, 247 H1, 194 H2, 98 H3 and 18 H4 tests (580 total). No skipped tests were reported. Separate modes `static` and `tests` are available; both still execute containment and architecture checks.

| Command/check                                                                                                                                   | Local result                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `node scripts/check-isolation.mjs`                                                                                                              | Passed; contained dependencies/output ancestors and in-memory native SQLite. |
| `node scripts/architecture-check.mjs`                                                                                                           | Passed, policy v1, 44 protected module visits.                               |
| `node node_modules/typescript/bin/tsc -p backend/tsconfig.json --noEmit`                                                                        | Passed.                                                                      |
| Same compiler, `-p shared/tsconfig.json --noEmit`                                                                                               | Passed.                                                                      |
| Same compiler, `-p frontend/tsconfig.app.json --noEmit`                                                                                         | Passed.                                                                      |
| Same compiler, `--noEmit --module NodeNext --target ES2022 --skipLibCheck --strict`, followed by all four dedicated backend Vitest config paths | Passed.                                                                      |
| `node node_modules/eslint/bin/eslint.js . --ignore-pattern .pnpm-store/** --ignore-pattern .tmp/**`                                             | Passed after correcting a negative-fixture lint expression.                  |
| `node node_modules/prettier/bin/prettier.cjs . --check --ignore-path .gitignore --ignore-path .prettierignore`                                  | Passed; final evidence docs rechecked separately after recording results.    |
| `node scripts/check-secrets.mjs` and `git diff --check`                                                                                         | Passed.                                                                      |
| `node --test scripts/architecture-check.test.mjs scripts/verify-isolated.test.mjs`                                                              | 23 tests passed (19 architecture/output-path and 4 runner cases).            |
| `node node_modules/vitest/vitest.mjs run --config backend/vitest.measurement-analysis.config.ts`                                                | 247 tests, 5 files passed.                                                   |
| Same Vitest command, `--config backend/vitest.h2.config.ts`                                                                                     | 194 tests, 22 files passed.                                                  |
| Same Vitest command, `--config backend/vitest.h3.config.ts`                                                                                     | 98 tests, 20 files passed.                                                   |
| Same Vitest command, `--config backend/vitest.h4.config.ts`                                                                                     | 18 tests, 4 files passed; two unchanged baseline snapshots.                  |

Baseline snapshots were created with `node node_modules/vitest/vitest.mjs run --config backend/vitest.h4.config.ts --update` **before production refactoring**, against the original two analytics tests and a fixed Date.now/report clock. Subsequent runs did not update snapshots. Independent assertions cover counts, rank boundaries, filtered fields, call order and session selection.

The initial combined run stopped at ESLint because the negative type fixture used a bare property expression; changed to `void repositories.db` with its expected type error retained. This was a test lint fix, not a production behavior change. Final hardening added rejection of redirected output ancestors before creation, TypeScript import-equals loading and unresolved explicitly allowed packages. Negative probes modify only owned synthetic files.

## Locked clean install

Copied only workspace package manifests, pnpm workspace/lock and .npmrc into `.tmp/h4/clean-install`. Provisioned pnpm 11.8.0 under `.tmp/h4/tooling` using `npm install --prefix .tmp/h4/tooling --ignore-scripts --no-package-lock pnpm@11.8.0`; no global package-manager change. With HUSKY=0 and npm/XDG caches under `.tmp/h4`, ran from the clean-install directory:

```text
node ../tooling/node_modules/pnpm/bin/pnpm.mjs install --frozen-lockfile --config.auto-install-peers=true --config.manage-package-manager-versions=false --store-dir ../store
```

Exit 0; 360 locked packages installed with existing allowed better-sqlite3/esbuild builds. Clean-install native SQLite opened only `:memory:` and returned 3.53.2. Copied lockfile remained byte-identical to the repository lockfile. SHA-256: `e59c00031e254b877146984fc2bb5ee493c5c9dfc57ff63aaff3868a039ae6a4`. Explicit peer alignment reconciles .npmrc=false with retained lockfile=true without regeneration. An initial unrelated preinstalled pnpm version probe attempted automatic management and was interrupted; it was not used as installation evidence.

## Acceptance mapping

| Gate    | Named evidence                                                                                                                                         | Status                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| T01     | architecture-check: allowed cycles/type classification; exact policy and boundary audit.                                                               | Local passed.                                           |
| T02     | Direct, barrel export, alias and transitive barrel mutation fixtures; nonzero CLI assertion.                                                           | Local passed.                                           |
| T03     | Dynamic/computed imports, require, import-equals, unresolved type/runtime/package targets, cycles and redirected source fixtures.                      | Local passed.                                           |
| T04     | Retained MeasurementCohortAnalysisDependencies tests; renamed fs write and global/process/loading mutations.                                           | Local passed.                                           |
| T05     | H4ReadFacade compile-negative fixture; service read proxies; calculator accepts projected facts only.                                                  | Local passed.                                           |
| T06-T08 | H4Readers: missing/invalid cases, unsupported interpretation versions, partial optional fields, finite numbers and bounded diagnostics.                | Local passed.                                           |
| T09     | AnalyticsReportService: explicit session, latest populated PAPER session, empty aggregates/no-session failure, 10,000-row query argument, fixed clock. | Local passed.                                           |
| T10     | H4Readers independent rank boundary/count test plus original service report expectations.                                                              | Local passed.                                           |
| T11     | Backend callers typecheck and pre-refactor structured/text snapshots.                                                                                  | Local passed.                                           |
| T12     | H4Boundary fetch/http/subprocess/env/archive/default DB; retained H1/H2 redirected-fixture tests; new output-ancestor negative probe.                  | Local passed.                                           |
| T13     | Clean Windows frozen install and native memory database above.                                                                                         | Accepted; supplied Windows/Linux checks passed.         |
| T14     | verify-isolated tests for exact suite selection, first child failure, signals/spawn errors and invalid mode; reviewed workflow below.                  | Accepted; supplied hosted checks passed.                |
| T15     | Combined suites and static command table above.                                                                                                        | Local passed, final combined run exit 0.                |
| T16     | Windows/Linux GitHub Actions at the actual pushed revision.                                                                                            | **Accepted: four green checks supplied; PR #5 merged.** |

## CI, provenance and next action

Workflow uses pull_request, push on main/isolation/codex branches, and manual dispatch; contents:read only, checkout credentials disabled, no deployment, no pull_request_target, no runtime secrets/operational mounts. Matrix is Windows/Linux with a 30-minute timeout and cancellation of superseded runs. Node/pnpm versions are pinned; dependencies use the unchanged lockfile and explicit peer setting. Both platform suites execute junction/symlink equivalents rather than silently skipping them.

Immutable action revisions were verified against official Git refs using `git ls-remote` before writing the workflow: actions/checkout v4 `11d5960a326750d5838078e36cf38b85af677262`, actions/setup-node v4 `49933ea5288caeca8642d1e84afbd3f7d6820020`. Download/build provisioning is distinct from guarded test execution. Local Windows evidence does not establish Linux or hosted success.

Source is baseline `3b7b229` plus 22 changed/new non-documentation files identified by the fingerprint record; aggregate SHA-256 `0491c95a8d9f85f6d1f1b94bec4a376dcb3fbfa4ae5bec577793f0c7db92c2b8`. It hashes actual worktree bytes, not a nonexistent commit. Archive identity, collector/protocol, schema, dependency lock and H1-H3 source were unchanged by H4. Historical B.3 source remains `6f8ae85` plus the repair later committed as `ae5c940`, without H1; H4 does not retroactively validate that execution.

Next: carry this documentation-only closeout into main through the user workflow, then use the main developer handoff to prepare the B.4 decision checklist for review. No extra collector, archive analysis, migration or PAPER/live execution is authorized. No new H5/H6 packages are defined; H-05/H-06 are findings addressed by H1/H4.
