# NeXusTrade Phase 9 Detailed Checklist

Shadow-First TerminalRunner

Last updated: July 2026

Status: Implemented.

Mode: `PAPER` orchestration, shadow research only.

## Purpose

Phase 9 builds TerminalRunner so long research runs require less manual command work.

TerminalRunner should orchestrate the existing shadow-safe pipeline:

```text
scanner
-> risk
-> strategy
-> shadow observe
-> shadow exits
-> shadow calibration
-> shadow entries
-> watchlist returns
-> analytics report
-> calibration report
```

Phase 9 does not promote a strategy profile and does not enable paper BUY automation.

## Historical Inputs

Read these before implementation:

- [Phase-9-Planning-Inputs.md](./Phase-9-Planning-Inputs.md)
- [NeXusTrade-Phase-8.93-Detailed-Checklist.md](./NeXusTrade-Phase-8.93-Detailed-Checklist.md)
- [ROADMAP_Phase9Plus.md](./ROADMAP_Phase9Plus.md)
- [DECISIONS_Phase9Plus.md](./DECISIONS_Phase9Plus.md)
- [Structure_Phase9Plus.md](./Structure_Phase9Plus.md)
- [Provider-Strategy-Phase9Plus.md](./Provider-Strategy-Phase9Plus.md)

Key handoff result:

```text
Phase 8.93 promoted no profile.
paper BUY orchestration permission = false
Phase 9 starts shadow-first.
```

## Non-Goals

Phase 9 must not:

- enable live trading,
- load wallets,
- sign transactions,
- submit transactions,
- run `paper:execute` by default,
- run `paper:sell` by default,
- run `session:manage` by default,
- run `exits:manage` by default,
- create orders, fills, or positions as part of the default loop,
- invent or tune strategy rules,
- promote any profile,
- treat shadow P/L as realized P/L,
- add dashboard UI.
- add new external provider adapters by default.

## Recommended Command Shape

Add:

```bash
pnpm terminal:run --once
pnpm terminal:run --cycles=6 --interval-ms=60000
pnpm terminal:run --max-runtime-minutes=120 --interval-ms=60000
pnpm terminal:run --once --json
```

Default behavior:

```text
mode = PAPER
shadowOnly = true
once = true unless cycles or max-runtime-minutes is supplied
paper execution stages disabled
continueOnEmpty = true
continueOnRecoverableStageFailure = true
```

## Runtime Defaults

Preserve the Phase 9 handoff defaults unless implementation discovers a concrete conflict:

```text
scanner intervalMs = 60000
scanner limit = 25
scanner concurrency = 3
risk statuses = DISCOVERED,WATCHING
risk sinceHours = 24
risk limit = 50
risk concurrency = 3
strategy sinceHours = 24
strategy limit = 50
watchlist horizons = 3,5,15,30,60,120,240,360,480,720
shadow observe sourceDecisions = BUY
shadow score min = 55
shadow targetPcts = 10,15,25
shadow stopPcts = 10,15,25
shadow maxHoldMinutes = 60
```

## Provider Pressure Scope

Phase 9 should make provider pressure visible, but should not add provider fallbacks yet.

Each run summary should include provider-pressure fields when available:

```text
provider health rows observed
OK / DEGRADED / RATE_LIMITED / ERROR counts by provider
quote attempts and quote successes when exposed by stage summaries
missing quote counts when exposed by risk/strategy/reporting stages
notes for candidates that moved favorably despite missing quote evidence
```

If implementation discovers that provider-pressure fields require a larger refactor, capture the
available `ProviderHealth` deltas first and document the deeper fields as Phase 9.1 work.

## Implementation Checklist

### 1. Pre-Flight

- [x] Confirm Phases 8 through 8.93 are committed or intentionally left as known docs-only changes.
- [x] Confirm `data/` root is clean except active DB files and `archive/`.
- [x] Confirm no secrets or local transcripts are staged.
- [x] Confirm active Phase 9+ docs exist.
- [x] Confirm provider strategy doc exists.
- [x] Confirm `paper:execute` remains outside TerminalRunner defaults.

### 2. Config

- [x] Add `backend/src/terminal-runner/TerminalRunnerConfig.ts`.
- [x] Parse `--once`.
- [x] Parse `--cycles`.
- [x] Parse `--interval-ms`.
- [x] Parse `--max-runtime-minutes`.
- [x] Parse `--json`.
- [x] Parse optional `--output-dir`.
- [x] Reject live mode.
- [x] Reject paper execution flags in Phase 9 default mode.
- [x] Add config tests for defaults, loop options, invalid combinations, and safety rejection.

### 3. Stage Result Contract

- [x] Add a shared stage result type for TerminalRunner.
- [x] Track stage name.
- [x] Track status: `SUCCESS`, `EMPTY`, `SKIPPED`, `FAILED`.
- [x] Track start and end timestamps.
- [x] Track duration.
- [x] Track summary text.
- [x] Track structured counts when available.
- [x] Track provider-pressure counts when available.
- [x] Track recoverable versus fatal failures.

### 4. Stage Adapters

- [x] Prefer composing existing backend runner/service classes directly where practical.
- [x] Avoid shelling out to `pnpm` from inside TerminalRunner unless a stage has no reasonable
      service surface.
- [x] Add scanner stage.
- [x] Add risk stage.
- [x] Add strategy stage.
- [x] Add shadow observe stage.
- [x] Add shadow exits stage.
- [x] Add shadow calibration stage.
- [x] Add shadow entries stage.
- [x] Add watchlist returns stage.
- [x] Add analytics report stage.
- [x] Add calibration report stage.
- [x] Capture provider health deltas before and after the cycle when practical.
- [x] Explicitly exclude paper BUY, paper SELL, SessionManager, and ExitManager stages from the
      default phase.

### 5. TerminalRunner

- [x] Add `backend/src/terminal-runner/TerminalRunner.ts`.
- [x] Execute stages in deterministic order.
- [x] Support `--once`.
- [x] Support fixed cycle count.
- [x] Support max runtime.
- [x] Sleep between cycles only when another cycle remains.
- [x] Treat zero-candidate and zero-observation stages as non-fatal.
- [x] Continue after recoverable provider/reporting failures when safe.
- [x] Stop on safety-boundary failures.
- [x] Handle `Ctrl+C` gracefully.
- [x] Print a cycle summary after each cycle.
- [x] Print a final run summary.

### 6. Output Artifacts

- [x] Default to console output only.
- [x] If `--output-dir` is supplied, write a run summary JSON file.
- [x] If `--output-dir` is supplied, write a run summary text file.
- [x] Use ignored `data/` paths for local run artifacts.
- [x] Do not commit generated run artifacts.
- [x] Include run id, cycle count, stage outcomes, totals, and safety status.
- [x] Include provider-pressure summary when available.

### 7. CLI And Scripts

- [x] Add `backend/src/scripts/terminal-runner.ts`.
- [x] Add backend package script `terminal:run`.
- [x] Add root package script `terminal:run`.
- [x] Ensure `pnpm terminal:run --once` works from repo root.
- [x] Ensure `pnpm terminal:run --once --json` works from repo root.

### 8. Tests

- [x] Add config tests.
- [x] Add stage ordering tests.
- [x] Add zero-candidate cycle tests.
- [x] Add recoverable failure tests.
- [x] Add fatal safety-boundary tests.
- [x] Add summary output tests.
- [x] Add provider-pressure summary tests with mocked stage/provider-health counts where practical.
- [x] Add CLI argument smoke tests where practical.

### 9. Documentation

- [x] Update [ROADMAP_Phase9Plus.md](./ROADMAP_Phase9Plus.md).
- [x] Update [DECISIONS_Phase9Plus.md](./DECISIONS_Phase9Plus.md) for any implementation decisions
      locked during coding.
- [x] Update [Structure_Phase9Plus.md](./Structure_Phase9Plus.md) with actual files created.
- [x] Update this checklist with completion notes.
- [x] Leave historical docs mostly unchanged unless a cross-link becomes stale.

## Acceptance Criteria

Phase 9 is complete when:

- [x] `pnpm terminal:run --once` executes the shadow-safe cycle.
- [x] `pnpm terminal:run --once --json` emits machine-readable summary output.
- [x] zero-candidate cycles are reported clearly and do not fail the run.
- [x] provider/reporting failures are classified as recoverable or fatal.
- [x] provider pressure is summarized from available health/stage evidence.
- [x] paper execution stages are not run by default.
- [x] safety-boundary tests prove TerminalRunner cannot trigger live mode or default paper BUY.
- [x] docs and Phase 9+ structure are updated.
- [x] `pnpm verify` passes.

## Completion Notes

Implemented files:

- `backend/src/terminal-runner/TerminalRunnerConfig.ts`
- `backend/src/terminal-runner/TerminalRunSummary.ts`
- `backend/src/terminal-runner/TerminalStageRunner.ts`
- `backend/src/terminal-runner/TerminalRunner.ts`
- `backend/src/scripts/terminal-runner.ts`
- `backend/src/terminal-runner/*.test.ts`

Implementation decisions:

- TerminalRunner composes existing runner/service classes directly.
- TerminalRunner defaults to `--once`.
- `--cycles` and `--max-runtime-minutes` enable loop mode.
- `--output-dir` writes JSON and text artifacts; otherwise output is console-only.
- Provider pressure uses `ProviderHealth` deltas first.
- TerminalRunner creates one `PAPER` + `RUNNING` session per run and passes that `sessionId`
  through every stage/cycle.
- Normal output prints compact cycle/stage progress logs; `--json` output stays machine-readable.
- Paper BUY/SELL, SessionManager, and ExitManager are intentionally excluded from the default
  Phase 9 stage list.

Validation note:

- The first two-hour Phase 9 smoke run proved TerminalRunner safety and provider telemetry, but it
  exposed scanner auto-created sessions per cycle. The implementation was patched so future
  research runs use a single run-scoped session and reports summarize the full validation window.

## Phase 9 Validation Runbook

After implementation, run:

```powershell
cd U:\Projects\NeXusTrade-Otis

corepack pnpm verify

corepack pnpm terminal:run --once

corepack pnpm terminal:run --once --json
```

Then perform one longer local validation run:

```powershell
corepack pnpm terminal:run --max-runtime-minutes=120 --interval-ms=60000 --output-dir=data\phase9-runs
```

Archive generated run artifacts under `data/archive/phase9` after review.
