# NeXusTrade Phase 9.4A.1 Detailed Checklist

Archive and reporting truthing

Last updated: August 2026

## Status

Implemented, smoke-validated, and closed out against the three Phase 9.4 archived runs.

Implementation result:

```text
command = pnpm research:truth --once
smoke archive = data/archive/phase9.4A.1/smoke-20260805-0830
safety = passed
orders/fills/positions = 0
decisionRows = 2458
missingQuote = 2037
unclassifiedMissingQuote = 0
Birdeye budget skips = 66 policy/guardrail skips
Birdeye provider failures = 0
dominant run = T2, 87.78% of target-first wins
dominant mint = WONKA, 71.11% of target-first wins
selected recommendation = A, proceed to Phase 9.4A.2 adapter correctness and diagnostics
closeout JSON size = 149 KB (runner cycles omitted by default)
```

Phase 9.4A.1 is a read-only research-integrity phase. It consumes existing Phase 9.4 archives and
answers whether the current reports are counting, classifying, and attributing evidence correctly
before any runtime provider behavior changes.

It is the first half of Phase 9.4A:

```text
9.4A.1 Archive and reporting truthing
9.4A.2 Adapter correctness and diagnostics
```

Phase 9.4A.1 must not change provider runtime behavior. Raydium preflight fixes, HTTP attempt
telemetry, and `quote:diagnose` belong to Phase 9.4A.2.

## Why This Phase Exists

Phase 9.4 validated that selective Birdeye enrichment can run safely:

```text
validRuns = 3/3
observedDecisions = 115
uniqueMints = 14
orders/fills/positions = 0
readiness = PROMISING_RESEARCH
controlledPaperPilotRecommended = no
```

But the Phase 9.4 aggregate exposed reporting and attribution gaps:

```text
BIRDEYE failures include budget skips that should be policy skips.
missingQuote is too broad.
quote evidence does not clearly split buy quote, sell quote, round trip, and price impact.
report row limits may hide available evidence.
Birdeye enriched-mint counts and CU attribution are not explicit enough.
the strongest observed outcomes were concentrated in one run and one mint.
```

Phase 9.4A.1 exists to make the research evidence trustworthy before deciding whether Phase 9.4B,
Phase 9.5, Phase 9.26, or profile changes are the right next move.

## Phase Boundary

Phase 9.4A.1 may:

- Read archived TerminalRunner output folders.
- Open archived paper databases in read-only mode.
- Read archived text and JSON report artifacts.
- Add reporting/truthing services and formatters.
- Add a read-only CLI command.
- Write new report artifacts under ignored `data/` paths.
- Update docs and tests.

Phase 9.4A.1 must not:

- Run scanner, risk, strategy, shadow observe, paper execute, paper sell, exits, or TerminalRunner
  as part of normal validation.
- Reset or migrate the database.
- Mutate any archived database.
- Create or update `TokenRadar`, `RiskAssessment`, `StrategyDecision`, `Order`, `Fill`,
  `Position`, `EquitySnapshot`, or `PositionSnapshot` rows.
- Make live provider calls.
- Change provider ordering.
- Change quote-router behavior.
- Change strategy scores, profile thresholds, or promotion gates.
- Enable paper BUY automation.
- Load wallets, sign transactions, or submit transactions.

## Source Archives

Default Phase 9.4 input set:

```text
data/archive/phase9.4/test1-phase9.4-test1-20260804-0810
data/archive/phase9.4/test2-phase9.4-test2-20260804-1408
data/archive/phase9.4/test3-phase9.4-test3-20260804-1713
```

Existing aggregate reference:

```text
data/archive/phase9.4/aggregate-phase9.4-20260804-2016
```

The implementation should support arbitrary labeled archives, but the first validation should use
the three Phase 9.4 full runs above.

## Command Shape

Add a new command:

```bash
pnpm research:truth --once
```

Recommended full command:

```powershell
corepack pnpm research:truth --once `
  --label-run=T1:data/archive/phase9.4/test1-phase9.4-test1-20260804-0810 `
  --label-run=T2:data/archive/phase9.4/test2-phase9.4-test2-20260804-1408 `
  --label-run=T3:data/archive/phase9.4/test3-phase9.4-test3-20260804-1713 `
  --output-dir=data/phase9.4A.1-truthing
```

Recommended options:

```text
--once
--json
--label-run=<label>:<archivePath>       repeatable
--output-dir=<path>
--dedupe-mode=decision|mint|first_per_mint|best_per_mint
--source-decisions=BUY,WATCH,SKIP
--min-score=0
--target-pcts=10,15,25
--stop-pcts=10,15,25
--max-hold-minutes=15,30,60,120
--top-limit=25
--market-window-minutes=60
--require-terminal-json=true
--require-db=true
--include-runner-cycles                 optional; false by default
```

Defaults:

```text
dedupeMode = decision
sourceDecisions = BUY,WATCH,SKIP
minScore = 0
targetPcts = 10,15,25
stopPcts = 10,15,25
maxHoldMinutes = 15,30,60,120
topLimit = 25
marketWindowMinutes = 60
requireTerminalJson = true
requireDb = true
```

## Proposed Files

Add:

```text
backend/src/research-truthing/ResearchTruthingConfig.ts
backend/src/research-truthing/ResearchTruthingTypes.ts
backend/src/research-truthing/ArchiveDatabaseTruthService.ts
backend/src/research-truthing/ReportLimitTruthService.ts
backend/src/research-truthing/QuoteEvidenceTruthService.ts
backend/src/research-truthing/BirdeyeTruthService.ts
backend/src/research-truthing/ConcentrationTruthService.ts
backend/src/research-truthing/ScenarioPortfolioAuditService.ts
backend/src/research-truthing/ResearchTruthingRunner.ts
backend/src/research-truthing/ResearchTruthingReportFormatter.ts
backend/src/research-truthing/ResearchTruthingConfig.test.ts
backend/src/research-truthing/ResearchTruthingServices.test.ts
backend/src/scripts/research-truth.ts
```

Modify:

```text
package.json
backend/package.json
docs/ROADMAP_Phase9Plus.md
docs/Structure_Phase9Plus.md
docs/DECISIONS_Phase9Plus.md
docs/Phase-9-Planning-Inputs.md
docs/Provider-Strategy-Phase9Plus.md
```

Reuse when practical:

```text
backend/src/research/ResearchRunArchiveLoader.ts
backend/src/research/CrossRunResearchService.ts
backend/src/research-interpretation/ResearchInterpretationRunner.ts
backend/src/research-interpretation/ProviderInterpretationService.ts
backend/src/calibration/ProviderImpactAnalyzer.ts
backend/src/calibration/ForwardReturnAnalyzer.ts
backend/src/shadow-calibration/ShadowCalibrationReportService.ts
backend/src/shadow-entry/ShadowEntryReportService.ts
```

Do not create a database migration for Phase 9.4A.1.

## Output Report Sections

The text and JSON report should include:

```text
Safety Boundary
Input Archive Inventory
Archive Database Counts
TerminalRunner Artifact Counts
Report Limit And Truncation Audit
Decision Row Truth Table
Quote Evidence Attribution
Birdeye Attribution
Provider Failure Reclassification
Enriched Versus Eligible-Control Outcomes
Concentration Analysis
Leave-One-Run-Out Analysis
Leave-One-Mint-Out Analysis
Blocker Classification Audit
Scenario Portfolio Audit
Truthing Findings
Phase 9.4A.2 / 9.4B Recommendation Gate
```

Every report section that limits rows must disclose:

```text
rowsAvailable
rowsEvaluated
rowsDisplayed
displayLimit
displayTruncated
omittedDisplayRows
```

## Closeout Patch

The Phase 9.4A.1 closeout patch keeps the phase read-only and corrects report interpretation only:

```text
Runner cycles are omitted from generated research-truth JSON by default.
The original TerminalRunner JSON remains the canonical full-cycle artifact.
--include-runner-cycles explicitly opts in to copying those cycles.

Birdeye CU total = only live price calls plus live overview calls.
Cache hits and local CU-budget guardrail skips contribute zero estimated CU.
Raw per-run cumulative CU remains separately reported as provider-recorded context.

Missing-quote explanation confidence = DIRECT | CORRELATED |
INSUFFICIENT_ARCHIVE_EVIDENCE | UNCLASSIFIED.
Run-level provider pressure is correlation, never candidate-level proof.

Blocker score gates use archived session strategy thresholds when present; otherwise they use
the current default WATCH=70 and BUY=90 values.
```

## Implementation Chunks

### Chunk 1 - Config And CLI

Tasks:

- Add `ResearchTruthingConfig.ts`.
- Add `ResearchTruthingConfig.test.ts`.
- Add `backend/src/scripts/research-truth.ts`.
- Add backend and root package scripts:

```json
{
  "research:truth": "pnpm --filter @nexustrade/backend research:truth"
}
```

CLI validation:

- `--once` is accepted; loop mode is not supported.
- At least one `--label-run` is required.
- `--label-run` labels must be unique.
- Archive paths must exist and be directories.
- `--dedupe-mode` must be one of `decision`, `mint`, `first_per_mint`, or `best_per_mint`.
- `--source-decisions` must only contain valid strategy decisions.
- Numeric lists must be positive.
- `--top-limit` must be positive.
- `--market-window-minutes` must be positive.

Acceptance:

```text
Invalid options fail with clear messages.
Valid Phase 9.4 archive labels parse successfully.
The command can emit text or JSON.
The command writes artifacts only when --output-dir is supplied.
```

### Chunk 2 - Archive Inventory And Read-Only Database Access

Tasks:

- Reuse or extend `ResearchRunArchiveLoader`.
- Locate each archive's:

```text
nexus_paper.db
terminal_*.json
terminal_*.txt
analytics tail report
calibration tail report
shadow calibration tail report
transcript
```

- Open archived SQLite databases in read-only mode.
- Count core tables directly from each archived database:

```text
sessions
tokenRadar
riskAssessments
strategyDecisions
watchlistObservations / shadow observations, if table exists
orders
fills
positions
providerHealth
systemLogs, if needed for diagnostics
```

- Detect the TerminalRunner session id and verify one-session behavior.
- Compare database counts to any counts printed in terminal/report artifacts.

Acceptance:

```text
Archived DBs are never opened read-write.
Missing optional report artifacts are reported as coverage gaps, not crashes.
orders/fills/positions must be 0 for the Phase 9.4 archive set.
Full-session DB counts are the source of truth when report artifacts disagree.
```

### Chunk 3 - Report Limit And Truncation Audit

Tasks:

- Identify every existing report section that uses a top-N or row limit.
- Add a shared limit metadata shape:

```text
sectionName
rowsAvailable
rowsEvaluated
rowsDisplayed
displayLimit
displayTruncated
omittedDisplayRows
dedupeMode
```

- Surface this metadata in:

```text
research:truth text output
research:truth JSON output
research:aggregate, if the current formatter hides row limits
research:interpret, if the current formatter hides row limits
analytics:report, where applicable
calibration:report, where applicable
shadow:calibrate, where applicable
```

Phase 9.4A.1 does not need to rewrite every report formatter if a single truthing report can expose
the missing limit metadata for the Phase 9.4 archive set. Formatter changes should remain small and
localized.

Acceptance:

```text
No top-N table can be mistaken for a full dataset.
Text output clearly says when a section is truncated.
JSON output exposes limit metadata for dashboard consumption.
```

### Chunk 4 - Decision Row Truth Table

Tasks:

- Build a normalized decision row from archived data:

```text
runLabel
sessionId
decisionId
mintAddress
symbol
decision
score
decidedAt
riskResult
tokenRadarStatus
liquidityUsd
volume5mUsd
volume1hUsd
ageSeconds
observedReturnCoverage
bestReturnPct
worstReturnPct
targetBeforeStop results
provider evidence summary
Birdeye enrichment summary
blocker summary
```

- Support dedupe modes:

```text
decision
mint
first_per_mint
best_per_mint
```

- Define `considered` consistently as:

```text
unique StrategyDecision evaluated after the selected dedupe mode
```

Acceptance:

```text
Decision-mode count matches archived StrategyDecision rows included by filters.
Mint-level modes report unique mint counts separately from decision counts.
Unobserved decisions remain visible as coverage gaps.
```

### Chunk 5 - Quote Evidence Attribution

Tasks:

- Replace broad `missingQuote` reporting inside the truthing report with explicit fields:

```text
buyQuoteAvailable
sellQuoteAvailable
roundTripQuoteAvailable
buyPriceImpactAvailable
sellPriceImpactAvailable
roundTripImpactAvailable
buyQuoteProvider
sellQuoteProvider
buyQuoteSourceType
sellQuoteSourceType
buyQuoteFailureReason
sellQuoteFailureReason
quotePresentButImpactMissing
missingQuoteCategory
missingQuoteExplanationConfidence
missingQuoteExplanation
```

Recommended missing quote categories:

```text
NO_BUY_QUOTE
NO_SELL_QUOTE
NO_ROUND_TRIP_QUOTE
PRICE_IMPACT_MISSING
PROVIDER_RATE_LIMITED
ROUTER_COOLDOWN
PROVIDER_UNAVAILABLE
ROUTE_UNSUPPORTED
POLICY_SKIPPED
BIRDEYE_MARKET_DATA_ONLY
INSUFFICIENT_ARCHIVE_EVIDENCE
UNEXPLAINED
```

Rules:

- Birdeye price or overview evidence must never count as executable quote evidence.
- Cached Jupiter/Raydium quotes count as quote evidence but must remain labeled as cached.
- Router cooldown skips explain missing quote pressure but are not live provider failures.
- If archived Phase 9.4 data cannot separate buy from sell quote, classify the gap as
  `INSUFFICIENT_ARCHIVE_EVIDENCE` instead of pretending to know.
- The success target is:

```text
unclassifiedMissingQuote ~= 0
```

Acceptance:

```text
The report separates quote availability from price-impact availability.
The report separates buy, sell, and round-trip quote evidence when archived data allows it.
No row with known provider/cooldown/policy explanation is classified as UNEXPLAINED.
```

### Chunk 6 - Birdeye Attribution And CU Truthing

Tasks:

- Identify Birdeye evidence from ProviderHealth context and archived enrichment data.
- Report:

```text
Birdeye live calls
Birdeye cache hits
Birdeye endpoint distribution
Birdeye estimated CU by endpoint
Birdeye estimated CU total
Birdeye estimated CU per run
unique Birdeye enriched mints
Birdeye selected-candidate reasons
Birdeye budget skips
Birdeye policy skips
Birdeye provider failures
Birdeye enriched versus non-enriched outcomes
Birdeye enriched versus eligible-control outcomes
```

- Reclassify `BIRDEYE_CU_BUDGET_EXHAUSTED` as a policy/budget skip in the truthing report, not a
  provider outage.
- Preserve raw provider failure counts separately from policy skip counts.
- Disclose whether exact CU was computed from endpoint costs, ProviderHealth context, or a fallback
  estimate.

Acceptance:

```text
Birdeye budget exhaustion is not presented as external provider failure.
Birdeye CU totals reconcile with endpoint distributions.
Unique enriched mint count is visible.
Enriched versus eligible-control outcome comparison is visible.
```

### Chunk 7 - Eligible-Control Cohort

Tasks:

- Define a historical eligible-control cohort using the Phase 9.4 Birdeye selection policy:

```text
decision = WATCH
or score >= 50
or risk = PASS
or missingQuote = true with promising DexScreener liquidity/volume
```

- Split candidates into:

```text
Birdeye enriched
Birdeye eligible but not enriched
not Birdeye eligible
```

- For each cohort, report:

```text
count
unique mints
average score
average best return
average worst return
target-before-stop rates
drawdown-first rates
quote evidence coverage
authority evidence coverage
```

Rules:

- This is observational, not proof that Birdeye caused better or worse outcomes.
- The report must label the cohort as historical/observational.

Acceptance:

```text
The report can answer whether Birdeye was spent on candidates that were already high-intent.
The report can answer whether Birdeye-enriched rows were concentrated in one mint/run.
```

### Chunk 8 - Concentration Analysis

Tasks:

- Compute run-level concentration:

```text
observed decisions by run
target-first wins by run
best-return contribution by run
worst-return contribution by run
Birdeye enriched rows by run
quote-available rows by run
```

- Compute mint-level concentration:

```text
observed decisions by mint
target-first wins by mint
best-return contribution by mint
worst-return contribution by mint
Birdeye enriched rows by mint
quote-available rows by mint
```

- Highlight known Phase 9.4 caveats:

```text
Test2 concentration
WONKA concentration
BUY55 and BUY65 same observed set
```

Acceptance:

```text
The report explicitly shows whether one run or one mint dominates the result.
No promotion-oriented recommendation can ignore concentration caveats.
```

### Chunk 9 - Leave-One-Run-Out And Leave-One-Mint-Out Analysis

Tasks:

- Recalculate the main outcome metrics while excluding each run one at a time:

```text
observed decisions
unique mints
quote coverage
Birdeye coverage
avg best return
avg worst return
target-before-stop rates
readiness implication
```

- Recalculate the same metrics while excluding each top-contribution mint one at a time.
- Always include a dedicated leave-WONKA-out row if WONKA appears in the input set.
- Always include a dedicated leave-Test2-out row if Test2 appears in the input set.

Acceptance:

```text
The report can show whether Phase 9.4 conclusions survive removal of the strongest run.
The report can show whether Phase 9.4 conclusions survive removal of the strongest mint.
```

### Chunk 10 - Blocker Classification Audit

Tasks:

- Reuse Phase 9.25 decision attribution where possible.
- Audit rows where:

```text
decision = SKIP and blockers = none
missingQuote = true but no quote failure reason is visible
score >= 65 but decision = SKIP
risk = PASS but decision = SKIP
quote available but price impact missing
Birdeye enriched but no Birdeye attribution appears in reports
```

- Classify `SKIP` with no blockers as:

```text
SCORE_THRESHOLD_ONLY
UNRESOLVED_STRATEGY_GATE
INSUFFICIENT_ARCHIVE_EVIDENCE
```

Avoid generic `UNKNOWN` unless no safer classification is possible.

Acceptance:

```text
The report gives counts and examples for unresolved strategy gates.
The report does not hide important skip reasons behind blockers=none.
```

### Chunk 11 - Scenario Portfolio Audit

Tasks:

- Recompute or verify scenario-portfolio rows used by `shadow:calibrate`.
- Ensure scenario rows disclose:

```text
entries considered
unique mints
configured target
configured stop
max hold
position size
start cash
ending cash
simulated P/L
goal reached
drawdown-first count
target-first count
unobserved count
truncated
```

- Add focused tests around target-before-stop ordering and row-limit behavior.

Rules:

- Scenario P/L is simulated shadow evidence, not realized paper P/L.
- Scenario portfolio output must not imply `paper:execute` ran.

Acceptance:

```text
Scenario portfolio math is deterministic.
Scenario rows cannot silently omit available decisions due to display limits.
orders/fills/positions remain 0.
```

### Chunk 12 - Provider Failure Reclassification

Tasks:

- Add truthing-only classification for provider health rows:

```text
LIVE_OK
LIVE_RATE_LIMITED
LIVE_PROVIDER_FAILURE
ROUTER_CACHE_HIT
ROUTER_COOLDOWN_SKIP
POLICY_BUDGET_SKIP
POLICY_DISABLED
DIAGNOSTIC_ONLY
UNKNOWN_OR_UNCLASSIFIED
```

- Apply it to:

```text
JUPITER
RAYDIUM
BIRDEYE
SOLANA_RPC
QUICKNODE_DAS
ALCHEMY_DAS
HELIUS, if present
DEXSCREENER
```

- Keep provider-specific diagnostics visible:

```text
raydiumFailures
raydiumPreflight
birdeyeEndpoints
birdeyeCache
birdeyeFailures
birdeyeReasons
authoritySources
mintAuthority
freezeAuthority
rpcCache
dasProviders
```

Acceptance:

```text
Policy skips are separated from live provider errors.
Diagnostic-only rows are not treated as quote success or quote failure.
Unknown provider rows are visible and countable.
```

### Chunk 13 - Report Formatter

Tasks:

- Add `ResearchTruthingReportFormatter.ts`.
- Text output should be human-readable and short enough for terminal review.
- JSON output should preserve detailed arrays for later dashboard work.
- Suggested top-level JSON shape:

```text
generatedAt
config
inputs
safety
archiveCounts
reportLimitAudit
decisionTruthTable
quoteEvidence
birdeyeAttribution
eligibleControl
concentration
leaveOneRunOut
leaveOneMintOut
blockerAudit
scenarioPortfolioAudit
providerReclassification
findings
recommendations
```

Acceptance:

```text
Text report includes the key findings first.
JSON report uses stable keys and deterministic ordering.
No API keys, raw auth headers, or unbounded raw provider payloads are emitted.
```

### Chunk 14 - Recommendation Gate

The report should end with one explicit next-step recommendation:

```text
A. Proceed to Phase 9.4A.2 adapter correctness and diagnostics
B. Proceed to Phase 9.4B quote-pressure reduction
C. Proceed to Phase 9.5 access-gated quote-provider research
D. Collect another validation batch
E. Revisit strategy interpretation or profile promotion
```

Default expected recommendation after 9.4A.1:

```text
A. Proceed to Phase 9.4A.2 adapter correctness and diagnostics
```

Reason:

```text
Phase 9.4A.1 should make the evidence clearer, but Raydium adapter correctness and quote-attempt
diagnostics still need to be fixed before runtime pressure work or provider expansion.
```

Acceptance:

```text
Exactly one primary recommendation is selected.
The recommendation includes evidence for and against.
The recommendation cannot enable paper BUY automation.
```

### Chunk 15 - Tests

Planned unit-test coverage:

```text
ResearchTruthingConfig.test.ts
ArchiveDatabaseTruthService.test.ts
ReportLimitTruthService.test.ts
QuoteEvidenceTruthService.test.ts
BirdeyeTruthService.test.ts
ConcentrationTruthService.test.ts
ScenarioPortfolioAuditService.test.ts
ResearchTruthingReportFormatter.test.ts
```

Implementation note: Phase 9.4A.1 consolidated this coverage into:

```text
backend/src/research-truthing/ResearchTruthingConfig.test.ts
backend/src/research-truthing/ResearchTruthingServices.test.ts
```

Those tests cover config parsing, duplicate-label rejection, report-limit metadata, quote-evidence
classification, Birdeye budget/caching attribution, provider reclassification, blocker
classification, and scenario target/stop ordering. The final archive smoke covers the CLI,
formatter, read-only DB loading, and actual Phase 9.4 archives.

Test fixtures should cover:

```text
one valid archive
multiple valid archives
missing optional reports
missing DB
missing TerminalRunner JSON
zero decision rows
nonzero orders/fills/positions safety violation
truncated report section
Birdeye budget exhaustion
Birdeye cache hit
cached Jupiter quote
router cooldown skip
quote available but price impact missing
SKIP with blockers=none
dominant run concentration
dominant mint concentration
leave-one-run-out
leave-one-mint-out
scenario portfolio target-before-stop ordering
```

Acceptance:

```text
Focused backend tests pass.
Full verify passes.
No test fixture writes to real archives.
```

### Chunk 16 - Docs And Runbook

Update:

```text
docs/ROADMAP_Phase9Plus.md
docs/Structure_Phase9Plus.md
docs/DECISIONS_Phase9Plus.md
docs/Phase-9-Planning-Inputs.md
docs/Provider-Strategy-Phase9Plus.md
```

Implemented notes:

```text
ResearchTruthingConfig and research:truth CLI were added.
Archived DBs are opened read-only/query-only.
Report-limit metadata now discloses rowsAvailable, rowsEvaluated, rowsDisplayed, displayLimit,
displayTruncated, and omittedDisplayRows for key top-N sections.
Quote truthing separates missing quote, price-impact missing, provider pressure, policy skips, and
insufficient archive evidence.
Birdeye truthing separates cache hits, live calls, budget guardrail skips, provider failures, CU
estimate, endpoint use, and enriched/control cohorts.
Provider reclassification separates live provider failures from router cache/cooldown, policy, and
diagnostic-only rows.
Concentration and scenario-portfolio audits are produced from archived evidence only.
```

Add a short validation runbook after implementation.

Expected validation shape:

```powershell
cd U:\Projects\NeXusTrade-Otis

corepack pnpm verify

$run = "phase9.4A.1-truth-$(Get-Date -Format 'yyyyMMdd-HHmm')"

corepack pnpm research:truth --once `
  --label-run=T1:data/archive/phase9.4/test1-phase9.4-test1-20260804-0810 `
  --label-run=T2:data/archive/phase9.4/test2-phase9.4-test2-20260804-1408 `
  --label-run=T3:data/archive/phase9.4/test3-phase9.4-test3-20260804-1713 `
  --output-dir="data\$run"

$archive = "data\archive\phase9.4A.1\$run"

New-Item -ItemType Directory -Force -Path $archive
Copy-Item "data\$run" $archive -Recurse -Force
```

No long scanner or TerminalRunner validation is required for Phase 9.4A.1.

## Success Criteria

Phase 9.4A.1 succeeds when:

```text
corepack pnpm verify passes.
research:truth runs against the three Phase 9.4 archives.
archived databases are opened read-only.
orders/fills/positions remain 0.
full-session database counts are visible.
report truncation metadata is visible.
decision, mint, first_per_mint, and best_per_mint modes work.
buy, sell, round-trip, and price-impact quote evidence are separated where archive evidence allows.
Missing-quote evidence is labeled DIRECT, CORRELATED, INSUFFICIENT_ARCHIVE_EVIDENCE, or
UNCLASSIFIED; run-level provider pressure is not candidate-level proof.
Birdeye budget skips are separated from live provider failures.
Birdeye estimated CU and unique enriched mints are visible.
Birdeye enriched versus eligible-control outcomes are visible.
leave-Test2-out and leave-WONKA-out results are visible when applicable.
blockers=none rows are audited and reclassified when possible.
scenario-portfolio calculations have focused tests.
the report selects exactly one next-step recommendation.
paper BUY automation remains disabled.
no live provider calls are made by the truthing command.
```

## Expected Outcomes

Expected:

```text
Phase 9.4A.1 will not make the strategy more profitable.
Phase 9.4A.1 will make the evidence less ambiguous.
The likely next recommendation will be Phase 9.4A.2.
```

Possible outcomes:

```text
Outcome A: Most missing quote rows are explained by cooldown, budget, or unsupported route.
  Continue to 9.4A.2, then 9.4B for demand and scheduler fixes.

Outcome B: Many missing quote rows remain unclassified or lack candidate-level evidence.
  Prioritize 9.4A.2 diagnostics before any provider expansion.

Outcome C: Birdeye enrichment appears useful but highly concentrated.
  Keep Birdeye selective and require more validation before strategy changes.

Outcome D: Report truncation materially changed interpretation.
  Fix report surfaces before making strategy or provider decisions.
```

## Handoff To Phase 9.4A.2

Phase 9.4A.1 should produce enough evidence for Phase 9.4A.2 to target the right adapter fixes:

```text
which quote gaps have only correlated or insufficient archive evidence
which Raydium failures are deterministic versus ambiguous
which provider rows need HTTP-attempt telemetry
which quote evidence should preserve latest attempt versus last success
which mints deserve quote:diagnose smoke coverage
```

## Handoff To Phase 9.4B

Phase 9.4B should not start until Phase 9.4A.1 and Phase 9.4A.2 show that measurements are
trustworthy.

Phase 9.4B should consume:

```text
classified missing quote reasons
duplicate quote-demand evidence
cache hit/miss evidence
cooldown skip evidence
provider failure categories
latest-attempt versus last-successful quote gaps
```

## Final Safety Reminder

Phase 9.4A.1 is truthing, not trading.

```text
No paper BUY.
No paper SELL.
No live trading.
No wallet.
No provider calls.
No database mutation.
No strategy promotion.
```
