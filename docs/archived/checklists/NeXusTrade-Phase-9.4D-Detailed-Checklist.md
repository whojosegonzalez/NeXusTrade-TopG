# NeXusTrade Phase 9.4D Detailed Checklist

Quote budget allocation and candidate prioritization

Last updated: August 2026

## Status

Implementation and runtime validation are complete.

```text
9.4B  quote-pressure reduction                 -> complete
9.4C  shared adaptive Jupiter demand control   -> complete and runtime-validated
9.4D  quote budget allocation                  -> complete and runtime-validated
9.5   additional aggregate quote providers     -> deferred pending 9.4D evidence
```

## Objective

Spend constrained executable-quote capacity on the most research-relevant candidates before a
request reaches `QuoteProviderRouter`.

```text
Current
  scanner candidates
  -> risk refresh attempts to enrich every selected candidate
  -> shared Jupiter controller allows or defers each quote
  -> Raydium is attempted only under its venue policy

Phase 9.4D
  scanner candidates
  -> deterministic quote-budget planner
  -> selected candidates request router quotes
  -> non-selected candidates receive explicit local quote-budget evidence
  -> existing Jupiter controller and Raydium venue guard remain authoritative
```

This is a provider-demand and evidence-quality phase. It must not alter strategy scoring,
shadow-entry profiles, risk thresholds, exit rules, or paper execution behavior.

## Evidence That Motivates This Phase

Phase 9.4C full PAPER/shadow-only validation completed two valid 120-minute runs.

```text
Safety:                 PASS in both runs
Paper execution:        orders=0, fills=0, positions=0
Jupiter live 429s:      0% in both runs
Jupiter controller:     5,473 live requests allowed across the two runs
Jupiter local deferral: 856 requests, primarily DEFERRED_WINDOW_BUDGET
Raydium fallback:       correctly venue-guard skipped; no observed Raydium venue
```

The controller is healthy: it protects the free-tier upstream allowance. The remaining gap is
that the risk stage can still request more executable quotes than the safe per-cycle allowance.
Phase 9.4D must reduce _unnecessary demand_, not raise the controller limit or disguise local
deferral as provider failure.

## Safety Boundary

Phase 9.4D may:

- Add process-local planning that selects a bounded subset of risk-stage candidates for quote
  enrichment.
- Use already stored scanner, TokenRadar, and prior risk evidence to rank quote demand.
- Persist sanitized quote-budget selection evidence through existing `RiskAssessment`,
  `ProviderHealth`, `SystemLog`, and run-artifact surfaces when practical.
- Add read-only diagnostic/reporting fields, configuration, deterministic tests, and docs.

Phase 9.4D must not:

- Add a new external provider, alter `JUPITER -> RAYDIUM`, or bypass `QuoteProviderRouter`.
- Change the shared Jupiter controller's hard rolling-window budget, adaptive behavior, or
  `Retry-After` handling.
- Treat a non-selected candidate as a Jupiter/Raydium error, an upstream rate limit, or a valid
  executable quote.
- Change scanner discovery, risk rules/thresholds, strategy score weights, BUY/WATCH thresholds,
  shadow profiles, or exit logic.
- Enable Helius for this validation, paper BUY/SELL, wallet loading, signing, transaction
  construction, or submission.
- Add a database migration, a persistent queue, or a background worker.
- Log API keys, raw URLs, raw headers, raw bodies, or raw provider payloads.

## Locked Design Decisions

```text
Planning location:       before risk-stage quote enrichment
Scope:                   one TerminalRunner risk cycle, process-local only
Default selected limit:  20 quote candidates per risk cycle
Selection input:         existing local evidence only; no additional live calls
Ordering:                deterministic, stable mint-address tie-break
Non-selected behavior:   refresh non-quote evidence where already supported; skip router quote
Evidence code:           QUOTE_BUDGET_NOT_SELECTED
Router order:            JUPITER -> RAYDIUM unchanged
Jupiter controller:      remains the final shared safety authority
Raydium guard:           remains the final fallback safety authority
Provider result status:  local selection outcome, never RATE_LIMITED
Default deployment:      enabled for TerminalRunner validation, configurable and fail-closed
```

`20` deliberately leaves headroom beneath the existing shared Jupiter allowance of `48` requests
per 60-second window. It accommodates low-priority price/diagnostic work and timing overlap at
the 60-second TerminalRunner cadence. It is a starting hypothesis, not a strategy threshold.

## Candidate Planning Contract

Add a small, deterministic planner such as:

```text
backend/src/providers/quotes/QuoteBudgetPlanner.ts
backend/src/providers/quotes/QuoteBudgetPlanner.test.ts
```

Suggested contracts:

```ts
type QuoteBudgetSelectionReason =
  | "SELECTED"
  | "QUOTE_BUDGET_NOT_SELECTED"
  | "QUOTE_BUDGET_DISABLED";

interface QuoteBudgetPlanEntry {
  readonly mintAddress: string;
  readonly selected: boolean;
  readonly selectionReason: QuoteBudgetSelectionReason;
  readonly rank?: number;
  readonly candidateScore?: number;
  readonly candidateSignals: readonly string[];
}

interface QuoteBudgetPlan {
  readonly candidateCount: number;
  readonly selectedCount: number;
  readonly notSelectedCount: number;
  readonly limit: number;
  readonly entriesByMint: ReadonlyMap<string, QuoteBudgetPlanEntry>;
}
```

Names may vary, but the public boundary must retain selected/not-selected, rank, configured limit,
and sanitized signal attribution.

### Deterministic Pre-Quote Ranking

The planner must consume only data already available to the risk selector/evaluation pass:

- candidate recency from `TokenRadar.discoveredAtMs`;
- current stored liquidity and volume fields from scanner/DexScreener mapping;
- stored pair age or creation timestamp when available;
- current `TokenRadar` status and duplicate/session identity;
- existing local price/pair presence; and
- latest stored risk assessment only when it exists before the current refresh.

It must not call Jupiter, Raydium, Birdeye, DexScreener, RPC, DAS, or any provider while ranking.

Use a transparent additive priority score with named reasons, for example:

```text
fresh candidate within risk recency window       + recency point(s)
liquidity present and above existing risk floor  + liquidity point(s)
volume present and above existing risk floor     + volume point(s)
pair age satisfies existing age floor            + age point(s)
previous local PASS/WARN evidence                + evidence point(s)
missing local pair/price evidence                - availability point(s)
```

The exact priority weights are _not_ a trading score and must be held in dedicated quote-budget
configuration. The design should avoid duplicating `StrategyScoringService`; its purpose is
efficient evidence collection, not deciding whether to buy.

When candidate scores tie, use deterministic tie-breakers in this order:

```text
newer discoveredAtMs
higher liquidityUsd if present
higher volumeH1Usd if present
lexical mintAddress
```

Document every fallback used when an optional field is absent.

## Risk Refresh Integration

Modify the risk refresh path rather than adding a second terminal stage.

Likely files:

```text
backend/src/risk/RiskEvaluationService.ts
backend/src/risk/RiskEvidenceRefreshService.ts
backend/src/risk/RiskConfig.ts
backend/src/risk/RiskRunner.ts
backend/src/terminal-runner/TerminalStageRunner.ts
```

Required behavior:

1. `RiskCandidateSelector` continues to select the existing configured candidate universe.
2. `RiskEvaluationService` builds one `QuoteBudgetPlan` for that selected batch before invoking
   refreshes.
3. Selected entries retain the current enrichment path, including the existing router and
   provenance behavior.
4. Non-selected entries must not invoke `MarketDataService` quote enrichment for the current
   cycle. Existing no-quote/non-quote evidence can still be evaluated without inventing a live
   result.
5. Risk evidence for a non-selected entry records a specific fact/note such as
   `quote_budget_not_selected`, the configured limit, batch candidate count, rank, and sanitized
   reason signals.
6. A missing quote caused by allocation must be distinguishable from `JUPITER_UNAVAILABLE`,
   `RAYDIUM_UNAVAILABLE`, `RATE_LIMITED`, negative cache, cooldown, and malformed routes.
7. No selected candidate may be silently dropped because the planner has an unexpected field
   shape. Invalid planner input must fall back deterministically to the documented conservative
   ordering and emit a sanitized warning.

The risk decision semantics must remain conservative:

```text
quote-budget not selected
  -> no executable quote was observed this cycle
  -> do not manufacture price impact
  -> do not call it PASS due to an absent quote
  -> preserve normal WARN/UNKNOWN behavior under current risk rules
```

## Configuration

Add settings under the existing provider/quote resilience configuration, with environment
validation and `.env.example` documentation:

```text
QUOTE_BUDGET_PLANNER_ENABLED=true
QUOTE_BUDGET_MAX_CANDIDATES_PER_CYCLE=20
QUOTE_BUDGET_RECENCY_WEIGHT=...
QUOTE_BUDGET_LIQUIDITY_WEIGHT=...
QUOTE_BUDGET_VOLUME_WEIGHT=...
QUOTE_BUDGET_AGE_WEIGHT=...
QUOTE_BUDGET_PRIOR_EVIDENCE_WEIGHT=...
```

Only introduce knobs that alter a clear, testable planning dimension. Keep a compact default
profile. Reject non-integers, negative limits/weights, or a zero maximum selected limit.

When disabled, retain the existing pre-9.4D behavior for isolated comparison only. TerminalRunner
validation must state whether the planner was enabled and which effective settings were used.

## Observability And Reporting

Add sanitized, separately counted quote-budget telemetry. Never infer it from a generic error.

```text
quoteBudgetCandidateCount
quoteBudgetSelectedCount
quoteBudgetNotSelectedCount
quoteBudgetLimit
quoteBudgetSelectionReasonCounts
quoteBudgetSignalCounts
quoteBudgetRankBucketCounts
quoteBudgetSkippedLiveCallsEstimate
```

Integrate into the existing local-evidence and run-report surfaces:

```text
TerminalRunSummary
AnalyticsReportService / formatter
research:aggregate
research:interpret
providers:smoke / quote:diagnose when practical
```

Rules:

- `QUOTE_BUDGET_NOT_SELECTED` is a local selection result, not an external provider failure.
- Report it beside, not inside, Jupiter controller deferrals.
- Preserve quote provenance for entries that did receive an actual router request.
- Report selection outcomes by run and by `JUPITER`, `RAYDIUM`, and router aggregate only when
  accurate; avoid attributing an unrequested quote to any provider.
- Include quote coverage: selected, quoted successfully, locally controller-deferred, fallback
  attempted, and no-route/no-venue separately.

## Tests

Add focused tests under the current Vitest conventions.

```text
backend/src/providers/quotes/QuoteBudgetPlanner.test.ts
backend/src/risk/RiskEvaluationService.test.ts
backend/src/terminal-runner/TerminalStageRunner.test.ts
backend/src/providers/ProviderPressureClassifier.test.ts
backend/src/analytics/AnalyticsReportService.test.ts
backend/src/research/CrossRunResearchService.test.ts
backend/src/research-interpretation/ProviderInterpretationService.test.ts
```

Minimum cases:

1. A batch above the limit selects exactly the configured count.
2. Ranking is deterministic across repeated calls and input ordering.
3. Tie-breaking is stable and documented.
4. Planner performs no provider calls.
5. A disabled planner preserves the prior all-selected behavior.
6. Non-selected candidates make no router/Jupiter/Raydium quote call.
7. Selected candidates retain existing router provenance and controller behavior.
8. `QUOTE_BUDGET_NOT_SELECTED` does not increment upstream rate-limited, provider error, or
   Raydium failure counts.
9. Controller deferral and planner non-selection remain separately counted in reports.
10. Empty/short candidate batches do not fail and do not create artificial selection skips.
11. PAPER-only guard remains intact; no orders, fills, positions, wallet, signing, or submission.
12. Existing Phase 9.4B/9.4C cache, negative-cache, single-flight, and venue-guard tests remain
    green.

## Implementation Order

### Chunk 1 - Contract And Config

- Add planner types, defaults, parsing, validation, and tests.
- Add `.env.example` entries and document effective defaults.
- Complete: planner config defaults and environment validation added under quote resilience.

### Chunk 2 - Deterministic Planner

- Implement pure ranking and plan construction.
- Add attribution signals and stable tie-breakers.
- Complete: tested normal, sparse/tied, disabled, and over-limit batches.

### Chunk 3 - Risk Refresh Gate

- Build the plan once per risk evaluation batch.
- Gate quote refreshes for non-selected candidates.
- Persist/evaluate explicit local allocation evidence without changing risk thresholds.
- Complete: non-selected entries refresh non-quote evidence only; selected entries retain the
  unchanged router/controller path.

### Chunk 4 - Telemetry And Reports

- Add local allocation counters to risk evidence and terminal-stage summaries.
- Propagate counters through analytics, aggregate, and interpretation reports.
- Complete: allocation telemetry is stored in `RiskAssessment.rawProviderDataJson`, TerminalRunner
  risk-stage counts, analytics, research aggregate, and research interpretation. It remains outside
  provider-pressure totals so it cannot be misreported as an upstream provider event.

### Chunk 5 - Diagnostics And Documentation

- Extend provider smoke and/or quote diagnostics with planner configuration and a bounded sample
  plan, without database mutation beyond existing smoke behavior.
- Complete: smoke, quote diagnostics, configuration example, and Phase 9+ documentation updated.

### Chunk 6 - Verification

- Complete: `corepack pnpm verify` passes (format, lint, typecheck, tests, and secrets; 304
  backend tests). Provider smoke, quote diagnostics, and the 30-minute reset-DB PAPER/shadow-only
  smoke remain in the runtime-validation sequence.
- Review planner selection, controller deferrals, quote success, cycle duration, and safety before
  full validation.

## Validation Plan

### Run Artifact Hygiene

Each validation run must use one timestamped directory such as
`data/phase9.4D-smoke-YYYYMMDD-HHMM/`. Store the TerminalRunner output, transcript, and
tail reports in that directory. Pass an absolute `--output-dir` to package-scoped commands such
as `quote:diagnose`, because their process working directory is `backend/`. After copying the
completed run directory and its matching
`nexus_paper.db*` snapshot into `data/archive/phase9.4D/<run-label>/`, verify the archive and
remove only the duplicate root copies. Keep `data/` limited to the active database and the
currently running test. All generated artifacts remain ignored by Git.

### Smoke

One 30-minute reset-DB TerminalRunner run:

```text
PROVIDERS_ENABLED=DEXSCREENER,JUPITER,RAYDIUM,SOLANA_RPC,QUICKNODE_DAS,BIRDEYE
Helius disabled
TerminalRunner max runtime = 30 minutes
interval = 60 seconds
PAPER and shadow-only
```

Acceptance targets:

```text
safetyStatus = PASS
orders/fills/positions = 0
quoteBudgetNotSelectedCount > 0 only when candidate batch exceeds the limit
Jupiter liveRateLimited = 0%
Jupiter controller deferrals materially lower than a comparable unallocated busy cycle
selected candidates produce actual quote provenance where routes exist
cycle duration stays below the 60-second cadence in typical cycles
```

Smoke result, August 12, 2026: PASS.

```text
PAPER/shadow-only safety:        PASS
orders/fills/positions:          0 / 0 / 0
cycles:                          17
risk-stage errors:               0
quote-budget selected:           340
quote-budget not selected:       60
selected with quote:             332 (97.65%)
Jupiter live/combined 429:       0.00% / 0.00%
Jupiter controller window max:   40, below the 48-request safety budget
risk-stage duration:             42.8-49.3 seconds
```

Each cycle selected at most 20 candidates. Cycle status `PARTIAL` was expected for cycles with
an `EMPTY` shadow-observation/calibration stage; no TerminalRunner stage failed.

### Full Validation

Only after smoke review, run two separate 120-minute PAPER/shadow-only windows on reset databases,
each with a 60-minute watchlist maturity tail and analytics/calibration/shadow-calibration reports.

Compare with Phase 9.4C Full1/Full2:

```text
Jupiter live upstream 429 rate
planner not-selected count versus controller deferral count
actual quote-success coverage among selected candidates
missing quote evidence by allocation versus provider/no-route cause
Raydium venue guard and fallback behavior
cycle runtime and number of complete stages
Birdeye local budget usage (informational only)
decision-level and best-per-mint forward-return evidence
```

Full validation result, August 12-13, 2026: PASS.

```text
valid runs:                         3 / 3
PAPER/shadow-only safety:           PASS in every run
orders/fills/positions:             0 / 0 / 0
TerminalRunner cycles:              65 + 64 + 66 = 195
risk-stage errors:                  0
planner-enabled risk cycles:        195
quote candidates selected:          3,900
quote candidates not selected:      1,814
estimated live calls avoided:       1,814
selected candidates with a quote:   3,761 / 3,900 (96.44%)
Jupiter upstream live 429:          0.00%
Jupiter shared-window maximum:      40, below the 48-request safety budget
research validity:                  3 / 3 runs, 850 observed decisions, 30 unique mints
promotion gate:                     PROMISING_RESEARCH, confidence MEDIUM, paper pilot no
```

The quote-budget planner therefore replaces most avoidable demand before the router while
preserving high selected-candidate coverage. Raydium still produced no usable route under the
venue policy, while its guard prevented futile fallback traffic. Phase 9.5 aggregate fallback and
Phase 9.6 pool-specific providers are not justified by this evidence. Birdeye budget exhaustion
remains informational and did not reduce selected-candidate quote coverage.

## Phase Success Criteria

Phase 9.4D succeeds when all are true:

```text
1. No safety regression: PAPER/shadow-only; orders/fills/positions remain zero.
2. Every unrequested quote is explicitly reported as a planner non-selection.
3. Jupiter upstream live 429 remains at or near 0% under the current safe controller.
4. On comparable busy cycles, planner non-selection replaces a material share of
   DEFERRED_WINDOW_BUDGET events.
5. Selected candidates retain materially better quote-success coverage than the unbounded
   Phase 9.4C behavior.
6. Reports clearly distinguish planner selection, Jupiter controller action, router provenance,
   and Raydium venue outcome.
7. No strategy/profile/paper-execution behavior changes.
```

## Exit Gate And Next Decision

After three valid full runs plus aggregate and interpretation:

```text
If allocation improves selected-candidate quote coverage and preserves safety:
  retain Phase 9.4D allocation. Review strategy-promotion evidence separately before considering
  any paper-pilot decision.

If allocation protects Jupiter but useful selected coverage remains poor:
  evaluate Phase 9.5 aggregate fallback access (Titan/Autobahn) or Phase 9.6 pool-specific
  Meteora/Orca quotes based on actual venue evidence.

If controller deferrals remain high because selected demand still exceeds the safe allowance:
  tune only the allocation limit/profile with a fresh A/B validation; do not raise the controller
  budget blindly.

In every case:
  paper BUY automation remains disabled until a separate strategy-promotion gate passes.
```

Three-run decision: retain the planner unchanged and proceed to counterfactual decision analysis
before changing score thresholds or shadow-entry profiles. The aggregate met the run-count,
unique-mint, and cross-run target-first concentration requirements, but no profile cleared the
promotion workbench. The immediate diagnostic target is the 27 `UNRESOLVED_STRATEGY_GATE` SKIPs
and their 25 high-scoring examples; this is evidence analysis, not permission for paper BUY.

## Known Limitations

- Selection quality is initially limited to scanner/TokenRadar and prior local evidence; it cannot
  predict a winner without requesting a quote.
- Quote budget allocation improves the value of scarce evidence, not total market coverage.
- The process-local planner resets between runs and intentionally does not coordinate machines or
  sessions.
- Raydium remains a fallback only for candidates with observed Raydium venue evidence.
- Birdeye remains selective market-data enrichment only and may hit its local CU/request guardrail.
- Shadow outcomes remain observation-based simulations, not executable fills or live P/L.
