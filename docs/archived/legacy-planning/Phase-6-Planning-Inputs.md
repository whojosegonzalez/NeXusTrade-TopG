# Phase 6 Planning Inputs

This handoff captures the current Phase 5 state needed to plan Phase 6: the first strategy engine.

Phase 6 should consume risk output and create transparent strategy decisions only:

```text
TokenRadar candidate
-> latest RiskAssessment
-> transparent rule-based strategy
-> StrategyDecision record
-> optional TokenRadar status update
```

Phase 6 should not create orders, fills, positions, wallet activity, transaction signing, transaction submission, or live trades.

## 1. Current File Tree After Phase 5

Meaningful project files after Phase 5:

```text
.
|-- .editorconfig
|-- .env.example
|-- .gitignore
|-- .node-version
|-- .npmrc
|-- .nvmrc
|-- .prettierignore
|-- .prettierrc
|-- eslint.config.js
|-- package.json
|-- pnpm-lock.yaml
|-- pnpm-workspace.yaml
|-- README.md
|-- tsconfig.base.json
|-- backend/
|   |-- drizzle.config.ts
|   |-- package.json
|   |-- tsconfig.json
|   |-- drizzle/
|   |   |-- 0000_tense_aqueduct.sql
|   |   `-- meta/
|   |       |-- 0000_snapshot.json
|   |       `-- _journal.json
|   `-- src/
|       |-- index.ts
|       |-- config/
|       |-- db/
|       |   |-- repositories/
|       |   |   |-- RiskAssessmentRepository.ts
|       |   |   |-- StrategyDecisionRepository.ts
|       |   |   |-- TokenRadarRepository.ts
|       |   |   `-- ...
|       |   `-- schema/
|       |       |-- enums.ts
|       |       |-- riskAssessments.ts
|       |       |-- strategyDecisions.ts
|       |       |-- tokenRadar.ts
|       |       `-- ...
|       |-- providers/
|       |-- risk/
|       |   |-- RiskAssessmentWriter.ts
|       |   |-- RiskCandidateSelector.ts
|       |   |-- RiskCandidateSelector.test.ts
|       |   |-- RiskConfig.ts
|       |   |-- RiskConfig.test.ts
|       |   |-- RiskEvaluationService.ts
|       |   |-- RiskEvidenceRefreshService.ts
|       |   |-- RiskFlags.ts
|       |   |-- RiskRunner.ts
|       |   |-- RiskRunner.test.ts
|       |   |-- RiskScoringService.ts
|       |   |-- RiskScoringService.test.ts
|       |   `-- rules/
|       |       |-- AuthorityRule.ts
|       |       |-- LiquidityRule.ts
|       |       |-- PairAgeRule.ts
|       |       |-- PriceImpactRule.ts
|       |       |-- RiskRuleResult.ts
|       |       `-- RiskRules.test.ts
|       |-- scanner/
|       `-- scripts/
|           |-- providers-smoke.ts
|           |-- risk-evaluate.ts
|           `-- scanner-discover.ts
|-- data/
|   `-- .gitkeep
|-- docs/
|   |-- DECISIONS.md
|   |-- NeXusTrade-Phase-1-Detailed-Checklist.md
|   |-- NeXusTrade-Phase-2-Detailed-Checklist.md
|   |-- NeXusTrade-Phase-3-Detailed-Checklist.md
|   |-- NeXusTrade-Phase-4-Detailed-Checklist.md
|   |-- NeXusTrade-Phase-5-Detailed-Checklist.md
|   |-- Phase-4-Planning-Inputs.md
|   |-- Phase-5-Planning-Inputs.md
|   |-- Phase-6-Planning-Inputs.md
|   |-- Provider-Architecture.md
|   |-- ROADMAP.md
|   |-- Structure.md
|   |-- architecture/
|   |   |-- database.md
|   |   |-- risk-engine.md
|   |   `-- scanner.md
|   `-- phase-notes/
|       `-- phase-2-database-layer.md
|-- frontend/
|   `-- README.md
|-- scripts/
|   `-- check-secrets.mjs
`-- shared/
    |-- package.json
    |-- tsconfig.json
    `-- src/
        |-- config.ts
        |-- index.ts
        |-- modes.ts
        |-- market/
        `-- providers/
```

Local-only files such as `.env`, `data/nexus_paper.db`, and SQLite WAL/SHM files are intentionally excluded from the tree.

## 2. Risk Engine Architecture

Read `docs/architecture/risk-engine.md` before writing Phase 6. Key points:

- Phase 5 is paper-only.
- It consumes scanner-created `TokenRadar` candidates.
- It refreshes evidence and probes quotes through `MarketDataService`.
- It writes `RiskAssessment`.
- It updates TokenRadar only within risk-safe bounds.
- It never creates `StrategyDecision`, `Order`, `Fill`, or `Position`.

## 3. RiskRunner Surface

File: `backend/src/risk/RiskRunner.ts`

Available methods:

- `run(): Promise<RiskEvaluationSummary>`
- `runOnce(): Promise<RiskEvaluationSummary>`

`RiskRunner` builds:

- `RiskCandidateSelector`
- `RiskEvidenceRefreshService`
- `RiskEvaluationService`

Phase 6 can mirror this shape with a `StrategyRunner` facade.

## 4. RiskEvaluationService Surface

File: `backend/src/risk/RiskEvaluationService.ts`

Responsibilities:

- Select candidates.
- Refresh evidence with bounded concurrency.
- Score risk.
- Write `RiskAssessment`.
- Update TokenRadar status.
- Write `SystemLog` records with scope `RISK`.
- Return `RiskEvaluationSummary`.

Summary fields:

- `sessionId`
- `selectedCount`
- `evaluatedCount`
- `writtenCount`
- `statusUpdatedCount`
- `passCount`
- `warnCount`
- `failCount`
- `unknownCount`
- `errorCount`
- `dryRun`

Phase 6 should likely have a parallel `StrategyEvaluationService` with strategy-specific counts.

## 5. RiskConfig Surface

File: `backend/src/risk/RiskConfig.ts`

Defaults:

- `statuses`: `DISCOVERED,WATCHING`
- `sinceHours`: `24`
- `limit`: `50`
- `concurrency`: `3`
- `probeAmountSol`: `0.01`
- `once`: `false`
- `dryRun`: `false`

Supported CLI options:

- `--once`
- `--dry-run`
- `--session-id=...`
- `--status=DISCOVERED,WATCHING`
- `--since-hours=24`
- `--limit=50`
- `--concurrency=3`
- `--probe-sol=0.01`

Phase 6 can reuse the same style for `StrategyConfig`.

## 6. Risk Rule Files

Rule files live under `backend/src/risk/rules`.

Current deterministic risk rules:

- `AuthorityRule.ts`
  - mint authority present: `FAIL`
  - freeze authority present: `FAIL`
  - missing or unknown authority evidence: `WARN`
- `LiquidityRule.ts`
  - missing pair: `FAIL`
  - missing liquidity: `FAIL`
  - liquidity below `$2,000`: `FAIL`
  - liquidity `$2,000-$10,000`: `WARN`
  - liquidity at or above `$10,000`: pass
- `PairAgeRule.ts`
  - missing pair creation time: `FAIL`
  - pair age below 5 minutes: `FAIL`
  - pair age 5-30 minutes: `WARN`
  - pair age above 30 minutes: pass
- `PriceImpactRule.ts`
  - missing buy and sell quote evidence: `WARN`
  - one missing quote side: `WARN`
  - price impact above 15%: `FAIL`
  - price impact 5-15%: `WARN`
  - price impact below 5%: pass

## 7. RiskAssessmentRepository Methods

File: `backend/src/db/repositories/RiskAssessmentRepository.ts`

Methods:

- `createRiskAssessment(input)`
- `getRiskAssessmentById(id)`
- `getLatestRiskAssessment(sessionId, mintAddress)`
- `listRiskAssessments(sessionId, filter)`

Current filters:

- `result`
- `mintAddress`
- `limit`

Phase 6 can use `getLatestRiskAssessment(sessionId, mintAddress)` for per-token strategy evaluation.

## 8. StrategyDecisionRepository Methods

File: `backend/src/db/repositories/StrategyDecisionRepository.ts`

Methods:

- `createStrategyDecision(input)`
- `getStrategyDecisionById(id)`
- `listStrategyDecisions(sessionId, filter)`
- `listDecisionsForMint(sessionId, mintAddress)`

Current filters:

- `decision`
- `mintAddress`
- `limit`

Phase 6 can use `listDecisionsForMint()` to enforce no duplicate `BUY` decision for the same session and mint.

## 9. TokenRadarRepository Methods

File: `backend/src/db/repositories/TokenRadarRepository.ts`

Methods:

- `createRadarEntry(input)`
- `upsertRadarEntry(input)`
- `getRadarEntryById(id)`
- `findRadarEntryByMint(sessionId, mintAddress)`
- `listRadarEntries(sessionId, filter)`
- `updateRadarStatus(id, status, notes?)`

Current filters:

- `status`
- `statuses`
- `mintAddress`
- `discoveredFromMs`
- `discoveredToMs`
- `limit`

Phase 6 can use `listRadarEntries()` for `WATCHING` candidates and `updateRadarStatus()` to move a token to `APPROVED` only after a stored `BUY` decision.

## 10. StrategyDecision Schema Fields And Enums

File: `backend/src/db/schema/strategyDecisions.ts`

Fields:

- `id`
- `sessionId`
- `mintAddress`
- `decidedAtMs`
- `decision`
- `strategyName`
- `score`
- `reason`
- `inputSnapshotJson`
- `createdAtMs`

Decision enum values:

- `WATCH`
- `SKIP`
- `BUY`
- `HOLD`
- `SELL`

Related TokenRadar status enum values:

- `DISCOVERED`
- `WATCHING`
- `REJECTED`
- `APPROVED`
- `BOUGHT`
- `IGNORED`
- `ERROR`

## 11. Sample RiskAssessment Row From Non-Dry Phase 5 Run

The non-dry Phase 5 smoke run for session `session_3e2830d0-1bb0-496c-b8f0-772215840996` produced 25 assessments:

- `FAIL`: 24
- `WARN`: 1
- `PASS`: 0

Sample `WARN` row from that run:

```json
{
  "id": "risk_2614c55a-5ffe-4c57-a3a8-cb266584ea65",
  "sessionId": "session_3e2830d0-1bb0-496c-b8f0-772215840996",
  "tokenRadarId": "radar_ac1d4651-9f0a-4c2c-a62b-834f183176df",
  "mintAddress": "GTtNj9FEqkP9Xtw4y2bFxMXVMM1iDcFKKBE2zQSzpump",
  "checkedAtMs": 1782067488430,
  "score": 70,
  "result": "WARN",
  "passed": 0,
  "mintAuthorityDisabled": null,
  "freezeAuthorityDisabled": null,
  "tokenProgram": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "liquidityUsd": "10288.32",
  "riskFlagsJson": "[\"MISSING_AUTHORITY_EVIDENCE\",\"MISSING_QUOTE\"]",
  "createdAtMs": 1782067490547
}
```

Planning implication: a PASS-only Phase 6 default will evaluate zero eligible candidates for this particular session until a later scanner/risk run produces a `PASS` result.

## 12. Sample TokenRadar Row After Risk Status Update

Matching TokenRadar row after the `WARN` risk update:

```json
{
  "id": "radar_ac1d4651-9f0a-4c2c-a62b-834f183176df",
  "sessionId": "session_3e2830d0-1bb0-496c-b8f0-772215840996",
  "mintAddress": "GTtNj9FEqkP9Xtw4y2bFxMXVMM1iDcFKKBE2zQSzpump",
  "symbol": "LOL",
  "name": null,
  "pairAddress": "8tYWFQxrtvbdCmyDdjC4cJMCk7HisBqprQpzzVJLbwMf",
  "source": "DEXSCREENER",
  "firstSeenAtMs": 1782014790000,
  "discoveredAtMs": 1782022451494,
  "priceUsd": "0.00002362",
  "priceSol": "3.232e-7",
  "liquidityUsd": "11071.32",
  "volume5mUsd": "1452.21",
  "volume1hUsd": "26381.97",
  "ageSeconds": 7661,
  "status": "WATCHING",
  "notes": "Enrichment warnings: 2\nRisk WARN score=70 flags=MISSING_AUTHORITY_EVIDENCE,MISSING_QUOTE",
  "createdAtMs": 1782022458908,
  "updatedAtMs": 1782067490547
}
```

## 13. Phase 5 Checklist And Completion Notes

Read `docs/NeXusTrade-Phase-5-Detailed-Checklist.md`.

Completed Phase 5 behavior:

- `risk:evaluate` command exists.
- Defaults are statuses `DISCOVERED,WATCHING`, recency 24 hours, limit 50, concurrency 3, quote probe `0.01 SOL`.
- No auto-created risk sessions.
- Missing Jupiter quote is `WARN`.
- Unknown Helius authority evidence is `WARN`, not `PASS`.
- `RiskAssessment` persistence is implemented.
- TokenRadar risk-safe transitions are implemented.
- Dry-run skips `RiskAssessment` writes and TokenRadar updates.
- Safety boundary tests verify no strategy decisions, orders, fills, or positions.

Verification:

- `corepack pnpm verify` passed.
- `corepack pnpm risk:evaluate --once --dry-run` passed with 25 selected, 25 evaluated, 0 written, 0 status updates.
- `corepack pnpm risk:evaluate --once` passed with 25 selected, 25 evaluated, 25 written, 25 status updates.

## 14. Current Package Scripts For Risk Evaluate

Root `package.json`:

```json
{
  "risk:evaluate": "pnpm --filter @nexustrade/backend risk:evaluate"
}
```

Backend `backend/package.json`:

```json
{
  "risk:evaluate": "tsx src/scripts/risk-evaluate.ts"
}
```

Recommended Phase 6 script shape:

```json
{
  "strategy:evaluate": "pnpm --filter @nexustrade/backend strategy:evaluate"
}
```

```json
{
  "strategy:evaluate": "tsx src/scripts/strategy-evaluate.ts"
}
```

## 15. Phase 5 Safety Boundary Tests

File: `backend/src/risk/RiskRunner.test.ts`

Current safety assertions verify that Phase 5 creates none of:

- `StrategyDecision`
- `Order`
- `Fill`
- open `Position`
- closed `Position`

Phase 6 should add parallel tests that allow `StrategyDecision` writes but still forbid:

- `Order`
- `Fill`
- `Position`
- wallet activity
- transaction signing
- transaction submission

## Phase 6 Decision Recommendations

Recommended defaults:

- Add standalone command: `pnpm strategy:evaluate --once`.
- Do not auto-create sessions.
- If `--session-id` is omitted, use the latest `PAPER` + `RUNNING` session with eligible strategy candidates.
- Evaluate `WATCHING` TokenRadar rows by default.
- Allow latest risk result `PASS` or eligible `WARN` for initial `BUY` eligibility.
- Create `StrategyDecision` records only.
- Do not create orders, fills, positions, wallet activity, signing, or submission.
- Update TokenRadar to `APPROVED` only after a `BUY` decision is stored.
- Use `SKIP` or `WATCH` decisions for evaluated candidates that do not meet first-pass strategy rules.

Recommended first-pass strategy rules:

- latest `RiskAssessment.result` must be `PASS`, or `WARN` with only eligible incomplete-evidence flags
- liquidity must be at least `$10,000`
- max buy/sell price impact must be below `5%`
- pair age must be above 30 minutes
- require either 5m or 1h volume to meet a configured minimum
- cap candidates per run
- prevent duplicate `BUY` decision for the same session and mint

Recommended initial config:

- `status`: `WATCHING`
- `riskResult`: `PASS_OR_ELIGIBLE_WARN`
- `sinceHours`: `24`
- `limit`: `50`
- `maxBuyDecisions`: `5`
- `minLiquidityUsd`: `10000`
- `maxPriceImpactPct`: `5`
- `minPairAgeMinutes`: `30`
- `minVolume1hUsd`: `10000`
- `strategyName`: `phase6_first_pass`
- `dryRun`: `false`

Reasoning:

- `PASS_OR_ELIGIBLE_WARN` keeps Phase 6 practical while still blocking active danger flags.
- BUY decisions should not imply execution; PaperExchange owns orders/fills/positions later.
- `APPROVED` should mean "strategy-approved for future paper execution," not bought.
- Duplicate BUY prevention keeps the decision table auditable and avoids repeated approvals for the same token in the same session.
