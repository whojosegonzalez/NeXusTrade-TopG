# NeXusTrade Phase 9.2B Detailed Checklist

Provider truthing and Jupiter metadata pressure cleanup

Last updated: July 2026

## Status

Implemented.

Phase 9.2B is a measurement-cleanup phase between Phase 9.2 and Phase 9.25. It should make provider
pressure reports trustworthy before strategy interpretation work begins.

Implementation completed:

```text
ProviderPressureClassifier added
live-vs-router provider pressure metrics added to TerminalRunner, analytics, calibration, and research aggregate reports
PromotionGate Jupiter caution now uses live provider rate limits
JUPITER_TOKEN_METADATA_ENABLED defaults to false
Helius token metadata is preferred before optional Jupiter metadata
QUOTE_CACHE_TTL_MS default raised to 90000
research archive loader accepts nested run-output folders
paper BUY automation remains disabled
```

## Why This Phase Exists

Five Phase 9.2 validation runs were mechanically valid:

```text
validRuns = 5/5
oneSession = yes for all runs
safety = PASS for all runs
orders/fills/positions = 0
observedDecisions = 321
uniqueMints = 14
readiness = PROMISING_RESEARCH
paperBuyAutomationEnabled = no
```

The five-run evidence changed the next highest-value work:

```text
Quote cooldown skips are working.
Quote cache hits were 0.
Provider reports mixed live Jupiter rate limits with router cooldown skips.
Most live Jupiter pressure came from token-metadata-from-price, not quotes.
Tests 3 and 5 were valid low-signal windows, not broken runs.
Test 4 produced most of the target-first wins.
```

Phase 9.2B should clean this up before Phase 9.25 investigates skipped opportunities and before
Phase 9.3 adds Raydium.

## Non-Goals

Phase 9.2B must not:

- enable paper BUY automation,
- call `paper:execute` from TerminalRunner,
- change production strategy score weights,
- change strategy thresholds,
- promote a profile,
- add Raydium,
- add Birdeye,
- add Titan or Autobahn,
- add Meteora or Orca,
- add paid-provider dependencies,
- add wallet loading,
- sign transactions,
- submit transactions,
- add a database migration unless implementation proves it is unavoidable.

## Source Evidence

Phase 9.2 five-run aggregate:

```text
T1: cycles=57 scannerStored=887 strategyWritten=246
T2: cycles=76 scannerStored=908 strategyWritten=194
T3: cycles=107 scannerStored=933 strategyWritten=168
T4: cycles=56 scannerStored=629 strategyWritten=349
T5: cycles=62 scannerStored=847 strategyWritten=26
```

Threshold result:

```text
BUY65 observedBUY = 146
unique = 6
avgBest = +77.9996%
avgWorst = -12.3651%
hit10 = 89.0411%
hit25 = 66.4384%
```

Promotion blocker:

```text
76.8473% of target-first wins came from T4
```

Quote router evidence:

```text
cooldown skips:
T1 = 776
T2 = 772
T3 = 784
T4 = 676
T5 = 681

cache hits = 0
```

Live Jupiter pressure:

```text
Jupiter live quote rate limits per run: roughly 141-169
Jupiter token-metadata-from-price rate limits per run: roughly 814-1096
```

Interpretation:

```text
Phase 9.2 improved the quote path but did not solve the larger Jupiter bottleneck.
The larger bottleneck is currently Jupiter token metadata via Price API.
Provider reports need to distinguish live provider failures from router cooldown skips.
```

## Implementation Chunks

### 1. Add Provider Pressure Classification

Create a small classification layer for provider-health rows.

Proposed file:

```text
backend/src/providers/ProviderPressureClassifier.ts
```

Classify each row as:

```text
LIVE_PROVIDER
ROUTER_CACHE
ROUTER_COOLDOWN
ROUTER_UNAVAILABLE
ROUTER_OTHER
DISABLED
```

Classification rules:

- If `contextJson.quoteSource = CACHE`, classify as `ROUTER_CACHE`.
- If `contextJson.quoteSource = SKIPPED_COOLDOWN`, classify as `ROUTER_COOLDOWN`.
- If `contextJson.quoteSource = UNAVAILABLE`, classify as `ROUTER_UNAVAILABLE`.
- If `contextJson.quoteSource` exists but is none of the above, classify as `ROUTER_OTHER`.
- If status is `DISABLED`, classify as `DISABLED`.
- Otherwise classify as `LIVE_PROVIDER`.

Acceptance tests:

- Live Jupiter quote rows classify as `LIVE_PROVIDER`.
- Jupiter cooldown skip rows classify as `ROUTER_COOLDOWN`.
- Quote cache rows classify as `ROUTER_CACHE`.
- Disabled provider rows classify as `DISABLED`.
- Invalid or empty context falls back to `LIVE_PROVIDER`.

Status: Implemented in `backend/src/providers/ProviderPressureClassifier.ts` with tests in
`backend/src/providers/ProviderPressureClassifier.test.ts`.

### 2. Split Provider Pressure Metrics

Update provider pressure summaries to separate live provider behavior from router behavior.

Likely files:

```text
backend/src/terminal-runner/TerminalRunSummary.ts
backend/src/research/CrossRunResearchService.ts
backend/src/analytics/AnalyticsReportService.ts
backend/src/calibration/ProviderImpactAnalyzer.ts
```

Required metrics:

```text
totalRows
liveRows
routerRows
liveOk
liveDegraded
liveRateLimited
liveError
liveRateLimitedPct
routerCacheHits
routerCooldownSkips
routerUnavailable
routerCooldownSkipPct
combinedRateLimitedPct
```

Rules:

- Keep old combined totals where useful for backward compatibility.
- Label old combined rate-limit percentages as combined, not live.
- Promotion-gate cautions should use `liveRateLimitedPct`, not combined router+live rate limits.
- Reports should still show router cooldown skips because they represent avoided live calls.
- Do not hide missing quote evidence.

Acceptance tests:

- A mixed set of live rows and router cooldown rows reports both separately.
- `liveRateLimitedPct` excludes router cooldown skips.
- `routerCooldownSkips` counts cooldown rows.
- Existing report format still renders without crashing when old archives lack quote-router context.

Status: Implemented in TerminalRunner, analytics, calibration, shadow calibration, research
aggregate, and promotion-gate reporting.

### 3. Reduce Jupiter Metadata Pressure

Change metadata provider behavior so Jupiter is not the default token-metadata source during Phase
9.x research.

Preferred implementation:

```text
HELIUS token metadata first
JUPITER token metadata disabled by default or used only as explicit fallback
```

Proposed config:

```text
JUPITER_TOKEN_METADATA_ENABLED=false
```

Implementation options:

- Make `JupiterAdapter.capabilities` conditional so it exposes `TOKEN_METADATA` only when enabled.
- Or keep the adapter unchanged but have `ProviderRegistry.getTokenMetadataProviders()` return
  Helius before Jupiter and omit Jupiter metadata unless explicitly enabled.

Rules:

- Jupiter must remain available for quotes.
- Jupiter may remain available for price if the current code still needs it.
- Helius remains the primary metadata/risk provider when the key is configured.
- If Helius is disabled and Jupiter metadata is also disabled, enrichment should still succeed with
  identity from DexScreener price/liquidity where available.
- Do not add Birdeye in this phase.

Acceptance tests:

- Default config disables Jupiter token metadata.
- With Helius and Jupiter enabled, token metadata provider order prefers Helius and does not call
  Jupiter for metadata first.
- Enabling `JUPITER_TOKEN_METADATA_ENABLED=true` restores Jupiter token metadata fallback.
- Jupiter quote provider remains enabled when Jupiter metadata is disabled.

Status: Implemented with conditional Jupiter `TOKEN_METADATA` capability and Helius-first metadata
provider ordering.

### 4. Tune Quote Cache TTL For TerminalRunner Cadence

Phase 9.2 used:

```text
QUOTE_CACHE_TTL_MS=15000
```

With a 60-second TerminalRunner interval, this produced:

```text
cacheHits = 0
```

Phase 9.2B should adjust the research default:

```text
QUOTE_CACHE_TTL_MS=90000
```

Rules:

- Keep cache in-memory only.
- Cache only successful quote results.
- Keep `QUOTE_CACHE_TTL_MS` configurable.
- Document that later paper/live execution must require fresh execution quotes regardless of
  research cache settings.
- Do not use cached quotes as proof of executable fill quality.

Acceptance tests:

- Default TTL is 90 seconds.
- Env override still works.
- Cache hits occur for identical requests within the TTL.
- Expired entries are not used.

Status: Implemented by changing the default quote cache TTL from 15 seconds to 90 seconds while
keeping the env override.

### 5. Make Archive Loading More Forgiving

The Phase 9.2 runbook archived TerminalRunner outputs as:

```text
archive-root/<run-label>/*.json
```

but `research:aggregate` expected:

```text
archive-root/runner-output/*.json
```

Update archive loading to accept both shapes.

Likely file:

```text
backend/src/research/ResearchRunArchiveLoader.ts
```

Supported shapes:

```text
archive-root/runner-output/*.json
archive-root/<single-child-run-folder>/*.json
archive-root/*.json
```

Rules:

- Keep current `runner-output` shape as preferred.
- If multiple candidate run-output folders exist, fail clearly instead of guessing.
- Do not mutate archives.
- Preserve optional tail report discovery at the archive root.

Acceptance tests:

- Existing `runner-output` archive still loads.
- Nested run-label archive loads.
- Missing DB still fails.
- Multiple nested JSON folders fail with a clear message.

Status: Implemented in `backend/src/research/ResearchRunArchiveLoader.ts` with nested archive
loader tests.

### 6. Add Phase 9.2B Provider Truth Report Section

Update text and JSON report output where practical.

Required report concepts:

```text
Provider Pressure
  live provider rows
  router rows
  live rate-limited percent
  router cooldown skips
  cache hits
  Jupiter metadata pressure
```

Specific Jupiter detail:

```text
Jupiter live quote rate limits
Jupiter live token-metadata-from-price rate limits
Jupiter router cooldown skips
Jupiter cache hits
```

Acceptance tests:

- Report text includes live-vs-router provider pressure.
- JSON output exposes live-vs-router metrics.
- Promotion caution mentions live rate limiting and cooldown skips separately.

Status: Implemented. Reports expose live rows, router rows, live rate limits, combined rate
limits, cache hits, and cooldown skips.

### 7. Preserve Safety Boundaries

Phase 9.2B remains research-only.

Required behavior:

- TerminalRunner remains shadow-only by default.
- `paper:execute` remains excluded.
- No wallet loading.
- No signing.
- No transaction submission.
- No orders.
- No fills.
- No positions.
- No strategy profile promotion.

Acceptance tests:

- Existing TerminalRunner safety tests still pass.
- Existing research aggregate safety output remains explicit.

Status: Implemented. No paper execution surfaces were added to TerminalRunner.

### 8. Documentation Updates

Update:

```text
docs/ROADMAP_Phase9Plus.md
docs/DECISIONS_Phase9Plus.md
docs/Structure_Phase9Plus.md
docs/Phase-9-Planning-Inputs.md
docs/Provider-Strategy-Phase9Plus.md
```

Required documentation:

- Phase 9.2B inserted before Phase 9.25 and Phase 9.3.
- Phase 9.25 planned as research interpretation and skipped-opportunity diagnostics.
- Raydium remains planned, but after provider truthing and research interpretation.
- Phase 9.2B does not change strategy defaults.

Status: Implemented in the active Phase 9+ docs.

## Implementation Order

1. Add provider pressure classifier and tests.
2. Update report/provider-pressure summaries to split live provider rows from router rows.
3. Add Jupiter token metadata config and prefer Helius/default-disable Jupiter metadata.
4. Change quote cache default TTL to 90 seconds.
5. Make research archive loading support nested run-output folders.
6. Update report text/JSON and tests.
7. Update docs.
8. Run verification.

## Verification Commands

Required:

```bash
corepack pnpm verify
```

Implementation verification completed locally:

```text
corepack pnpm typecheck
corepack pnpm test
```

`corepack pnpm verify` should still be run before commit as the final full-project gate.

Useful focused checks:

```bash
corepack pnpm --filter @nexustrade/backend test
corepack pnpm --filter @nexustrade/backend typecheck
corepack pnpm research:aggregate --once \
  --label-run=T1:data/archive/phase9.2/test1-phase9.2-test1-20260711-1245 \
  --label-run=T2:data/archive/phase9.2/test2-phase9.2-test2-20260711-1652 \
  --label-run=T3:data/archive/phase9.2/test3-phase9.2-test3-20260711-1958 \
  --label-run=T4:data/archive/phase9.2/test4-phase9.2-test4-20260712-1554 \
  --label-run=T5:data/archive/phase9.2/test5-phase9.2-test5-20260712-2001
```

The aggregate command should work directly against the existing archives after archive-loader
cleanup, without temporary normalized folders.

## Post-Implementation Validation

Yes, Phase 9.2B needs more tests after implementation.

Run:

```text
1 short smoke run
3 full validation runs
```

Short smoke:

```powershell
corepack pnpm db:reset:paper
corepack pnpm terminal:run --cycles=2 --interval-ms=60000 --output-dir=data/phase9.2B-smoke
```

Full validation should use the Phase 9.2 runbook shape:

```powershell
corepack pnpm db:reset:paper
$run = "phase9.2B-test1-$(Get-Date -Format 'yyyyMMdd-HHmm')"
Start-Transcript -Path "data\$run-transcript.txt"
corepack pnpm terminal:run --max-runtime-minutes=120 --interval-ms=60000 --output-dir="data\$run"
Start-Sleep -Seconds 3600
corepack pnpm watchlist:returns --once
corepack pnpm analytics:report --once | Tee-Object "data\$run-analytics-tail60.txt"
corepack pnpm calibration:report --once --max-hold-minutes=120 | Tee-Object "data\$run-calibration-tail60.txt"
corepack pnpm shadow:calibrate --once | Tee-Object "data\$run-shadow-calibrate-tail60.txt"
Stop-Transcript
```

Archive each run under:

```text
data/archive/phase9.2B/
```

Three full runs are recommended because Phase 9.2B changes measurement and provider load. More than
three is optional unless one run is mechanically invalid.

Success criteria:

```text
live Jupiter rate-limit percent is separated from router cooldown skips
Jupiter token-metadata-from-price pressure drops materially
quote cache hits are greater than 0 when repeated identical requests occur
reports clearly show cache hits, cooldown skips, and live rate limits separately
no safety regression
orders/fills/positions remain 0
```

## Handoff To Phase 9.25

Phase 9.25 should start after Phase 9.2B validation confirms provider data is trustworthy.

Phase 9.25 scope:

```text
high-scoring SKIP explanation
SKIP reason clustering
WARN condition outcome analysis
missing quote outcome analysis
market-window analytics
per-token skipped opportunity breakdown
```

Phase 9.25 should not add Raydium or change production strategy defaults. It should interpret the
cleaned research data and decide what strategy/provider work is justified next.
