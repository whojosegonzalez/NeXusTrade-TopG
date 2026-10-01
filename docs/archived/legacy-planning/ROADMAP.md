# NeXusTrade Roadmap

NeXusTrade is a local-first Solana meme-coin trading research and automation project. The first major milestone is live-data paper trading with real market data, simulated fills, complete records, and strict live-trading safeguards.

Historical scope: this roadmap is the primary record for Phases 1 through 8.93. Active Phase 9+
planning continues in [ROADMAP_Phase9Plus.md](./ROADMAP_Phase9Plus.md).

## North Star

- Discover Solana tokens worth monitoring.
- Evaluate token risk before simulated or live entry.
- Paper-buy and paper-sell using live quotes and realistic cost assumptions.
- Track scans, decisions, orders, fills, positions, fees, snapshots, logs, provider health, and P/L.
- Stop opening new positions when a configured run-level or day-level target is reached.
- Keep `PAPER`, `LIVE`, and future `BACKTEST` data physically separated.
- Keep providers, execution methods, and strategies replaceable behind interfaces.

## Phases

1. Establish the new foundation. Complete.
2. Build the local database layer. Complete.
3. Build provider adapters for live market data. Complete.
4. Build scanner-only mode. Complete.
5. Build the first risk engine. Complete.
6. Build the first strategy engine. Complete.
7. Build PaperExchange BUY execution. Complete.
   7.5. Build PaperExchange SELL execution and realized P/L. Complete.
8. Build SessionManager, snapshots, target/drawdown tracking, and BUY gating. Complete.
   8.5. Build automated paper exits from SessionManager signals. Complete.
   8.6. Stabilize, reset paper data, validate clean pipeline, and prepare Phase 9. Complete.
   8.7. Add strategy calibration, analytics reporting, and watchlist forward returns. Complete.
   8.8. Build the strategy calibration workbench and threshold evidence reports. Complete.
   8.9. Build shadow entry/exit simulation and high-frequency buy candidate monitoring. Complete.
   8.91. Build cross-run shadow calibration and entry confirmation research. Complete.
   8.92. Build calibrated shadow entry gates before Phase 9 orchestration. Complete.
   8.92B. Refine fresh shadow entry-gate reports and research profiles before Phase 9. Complete.
   8.93. Review strategy promotion evidence and leave defaults unchanged. Complete.
9. Build the shadow-first terminal runner.
10. Build the local dashboard.
11. Harden for live-trading readiness.
12. Run tiny live-trade experiments.
13. Add paid providers and advanced strategies when justified by measured needs.

## Phase 1 Outcome

Phase 1 produces a clean, safe, TypeScript-first monorepo that can start the backend in paper mode, reject live mode, run tests, and document every created file.

## Phase 4 Outcome

Phase 4 produces a paper-only scanner runner that discovers token candidates, deduplicates them by mint address, enriches them with provider-backed market data, normalizes them into `TokenRadar`, and keeps the trading boundary closed. The scanner writes `SystemLog` and provider health records, but it does not create risk assessments, strategy decisions, orders, fills, positions, wallet activity, transaction signing, or transaction submission.

## Phase 5 Outcome

Phase 5 produces a paper-only deterministic risk engine that consumes scanner-created `TokenRadar` candidates, refreshes market and authority evidence, probes Jupiter quotes when available, scores deterministic risk rules, writes `RiskAssessment` records, and updates TokenRadar only to risk-safe statuses. It still does not create strategy decisions, orders, fills, positions, wallet activity, transaction signing, or transaction submission.

## Phase 6 Outcome

Phase 6 produces a paper-only rule-based strategy engine that consumes `WATCHING` TokenRadar candidates with latest `RiskAssessment` records, applies `PASS_OR_ELIGIBLE_WARN` BUY eligibility, scores first-pass attractiveness rules, writes `StrategyDecision` records, prevents duplicate BUY decisions per session and mint, and updates TokenRadar to `APPROVED` only after stored BUY decisions. It still does not create orders, fills, positions, wallet activity, transaction signing, or transaction submission.

## Phase 7 Outcome

Phase 7 produces a paper-only BUY execution engine that consumes `StrategyDecision(BUY)` plus matching `TokenRadar(APPROVED)` candidates, validates cash and duplicate open positions, creates simulated `Order`, `Fill`, and `Position` records, decrements `Session.currentCashLamports`, and updates TokenRadar to `BOUGHT` only after execution records are stored. It still does not create SELL fills, close positions, create snapshots, load wallets, sign transactions, or submit transactions.

## Phase 7.5 Outcome

Phase 7.5 produces a paper-only SELL execution engine that requires an explicit `--sell-all` or `--mint` trigger, selects open positions, refreshes quote or price evidence, creates `Order(SELL)` and SELL fill records, closes positions, restores session cash using net proceeds, stores realized P/L, and returns TokenRadar to `WATCHING`. It still does not implement target-profit automation, stop-loss automation, session completion, snapshots, wallet activity, signing, or transaction submission.

## Phase 8 Outcome

Phase 8 produces a paper-only SessionManager that creates equity and position snapshots, calculates unrealized P/L, tracks target and drawdown progress, updates session unrealized P/L, and gates future paper BUY activity through `Session.terminationReason`. It keeps sessions `RUNNING`, preserves manual SELL availability, avoids automatic liquidation, and defers automated exits to Phase 8.5.

## Phase 8.5 Outcome

Phase 8.5 adds a paper-only ExitManager that consumes Phase 8 `Session.terminationReason` signals
and can perform explicit session-level sell-all exits for `TARGET_REACHED` and `MAX_DRAWDOWN`.
Observe-only is the default, session completion is optional, and position-level exits such as
stop-losses, trailing stops, max-hold exits, liquidity-collapse exits, partial exits, and live
execution remain deferred.

## Phase 8.6 Outcome

Phase 8.6 stabilizes the completed paper pipeline before TerminalRunner work. It commits completed
work, archives and resets the local paper database, validates schema and repository behavior, runs a
clean real-market paper validation when provider data is available, documents actual outcomes, and
creates the Phase 9 planning inputs. It adds no new trading logic.

## Phase 8.7 Outcome

Phase 8.7 adds paper-only strategy calibration and research instrumentation before TerminalRunner.
Strategy BUY and WATCH score thresholds are configurable while preserving conservative defaults and
existing BUY eligibility gates. Analytics reporting now summarizes funnels, score buckets, near
misses, missed opportunities, and provider health. Watchlist forward-return tracking persists
3-minute through 12-hour observations for WATCH/SKIP/BUY strategy decisions so future planning can
measure whether rejected or watched candidates later moved profitably. It adds no wallet activity,
signing, transaction submission, live execution, or automatic exit rules.

## Phase 8.8 Outcome

Phase 8.8 builds a paper-only, read-only strategy calibration workbench before TerminalRunner. It
analyzes stored strategy score factors, watchlist forward returns, risk evidence, TokenRadar market
fields, and provider health to explain individual scores, calculate observed-horizon MFE/MAE,
simulate target-hit behavior for +10%, +25%, and +39%, identify missed opportunities and false
positive BUYs, quantify Jupiter and missing-evidence effects, and recommend threshold or weight
changes without automatically changing trading behavior. It adds no wallet activity, signing,
transaction submission, live execution, orders, fills, positions, or automated exits.

## Phase 8.9 Outcome

Phase 8.9 adds paper-only shadow entry/exit simulation and high-frequency monitoring for BUY and
explicit shadow-score candidates. It schedules and observes tighter post-decision price horizons,
simulates target/stop/max-hold exits, reports run-level shadow portfolio outcomes against goals such
as `1 SOL -> 1.25 SOL`, and prepares Phase 9 to orchestrate evidence-driven entries and exits. It
adds no wallet activity, signing, transaction submission, live swaps, real orders, fills, positions,
or automatic paper execution in the first pass.

## Phase 8.91 Outcome

Phase 8.91 adds a paper-only, read-only cross-run calibration layer for Phase 8.9 shadow tests. It
compares archived shadow runs, separates decision-level from unique-mint outcomes, simulates
target/stop/max-hold scenario grids, evaluates delayed entry confirmation rules, analyzes candidate
filters and provider effects, and recommends the next test batch before TerminalRunner work. It adds
no wallet activity, signing, transaction submission, live swaps, orders, fills, positions, or
automatic paper execution.

## Phase 8.92 Outcome

Phase 8.92 builds a paper-only, shadow-only calibrated entry-gate experimentation workbench before
Phase 9. It uses Phase 8.91 evidence to compare raw BUY behavior against score-band,
duplicate-attention, confirmation, early-drawdown, recovery-after-drawdown, first-entry,
latest-entry, target/stop, and max-hold profiles. It does not enable paper execution by default. Its
job is to decide whether there is a safer, repeatable entry profile worth handing to TerminalRunner
later.

## Phase 8.92B Outcome

Phase 8.92B refines the shadow entry-gate workbench after four fresh Phase 8.92 validation runs. It
fixes fresh-run baseline wording, separates normalized profile summaries from experimental
diagnostics, adds focused WATCH-first, duplicate-attention, score 65-79, high-score, and hybrid
research profiles, promotes repeated attention into a strength-based research feature, and tightens
readiness output with confidence, signal stability, market-window concentration, and profile
versioning before Phase 9. It remains paper-only and read-only, does not enable paper BUY, and hands
promotion decisions to Phase 8.93 rather than TerminalRunner.

## Phase 8.93 Outcome

Phase 8.93 reviewed the Strategy Promotion evidence after three fresh Phase 8.92B validation runs.
No profile reached `CANDIDATE_FOR_PROMOTION`; the only `PROMISING_RESEARCH` rows were
low-confidence and low-stability, and the best normalized profiles still carried too much drawdown
risk for paper BUY promotion. Strategy defaults remain unchanged, no profile version is promoted,
and `paper:execute` stays outside default automation.

## Phase 9 Direction

Phase 9 should build TerminalRunner as a shadow-first automation layer for research throughput. Its
first job should automate scanner, risk, strategy, shadow observation, shadow exit analysis,
shadow-entry/profile reports, watchlist returns, analytics, and calibration reports. It should not
invent new strategy rules, promote profiles, enable paper BUY by default, load wallets, sign
transactions, submit transactions, or treat shadow P/L as realized P/L. Future Phase 9.x work can
use the larger automated dataset to tune profile versions and prepare another explicit promotion
review.

Detailed checklists:

- [NeXusTrade-Phase-1-Detailed-Checklist.md](./NeXusTrade-Phase-1-Detailed-Checklist.md)
- [NeXusTrade-Phase-2-Detailed-Checklist.md](./NeXusTrade-Phase-2-Detailed-Checklist.md)
- [NeXusTrade-Phase-3-Detailed-Checklist.md](./NeXusTrade-Phase-3-Detailed-Checklist.md)
- [NeXusTrade-Phase-4-Detailed-Checklist.md](./NeXusTrade-Phase-4-Detailed-Checklist.md)
- [NeXusTrade-Phase-5-Detailed-Checklist.md](./NeXusTrade-Phase-5-Detailed-Checklist.md)
- [NeXusTrade-Phase-6-Detailed-Checklist.md](./NeXusTrade-Phase-6-Detailed-Checklist.md)
- [NeXusTrade-Phase-7-Detailed-Checklist.md](./NeXusTrade-Phase-7-Detailed-Checklist.md)
- [NeXusTrade-Phase-7.5-Detailed-Checklist.md](./NeXusTrade-Phase-7.5-Detailed-Checklist.md)
- [NeXusTrade-Phase-8-Detailed-Checklist.md](./NeXusTrade-Phase-8-Detailed-Checklist.md)
- [NeXusTrade-Phase-8.5-Detailed-Checklist.md](./NeXusTrade-Phase-8.5-Detailed-Checklist.md)
- [NeXusTrade-Phase-8.6-Detailed-Checklist.md](./NeXusTrade-Phase-8.6-Detailed-Checklist.md)
- [NeXusTrade-Phase-8.7-Detailed-Checklist.md](./NeXusTrade-Phase-8.7-Detailed-Checklist.md)
- [NeXusTrade-Phase-8.8-Detailed-Checklist.md](./NeXusTrade-Phase-8.8-Detailed-Checklist.md)
- [NeXusTrade-Phase-8.9-Detailed-Checklist.md](./NeXusTrade-Phase-8.9-Detailed-Checklist.md)
- [NeXusTrade-Phase-8.91-Detailed-Checklist.md](./NeXusTrade-Phase-8.91-Detailed-Checklist.md)
- [NeXusTrade-Phase-8.92-Detailed-Checklist.md](./NeXusTrade-Phase-8.92-Detailed-Checklist.md)
- [NeXusTrade-Phase-8.92B-Detailed-Checklist.md](./NeXusTrade-Phase-8.92B-Detailed-Checklist.md)
- [NeXusTrade-Phase-8.93-Detailed-Checklist.md](./NeXusTrade-Phase-8.93-Detailed-Checklist.md)
- [Phase-9-Planning-Inputs.md](./Phase-9-Planning-Inputs.md)

Architecture notes:

- [architecture/database.md](./architecture/database.md)
- [Provider-Architecture.md](./Provider-Architecture.md)
- [architecture/scanner.md](./architecture/scanner.md)
- [architecture/risk-engine.md](./architecture/risk-engine.md)
- [architecture/strategy-engine.md](./architecture/strategy-engine.md)
- [architecture/paper-exchange.md](./architecture/paper-exchange.md)
- [architecture/paper-sell-engine.md](./architecture/paper-sell-engine.md)
- [architecture/session-manager.md](./architecture/session-manager.md)
- [architecture/exit-manager.md](./architecture/exit-manager.md)
