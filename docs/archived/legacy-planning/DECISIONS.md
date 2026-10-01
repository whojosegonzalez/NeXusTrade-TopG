# NeXusTrade Decision Log

This file records technical decisions that shape the project foundation.

Historical scope: this decision log is the primary record for Phases 1 through 8.93. Active Phase
9+ decisions continue in [DECISIONS_Phase9Plus.md](./DECISIONS_Phase9Plus.md).

## 2026-06-20 - Use Node.js 24 LTS

Decision: NeXusTrade targets Node.js 24 LTS.

Reason: The project is a fresh TypeScript build and should start on the current long-term runtime target.

Status: Accepted.

## 2026-06-20 - Use pnpm workspaces

Decision: The repository uses pnpm workspaces for the monorepo.

Reason: The project needs separate backend and shared packages now, with frontend added later without changing package-management strategy.

Status: Accepted.

## 2026-06-20 - Use strict TypeScript

Decision: TypeScript strict mode is enabled from the first commit-worthy foundation.

Reason: Provider adapters, risk decisions, simulated fills, and P/L accounting need precise contracts.

Status: Accepted.

## 2026-06-20 - Use explicit execution modes

Decision: NeXusTrade uses `PAPER`, `LIVE`, and `BACKTEST` execution modes.

Reason: The immediate goal is live-data paper trading, and accidental live trading must be impossible during early development.

Status: Accepted.

## 2026-06-20 - Keep live mode disabled during Phase 1

Decision: `LIVE` mode fails fast during Phase 1.

Reason: No wallet loading, signing, swap construction, or live-trading safety gates exist yet.

Status: Accepted.

## 2026-06-20 - Defer frontend initialization

Decision: The frontend folder is documented as a placeholder, but Vite is not initialized in Phase 1.

Reason: The paper-trading engine and backend records should exist before building the dashboard.

Status: Accepted.

## 2026-06-21 - Use SQLite with Drizzle and better-sqlite3

Decision: Phase 2 uses SQLite, Drizzle ORM, and `better-sqlite3` for local-first persistence.

Reason: The product needs inspectable local databases, deterministic migrations, and a synchronous embedded database driver that works well for a local trading engine.

Status: Accepted.

## 2026-06-21 - Physically separate mode databases

Decision: `PAPER`, `LIVE`, and `BACKTEST` resolve to separate SQLite files under `data/`.

Reason: Paper runs, future live trades, and future backtests must never share physical storage by accident.

Status: Accepted.

## 2026-06-21 - Store trading money in integer lamports

Decision: SOL balances, fees, and P/L values are stored as integer lamports.

Reason: Floating-point storage is not acceptable for final accounting fields.

Status: Accepted.

## 2026-06-21 - Store provider evidence as redacted JSON text

Decision: Provider evidence, raw quote snapshots, and contextual records are stored as JSON text after sensitive-field redaction.

Reason: Paper-trading behavior must be auditable, but logs and evidence fields must not become a hiding place for secrets.

Status: Accepted.

## 2026-06-21 - Put market-data vendors behind provider adapters

Decision: Jupiter, DexScreener, Helius, and future vendors are accessed through internal provider interfaces and return shared normalized market-data contracts.

Reason: Scanner, strategy, and paper execution code should not depend directly on vendor-specific response shapes.

Status: Accepted.

## 2026-06-21 - Use mint address as canonical token identity

Decision: Solana token mint address, also referred to as the token contract address, is the canonical token identifier across TokenRadar, risk assessments, strategy decisions, orders, fills through their related orders, and positions. Token symbol and name are display metadata only. DexScreener pair address is optional market context, not the primary token identity.

Reason: Token names and symbols are not unique, can change, and are unsafe as identifiers. Provider price, quote, metadata, and liquidity lookups can be performed from a real mint address, while pair addresses identify a specific liquidity venue/pair and may change as better pairs appear.

Status: Accepted.

## 2026-06-21 - Keep raw provider payload logging disabled by default

Decision: Provider adapters expose raw payloads only when `ENABLE_PROVIDER_RAW_PAYLOAD_LOGGING=true`.

Reason: Raw vendor responses can be useful while debugging, but provider context must not become a place where keys, headers, or unexpectedly sensitive data are stored.

Status: Accepted.

## 2026-06-21 - Keep Phase 4 scanner discovery paper-only

Decision: Scanner-only mode runs only in `PAPER`, writes candidates to `TokenRadar`, and does not create risk assessments, strategy decisions, orders, fills, positions, wallet activity, signing, or transaction submission.

Reason: Phase 4 is the discovery and normalization layer. Risk scoring, strategy decisions, simulated execution, and live-trading readiness need separate phases and separate safety gates.

Status: Accepted.

## 2026-06-21 - Use reusable paper sessions for scanner runs

Decision: The scanner auto-creates zero-balance paper sessions when no session ID is supplied and reuses only `PAPER` sessions in `CREATED` or `RUNNING` status.

Reason: Scanner-only runs need auditable logs and TokenRadar rows without implying trading capital or completed session lifecycle semantics before the SessionManager phase.

Status: Accepted.

## 2026-06-21 - Treat unknown authority evidence conservatively

Decision: Phase 5 risk evaluation treats `mint_authority_absent_or_unknown` and `freeze_authority_absent_or_unknown` as warning evidence, not as a confident pass.

Reason: The current Helius mapper cannot distinguish explicitly disabled mint/freeze authority from missing or unknown authority fields. The risk engine should not mark authority checks as passed until provider evidence can make that distinction.

Status: Accepted.

## 2026-06-21 - Risk evaluation consumes existing scanner sessions

Decision: Phase 5 risk evaluation does not auto-create sessions. If `--session-id` is omitted, it uses the latest `PAPER` session with status `RUNNING` that has TokenRadar candidates; if no such session exists, it fails with a clear message.

Reason: Risk evaluation consumes scanner output, and scanner output is session-scoped. Creating an empty risk session would hide missing scanner input and make risk runs harder to audit.

Status: Accepted.

## 2026-06-21 - Phase 6 strategy consumes active paper sessions only

Decision: Strategy evaluation must not auto-create sessions, and an explicit `--session-id` must identify a `PAPER` session with status `RUNNING`.

Reason: Phase 6 can mutate TokenRadar status and create StrategyDecision rows. Restricting it to active paper sessions prevents strategy decisions from changing completed historical sessions.

Status: Accepted.

## 2026-06-21 - Use PASS or eligible WARN for first strategy BUY eligibility

Decision: Phase 6 BUY eligibility uses `PASS_OR_ELIGIBLE_WARN`. `PASS` risk is eligible, and `WARN` risk is eligible only when all warning flags represent incomplete evidence such as `MISSING_QUOTE` or `MISSING_AUTHORITY_EVIDENCE`.

Reason: Current provider evidence can be incomplete even when a candidate has acceptable liquidity, age, and volume. Strategy should remain conservative by blocking active danger flags while still allowing incomplete-evidence warnings to be evaluated.

Status: Accepted.

## 2026-06-21 - Keep duplicate BUY protection application-level in Phase 6

Decision: Phase 6 prevents duplicate BUY decisions per session and mint by checking `StrategyDecisionRepository.listDecisionsForMint()` before writing a new BUY decision. It does not add a database unique constraint yet.

Reason: The one-shot local strategy runner does not need a migration for first-pass duplicate protection. A later phase can add a database constraint if concurrent strategy execution becomes realistic.

Status: Accepted.

## 2026-06-21 - Use a separate strategy score

Decision: Phase 6 uses a separate 0-100 strategy score instead of reusing the Phase 5 risk score.

Reason: Risk score measures safety. Strategy score measures attractiveness for future paper entry, using risk eligibility plus liquidity, volume, age, and price-impact facts.

Status: Accepted.

## 2026-06-21 - Phase 6 creates decisions, not execution records

Decision: Phase 6 may create `StrategyDecision` and `SystemLog` rows and may update TokenRadar within strategy-safe bounds, but it must not create orders, fills, positions, snapshots, wallet activity, signing, or transaction submission.

Reason: Paper execution belongs to Phase 7. Keeping Phase 6 decision-only preserves a clean audit boundary between approval and simulated execution.

Status: Accepted.

## 2026-06-21 - Phase 7 PaperExchange executes paper BUYs only

Decision: Phase 7 consumes `StrategyDecision(BUY)` plus matching `TokenRadar(APPROVED)` rows and may create `Order`, `Fill`, and `Position` records, decrement paper cash, and update TokenRadar to `BOUGHT`. It does not simulate SELLs, close positions, create snapshots, load wallets, sign transactions, or submit transactions.

Reason: Opening positions is the smallest useful execution boundary after strategy approval. SELL simulation, realized P/L, unrealized P/L, and session target control need their own focused phases.

Status: Accepted.

## 2026-06-21 - Use existing EXECUTION log scope for PaperExchange

Decision: Phase 7 writes paper execution logs with `SystemLog.scope = EXECUTION` instead of adding a new `PAPER_EXECUTION` enum value.

Reason: The current schema already has an execution scope. Avoiding an enum migration keeps Phase 7 focused on paper BUY behavior.

Status: Accepted.

## 2026-06-21 - Keep Phase 7 duplicate position protection application-level

Decision: Phase 7 prevents duplicate open positions per session and mint through `PositionRepository.getOpenPositionByMint()` before writing fills or cash updates. It does not add a database unique constraint yet.

Reason: The one-shot local paper runner does not need concurrent execution hardening yet. A later phase can add a DB constraint or transaction wrapper if multiple execution workers become realistic.

Status: Accepted.

## 2026-06-21 - Phase 7.5 requires explicit SELL triggers

Decision: `pnpm paper:sell --once` fails unless the operator supplies `--sell-all` or `--mint=<mint>`.

Reason: SELL execution closes positions and mutates cash/P&L. The first SELL engine should require explicit intent and must not silently liquidate positions.

Status: Accepted.

## 2026-06-21 - Keep Phase 7.5 migration-free

Decision: Phase 7.5 stores SELL audit details in existing fields and JSON payloads instead of adding first-class SELL columns.

Reason: Existing `Order`, `Fill`, and `Position` fields can represent first-pass SELL execution. Dedicated columns can be added later if reporting needs justify a migration.

Status: Accepted.

## 2026-06-21 - Defer Phase 7.5 snapshots and session governance

Decision: Phase 7.5 closes positions and stores realized P/L, but it does not create position snapshots, equity snapshots, target-profit exits, stop-loss exits, or session completion behavior.

Reason: Those concerns belong to Phase 8 SessionManager. Keeping PaperExchange focused preserves the execution boundary.

Status: Accepted.

## 2026-06-21 - Phase 8 gates BUYs through terminationReason

Decision: Phase 8 SessionManager uses existing session status values and gates future paper BUY activity by setting `Session.terminationReason` to `TARGET_REACHED` or `MAX_DRAWDOWN` while keeping `Session.status = RUNNING`.

Reason: The current schema already has termination reasons for target and drawdown, but it does not have `TARGET_REACHED` or `DRAWDOWN_REACHED` session statuses. Using `terminationReason` avoids a migration, lets snapshots continue for running sessions, and keeps manual paper SELL available until Phase 8.5 adds automatic exits.

Status: Accepted.

## 2026-06-22 - Keep Phase 8.5 exits paper-only and session-level

Decision: Phase 8.5 ExitManager reacts only to session-level `TARGET_REACHED` and `MAX_DRAWDOWN`
termination reasons, and only in `PAPER` mode. It may perform explicit sell-all automation, but it
does not add stop-loss, trailing-stop, max-hold, liquidity-collapse, partial, strategy-driven, or
live exits.

Reason: Phase 8.5 should bridge SessionManager governance to the existing PaperSell service layer
without expanding into position-level risk management or live execution.

Status: Accepted.

## 2026-06-22 - Make automated exit actions explicit

Decision: `pnpm exits:manage --once` defaults to observe-only. Automated liquidation requires an
explicit action such as `--target-action=sell-all` or `--drawdown-action=sell-all`.

Reason: SELL execution mutates orders, fills, positions, cash, realized P/L, and TokenRadar status.
The first automated exit engine must make mutation intent visible at the command boundary.

Status: Accepted.

## 2026-06-22 - Keep Phase 8.5 session completion optional

Decision: Phase 8.5 may mark a gated `PAPER` + `RUNNING` session `COMPLETED` only when
`--complete-session-on-exit=true` is supplied and all open positions are closed.

Reason: Completion changes session lifecycle semantics. Keeping it optional preserves the ability to
inspect, snapshot, or manually intervene after automated exits.

Status: Accepted.

## 2026-06-22 - Keep Phase 8.6 stabilization-only

Decision: Phase 8.6 is an operational stabilization phase. It may archive/reset local paper data,
run validation commands, document findings, and create Phase 9 planning inputs, but it must not add
new trading rules, provider behavior, schemas, execution models, or exit strategies.

Reason: The project already has the full paper pipeline through automated session-level exits.
Before adding TerminalRunner orchestration, the existing pipeline needs a clean baseline and known
handoff state rather than more trading behavior.

Status: Accepted.

## 2026-07-06 - Keep Phase 9 paper BUY disabled until entry gates improve

Decision: Phase 9 must remain shadow-first by default. It must not enable `paper:execute` as part
of an automated loop until a later calibration phase shows a stronger entry/exit profile than raw
Phase 8.91 BUY decisions.

Reason: The final three-run Phase 8.91 analysis showed raw BUY decisions with only a 40.00% +10%
hit rate, -46.77% average worst observed return, and 70.00% drawdown-first-at-10% behavior. That is
not enough evidence to automate paper BUY execution, even in paper mode.

Status: Accepted.

## 2026-07-06 - Make Phase 8.92 shadow-only entry-gate research

Decision: Phase 8.92 will add a read-only `shadow:entries` workbench that compares calibrated entry
profiles, confirmation rules, duplicate-attention behavior, early-drawdown filters, and
target/stop/max-hold outcomes. It must not create orders, fills, positions, cash mutations,
TokenRadar status mutations, wallet activity, signing, or transaction submission.

Reason: Phase 8.91 showed that the system can find moving tokens, but raw strategy BUY timing is
too noisy. A shadow-only gate lets us test entry behavior before changing production paper
execution.

Status: Accepted.

## 2026-07-06 - Treat missing quotes as visible evidence, not a hard entry rejection

Decision: Phase 8.92 should report quote availability and missing-quote buckets, but it should not
make missing Jupiter quotes a hard rejection rule by default.

Reason: Phase 8.91 quote-available candidates were not clearly better than missing-quote
candidates, and average Jupiter rate limiting remained high. Quote confidence still matters for
execution readiness, but current provider availability is too noisy to use as a standalone quality
filter.

Status: Accepted.

## 2026-07-06 - Treat duplicate attention as a research signal first

Decision: Phase 8.92 may evaluate duplicate or repeated-attention candidates as a separate profile,
but duplicate attention must not automatically promote candidates to paper BUY.

Reason: Phase 8.91 `duplicate_buy_blocked` outcomes showed better +10% hit rate and milder
drawdown than not-duplicate outcomes, but the sample is still small and can be dominated by one or
two mints.

Status: Accepted.

## 2026-07-08 - Add Phase 8.92B before Phase 9

Decision: Add Phase 8.92B as a read-only refinement phase before Phase 9. Phase 8.92B should fix
fresh-run baseline wording, separate normalized profile summaries from experimental diagnostics,
add focused WATCH-first, duplicate-attention, score 65-79, high-score, and hybrid research profiles,
make repeated attention first-class, and make readiness reasons more explicit.

Reason: Four fresh Phase 8.92 tests were mechanically valid and found real signal, but did not
produce a promotion-ready entry profile. Raw BUY remained too exposed, WATCH and duplicate-attention
looked promising but sample-limited, and score 65-69 performed better than lower score buckets. The
reporting workbench should become clearer before TerminalRunner planning consumes it.

Status: Accepted.

## 2026-07-08 - Separate strategy promotion into Phase 8.93

Decision: Add Phase 8.93 as a planned Strategy Promotion review before Phase 9. Phase 8.93 should
consume Phase 8.92B output and decide whether any research profile can become real paper strategy
behavior. Phase 9 should not invent or promote strategy rules itself.

Reason: The project now has a disciplined research flow: measure behavior, experiment in shadow,
refine the workbench, promote only if evidence is strong, then orchestrate. Keeping promotion
separate prevents TerminalRunner from becoming both a scheduler and a strategy decision process.

Status: Accepted.

## 2026-07-08 - Add confidence and stability to readiness

Decision: Phase 8.92B readiness should report confidence and signal stability separately from
status. It should also limit both mint concentration and market-window concentration before a
profile can become `CANDIDATE_FOR_PROMOTION`.

Reason: A profile can look promising because of one mint, one market window, or too small a sample.
Separate confidence and signal-stability labels make those limitations visible without weakening the
main readiness status.

Status: Accepted.

## 2026-07-08 - Version shadow entry profiles

Decision: Phase 8.92B profiles should include explicit immutable versions. Reports should include
`profileId`, `profileVersion`, and `profileKey`, such as `P009`, `v1`, and `P009@v1`. Existing
profiles should start at `v1`. If profile behavior changes later, create a new version rather than
silently changing the old one.

Reason: Archived research reports must remain comparable over time. A future tuned `P009` should
not make old `P009` results ambiguous.

Status: Accepted.

## 2026-07-08 - Keep Phase 9 shadow-first after fresh Phase 8.92 tests

Decision: Phase 9 remains shadow-first by default. Fresh Phase 8.92 results must not enable
`paper:execute` or automated paper BUY orchestration.

Reason: The fresh Phase 8.92 batch showed `BUY` with 60.00% +10% hit rate but -46.98% average worst
observed return and 50.00% -10% drawdown-first behavior. WATCH and duplicate-attention signals were
better risk-adjusted, but samples were too small and portfolio-level outcomes were far below the
25% session goal.

Status: Accepted.

## 2026-07-09 - Complete Phase 8.93 with no strategy promotion

Decision: Phase 8.93 completed the Strategy Promotion review after three fresh Phase 8.92B
validation runs. No profile is promoted into paper strategy defaults. Existing strategy defaults
remain unchanged, and `paper:execute` remains outside default automation.

Reason: The Phase 8.92B batch confirmed that the research framework is working, but no profile
reached `CANDIDATE_FOR_PROMOTION`. The only `PROMISING_RESEARCH` results were low-confidence and
low-stability, with drawdown and market-window risk still too high for promotion.

Status: Accepted.

## 2026-07-09 - Make Phase 9 TerminalRunner shadow-first automation

Decision: Phase 9 should build TerminalRunner as a shadow-first automation layer for scanner,
risk, strategy, shadow observation, shadow exits, shadow entries, watchlist returns, analytics, and
calibration reports. TerminalRunner must not invent strategy rules or enable paper BUY by default.

Reason: The project needs more consistent research data with less manual command work before a
paper BUY promotion is justified. Keeping TerminalRunner focused on orchestration preserves the
separation between research, promotion, and execution.

Status: Accepted.
