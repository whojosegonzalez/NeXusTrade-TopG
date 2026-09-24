# NeXusTrade Phase 8.6 Detailed Checklist

Stabilization + Clean Paper Validation + Phase 9 Handoff

Last updated: June 2026

Status: Complete.

Mode: `PAPER` only.

## Executive Summary

Phase 8.6 is a stabilization phase.

No new trading features are introduced. No new trading logic is introduced. No new exit strategies
are introduced.

Phase 8.6 exists to stabilize Phases 1 through 8.5, archive/reset local paper data, run a clean
validation pass, document operational findings, and create the Phase 9 TerminalRunner handoff.

## Implementation Review

Phase 8.6 is implementable with the current codebase.

There are no technical blockers, but there are operational limitations:

- A clean real-market run may discover zero candidates.
- A clean real-market run may produce zero BUY decisions.
- A clean real-market run may not reach `TARGET_REACHED` or `MAX_DRAWDOWN`.
- Provider availability, rate limits, and API keys can affect live-data validation.
- The local paper DB reset is destructive unless the archive step is completed first.

Do not loosen risk rules, strategy rules, or execution gates just to force a BUY during Phase 8.6.
Document the actual result instead.

## Locked Clarifications

- [ ] Phase 8.6 is `PAPER` only.
- [ ] No new trading features.
- [ ] No new scanner logic.
- [ ] No new risk rules.
- [ ] No new strategy rules.
- [ ] No new execution model.
- [ ] No new exit strategies.
- [ ] No stop-loss logic.
- [ ] No trailing-stop logic.
- [ ] No max-hold logic.
- [ ] No liquidity-collapse logic.
- [ ] No schema migrations.
- [ ] No provider adapter changes.
- [ ] No live wallet loading.
- [ ] No transaction signing.
- [ ] No transaction submission.
- [ ] Phase 8 and Phase 8.5 should be committed before database cleanup.

## Definition Of Done

Phase 8.6 is complete when:

- [x] Phase 8 and Phase 8.5 are committed.
- [x] Current paper DB is archived.
- [x] Archive restoration procedure is documented.
- [x] Paper DB is reset.
- [x] Schema and repository smoke checks pass.
- [x] Clean validation commands are run.
- [x] Actual validation outputs are recorded.
- [x] Known limitations are documented.
- [x] Phase 9 planning inputs are created.
- [x] Repository is verified with `pnpm verify`.
- [x] Project is ready for TerminalRunner implementation.

## Commit Stabilization

Before touching the local paper database:

```bash
pnpm verify
git status --short
```

Commit requirements:

- [ ] Phase 8 implementation committed.
- [ ] Phase 8.5 implementation committed.
- [ ] Docs committed with implementation notes.
- [ ] No unrelated generated DB files staged.
- [ ] No `.env`, wallet, private key, or local DB artifacts staged.

Recommended commit grouping:

```text
phase8: add session manager snapshots and buy gating
phase8.5: add automated paper exit manager
phase8.6: document stabilization and phase 9 handoff
```

If Phase 8 and Phase 8.5 remain in the same working tree, a single combined commit is acceptable
before Phase 8.6 operational work:

```text
phase8-8.5: add session manager and exit manager
```

## Documentation Audit

Verify these files reflect current behavior:

- [ ] `README.md`
- [ ] `docs/Structure.md`
- [ ] `docs/ROADMAP.md`
- [ ] `docs/DECISIONS.md`
- [ ] `docs/NeXusTrade-Phase-8-Detailed-Checklist.md`
- [ ] `docs/NeXusTrade-Phase-8.5-Detailed-Checklist.md`
- [ ] `docs/architecture/session-manager.md`
- [ ] `docs/architecture/exit-manager.md`
- [ ] `docs/architecture/paper-exchange.md`
- [ ] `docs/architecture/paper-sell-engine.md`

## Database Hygiene Rationale

The current local paper database may contain:

- seeded Phase 2 sessions
- fake mints
- fake pair addresses
- smoke-test positions
- manual command output
- provider health records from old experiments
- system logs from earlier verification

Those rows are useful during development but are not clean market-history data. Phase 8.6 archives
them before resetting the paper DB so Phase 9 starts from a clean baseline.

## Archive Procedure

Do not reset the database until the archive is created and verified.

PowerShell archive procedure:

```powershell
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$archiveDir = "data/archive/paper-$stamp"
New-Item -ItemType Directory -Force -Path $archiveDir
Copy-Item -LiteralPath "data/nexus_paper.db" -Destination $archiveDir -ErrorAction SilentlyContinue
Copy-Item -LiteralPath "data/nexus_paper.db-wal" -Destination $archiveDir -ErrorAction SilentlyContinue
Copy-Item -LiteralPath "data/nexus_paper.db-shm" -Destination $archiveDir -ErrorAction SilentlyContinue
Get-ChildItem -Force $archiveDir
```

Archive acceptance:

- [ ] Archive directory exists under `data/archive/`.
- [ ] Existing `nexus_paper.db` was copied if present.
- [ ] WAL and SHM files were copied if present.
- [ ] Archive path is recorded in Phase 8.6 notes.
- [ ] Archive files remain ignored by Git.

If no paper DB exists, document that there was nothing to archive and continue.

## Rollback Procedure

Rollback should only be used if the reset must be undone.

PowerShell rollback procedure:

```powershell
$archiveDir = "data/archive/paper-YYYYMMDD-HHMMSS"
Stop-Process -Name node -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "data/nexus_paper.db" -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "data/nexus_paper.db-wal" -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "data/nexus_paper.db-shm" -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath "$archiveDir/nexus_paper.db" -Destination "data/nexus_paper.db" -ErrorAction SilentlyContinue
Copy-Item -LiteralPath "$archiveDir/nexus_paper.db-wal" -Destination "data/nexus_paper.db-wal" -ErrorAction SilentlyContinue
Copy-Item -LiteralPath "$archiveDir/nexus_paper.db-shm" -Destination "data/nexus_paper.db-shm" -ErrorAction SilentlyContinue
```

Rollback acceptance:

- [ ] Paper DB files are restored from the selected archive.
- [ ] `pnpm db:smoke:paper` or equivalent readback confirms database access.
- [ ] Rollback reason is documented.

## Reset Procedure

The existing reset command is the approved reset surface:

```bash
pnpm db:reset:paper
```

Expected behavior:

```text
DB RESET: recreated PAPER database at <repo>/data/nexus_paper.db
```

Reset acceptance:

- [ ] Existing paper DB files were removed by the guarded reset script.
- [ ] Migrations were reapplied.
- [ ] New paper DB exists under `data/`.
- [ ] No live DB files were touched.
- [ ] `git status --short` does not show DB files.

## Post-Reset Schema Validation

Run:

```bash
pnpm db:migrate:paper
pnpm db:smoke:paper
```

Important note: `db:smoke:paper` inserts seeded fake data. If the goal is a clean real-market DB
immediately after smoke validation, run `pnpm db:reset:paper` again after the smoke test.

Acceptance:

- [ ] Migrations run successfully.
- [ ] Smoke test reports readback success.
- [ ] If smoke seeded fake rows, database is reset again before clean market validation.

## Validation Tracks

Phase 8.6 has two validation tracks.

### Track A: Deterministic Validation

Required:

```bash
pnpm verify
pnpm db:reset:paper
pnpm db:smoke:paper
pnpm db:reset:paper
```

Expected outputs:

- [ ] `pnpm verify` passes.
- [ ] Shared tests pass.
- [ ] Backend tests pass.
- [ ] Secret check passes.
- [ ] DB reset reports recreated paper DB.
- [ ] DB smoke reports migrations verified and readback checks passed.
- [ ] Final reset leaves a clean schema for Track B.

### Track B: Clean Real-Market Validation

Required when provider configuration is available:

```bash
pnpm scanner:discover --once
pnpm risk:evaluate --once
pnpm strategy:evaluate --once
pnpm paper:execute --once
pnpm session:manage --once
pnpm exits:manage --once --dry-run
```

Expected outputs are state-dependent. The clean run is successful if each command either:

- completes with valid records and safety output, or
- fails clearly because the prior command produced no eligible input.

Acceptable non-blocking outcomes:

- [ ] Scanner discovers zero candidates.
- [ ] Risk has no eligible candidates after scanner output.
- [ ] Strategy creates zero BUY decisions.
- [ ] Paper BUY has no approved BUY candidates.
- [ ] SessionManager snapshots a session with zero open positions.
- [ ] ExitManager dry-run reports no gated session.

Unacceptable outcomes:

- [ ] Any command loads a wallet.
- [ ] Any command signs a transaction.
- [ ] Any command submits a transaction.
- [ ] Any command writes to `LIVE` storage.
- [ ] Any command mutates data in dry-run mode.
- [ ] Any command fails with an unclear or unhandled error.

## Exact Validation Dataset Expectations

Dataset A: archived development DB.

- Purpose: preserve historical development artifacts.
- Expected data: seeded fake sessions, smoke rows, manual test rows, old logs.
- Used for: rollback only.

Dataset B: clean schema DB.

- Purpose: validate migrations and fresh startup.
- Expected data before scanner: zero sessions, zero TokenRadar rows, zero positions, zero snapshots.
- Used for: clean real-market validation.

Dataset C: smoke-test DB.

- Purpose: deterministic repository and schema readback.
- Expected data: seeded fake mints and one seeded paper scenario.
- Used for: DB smoke only.
- Cleanup: reset after smoke before Track B.

Dataset D: clean real-market DB.

- Purpose: validate the modern paper pipeline with real provider data.
- Expected data: real token mint addresses only.
- Used for: Phase 9 readiness assessment.
- Rule: do not manually insert fake mints into Dataset D.

## Command Acceptance Matrix

`pnpm scanner:discover --once`

- [ ] Runs in `PAPER`.
- [ ] Prints no wallet/signing/submission activity.
- [ ] Writes TokenRadar rows when discovery returns candidates.
- [ ] Creates or reuses a paper scanner session.
- [ ] Handles zero candidates clearly.

`pnpm risk:evaluate --once`

- [ ] Runs in `PAPER`.
- [ ] Consumes existing scanner TokenRadar rows.
- [ ] Writes RiskAssessment rows for eligible candidates.
- [ ] Updates TokenRadar only within risk-safe bounds.
- [ ] Handles missing candidates clearly.

`pnpm strategy:evaluate --once`

- [ ] Runs in `PAPER`.
- [ ] Consumes WATCHING candidates with latest risk records.
- [ ] Writes StrategyDecision rows.
- [ ] Updates TokenRadar to APPROVED only after BUY decisions.
- [ ] Handles zero BUY decisions clearly.

`pnpm paper:execute --once`

- [ ] Runs in `PAPER`.
- [ ] Consumes BUY decisions and APPROVED TokenRadar rows.
- [ ] Writes BUY orders, fills, positions, and cash updates only when valid.
- [ ] Rejects missing prices, insufficient cash, duplicate open positions, or gated sessions clearly.

`pnpm paper:sell --once --sell-all --dry-run`

- [ ] Requires explicit sell trigger.
- [ ] Does not write in dry-run mode.
- [ ] Uses PaperSell quote/fallback behavior.
- [ ] Handles no open positions clearly.

`pnpm session:manage --once`

- [ ] Runs in `PAPER`.
- [ ] Creates snapshots in non-dry mode.
- [ ] Updates unrealized P/L.
- [ ] Gates BUYs when target or drawdown is reached.
- [ ] Does not sell or complete sessions.

`pnpm exits:manage --once --dry-run`

- [ ] Runs in `PAPER`.
- [ ] Defaults observe-only.
- [ ] Writes nothing in dry-run mode.
- [ ] Reports no gated session clearly when there is no trigger.
- [ ] Does not sell unless matching action is explicit and non-dry.

## Observability Audit

Verify log scopes and summaries:

- [ ] `SCANNER` logs for scanner runs.
- [ ] `RISK` logs for risk runs.
- [ ] `STRATEGY` logs for strategy runs.
- [ ] `EXECUTION` logs for paper buy, paper sell, and ExitManager.
- [ ] `SESSION` logs for SessionManager.
- [ ] `PROVIDER` health records when enabled.

There is no dedicated `EXIT` log scope in Phase 8.6. ExitManager uses:

```text
SystemLog.scope = EXECUTION
contextJson.phase = PHASE_8_5_EXIT_MANAGER
```

## Known Limitation Tracking

Document the current status of:

- [ ] Provider availability and API keys.
- [ ] DexScreener discovery source limitations.
- [ ] Helius authority evidence unknown versus disabled limitation.
- [ ] Jupiter quote availability and missing quote behavior.
- [ ] Strategy BUY scarcity in real market data.
- [ ] PaperSell ordered writes without transaction wrapper.
- [ ] ExitManager session-level sell-all only.
- [ ] No stop-loss, trailing-stop, max-hold, liquidity-collapse, or partial exits.
- [ ] No frontend dashboard yet.
- [ ] No TerminalRunner orchestration yet.

## Phase 9 Planning Inputs

Create:

```text
docs/Phase-9-Planning-Inputs.md
```

Capture:

- [ ] Current command list.
- [ ] Runtime defaults.
- [ ] Required command order.
- [ ] Command output summaries.
- [ ] Failure behavior.
- [ ] Dry-run behavior.
- [ ] Safety boundaries.
- [ ] Session lifecycle.
- [ ] Exit lifecycle.
- [ ] Logging surfaces.
- [ ] Provider dependencies.
- [ ] Database hygiene outcome.
- [ ] Clean validation results.
- [ ] Known limitations.

## Phase 9 Orchestration Assumptions

Phase 9 TerminalRunner should orchestrate existing commands/services. It should not add new trading
logic.

Expected order:

```text
scanner
-> risk
-> strategy
-> paper BUY
-> session manage
-> exits manage
```

Assumptions:

- [ ] TerminalRunner runs in `PAPER` by default.
- [ ] TerminalRunner never loads wallets.
- [ ] TerminalRunner never signs transactions.
- [ ] TerminalRunner never submits transactions.
- [ ] TerminalRunner uses existing service layers rather than shelling out where practical.
- [ ] TerminalRunner records cycle summaries.
- [ ] TerminalRunner handles zero-candidate and zero-BUY cycles as normal outcomes.
- [ ] TerminalRunner supports graceful shutdown.
- [ ] TerminalRunner does not loosen risk or strategy thresholds.

## Milestone Sign-Off Criteria

Phase 8.6 sign-off requires:

- [ ] `pnpm verify` passed after Phase 8.6 docs and any stabilization fixes.
- [ ] Paper DB archive path recorded.
- [ ] Paper DB rollback procedure confirmed.
- [ ] Paper DB reset completed.
- [ ] Smoke validation completed.
- [ ] Clean validation attempted.
- [ ] All command outputs recorded or summarized.
- [ ] Known limitations updated.
- [ ] Phase 9 planning inputs created.
- [ ] No local secrets or DB files staged.
- [ ] User confirms readiness to start Phase 9.

## Verification Commands

Baseline:

```bash
pnpm verify
pnpm db:reset:paper
pnpm db:smoke:paper
pnpm db:reset:paper
```

Clean validation:

```bash
pnpm scanner:discover --once
pnpm risk:evaluate --once
pnpm strategy:evaluate --once
pnpm paper:execute --once
pnpm session:manage --once
pnpm exits:manage --once --dry-run
```

Use non-dry `exits:manage` only when a gated paper session exists and the operator explicitly wants
to close all open paper positions.

## Phase Notes

Add notes during implementation:

- archive directory
- reset result
- smoke result
- scanner result
- risk result
- strategy result
- paper BUY result
- session manager result
- exit manager dry-run result
- known limitations found
- Phase 9 handoff path

## Phase Notes

- 2026-06-22: Baseline `pnpm verify` passed before database cleanup.
- 2026-06-22: Committed completed Phase 8, Phase 8.5, and Phase 8.6 documentation checkpoint as
  `82252df Add ExitManager & SessionManager features`.
- 2026-06-22: Archived the development paper DB to `data\archive\paper-20260622-131803`.
- 2026-06-22: Reset the paper DB with `pnpm db:reset:paper`.
- 2026-06-22: Ran deterministic smoke validation with `pnpm db:smoke:paper`; migrations and
  readback checks passed.
- 2026-06-22: Reset the paper DB again after smoke validation to remove seeded fake rows.
- 2026-06-22: Ran one clean scanner cycle. Output:
  `discovered=25 unique=25 enriched=25 stored=25 errors=0`.
- 2026-06-22: Ran risk evaluation. Output:
  `selected=25 evaluated=25 PASS=0 WARN=8 FAIL=17 UNKNOWN=0 written=25 statusUpdated=25 errors=0`.
- 2026-06-22: Ran strategy evaluation. Output:
  `selected=8 evaluated=8 BUY=0 WATCH=0 SKIP=8 HOLD=0 SELL=0 written=8 statusUpdated=0 errors=0`.
- 2026-06-22: Ran paper BUY. It failed safely with no approved BUY candidates.
- 2026-06-22: Ran SessionManager. It created one equity snapshot with zero open positions and left
  `terminationReason=NOT_TERMINATED`.
- 2026-06-22: Ran ExitManager dry-run. It failed safely with
  `NO_GATED_RUNNING_PAPER_SESSION`.
- 2026-06-22: Created Phase 9 handoff at `docs/Phase-9-Planning-Inputs.md`.
- 2026-06-22: Reviewed user-run 27-28 minute scanner validation transcript. The transcript missed
  several native-process summary lines after `Ctrl+C`, but database logs confirmed 29 scanner
  cycles with recent cycle summaries of `discovered=25 unique=25 enriched=25 stored=25 errors=0`.
- 2026-06-22: Long-run validation database readback showed latest session
  `session_e3eef094-44dd-4073-9eaa-9261a3e59732` with `TokenRadar REJECTED=27 WATCHING=7`,
  `Risk FAIL=27 WARN=10 PASS=0`, `Strategy SKIP=10 BUY=0`, no orders, no fills, no positions, and
  one SessionManager equity snapshot.
- 2026-06-22: Long-run provider health showed DexScreener stable, Helius partially degraded, and
  Jupiter frequently rate-limited. No rerun is required solely because of the command-entry mistakes
  in the transcript.
