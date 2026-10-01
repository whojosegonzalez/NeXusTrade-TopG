# Phase 10.6H H2 Verification And Resumption Record

Status: **H2 engineering acceptance complete in the isolated checkout, 2026-09-16.**
Subsequent status, 2026-09-17: H2 is committed as `ff6d586`; the user reports it pushed and unmerged.
Operational integration and migration remain separately gated. Historical checkpoint wording below
records the state when tests were run, not the current commit status.

## Authority And Baseline

The user approved implementation of the [H2 checklist](./NeXusTrade-Phase-10.6H-H2-Detailed-Checklist.md)
on 2026-09-10, including D1-D9 and batches H2-00 through H2-07. They requested that checked tasks and
remaining work be recorded incrementally. The base is `a0bfdf9` (`H1 completed in the isolated workspace`),
branch `isolation`, worktree `U:\Projects\H1s\isolation`. Initial Git status was clean. No merge or
operational checkout change is part of implementation. H1's production identity remains unset.

## Progress

| Batch   | Status   | Evidence                                                                                                                                               |
| ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H2-AUTH | Complete | User approval recorded in the checklist; committed H1 baseline verified.                                                                               |
| H2-00   | Complete | Dedicated harness; 866 root/backend dependency links contained; native SQLite 3.53.2 verified.                                                         |
| H2-01   | Complete | Accepted implementation contract, 12 identity cases, three added accounting cases, existing runner characterization, retained defect probes.           |
| H2-02   | Complete | Schema constraints, trusted three-migration chain, preflight and populated rollback; 15 migration and 24 schema cases.                                 |
| H2-03   | Complete | Transaction lifetime/rollback, conditional writes, operation registration/replay/corruption, radar merge and independent-connection contention checks. |
| H2-04   | Complete | Atomic BUY, rollback at six write boundaries, replay/new eligible decision, current cash, dry-run and protected diagnostics.                           |
| H2-05   | Complete | Atomic SELL, current-row deltas, exit integration, dry-run, replay and diagnostic failure evidence pass.                                               |
| H2-06   | Complete | Read-only supplied-snapshot service, complete/contradictory/incomplete history checks, bounded findings, genuine read-only fixture handle.             |
| H2-07   | Complete | 194 H2 tests / 22 files, 245 unchanged H1 tests, required static checks and final evidence below.                                                      |

## Resume Here

H2 implementation and isolated engineering verification are complete and committed as `ff6d586`.
The [H3 detailed implementation checklist](./NeXusTrade-Phase-10.6H-H3-Detailed-Checklist.md) is ready for review before implementation. Do not merge into the operational checkout or run any
operational migration. Preserve H1 and frozen V3 dependencies through final archive binding/reporting.
H3 implementation remains unapproved; H4 still needs its detailed scope/checklist. The entries
below retain historical checkpoints; the final acceptance section supersedes their pending counts.

## H2-00 Evidence And Commands

The initial native probe failed because H1 intentionally skipped install scripts. Installed only the
locked better-sqlite3 12.11.1 Windows x64 Node ABI 137 prebuild from its upstream release, into this
worktree's independent dependency directory. Cache and temporary output stayed under `.tmp/h2/`.
Network provisioning required a sandbox escalation and succeeded; no manifest, lockfile, machine-wide
tooling, shared cache, or operational dependency was changed. Subsequent in-memory query returned
SQLite 3.53.2. No provider was contacted.

`backend/vitest.h2.config.ts` disables environment files/watch, uses one worker, and explicitly selects
four existing PAPER runner/config test files plus H2Baseline and H2Boundary. The dependency audit walks
their local runtime import closures, including shared source; it passed before database tests ran.
The existing database fixture helper is replaced only in this harness with H2-owned temporary files.
The native constructor rejects databases outside the fixture root; environment reads and fetch are
blocked. Every fixture closes before containment-checked cleanup, including SQLite WAL/SHM files.

```powershell
$env:TEMP = Join-Path (Get-Location) '.tmp\h2'
$env:TMP = $env:TEMP
node node_modules/vitest/vitest.mjs run --config backend/vitest.h2.config.ts
```

Initial result: six files, 25 passed and five expected failures. `H2Baseline.test.ts` retains H-01 BUY
cash-write rollback, H-02 duplicate active positions/null-pair radar/negative cash, and H-04 sessions-only
readiness as `it.fails` cases. These document defects, not fixed behavior. Convert each to a normal
passing regression when its implementation lands; no expected failure may remain at H2 acceptance.
The existing runner cases characterize success/rejection/dry-run and SELL fake quote/fallback accounting.

## H2-01 And Initial H2-02 Evidence

The [implementation contract](./Phase-10.6H-H2-Implementation-Contract.md) records exact canonical key/
digest fields, explicit stable retry intent, terminal/retryable state decisions, write sets, every
caller family, radar merge rules, schema/nullability/ownership design, and reconciliation limits.
PaperOperationIdentity implements strict versioned BUY/SELL intent parsing, ownership guards, stable
keys and digest conflicts, and precise decimal canonicalization. Twelve pure cases pass. Three
H2AccountingCharacterization cases add zero-fee/slippage, decimal truncation, upward slippage rounding,
negative P/L, and already-net SELL fill evidence to the existing runner/config cases.

MigrationContract pins committed 0000/0001 SQL hashes, their explicitly enumerated historical CRLF
hashes, and 52/60 SQLite schema objects. Historical SQL and existing journal entries were not edited.
The source checker accepts only those known hashes; it never normalizes unknown source bytes into
trust. Schema comparison permits only the corresponding LF/CRLF representation difference.
MigrationReadiness checks journal structure, complete ordered rows/hashes, and actual schema objects.
The explicit migration runner uses one immediate transaction for schema plus journal, restores the
connection's foreign-key setting, and checks foreign keys before commit. No operational migration ran.

H2Migrations supplies 14 passing cases: empty/partial/full chain, repeat initialization/upgrade,
historical CRLF identity, missing middle entry, wrong hash, newer/duplicate journal entries, missing
index, forged table/journal, injected interruption rollback, and nested-transaction rejection.
H-04's baseline expected failure was converted to a normal regression. Four expected failures remain
for H-01/H-02 and must be resolved in later batches.

Latest dedicated run: **55 passed, four expected failures, nine files**. Backend typecheck passed
before the latest migration/characterization additions; rerun static checks for the next checkpoint.
Changes are uncommitted. New H2 schema, transaction unit of work/durable operation storage, BUY/SELL
wiring, reconciliation, and final concurrency/recovery acceptance are not yet implemented.

## H2-02 Completion Checkpoint

H2-02 is complete in the working patch. `0002_h2_accounting_integrity.sql`, its Drizzle snapshot,
and an appended journal entry add the constrained accounting schema and PAPER operations. The
trusted schema inventory now has 76 objects, including immutable-operation triggers. Prior schemas
remain pinned at 52/60 objects. New operation/order/fill links are nullable for legacy data; the
review caught and corrected generated INSERT/SELECT statements to explicitly supply NULL rather
than read a nonexistent legacy operation_id column. No historical link or intent was invented.

H2MigrationPreflight reports up to 100 bounded table/id/code findings for invalid domains, cash/fee/
timestamp shapes, duplicate exposure/null-pair radar, and broken ownership/FKs before upgrade writes.
H2Schema covers direct-SQL rejection, legitimate losses/closed histories/distinct pairs, operation
immutability, complete terminal evidence, one order/fill per operation, preserved legacy columns,
NULL new links, invalid-data preflight preservation, and rollback after a populated mid-rebuild fault.

The stale-price SELL fixture now supplies a creation time no later than its deliberately old update
time. Its stale-price expectation is unchanged; the fixture previously contradicted the new timestamp
invariant. Fifteen ordinary script entrypoints now assert readiness without automatically applying
migrations. Explicit migration/reset/seed tooling remains separate and was not invoked; a static test
guards ordinary scripts against reintroducing implicit migration.

Latest dedicated run: **84 passed, one expected failure, ten files**. H-02 and H-04 are normal passing
regressions. Only H-01's BUY cash-write rollback remains expected-failing until accounting integration.
Backend typecheck/lint are being rerun for this checkpoint. H2-03 through H2-07 remain open; H2 is not complete.

## 2026-09-14 H2-03 And BUY Integration Checkpoint

H2-03 now supplies synchronous immediate transactions with one shared executor, expired-repository guards, async callback rollback, conditional cash/P&L and position/order transitions, durable immutable registration/result validation, atomic null/non-null radar merge, and bounded contention without changing connection timeout policy. The independent-connection contention fixture explicitly uses zero timeout only on its synthetic contender.

The dedicated run after initial BUY integration passed **99 tests in 12 files, with no expected failures**. Backend typecheck passed. H-01 now injects the scoped cash-write failure and verifies rollback as a normal regression. Expanded H2Buy tests were added afterward and still require their next recorded run; H2-04 is not yet marked complete.

BUY registration and replay precede quote preparation. The accounting commit re-reads owned evidence, current cash/governance and blocking exposure. All economic writes plus required radar/order/result are atomic. Diagnostics are outside the transaction and failures appear in a separate summary count. Missing BUY price now retains PENDING with no rejected order, following the approved retryable-evidence contract; the legacy expectation was updated explicitly. No SELL integration, reconciliation, final crash/race matrix, operational migration or merge has occurred.

## SELL And Reconciliation Checkpoint

Dedicated suite: **151 passed in 17 files**, no expected failures. Backend typecheck and repository ESLint pass. SELL tests cover six transactional fault boundaries, reopening/replay before quote work, concurrent cash/P&L changes on another connection during quote preparation, quantity/basis/fee/gate changes, cached age at commit, retryable missing evidence, and signed loss accounting. The two existing ExitManager test files pass after explicitly updating temporary quote failure classification.

Reconciliation consumes a caller-supplied consistent scoped snapshot, without a connection factory or write capability. It reports seven accounting/evidence invariants and at most 100 bounded findings; discrepancy dominates incomplete evidence. A real readonly SQLite handle rejects writes and produces the same report with unchanged fixture rows. Linked H2 BUY/full-close SELL history needs no extra ledger. Seeded, partial, unlinked historical or unexplained cash movements remain incomplete; any cash-equation contradiction is still reported. A future deposit/withdrawal/correction workflow needs a separately approved cash-movement ledger proposal through 10.7A/10.8B, with no historical backfill inferred by H2.

Call-site inspection found PaperRunner and PaperSellRunner routed through their updated services; ExitManager constructs the same SELL service. TerminalStageRunner has discovery/research/analytics stages but no BUY/SELL stage, so no execution adapter is added. H1 and operational runtime remain unchanged. The worker recovery harness was added after the 151-test run and is not yet counted as verified.

## Final Acceptance — 2026-09-16

Base: `a0bfdf9e685c9de63729d276f5ffd053c59cb1f3`, branch `isolation`, worktree
`U:\Projects\H1s\isolation`. H1 was committed/pushed by the user; H2 remains an uncommitted patch.
Source fingerprint: **a482a4597e9da0c8a9604cdff13855151890b4a64c617a3d547ad72383e31b64**, covering
71 changed/new backend files, including tests, harness and migration metadata. The fingerprint is
SHA-256 over JSON of sorted `[relativePath, SHA256(rawFileBytes)]` pairs, selected from tracked
differences against HEAD plus untracked nonignored backend files. Documentation is excluded so this
record can identify the tested source without a circular hash. Recompute before relying on acceptance
after further source edits.

Validation results:

- Dedicated H2 command from Section H2-00: **194 passed, 22 files**, no skips or expected failures.
- Unchanged H1 command: `node node_modules/vitest/vitest.mjs run --config backend/vitest.measurement-analysis.config.ts`: **245 passed, five files**.
- Backend, shared and frontend application TypeScript checks, plus explicit H2 config typecheck: pass.
- Full-repository ESLint, Prettier, secret scan and whitespace diff checks: pass.
- Isolation probe: 866 dependency links contained; native SQLite 3.53.2; Node 24.17.0, locked better-sqlite3 12.11.1, Vitest 4.1.11, TypeScript 5.9.3. No manifest/lockfile changes.
- H1 analyzer source/config, frozen launch/runbook files and dependency manifests have no diff from the committed baseline. No operational archive/database/provider/scheduler inspection or mutation, merge, migration, PAPER or live run was performed.

The explicit allowlist includes existing PaperRunner/PaperSellRunner/config, ExitManagerRunner/config,
SessionManagerRunner/config, database connection/repository tests and H2-focused suites. Runtime
import auditing excludes environment loaders and real provider implementations. The worker bootstrap
loads only its owned fixture task; that task validates the explicit path before opening it and denies
fetch. It receives a fixed clock shared by competing workers, uses a bounded readiness/barrier
handshake, and exits only its own worker for recovery tests. Fixture cleanup awaits owned workers.
TerminalStageRunner has no trade-execution stage; static call-site inspection and typechecks cover
its unchanged composition. No broad terminal/provider workflow was executed.

### Named Acceptance Evidence

All paths below are relative to `backend/src/`; parameterized cases are named in their test files.

| Requirement | Passing evidence                                                                                                                                                                                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T01         | `db/h2/H2AccountingCharacterization.test.ts`: zero costs, decimal truncation, exact slippage including maximum-safe input, signed loss/already-net fill. `paper/PaperRunner.test.ts` and `PaperSellRunner.test.ts`: dry-run, exact quote, refreshed price and allowed cached fallback.                     |
| T02         | `db/h2/H2Buy.test.ts`: “rolls back every trade write after a %s failure” (link/order/fill/position/cash/radar/terminal/after-terminal); each resumes PENDING once. `H2Baseline.test.ts`: H-01 cash failure regression.                                                                                     |
| T03         | `db/h2/H2Sell.test.ts`: corresponding eight write-boundary failures, restoring position/cash/P&L before retry.                                                                                                                                                                                             |
| T04         | `H2Operations.test.ts`: registration across connections, changed economics conflict, distinct intent and terminal rejection reopening. `H2Buy.test.ts`: committed replay and genuinely new eligible decision. `H2Recovery.test.ts`: duplicate BUY/SELL workers and restart replay.                         |
| T05         | `H2Recovery.test.ts`: competing mint/cash BUYs, independent concurrent SELLs, concurrent BUY plus SELL, distinct operations closing one position. Exact aggregate balances and counts asserted.                                                                                                            |
| T06         | `H2Buy.test.ts`: gate revalidation and stale snapshot retry. `H2Sell.test.ts`: changed quantity/basis/fees/gate/lifecycle during fake quote, cached age at commit, current cash/P&L on another connection. Ownership refusal is also enforced/tested by `H2Schema.test.ts` and operation-reference checks. |
| T07         | `H2Schema.test.ts`: direct-SQL domain/amount/time/owner constraints and signed-loss controls; `H2Transactions.test.ts`: overflow, overdraft and stale cash guards.                                                                                                                                         |
| T08         | `H2Schema.test.ts`: OPEN/CLOSING uniqueness and CLOSED history, null/non-null/source identities. `H2Transactions.test.ts`: merge ordering, identity/history and execution status. `H2Recovery.test.ts`: independent null/non-null radar races.                                                             |
| T09         | `H2Migrations.test.ts`: supported chain prefixes, CRLF identity, bad hashes/journals, missing index/forged schema, nested refusal; `H2Baseline.test.ts`: H-04 partial schema.                                                                                                                              |
| T10         | `H2Schema.test.ts`: preflight refusal preserves rows/journal, legacy upgrade keeps nullable operation links empty, mid-rebuild rollback and FK check. `H2Migrations.test.ts`: repeat/interrupt and integrity checks.                                                                                       |
| T11         | `H2Buy.test.ts`: diagnostics before/after commit and while reporting failure. `H2Sell.test.ts`: diagnostics plus zero-effect replay summary. `exits/ExitManagerRunner.test.ts`: diagnostic failure cannot rewrite a successful SELL. Worker after-commit lost-response cases cover recovery.               |
| T12         | `H2Reconciliation.test.ts`: complete open/closed history, cash/orphan/duplicate/owner/terminal/fee contradictions, seed/legacy/partial evidence, missing amounts and bounded precedence. Unknown/unrecorded historical effects are never reconstructed by guesswork.                                       |
| T13         | `H2Reconciliation.test.ts`: real readonly handle rejects writes and leaves every fixture row unchanged; supplied reader has no mutation API. `H2Boundary.test.ts`: import audit includes reconciliation.                                                                                                   |
| T14         | `H2Transactions.test.ts`: rollback, async continuation and expired/cached repository access. `H2Operations.test.ts`: configured-timeout contention. `H2Recovery.test.ts`: BUY and SELL worker exit after registration, inside commit and after commit/before response.                                     |
| T15         | Existing runner/config, ExitManager, SessionManager, connection/repository suites plus new/replayed BUY/SELL summary cases. TerminalStageRunner inspected: no BUY/SELL path.                                                                                                                               |

Invariant mapping: INV-01→T04; INV-02→T02/T03/T14; INV-03→T06/T15; INV-04→T01/T05/T07;
INV-05→T07/T12; INV-06→T05/T08; INV-07→T08; INV-08→T09/T10; INV-09→T12/T13.
H-01, H-02 and H-04 are retained as normal passing regression tests.

### Review Notes And Limits

The review caught and corrected migration copy expressions that could invent old operation links,
fixture close timestamps preceding their openings, floating-point slippage multiplication, and an
initial reconciliation path that could treat a missing amount as zero when comparing cash. Missing
amounts now make the equation incomplete; the new regression prevents a false discrepancy. Historical
rows are neither repaired nor assigned invented operation identities.

Temporary BUY/SELL pricing failures now retain PENDING without rejected accounting rows, as approved;
legacy tests were updated explicitly. Economic rejections remain durable, with rejected orders and no
fill/position/cash effect. Replays report zero new effects. Diagnostic failures are counted separately.

Tests establish application/SQLite behavior on synthetic inputs and owned worker termination/restart;
they do not establish power-loss durability, provider reliability, measurement capability, strategy
profitability or pilot authorization. Reconciliation trusts the caller to supply one complete,
consistent scoped snapshot; it provides no operational connection factory or repair switch. Existing
fields plus operation links suffice for the supported BUY/full-close SELL path. Additional cash
movements require a separate ledger/schema proposal and future-protocol approval.

Integration remains deferred until V3 closeout and evidence preservation, with analyzer dependencies
protected through its approved report. September 18 alone does not prove finality or authorize merge.
Any operational migration requires its own scoped preflight, backup/restore and compatibility plan,
review and authorization. H3/H4 and all research/promotion/pilot gates remain separate.
