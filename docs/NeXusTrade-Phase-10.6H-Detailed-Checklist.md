# NeXusTrade Phase 10.6H Detailed Improvement Checklist

## Engineering Integrity And Development Hardening

Status: H1 engineering acceptance completed on 2026-09-10 in the isolated `isolation` worktree:
245 synthetic tests and all required source checks pass. H1 closeout is committed and pushed on the
isolated branch as `a0bfdf9`. H2 was approved on September 10 and completed isolated engineering acceptance on September 16;
H2 is committed as `ff6d586`. H3 isolated engineering acceptance is complete on September 17 (98 H3 tests, 245 H1 and 194 H2 compatibility tests); its commit is `f8f8d4c`. H1-H3 are integrated into main at `63f5378`. H4 acceptance is complete and integrated into main through PR #5 at `88921e9`; both hosted platforms passed (user-supplied evidence). See the [H1 record](./Phase-10.6H-H1-Verification.md) and
[H2 record](./Phase-10.6H-H2-Verification.md) and [H3 record](./Phase-10.6H-H3-Verification.md).
Package H1 is required
before final V3 identity binding; packages H2-H4 harden existing development before the future systems
that depend on them are operated. No package is complete merely because this checklist exists.

Phase 10.6H is a parallel engineering track, not a successor hypothesis or strategy-promotion gate.
It may improve existing software even if V3 capability is not confirmed. It cannot reopen the V2
`NO_DEFENSIBLE_HYPOTHESIS` result, authorize collection, or advance Phase 10.6C/PAPER/live work.

Read with:

- [Post-V3 Development Plan](./Post-V3-Development-Plan.md)
- [Phase 10.6B.3 analyzer contract](./NeXusTrade-Phase-10.6B.3-Detailed-Checklist.md)
- [Frozen V3 operator runbook](./research-launches/phase10.6a-measurement-v3-20260904-2100Z-operator-runbook.md)

## 1. Purpose And Required Outcome

Make existing behavior correct under failed writes, repeated requests, simultaneous callers, invalid
records, and outdated databases. Preserve the existing stack and research boundaries. Deliver small,
reviewable changes with requirement-to-test evidence; cosmetic cleanup is secondary to correctness.

Engineering completion means the selected packages meet their acceptance criteria. It does not mean
the project has a candidate, a promoted profile, an approved pilot, or permission to execute.

## 2. Review Evidence And Limits

The 2026-09-09 review inspected source and ran 49 database/PAPER/HTTP tests and four frontend tests;
all passed. Backend, shared, and frontend typechecks passed. Additional probes used in-memory SQLite
and a fake clock only, with no real archive, provider, scheduler, or operational database access.

| ID   | Reproduced or inspected finding                                                                                                                                                  | Primary source                                                                                                                                        | Required response                                               |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| H-01 | An injected BUY cash-write failure left a fill and open position, unchanged cash, and a `QUOTED` order. SELL also uses separate persistence calls.                               | [BUY](../backend/src/paper/PaperExecutionService.ts), [SELL](../backend/src/paper/PaperSellExecutionService.ts)                                       | Atomic accounting and rollback tests.                           |
| H-02 | The migrated schema accepted duplicate open positions, duplicate null-pair radar identities, an invalid session status, and negative cash.                                       | [Positions](../backend/src/db/schema/positions.ts), [radar](../backend/src/db/schema/tokenRadar.ts), [sessions](../backend/src/db/schema/sessions.ts) | Database-enforced invariants and duplicate-safe writes.         |
| H-03 | With a one-per-minute fake limit, three waiting callers were admitted together after the window expired.                                                                         | [Provider limiter](../backend/src/providers/http/providerRateLimiter.ts)                                                                              | Serialized admission or capacity rechecking under concurrency.  |
| H-04 | The migration guard accepted the initial schema although the later watchlist table was absent.                                                                                   | [Migration guard](../backend/src/db/migrations.ts)                                                                                                    | Required-version validation and migration fixtures.             |
| H-05 | The analyzer's 11 existing synthetic tests pass, but do not establish every promised Section 8 case.                                                                             | [Analyzer tests](../backend/src/research-measurement-cohort-analysis/MeasurementCohortAnalysis.test.ts)                                               | Complete the coverage matrix before binding the final identity. |
| H-06 | Dependency boundaries are largely conventional; no checked-in CI workflow was found. Several reporting modules combine substantial validation, calculation, and formatting work. | [Lint configuration](../eslint.config.js), [structure inventory](./Structure_Phase9Plus.md)                                                           | Automated boundaries/checks and targeted decomposition.         |

These are development findings, not observations about the active V3 archive or claims that a
production accounting failure occurred. Preserve this distinction in implementation reports.

## 3. V3 Preservation And Integration Boundary

Current update (2026-09-18): main records completed B.3 analysis with `MEASUREMENT_CAPABILITY_NOT_CONFIRMED`; the supplied operator conversation reports early V3 finalization and scheduler disablement. The [integration record](./Phase-10.6H-Main-Isolation-Integration.md) preserves provenance and combined-source verification. The following active-collection constraints describe the historical development boundary; they are not instructions to restart collection or wait for another invocation. Main integration, deployment and new research remain separately reviewed.

The operational checkout is `U:\Projects\NeXusTrade-Otis`. The existing scheduler launches from it
repeatedly; changing files between invocations can change later observations even without restarting
a long-running process. A branch name alone does not isolate those changes.

The frozen final invocation starts 2026-09-18 at 18:44 UTC / 11:44 AM PDT. Its anchor is 19:00 UTC /
noon PDT. Follow the existing runbook after the invocation exits; the date alone does not prove archive
finality. No manual collector invocation, backfill, extension, retry, or replacement is permitted.

| Work while V3 is active                                             | Location and prerequisite                                                                                                                                        | Integration boundary                                                                                                                                   |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Documentation, source review, test design                           | Documentation/source only; no active archive or scheduler inspection implied.                                                                                    | Documentation may be reviewed normally; frozen protocol, launch JSON, and runbook remain unchanged.                                                    |
| H1 analyzer tests and narrowly required analyzer fixes              | A physically separate checkout/worktree, synthetic fixtures, and documented dependency isolation. Keep production identity unset.                                | A reviewed analyzer-only patch may integrate before binding if it cannot affect collector imports or shared tooling.                                   |
| H2-H4 implementation against existing code                          | A physically separate checkout/worktree with independent dependencies and temporary/in-memory data. A scoped implementation task must establish isolation first. | Hold changes to the operational checkout until V3 closeout and evidence preservation; keep pending analyzer dependencies unchanged through its report. |
| Work that requires shared files, machine settings, or real services | Isolation is not established.                                                                                                                                    | Defer until closeout and an appropriately scoped task.                                                                                                 |

Before parallel implementation, record the resolved checkout root and affected imports. Verify that
source, `node_modules`, databases, archives, and test/output directories do not resolve through
symlinks or junctions into the operational checkout. Do not change its manifests, lockfile, shared
dependencies, Node/Corepack/pnpm installation, environment, provider settings, process, task, or host
power settings. Do not attach copied operational data or credentials to a development fixture.

Use bounded synthetic/local checks with no provider/network calls and no machine-wide changes. If
those conditions cannot be demonstrated, continue documentation work and defer implementation.
Neither creating a worktree nor passing tests authorizes integration or an operational run.

## 4. Package H1 — Analyzer Verification Completion

Owner of the analysis semantics: Phase 10.6B.3. H1 supplies verification and narrowly scoped fixes
against that existing contract; it must not invent a new gate or use interim V3 data to resolve one.

Completed evidence is recorded in the [H1 requirement matrix](./Phase-10.6H-H1-Verification.md).
The focused suite has 245 passing tests across five files, covering every 10.6B.3 Section 8 requirement.
H1 engineering acceptance is complete. Main subsequently bound and analyzed the archive without this H1 implementation; current integration verification remains distinct from that historical run.

- [x] Establish a separate checkout, independent dependencies, and owned temporary fixture paths.
- [x] Reject redirected archive/protocol paths and preserve the committed protocol's raw bytes in
      new checkouts. Verify the fix with synthetic junction and identity-guard regressions.

- [x] Map every Section 8 requirement to named tests and expected bounded errors/statuses.
- [x] Test containment, symlink/junction escape, missing/extra artifacts, nonfinal state, individual
      identity mismatch, coherent rewrites, and protocol/launch mismatch using temporary roots.
- [x] Test nonzero safety facts, duplicate identity/slot, cap excess, invalid value/missingness shape,
      wrong provenance, and label-shaped content.
- [x] Cover 71/72 and 95/96-unit boundaries; partition unit/date requirements; distinct mints; eight
      UTC dates; 20% concentration; four-date objective support; and exact 90% and 60-second edges.
      Explicitly compare checklist status selection with the frozen protocol. Any ambiguity is a
      source-contract review issue, not permission to retune a gate.
- [x] Prove numerical-value changes do not affect capability decisions or leak through reports;
      verify Markdown/JSON agreement and the canonical fingerprint independently.
- [x] Check all analyzer modules and the entrypoint for prohibited imports, dynamic access,
      environment/network/write/scheduler APIs, and transitive dependencies. Prove no archive access
      before the identity guard and bounded stdout/stderr behavior.
- [x] Run the Phase 10.6B.3 verification commands under the isolation rules; record revision, named
      tests, outcomes, limitations, and any source fixes. Reconcile that checklist's open items.

Historical H1 acceptance: every requirement has evidence; production identity remained unset; no real archive or
provider is accessed. Complete H1 before the separate final-identity binding and real-run gates.
The broader H2-H4 packages need not delay a valid V3 capability report.

## 5. Package H2 — Accounting, Schema, And Migration Integrity

Use the [H2 detailed implementation checklist](./NeXusTrade-Phase-10.6H-H2-Detailed-Checklist.md)
as the approved implementation reference. It supplies accepted design decisions, ordered batches,
invariants, named test requirements, and separate engineering/integration gates. The user approved
H2 implementation on 2026-09-10. Track completed implementation and final checks in its
[verification record](./Phase-10.6H-H2-Verification.md); no merge or operational migration is included.

### A. Freeze existing behavior and invariants

- [x] Capture current fee, slippage, rounding, selection, session-gating, and lifecycle behavior in
      synthetic fixtures. Do not change strategy defaults, risk thresholds, or economic assumptions.
- [x] Define one operation/request identity, allowed state transitions, position ownership, and the
      reconciliation equations for a simulated trade. Separate duplicate retries from new intent.
- [x] Review how each invariant is enforced by the database, service, and test; do not rely only on
      TypeScript types or on a preliminary read outside the transaction.

### B. Make trade persistence atomic and repeat-safe

- [x] Add a transaction boundary that supplies repositories bound to that same transaction. Commit
      order, fill, position, cash, and required status updates together, or roll them all back.
- [x] Resolve provider evidence before a short synchronous SQLite write transaction. Revalidate its
      freshness and the current session/cash/position/operation state inside the transaction; never
      await a provider while holding the write transaction.
- [x] Persist a unique operation identity atomically. A repeated identical request returns the
      recorded result; conflicting content for the same identity is rejected.
- [x] Prevent lost cash updates and repeated sells with conditional state changes and affected-row
      checks. Define behavior for simultaneous BUY/SELL or session gating.
- [x] Keep diagnostic logging failures from changing a successfully committed accounting result;
      preserve failed-operation evidence without manufacturing fills or silently repairing balances.
- [x] Inject failures at each write and test duplicate requests, competing callers, stale state,
      rollback, and restart at operation boundaries using isolated fixtures.

### C. Enforce schema and migration readiness

- [x] Add a partial unique constraint for an open position within the currently supported session
      and mint scope. Preserve multiple historical closed positions. Future portfolio scope belongs
      to the paper protocol and must receive its own schema review.
- [x] Define null-pair radar identity explicitly and enforce it for simultaneous inserts/upserts.
- [x] Add status/domain, nonnegative cash/fee, integer/amount, timestamp, and cross-session
      relationship constraints where required. P/L stays signed; do not apply a blanket nonnegative
      rule to all monetary fields.
- [x] Validate the required migration version and reject missing, partial, incompatible, or newer
      unsupported schemas with a clear error before business operations begin.
- [x] Test upgrades from each supported prior schema and refusal of incompatible fixtures. Existing
      invalid records must be reported for review; no automatic deletion, deduplication, history
      rewrite, or operational migration is authorized by this package's synthetic tests.

### D. Reconcile accounting without rewriting evidence

- [x] Add a read-only reconciliation service for synthetic/explicitly scoped inputs: cash versus
      recorded activity, fills versus orders, position lifecycle, ownership, fees, and orphan or
      duplicate records. Classify discrepancies; never repair them silently.
- [x] Decide whether existing records are sufficient for complete reconstruction. If not, propose a
      minimal append-only cash-movement ledger with operation/trade links as a separately reviewed
      schema addition. Do not invent historical ledger entries. Record the decision and route any
      necessary future-pilot implementation to 10.8B after the 10.7A protocol.

Acceptance: H-01/H-02/H-04 have regressions; partial trades, duplicate processing, and lost updates
are prevented in fixtures; migration and reconciliation failures are explicit. No operational
database is read, migrated, reset, or repaired by development verification.

## 6. Package H3 — Provider Concurrency And Measurement Semantics

Use the [H3 detailed implementation checklist](./NeXusTrade-Phase-10.6H-H3-Detailed-Checklist.md) for approved D1-D9 decisions,
H3-00 through H3-06, and named acceptance requirements. Drafted 2026-09-17 from the committed H2
baseline. Approved and implemented in isolation; see the [verification record](./Phase-10.6H-H3-Verification.md) and [time/budget contract](./Phase-10.6H-H3-Provider-Time-And-Budget-Contract.md). Operational integration remains separate.

- [x] Fix general limiter admission with a deterministic queue or atomic capacity recheck; prove
      waiting callers cannot consume the same capacity. Specify fairness, cancellation, timeout,
      and window-boundary behavior.
- [x] Declare budget ownership and sharing scope across callers/categories/processes. A process-local
      limiter must not claim to enforce a host-wide cap; preserve the existing single-owner limits
      until another execution model is explicitly designed.
- [x] Use fake clocks and fake transports to test bursts, concurrent wakes, cancellation, and errors.
      Preserve provider/category caps, retries, fallback policies, and existing economic behavior.
- [x] Document source-observation, request-start, response-receipt, and persistence timestamps as
      distinct concepts, including unknown source time. Do not relabel historical facts.
- [x] Any changed timestamp meaning, sampling behavior, provider surface, or evidence format requires
      a new reviewed contract/version before future collection. Leave frozen V3 bytes and archives
      unchanged, even if a newer design would use different semantics.

Acceptance: H-03 is reproduced and fixed under simulated concurrency; budget and time semantics are
explicit; no live provider probe or change to V3 collection is part of the package.

## 7. Package H4 — Enforced Boundaries And Development Workflow

The [H4 detailed implementation checklist](./NeXusTrade-Phase-10.6H-H4-Detailed-Checklist.md) was approved from `3b7b229` and implemented on 2026-09-18. Local verification and supplied Windows/Linux hosted checks passed; H4 is merged into main at `88921e9`. See the [verification record](./Phase-10.6H-H4-Verification.md) and [boundary/debt audit](./Phase-10.6H-H4-Boundary-Audit.md). H4 engineering acceptance is closed.

- [x] Define an allowed dependency map and automatically reject prohibited analyzer/provider/database/
      execution imports, including transitive or dynamic access where applicable.
- [x] Narrow service dependencies to the operations they need; expose read-only interfaces to readers
      and validated domain facts to calculators. Reduce direct dependence on database row shapes
      where it makes tests or schema evolution fragile.
- [x] Add versioned runtime validation at existing persisted-JSON boundaries that currently rely on
      type assertions. Preserve supported historical representations with explicit reader versions.
- [x] Add automated format, lint, workspace typecheck, selected/full isolated tests, and secret checks
      as appropriate. CI uses synthetic/in-memory/temporary data, blocks real network access, and
      has no operational credentials, archive mounts, or live database paths. Inventory the full test
      suite before enabling it; never assume all tests are isolated from their names alone.
- [x] Split large modules only along meaningful validation/calculation/formatting responsibilities.
      Extract shared utilities selectively; never make a frozen study silently inherit new semantics.
- [x] Keep the current status, historical command documentation, evidence references, and review
      checklists consistent. Record supported tool/runtime versions and the reviewed source revision.

Acceptance: automated checks enforce the agreed boundaries; behavioral fixtures remain unchanged;
the current handoff points to authoritative phase status. A framework rewrite, provider expansion,
or a new dashboard is outside this existing-code improvement phase.

## 8. Verification Record And Exit Gates

For every completed package, record its exact revision, scope/diff, named tests, failure probes,
results, known limitations, and integration location. Do not mark a package complete from the total
number of passing tests alone. Existing approvals retain their scope; the checklist creates no
approval requirement for each individual implementation checkbox.

- [x] Create this planned phase and synchronize the development roadmap and handoff documentation.
- [x] Draft and approve H2; complete isolated engineering acceptance and record committed H2 as `ff6d586`.
- [x] Draft the detailed H3 implementation plan for user review; H3 is approved and has completed isolated engineering acceptance.
- [x] Record the chosen package and prove its implementation environment satisfies Section 3.
      H1 isolation is recorded; H2-H4 must recheck their own dependencies and fixture requirements.
- [x] Complete H1 and reconcile the Phase 10.6B.3 verification record before final identity binding.
- [x] Complete H2 engineering acceptance before future PAPER operations rely on existing execution/persistence code.
      Integration/migration and PAPER authorization remain separately gated.
- [x] Complete H3 isolated engineering acceptance before future concurrent provider workflows rely on the general limiter; integration remains gated.
- [x] Complete H4 and document the boundary/verification protections for the reviewed release.
- [x] Review integration after V3 closeout, preserving the analyzed archive identity and frozen
      implementation evidence. Record which packages are complete and which remain deferred.

The final V3 report depends on H1 plus its original finality/binding/run gates. Future PAPER entry
requires H2-H4 acceptance for the implementation it uses, the separate 10.7 promotion decision,
the frozen 10.7A protocol, and named-pilot authority. None substitutes for another.
