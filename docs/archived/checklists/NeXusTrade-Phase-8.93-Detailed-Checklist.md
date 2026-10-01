# NeXusTrade Phase 8.93 Detailed Checklist

Strategy Promotion Review

Last updated: July 2026

Status: Complete.

Mode: `PAPER` strategy promotion review only.

## Purpose

Phase 8.93 keeps research, promotion, and orchestration separate.

The flow is:

```text
8.91 Measure behavior
8.92 Build the experimentation workbench
8.92B Refine research tooling and readiness evidence
8.93 Review promotion evidence
9 Orchestrate the approved next behavior
```

Phase 8.93 reviewed whether any Phase 8.92B research profile should become real paper strategy
behavior. It did not invent strategy rules, change profile behavior, run live trades, create paper
orders, or turn shadow P/L into realized P/L.

## Source Evidence

Fresh Phase 8.92B validation datasets:

```text
data/archive/phase8.92B/test1-phase8.92B-test1-20260708-1141
data/archive/phase8.92B/test2-phase8.92B-test2-20260708-1949
data/archive/phase8.92B/test3-phase8.92B-test3-20260709-0908
```

Primary machine-readable reports:

```text
data/archive/phase8.92B/test1-phase8.92B-test1-20260708-1141/phase8.92B-test1-20260708-1141-shadow-entries.json
data/archive/phase8.92B/test2-phase8.92B-test2-20260708-1949/phase8.92B-test2-20260708-1949-shadow-entries.json
data/archive/phase8.92B/test3-phase8.92B-test3-20260709-0908/phase8.92B-test3-20260709-0908-shadow-entries.json
```

## Mechanical Safety Review

Archived DB counts:

```text
Test 1: orders=0 fills=0 positions=0 strategyDecisions=44 watchlistObservations=153
Test 2: orders=0 fills=0 positions=0 strategyDecisions=40 watchlistObservations=408
Test 3: orders=0 fills=0 positions=0 strategyDecisions=37 watchlistObservations=289
```

Combined source summary:

```text
runs = 3
observed decisions = 50
run-level unique mint observations = 20
orders = 0
fills = 0
positions = 0
```

Safety decision:

```text
source datasets are valid for promotion review
source datasets did not execute paper BUY
source datasets did not create trading-state rows
```

## Promotion Bar

A profile could be considered for promotion only if it satisfied all hard gates:

```text
status = CANDIDATE_FOR_PROMOTION
confidence = MEDIUM or HIGH
signal stability = MEDIUM or HIGH
profile version = explicit and immutable
source datasets contain zero Order rows
source datasets contain zero Fill rows
source datasets contain zero Position rows
```

Minimum evidence bar:

```text
run count >= 3
unique mints >= 10
entered decisions >= 20
target-first rate >= 60%
stop-first rate <= 30%
avgWorst >= -20%
no single mint contributes more than 35% of wins
no single market window contributes more than 40% of observed wins
```

## Readiness Findings

Combined readiness status counts:

```text
NOT_READY = 56
PROMISING_RESEARCH = 5
CANDIDATE_FOR_PROMOTION = 0
```

Combined confidence counts:

```text
LOW = 61
MEDIUM = 0
HIGH = 0
```

The five `PROMISING_RESEARCH` rows all came from the third fresh validation window and all remained:

```text
confidence = LOW
signalStability = LOW
```

Therefore no profile passed the hard promotion bar.

## Representative Normalized Outcomes

These rows use normalized profile summaries, not scenario-expanded diagnostics.

```text
P001@v1 baseline_raw_buy / decision:
  considered = 9
  entered = 9
  run-level unique mint observations = 9
  target-first = 44.44%
  stop-first = 33.33%
  avgBest = +16.76%
  avgWorst = -39.48%

P005@v1 quote_control / decision:
  considered = 50
  entered = 50
  run-level unique mint observations = 20
  target-first = 36.00%
  stop-first = 46.00%
  avgBest = +15.49%
  avgWorst = -28.11%

P004@v1 score55_research / decision:
  considered = 30
  entered = 21
  run-level unique mint observations = 14
  target-first = 23.81%
  stop-first = 57.14%
  avgBest = +17.59%
  avgWorst = -28.43%

P009@v1 score65_79_confirmed / decision:
  considered = 18
  entered = 15
  run-level unique mint observations = 9
  target-first = 20.00%
  stop-first = 46.67%
  avgBest = +12.91%
  avgWorst = -32.14%

P006@v1 recovery_after_drawdown / first_entry:
  considered = 19
  entered = 15
  run-level unique mint observations = 19
  target-first = 20.00%
  stop-first = 60.00%
  avgBest = +23.07%
  avgWorst = -32.68%
```

## Decision

Phase 8.93 promotes no profile.

```text
promoted profile = none
strategy default changes = none
paper BUY orchestration permission = false
paper execution rows created = 0
Phase 9 mode = shadow-first
```

## Rationale

No profile reached `CANDIDATE_FOR_PROMOTION`.

The best available rows either had too little sample depth, low confidence, low signal stability,
too much stop-first behavior, too much average-worst-return risk, or too much market-window
concentration. The `PROMISING_RESEARCH` rows are useful for future profile-version experiments, but
they are not strong enough to change paper strategy behavior.

The correct engineering choice is to preserve the strategy defaults and move to Phase 9 as
shadow-first orchestration. TerminalRunner should improve research throughput before any future
paper BUY promotion is considered.

## Completed Checklist

- [x] Confirm the Phase 8.92B archived folders are present.
- [x] Record each source run folder.
- [x] Record the primary report files used for review.
- [x] Confirm source DBs have zero `Order` rows.
- [x] Confirm source DBs have zero `Fill` rows.
- [x] Confirm source DBs have zero `Position` rows.
- [x] Review normalized profile summaries.
- [x] Review readiness statuses.
- [x] Review confidence and signal stability labels.
- [x] Check whether any profile reached `CANDIDATE_FOR_PROMOTION`.
- [x] Document why `PROMISING_RESEARCH` rows are not promotion-ready.
- [x] Record `promotedProfile = none`.
- [x] Record `strategyDefaultChanges = none`.
- [x] Record `paperBuyOrchestrationPermission = false`.
- [x] Keep `paper:execute` outside default automation.
- [x] Define the Phase 9 handoff as shadow-first TerminalRunner automation.
- [x] Update roadmap, decisions, structure, and Phase 9 planning docs.

## Phase 9 Handoff

Phase 9 should automate the shadow research loop:

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

Phase 9 should keep these surfaces manual or later-phase only:

```text
paper:execute
paper:sell
session:manage
exits:manage
```

Phase 9 must not:

- enable live trading,
- load wallets,
- sign transactions,
- submit transactions,
- treat simulated P/L as realized P/L,
- enable `paper:execute` by default,
- invent or promote strategy rules inside TerminalRunner.

Future profile tuning should create explicit new profile versions and return to a later promotion
review before becoming default paper strategy behavior.

## Validation

- `corepack pnpm format:check`: required after documentation updates.
- `corepack pnpm verify`: optional for docs-only implementation; required if runtime code changes
  are made.

Runtime code changes were not needed for Phase 8.93.
