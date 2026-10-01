# Strategy Engine Architecture

Phase 6 adds the first rule-based strategy engine. It consumes existing scanner and risk output, evaluates first-pass attractiveness rules, writes `StrategyDecision` records, and updates TokenRadar only within strategy-safe bounds.

The strategy engine is not an exchange, paper fill simulator, wallet runner, or trading executor.

## Runtime Command

```bash
pnpm strategy:evaluate --once
```

Supported options:

```bash
pnpm strategy:evaluate --dry-run
pnpm strategy:evaluate --session-id=session_123
pnpm strategy:evaluate --status=WATCHING
pnpm strategy:evaluate --since-hours=24
pnpm strategy:evaluate --limit=50
pnpm strategy:evaluate --max-buy-decisions=5
pnpm strategy:evaluate --strategy-name=phase6_first_pass
pnpm strategy:evaluate --min-liquidity-usd=10000
pnpm strategy:evaluate --min-volume-1h-usd=10000
pnpm strategy:evaluate --max-price-impact-pct=5
pnpm strategy:evaluate --min-pair-age-minutes=30
```

Defaults:

- `status`: `WATCHING`
- `riskPolicy`: `PASS_OR_ELIGIBLE_WARN`
- `sinceHours`: `24`
- `limit`: `50`
- `maxBuyDecisions`: `5`
- `minLiquidityUsd`: `10000`
- `minVolume1hUsd`: `10000`
- `maxPriceImpactPct`: `5`
- `minPairAgeMinutes`: `30`
- `strategyName`: `phase6_first_pass`
- `dryRun`: `false`

The command runs in `PAPER` mode only. It prints that wallet loading, transaction signing, and transaction submission are disabled.

## Session Policy

Strategy evaluation consumes scanner and risk output. It never auto-creates sessions.

When `--session-id` is supplied:

- the session must exist
- the session must be `PAPER`
- the session must be `RUNNING`

When `--session-id` is omitted:

- use the latest `PAPER` session with status `RUNNING` that has eligible strategy candidates
- fail with a clear message if no eligible session exists

## Pipeline

Each strategy evaluation run executes:

```text
SELECT STRATEGY CANDIDATES
LOAD LATEST RISK ASSESSMENT
CHECK BUY ELIGIBILITY
APPLY STRATEGY RULES
SCORE
WRITE STRATEGY DECISION
UPDATE TOKENRADAR STATUS
LOG
```

The strategy engine uses:

- `StrategyCandidateSelector` for session, TokenRadar, latest risk, and prior decision selection
- rule modules for risk eligibility, liquidity, volume, pair age, price impact, and duplicate BUY checks
- `StrategyScoringService` for scoring and decision overrides
- `StrategyEvaluationService` for persistence, TokenRadar updates, and logs
- `StrategyRunner` and `strategy-evaluate.ts` for CLI orchestration

## Candidate Selection

Default selection includes `WATCHING` TokenRadar rows discovered in the last 24 hours, capped at 50 candidates.

Each selected candidate must have a latest `RiskAssessment`. Candidates without risk output are excluded because Phase 6 should only make strategy decisions after Phase 5 has evaluated risk.

## BUY Eligibility

Phase 6 uses `PASS_OR_ELIGIBLE_WARN`.

Eligible:

- `RiskAssessment.result = PASS`
- `RiskAssessment.result = WARN` where all flags are incomplete-evidence flags

Eligible WARN flags:

- `MISSING_QUOTE`
- `MISSING_AUTHORITY_EVIDENCE`

Ineligible risk flags block BUY:

- `MINT_AUTHORITY_PRESENT`
- `FREEZE_AUTHORITY_PRESENT`
- `LOW_LIQUIDITY`
- `MEDIUM_LIQUIDITY`
- `HIGH_PRICE_IMPACT`
- `MEDIUM_PRICE_IMPACT`
- `PAIR_TOO_NEW`
- `PAIR_YOUNG`
- `MISSING_PAIR`
- `MISSING_LIQUIDITY`

`FAIL` and `UNKNOWN` are never BUY-eligible.

## Strategy Score

Strategy score starts at 0 and adds deterministic points:

- risk PASS: `+40`
- risk WARN with eligible flags: `+20`
- liquidity above `$50,000`: `+20`
- liquidity above `$25,000`: `+10`
- 1h volume above `$50,000`: `+20`
- 1h volume above `$10,000`: `+10`
- pair age above 24h: `+10`
- pair age 30m to 24h: `+5`
- price impact below `2%`: `+10`
- price impact `2%` to `5%`: `+5`

Score is clamped to `0-100`.

Decision bands:

- `90-100`: `BUY`
- `70-89`: `WATCH`
- `0-69`: `SKIP`

Overrides:

- BUY score but ineligible risk or failed minimum rules becomes `SKIP`
- BUY score but duplicate BUY history becomes `WATCH`
- BUY score but max BUY cap is reached becomes `WATCH`

## TokenRadar Status Changes

Phase 6 only uses strategy-safe status transitions:

- `BUY` writes `StrategyDecision` then updates TokenRadar to `APPROVED`
- `WATCH` writes `StrategyDecision` and keeps TokenRadar `WATCHING`
- `SKIP` writes `StrategyDecision` and leaves TokenRadar unchanged

Phase 6 never sets `BOUGHT` and does not use risk-owned `REJECTED`.

## Duplicate BUY Prevention

Phase 6 prevents duplicate BUY decisions per session and mint through `StrategyDecisionRepository.listDecisionsForMint()`.

This protection is application-level in Phase 6. There is no database unique constraint yet.

## Dry Run

Dry-run mode allows:

- candidate selection
- latest risk lookup
- strategy scoring
- decision summary
- strategy logs

Dry-run mode skips:

- `StrategyDecision` writes
- `TokenRadar` updates

## Safety Boundary

Phase 6 may create:

- `StrategyDecision`
- `SystemLog`

Phase 6 may update:

- `TokenRadar`

Phase 6 must not create:

- `Order`
- `Fill`
- `Position`
- `PositionSnapshot`
- `EquitySnapshot`
- wallet activity
- transaction signing
- transaction submission

## Known Limitations

- Strategy scoring is intentionally simple.
- Price impact is read from compact Phase 5 `rawProviderDataJson` for now.
- Duplicate BUY prevention is not enforced by a database unique constraint yet.
- Eligible WARN candidates may still score as WATCH or SKIP.
- The engine does not rank across already-approved candidates beyond the per-run BUY cap.
- No strategy decision triggers execution in Phase 6.
