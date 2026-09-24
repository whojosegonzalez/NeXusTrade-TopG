# NeXusTrade Phase 6 Detailed Checklist

## First Strategy Engine - Enterprise / Codex Implementation Edition

_Last updated: June 2026_

---

# 1. Phase 6 Goal

Phase 6 builds the first transparent rule-based strategy engine for NeXusTrade.

The strategy engine consumes:

```text
TokenRadar
+
Latest RiskAssessment
```

and produces:

```text
StrategyDecision
```

The strategy engine answers one question:

> Given the current scanner and risk data, is this token worth approving for future paper execution?

Phase 6 introduces decision-making, but it still does **not** execute trades.

---

# 1.1 Locked Pre-Implementation Clarifications

These clarifications are the Phase 6 source of truth before coding:

```text
Phase 6 source of truth:
PASS_OR_ELIGIBLE_WARN

Explicit session rule:
--session-id must be PAPER + RUNNING

Duplicate BUY protection:
application-level using listDecisionsForMint()
no DB unique constraint yet

Price impact:
read from compact risk rawProviderDataJson for now
no dedicated column yet

Expected real output:
WATCH/SKIP may dominate
few or zero BUY decisions is acceptable
```

No DB migration is planned for Phase 6. The existing `StrategyDecision` table is enough because Phase 6 stores the decision, score, reason, and compact input snapshot.

---

# 2. Primary Outcome

By the end of Phase 6, NeXusTrade should be able to run:

```bash
pnpm strategy:evaluate --once
```

and:

- Select eligible `TokenRadar` candidates.
- Load the latest `RiskAssessment` for each candidate.
- Evaluate first-pass strategy rules.
- Generate a 0-100 strategy score.
- Create `StrategyDecision` records.
- Update `TokenRadar` only within strategy-safe bounds.
- Prevent duplicate `BUY` decisions for the same session and mint.
- Keep execution boundaries closed.

---

# 3. Phase 6 Pipeline

```text
SELECT STRATEGY CANDIDATES
-> LOAD LATEST RISK ASSESSMENT
-> CHECK BUY ELIGIBILITY
-> APPLY STRATEGY RULES
-> CALCULATE STRATEGY SCORE
-> CREATE STRATEGY DECISION
-> UPDATE TOKENRADAR STATUS
-> LOG SUMMARY
```

---

# 4. Scope Boundaries

## In Scope

Phase 6 may:

- Read `TokenRadar`.
- Read latest `RiskAssessment`.
- Read existing `StrategyDecision` history.
- Create `StrategyDecision` records.
- Update `TokenRadar` to `APPROVED` after a stored `BUY` decision.
- Keep `WATCHING` tokens in `WATCHING`.
- Write `SystemLog` records.
- Run in `PAPER` mode only.
- Support dry-run mode.

## Out of Scope

Phase 6 must not:

- Create `Order` records.
- Create `Fill` records.
- Create `Position` records.
- Simulate buys.
- Simulate sells.
- Load wallets.
- Sign transactions.
- Submit transactions.
- Touch `LIVE` mode.
- Manage P/L targets.
- Manage open positions.
- Build the dashboard.

Those belong to later phases.

---

# 5. Definition of Done

Phase 6 is complete when:

- [x] `strategy:evaluate` root script exists.
- [x] `strategy:evaluate` backend script exists.
- [x] CLI entry point exists at `backend/src/scripts/strategy-evaluate.ts`.
- [x] `StrategyConfig.ts` exists.
- [x] Strategy CLI parsing exists.
- [x] Strategy runtime validation exists.
- [x] `StrategyCandidateSelector` exists.
- [x] Candidate selection defaults to `WATCHING`.
- [x] Candidate selection supports `--session-id`.
- [x] No-session behavior selects the latest `PAPER` + `RUNNING` session with eligible strategy candidates.
- [x] No-session behavior fails clearly when no eligible session exists.
- [x] Strategy selection supports recency filtering.
- [x] Strategy selection supports limit.
- [x] `StrategyEvaluationService` exists.
- [x] `StrategyScoringService` exists.
- [x] First-pass rule-based strategy exists.
- [x] Strategy score uses 0-100 range.
- [x] `BUY`, `WATCH`, and `SKIP` decisions are produced.
- [x] `HOLD` and `SELL` remain out of scope or reserved.
- [x] `BUY` eligibility allows `PASS` risk or eligible `WARN`.
- [x] Ineligible `WARN` flags block `BUY`.
- [x] Duplicate `BUY` decisions are prevented per session and mint.
- [x] `BUY` creates a `StrategyDecision`.
- [x] `BUY` updates TokenRadar to `APPROVED`.
- [x] `WATCH` creates a `StrategyDecision`.
- [x] `WATCH` keeps TokenRadar as `WATCHING`.
- [x] `SKIP` creates a `StrategyDecision`.
- [x] `SKIP` does not update TokenRadar status by default.
- [x] Dry-run mode skips `StrategyDecision` writes.
- [x] Dry-run mode skips TokenRadar status updates.
- [x] SystemLog entries are written with scope `STRATEGY`.
- [x] Boundary tests verify no orders, fills, or positions are created.
- [x] Boundary tests verify no execution records, wallet loading, signing, or submission behavior.
- [x] Documentation is updated.
- [x] `corepack pnpm verify` passes.
- [x] `corepack pnpm strategy:evaluate --once --dry-run` passes.
- [x] `corepack pnpm strategy:evaluate --once` passes.

## Verification Notes

- 2026-06-21: `corepack pnpm typecheck` passed.
- 2026-06-21: `corepack pnpm test` passed with 31 backend test files and 90 backend tests.
- 2026-06-21: `corepack pnpm strategy:evaluate --once --dry-run` passed against the local paper database with 1 selected, 1 evaluated, 0 written, and 0 status updates.
- 2026-06-21: `corepack pnpm strategy:evaluate --once` passed against the local paper database with 1 selected, 1 evaluated, 1 written, and 0 status updates.
- 2026-06-21: The real local strategy output was `SKIP`, which is acceptable because WATCH/SKIP may dominate and few or zero BUY decisions are expected.

---

# 6. Required Inputs From Previous Phases

Phase 6 requires:

- [x] Phase 1 foundation complete.
- [x] Phase 2 database and repository layer complete.
- [x] Phase 3 provider layer complete.
- [x] Phase 4 scanner-only mode complete.
- [x] Phase 5 risk engine complete.

The key handoff artifacts are:

- `TokenRadar` candidates from Phase 4.
- `RiskAssessment` records from Phase 5.
- `StrategyDecisionRepository`.
- `TokenRadarRepository`.
- `RiskAssessmentRepository`.
- Existing `StrategyDecision` schema and enum values.
- `SystemLog` repository.
- Existing `PAPER` mode safety conventions.

---

# 7. Strategy Decision Model

Phase 6 uses existing `StrategyDecision` schema fields:

```text
id
sessionId
mintAddress
decidedAtMs
decision
strategyName
score
reason
inputSnapshotJson
createdAtMs
```

Existing decision enum values:

```text
WATCH
SKIP
BUY
HOLD
SELL
```

Phase 6 should actively use:

```text
WATCH
SKIP
BUY
```

Phase 6 should reserve but not rely on:

```text
HOLD
SELL
```

because positions do not exist yet.

---

# 8. TokenRadar Strategy Status Policy

Phase 6 may update `TokenRadar` only in these cases:

## BUY

```text
StrategyDecision = BUY
-> TokenRadar.status = APPROVED
```

Meaning:

> Strategy-approved for future paper execution.

It does **not** mean bought.

## WATCH

```text
StrategyDecision = WATCH
-> TokenRadar.status = WATCHING
```

## SKIP

```text
StrategyDecision = SKIP
-> no TokenRadar status change by default
```

## Forbidden Status Changes

Phase 6 must not set:

```text
BOUGHT
```

Phase 6 should not set:

```text
REJECTED
```

because risk already owns rejection.

---

# 9. Runtime Command

Main command:

```bash
pnpm strategy:evaluate --once
```

Supported options:

```bash
pnpm strategy:evaluate --once
pnpm strategy:evaluate --dry-run
pnpm strategy:evaluate --session-id=session_123
pnpm strategy:evaluate --status=WATCHING
pnpm strategy:evaluate --since-hours=24
pnpm strategy:evaluate --limit=50
pnpm strategy:evaluate --max-buy-decisions=5
pnpm strategy:evaluate --strategy-name=phase6_first_pass
```

Optional future flags may include:

```bash
pnpm strategy:evaluate --min-liquidity-usd=10000
pnpm strategy:evaluate --min-volume-1h-usd=10000
pnpm strategy:evaluate --max-price-impact-pct=5
pnpm strategy:evaluate --min-pair-age-minutes=30
```

For Phase 6, these may be constants or config defaults. They should still be centralized in `StrategyConfig.ts`.

---

# 10. Strategy Runtime Defaults

Default config:

```text
status = WATCHING
riskResult = PASS_OR_ELIGIBLE_WARN
sinceHours = 24
limit = 50
maxBuyDecisions = 5
minLiquidityUsd = 10000
maxPriceImpactPct = 5
minPairAgeMinutes = 30
minVolume1hUsd = 10000
strategyName = phase6_first_pass
dryRun = false
once = false
```

---

# 11. Strategy Runtime Validation

Validate:

- [ ] `sinceHours` must be positive.
- [ ] `limit` must be positive.
- [ ] `limit` should be capped to prevent accidental huge runs.
- [ ] `maxBuyDecisions` must be positive.
- [ ] `strategyName` must be non-empty.
- [ ] `status` must be a valid TokenRadar status.
- [ ] `sessionId`, when supplied, must be a non-empty string.
- [ ] `dryRun` defaults to false.
- [ ] `once` defaults to false.

Recommended bounds:

```text
sinceHours: 1 - 168
limit: 1 - 250
maxBuyDecisions: 1 - 25
minLiquidityUsd: >= 0
minVolume1hUsd: >= 0
maxPriceImpactPct: 0 - 100
minPairAgeMinutes: >= 0
```

---

# 12. Session Policy

Phase 6 does **not** create sessions.

## With `--session-id`

When supplied:

```bash
pnpm strategy:evaluate --session-id=session_123
```

Rules:

- [ ] Session must exist.
- [ ] Session must be `PAPER`.
- [ ] Session must be `RUNNING`.
- [ ] If session does not exist, fail clearly.
- [ ] If session is not `PAPER`, fail clearly.
- [ ] If session is not `RUNNING`, fail clearly.

## Without `--session-id`

When omitted:

```bash
pnpm strategy:evaluate --once
```

Rules:

- [ ] Select latest `PAPER` + `RUNNING` session with eligible strategy candidates.
- [ ] Eligible candidates default to `WATCHING`.
- [ ] Candidate must have a latest `RiskAssessment`.
- [ ] If none exists, fail with a clear message.

Do not auto-create a session.

---

# 13. Candidate Selection

Create:

```text
backend/src/strategy/StrategyCandidateSelector.ts
```

Responsibilities:

- [ ] Resolve session.
- [ ] Load `WATCHING` TokenRadar rows by default.
- [ ] Apply recency filter using `discoveredAtMs`.
- [ ] Apply limit.
- [ ] Exclude `REJECTED`.
- [ ] Exclude `BOUGHT`.
- [ ] Exclude `ERROR`.
- [ ] Exclude `IGNORED`.
- [ ] Optionally exclude already `APPROVED` tokens unless explicitly configured later.
- [ ] Load latest `RiskAssessment` per candidate.
- [ ] Return candidates paired with latest risk assessment.

Candidate selection result shape should include:

```ts
interface StrategyCandidate {
  readonly tokenRadar: TokenRadarRecord;
  readonly latestRiskAssessment: RiskAssessmentRecord;
  readonly existingDecisions: readonly StrategyDecisionRecord[];
}
```

---

# 14. Latest Risk Requirement

Each strategy candidate must have a latest `RiskAssessment`.

If missing:

- [ ] Create `SKIP` decision with reason `MISSING_RISK_ASSESSMENT`, or
- [ ] Exclude candidate before evaluation.

Recommendation for Phase 6:

```text
Exclude candidates with no RiskAssessment
```

Reason:

Phase 6 should only make strategy decisions after Phase 5 has completed.

---

# 15. BUY Eligibility Policy

BUY eligibility is based on risk result and flags.

Allowed:

```text
RiskAssessment.result = PASS
```

or:

```text
RiskAssessment.result = WARN
AND WARN flags are eligible
```

Eligible WARN flags:

```text
MISSING_QUOTE
MISSING_AUTHORITY_EVIDENCE
```

Ineligible risk flags for BUY:

```text
MINT_AUTHORITY_PRESENT
FREEZE_AUTHORITY_PRESENT
LOW_LIQUIDITY
HIGH_PRICE_IMPACT
PAIR_TOO_NEW
MISSING_PAIR
MISSING_LIQUIDITY
```

If any ineligible flag is present:

```text
BUY not allowed
```

---

# 16. Duplicate BUY Protection

Phase 6 must enforce:

```text
One BUY decision per session + mint.
```

Use:

```ts
StrategyDecisionRepository.listDecisionsForMint(sessionId, mintAddress);
```

Rules:

- [ ] If an existing `BUY` decision exists for the same session and mint, do not create another `BUY`.
- [ ] Candidate may receive `WATCH` or `SKIP` depending on current scoring policy.
- [ ] Reason should include `DUPLICATE_BUY_PREVENTED`.
- [ ] Boundary tests must cover this.

---

# 17. Strategy Score Model

Strategy score is separate from risk score.

Risk score answers:

```text
How safe is this token?
```

Strategy score answers:

```text
How attractive is this token for future paper entry?
```

Strategy score range:

```text
0 - 100
```

Score starts at:

```text
0
```

and adds points from deterministic factors.

---

# 18. Strategy Scoring Table

| Condition           | Points |
| ------------------- | -----: |
| Risk PASS           |    +40 |
| Risk WARN, eligible |    +20 |
| Liquidity > $50,000 |    +20 |
| Liquidity > $25,000 |    +10 |
| Volume 1h > $50,000 |    +20 |
| Volume 1h > $10,000 |    +10 |
| Pair age > 24h      |    +10 |
| Pair age 30m-24h    |     +5 |
| Price impact < 2%   |    +10 |
| Price impact 2%-5%  |     +5 |

Clamp final score:

```text
min = 0
max = 100
```

---

# 19. Strategy Decision Bands

```text
90 - 100 = BUY
70 - 89 = WATCH
0 - 69 = SKIP
```

Important:

- A candidate with score >= 90 still cannot be `BUY` if BUY eligibility fails.
- A candidate with duplicate BUY history cannot receive another `BUY`.
- If the score says BUY but BUY is blocked, downgrade to `WATCH` or `SKIP` with a clear reason.

Recommended downgrade:

```text
BUY score but ineligible risk -> SKIP
BUY score but duplicate BUY exists -> WATCH
BUY score but max BUY cap reached -> WATCH
```

---

# 20. Strategy Reasons

Strategy decisions must be explainable.

Reason examples:

```text
BUY: risk=PASS liquidity=55000 volume1h=80000 age=2d impact=1.2 score=100
WATCH: score=75 below buy threshold
SKIP: risk WARN contains ineligible flag LOW_LIQUIDITY
SKIP: missing latest risk assessment
WATCH: duplicate BUY decision already exists
WATCH: max BUY decisions reached
```

Reason should be concise but useful.

---

# 21. Strategy Input Snapshot

`inputSnapshotJson` should store compact redacted evidence.

Include:

```json
{
  "phase": "PHASE_6_STRATEGY_ENGINE",
  "strategyName": "phase6_first_pass",
  "tokenRadar": {
    "id": "...",
    "mintAddress": "...",
    "symbol": "...",
    "status": "WATCHING",
    "liquidityUsd": "...",
    "volume1hUsd": "...",
    "ageSeconds": 12345
  },
  "riskAssessment": {
    "id": "...",
    "result": "PASS",
    "score": 95,
    "riskFlags": []
  },
  "strategyScore": {
    "score": 90,
    "factors": []
  },
  "decision": "BUY"
}
```

Do not store:

- API keys
- Headers
- Wallet data
- Raw provider payloads
- Huge nested objects

---

# 22. Strategy Rule Modules

Create:

```text
backend/src/strategy/rules/
```

Suggested files:

```text
RiskEligibilityRule.ts
LiquidityAttractivenessRule.ts
VolumeRule.ts
PairAgeAttractivenessRule.ts
PriceImpactAttractivenessRule.ts
DuplicateBuyRule.ts
StrategyRuleResult.ts
```

Each rule should return structured output:

```ts
interface StrategyRuleResult {
  readonly ruleName: string;
  readonly points: number;
  readonly passed: boolean;
  readonly warnings: readonly string[];
  readonly reason: string;
}
```

---

# 23. Strategy Scoring Service

Create:

```text
backend/src/strategy/StrategyScoringService.ts
```

Responsibilities:

- [ ] Apply all strategy rules.
- [ ] Sum points.
- [ ] Clamp 0-100.
- [ ] Determine initial decision band.
- [ ] Apply BUY eligibility override.
- [ ] Apply duplicate BUY override.
- [ ] Apply max BUY cap override.
- [ ] Return final decision.

Suggested output:

```ts
interface StrategyScoreResult {
  readonly score: number;
  readonly decision: StrategyDecision;
  readonly rawDecision: StrategyDecision;
  readonly buyEligible: boolean;
  readonly duplicateBuyBlocked: boolean;
  readonly maxBuyCapBlocked: boolean;
  readonly factors: readonly StrategyRuleResult[];
  readonly reason: string;
}
```

---

# 24. Strategy Evaluation Service

Create:

```text
backend/src/strategy/StrategyEvaluationService.ts
```

Responsibilities:

- [ ] Select candidates.
- [ ] Score each candidate.
- [ ] Create `StrategyDecision` records unless dry-run.
- [ ] Update TokenRadar when allowed unless dry-run.
- [ ] Write SystemLog records.
- [ ] Return summary.

Suggested summary:

```ts
interface StrategyEvaluationSummary {
  readonly sessionId: string;
  readonly selectedCount: number;
  readonly evaluatedCount: number;
  readonly writtenCount: number;
  readonly statusUpdatedCount: number;
  readonly buyCount: number;
  readonly watchCount: number;
  readonly skipCount: number;
  readonly holdCount: number;
  readonly sellCount: number;
  readonly duplicateBuyBlockedCount: number;
  readonly maxBuyCapBlockedCount: number;
  readonly errorCount: number;
  readonly dryRun: boolean;
}
```

---

# 25. Strategy Runner

Create:

```text
backend/src/strategy/StrategyRunner.ts
```

Mirror the Phase 5 runner shape:

```ts
export class StrategyRunner {
  run(): Promise<StrategyEvaluationSummary>;
  runOnce(): Promise<StrategyEvaluationSummary>;
}
```

Phase 6 does not need continuous mode unless you choose to support it. For first implementation, `--once` is enough.

---

# 26. Strategy Config

Create:

```text
backend/src/strategy/StrategyConfig.ts
```

Supported CLI options:

```text
--once
--dry-run
--session-id
--status
--since-hours
--limit
--max-buy-decisions
--strategy-name
```

Optional configurable scoring thresholds:

```text
--min-liquidity-usd
--min-volume-1h-usd
--max-price-impact-pct
--min-pair-age-minutes
```

If these are not exposed in CLI yet, define them as config defaults for later tuning.

---

# 27. CLI Entry Point

Create:

```text
backend/src/scripts/strategy-evaluate.ts
```

Responsibilities:

- [ ] Load app config.
- [ ] Enforce `PAPER` mode.
- [ ] Run migrations.
- [ ] Create database context.
- [ ] Create repositories.
- [ ] Parse strategy CLI args.
- [ ] Build `StrategyRunner`.
- [ ] Print startup summary.
- [ ] Print safety boundary.
- [ ] Run once.
- [ ] Print strategy summary.
- [ ] Close database.

Startup output should include:

```text
MODE: PAPER
Strategy once: yes
Strategy dry-run: yes/no
Session: auto-select/latest or explicit
Candidate status: WATCHING
Since hours: 24
Limit: 50
Max BUY decisions: 5
Strategy name: phase6_first_pass
Wallet loaded: no
Transaction signing: disabled
Transaction submission: disabled
```

---

# 28. Package Scripts

Add root `package.json`:

```json
{
  "strategy:evaluate": "pnpm --filter @nexustrade/backend strategy:evaluate"
}
```

Add backend `backend/package.json`:

```json
{
  "strategy:evaluate": "tsx src/scripts/strategy-evaluate.ts"
}
```

---

# 29. Dry-Run Behavior

Dry-run mode allows:

- Candidate selection.
- Risk lookup.
- Strategy scoring.
- Decision summary.
- SystemLog writes if consistent with previous phases.

Dry-run mode skips:

- `StrategyDecision` writes.
- `TokenRadar` status updates.

Command:

```bash
pnpm strategy:evaluate --once --dry-run
```

Expected:

```text
selected=X evaluated=Y written=0 statusUpdated=0
```

---

# 30. Persistence Behavior

## StrategyDecision Writes

For non-dry runs:

- [ ] Write one `StrategyDecision` per evaluated candidate.
- [ ] Include `sessionId`.
- [ ] Include `mintAddress`.
- [ ] Include `decidedAtMs`.
- [ ] Include `decision`.
- [ ] Include `strategyName`.
- [ ] Include `score`.
- [ ] Include concise reason.
- [ ] Include compact `inputSnapshotJson`.

## TokenRadar Updates

Only after decision write succeeds:

- [ ] `BUY` updates TokenRadar to `APPROVED`.
- [ ] `WATCH` updates TokenRadar to `WATCHING`.
- [ ] `SKIP` leaves TokenRadar unchanged.

If decision write fails, do not update TokenRadar.

---

# 31. Max BUY Decisions Per Run

Default:

```text
maxBuyDecisions = 5
```

Rules:

- [ ] Count BUY decisions created in the current run.
- [ ] Stop creating BUY decisions after cap is reached.
- [ ] Candidates that would otherwise BUY after cap should become `WATCH`.
- [ ] Reason should include `MAX_BUY_DECISIONS_REACHED`.

This prevents Phase 7 from being handed too many approved candidates.

---

# 32. Eligible WARN Policy Details

Eligible WARN means warnings from incomplete evidence, not active danger.

Eligible flags:

```text
MISSING_QUOTE
MISSING_AUTHORITY_EVIDENCE
```

Ineligible flags:

```text
MINT_AUTHORITY_PRESENT
FREEZE_AUTHORITY_PRESENT
LOW_LIQUIDITY
MEDIUM_LIQUIDITY
HIGH_PRICE_IMPACT
MEDIUM_PRICE_IMPACT
PAIR_TOO_NEW
PAIR_YOUNG
MISSING_PAIR
MISSING_LIQUIDITY
```

Recommended Phase 6 behavior:

- `PASS` is always BUY-eligible unless duplicate/cap blocks it.
- `WARN` is BUY-eligible only if all flags are eligible.
- `FAIL` is never BUY-eligible.
- `UNKNOWN` is never BUY-eligible.

---

# 33. Handling Current Real Data

Current Phase 5 sample run had:

```text
PASS = 0
WARN = 1
FAIL = 24
```

This means a PASS-only strategy would produce zero BUY candidates.

Phase 6 intentionally supports eligible WARN because current provider evidence can be incomplete even when liquidity and age look acceptable.

This is a practical but still conservative bridge until provider evidence improves.

---

# 34. Logging and Observability

Use `SystemLog` scope:

```text
STRATEGY
```

Log:

- [ ] Strategy startup.
- [ ] Selected candidate count.
- [ ] Missing risk assessment count.
- [ ] BUY eligibility blocks.
- [ ] Duplicate BUY blocks.
- [ ] Max BUY cap blocks.
- [ ] Decision summary.
- [ ] Errors.

Summary format:

```text
Strategy summary: selected=25 evaluated=25 written=25 buy=3 watch=10 skip=12 duplicateBuyBlocked=1 errors=0
```

---

# 35. Safety Boundary

Phase 6 may create:

```text
StrategyDecision
SystemLog
```

Phase 6 may update:

```text
TokenRadar
```

Phase 6 must not create:

```text
Order
Fill
Position
PositionSnapshot
EquitySnapshot
```

Phase 6 must not:

```text
Load wallet
Sign transaction
Submit transaction
Execute swap
Simulate fill
```

---

# 36. Testing Plan

## 36.1 Config Tests

Create:

```text
backend/src/strategy/StrategyConfig.test.ts
```

Cover:

- [ ] Default config.
- [ ] `--once`.
- [ ] `--dry-run`.
- [ ] `--session-id`.
- [ ] `--status`.
- [ ] `--since-hours`.
- [ ] `--limit`.
- [ ] `--max-buy-decisions`.
- [ ] `--strategy-name`.
- [ ] Invalid numeric bounds.
- [ ] Unknown option rejection.

## 36.2 Candidate Selector Tests

Create:

```text
backend/src/strategy/StrategyCandidateSelector.test.ts
```

Cover:

- [ ] Explicit session selection.
- [ ] Default latest running PAPER session selection.
- [ ] Failure when no eligible session exists.
- [ ] WATCHING status filtering.
- [ ] Recency filtering.
- [ ] Limit filtering.
- [ ] Exclusion of REJECTED/ERROR/BOUGHT.
- [ ] Latest RiskAssessment lookup.
- [ ] Missing risk assessment exclusion.

## 36.3 Rule Tests

Create:

```text
backend/src/strategy/rules/StrategyRules.test.ts
```

Cover:

- [ ] Risk PASS gives +40.
- [ ] Eligible WARN gives +20.
- [ ] Ineligible WARN blocks BUY.
- [ ] FAIL blocks BUY.
- [ ] UNKNOWN blocks BUY.
- [ ] Liquidity > $50k gives +20.
- [ ] Liquidity > $25k gives +10.
- [ ] Volume1h > $50k gives +20.
- [ ] Volume1h > $10k gives +10.
- [ ] Age > 24h gives +10.
- [ ] Age 30m-24h gives +5.
- [ ] Impact < 2% gives +10.
- [ ] Impact 2%-5% gives +5.
- [ ] Duplicate BUY blocks BUY.

## 36.4 Scoring Tests

Create:

```text
backend/src/strategy/StrategyScoringService.test.ts
```

Cover:

- [ ] Score clamps to 100.
- [ ] Score 90+ maps to BUY when eligible.
- [ ] Score 70-89 maps to WATCH.
- [ ] Score below 70 maps to SKIP.
- [ ] BUY score with ineligible risk maps to SKIP.
- [ ] BUY score with duplicate BUY maps to WATCH.
- [ ] Max BUY cap downgrades BUY to WATCH.

## 36.5 Runner Tests

Create:

```text
backend/src/strategy/StrategyRunner.test.ts
```

Cover:

- [ ] Non-dry run writes StrategyDecision.
- [ ] Non-dry BUY updates TokenRadar to APPROVED.
- [ ] WATCH updates/keeps TokenRadar WATCHING.
- [ ] SKIP leaves TokenRadar unchanged.
- [ ] Dry-run skips StrategyDecision writes.
- [ ] Dry-run skips TokenRadar updates.
- [ ] Duplicate BUY protection.
- [ ] Max BUY cap behavior.
- [ ] SystemLog writes.

## 36.6 Safety Boundary Tests

In `StrategyRunner.test.ts`, assert Phase 6 creates no:

- [ ] Orders.
- [ ] Fills.
- [ ] Open positions.
- [ ] Closed positions.
- [ ] Position snapshots.
- [ ] Equity snapshots.

Also assert no wallet/signing/submission code is reachable through the strategy runner.

---

# 37. Documentation Requirements

Update:

- [ ] `docs/Structure.md`
- [ ] `docs/ROADMAP.md`
- [ ] `README.md`
- [ ] `docs/DECISIONS.md`

Create:

```text
docs/architecture/strategy-engine.md
docs/NeXusTrade-Phase-6-Detailed-Checklist.md
docs/Phase-7-Planning-Inputs.md
```

---

# 38. Strategy Engine Architecture Doc

Create:

```text
docs/architecture/strategy-engine.md
```

Include:

- Phase 6 purpose.
- Runtime command.
- CLI options.
- Session policy.
- Candidate selection.
- Risk eligibility policy.
- Eligible WARN policy.
- Strategy scoring model.
- Decision bands.
- TokenRadar status updates.
- Duplicate BUY prevention.
- Max BUY cap.
- Dry-run behavior.
- Safety boundary.
- Known limitations.

---

# 39. Decision Log Updates

Add decisions:

## Use PASS + eligible WARN for initial BUY eligibility

Reason:

Current Helius/Jupiter evidence can be incomplete. Missing quote or missing authority certainty should not automatically block strategy evaluation if other data is attractive.

## Use separate 0-100 strategy score

Reason:

Risk score measures safety. Strategy score measures attractiveness.

## Enforce one BUY decision per session and mint

Reason:

Keeps strategy history auditable and prevents repeated approvals for the same token.

## Phase 6 creates decisions, not orders

Reason:

Execution belongs to PaperExchange in Phase 7.

---

# 40. File Planning

Likely files:

```text
backend/src/strategy/StrategyConfig.ts
backend/src/strategy/StrategyConfig.test.ts
backend/src/strategy/StrategyCandidateSelector.ts
backend/src/strategy/StrategyCandidateSelector.test.ts
backend/src/strategy/StrategyScoringService.ts
backend/src/strategy/StrategyScoringService.test.ts
backend/src/strategy/StrategyEvaluationService.ts
backend/src/strategy/StrategyRunner.ts
backend/src/strategy/StrategyRunner.test.ts
backend/src/strategy/StrategyFlags.ts
backend/src/strategy/rules/StrategyRuleResult.ts
backend/src/strategy/rules/RiskEligibilityRule.ts
backend/src/strategy/rules/LiquidityAttractivenessRule.ts
backend/src/strategy/rules/VolumeRule.ts
backend/src/strategy/rules/PairAgeAttractivenessRule.ts
backend/src/strategy/rules/PriceImpactAttractivenessRule.ts
backend/src/strategy/rules/DuplicateBuyRule.ts
backend/src/strategy/rules/StrategyRules.test.ts
backend/src/scripts/strategy-evaluate.ts
docs/architecture/strategy-engine.md
docs/NeXusTrade-Phase-6-Detailed-Checklist.md
docs/Phase-7-Planning-Inputs.md
```

---

# 41. Commit Checkpoints

Use small commits that keep the project runnable.

## Commit 1

```text
phase6: add strategy runtime configuration
```

Includes:

- StrategyConfig.
- CLI parsing tests.
- Package scripts if simple.

## Commit 2

```text
phase6: add strategy candidate selection
```

Includes:

- StrategyCandidateSelector.
- Session selection.
- Latest risk lookup.
- Candidate filtering tests.

## Commit 3

```text
phase6: add strategy scoring rules
```

Includes:

- Rule modules.
- StrategyScoringService.
- Scoring tests.

## Commit 4

```text
phase6: add strategy evaluation service
```

Includes:

- StrategyEvaluationService.
- StrategyDecision persistence.
- TokenRadar status updates.
- Dry-run behavior.

## Commit 5

```text
phase6: add strategy runner and cli
```

Includes:

- StrategyRunner.
- strategy-evaluate.ts.
- Root/backend scripts.
- Startup summary.

## Commit 6

```text
phase6: add strategy safety tests and documentation
```

Includes:

- Boundary tests.
- Architecture doc.
- Structure updates.
- Roadmap updates.
- Phase 7 planning inputs.

---

# 42. Verification Commands

Run:

```bash
corepack pnpm verify
corepack pnpm strategy:evaluate --once --dry-run
corepack pnpm strategy:evaluate --once
```

Expected dry-run behavior:

```text
Strategy dry-run: yes
selected=X evaluated=Y written=0 statusUpdated=0
```

Expected non-dry behavior:

```text
Strategy dry-run: no
selected=X evaluated=Y written=Y statusUpdated=Z
```

Safety output should include:

```text
Wallet loaded: no
Transaction signing: disabled
Transaction submission: disabled
```

---

# 43. Final Acceptance Criteria

Phase 6 is complete when:

```bash
pnpm strategy:evaluate --once
```

successfully:

- Selects eligible `WATCHING` TokenRadar candidates.
- Loads latest RiskAssessment per token.
- Applies BUY eligibility policy.
- Calculates 0-100 strategy score.
- Creates StrategyDecision records.
- Prevents duplicate BUY decisions.
- Enforces max BUY cap.
- Updates TokenRadar to APPROVED only after stored BUY decisions.
- Keeps WATCH candidates in WATCHING.
- Leaves SKIP candidates unchanged.
- Writes SystemLog entries.
- Runs in PAPER mode.
- Creates no orders.
- Creates no fills.
- Creates no positions.
- Loads no wallet.
- Signs no transaction.
- Submits no transaction.

---

# 44. Phase 7 Handoff Notes

Phase 7 will consume:

```text
StrategyDecision(BUY)
+
TokenRadar(APPROVED)
+
Latest RiskAssessment
```

Phase 7 will introduce:

- Paper orders.
- Simulated fills.
- Open positions.
- Fee/slippage modeling.
- Price impact modeling.
- Position state changes.

Phase 6 should not attempt to prepare execution payloads or simulate fills.

Phase 7 should be able to ask:

```text
Which tokens did strategy approve for paper execution?
```

and answer by querying:

```text
StrategyDecision where decision = BUY
```

or:

```text
TokenRadar where status = APPROVED
```

---

# 45. Known Limitations

- Phase 6 does not yet use momentum beyond 1h volume.
- Phase 6 does not evaluate holder concentration.
- Phase 6 does not use social signals.
- Phase 6 does not use wallet clustering.
- Phase 6 does not simulate entry.
- Phase 6 does not check open position exposure.
- Phase 6 does not consider current paper balance.
- Phase 6 does not rank against already-approved candidates beyond max BUY cap.
- Current strategy scoring is intentionally simple and should be tuned after collecting real decisions.

---

# 46. Phase 6 Completion Statement

When Phase 6 is complete, NeXusTrade will have its first true decision-making engine.

At that point, the system will have:

```text
Scanner
-> Risk Engine
-> Strategy Engine
```

working in sequence.

It still will not trade. That is intentional.

The next phase, PaperExchange, will finally turn stored BUY decisions into simulated orders, fills, and positions.
