# NeXusTrade Roadmap Phase 9+

Active roadmap for Phase 9 and later.

Last updated: 2026-09-24

## Historical References

Use these files for the completed foundation and evidence trail:

- [ROADMAP.md](./ROADMAP.md) - historical roadmap through Phase 8.93.
- [DECISIONS.md](./DECISIONS.md) - historical decisions through Phase 8.93.
- [Structure.md](./Structure.md) - historical file inventory through Phase 8.93.
- [Phase-9-Planning-Inputs.md](./Phase-9-Planning-Inputs.md) - TerminalRunner handoff from Phase
  8.6 through Phase 8.93.
- [Provider-Strategy-Phase9Plus.md](./Provider-Strategy-Phase9Plus.md) - provider bottleneck and
  fallback roadmap for Phase 9+.

## Current State

Main's recorded V3/B.3 closeout reports `MEASUREMENT_CAPABILITY_NOT_CONFIRMED`:
liquidity availability was 60.344828% / 63.157895%, below the frozen 90% gate. Both momentum
objectives passed their specified V3 gates; this is no broader proof of strategy performance or
universal measurement reliability. The supplied operator conversation reports finalization on
September 12 and a disabled scheduler. No new collection is authorized.

Main's historical run used its binding and loader repair, without isolation's H1 implementation.
The [integration record](./Phase-10.6H-Main-Isolation-Integration.md) separates that report from
synthetic verification of the combined source. Integration is committed as `b8a91fc` in isolation;
no new real analysis or main deployment is included.

Phase 10.6H is the parallel engineering improvement track for existing code. H1 is complete, with
245 focused tests and all required source checks passing in the isolated worktree. Its closeout
patch is committed and pushed on the isolated branch as `a0bfdf9`. See the [H1 verification record](./Phase-10.6H-H1-Verification.md).
The [H2 detailed checklist](./NeXusTrade-Phase-10.6H-H2-Detailed-Checklist.md) was approved on September 10;
isolated engineering acceptance is complete on September 16 (194 H2 tests, 245 unchanged H1 tests). See the [H2 verification record](./Phase-10.6H-H2-Verification.md). H2 is committed as `ff6d586`; the [H3 detailed implementation checklist](./NeXusTrade-Phase-10.6H-H3-Detailed-Checklist.md) was approved and implemented in isolation on September 17 (98 H3 tests, 245 H1 and 194 H2 compatibility tests). See the [H3 verification record](./Phase-10.6H-H3-Verification.md); H3 is committed as `f8f8d4c` and is integrated into main at `63f5378`. The [H4 detailed implementation checklist](./NeXusTrade-Phase-10.6H-H4-Detailed-Checklist.md) was implemented and passed local/hosted acceptance; PR #5 integrated H4 into main at `88921e9`. See the [H4 verification record](./Phase-10.6H-H4-Verification.md). The track addresses
analyzer verification, accounting/schema/migration integrity, provider concurrency, and automated
development boundaries. It supplies no candidate or trading authority. V2 remains closed as
`NO_DEFENSIBLE_HYPOTHESIS`; V3 can establish only measurement capability. A separately approved
evidence-producing research design and actual candidate evidence are still needed before 10.6C.

Phase 10.6B.4 — Measurement Remediation Decision closed on 2026-09-24. Its documentation-only
investigation found the documented B.3 identity and aggregate result internally consistent, without
independently inspecting the archive. The assistant then proposed `UNRESOLVED` liquidity necessity,
`VALID_NEGATIVE_DECISION`, and `NO_NEW_MEASUREMENT_PROTOCOL_JUSTIFIED`. The user subsequently
accepted that outcome within the reviewed documentary scope on 2026-09-24. The proposal and
acceptance are preserved as distinct events in the decision memo. The permitted documents reviewed
define no concrete future research question that establishes why liquidity is required, and they
support no materially different alternative strongly enough to establish successor protocol fields.
No conditional protocol draft was created. The frozen 90% gate is unchanged. Operational archive
inspection and automated protocol validation remain separately gated, and no provider, protocol,
collector, named root, scheduler, collection, Phase 10.6C, PAPER, or execution action is authorized.

Near-term sequence, parallel-work rules, and future phase requirements:

- [Post-V3 Development Plan](./Post-V3-Development-Plan.md)
- [Phase 10.6B.4 Measurement Remediation Decision](./NeXusTrade-Phase-10.6B.4-Detailed-Checklist.md)
- [Phase 10.6B.4 Evidence And Uncertainty Ledger](./research-reviews/phase10.6b.4-evidence-uncertainty-ledger.md)
- [Phase 10.6B.4 Liquidity-Necessity And Material-Alternatives Assessment](./research-reviews/phase10.6b.4-liquidity-necessity-material-alternatives-assessment.md)
- [Phase 10.6B.4 Proposed Decision Memo](./research-reviews/phase10.6b.4-proposed-decision-memo.md)
- [Phase 10.6H Engineering Integrity And Development Hardening](./NeXusTrade-Phase-10.6H-Detailed-Checklist.md)

The following paragraphs retain the completed foundation and earlier research evidence.

Phases 1 through 9.29 are complete. Phase 9.3 implementation and first validation are complete.
Phase 9.3B implementation and validation are complete. Phase 9.3C implementation, provider
validation, and post-fix follow-up validation are complete. Phase 9.4 implementation and validation
are complete. Phase 9.4A.1 archive/reporting truthing is implemented and smoke-validated; its
closeout patch corrects archive compactness and reporting semantics. Phase 9.4A.2 adapter
correctness and diagnostics is implemented and short-runtime validated. Phase 9.4B quote-pressure
reduction is implemented and runtime-validated. Its Raydium controls materially reduced futile
fallback calls, while Jupiter live rate limiting remained about 23% across two full runs. Phase 9.4C
is implemented and runtime-validated: upstream Jupiter `429` results fell to 0%, but the safe
shared allowance revealed local quote-demand overflow. Phase 9.4D allocated constrained quote
capacity before requests reached the existing router/controller. Phase 9.26 is implemented and
archive-smoke validated. Its direct 65/60 result is concentrated, so Phase 9.27 implemented a
narrow, archive-only `T65N@v1` validator for the 65-69 threshold-only cohort. Eight valid fresh
run archives ultimately selected 24 unique mints. The sample-quality and leave-one-out gates passed,
but the primary 10/10 at 60-minute result (`13` target-first, `9` stop-first, `2` neither; median
MAE `-11.44%`) returned `REJECT_NARROW_THRESHOLD`. The invalid QuickNode-expiry Test 8 is excluded;
Test8R is the Alchemy-backed replacement. Phase 9.28 is complete. Its separate `F65E@v1`
fast-exit profile kept normal 90/70 strategy collection unchanged and completed three valid
120-minute PAPER/shadow-only runs. The combined fresh cohort selected seven candidates with exact
3/5/15-minute coverage: Test1 selected 0, Test2 selected 1, and Test3 selected 6. Its 10% target
/ 15% stop / 15-minute primary result was 3 target-first, 3 stop-first, and 1 maximum-hold. It
failed the pre-registered sample, concentration, stability, target-first, stop-first,
target-minus-stop, and median-MFE promotion gates. Close F65E@v1 without promotion; do not extend
the unchanged batch. Strategy defaults and paper execution remain unchanged.

Phase 9.3C confirmed that raw Solana RPC can replace exhausted Helius credits for mint/freeze
authority evidence in long validation runs. The August 3 current baseline reconfirmed
`missingAuthority=0`. The remaining provider bottleneck is quote and market-data confidence:
Jupiter remains pressured, Raydium helps only occasionally, and many strategy rows still lack
usable quote/price-impact evidence.

Phase 8.93 promoted no strategy profile:

```text
CANDIDATE_FOR_PROMOTION = 0
paper BUY orchestration permission = false
strategy default changes = none
```

Phase 9 produced shadow-first automation. Phase 9.1 produced read-only cross-run aggregation.
Phase 9.2 added provider resilience for quote cache/backoff/router behavior. Phase 9.2B cleaned up
provider measurement and reduced Jupiter metadata pressure. Phase 9.25 interpreted the cleaned
research output and selected Raydium quote fallback as the next highest-value provider step.

## Phase 9+ North Star

- Automate the research loop so long validation runs require less manual command work.
- Keep strategy research, promotion, and execution separate.
- Keep `paper:execute` outside default automation until a later explicit promotion review.
- Produce repeatable run artifacts that make profile tuning easier.
- Report provider pressure clearly before adding provider complexity.
- Preserve `PAPER`, `LIVE`, and future `BACKTEST` separation.
- Make Phase 10 dashboard work consume structured runner outputs rather than terminal transcripts.

## Active Phases

9. Build shadow-first TerminalRunner with provider pressure reporting. Implemented.
   9.1. Add cross-run research aggregation and promotion gate reporting. Implemented.
   9.2. Add quote cache, backoff, and provider fallback framework. Implemented.
   9.2B. Clean provider-pressure measurement and Jupiter metadata pressure. Implemented.
   9.25. Add research interpretation and skipped-opportunity diagnostics. Implemented.
   9.3. Add Raydium direct quote fallback. Implemented; validation reviewed.
   9.3B. Add Raydium diagnostics and Helius pressure cleanup. Implemented; validation complete.
   9.3C. Add Helius fallback / RPC authority evidence. Implemented; post-fix validation complete.
   9.4. Add Birdeye selective market-data enrichment if CU budget supports the research need.
   Implemented; validation complete.
   9.4A. Truth reporting, quote evidence attribution, Birdeye attribution, and adapter correctness.
   Implemented; A.2 short validation complete.
   9.4A.1. Archive and reporting truthing. Implemented; smoke validation and closeout patch complete.
   9.4A.2. Adapter correctness and diagnostics. Implemented; short validation complete.
   9.4A.3. Conditional persistence hardening. Do not plan unless 9.4A.2 proves the existing
   ProviderHealth context and bounded journal cannot preserve required diagnostic evidence.
   9.4B. Reduce quote-provider pressure through scheduling, demand control, and evidence freshness.
   Implemented and runtime-validated. Raydium protection succeeded, but fixed Jupiter pacing did not
   reduce upstream 429s sufficiently.
   9.4C. Add a shared adaptive Jupiter demand controller and free-tier evidence. Implemented and
   runtime-validated; upstream 429s are 0%, with local demand overflow now measured clearly.
   9.4D. Allocate bounded quote capacity to the most evidence-relevant risk candidates before the
   existing router/controller. Implemented and runtime-validated across three full runs: the
   planner avoided 1,814 live quote calls across 195 risk cycles while selected-candidate quote
   coverage remained 96.44% and Jupiter upstream 429 remained 0%. Retain the allocation defaults.
   9.26. Add read-only counterfactual decision analysis for resolvable strategy blockers before
   tuning profiles or considering paper execution. Implemented and archive-smoke validated against
   the three Phase 9.4D runs. It replays time-of-decision facts, applies one named intervention at
   a time, and labels threshold policy sensitivity separately from gate-override sensitivity.
   9.27. Validate only fresh, time-safe 65-69 threshold-only shadow candidates after the
   concentrated Phase 9.26 result. Completed and rejected as a 10/10/60 threshold policy after
   eight valid archives. It retains the normal 90/70 strategy during collection and cannot enable
   paper BUY.
   9.28. Validate the separate `F65E@v1` fast-exit hypothesis using stored 65-69 candidate facts,
   fresh 3/5/15-minute observations, and a primary 10% target / 15% stop / 15-minute scenario.
   Implemented and closed without promotion after three valid fresh runs produced 7 exact-coverage
   candidates, 3 target-first outcomes, and 3 stop-first outcomes. The cohort failed its
   pre-registered sample and outcome gates. Do not collect more unchanged F65E runs, lower entry
   thresholds, or enable paper execution from this result.
   9.29. Perform read-only fast-entry feature attribution and hypothesis selection. Compare F65E
   target-first, stop-first, and maximum-hold candidates using only facts available at decision
   time, then either pre-register one materially different successor hypothesis or explicitly
   conclude that the existing evidence cannot support one. Implemented and closed with
   `NO_DEFENSIBLE_HYPOTHESIS`: all seven exact-coverage candidates were reconstructed, but 85.71%
   were in Test3 and every non-target label was in Test3. It cannot alter strategy defaults, run
   providers, create sessions, or enable paper execution.
   9.5. Evaluate Autobahn and Titan as access-gated aggregate quote fallbacks only if a future
   validation shows selected-candidate quote coverage is inadequate. Deferred by Phase 9.4D.
   9.6. Evaluate Meteora and Orca pool-specific quote adapters. Planned.
10. Build the local, read-only Research Dashboard and Archive Explorer. Implemented 2026-08-18. It
    consumes completed structured archive data first, exposes run/cohort/candidate/provider-pressure
    evidence, and keeps all execution and runtime controls absent.
    10.4. Build the local, deterministic Research Brief Generator and Analyst Review Protocol.
    Implemented 2026-08-19. It reads only an explicit completed archive scope and emits a
    source-traceable brief for conversational analysis; it cannot collect data, create a hypothesis,
    or authorize a study.
    10.5. Human review and pre-registration gate. Implemented 2026-08-19. It records the completed
    evidence as `NO_STUDY_AUTHORIZED`, permits no successor study, cannot reuse the closed F65E@v1
    study unchanged, and cannot enable paper execution.
    Detailed implementation checklist:
    [NeXusTrade-Phase-10.5-Detailed-Checklist.md](./NeXusTrade-Phase-10.5-Detailed-Checklist.md)
    10.5A. Research restart criteria and exploratory cohort design. Implemented 2026-08-19 as a
    planning/local-validation-only gate. It freezes a broad, outcome-blind sampling frame and
    validates the static protocol locally; it never authorizes collection, a strategy predicate, or
    execution.
    Detailed implementation checklist:
    [NeXusTrade-Phase-10.5A-Detailed-Checklist.md](./NeXusTrade-Phase-10.5A-Detailed-Checklist.md)
    10.6A. Exploratory cohort collection. Implemented 2026-08-19 and separately live-run-gated.
    Its isolated collector can create one fixed independent real-market observation archive without
    a strategy decision, order, fill, position, wallet action, signing, or submission. No first
    collection is authorized until the user approves one named archive root.
    Detailed implementation checklist:
    [NeXusTrade-Phase-10.6A-Detailed-Checklist.md](./NeXusTrade-Phase-10.6A-Detailed-Checklist.md)
    10.6A.1. External-slot reliability and deterministic closeout. Implemented 2026-08-19 and
    still launch-gated. It preserves every frozen V2 collection value while recording elapsed
    uninvoked external slots as canonical zero-request availability rows, hash-validating active
    archive evidence, and allowing only a strict provider-free post-window closeout of an existing
    active root. It does not arm or start the authorized collection.
    Detailed implementation checklist:
    [NeXusTrade-Phase-10.6A.1-Detailed-Checklist.md](./NeXusTrade-Phase-10.6A.1-Detailed-Checklist.md)
    10.6B. Exploratory cohort analysis and hypothesis decision. Implemented archive-only against the
    pre-registered 60-minute label, finite decision-time single-feature catalog, and
    discovery/validation split gates. The one separately authorized real-archive run closed
    `NO_DEFENSIBLE_HYPOTHESIS`: no rule advanced to held validation, so no materially distinct study
    may be pre-registered. Its only possible positive result,
    `PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL`, remains non-authorizing and was not reached.
    Detailed implementation checklist:
    [NeXusTrade-Phase-10.6B-Detailed-Checklist.md](./NeXusTrade-Phase-10.6B-Detailed-Checklist.md)
    10.6B.1. Decision-time measurement and missingness audit. Closed archive-only after synthetic
    verification and one separately approved real-archive stdout run. It assesses only field availability, bounded
    missingness reasons, sanitized provenance, provider-capability outcomes, and date/partition
    concentration—never later labels or candidate effects. Its best possible result can support
    drafting a separate measurement-only protocol revision; it cannot authorize collection, Phase
    10.6C, strategy tuning, PAPER execution, or promotion. Its `MEASUREMENT_REVISION_READY_FOR_SEPARATE_PROTOCOL_REVIEW`
    result supports only a separate human-reviewed measurement-protocol draft:
    [NeXusTrade-Phase-10.6B.1-Detailed-Checklist.md](./NeXusTrade-Phase-10.6B.1-Detailed-Checklist.md)
    10.6B.2. Measurement-only protocol design and static review. Implemented as a static-only V3
    draft and isolated validator from the three replicated availability signatures. Its one separately
    approved stdout-only static validation passed, but it cannot authorize a provider call, collector,
    scheduler, archive root, collection, Phase 10.6C, strategy change, PAPER action, or promotion:
    [NeXusTrade-Phase-10.6B.2-Detailed-Checklist.md](./NeXusTrade-Phase-10.6B.2-Detailed-Checklist.md)
    10.6A.2. V3 measurement-only cohort collector. Implemented and verified synthetically after the
    V3 static result. It fixes the direct DEXSCREENER-only -16/-15/-10/-5/0 schedule, safe
    archive/lock behavior and the separate archive-analysis gate. One named launch record is approved
    and validated locally. The operator-owned scheduler was registered and armed for that one root on
    2026-09-04; the V3 measurement collection is active under its frozen schedule. This operational
    state does not authorize a protocol/root/scheduler change, archive analysis, Phase 10.6C,
    strategy change, PAPER action, or promotion:
    [NeXusTrade-Phase-10.6A.2-Detailed-Checklist.md](./NeXusTrade-Phase-10.6A.2-Detailed-Checklist.md)
    10.6B.3. V3 final measurement capability analysis and remediation decision. Implemented with an
    initial passing synthetic suite as a final-archive-only analyzer for the one active V3 root.
    H1 verification is complete; final identity binding remains separate. It will
    verify a separately bound immutable final identity and report only frozen availability,
    freshness, provenance, independence, and safety gates. Its production command remains
    default-denied before identity binding; it cannot select a V4 design, authorize Phase 10.6C, or
    enable PAPER/execution:
    [NeXusTrade-Phase-10.6B.3-Detailed-Checklist.md](./NeXusTrade-Phase-10.6B.3-Detailed-Checklist.md)
    10.6H. Engineering integrity and development hardening. Parallel track for existing code:
    H1 analyzer verification before final binding; H2 atomic accounting/schema/migrations; H3 general
    provider concurrency; H4 dependency boundaries, validation, and workflow. Active-V3 implementation
    requires physical checkout/dependency/data isolation; shared operational changes wait for closeout.
    Applicable H2-H4 acceptance is required before a future PAPER pilot. No research gate is advanced:
    [NeXusTrade-Phase-10.6H-Detailed-Checklist.md](./NeXusTrade-Phase-10.6H-Detailed-Checklist.md)
    Future research-design gate, before 10.6C. Only after confirmed V3 capability and a separate human
    decision, design and authorize a new outcome-aware evidence-producing study. Its actual passing
    evidence and candidate decision are required; no successor protocol/version is selected now:
    [Post-V3-Development-Plan.md](./Post-V3-Development-Plan.md)
    10.6C. Independent real-market shadow validation. Blocked: the completed 10.6B result supplied
    no pre-registration candidate. It remains available only after a future, separately approved,
    materially distinct candidate passes all required evidence gates.
    10.7. Strategy promotion review. Blocked upstream pending a successful Phase 10.6C validation;
    it cannot review, select, or promote the current evidence.
    10.7A. Paper-Pilot Experiment Protocol. Proposed and blocked pending a successful Phase 10.7
    promotion review. It will pre-register a small, fixed set of versioned experimental profiles,
    comparable simulated portfolios, session/batch limits, P/L and operational measures, and
    between-batch-only revision rules. It is documentation only and cannot enable PAPER execution.
    10.8A. Build the Paper Operations Dashboard. Blocked upstream pending a successful Phase 10.7
    promotion review and a frozen Phase 10.7A protocol; it remains separate from the archive-only
    research viewer.
    10.8B. Run the controlled paper pilot. Blocked upstream pending a frozen strategy version and
    explicit Phase 10.7 promotion and named-pilot approval under the Phase 10.7A protocol, plus
    applicable Phase 10.6H H2-H4 integrity and verification acceptance for the implementation used.
    10.9. Assess the controlled paper pilot. Blocked until a bounded Phase 10.8B pilot exists.
11. Harden for live-trading readiness. Planned.
12. Run tiny live-trade experiments only after explicit readiness gates. Planned.
13. Add paid providers, advanced execution infrastructure, and advanced strategies when justified
    by measured needs. Planned.
14. Run a low-cap autonomous live pilot only after the guarded live experiments and all operational
    safety gates pass. Proposed.

## Phase 9 Outcome

Phase 9 produced a TerminalRunner that coordinates the existing shadow-safe surfaces:

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

TerminalRunner creates one `PAPER` + `RUNNING` session per run, reuses it across all cycles, and
prints compact progress lines during normal long runs. JSON output remains machine-readable.

Provider pressure should be summarized, but new provider adapters are not part of the Phase 9
default scope.

Phase 9 must not:

- enable live trading,
- load wallets,
- sign transactions,
- submit transactions,
- enable `paper:execute` by default,
- invent strategy rules,
- promote profiles,
- treat simulated shadow P/L as realized P/L.

Detailed checklist:

- [NeXusTrade-Phase-9-Detailed-Checklist.md](./NeXusTrade-Phase-9-Detailed-Checklist.md)

## Phase 9.1 Direction

Phase 9.1 aggregates multiple Phase 9 TerminalRunner archives and produces one promotion-gate
research report. It compares one-session run validity, decision-level and unique-mint outcomes,
score thresholds, target-before-stop races, provider pressure, and the Phase 8.92B shadow-entry
readiness workbench.

Initial Phase 9.1 result over the first three valid Phase 9 archives:

```text
validRuns = 3/3
observedDecisions = 277
uniqueMints = 13
paper execution rows = 0
Jupiter rateLimited = 52.67%
readiness = PROMISING_RESEARCH
confidence = MEDIUM
controlledPaperPilotRecommended = no
paperBuyAutomationEnabled = no
```

Phase 9.1 does not change strategy defaults or enable paper BUY automation.

Detailed checklist:

- [NeXusTrade-Phase-9.1-Detailed-Checklist.md](./NeXusTrade-Phase-9.1-Detailed-Checklist.md)

## Phase 9.2 Direction

Phase 9.2 added the provider-resilience framework before adding any new external provider adapters.
It should reduce avoidable Jupiter quote pressure and preserve clearer evidence through:

```text
quote request identity
in-memory quote cache
Jupiter quote backoff
quote priority
provider fallback router
provider-health context for cache/backoff/fallback outcomes
```

Phase 9.2 keeps Jupiter as the only live quote provider. Raydium, Birdeye, Titan, Autobahn,
Meteora, and Orca remain future phases unless a later implementation review explicitly re-scopes
the work.

Phase 9.2 must not enable paper BUY automation, change strategy defaults, promote a profile, or
treat cached/missing quotes as realized trading evidence.

Detailed checklist:

- [NeXusTrade-Phase-9.2-Detailed-Checklist.md](./NeXusTrade-Phase-9.2-Detailed-Checklist.md)

## Phase 9.2B Direction

Phase 9.2B cleans up provider measurement after the five Phase 9.2 validation runs. It should:

```text
separate live provider rate limits from router cooldown skips
prefer Helius metadata and reduce Jupiter token-metadata-from-price pressure
raise research quote cache TTL to fit 60-second TerminalRunner cadence
make research:aggregate load the Phase 9.2 archive shape directly
report cache hits, cooldown skips, and live provider rate limits separately
```

Phase 9.2B implemented:

```text
ProviderPressureClassifier
live-vs-router provider pressure in TerminalRunner, analytics, calibration, and research aggregate
PromotionGate caution based on live Jupiter rate limits
JUPITER_TOKEN_METADATA_ENABLED=false by default
Helius-first metadata provider ordering
QUOTE_CACHE_TTL_MS=90000 default
nested Phase 9.2 archive loading
```

Phase 9.2B did not add Raydium or change strategy defaults. It exists so Phase 9.25 can interpret
clean research data.

Final Phase 9.2B validation aggregate:

```text
validRuns = 3/3
observedDecisions = 468
uniqueMints = 35
orders/fills/positions = 0
Jupiter liveRateLimited = 15.92%
Jupiter combinedRateLimited = 44.68%
cacheHits = 159
cooldownSkips = 1311
readiness = PROMISING_RESEARCH
controlledPaperPilotRecommended = no
```

Detailed checklist:

- [NeXusTrade-Phase-9.2B-Detailed-Checklist.md](./NeXusTrade-Phase-9.2B-Detailed-Checklist.md)

## Phase 9.25 Direction

Phase 9.25 implemented read-only interpretation of the cleaned Phase 9.x research data before
provider expansion. It focuses on high-scoring SKIP explanations, SKIP reason clustering, WARN outcome analysis,
missing-quote outcome analysis, market-window analytics, and per-token missed-opportunity
breakdowns.

Phase 9.25 added decision attribution for every BUY, WATCH, and SKIP:

```text
score component contributions
first blocking factor
highest-impact blocking factor
risk/quote/liquidity/volume/age/authority explanation
```

Counterfactual decision analysis, such as "if quote existed then WATCH, if risk PASS then BUY,"
should be noted as future Phase 9.26 or Phase 10 work rather than included in Phase 9.25.

Phase 9.25 does not enable paper BUY automation or change production strategy defaults without a
later promotion review.

Command:

```bash
pnpm research:interpret --once
```

Detailed checklist:

- [NeXusTrade-Phase-9.25-Detailed-Checklist.md](./NeXusTrade-Phase-9.25-Detailed-Checklist.md)

Phase 9.25 report result:

```text
decision mode observed decisions = 468
unique mints = 35
missingQuote = 311 / 468
first_per_mint missingQuote = 15 / 35
best_per_mint missingQuote = 15 / 35
Jupiter liveRateLimited = 15.92%
Jupiter combinedRateLimited = 44.68%
cacheHits = 159
cooldownSkips = 1311
primary recommendation = Phase 9.3 Raydium fallback
paper BUY automation = disabled
```

## Phase 9.3 Direction

Phase 9.3 adds Raydium as the first direct quote fallback behind the existing
`QuoteProvider` interface and quote router.

Scope:

```text
Raydium Trade API quote computation only
GET /compute/swap-base-in
no Raydium transaction serialization endpoint calls
no wallet loading
no signing
no transaction submission
no paper BUY automation
no strategy default changes
```

Raydium does not appear to require an API key for the first quote-only implementation. If that
changes during implementation, the adapter should fail closed and document the required credential
before validation runs continue.

Implementation result:

```text
RAYDIUM provider name and config added
RaydiumAdapter added under backend/src/providers/raydium
default provider set includes RAYDIUM
quote provider order is JUPITER then RAYDIUM
QuoteResult provenance records provider, LIVE/CACHE source type, fallback reason, and attempted providers
provider pressure reports include quote source type and fallback reason counts
providers:smoke includes a Raydium quote check when enabled
orders/fills/positions remain disabled by design
```

Phase 9.3 must record quote provenance and fallback reason so later reports can distinguish:

```text
Jupiter live quote
Jupiter cached quote
Raydium live quote
Raydium cached quote
no quote
Raydium used because Jupiter rate-limited, cooled down, unavailable, policy-selected, or forced
```

Exit gate:

```text
Raydium implemented
provider/TerminalRunner smoke passed
three validation runs complete
research:aggregate complete
research:interpret complete
decision: remain on Raydium, proceed to 9.26/9.31/9.4, evaluate another fallback, or collect more data
```

Phase 9.4 should not start automatically. The Phase 9.3 validation review should decide whether
Birdeye is still the highest-value next step.

Detailed checklist:

- [NeXusTrade-Phase-9.3-Detailed-Checklist.md](./NeXusTrade-Phase-9.3-Detailed-Checklist.md)

Phase 9.3 validation result:

```text
validRuns = 3/3
observedDecisions = 270
uniqueMints = 24
orders/fills/positions = 0
decision-level missingQuote = 115 / 270 = 42.59%
mint-level missingQuote = 4 / 24 = 16.67%
Jupiter liveRateLimited = 8.53%
Jupiter combinedRateLimited = 24.66%
Raydium total rows = 595
Raydium OK = 7.73%
Raydium ERROR = 91.76%
Helius aggregate liveRateLimited = 54.56%
readiness = PROMISING_RESEARCH
controlledPaperPilotRecommended = no
```

## Phase 9.3B Direction

Phase 9.3B is a cleanup phase before provider expansion or paper BUY work. It classifies Raydium
failures, adds optional Raydium API v3 pool/mint diagnostics, and reduces avoidable Helius
metadata/risk pressure.

Scope:

```text
Raydium quote error classification
Raydium API v3 pool preflight diagnostics
Raydium API v3 mint price diagnostics, not quote evidence
Helius metadata/risk cache and backoff
provider-pressure reporting updates
no paper BUY automation
no wallet/signing/submission
```

Implementation result:

```text
Raydium failure categories = reported from ProviderHealth context
Raydium pool preflight = API v3 /pools/info/mint with in-memory TTL cache
Raydium mint price = API v3 /mint/price diagnostics only
Helius cache/backoff = metadata/risk getAsset cache plus cooldown skip behavior
reports updated = TerminalRunner, analytics, calibration, research aggregate, research interpret, providers:smoke
DB migration = none
orders/fills/positions = still disabled by phase boundary
```

Detailed checklist:

- [NeXusTrade-Phase-9.3B-Detailed-Checklist.md](./NeXusTrade-Phase-9.3B-Detailed-Checklist.md)

Validation conclusion:

```text
Safety passed.
Helius free-plan credits were exhausted and produced 100% rate-limited behavior while enabled.
Disabling Helius reduced provider noise but left authority evidence broadly missing.
Raydium diagnostics worked, but candidate quote attempts remained 0% OK across the full validation runs.
Jupiter remained usable but pressured at roughly 50% combined rate-limited behavior.
No paper BUY readiness was established.
```

Next recommended phase:

```text
Phase 9.3C: Helius fallback / RPC authority evidence

Primary: raw Solana RPC mint-account parsing.
Secondary: QuickNode DAS.
Tertiary: Alchemy DAS.
Deferred provider research: Shyft or another token-info provider only if RPC + DAS are insufficient.
```

Detailed checklist:

- [NeXusTrade-Phase-9.3C-Detailed-Checklist.md](./NeXusTrade-Phase-9.3C-Detailed-Checklist.md)

## Phase 9.3C Direction

Phase 9.3C replaces the most important Helius risk-evidence dependency with provider-neutral raw
Solana RPC authority evidence. Implementation and follow-up validation are complete. The next phase
should improve quote coverage/quality before any broader provider expansion or paper BUY automation.

Scope:

```text
SOLANA_RPC provider for mint-account authority evidence
QuickNode DAS metadata fallback
Alchemy DAS metadata fallback
Shyft deferred from Phase 9.3C implementation
provider-health and report counts for authority source and authority state
no paper BUY automation
no wallet/signing/submission
```

Success was met: long validation can run with Helius disabled while still collecting mint authority
and freeze authority evidence conservatively.

## Phase 9.4 Direction

Phase 9.4 adds Birdeye as a selective market-data enrichment provider for high-intent candidates.
It is not an executable quote provider and must not be treated as Jupiter/Raydium route evidence.

Current Birdeye Standard/free constraints:

```text
30,000 CUs/month
1 RPS
no overage
no WebSocket access
```

Scope:

```text
BIRDEYE provider identity and config
selective high-intent candidate enrichment
price and token-overview diagnostics
Birdeye CU/request budget tracking
provider-health/reporting for Birdeye endpoint, cache, budget, and failure categories
no paper BUY automation
no wallet/signing/submission
```

Implementation status:

```text
Implemented; validation complete.
```

Recommended default provider set for Phase 9.4 validation:

```text
DEXSCREENER,JUPITER,RAYDIUM,SOLANA_RPC,QUICKNODE_DAS,BIRDEYE
```

Helius credits may be available again, but Helius should remain optional/comparison-only for Phase
9.4 long runs because `SOLANA_RPC` already covers authority evidence cheaply.

Detailed checklist:

- [NeXusTrade-Phase-9.4-Detailed-Checklist.md](./NeXusTrade-Phase-9.4-Detailed-Checklist.md)

Validation conclusion:

- [NeXusTrade-Phase-9.4-Conclusion-and-9.4A-Prep.md](./NeXusTrade-Phase-9.4-Conclusion-and-9.4A-Prep.md)

Phase 9.4 aggregate:

```text
validRuns = 3/3
observedDecisions = 115
uniqueMints = 14
orders/fills/positions = 0
readiness = PROMISING_RESEARCH
controlledPaperPilotRecommended = no
BIRDEYE liveRateLimited = 0%
BIRDEYE combinedRateLimited = 0%
BIRDEYE cacheHits = 244
JUPITER combinedRateLimited = 69.7326%
RAYDIUM error share = 94.5019%
```

Conclusion:

```text
Birdeye selective enrichment is operationally validated.
Birdeye attribution/reporting is incomplete.
Quote evidence and provider-pressure measurement need truthing.
No paper BUY promotion.
No threshold change.
No unchanged Phase 9.4 Test #4.
```

## Phase 9.4A Direction

Phase 9.4A should make the evidence trustworthy before changing runtime provider behavior.

Internal split:

```text
9.4A.1 Archive and reporting truthing
9.4A.2 Adapter correctness and diagnostics
```

Phase 9.4A.1 is read-only and operates on the existing Phase 9.4 archives. It adds truncation
disclosure, full-session row counts, quote-evidence attribution, Birdeye CU and enriched-mint
attribution, concentration analysis, leave-one-run/mint-out analysis, clear blocker classification,
provider failure reclassification, and scenario-portfolio audit.

Detailed checklist:

- [NeXusTrade-Phase-9.4A.1-Detailed-Checklist.md](./NeXusTrade-Phase-9.4A.1-Detailed-Checklist.md)

Phase 9.4A.1 smoke result:

```text
command = pnpm research:truth --once
input runs = Phase 9.4 T1, T2, T3
safety = passed
orders/fills/positions = 0
decisionRows = 2458
missingQuote = 2037
unclassifiedMissingQuote = 0
Birdeye budget skips = 66 policy/guardrail skips
Birdeye provider failures = 0
dominant run = T2, 87.78% of target-first wins
dominant mint = WONKA, 71.11% of target-first wins
selected recommendation = Phase 9.4A.2 adapter correctness and diagnostics
```

Phase 9.4A.2 should correct Raydium preflight parameters, parse Raydium top-level `msg`, classify
deterministic Raydium failures as nonretryable, add sanitized HTTP-attempt telemetry and derived
rate hints, preserve latest quote attempt versus last successful quote evidence, and add a read-only
`quote:diagnose` command with an opt-in round-trip probe.

Detailed checklist:

- [NeXusTrade-Phase-9.4A.2-Detailed-Checklist.md](./NeXusTrade-Phase-9.4A.2-Detailed-Checklist.md)

The current Raydium API v3 pair preflight contract requires `mint1`, `poolType`,
`poolSortField`, `sortType`, `pageSize`, and `page`; `mint2` is supplied for the pair lookup. The
Phase 9.4A.2 default preflight is `all`, `liquidity`, `desc`, `5`, `1`. The compute quote remains
the read-only `GET /compute/swap-base-in` surface only.

Success target:

```text
unclassifiedMissingQuote ~= 0
```

The target is not `missingQuote = 0`, because some tokens legitimately have no supported route.

Phase 9.4A.2 short validation:

```text
run = phase9.4A.2-short-20260806-1255
duration = 30 minutes
cycles = 29
safetyStatus = PASS
mode = PAPER
shadowOnly = true
orders/fills/positions = 0
TokenRadar = 26
Risk = 553
Strategy = 229
Strategy decisions = WATCH 6, SKIP 223, BUY 0
Birdeye = 64 rows, 0% rate limited, 0 provider failures
Jupiter = 732 rows, liveRateLimited ~20.31%, combinedRateLimited ~58.47%
Raydium = 858 rows, failures classified as NO_ROUTE after NO_POOL preflight
Solana RPC = 2488 rows, 0% rate limited, authority evidence cached
```

Decision from the validation:

```text
Phase 9.4A.3 is not needed now.
Existing ProviderHealth context plus bounded runtime journal preserved enough evidence.
Proceed to Phase 9.4B.
Phase 9.4B should first reduce avoidable quote demand and suppress implausible Raydium probes
using available DexScreener pair/venue evidence before adding another provider.
```

## Phase 9.4B Direction

Phase 9.4B should reduce quote-provider pressure now that Phase 9.4A.2 made the measurements
trustworthy enough for the next runtime work. The A.2 short validation showed Raydium fallback is
mostly blocked by legitimate no-route/no-pool outcomes for discovered mints, so 9.4B should use
existing DexScreener pair/venue evidence to avoid implausible Raydium probes before adding another
provider.

Detailed checklist:

- [NeXusTrade-Phase-9.4B-Detailed-Checklist.md](./NeXusTrade-Phase-9.4B-Detailed-Checklist.md)

Recommended order:

```text
B1 Jupiter scheduler and provider-aware retries
B2 remove duplicate demand and avoid second full sell enrichment
B3 single-flight request joining and cache split
B4 preserve latest attempt and last successful quote evidence separately
B5 Raydium negative caching, circuit breaker, and venue-aware routing
```

Keep Phase 9.5 reserved for Autobahn/Titan access-gated aggregate quote-provider research.

Phase 9.4B validation conclusion:

```text
Raydium venue guard and negative cache materially reduced futile live fallback probes.
Jupiter scheduler, cooldown, and cache controls avoided thousands of live calls.
Jupiter liveRateLimited remained about 23% across two full runs.
Do not run more unchanged Phase 9.4B validations or add a provider yet.
Run the Phase 9.4C PAPER/shadow-only validation: shared adaptive Jupiter demand control.
```

## Phase 9.4C Direction

Phase 9.4C adds one process-wide Jupiter request budget shared by price and quote operations. It
uses conservative free-tier headroom, adaptive response to real upstream 429s, priority-aware local
deferral, and distinct reporting for local deferral versus upstream rate limiting.

Helius remains disabled for its validation runs because authority evidence is already supplied by
Solana RPC and QuickNode DAS. Jupiter's paid Developer tier is not part of implementation; a paid
comparison requires a later evidence-based decision.

Detailed checklist:

- [NeXusTrade-Phase-9.4C-Detailed-Checklist.md](./NeXusTrade-Phase-9.4C-Detailed-Checklist.md)

## Phase 9.29 Direction

Phase 9.29 is a read-only, archive-only feature-attribution and hypothesis-selection step after
the closed F65E@v1 batch. It reconstructs the seven selected F65E candidates from their stored
decision snapshots, then compares the fixed primary target-first, stop-first, and maximum-hold
labels against only facts known at each original decision time.

Scope is limited to stored score attribution, risk, age, liquidity, volume, momentum, quote and
price-impact evidence, provider provenance when deterministically linked, and repeated-attention
evidence. Later 3/5/15-minute observations remain labels only and cannot become entry features.
Phase 9.29 cannot call providers, write a database, create a session, change strategy defaults,
alter monitoring, or enable any execution/wallet path.

The report must choose only one of two outcomes:

```text
NO_DEFENSIBLE_HYPOTHESIS
PRE_REGISTER_SUCCESSOR_HYPOTHESIS
```

A successor is permitted only when fixed label-support, concentration, leave-one-run/mint-out, and
time-safe feature gates all pass. It must be a narrower, materially different decision-time entry
predicate with a versioned future collection and promotion contract. Otherwise the report must
explicitly conclude no defensible hypothesis; it cannot recommend another unchanged F65E batch.

Detailed checklist:

- [NeXusTrade-Phase-9.29-Detailed-Checklist.md](./NeXusTrade-Phase-9.29-Detailed-Checklist.md)

Phase 9.29 archive smoke result:

```text
archive = data/archive/phase9.29/combined-valid-three-20260818-1539
source runs = Test1, Test2, Test3
selected = 7 with exact 3/5/15-minute coverage
primary labels = 3 TARGET_FIRST, 3 STOP_FIRST, 1 MAX_HOLD
provider calls / database writes / sessions / orders / fills / positions = 0 / 0 / 0 / 0 / 0 / 0
recommendation = NO_DEFENSIBLE_HYPOTHESIS
```

The source cohort passed mechanical validity, exact coverage, and minimum label-count checks. It
failed independent non-target run support, selected/label run-concentration checks, leave-one-out
direction checks, and the required fixed narrower predicate gate. No successor profile, new
collection, or strategy change is authorized from this result.

## Phase 10 Direction

Phase 10 is a local, read-only Research Dashboard and Archive Explorer. Its purpose is to make the
existing archive evidence usable without producing more undirected research. It browses canonical
archived runs, cohorts, candidates, structured reports, and provider pressure; compares later
target-first, stop-first, and maximum-hold labels; and inspects decision-time candidate facts and
score attribution with explicit provenance and missingness.

The first pass uses a one-way archive exporter and a local static dashboard. It consumes structured
reports before read-only archive-database fallbacks and never uses terminal transcripts as a data
source. It excludes active `data/nexus_paper.db*` and the recoverable legacy-root cleanup copies.
It makes no provider calls, database writes, sessions, orders, fills, positions, wallet actions,
signing, submission, strategy changes, or monitoring changes. The visible safety state remains
`PAPER` / shadow-only, BUY=90, WATCH=70, execution disabled.

Detailed checklist:

- [NeXusTrade-Phase-10-Detailed-Checklist.md](./NeXusTrade-Phase-10-Detailed-Checklist.md)

## Phase 10 Implementation Result

Phase 10 is implemented as a one-way, archive-only exporter and a Vite/React local static viewer.
The exporter accepts only explicit `phase9.28`, `phase9.29`, and named-cohort selections, projects
allowlisted versioned JSON into the ignored `frontend/public/research-dashboard-data/` directory,
and records deterministic content fingerprints that exclude only the audit timestamp. The initial
approved export produced 5 runs, 1 cohort, and 7 candidates with content fingerprint
`b02e16f3c19f3f016ff94b2405c072606a207dba767d3e51d583110c9b6147e5`.

The local dashboard exposes the fixed `PAPER`/shadow-only, BUY=90/WATCH=70, execution-disabled
state; archive/run provenance; provider-pressure categories; the 3 target-first / 3 stop-first / 1
max-hold later-label comparison; and candidate decision-time facts separate from later outcome
labels. It has no wallet, execution, runtime, or provider-control surface. The exporter and viewer
were verified with zero provider calls, database writes, sessions, orders/fills/positions, wallet
loading, signing, or submission. The next step is a human review of the inspectable evidence, not a
new shadow-study or strategy change.

Phase 10.1 closes the evidence-fidelity presentation gap without changing the research contract. It
adds report-kind and provider-pressure-availability exploration; displays run membership, recorded
concentration distributions, and pre-registered cohort gates; separates archived upstream,
cooldown, budget, controller, and venue-guard pressure; and puts the original decision/score/
threshold context ahead of later labels. These remain local static views, never inputs to selection.

## Phase 10.4 Result

Phase 10.4 is complete. It is a local CLI that turns one explicitly selected completed
archive set into deterministic Markdown or JSON for a reviewer/Codex to analyze directly. It reads
only known structured archive JSON, writes only to standard output, preserves decision-time facts
separately from later labels, carries concentration/gate evidence and the recorded conclusion, and
is not a new data-collection or hypothesis-selection phase. The initial fixture reproduces the
recorded `NO_DEFENSIBLE_HYPOTHESIS`, not a successor.

Detailed checklist:

- [NeXusTrade-Phase-10.4-Detailed-Checklist.md](./NeXusTrade-Phase-10.4-Detailed-Checklist.md)

Implementation result: `research:brief` now reads only five Phase 9.28 TerminalRunner summary JSON
reports and the one explicitly named Phase 9.29 fast-entry attribution report, then writes a
validated deterministic Markdown or JSON brief to standard output only. The approved initial scope
has fingerprint `5fb59e2bf4472ea4da2a516d1298398491b812d1a3ae811d745aa46d5ee308c7`; both output formats
reproduce the 7 exact-coverage candidates, 3 target-first / 3 stop-first / 1 max-hold labels,
Test3 selected/non-target concentration of 85.71% / 100%, recorded gates, and
`NO_DEFENSIBLE_HYPOTHESIS`. It has no database, provider/RPC/HTTP, runtime, filesystem-write,
wallet, execution, strategy, threshold, provider, or monitoring behavior.

## Phase 10.5 Direction

Phase 10.5 is complete. It is a source-traceable human-review and pre-registration gate over the
completed Phase 10.4 evidence, not a collection or strategy-tuning phase. Its initial fixed decision
is `NO_STUDY_AUTHORIZED`: the current seven-candidate cohort does not support a materially different
successor study. No Phase 10.6 collection, PAPER execution, profile/default change, or promotion is
authorized by creating or reviewing the record.

Implementation result: `research:review-gate` accepts only the explicit approved Phase 9.28/9.29
archive scope and the source-controlled default-deny record. It recomputes the Phase 10.4 brief in
memory, checks its fingerprint
`5fb59e2bf4472ea4da2a516d1298398491b812d1a3ae811d745aa46d5ee308c7`, and writes deterministic
Markdown or JSON to standard output only. The first gate has content fingerprint
`2846a8509f523104417e460d0bc0a6812d161f393ade666b73faea5caa19828b`; it reports all seven failed
attribution gates and preserves `NO_DEFENSIBLE_HYPOTHESIS`. Mechanical review assertions use fixed
fact-key/assertion-code enums with bounded sanitized notes. Candidate-pre-registration validation is
documented but deliberately deferred; the initial implementation rejects candidates and every
non-default-deny status.

Detailed checklist:

- [NeXusTrade-Phase-10.5-Detailed-Checklist.md](./NeXusTrade-Phase-10.5-Detailed-Checklist.md)

## Proposed Phase 10.5A Research Restart Pathway

Phase 10.5A is the implemented planning/local-validation phase. It does not weaken the completed
`NO_STUDY_AUTHORIZED` conclusion and did not collect data. Its only purpose is to define whether a
future, outcome-blind exploratory cohort could create enough independent evidence to evaluate a new
strategy family without re-running the closed F65E@v1 hypothesis.

The planned protocol must pre-register a broad population, mint and market-window deduplication,
decision-time facts, provider-budget limits, observation horizons, missing-data behavior, and a
discovery/validation split before any live-market collection occurs. Later returns and labels cannot
select the population, alter the plan, or become entry inputs. No provider calls, database access,
TerminalRunner run, strategy change, paper order, wallet action, signing, or submission is permitted
in Phase 10.5A itself. Its sole permitted implementation command is a strict local stdout-only
protocol validator; it cannot collect or configure a market runtime.

The frozen source-controlled protocol is
`docs/research-protocols/phase10.6a-exploratory-cohort.v1.json`, SHA-256
`748a159464ddfae3d7821e5e18bc690d87c2ac82cf2d89b596a11f4612fce152`.
The local validator returned `PROTOCOL_READY_FOR_SEPARATE_COLLECTION_APPROVAL` with content
fingerprint `2a21ec935618ebf7f7fed628c7f276474a104fb55dcb9f45f4a721bf4e9833e5`.
That result is non-authorizing.

Only a separately approved Phase 10.6A checklist may collect the resulting observational cohort.
Its output is not a strategy validation or a promotion signal. A later archive-only Phase 10.6B
analysis may return `PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL` only to support drafting a
materially distinct candidate; only an approved Phase 10.6C may validate that new shadow study.
Phase 10.7,
Phase 10.8A, and Phase 10.8B remain unavailable until those evidence gates pass.

## Implemented Phase 10.6A Exploratory Cohort Collection

Phase 10.6A is implemented as the first strictly bounded live-observation phase after Phase 10.5A. It
may use only a new archive-only collector, the frozen `EXPLORATORY_COHORT@v2` protocol, 2-hour UTC
slots, one outcome-blind selected mint per slot, and the fixed decision-time/later-label boundary.
It cannot reuse the scanner, watchlist, session, database, strategy, PAPER, or execution surfaces.

The detailed checklist pre-registers a narrow direct provider mapping, provider pacing and budgets,
a non-executable quote probe, 3/5/15/60-minute label observations, archive lifecycle, stop rules,
and a separate explicit launch authorization for one named archive root. Completion or incompletion
will be observational evidence only. Neither result can authorize Phase 10.6B, Phase 10.6C, a
strategy change, PAPER execution, or promotion.

V2 preserves V1 unchanged but supersedes it for proposed collection because its caps cover all 168
attempted slots (and all four labels per slot) without retries, fallbacks, replacements, or a wider
cohort. It also fixes `discoverTokens(100)`, the non-overlapping external-invocation schedule, and
exclusive archive-root locking. The lock precedes all first-root artifacts; source inventory uses a
canonical hash of sanitized provenance only; final summaries carry aggregate evidence only. V2
remains non-authorizing until this checklist is approved, implemented, verified, and separately
authorized for one named root.

The implemented command is `pnpm research:exploratory-cohort:collect --` with only the V2 protocol,
one V2 `YYYYMMDD-0000Z` archive root, `--once`, and an optional format. It validates the fixed
protocol and a source-controlled launch record before archive or provider work. Development tests use
only fakes; its stale-lock path finalizes the affected root as incomplete without another provider
call, including a crash before initial artifacts. `corepack pnpm verify` passed locally on 2026-08-19:
backend 114 files / 379 tests, frontend 2 / 4, shared 4 / 13.

The one authorized first observational launch is source-controlled at
`docs/research-launches/phase10.6a-exploratory-cohort-v2-20260821-0000Z.json` for archive root
`data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z` and UTC start
`2026-08-21T00:00:00.000Z`. Its local config/launch/protocol validation passed with zero provider,
database, or filesystem-write actions before collection. The authorized external schedule then
collected 100 attempted slots and finalized `COHORT_COMPLETE` on 2026-08-29 after reaching the fixed
96-valid-unit target. Its immutable final inventory contains 382 on-time and 2 missing later labels,
zero database/execution safety counters, and hashes recorded in the Phase 10.6B checklist. The
repeating collector task is disabled; the one provider-free confirmation ran successfully at 6:01 PM
PDT on 2026-09-03 with exit code zero. This is observational evidence only and does not itself
authorize any execution action.

## Implemented Phase 10.6B Exploratory Cohort Archive Analysis

The detailed Phase 10.6B checklist was pre-registered before the first cohort label and is now
reconciled to the one finalized V2 archive. It fixes the 60-minute primary label, seven decision-time
fields, outcome-blind discovery quantiles, held validation, exact Fisher, date stability, and the
sole non-authorizing positive outcome. Its strict local analyzer was implemented on 2026-08-30 and
verified with temporary synthetic archives before the user separately authorized one real-archive,
stdout-only run after the 2026-09-03 provider-free closeout. That report hard-verified the approved
four-file identity (`MATCHED`), passed all cohort quality gates, and returned
`NO_DEFENSIBLE_HYPOTHESIS` because no fixed discovery rule advanced to held validation. Its audit
fingerprint is `5b57410a3fa9164ba2671f7fb118fdda65985802b56411f67e4835f1fdde39b6`.

This result permits only preservation of the immutable archive and retained stdout report. It does
not authorize a candidate, Phase 10.6C, another collection, strategy/default/threshold change,
PAPER action, wallet action, signing, submission, order, fill, position, or promotion.

## Closed Phase 10.6B.1 Decision-Time Measurement And Missingness Audit

Phase 10.6B.1 was the immediate research step, not a successor-hypothesis or validation phase. Its
detailed checklist defined and implemented a deterministic, archive-only review of the existing V2 evidence to answer why
the fixed decision-time catalog had insufficient `LIQUIDITY` coverage and unavailable momentum facts.
It may examine only sanitized decision-time field availability, bounded missingness classifications,
source-inventory provenance/capability outcomes, and their date and partition distributions. It must
not read, aggregate, compare, or expose any later label, positive outcome, target, stop, P/L, or
candidate effect.

The audit may conclude only that there is no actionable measurement change, that the available
evidence is insufficient for a measurement conclusion, that human review is required, or that a
specific measurement-only revision may be drafted for separate protocol review. A last outcome is not
a new protocol, collection authorization, candidate, Phase 10.6C authorization, strategy adjustment,
PAPER action, or promotion. The V2 archive remains immutable and no provider, database, runtime,
filesystem-write, wallet, or execution surface is permitted. Implementation completed on 2026-09-04
with temporary synthetic fixtures, followed by one separately approved real-archive run with zero
audit side effects and immutable identity `MATCHED`.

The real audit found systemic, attributable decision-time deficiencies only: `LIQUIDITY` had
`UNAVAILABLE_AT_ANCHOR` coverage gaps, while `MOMENTUM_5M` and `MOMENTUM_15M` were `UNSUPPORTED`
across both partitions and nine UTC dates. The separate V3 measurement protocol and its one approved
static validation are complete. A prospective V3 cohort still requires its own detailed collector
checklist, separate implementation approval, synthetic verification, named archive-root authorization,
external scheduler authorization, and later archive-only analysis before Phase 10.6C can be
reconsidered.

Related detailed implementation checklists:

- [NeXusTrade-Phase-10.6A-Detailed-Checklist.md](./NeXusTrade-Phase-10.6A-Detailed-Checklist.md)
- [NeXusTrade-Phase-10.6B-Detailed-Checklist.md](./NeXusTrade-Phase-10.6B-Detailed-Checklist.md)
- [NeXusTrade-Phase-10.6B.1-Detailed-Checklist.md](./NeXusTrade-Phase-10.6B.1-Detailed-Checklist.md)
- [NeXusTrade-Phase-10.6B.2-Detailed-Checklist.md](./NeXusTrade-Phase-10.6B.2-Detailed-Checklist.md)
- [NeXusTrade-Phase-10.6A.2-Detailed-Checklist.md](./NeXusTrade-Phase-10.6A.2-Detailed-Checklist.md)
- [NeXusTrade-Phase-10.6B.3-Detailed-Checklist.md](./NeXusTrade-Phase-10.6B.3-Detailed-Checklist.md)

## Implemented Phase 10.6B.2 Measurement-Only Protocol Design And Static Review

The completed 10.6B.1 result permits only a separate protocol-design step. Phase 10.6B.2 must convert
the bounded availability record for `LIQUIDITY`, `MOMENTUM_5M`, and `MOMENTUM_15M` into either one
fully concrete, outcome-blind V3 measurement protocol draft or an explicit no-draft/human-review
conclusion. It may not infer a provider remedy or collection setting from the audit result itself.

The completed implementation adds the pinned `EXPLORATORY_COHORT_MEASUREMENT@v3` source and an
isolated stdout-only validator. V3 measures only direct liquidity at anchor and fixed local 5-/15-minute
pre-anchor price changes using four -15/-10/-5/0 minute observations. Its source evidence contains only
the 10.6B.1 fingerprint, V2 root/protocol identity, and the three permitted aggregate signatures; it
does not retain V2 artifact hashes or raw payloads. The static boundary, synthetic tests, typecheck,
lint, formatting, and secret scan pass. Its one separately approved stdout-only static validation also
passed. No collector, scheduler, archive, provider, database/runtime, strategy, PAPER, or execution
action has occurred.

The static validation returned `MEASUREMENT_PROTOCOL_DRAFT_READY_FOR_SEPARATE_COLLECTION_CHECKLIST_REVIEW`,
fingerprint `b992982000ac2e0fb51cd7944a979adc0114f77a6845b3d36a3d88b9eab3e4e6`, and literal zero
provider/HTTP, archive, database, filesystem-write, runtime, scheduler, session, and execution
counters. The next gate is a separate V3 measurement-only collection implementation checklist. A
passing static result does not authorize a collector, named archive root, scheduler, provider call,
collection, Phase 10.6C, or execution.

Related detailed implementation checklist:

- [NeXusTrade-Phase-10.6B.2-Detailed-Checklist.md](./NeXusTrade-Phase-10.6B.2-Detailed-Checklist.md)

## Implemented Phase 10.6A.2 V3 Measurement-Only Cohort Collector

The completed V3 static result and later separate implementation approval produced an isolated V3
collector without revising the protocol, reopening the V2 archive, expanding providers, or
reintroducing later labels. It fixes one direct DEXSCREENER discovery at anchor−16 minutes and four
direct `BEST_PAIR` snapshots at anchor−15/−10/−5/0 minutes, with exact formulas and fixed 168/672
no-retry/no-fallback caps.

The implementation uses a fail-closed protocol-fidelity mapping for the normal archive lifecycle,
lock-before-artifacts handling, malformed-root no-write refusal, and synthetic-only fake-clock tests.
The focused 10-test suite and format, lint, typecheck, and secret checks passed. The named launch
record for `measurement-v3-20260904-2100Z` was approved and validated locally. The user subsequently
registered and armed the operator-owned scheduler for that exact root; the frozen measurement-only
collection is active. Do not alter the active protocol, root, or task. The remaining independent
authority gate after collection is archive-only analysis; implementation does not authorize Phase
10.6C, strategy work, PAPER, or execution.

Related detailed implementation checklist:

- [NeXusTrade-Phase-10.6A.2-Detailed-Checklist.md](./NeXusTrade-Phase-10.6A.2-Detailed-Checklist.md)

## Implemented Phase 10.6B.3 V3 Final Measurement Capability Analysis

Phase 10.6B.3 is the implemented archive-only successor once the active V3 collection reaches a
final state. It assesses only whether the frozen measurement protocol met its already-declared
availability, freshness, provenance, population-independence, and zero-safety gates. The three
possible results are `MEASUREMENT_CAPABILITY_CONFIRMED`,
`MEASUREMENT_CAPABILITY_NOT_CONFIRMED`, or `MEASUREMENT_EVIDENCE_INSUFFICIENT`.

The analyzer was implemented and verified with synthetic fixtures on 2026-09-09 without reading the
active V3 root. Phase 10.6H H1 closed the later required-test gaps on 2026-09-10: 245 tests and
all required source checks pass. The original 11-test pass remains historical evidence; the H1
record now maps every required case to current verification. Its production CLI default-denies
until a separately reviewed source-only binding records the final protocol and four artifact hashes.
A later exact-root stdout run also requires
separate approval. It will not use the interim collection snapshot to choose a successor protocol,
and it cannot authorize a V4 design, collection, Phase 10.6C, strategy change, PAPER action, or
execution.

Related detailed implementation checklist:

- [NeXusTrade-Phase-10.6B.3-Detailed-Checklist.md](./NeXusTrade-Phase-10.6B.3-Detailed-Checklist.md)

## Phase 10.6H Engineering Integrity And Development Hardening

Current status: H1 is committed on the isolated branch as `a0bfdf9`; its 245 tests still pass.
H2 isolated engineering acceptance is complete on September 16 against its
[detailed checklist](./NeXusTrade-Phase-10.6H-H2-Detailed-Checklist.md) and
[verification record](./Phase-10.6H-H2-Verification.md). Operational integration remains separate. H2 is committed as `ff6d586`; the [H3 detailed implementation checklist](./NeXusTrade-Phase-10.6H-H3-Detailed-Checklist.md) was approved and implemented in isolation on September 17 (98 H3 tests, 245 H1 and 194 H2 compatibility tests). See the [H3 verification record](./Phase-10.6H-H3-Verification.md); H3 is committed as `f8f8d4c` and is integrated into main at `63f5378`. The [H4 detailed implementation checklist](./NeXusTrade-Phase-10.6H-H4-Detailed-Checklist.md) was implemented and passed local/hosted acceptance; PR #5 integrated H4 into main at `88921e9`. See the [H4 verification record](./Phase-10.6H-H4-Verification.md).

The [10.6H checklist](./NeXusTrade-Phase-10.6H-Detailed-Checklist.md) owns bounded improvements to
existing development. H1 supplies the analyzer verification needed for 10.6B.3 closeout. H2 addresses
partial trade persistence, duplicate processing, database constraints, migration readiness, and
read-only reconciliation. H3 repairs general limiter concurrency while preserving frozen provider and
measurement contracts. H4 enforces dependencies, runtime validation, isolated automated checks, and
targeted maintainability improvements.

Documentation may proceed while V3 runs. Later implementation may proceed only with demonstrated
physical isolation from the scheduled checkout, dependencies, data, and machine-wide configuration.
A different branch in the same directory is insufficient. Hold shared operational changes through
V3 closeout and preserve pending analyzer dependencies through its report. Existing research outcomes,
protocols, schedules, thresholds, and operational approvals remain unchanged.

Engineering work can progress regardless of V3's result. Candidate research depends on the separate
evidence pathway in the [Post-V3 Development Plan](./Post-V3-Development-Plan.md). That plan assigns
requirements to future phases without declaring their detailed protocols or implementations complete.

## Future Promotion Rule

Any future strategy promotion must create or select an explicit profile version, document the
evidence, update the active Phase 9+ decision log, and pass through a separate promotion review
before changing default paper strategy behavior.

## Proposed Phase 10.7A Paper-Pilot Experiment Protocol

Phase 10.7A is a future documentation and pre-registration stage, positioned after a successful
Phase 10.7 promotion review and before either paper-operations implementation or a paper pilot. It
will translate an actually promoted evidence-backed profile into a bounded operational experiment
contract; it is not a mechanism for promoting the current evidence or for enabling execution.

The future protocol must fix, before implementation, a small set of versioned experimental profiles;
a shared time-stamped market universe; isolated simulated portfolio/ledger identities; a declared
fee, slippage, latency, and fill model; exposure, drawdown, and session-loss limits; operational and
P/L measures; profile comparison/retirement rules; and a fixed review cadence. A 4-6-hour session and
5-7-day batch are possible future values only when their sampling, independence, and minimum-evidence
requirements are pre-registered. A strategy version may change only between completed batches, and a
changed version must return to independent shadow validation before another paper-pilot batch.

Phase 10.7A may not create a session, access a provider, write a simulated order/fill/position/P/L,
enable a PAPER setting, change a strategy default, or use a wallet, signing, or submission surface.
Those operational capabilities remain separately gated in Phase 10.8B, after a frozen protocol and a
separate named-pilot approval.

## Proposed Paper Operations Pathway

The Phase 10 Research Dashboard remains an archive-only, static evidence viewer. It must never be
extended with active session, execution, wallet, or provider controls. A separate, local Paper
Operations Dashboard is proposed as Phase 10.8A only after a strategy profile clears a separate
promotion review and Phase 10.7A freezes the Paper-Pilot Experiment Protocol.

The first Paper Operations Dashboard will be read-only from the operator interface and show active
PAPER sessions, orders, fills, open/closed positions, realized P/L, unrealized mark-to-market P/L,
daily and cumulative P/L, equity/drawdown, exposure, provider/quote provenance, mark timestamps,
and stale-mark warnings. It must derive realized P/L from recorded fills/closed positions and fees;
unrealized P/L must identify the stored mark source and its `asOf` timestamp. The dashboard itself
will not fetch prices, create sessions, place orders, sell, load a wallet, sign, or submit.

Phase 10.8B may begin only after the Phase 10.7 review approves a frozen strategy/profile version,
Phase 10.7A freezes a paper-pilot experiment contract, applicable Phase 10.6H H2-H4 acceptance is
recorded for the implementation used, and the user separately authorizes one named pilot. Its
synthetic implementation verification must establish atomic/repeat-safe accounting, recovery,
reconciliation, and enforceable run limits before operation. Phase 10.9 establishes operational
validity before interpreting simulated performance. Pilot findings may motivate a new strategy
version, but only between fixed pilot batches. Every changed version returns to independent shadow
validation before another paper pilot. Phase 11 then
hardens the system for guarded live readiness; Phase 12 permits only tiny, explicitly bounded live
experiments; and a separate future Phase 14 gate is required before autonomous live-wallet trading.
