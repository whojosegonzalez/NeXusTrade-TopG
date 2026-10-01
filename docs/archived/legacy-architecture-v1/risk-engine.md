# Risk Engine Architecture

Phase 5 adds the first deterministic risk engine. It consumes existing scanner output from `TokenRadar`, refreshes provider evidence, probes quotes, evaluates deterministic rules, writes `RiskAssessment` records, and updates `TokenRadar` only within risk-safe status bounds.

The risk engine is not a strategy engine, paper exchange, wallet runner, or trading executor.

## Runtime Command

```bash
pnpm risk:evaluate --once
```

Supported options:

```bash
pnpm risk:evaluate --session-id=session_123
pnpm risk:evaluate --status=DISCOVERED,WATCHING
pnpm risk:evaluate --since-hours=24
pnpm risk:evaluate --limit=50
pnpm risk:evaluate --concurrency=3
pnpm risk:evaluate --probe-sol=0.01
pnpm risk:evaluate --dry-run
```

Defaults:

- `statuses`: `DISCOVERED,WATCHING`
- `sinceHours`: `24`
- `limit`: `50`
- `concurrency`: `3`
- `probeAmountSol`: `0.01`
- `dryRun`: `false`

The command runs in `PAPER` mode only. It prints that wallet loading, transaction signing, and transaction submission are disabled.

## Session Policy

Risk evaluation consumes scanner output and never auto-creates sessions.

When `--session-id` is supplied:

- the session must exist
- the session must be `PAPER`

When `--session-id` is omitted:

- use the latest `PAPER` session with status `RUNNING` that has eligible TokenRadar candidates
- fail with a clear message if no eligible session exists

## Pipeline

Each risk evaluation run executes:

```text
SELECT CANDIDATES
REFRESH EVIDENCE
PROBE QUOTES
EVALUATE RULES
SCORE
WRITE RISK ASSESSMENT
UPDATE TOKENRADAR STATUS
LOG
```

The risk engine uses:

- `RiskCandidateSelector` for session and TokenRadar selection
- `RiskEvidenceRefreshService` for provider-backed enrichment and quote probing
- `RiskScoringService` and rule modules for deterministic checks
- `RiskAssessmentWriter` for persistence and TokenRadar status transitions
- `RiskRunner` and `risk-evaluate.ts` for CLI orchestration

## Candidate Selection

Default selection includes `DISCOVERED` and `WATCHING` TokenRadar rows discovered in the last 24 hours, capped at 50 candidates. Evaluation refreshes candidates with bounded concurrency, defaulting to 3 workers.

The repository supports:

- multi-status filtering
- `discoveredAtMs` lower and upper bounds
- existing session-scoped filtering

Phase 5 intentionally skips `REJECTED`, `APPROVED`, `BOUGHT`, `IGNORED`, and `ERROR` unless a later phase expands the policy.

## Evidence Refresh

Risk evaluation does not rely only on scanner-stored evidence. For each selected candidate, it refreshes evidence through `MarketDataService`.

The refresh path requests:

- DexScreener price and best pair
- Helius metadata and authority evidence
- Jupiter buy quote for `0.01 SOL`
- Jupiter sell quote using the buy quote output token amount, when available

If Jupiter is unavailable or quote probing fails, missing quote evidence is a warning, not a hard failure.

## Rules

Authority:

- mint authority present: `FAIL`
- freeze authority present: `FAIL`
- `mint_authority_absent_or_unknown`: `WARN`, not pass
- `freeze_authority_absent_or_unknown`: `WARN`, not pass

Liquidity:

- below `$2,000`: `FAIL`
- `$2,000` to `$10,000`: `WARN`
- at or above `$10,000`: pass
- missing pair or liquidity: `FAIL`

Pair age:

- below 5 minutes: `FAIL`
- 5 to 30 minutes: `WARN`
- above 30 minutes: pass
- missing pair creation time: `FAIL`

Price impact:

- above `15%`: `FAIL`
- `5%` to `15%`: `WARN`
- below `5%`: pass
- missing quote evidence: `WARN`

## Scoring

Scores start at 100 and deductions are applied:

- mint authority present: `-40`
- freeze authority present: `-40`
- liquidity below `$2,000`: `-40`
- liquidity `$2,000` to `$10,000`: `-15`
- pair age below 5 minutes: `-30`
- pair age 5 to 30 minutes: `-10`
- price impact above `15%`: `-30`
- price impact `5%` to `15%`: `-10`
- missing quote: `-10`
- missing or unknown authority evidence: `-10` per authority field

Score bands:

- `90-100`: `PASS`
- `70-89`: `WARN`
- `0-69`: `FAIL`

Rule severity is also honored. Warning evidence cannot become a pass merely because the numeric score remains high.

## TokenRadar Status Changes

Phase 5 only uses risk-safe status transitions:

- `FAIL` updates TokenRadar to `REJECTED`
- `PASS` updates TokenRadar to `WATCHING`
- `WARN` updates TokenRadar to `WATCHING` and appends a risk note
- `UNKNOWN` leaves TokenRadar status unchanged

Phase 5 never sets `APPROVED` or `BOUGHT`.

## Dry Run

Dry-run mode allows:

- candidate selection
- evidence refresh
- quote probes
- scoring
- risk logs

Dry-run mode skips:

- `RiskAssessment` writes
- `TokenRadar` updates

## Safety Boundary

Phase 5 may create:

- `RiskAssessment`
- `SystemLog`
- provider health rows through provider adapters

Phase 5 must not create:

- `StrategyDecision`
- `Order`
- `Fill`
- `Position`
- wallet activity
- transaction signing
- transaction submission

## Known Limitations

- Helius authority evidence currently cannot distinguish explicit disabled authority from unknown/missing provider data.
- Missing or unknown authority evidence remains `WARN`.
- Holder concentration is not evaluated yet.
- Quote probing depends on Jupiter being configured and available.
- Provider latency and public API rate limits can make larger runs slow; use `--limit` and `--concurrency` to tune evaluation pace.
- No strategy decisions are made from risk results in Phase 5.
