# Phase 10.6H H2 Detailed Implementation Checklist

## Accounting, Schema, Migration, And Reconciliation Integrity

Status: **Engineering acceptance complete in the isolated checkout**, 2026-09-16.
Implementation was approved 2026-09-10. H2 is committed as `ff6d586` (push reported by the user) and remains unmerged.
Implementation baseline: `a0bfdf9` (committed H1) on branch `isolation`, at `U:\Projects\H1s\isolation`.
The user approved starting this checklist's H2 implementation and requested incremental completion
records. D1-D9 and the bounded synthetic implementation scope are accepted. Operational integration,
database access/migration, and PAPER execution remain excluded. Progress and resumption details:
[H2 verification record](./Phase-10.6H-H2-Verification.md).

Read with the [parent improvement checklist](./NeXusTrade-Phase-10.6H-Detailed-Checklist.md),
[H1 verification and closeout record](./Phase-10.6H-H1-Verification.md), and
[Post-V3 Development Plan](./Post-V3-Development-Plan.md).

## 1. Sequence And Intended Outcome

Sequence: H1 engineering acceptance is complete and the user approved this H2 plan on September 10.
H1 is required before final V3 identity binding.
H2 is not required to produce the V3 measurement-capability report, and H2 planning does not close H1.
H2 may be implemented independently in an established isolated environment after its own approval.

H2 must make an existing simulated BUY or full-position SELL commit its accounting effects once,
completely, or not at all. A restart or repeated request must not create another economic effect.
Invalid or incompatible state must produce an explicit result, not silent repair. Preserve the
existing stack, selection rules, fee/slippage policy, rounding definitions, and supported lifecycle.

H2 completion supplies engineering evidence for existing code. It cannot produce a candidate,
reopen V2, change V3, or authorize Phase 10.6C, PAPER operation, a pilot, or live trading.

## 2. Approval And Scope

- [x] **H2-AUTH** Record the user's implementation approval, date, approved checklist revision, and
      any changes to the proposed decisions in Section 4. Approved 2026-09-10 against `a0bfdf9`;
      D1-D9 accepted without changes. User: “Start on H2's implementation”.
- [x] Record the implementation branch/worktree and scope of the approved batches. One approval
      may cover the complete agreed plan; individual implementation checkboxes need no new approval.
      H2-00 through H2-07 in `U:\Projects\H1s\isolation`, branch `isolation`; no operational integration.
- [x] Return material changes to the agreed accounting/identity/migration design for review before
      implementing those changes. Routine implementation details remain within the approved scope.

Included after approval: transaction-bound repositories, durable request identity for existing
BUY/full-close SELL flows, schema constraints, migration readiness/preflight, read-only
reconciliation, caller wiring, and synthetic verification of those changes.

Excluded: collector/analyzer semantics and identity changes; active archives; operational databases;
provider changes or real requests; strategy/risk tuning; partial-fill or partial-sale support;
portfolios; general ledger or event-sourcing redesign; UI/dashboard work; production scheduling;
dependency upgrades; automatic data cleanup; operational integration, migration, or PAPER execution.
A separate cash-movement ledger may be proposed if evidence requires it; building it is not included
in approval of this checklist.

## 3. Current Code And Findings To Preserve In Tests

These are source findings and earlier synthetic probes, not claims about operational failures.

| Finding                                                                                                                                                        | Current source                                                                                                                                                                         | H2 response                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| H-01: BUY and SELL persist orders, fills, positions, cash, and statuses separately.                                                                            | [BUY service](../backend/src/paper/PaperExecutionService.ts), [SELL service](../backend/src/paper/PaperSellExecutionService.ts)                                                        | One short transaction for the economic effects; failure injection at every write.                           |
| Cash and realized P/L come from a previously read session and local loop variables.                                                                            | Same services; [SessionRepository](../backend/src/db/repositories/SessionRepository.ts)                                                                                                | Re-read inside the transaction; update by validated deltas/conditional writes, not stale absolute balances. |
| Exceptions after accounting, including logging failures, can enter failure handlers. SELL may mark an already affected order FAILED; BUY may mark radar ERROR. | Same services                                                                                                                                                                          | Commit outcome controls the result; diagnostics cannot rewrite a committed outcome.                         |
| H-02: no uniqueness for open positions; the nullable radar pair defeats the current composite uniqueness for null pairs.                                       | [Positions](../backend/src/db/schema/positions.ts), [radar schema](../backend/src/db/schema/tokenRadar.ts), [radar repository](../backend/src/db/repositories/TokenRadarRepository.ts) | Database constraints and conflict-safe upsert semantics.                                                    |
| TypeScript enum annotations do not themselves enforce SQLite domains; separate foreign keys do not establish matching session ownership.                       | [Session](../backend/src/db/schema/sessions.ts), [order](../backend/src/db/schema/orders.ts), [fill](../backend/src/db/schema/fills.ts), [enums](../backend/src/db/schema/enums.ts)    | Explicit constraints and ownership validation, exercised through direct SQL as well as repositories.        |
| H-04: readiness checks only for the sessions table.                                                                                                            | [Migrations](../backend/src/db/migrations.ts), [migration journal](../backend/drizzle/meta/_journal.json)                                                                              | Verify the complete supported migration chain and required structural features.                             |
| Repositories currently receive an AppDatabase; no accounting unit of work is supplied.                                                                         | [RepositoryFactory](../backend/src/db/repositories/RepositoryFactory.ts), [connection](../backend/src/db/connection.ts)                                                                | A transaction boundary that supplies all participating repositories from the same transaction.              |
| Existing callers include automatic exit handling, not just the two PAPER runners.                                                                              | [PaperRunner](../backend/src/paper/PaperRunner.ts), [PaperSellRunner](../backend/src/paper/PaperSellRunner.ts), [ExitManagerService](../backend/src/exits/ExitManagerService.ts)       | Wire every caller and preserve explicit exit/session gating.                                                |

## 4. Proposed Design Decisions For Approval

These are proposed defaults, not implemented capabilities. Record accepted choices under H2-01
before writing the implementation. This makes any requested change visible to the reviewer.

| ID  | Proposed decision                                                                                                                                                                               | Reason and limit                                                                                                                                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Use a synchronous SQLite transaction with immediate writer admission for the final accounting commit; expose repositories bound to that transaction.                                            | Revalidate before the first accounting write. No await, provider request, or diagnostic logging inside this transaction. No fallback to unbound repositories.                                                                                                                                                |
| D2  | Add a minimal durable PAPER operation record: version, operation ID, session, side, intent digest, state, source references, result references, and bounded failure/result facts.               | Bind the ID to intent in a separate short registration transaction before quote work. This record is not a job queue, fund reservation, or cash ledger.                                                                                                                                                      |
| D3  | Operation states are PENDING, COMMITTED, and REJECTED. A technical interruption leaves PENDING with no partial accounting; an explicit retry revalidates it.                                    | COMMITTED and REJECTED are terminal. A completed duplicate returns the stored result; changed intent under the same key conflicts. No automatic background retries or recovery execution.                                                                                                                    |
| D4  | Stable IDs belong to the logical action. Existing BUY adapters derive them from session plus strategy-decision ID; existing full-close SELL adapters derive them from session plus position ID. | Restarting a runner does not create new intent. The intent digest includes the relevant amount, fee/slippage configuration, quote/fallback policy, and trigger context; it excludes volatile timestamps and generated quote/order IDs. New economics require a new explicit intent, never a random retry ID. |
| D5  | Keep one full simulated fill per H2 operation. Persist operation-to-order/fill/position ownership links and the final result atomically with accounting.                                        | Do not impose a blanket one-fill rule on all historical order types: the schema already includes PARTIALLY_FILLED. Unsupported historical shapes are classified during reconciliation.                                                                                                                       |
| D6  | Enforce at most one OPEN or CLOSING position per session/mint, while retaining any number of CLOSED positions.                                                                                  | H2 itself continues the existing OPEN-to-CLOSED full-close path. ERROR or other ambiguous exposure is reported and blocks conflicting new execution until reviewed; do not invent a repair transition.                                                                                                       |
| D7  | Preserve non-null radar identity as session/mint/source/pair; use a separate unique null-pair identity on session/mint/source.                                                                  | Do not conflate different pairs or sources. Treat undefined as null at the boundary; reject blank pair identifiers rather than silently merging them.                                                                                                                                                        |
| D8  | Diagnostic log failure is reported separately after the accounting outcome is settled. Required trade/result evidence belongs in the transaction.                                               | Success must not become FAILED or cause a second trade because a log sink failed. Preserve current dry-run diagnostic policy while forbidding dry-run accounting/operation writes.                                                                                                                           |
| D9  | Reconciliation is a read-only service over explicitly supplied repositories/snapshots; no operational path default or repair mode.                                                              | H2 can establish invariants where records are sufficient and report incomplete evidence elsewhere. A new cash ledger remains a separate proposal if needed.                                                                                                                                                  |

The operation key and intent digest are different concepts. For example, repeating a committed BUY
for the same strategy decision returns the recorded result without a new quote or debit. Supplying
different sizing or fee policy for that key produces an identity conflict. A new strategy decision
can represent a new intent, but the position/cash constraints still apply. A SELL closes a specific
position ID; it must never close a replacement position merely because its mint matches.

For a terminal REJECTED operation, reusing its key returns its rejection. If later conditions justify
a distinct retry intent, require an explicit, stable new intent through the caller contract. The
legacy adapters must not silently reinterpret a stored key or manufacture IDs to bypass rejection.
Record how that explicit intent is supplied before wiring callers; do not add a generic execution
override or an unreviewed CLI flag.

## 5. Accounting And Integrity Contract

### 5.1 Preserve the existing accounting equations

Source definitions: [BUY quote/fill](../backend/src/paper/PaperFillFactory.ts),
[position basis](../backend/src/paper/PaperPositionFactory.ts),
[SELL accounting](../backend/src/paper/PaperSellAccountingService.ts),
[SELL fill](../backend/src/paper/PaperSellFillFactory.ts), and
[decimal arithmetic](../backend/src/paper/PaperMath.ts).

| Quantity                    | Required existing interpretation                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| BUY debit                   | requested principal + estimated buy slippage + buy base/priority fees                                                         |
| Position cost basis at open | requested principal + estimated buy slippage; buy fees are stored separately                                                  |
| SELL net credit             | gross proceeds - estimated sell slippage - sell base/priority fees                                                            |
| Realized P/L on full close  | net sell credit - opening cost basis - previously paid buy fees                                                               |
| Position fees after close   | buy fees + sell fees; slippage is not added again as a fee                                                                    |
| Reconstructed session cash  | starting balance - sum of BUY debits + sum of SELL net credits, for supported complete histories with no other cash movements |

The current SELL fill's `solReceivedLamports` is already net. Subtracting its recorded sell fees or
slippage again would double-count them. BUY fills record principal separately from their costs.
Test both conventions directly, rather than inferring them from field names.

For example, the existing BUY fixture spends 10,000,000 principal, 100,000 slippage, and 5,000 fees:
the debit is 10,105,000; cost basis is 10,100,000; paid fees are 5,000. This is a synthetic accounting
example, not a proposed trading size or policy.

### 5.2 Invariants and enforcement ownership

| ID     | Invariant                                                                                                                 | Required enforcement                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| INV-01 | One committed accounting effect for one operation; same-key/different-intent conflicts.                                   | Unique operation key, versioned digest comparison, terminal result, transaction tests.                                                         |
| INV-02 | A committed BUY/SELL has all required linked effects; a failed commit has none.                                           | Transaction-bound repositories; failure and restart tests. A previously registered PENDING intent may remain.                                  |
| INV-03 | Session is PAPER/RUNNING at commit; BUY respects its termination gate; SELL preserves its explicit supported exit policy. | Re-read session/governance and referenced decision/position inside the transaction. Do not apply the BUY termination rule to legitimate exits. |
| INV-04 | Cash cannot become negative; lamport inputs, deltas, balances, and totals remain safe integers.                           | Checked arithmetic, conditional updates, SQLite integer/range constraints. P/L remains signed.                                                 |
| INV-05 | Orders, fills, operations, decisions, positions, and sessions refer to the same economic owner.                           | Composite ownership constraints where representable, explicit service checks for remaining relationships, direct-SQL negative tests.           |
| INV-06 | No competing active position or second close of the same position.                                                        | Partial uniqueness, conditional OPEN-to-CLOSED update, affected-row checks, independent-connection tests.                                      |
| INV-07 | Radar upserts preserve identity and first-seen/creation history without racing or undoing a trade status.                 | Null/non-null unique indexes, atomic conflict handling, an explicit field/status merge policy.                                                 |
| INV-08 | Readiness reflects the complete supported migration/schema state.                                                         | Ordered migration identity validation plus required table/index/constraint checks; no automatic migration on assertion.                        |
| INV-09 | A reconciliation report makes no repairs and does not call incomplete evidence valid.                                     | Read-only interface, per-invariant results, stable bounded output, write traps.                                                                |

Decimal token/price text must be validated without converting arbitrary values through lossy floating
point. Preserve the current positive-decimal grammar, truncation, and ceil/round definitions for
supported inputs. Use exact arithmetic or explicit rejection where an intermediate calculation would
lose integer precision. Do not invent new economic defaults. SQLite checks should enforce what they
can represent faithfully; document service-level decimal checks rather than claiming a text-to-REAL
cast establishes exact decimal validity.

## 6. Implementation Batches

For each checked task, add the implementation commit, named test/case, result, and any limitation to
the evidence table in Section 9. Complete one reviewable batch at a time.

### H2-00 — Re-establish isolation and the test harness

- [x] Confirm H2-AUTH and the approved D1-D9 decisions; record the exact implementation base.
      `a0bfdf9`; see H2-AUTH above and the verification record.
- [x] Recheck resolved source, dependency, fixture, database, WAL/SHM, and output paths. Use only
      `U:\Projects\H1s\isolation` or another explicitly recorded isolated checkout. A branch in
      `U:\Projects\NeXusTrade-Otis` is not sufficient.
- [x] Inventory selected test imports before running them. Use owned temporary/in-memory SQLite,
      fake provider ports, fixed clocks, and explicitly supplied configuration; load no `.env`.
- [x] Add a dedicated H2 Vitest configuration with environment-file loading disabled, one worker,
      no watch mode, local caches, and an explicit allowlist of audited test files.
- [x] Verify the isolated better-sqlite3 binding using an in-memory database. H1 dependency
      provisioning disabled install scripts; H1 passing does not prove this native binding works.
      If necessary, provision only the existing locked native dependency within this worktree;
      disable unrelated lifecycle hooks and change no machine-wide installation or shared cache.
- [x] Put file fixtures under `.tmp/h2/`; verify containment before recursive cleanup, close every
      handle first, and account for WAL/SHM files. No copied operational databases or credentials.
- [x] Keep H1 source/test configuration and approved protocol bytes fixed while H2 is developed.
      Do not change manifests, lockfile, provider configuration, process/task/power settings, or
      operational files to make a test run. Stop the affected work if isolation cannot be established.

H2-00 evidence: 866 backend/root dependency links resolve inside the worktree; locked better-sqlite3
12.11.1 native binary provisioned locally and SQLite 3.53.2 verified in memory. The dedicated six-file
harness passes 25 checks and reproduces five expected baseline failures. The import audit ran first.
Filesystem/native guards confine database files and cleanup to owned `.tmp/h2/sqlite-*` directories.

### H2-01 — Capture behavior and freeze the implementation contract

- [x] Characterize current BUY success/rejection/dry-run and SELL success/rejection/dry-run behavior;
      include cached/refreshed/exact-quote choices via fakes, rounding edges, zero fees, and signed P/L.
- [x] Reproduce H-01/H-02/H-04 with named failing tests in isolated fixtures. Retain failures as
      evidence; do not reproduce them against an operational database.
- [x] Specify the exact operation-key derivation and canonical intent fields for every caller,
      including direct PAPER runners, terminal orchestration, and ExitManager. Specify how a new
      explicit intent after terminal rejection is supplied; no random IDs on retries.
- [x] Freeze PENDING/COMMITTED/REJECTED transitions, stable result fields, versioned digest rules,
      error codes, and which failures are terminal versus retryable. Temporary quote unavailability,
      stale evidence, database contention, and interrupted writes must not be mistaken for a fill.
- [x] Define the full transaction write set, required evidence, post-commit diagnostics, and summary
      behavior. Replayed results must be distinguishable from newly created effects and must not
      debit/credit a runner's local summary balance a second time.
- [x] Record the radar merge policy: preserve ID/creation time/earliest first-seen; preserve valid
      execution-owned status transitions; define field update ordering for concurrent discoveries.
- [x] Approve the schema design under Section 4's agreed scope. List allowed values, nullable fields,
      ownership keys, timestamp relationships, supported historical shapes, and required constraints.
      If source review exposes a material change to D1-D9, return that change to the user for review.

H2-01 contract and named evidence are recorded in the
[implementation contract](./Phase-10.6H-H2-Implementation-Contract.md) and
[verification record](./Phase-10.6H-H2-Verification.md). Identity helpers and 12 pure tests establish
the key/digest contract; existing runner tests plus three accounting cases preserve economic behavior.

### H2-02 — Add migration readiness and schema integrity

- [x] Create a trusted, versioned description of the supported ordered migration chain and required
      schema features. Historical SQL and journal entries remain immutable; add new migrations only.
      The 0000/0001/H2 chain is pinned in MigrationContract; historical SQL and journal entries are preserved.
- [x] Replace the sessions-table-only assertion. Reject absent, older, partial, tampered, incompatible,
      and unknown-newer states before business operations; report readiness without applying repairs.
- [x] Define canonical migration byte identity and test Windows checkout line endings against it.
      Do not silently normalize or re-hash an unknown migration to accept it. Review any narrowly
      needed checkout attributes without rewriting historical migration content.
- [x] Preflight synthetic prior-schema records for duplicate exposure/radar keys, invalid domains,
      unsafe numbers, invalid timestamp relationships, and broken ownership before migration writes.
      Report bounded offending identities and reasons; do not delete, deduplicate, or infer repairs.
- [x] Add the operation schema and links, active-position/null-radar uniqueness, appropriate enum
      CHECKs, nonnegative cash/fee and safe-integer constraints, and ownership relationships.
      Preserve negative realized/unrealized P/L and historical closed positions.
- [x] Review SQLite table rebuilds, foreign keys, indexes, and all preservation queries. Exercise
      migration rollback on fixtures and verify row identities, values, and relationships survive.
- [x] Test clean initialization and supported upgrade chains: 0000 plus its missing 0001, complete
      0000/0001, and the new H2 schema. Prior states may be migration inputs but must fail current
      readiness until the full reviewed chain is applied. Re-running an applied migration is inert.
- [x] Test a forged migration record with missing schema features, missing middle steps, wrong hashes,
      an unexpected newer step, failed preflight, and interrupted migration. Preserve the original
      logical fixture state on failure. Validate foreign-key and integrity checks after success.
- [x] Review all startup/readiness call sites. The assertion must not open a default database or
      automatically invoke `runMigrations`; production migration tooling remains out of execution scope.

### H2-03 — Add transaction-bound repositories and operation identity

- [x] Introduce the accounting unit-of-work interface and its SQLite implementation. Derive compatible
      database/transaction executor types; do not suppress type errors with unchecked casts.
- [x] Supply participating repositories from the same transaction. Enforce synchronous callbacks;
      reject async/thenable callbacks, roll back any synchronous writes, and invalidate transaction
      access after the callback ends so a late continuation or escaped repository cannot write.
- [x] Implement short registration of an immutable versioned intent and stable operation ID. A racing
      registration returns the same intent or a conflict. PENDING registration changes no balances.
- [x] Resolve terminal duplicates before quote work. Verify the stored result's owned references and
      report corruption rather than using a missing result to execute again.
- [x] Implement conditional cash/P&L deltas and conditional position/order/operation transitions.
      Treat unexpected affected-row counts as a rollback condition, not success.
- [x] Make null/non-null radar upserts atomic under the agreed merge policy; never use select-then-
      insert as the only duplicate defense or SQLite REPLACE that can delete/recreate identity.
- [x] Handle writer contention with a bounded retryable result. Preserve configured lock behavior;
      do not add unbounded loops, provider calls under the lock, or arbitrary timing sleeps in tests.

### H2-04 — Convert BUY persistence and callers

- [x] Prepare immutable request/price evidence outside the accounting transaction. Current BUY uses
      radar evidence; do not introduce a new live provider or freshness policy to this path.
- [x] Inside the transaction, re-read operation, session/cash/governance, owned radar and strategy
      decision, and active-position state. Revalidate applicable existing evidence rules. Reject
      material change since preparation rather than relying on stale selector objects.
- [x] Atomically create/link order and fill, open the position, debit current cash, set required radar
      and order status, and record COMMITTED operation/result. Required audit references participate.
- [x] Preserve business-rejection order behavior with an atomic REJECTED result and no economic
      writes. A technical failure rolls back the trade and leaves only the registered PENDING intent
      plus any separately reported diagnostic; no orphan fill or partially created position.
- [x] Move diagnostics outside the transaction and protect start/candidate/summary logging. A log
      failure after commit must not mark radar ERROR, recount a failed trade, or trigger a retry effect.
- [x] Preserve dry-run calculations and existing diagnostic policy; create no operation, order,
      fill, position, cash, or radar mutation during dry-run.
- [x] Update every BUY composition root to supply the unit of work and identity; no legacy unsafe
      fallback. Test a duplicate replay and a genuinely new eligible decision separately.

### H2-05 — Convert full-close SELL and exit integration

- [x] Register immutable SELL intent and resolve fake quote/enrichment evidence outside the accounting
      transaction. Completed duplicates return their stored result before any new quote request.
- [x] Inside the transaction, re-read the exact position ID, ownership, token quantity, basis/fees,
      operation, session/cash/P&L, and allowed exit state. Recheck freshness using existing rules and
      current time. Changed quantity, stale evidence, or a previously closed position cannot be sold.
- [x] Atomically create/link order and fill, close OPEN to CLOSED, credit net proceeds, add realized
      P/L, update required existing radar/order status, and store COMMITTED operation/result.
- [x] Apply a cash/P&L delta to the current row, not a value captured before awaiting a quote.
      Preserve unrelated session governance/mark-to-market fields and concurrent valid cash changes.
- [x] Remove failure paths that mark an already committed order FAILED. Preserve failure/rejection
      evidence without manufacturing a fill; keep post-commit diagnostics separate from the outcome.
- [x] Wire PaperSellRunner, ExitManager, and their orchestration callers through the same boundary.
      Preserve explicit exit triggers and session lifecycle rules; do not loosen PAPER/RUNNING checks.
- [x] Preserve dry-run and summary behavior; distinguish newly committed effects from replays. A
      repeated sell-all must not resell a closed position or count proceeds/P&L twice.

### H2-06 — Implement read-only reconciliation

- [x] Accept explicitly supplied read-only data access and scope; introduce no default data path,
      environment loader, gateway, migration-on-read, report-file output, or repair switch.
- [x] Reconstruct supported session cash using Section 5's equations. Compare fills/orders, operation
      links, active/closed positions, fees, realized P/L, ownership, and terminal lifecycle states.
- [x] Use explicit new operation links for new records. Do not join historical trades solely by
      mint/time or infer missing opening fills for seeded positions. Classify ambiguous legacy
      mappings, absent metadata, unsupported partial fills, and unrecorded cash movements as incomplete.
- [x] Report per-invariant PASS / DISCREPANCY / INCOMPLETE with stable codes, affected IDs, and bounded
      details. Overall status is DISCREPANCY if any invariant fails, otherwise INCOMPLETE if any cannot
      be established, otherwise PASS. One passing balance equation cannot hide incomplete ownership.
- [x] Trap attempted writes and compare fixture state before/after. Do not use a connection factory
      that applies migration or write-related PRAGMAs to claim an operational read-only inspection.
- [x] Record whether existing fields plus operation links suffice for the supported H2 path. If a
      cash-movement ledger is needed for additional workflows, write a separate schema proposal and
      route future-pilot requirements through 10.7A/10.8B; do not synthesize historical ledger entries.

### H2-07 — Verify recovery, concurrency, compatibility, and closeout

- [x] Finish every required case in Section 8 and attach exact named-test evidence. Use fresh fixtures
      per case, fixed clocks, barriers, and reproducible inputs rather than random timing assertions.
- [x] Test independent SQLite connections to one owned temporary file. Promise.all over synchronous
      methods on one connection does not prove competing-writer behavior. Use bounded workers or
      subprocesses with a deterministic handshake and fake providers only where required.
- [x] Exercise restart after registration, before the economic commit, and after commit but before
      response delivery. Rollback/replay must preserve accounting and stable operation identity.
      Any crash injection must target only the explicitly owned fixture worker, never a discovered
      host process. Do not claim power-loss durability from process-restart tests.
- [x] Run audited existing database/PAPER/exits/session/terminal tests affected by caller and schema
      changes, plus the required type/lint/format/secret checks. Keep the H1 suite unchanged and rerun
      it as a compatibility check if any shared dependency/import is affected.
- [x] Review schema SQL, migration preservation results, atomic write sets, ID/replay decisions,
      new error contracts, caller coverage, and reconciliation limitations against this plan.
- [x] Record final source revision, dependencies, exact commands/counts, every acceptance result,
      known limitation, and the still-separate integration/migration/operational gates.

## 7. Planned File Ownership

The table retains the planning allocation; implemented files and exact evidence are indexed in the
[verification record](./Phase-10.6H-H2-Verification.md) and [structure inventory](./Structure_Phase9Plus.md#h2-accounting-integrity-implementation).
Adjust ordinary naming during implementation and update this inventory; keep responsibility intact.

| Area                     | Existing or proposed location                                                                                            | Responsibility                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Transaction boundary     | New `backend/src/db/AccountingUnitOfWork.ts`; existing connection and RepositoryFactory                                  | One transaction and correctly bound repository set.                                  |
| Operation identity       | New `backend/src/paper/PaperOperationTypes.ts`, `PaperOperationIdentity.ts`; new operation schema/repository under `db/` | Validated versioned intent, durable state, replay/conflict, owned result references. |
| Conditional writes       | SessionRepository, PositionRepository, OrderRepository, TokenRadarRepository                                             | Current-state predicates, safe deltas, conflict-safe uniqueness and transitions.     |
| Accounting orchestration | PaperExecutionService, PaperSellExecutionService and their runners; ExitManagerService and relevant composition roots    | Separate evidence preparation, commit, and diagnostics.                              |
| Schema/readiness         | `backend/src/db/schema/`, `backend/src/db/migrations.ts`, new files in `backend/drizzle/`                                | Constraints, compatible upgrades, preflight, complete readiness.                     |
| Reconciliation           | New `backend/src/paper/PaperReconciliationService.ts` and report types                                                   | Read-only invariant results, no repair/operational entrypoint.                       |
| Tests                    | New focused `*.test.ts` beside these services; audited existing affected tests                                           | Section 8 failure, identity, schema, recovery, and compatibility evidence.           |
| Harness/evidence         | New `backend/vitest.h2.config.ts`; this checklist and a later H2 verification record                                     | Isolated test allowlist, revision/command/result mapping, final acceptance.          |

## 8. Required Test Matrix

These test IDs are acceptance requirements, not claims that corresponding tests already exist.
During implementation, map each to its exact test file, case names, and approved error/result code.

| ID  | Required cases                                                                                                                                                          | Required result                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| T01 | Current BUY/SELL fees, slippage, decimal/rounding edges, negative P/L, dry-run; cached/refreshed/quote choices through fakes.                                           | Supported economic calculations and gates preserved; no dry-run accounting effects.                                                   |
| T02 | BUY failure after each order/link/fill/position/cash/radar/result write, including failure of COMMITTED operation update.                                               | Full economic rollback; no partial records; retry of PENDING can commit once.                                                         |
| T03 | SELL failure at the corresponding write boundaries, including after close/cash/P&L updates.                                                                             | Position, balances, and linked records all restored; no double credit on retry.                                                       |
| T04 | Same operation twice, across restart, and concurrently; different digest under same key; distinct intended operations.                                                  | Stable replay without new provider/economic effects; bounded conflict; no accidental deduplication of distinct eligible intent.       |
| T05 | Two BUYs for one mint, two BUYs competing for limited cash, two independent SELLs, BUY plus SELL, and two closes of one position.                                       | One allowed active exposure; exact aggregate deltas; no lost update, negative cash, or double close.                                  |
| T06 | Session/termination gate changes during preparation; SELL quantity/status/ownership changes while awaiting a fake quote; stale evidence at lock acquisition.            | Revalidation rejects or produces the contract's retryable result before economic writes; no relaxation of exit rules.                 |
| T07 | Raw SQL invalid enum/mode/side, unsafe/fractional/out-of-range lamports, negative cash/fees, invalid timestamps, cross-session foreign links; signed P/L controls.      | Each defined constraint actually enforced; legitimate losses and supported history accepted.                                          |
| T08 | OPEN/OPEN and OPEN/CLOSING duplicates; multiple CLOSED histories; null-pair and non-null-pair radar races; distinct pair/source controls.                               | Agreed uniqueness enforced; atomic merge preserves identity, earliest first-seen, and execution-owned status.                         |
| T09 | Empty DB; each supported prior schema; sessions-only partial schema; missing middle step; wrong hash; forged/newer journal; missing constraint; CRLF identity handling. | Exact readiness classification; upgrades only by explicit fixture migration; unsupported/tampered state rejected.                     |
| T10 | Invalid-data preflight, interrupted migration/rebuild, repeat migration, fixture FK/integrity checks.                                                                   | No silent repair, lost records, or partially advanced schema; successful upgrade preserves required data.                             |
| T11 | Diagnostic failure before/after commit and while reporting another failure; repeated terminal operation after a lost response.                                          | Stable accounting result; no FAILED rewrite or duplicate effect; bounded diagnostic warning.                                          |
| T12 | Clean complete histories; cash mismatch; orphan/duplicate fill; ownership mismatch; missing opening fill; seeded/partial/unknown historical shapes.                     | Correct per-invariant result and overall precedence; no false PASS or invented history.                                               |
| T13 | Reconciliation write trap and pre/post fixture comparison; forbidden default-path/environment/provider/migration access.                                                | Read-only service boundary; no repair or operational side effects.                                                                    |
| T14 | Explicit transaction rollback; accidental async callback and late continuation; independent-connection contention; crash before/after commit.                           | Transaction-bound behavior, invalidated access after callback return, bounded contention, and correct recovery; no background replay. |
| T15 | PaperRunner, PaperSellRunner, ExitManager and affected terminal/session callers; new/replayed summary counts.                                                           | Every path uses the new boundary; no unsafe legacy fallback or double-counted balance/P&L.                                            |

## 9. Verification Commands And Evidence

H2-AUTH and H2-00 are complete. Run only the dedicated H2 harness and its audited allowlist from the
isolated worktree; do not run a broad operational workflow. The native binding was verified locally.
The following commands describe implementation verification:

```powershell
$env:TEMP = Join-Path (Get-Location) '.tmp\h2'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
node node_modules/vitest/vitest.mjs run --config backend/vitest.h2.config.ts
node node_modules/typescript/bin/tsc -p backend/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p shared/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p frontend/tsconfig.app.json --noEmit
node node_modules/eslint/bin/eslint.js . --ignore-pattern .pnpm-store/** --ignore-pattern .tmp/**
node node_modules/prettier/bin/prettier.cjs . --check --ignore-path .gitignore --ignore-path .prettierignore
node scripts/check-secrets.mjs
git diff --check
```

Typecheck new harness files explicitly if they are outside the existing TypeScript project includes.
Record the exact allowlisted existing regression tests in the implemented configuration. Do not run
`db:migrate:paper`, reset, seed, PAPER, terminal, provider-smoke, collector, or production analyzer
commands to prove H2. Migration functions may be exercised only against owned fixtures in tests.

The H1 closeout resolves the earlier full-repository formatting failure with committed-byte checkout
restoration, an LF checkout rule, and semantics-preserving lockfile formatting. Preserve that passing
baseline; do not count a changed-file pass as a full pass or weaken the acceptance gate. Keep these
development checkout/tooling changes out of the operational checkout through V3 closeout.

| Batch           | Commit and named test evidence                                                                          | Status   |
| --------------- | ------------------------------------------------------------------------------------------------------- | -------- |
| H2-00 / H2-01   | Worktree patch on `a0bfdf9`; see verification record                                                    | Complete |
| H2-02           | Schema/preflight/readiness/rollback synthetic evidence in verification record                           | Complete |
| H2-03           | Transaction lifetime, conditional writes, durable replay, radar merge, bounded contention tests         | Complete |
| H2-04           | BUY rollback, replay/new decision, dry-run, diagnostics and existing runner checks pass                 | Complete |
| H2-05           | SELL/ExitManager rollback, replay, current-row deltas and diagnostics pass                              | Complete |
| H2-06           | Supplied-snapshot reconciliation; complete/contradictory/incomplete evidence and real read-only fixture | Complete |
| H2-07 / T01-T15 | 194 H2 tests, 245 H1 tests, static checks; named matrix in verification record                          | Complete |

## 10. Final Acceptance And Separate Operational Gates

- [x] H-01, H-02, and H-04 are reproduced and fixed with retained evidence.
- [x] INV-01 through INV-09 and T01 through T15 have named passing evidence; no unexplained skips,
      missing native binding, unresolved migration ambiguity, or outstanding acceptance failure.
- [x] The supported full BUY/SELL path is atomic, repeat-safe, concurrency-safe, and restart-tested.
- [x] Invalid schema/data is rejected explicitly; migration fixtures preserve records; reconciliation
      distinguishes discrepancies from insufficient evidence and performs no repairs.
- [x] All required checks pass for the reviewed source revision; the approval/decision/evidence record
      is complete and every affected caller uses the new accounting boundary.
- [x] Review the patch and mark **H2 engineering complete in the isolated checkout** only after the
      above evidence is complete. Keep integration and operational status separate.

Integration into `U:\Projects\NeXusTrade-Otis` remains deferred until V3 closeout and evidence
preservation. Preserve pending analyzer dependencies through its approved report. September 18 alone
does not establish finality or authorize a merge. No operational database is to be inspected or
migrated under H2 synthetic implementation approval. Any later migration needs its own scoped
preflight, backup/restore and compatibility plan, review, and authorization; never restore an old
database after new activity without an explicit data-preservation decision.

Even after H2 is complete, PAPER operation still requires the applicable H3/H4 work and the separate
research, promotion, pilot-protocol, and named-pilot gates. Approval of this checklist implements
engineering safeguards only; it is not authority to run simulated or live trading.
