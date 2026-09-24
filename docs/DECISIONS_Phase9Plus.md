# NeXusTrade Decision Log Phase 9+

Active decision log for Phase 9 and later.

Last updated: 2026-09-09

## Historical References

Use [DECISIONS.md](./DECISIONS.md) for decisions through Phase 8.93.

Use these related historical handoff docs when a Phase 9+ decision depends on older evidence:

- [ROADMAP.md](./ROADMAP.md)
- [Structure.md](./Structure.md)
- [Phase-9-Planning-Inputs.md](./Phase-9-Planning-Inputs.md)
- [NeXusTrade-Phase-8.93-Detailed-Checklist.md](./NeXusTrade-Phase-8.93-Detailed-Checklist.md)

## 2026-07-09 - Start Active Phase 9+ Docs

Decision: Phase 9 and later work should use smaller active docs instead of continuing to grow the
large historical roadmap, decision log, and structure inventory.

Reason: The completed Phase 1-8.93 docs are valuable as historical evidence, but they are large
enough to create context and maintenance drag. A Phase 9+ doc set keeps future implementation,
research, and decisions easier to review while preserving links to the older trail.

Status: Accepted.

## 2026-08-05 - Add Read-Only Research Truthing Before Adapter Changes

Decision: Phase 9.4A.1 adds `pnpm research:truth --once` as a read-only archive/reporting
truthing command before any Phase 9.4A.2 adapter correctness or runtime quote-pressure changes.

Reason: Phase 9.4 proved Birdeye selective enrichment could run safely, but the archive reports
needed clearer row-limit disclosure, full-session DB counts, quote-evidence attribution, Birdeye
budget/CU attribution, provider failure reclassification, concentration analysis, and blocker
truthing. Changing runtime providers before those measurements were trustworthy would risk fixing
the wrong problem.

Implementation result: The Phase 9.4A.1 smoke over the three Phase 9.4 archives passed the safety
boundary with `orders/fills/positions = 0`, counted 2458 decision rows, classified 2037 missing
quote rows with `unclassifiedMissingQuote = 0`, reclassified 66 Birdeye budget guardrail skips away
from provider failure, and identified dominant run/mint concentration. The selected next step is
Phase 9.4A.2 adapter correctness and diagnostics.

Status: Accepted and implemented.

## 2026-08-05 - Close Out Phase 9.4A.1 Reporting Semantics

Decision: Keep Phase 9.4A.1 read-only and correct its output semantics without creating another
numbered implementation phase. Generated `research:truth` JSON omits duplicated TerminalRunner
cycles by default, counts only live Birdeye endpoint calls toward estimated CU, separates provider
correlation from direct candidate evidence, and resolves blocker thresholds from archived session
configuration when present or current 70/90 defaults otherwise.

Reason: The first smoke was safety-valid but its report could imply that display limits constrained
analysis, that run-level rate pressure proved an individual quote failure, or that cache/budget rows
consumed live Birdeye CU. Those are reporting defects, not trading behavior defects.

Status: Accepted and implemented as the Phase 9.4A.1 closeout patch.

## 2026-08-05 - Keep Phase 9.4A.3 Conditional

Decision: Do not create or schedule Phase 9.4A.3 now. It becomes a narrow persistence-hardening
phase only if Phase 9.4A.2 proves that existing `ProviderHealth.contextJson` plus the bounded
in-memory journal cannot safely retain latest-attempt, last-success, and optional round-trip quote
diagnostic evidence.

Reason: A migration or persistent diagnostic table is justified only by demonstrated evidence loss,
not by a hypothetical future use case. Phase 9.4B remains a pressure-reduction phase and should use
venue-aware routing first when diagnostics show no-route outcomes dominate.

Status: Accepted as a conditional decision gate.

## 2026-07-09 - Keep Phase 9 Shadow-First

Decision: Phase 9 TerminalRunner must be shadow-first by default. It may orchestrate scanner, risk,
strategy, shadow observation, shadow exits, shadow calibration, shadow entries, watchlist returns,
analytics, and calibration reports. It must not run `paper:execute` by default.

Reason: Phase 8.93 promoted no profile into paper strategy defaults. The project needs more
automated research evidence before paper BUY orchestration is justified.

Status: Accepted.

## 2026-07-09 - TerminalRunner Is An Orchestrator

Decision: TerminalRunner should coordinate existing runner/service surfaces and summarize outcomes.
It should not invent strategy rules, tune scores, promote profiles, or treat shadow P/L as realized
P/L.

Reason: Keeping orchestration separate from strategy research preserves the workflow established in
Phases 8.91 through 8.93: measure, experiment, refine, review promotion, then orchestrate.

Status: Accepted.

## 2026-07-09 - Provider Expansion Must Follow Observability

Decision: Phase 9 should add provider pressure reporting, but should not add new external provider
adapters by default. Provider cache/backoff/fallback work belongs in Phase 9.1+, after TerminalRunner
can measure quote demand, rate limits, degraded providers, missing quotes, and candidate outcomes.

Reason: Jupiter rate limiting is real, but strategy timing and drawdown instability remain separate
research problems. Adding providers before measuring pressure inside the automated loop could hide
the root cause and make later calibration harder.

Status: Accepted.

## 2026-07-09 - Provider Fallback Ladder

Decision: The planned provider ladder is cheap market data first, Jupiter for high-intent aggregate
quotes, Raydium as the first direct quote fallback, Autobahn/Titan only after access is confirmed,
and Meteora/Orca as later pool-specific adapters.

Reason: This preserves broad route coverage while adding resilience in small, measurable steps.
Raydium is the closest fit for the current `QuoteProvider` shape. Birdeye Standard is useful for
selective enrichment but is not a high-throughput quote replacement.

Status: Accepted.

## 2026-07-09 - Birdeye Standard Is Selective Enrichment

Decision: Birdeye Standard should be planned as a selective enrichment provider, not as a broad
scanner or Jupiter quote replacement.

Reason: Current account access is Standard with 30,000 CUs/month, 1 RPS, no overage, and no
WebSocket access. This is valuable for top candidates, shadow-observed candidates, BUY-like
candidates, open paper positions, and missed-opportunity analysis, but not for every scanner row.

Status: Accepted.

## 2026-07-09 - TerminalRunner Implementation Shape

Decision: Implement TerminalRunner under `backend/src/terminal-runner`, compose existing
runner/service classes directly, and expose it through `pnpm terminal:run`.

Reason: Direct composition avoids shelling out to package scripts, keeps tests fast, and lets Phase
9 summarize structured stage results and provider-pressure deltas.

Status: Accepted.

## 2026-07-09 - TerminalRunner Runtime Defaults

Decision: TerminalRunner defaults to one shadow-only cycle. `--cycles` and
`--max-runtime-minutes` enable loop mode. Console output is the default; `--output-dir` writes JSON
and text artifacts.

Reason: This matches the manual runbooks while keeping short smoke checks easy and generated
artifacts opt-in.

Status: Accepted.

## 2026-07-09 - Provider Pressure Uses ProviderHealth Deltas First

Decision: Phase 9 provider pressure is computed from `ProviderHealth` rows observed during each
stage/cycle. Deeper quote-attempt/cache/fallback metrics remain Phase 9.1 work.

Reason: ProviderHealth already exists and is safe to summarize without refactoring provider
interfaces during the TerminalRunner phase.

Status: Accepted.

## 2026-07-09 - TerminalRunner Uses One Session Per Run

Decision: TerminalRunner creates one `PAPER` + `RUNNING` session at startup and passes that
`sessionId` into scanner, risk, strategy, shadow, watchlist, analytics, calibration, shadow
calibration, and shadow entry stages for every cycle in the run.

Reason: The first Phase 9 validation run proved the runner was safe, but each scanner cycle
auto-created a new session. That made later reports focus on the latest session instead of the
whole validation window. A single run-scoped session keeps long-run research data coherent and
auditable.

Status: Accepted.

## 2026-07-09 - TerminalRunner Prints Compact Progress Logs

Decision: Normal TerminalRunner runs print compact cycle and stage progress lines. `--json` keeps
machine-readable output clean and does not emit progress logs.

Reason: Two-hour validation runs previously looked idle after the startup banner. Progress logs
make long runs easier to supervise without changing research data or report outputs.

Status: Accepted.

## 2026-07-10 - Make Phase 9.1 Cross-Run Research Aggregation

Decision: Phase 9.1 should implement cross-run research aggregation and promotion-gate reporting
over archived Phase 9 TerminalRunner runs. It should not change strategy defaults, scoring weights,
risk rules, provider adapters, or paper execution behavior.

Reason: The first three valid Phase 9 runs showed real upside in the candidate stream, but also
small unique-mint samples, inconsistent target-before-stop behavior, unstable scenario portfolio
results, and persistent Jupiter rate limiting. A controlled paper pilot should be based on a
repeatable cross-run profile, not on one noisy P/L window.

Status: Accepted.

## 2026-07-10 - Separate Controlled Paper Pilot From Research Aggregation

Decision: A controlled paper pilot is a future explicit phase, not part of Phase 9.1. Phase 9.1 may
recommend `CANDIDATE_FOR_CONTROLLED_PAPER_PILOT`, but it must not execute that pilot.

Reason: Paper trading has no real SOL risk, but it can still produce misleading research if entry,
exit, quote availability, provider failures, and market-window luck are mixed into one P/L number
before the hypothesis is clear.

Status: Accepted.

## 2026-07-10 - Phase 9.1 Result Is Promising Research, Not Pilot Promotion

Decision: The first Phase 9.1 aggregation result should be treated as `PROMISING_RESEARCH` with
medium confidence, not as permission to run automated paper BUY execution.

Reason: The three valid Phase 9 TerminalRunner archives had coherent one-session data, 277 observed
decisions, 13 unique mints, and no paper execution rows. However, target-first wins were still
concentrated in one market window, no shadow-entry profile cleared the Phase 8.92B promotion
workbench, and Jupiter rate limiting remained materially high at roughly 52.67%.

Status: Accepted.

## 2026-07-10 - Phase 9.1 Aggregator Is Read-Only

Decision: `pnpm research:aggregate` opens archived paper databases read-only, consumes
TerminalRunner JSON plus shadow calibration/entry evidence, and writes only optional report
artifacts under ignored `data/` paths.

Reason: The command is a research and promotion-gate tool. It must not mutate archived datasets,
change strategy defaults, enable `paper:execute`, or convert shadow results into realized P/L.

Status: Accepted.

## 2026-07-11 - Make Phase 9.2 Provider Resilience Before Provider Expansion

Decision: Phase 9.2 should add quote request identity, in-memory quote caching, Jupiter backoff,
quote priority, and a provider fallback router before adding new external provider adapters.

Reason: Phase 9.1 showed Jupiter rate limiting around 52.67%, but the correct first response is to
reduce duplicate demand and improve evidence quality. Adding several APIs before cache/backoff
would make provider pressure harder to interpret and could hide strategy timing and drawdown issues.

Status: Accepted.

## 2026-07-11 - Keep Jupiter As The Only Live Quote Provider In Phase 9.2

Decision: Jupiter remains the only live quote provider in Phase 9.2. Raydium, Birdeye, Titan,
Autobahn, Meteora, and Orca remain planned future provider phases.

Reason: The fallback framework should be testable with the current provider surface first. A
Jupiter-only router can prove cache, cooldown, priority, provenance, and reporting behavior without
adding external API contracts or new credentials.

Status: Accepted.

## 2026-07-11 - Use In-Memory Quote Cache First

Decision: Phase 9.2 quote cache should be process-local and in-memory only, with successful quote
entries cached by stable request identity. Default cache settings should be conservative:
`enabled=true`, `ttlMs=15000`, and `maxEntries=1000`.

Reason: This can reduce duplicate live quote calls during TerminalRunner cycles without a database
migration, raw payload persistence, or cross-run data ambiguity. Persistent quote history can be
added later if dashboard or backtest work needs it.

Status: Accepted.

## 2026-07-11 - Preserve Quote Provenance And Missing-Quote Evidence

Decision: Phase 9.2 must report quote provenance explicitly through cache/backoff/fallback context.
Cached quotes, live quotes, skipped cooldowns, unavailable quotes, and future fallback quotes should
remain distinguishable.

Reason: The research pipeline depends on knowing whether a candidate had real quote confidence,
cached quote confidence, or missing quote evidence. A fallback must not silently turn missing quote
into a fake pass, and DexScreener/Birdeye market prices should not be mislabeled as executable
quotes.

Status: Accepted.

## 2026-07-11 - Keep Phase 9.2 Safety Boundary Unchanged

Decision: Phase 9.2 must not enable paper BUY automation, call `paper:execute` from TerminalRunner,
load wallets, sign transactions, submit transactions, promote a profile, or change strategy scoring
defaults.

Reason: Provider resilience improves evidence quality. It is not a promotion review or a trading
execution phase.

Status: Accepted.

## 2026-07-13 - Insert Phase 9.2B Before Raydium

Decision: Insert Phase 9.2B before Phase 9.25 and Phase 9.3. Phase 9.2B should clean provider
measurement, separate live provider pressure from router cooldown behavior, reduce Jupiter token
metadata pressure, and make existing Phase 9.2 archives easier to aggregate.

Reason: The five Phase 9.2 validation runs showed quote cooldown skips were working, but cache hits
were zero and the aggregate provider-pressure report mixed router cooldown rows with live Jupiter
rate limits. The largest remaining live Jupiter pressure came from `token-metadata-from-price`, not
quotes. Raydium would not address that specific bottleneck.

Status: Accepted.

## 2026-07-13 - Prefer Helius Metadata Over Jupiter Metadata

Decision: Phase 9.2B should prefer Helius token metadata and disable or demote Jupiter token
metadata by default while keeping Jupiter available for aggregate quotes.

Reason: Phase 9.2 data showed Helius metadata calls succeeded, while Jupiter
`token-metadata-from-price` accounted for most live Jupiter rate-limit pressure. Jupiter metadata is
partial metadata through the Price API and should not be the default metadata source during Phase
9.x research.

Status: Accepted.

## 2026-07-13 - Separate Live Provider Metrics From Router Metrics

Decision: Provider-pressure reports should distinguish live provider rows from quote-router rows
such as cache hits, cooldown skips, and unavailable quote results.

Reason: Router cooldown skips are useful evidence that the system avoided live calls, but counting
them as ordinary provider rate limits makes Jupiter pressure look worse and makes provider work
harder to evaluate.

Status: Accepted.

## 2026-07-13 - Add Phase 9.25 Research Interpretation Before Raydium

Decision: After Phase 9.2B, add Phase 9.25 for research interpretation and skipped-opportunity
diagnostics before implementing Raydium fallback.

Reason: The five Phase 9.2 runs showed meaningful score-65 signal but strong market-window
concentration. The project now needs to explain high-scoring SKIPs, WARN outcomes, missing quote
behavior, and market-window effects before adding another provider variable.

Status: Accepted.

## 2026-07-13 - Include Decision Attribution In Phase 9.25

Decision: Phase 9.25 should include decision attribution for every BUY, WATCH, and SKIP. The report
should identify score component contributions, the first blocking factor, the highest-impact
blocking factor, and readable risk/quote/liquidity/volume/age/authority explanations.

Reason: Phase 9.25 needs to explain why high-potential candidates were skipped before strategy
defaults or provider integrations change. Decision attribution makes later calibration and dashboard
work more explainable.

Status: Accepted.

## 2026-07-13 - Defer Counterfactual Decision Analysis

Decision: Counterfactual decision analysis should be documented as future Phase 9.26 or Phase 10
work, not Phase 9.25.

Reason: Counterfactual reports such as "if quote existed then WATCH" or "if risk PASS then BUY" are
valuable, but they require careful simulation boundaries so hypothetical decisions are not confused
with observed evidence.

Status: Accepted.

## 2026-07-13 - Phase 9.2B Provider Truthing Implementation

Decision: Phase 9.2B should implement provider pressure classification, expose live-vs-router
provider metrics in TerminalRunner/analytics/calibration/research reports, base promotion cautions
on live Jupiter rate limiting, default `JUPITER_TOKEN_METADATA_ENABLED=false`, prefer Helius token
metadata before optional Jupiter fallback, raise the research quote cache default to
`QUOTE_CACHE_TTL_MS=90000`, and support nested TerminalRunner archive folders in
`research:aggregate`.

Reason: The five Phase 9.2 validation runs showed that router cooldown skips were useful but
inflated combined rate-limit reporting, quote cache TTL was too short for the 60-second
TerminalRunner cadence, and most remaining Jupiter pressure came from token metadata rather than
quotes. These changes make the next Phase 9.25 interpretation work cleaner without changing
strategy defaults or adding provider complexity.

Status: Accepted and implemented.

## 2026-07-14 - Phase 9.25 Selects Raydium Quote Fallback

Decision: Phase 9.3 should add Raydium as the first direct quote fallback behind the existing
`QuoteProvider` interface and quote router.

Reason: Phase 9.25 interpreted the cleaned Phase 9.2B data and found that missing quote evidence
remained material after Jupiter metadata pressure was reduced:

```text
decision mode missingQuote = 311 / 468
first_per_mint missingQuote = 15 / 35
best_per_mint missingQuote = 15 / 35
Jupiter liveRateLimited = 15.92%
Jupiter combinedRateLimited = 44.68%
```

Raydium's Trade API exact-input quote endpoint fits the existing normalized quote interface better
than a broad market-data or execution integration.

Status: Accepted.

## 2026-07-14 - Keep Phase 9.3 Raydium Quote-Only

Decision: Phase 9.3 should call only Raydium quote computation:

```text
GET https://transaction-v1.raydium.io/compute/swap-base-in
```

It must not call Raydium transaction serialization endpoints, build transactions, load wallets,
sign, submit, enable paper BUY automation, or change strategy defaults.

Reason: Phase 9.3 exists to measure whether a direct quote fallback reduces missing quote evidence.
Execution behavior belongs to later explicit paper/live-readiness phases.

Status: Accepted.

## 2026-07-14 - Require Quote Provenance And Fallback Reason

Decision: Phase 9.3 should record quote provenance with normalized quote evidence and report why
Raydium was attempted or used.

Required model:

```text
quoteProvider = JUPITER | RAYDIUM | NONE
quoteSourceType = LIVE | CACHE | NONE
fallbackReason = NONE | JUPITER_RATE_LIMITED | JUPITER_COOLDOWN | JUPITER_UNAVAILABLE | ROUTER_POLICY | FORCED_PROVIDER
```

Reason: Raydium should be measurable as an experiment. Provider identity, cache state, and fallback
reason answer different research questions and should not be collapsed into a single provider
string.

Status: Accepted.

## 2026-07-14 - Add Phase 9.3 Exit Gate

Decision: Phase 9.3 should end with an explicit validation review after implementation, smoke
testing, three validation runs, `research:aggregate`, and `research:interpret`. Phase 9.4 should
not start automatically.

Reason: If Raydium materially reduces missing quote evidence, Birdeye may no longer be the next
highest-value phase. If Raydium does not help, the next step may be counterfactual analysis,
provider-aware quote confidence work, another quote fallback, or more data.

Status: Accepted.

## 2026-07-15 - Phase 9.3 Raydium Quote Fallback Implementation

Decision: Implement Raydium as a quote-only fallback behind the existing `QuoteProvider` interface
and quote router. Keep Jupiter first, Raydium second, and keep Raydium keyless for the first
implementation.

Reason: This implements the Phase 9.25 recommendation without expanding into execution behavior.
Normalized quote provenance and provider-pressure reporting now make Raydium usage measurable by
provider, live/cache source type, attempted providers, and fallback reason.

Status: Accepted and implemented; validation reviewed.

## 2026-07-15 - Add Phase 9.3B Before Birdeye Or Paper BUY

Decision: Add Phase 9.3B for Raydium diagnostics and Helius pressure cleanup before moving to
Birdeye, another fallback provider, or paper BUY automation.

Reason: Phase 9.3 improved missing quote coverage and reduced Jupiter pressure, but Raydium had a
very high error share and Helius became the dominant provider-pressure problem. The next step should
classify Raydium errors, verify request/preflight behavior using current Raydium docs, and reduce
avoidable repeated Helius metadata/risk calls.

Status: Accepted and implemented; validation complete.

## 2026-07-15 - Phase 9.3B Uses ProviderHealth Context Instead Of A DB Migration

Decision: Phase 9.3B stores Raydium failure categories, Raydium preflight status, Raydium mint-price
diagnostic flags, Helius evidence source, Helius cache state, and Helius cooldown skips in existing
`ProviderHealth.contextJson` instead of adding columns.

Reason: The Phase 9.3B goal is diagnostic cleanup, not long-term analytics schema design. Existing
provider-health context is already the report source for quote provenance and fallback reasons, and
using it avoids migration noise while preserving structured, sanitized evidence for TerminalRunner,
analytics, calibration, research aggregate, and interpretation reports.

Status: Accepted and implemented; validation complete.

## 2026-07-16 - Phase 9.3B Validation Selects Helius Fallback As Next Step

Decision: Stop unchanged Phase 9.3B validation and plan Phase 9.3C around Helius fallback / RPC
authority evidence before Birdeye expansion or paper BUY automation.

Reason: Phase 9.3B validation stayed paper-safe, but Helius free-plan credits were exhausted and
Helius-enabled runs showed 100% rate-limited behavior. Disabling Helius reduced noise but left
authority evidence broadly unavailable. Raydium diagnostics worked, but discovered-candidate
Raydium quote outcomes remained 0% OK with `RAYDIUM_UNAVAILABLE` and preflight `FAILED`. Jupiter
remained usable but pressured at roughly 50% combined rate-limited behavior.

Status: Accepted. Phase 9.3C should prioritize raw Solana RPC mint-account parsing, then QuickNode
DAS and Alchemy DAS as metadata/asset fallbacks.

## 2026-07-17 - Phase 9.3C Uses Raw RPC Before More Paid Metadata APIs

Decision: Phase 9.3C should implement raw Solana RPC mint-account parsing as the primary Helius
fallback, with QuickNode DAS and Alchemy DAS as metadata fallbacks. Shyft is deferred provider
research, not part of the Phase 9.3C implementation target.

Reason: Mint authority and freeze authority are account-state facts, so raw `getAccountInfo` is the
cheapest canonical source. DAS providers are useful for metadata and asset shape, but they should
not be required for authority PASS evidence. This keeps the system usable while Helius credits are
exhausted and avoids broad provider expansion before the authority evidence gap is fixed. Shyft's
free-tier shape makes it a poor first-choice implementation target compared with RPC + DAS.

Status: Accepted and implemented. Provider validation succeeded with Solana RPC and QuickNode DAS;
Alchemy DAS remains optional/deferred. The validation exposed a risk-rule consumption bug, fixed on
July 18, 2026. The July 19, 2026 follow-up confirmed missingAuthority dropped to 0 with Helius
disabled.

## 2026-07-18 - Phase 9.3C Keeps Disabled Authority As PASS Evidence

Decision: Treat explicit disabled mint/freeze authority evidence from Solana RPC as PASS evidence
inside the risk authority rule.

Reason: Phase 9.3C provider validation showed Solana RPC successfully parsed authority evidence,
but the archived risk/strategy reports still classified every observed decision as
`MISSING_AUTHORITY_EVIDENCE`. The rule still only understood the older Helius
absent-or-unknown shape. Explicit disabled authority is stronger evidence than unknown/missing and
should not be penalized.

Status: Accepted, implemented, and validated. `UNKNOWN` authority remains WARN, `PRESENT` authority
remains FAIL, and explicit `DISABLED` authority is now PASS evidence. The July 19, 2026 follow-up
produced `missingAuthorityEvidenceCount=0` and `missingAuthority=0`.

## 2026-07-19 - Phase 9.3C Completes Helius Authority Fallback

Decision: Accept Phase 9.3C as complete for Helius authority-evidence fallback, but do not promote
paper BUY automation or move directly to execution work.

Reason: The post-fix follow-up run validated raw Solana RPC authority evidence with Helius disabled:
`SOLANA_RPC` produced 4005 authority-evidence rows, `missingAuthorityEvidenceCount=0`,
`missingAuthority=0`, and orders/fills/positions stayed 0. Jupiter remained pressured and Raydium
remained unavailable for discovered candidate quotes, so the next provider work should focus on
quote coverage/quality rather than authority evidence.

Status: Accepted. Phase 9.3C authority fallback is complete; quote coverage remains the next
provider bottleneck.

## 2026-08-03 - Phase 9.4 Uses Birdeye Selectively

Decision: Phase 9.4 should add Birdeye as a selective market-data enrichment provider for
high-intent candidates, not as a broad scanner provider or executable quote provider.

Reason: The August 3 current baseline reconfirmed `missingAuthority=0` with `SOLANA_RPC`, while
Jupiter remained heavily pressured and Raydium only occasionally produced usable fallback quotes.
Birdeye Standard/free access is useful but constrained by 30,000 CUs/month, 1 RPS, no overage, and
no WebSocket access. Calling Birdeye for every scanner candidate would exhaust budget quickly and
would blur market-data evidence with executable quote evidence.

Status: Implemented for Phase 9.4. Runtime use still requires `BIRDEYE_API_KEY` in local `.env`,
keeps Helius optional/comparison-only for long runs, and preserves the no-paper-BUY boundary.

## 2026-08-04 - Add Phase 9.4A Before Provider Expansion

Decision: After Phase 9.4 validation, add Phase 9.4A for validation truthing, quote-evidence
attribution, Birdeye attribution, Raydium adapter correctness, and a read-only quote diagnostic
command before moving to Phase 9.4B or Phase 9.5.

Reason: The Phase 9.4 aggregate was safe and operationally valid, but the evidence is not yet
trustworthy enough for strategy promotion or another provider expansion. Birdeye worked without
external rate limiting, but budget exhaustion is currently reported like a provider error, exact CU
spend and unique enriched mints are not surfaced directly, and the aggregate was heavily
concentrated in one run and one mint. Quote evidence also remains too broad: missing quote can mean
missing buy quote, missing sell quote, incomplete round trip, or quote present without price-impact
evidence.

Status: Accepted for next planning. Phase 9.4A should split into archive/reporting truthing first
and adapter correctness/diagnostics second. Phase 9.5 remains reserved for Autobahn/Titan research.

## 2026-08-04 - Phase 9.4B Should Follow 9.4A

Decision: Phase 9.4B should address runtime quote reliability and provider-pressure reduction only
after Phase 9.4A fixes reporting and adapter correctness.

Reason: Jupiter pressure is likely driven by bursty requests, minute-only throttling, fast retries,
repeated quote demand, and repeated full enrichment for sell quote probes. Raydium evidence is also
not reliable until preflight parameters and top-level error parsing are corrected. Implementing a
new quote provider before this work could hide internal demand and measurement problems rather than
solving them.

Status: Accepted for Phase 9+ sequencing. Phase 9.4B should implement Jupiter scheduling,
provider-aware retries, demand reduction, single-flight joins, separated quote caches, latest
attempt versus last successful quote evidence, Raydium negative caching, and venue-aware routing in
ordered chunks.

## 2026-08-05 - Phase 9.4A.1 Is Read-Only Archive Truthing

Decision: Implement Phase 9.4A.1 as a read-only archive/reporting truthing command before changing
runtime provider behavior. The planned command is `pnpm research:truth --once`, consuming the three
Phase 9.4 validation archives and writing only optional ignored report artifacts.

Reason: The Phase 9.4 aggregate is useful but ambiguous. Before changing provider scheduling,
Raydium behavior, Birdeye use, strategy thresholds, or profile promotion, the project needs
full-session DB counts, truncation disclosure, quote-evidence decomposition, Birdeye CU/budget
attribution, enriched versus eligible-control outcomes, and concentration analysis.

Status: Accepted for Phase 9.4A.1 implementation planning. Phase 9.4A.1 must make no live provider
calls, no database mutations, no strategy default changes, and no paper execution changes.

## 2026-08-05 - Phase 9.4A.2 Corrects Adapter Evidence Before Pressure Reduction

Decision: Implement Phase 9.4A.2 as a bounded provider-adapter correctness and diagnostics phase
before Phase 9.4B quote-pressure reduction or Phase 9.5 provider expansion. It will correct the
Raydium API v3 pair-preflight query, parse top-level Raydium `msg`, retain stable deterministic
failure detail, add sanitized HTTP-attempt telemetry, retain latest quote-attempt evidence
separately from last successful quote evidence, and add `pnpm quote:diagnose --once`.

Reason: Current official Raydium documentation requires `poolType`, `poolSortField`, `sortType`,
`pageSize`, and `page` for `/pools/info/mint`, in addition to the mint fields. The existing
preflight omits those parameters, and the current quote parser can miss errors placed in the outer
response `msg`. Improving provider scheduling before those adapter-level facts are trustworthy
would make Phase 9.4B measurements ambiguous.

Status: Implemented for Phase 9.4A.2. Runtime validation still determines whether Phase 9.4B can
begin. The implemented command is `pnpm quote:diagnose --once`, and it remains PAPER-only,
session-free, wallet-free, transaction-free, and quote-only.

## 2026-08-05 - Phase 9.4A.2 Keeps Diagnostics Additive

Decision: Implement sanitized HTTP attempts and quote-attempt state as additive runtime evidence,
using `ProviderResult.httpAttempts`, `ProviderResult.diagnostics`, `ProviderHealth.contextJson`,
and a bounded in-memory `QuoteAttemptJournal`; do not add a migration or change quote-provider
order.

Reason: Phase 9.4A.2 needs enough evidence to explain Raydium adapter outcomes and router
latest-attempt versus last-success behavior. The existing provider-health context and a bounded
runtime journal are sufficient for this diagnostic pass. A database persistence phase should remain
conditional unless validation proves this evidence is lost or too noisy.

Status: Implemented. Phase 9.4A.3 remains conditional only.

## 2026-08-06 - Phase 9.4A.2 Validation Selects Phase 9.4B

Decision: Treat Phase 9.4A.2 as validated and proceed to Phase 9.4B quote-pressure reduction.
Do not create Phase 9.4A.3 now.

Reason: The short runtime validation `phase9.4A.2-short-20260806-1255` completed 29 PAPER,
shadow-only cycles with `safetyStatus = PASS`, no orders, no fills, and no positions. Provider
diagnostics preserved enough evidence to classify Raydium fallback behavior: Raydium failures were
dominated by `NO_ROUTE` after `NO_POOL` preflight, while Jupiter remained the active quote-pressure
bottleneck. Birdeye and Solana RPC behaved cleanly with no provider failures or rate limiting in the
reported aggregate. This is enough evidence to move from adapter correctness into demand reduction.

Status: Accepted. Phase 9.4B should start with provider-aware scheduling, duplicate-demand
reduction, and venue-aware suppression of implausible Raydium probes before adding another provider.

## 2026-08-06 - Phase 9.4B Scope

Decision: Phase 9.4B is a quote-pressure reduction phase, not a provider-expansion or strategy
promotion phase.

Reason: Phase 9.4A.2 showed that Jupiter remains the active pressure bottleneck and that Raydium
runtime fallback is dominated by no-route/no-pool outcomes for discovered mints. Adding providers
before controlling demand would make later measurements harder to interpret. The next highest-value
work is local provider-aware scheduling, duplicate-demand reduction, single-flight joining,
negative caching, and venue-aware suppression of implausible Raydium probes.

Status: Accepted for the Phase 9.4B checklist. Provider order remains `JUPITER -> RAYDIUM`; Birdeye
remains market-data enrichment only; no paper BUY, paper SELL, wallet, signing, transaction build,
or submission is authorized.

## 2026-08-10 - Phase 9.4B Demand Controls Are Implemented

Decision: Implement local quote-pressure controls before evaluating another quote provider. The
runtime order stays `JUPITER -> RAYDIUM`; Birdeye remains market-data enrichment only.

Implementation: Added a per-provider quote scheduler, process-local single-flight joining, separate
bounded negative caches, and a conservative Raydium venue guard. New ProviderHealth context records
the demand action, scheduler delay, joined request, cache reason, venue decision, and avoided-call
estimate. Existing cache, quote provenance, attempt-journal, provider ordering, and strategy logic
remain intact.

Safety: No database migration, provider expansion, strategy/profile change, paper execution, wallet
loading, signing, transaction building, submission, order, fill, or position behavior was added.

Status: Implementation and automated checks are complete. Provider smoke, quote diagnose, and
focused TerminalRunner validation still determine whether the pressure-reduction targets are met.

## 2026-08-11 - Phase 9.4B Validation Selects Adaptive Jupiter Control

Decision: Accept Phase 9.4B's Raydium demand-control result and proceed to Phase 9.4C rather than
running another unchanged validation, enabling Helius, adding a provider, or paying for Jupiter.

Reason: Two full PAPER/shadow-only runs retained the safety boundary and showed large Raydium
venue-guard/negative-cache savings. Jupiter scheduling, caching, and cooldown behavior also avoided
thousands of live calls, but Jupiter live rate limiting remained approximately 23% in both runs.
Fixed per-operation pacing is therefore not sufficient evidence of free-tier-efficient quote demand.

Phase 9.4C: Use one process-local Jupiter budget shared by price and quote operations, adapt after
actual 429 evidence, defer lower-priority work explicitly, and report local deferral separately from
upstream rate limits. Helius remains disabled for this quote experiment because Solana RPC and
QuickNode DAS already provide authority/metadata evidence.

Status: Accepted for planning. No paid Jupiter plan, provider expansion, strategy change, paper
execution, wallet, signing, or transaction submission is authorized.

## 2026-08-12 - Phase 9.4C Validation Selects Quote Budget Allocation

Decision: Accept Phase 9.4C as operationally successful and proceed to Phase 9.4D quote budget
allocation before adding an aggregate provider, paying for Jupiter, changing strategy thresholds,
or enabling paper execution.

Reason: Two valid 120-minute PAPER/shadow-only runs produced zero upstream Jupiter `429` results
with the shared adaptive controller. The controller allowed 5,473 live Jupiter requests but
locally deferred 856, predominantly because the fixed 48-per-minute safe window was exhausted.
Raydium correctly venue-guarded the fallback paths; it was not the source of the demand overflow.
The next useful control is therefore to select a bounded candidate subset before risk refresh asks
the router for executable quotes.

Phase 9.4D: Plan quote demand once per risk batch using already stored local evidence, request
quotes only for the selected candidates, and label all others `QUOTE_BUDGET_NOT_SELECTED` without
calling a provider. The existing `JUPITER -> RAYDIUM` router, Jupiter controller, and Raydium
venue guard remain final safety authorities.

Status: Accepted for implementation planning. No provider expansion, controller-budget increase,
strategy/profile change, paper execution, wallet, signing, or transaction submission is
authorized.

## 2026-08-12 - Phase 9.4D Implementation Keeps Allocation Local

Decision: Implement quote-budget allocation as a local per-risk-batch planner with a default
maximum of 20 selected candidates.

Reason: Planner non-selection is not an upstream result. Storing it in `RiskAssessment` evidence
and TerminalRunner stage counts keeps it auditable without incorrectly increasing Jupiter or
Raydium provider errors, rate limits, or router pressure.

Implementation: The planner ranks existing local scanner and prior-risk evidence only, refreshes
non-quote evidence for unselected candidates, and records `QUOTE_BUDGET_NOT_SELECTED` with rank,
limit, batch size, and sanitized signals. The `JUPITER -> RAYDIUM` router, Raydium venue guard,
and shared Jupiter controller remain unchanged.

Status: Superseded by the runtime-validation decision below.

## 2026-08-13 - Phase 9.4D Validation Retains Local Quote Allocation

Decision: Complete Phase 9.4D and retain the default local quote-budget planner at 20 selected
candidates per risk cycle. Do not add a paid Jupiter tier, Titan/Autobahn, Meteora/Orca, or paper
BUY automation.

Reason: Two valid 120-minute PAPER/shadow-only runs completed 129 risk cycles without stage or
risk errors. The planner selected 2,580 candidates, explicitly did not select 1,322, and preserved
2,515 successful quotes for selected candidates (97.48%). Jupiter upstream live rate limiting was
0%, and shared-window usage remained at 40 below the 48-request safety limit. Raydium produced no
useful route in the three venue-allowed attempts; its guard safely skipped the other 97 paths.

Next gate: collect a third unchanged validation archive in a distinct market window, then rerun
the read-only aggregate and interpretation reports. This is strategy-confidence evidence, not a
provider-expansion or paper-execution authorization.

## 2026-08-13 - Phase 9.4D Three-Run Review Defers Provider Expansion

Decision: Retain the Phase 9.4D allocation defaults and defer paid Jupiter, Titan/Autobahn,
Meteora/Orca, Helius re-enablement, and paper BUY automation. Plan Phase 9.26 counterfactual
decision analysis next.

Reason: All three 120-minute PAPER/shadow-only runs were valid and safe, totaling 195 risk cycles.
The planner selected 3,900 candidates, explicitly avoided 1,814 live quote requests, retained
96.44% selected-candidate quote coverage, and observed zero Jupiter upstream 429s. Research now
meets the minimum three-run quantity, 30-unique-mint, and 37.70% run-concentration checks, but
the promotion gate remains `PROMISING_RESEARCH` with MEDIUM confidence and no eligible paper
pilot. The most actionable explanation gap is 27 `UNRESOLVED_STRATEGY_GATE` SKIPs, including
high-scoring observed opportunities.

Safety: Phase 9.26 must remain read-only research. It does not change strategy defaults or
authorize paper execution, wallet loading, signing, or submission.

## 2026-08-13 - Phase 9.26 Counterfactual Analysis Remains Research-Only

Decision: Implement archive-only counterfactual replay from persisted decision facts and retain all
strategy defaults, providers, paper execution, wallet loading, signing, and submission unchanged.

Reason: The first archive smoke exactly reproduced 844 of 844 eligible historical SKIP/WATCH rows
without provider calls or database writes. The direct 65/60 threshold sensitivity promoted 27 rows,
but the result is concentrated: 74.07% of promoted rows belong to one mint and 81.48% to one run.
That is insufficiently independent evidence for a production threshold change or paper BUY review.

Status: Accepted. Review counterfactual scenario concentration and outcome-only returns before
planning any separate shadow-profile experiment.

## 2026-08-13 - Keep The 65/60 Finding Narrow And Shadow-Only

Decision: Phase 9.27 will validate only a pre-registered T65N@v1 cohort: persisted baseline
SKIP decisions with score 65-69, recorded original thresholds 90/70, recorded buyEligible=true,
and all hard risk, liquidity, volume, age, quote, and price-impact factors passing. Normal
TerminalRunner collection remains at 90/70; the new validation command reads completed archives
only.

Reason: Phase 9.26 exactly replayed historical decision facts, but its 27 direct 65/60 promotions
were concentrated in one mint (74.07%) and one run (81.48%). A full lower-threshold strategy run,
gate relaxation, or paper BUY experiment would turn a useful hypothesis into premature behavior.
The narrower first-per-mint-per-run cohort can test whether the incremental score band has
independent outcome evidence without letting later returns select entries.

Safety: Phase 9.27 may not call providers, write either active or archived databases, alter
strategy defaults, run strategy evaluation with lower thresholds, create orders/fills/positions, or
load a wallet, sign, or submit transactions. Its possible outputs are research recommendations
only, never an execution authorization.

Status: Implemented and fresh-validated August 14-15, 2026. Initial smoke against the three
Phase 9.4D full-validation archives found 27 threshold-only eligible rows and 3 first-per-mint
candidates. Six independent runs then produced 19 selected candidates with 19 unique mints. The
10/10 at 60-minute result was 9 target-first versus 8 stop-first and passed count and concentration
gates, but failed both leave-one-out checks. All selected rows scored 65, so 66-69 remains
unobserved. The outcome remains `COLLECT_MORE_INDEPENDENT_DATA`. A passing future result can
authorize only a separate promotion review; paper BUY remains disabled.

## 2026-08-17 - Reject T65N Threshold Promotion And Plan Fast-Exit Research

Decision: Close Phase 9.27 with `REJECT_NARROW_THRESHOLD`. Do not change normal 90/70 strategy
thresholds, enable paper BUY, or collect more unchanged T65N validation runs. Plan Phase 9.28 as a
separate `F65E@v1` fast-exit research profile.

Reason: The final combined cohort uses eight valid PAPER/shadow-only archives, excluding the
QuickNode-expiry failure and including an Alchemy-backed replacement. It passed concentration and
leave-one-out checks, but the primary 10% target / 10% stop / 60-minute outcome was 13 target-first,
9 stop-first, and 2 neither, with median MAE `-11.44%`. That is not a sufficient adverse-risk
balance for a lower entry threshold.

Implementation: F65E@v1 keeps the stored 65-69 source facts and normal 90/70 baseline but tests
one fresh, pre-registered primary exit scenario: +10% target, -15% stop, 15-minute maximum hold,
with 3/5/15-minute observation horizons. One- and two-minute collection, scores 60-64, provider
expansion, paper execution, wallet actions, signing, and transaction submission remain deferred.

Status: Implemented on 2026-08-17. `shadow:fast-observe` schedules only F65E@v1 3/5/15-minute
PAPER watchlist rows and `shadow:fast-exit-validate` reconstructs the profile from read-only
archives. A later F65E recommendation can authorize only a separate promotion review, never paper
BUY directly.

Fresh-smoke update: The 2026-08-17 PAPER/shadow-only runtime smoke completed 34 cycles over about
29.4 minutes with one session and zero orders, fills, positions, wallet loading, signing, or
submission. It selected one F65E candidate with exact 3/5/15-minute coverage; the pre-registered
10/15/15 primary scenario stopped first. This is a mechanical validation and a single negative
data point, not a profile decision. Keep the normal 90/70 strategy and collect the defined three
independent validation runs.

## 2026-08-18 - Close Phase 9.28 F65E@v1 Without Promotion

Decision: Close the fixed `F65E@v1` batch without promotion. Do not lower normal 90/70 strategy
thresholds, enable paper BUY, or collect more unchanged F65E validation runs. Any future fast-entry
research must be a separately documented, pre-registered hypothesis.

Reason: The three mechanically valid 120-minute PAPER/shadow-only archives selected seven unique
candidates with exact 3/5/15-minute coverage: Test1 selected 0, Test2 selected 1, and Test3
selected 6. The primary 10% target / 15% stop / 15-minute scenario returned 3 target-first,
3 stop-first, and 1 maximum-hold outcome. Candidate concentration was 85.71% in Test3, primary
winners were 66.67% in Test3, and leave-one-mint/run stability was false. The cohort also failed
the minimum 20-candidate, 15-mint, 55% target-first, <=25% stop-first, +20-point target-minus-stop,
and +10% median-MFE gates. The validator correctly reports `COLLECT_MORE_INDEPENDENT_DATA` because
its sample gate is unmet; Phase 9.28's fixed-batch rule means that is not authorization to gather
unlimited unchanged evidence.

Status: Accepted. The combined archive report is
`data/archive/phase9.28/combined-valid-three-20260818-1418`. It was archive-only and preserved
zero provider calls, database writes, sessions, orders, fills, positions, wallet loading, signing,
and transaction submission.

## 2026-08-18 - Plan Phase 9.29 Fast-Entry Feature Attribution

Decision: Plan Phase 9.29 as a read-only feature-attribution and hypothesis-selection phase before
any new fresh validation. It will compare F65E target-first, stop-first, and maximum-hold outcomes
using only facts available at the original strategy decision: score components, risk facts, age,
liquidity, volume, momentum, quote/price-impact evidence, provider provenance, and repeated
attention where available.

Boundaries: Future 3/5/15-minute observations are labels for analysis only and must never become
selection inputs. Phase 9.29 makes no provider calls, database writes, sessions, orders, fills,
positions, wallet actions, signing, submission, or strategy-default changes. It does not add
one- or two-minute observation work.

Expected outcome: Produce either one named, versioned, materially different, pre-registered
successor profile with fixed collection and promotion gates, or an explicit no-hypothesis finding.
It must not create a profile simply to continue testing.

## 2026-08-18 - Close Phase 9.29 Without A Successor Hypothesis

Decision: Close Phase 9.29 with `NO_DEFENSIBLE_HYPOTHESIS`. Do not create a successor profile,
collect a new F65E batch, widen thresholds, alter the normal 90/70 strategy, or enable PAPER BUY.

Reason: The archive-only analyzer reproduced all seven F65E candidates with exact 3/5/15-minute
coverage and the fixed primary labels: 3 target-first, 3 stop-first, and 1 maximum-hold. However,
Test3 supplied 85.71% of selected candidates, 66.67% of target-first labels, and 100% of
non-target labels. The source cohort therefore failed independent label-run support, concentration,
leave-one-out direction, and fixed narrower-predicate gates. The score and factor pattern was also
tied across the selected cohort, so no result justifies synthesizing a filter from outcomes.

Status: Accepted. The report is
`data/archive/phase9.29/combined-valid-three-20260818-1539`. It read archived PAPER databases only
and retained zero provider calls, database writes, sessions, orders, fills, positions, wallet
loading, signing, and submission.

## 2026-08-18 - Plan Phase 10 Local Research Dashboard And Archive Explorer

Decision: Make Phase 10 the next work, rather than inventing a Phase 9.30 successor study. Build a
local, read-only Research Dashboard and Archive Explorer over completed structured archives and
read-only archive data.

Reason: Phase 9.29 found genuine feature variation but no independent, defensible separator
between F65E target-first, stop-first, and maximum-hold labels. A new profile would be curve-fitting.
The project now has enough accumulated archive/report machinery that inspectability and evidence
reuse have higher value than collecting another undirected batch.

Boundaries: Phase 10 has no external/provider/RPC HTTP calls, database writes, session creation,
runtime commands, orders, fills, positions, wallet loading, signing, submission, strategy-default
changes, or one-/two-minute monitoring change. Browser loopback static-asset requests to the local
Vite server are allowed only for the local viewer and must not proxy or initiate external traffic.
Its first pass contains no `paper BUY` or execution controls. Later observations remain visual
analysis labels, not selection inputs. The normal BUY=90 / WATCH=70 baseline and disabled PAPER
execution remain fixed.

Implementation direction: Use a one-way, archive-only exporter to generate a versioned sanitized
local data manifest for a static local dashboard. Prefer known structured JSON reports, use
whitelisted read-only archive queries only when necessary, and exclude active root databases, text
transcripts, and `legacy-root-artifacts-*` cleanup copies. The Phase 9.27/9.28 root cleanup moved
16 run snapshots and 66 loose reports into phase-specific archive folders without changing the
active PAPER database.

Expected outcome: A reviewer can browse archives, cohorts, provider pressure, candidate
decision-time facts, score attribution, and target-first/stop-first/max-hold comparisons with source
and missing-data disclosures. Completion authorizes no strategy or execution change; only a later
human review can decide whether another distinct shadow-study phase has support.

## 2026-08-18 - Implement Phase 10 Local Research Dashboard And Archive Explorer

Decision: Complete Phase 10 as a local static evidence viewer backed by a strict one-way exporter.
The implementation adds versioned shared dashboard contracts, a backend archive-only exporter, and
the `frontend` Vite/React workspace; it does not add a runtime service or browser-to-database path.

Evidence: The approved command explicitly selected `phase9.28`, `phase9.29`, and
`phase9.29/combined-valid-three-20260818-1539`, then produced four ignored local JSON resources:
5 runs, 1 cohort, and 7 candidates. Its canonical content fingerprint is
`b02e16f3c19f3f016ff94b2405c072606a207dba767d3e51d583110c9b6147e5`; its volatile `generatedAt`
field is intentionally excluded from the fingerprint. Backend tests (103 files / 339 tests),
frontend tests (2 files / 4 tests), production build, and a `127.0.0.1` static-asset smoke passed.

Safety result: The exporter rejects active/runtime/network options, reads known structured JSON
only, does not import provider/runtime modules, and writes only the ignored generated-data directory.
Tests assert zero `fetch` calls and unchanged source report/archive-database hashes. The manifest
and UI retain `PAPER` / shadow-only, BUY=90, WATCH=70, and execution disabled; no orders, fills,
positions, wallet loading, signing, submission, sessions, provider calls, database writes, strategy
defaults, thresholds, or monitoring cadence changed.

Consequence: Phase 10 creates no strategy conclusion or successor profile. The next decision is a
human review of the displayed structured evidence; a distinct shadow study remains a separate,
evidence-gated planning action.

## 2026-08-18 - Close Phase 10.1 Evidence-Fidelity Presentation Gap

Decision: Apply a narrow local/static/read-only Phase 10.1 patch before treating the dashboard as
fully closed. It must expose already archived cohort membership, concentration, gates, report kinds,
provider-pressure distinctions, and original decision context; it must not produce a strategy rule
or alter any archive source.

Reason: The initial dashboard was safe and inspectable but omitted material, already-exportable
evidence from its cohort, provider-pressure, candidate, and filter surfaces. Showing it improves
review traceability without claiming a predictive relationship.

Result: The exported contract now records report kind and optional quote-budget, controller, and
venue-guard facts where a structured source records them. The viewer displays those facts alongside
existing upstream/cooldown evidence; absent optional facts are `NOT_REPORTED`, never zero. Local
phase/run/report-kind/provider-evidence filters and the candidate decision context are display-only.
The refreshed bounded export retains 5 runs / 1 cohort / 7 candidates and has fingerprint
`b02e16f3c19f3f016ff94b2405c072606a207dba767d3e51d583110c9b6147e5`.

Safety result: No provider call, database write, session, order/fill/position, wallet, signing,
submission, strategy/default, threshold, or monitoring behavior changed. The next step remains a
human review of evidence, not an authorized Phase 11 implementation or shadow study.

## 2026-08-18 - Plan Phase 10.4 Local Research Brief Generator And Review Protocol

Decision: Plan Phase 10.4 as the next implementation phase. It will produce a deterministic,
source-traceable Markdown or JSON brief from an explicitly selected completed archive set so a
reviewer or Codex can analyze research evidence directly without relying on dashboard inspection.

Reason: Phase 9.29 remains `NO_DEFENSIBLE_HYPOTHESIS`: seven exact-coverage candidates are highly
concentrated in Test3, so neither Phase 11 readiness work nor another unchanged F65E@v1 collection
addresses the current evidence gap. The project needs a repeatable evidence-reading artifact before
any distinct future study can be responsibly considered.

Boundary: The first pass reads known structured archive JSON only, accepts explicit archive scope,
and emits to standard output only. It makes zero provider/RPC/HTTP calls, database reads or writes,
filesystem writes, sessions, runtime commands, execution actions, wallet actions, strategy/default
changes, threshold changes, monitoring changes, or hypothesis/study authorization. Later outcomes
remain visibly separate analytical labels.

Consequence: Phase 10.4 may carry a recorded conclusion or report `DATA_INSUFFICIENT` /
`HUMAN_REVIEW_REQUIRED`, but may never emit a promotion, successor-profile, or execution-ready
conclusion. Its detailed checklist must be approved before implementation.

## 2026-08-19 - Close Phase 10.4 Local Research Brief Generator And Review Protocol

Decision: Close Phase 10.4 as implemented. `research:brief` accepts only an explicit archive root,
known Phase 9.28/9.29 phase selection, and the named Phase 9.29 attribution cohort; it produces a
validated deterministic Markdown or JSON brief on standard output only.

Result: The initial six-source fixture has content fingerprint
`5fb59e2bf4472ea4da2a516d1298398491b812d1a3ae811d745aa46d5ee308c7`. Both output modes reproduce
the 5-run / 1-attribution-report / 7-candidate evidence record, exact 3 target-first / 3 stop-first
/ 1 max-hold labels, concentration and gate ledger, and the unmodified
`NO_DEFENSIBLE_HYPOTHESIS` conclusion. Decision-time facts are distinct from later labels, and
provider pressure remains a separate contextual section.

Safety result: The implementation reads known structured archive JSON only. It writes no report,
cache, manifest, session, archive, or database artifact; makes no provider/RPC/HTTP call; and does
not load wallets, sign, submit, create orders/fills/positions, change strategy/defaults/thresholds/
providers/monitoring, or authorize a hypothesis/study. Invalid scope, ambiguous report, unsupported
report, and source inconsistency fail closed with one bounded public error code.

Verification: `corepack pnpm verify` passed on 2026-08-19: 107 backend test files / 351 tests, 4
shared test files / 13 tests, and 2 frontend test files / 4 tests, plus format, lint, typecheck, and
secret checks. No archive cleanup or move is needed.

## 2026-08-19 - Plan Phase 10.5 Human Review And Pre-Registration Gate

Decision: Plan Phase 10.5 as a local, source-traceable human-review gate over the completed Phase
10.4 evidence. Its required initial decision is `NO_STUDY_AUTHORIZED`, not a successor study.

Reason: The completed Phase 9.28/9.29 evidence remains
`NO_DEFENSIBLE_HYPOTHESIS`: all seven exact-coverage candidates are concentrated in one test
window, with every non-target label in Test3. It cannot responsibly support a profile derived from
the observed labels.

Boundary: The planned review-gate command may read the explicitly selected completed archive JSON
and one human-authored, source-controlled review record, then emit Markdown or JSON to standard
output. It may not call providers/RPC/HTTP, access a database, run any runtime surface, write an
artifact, create a hypothesis automatically, or enable collection, PAPER execution, strategy/default
changes, provider changes, threshold changes, monitoring changes, wallet actions, signing,
submission, orders, fills, or positions. Later outcomes remain labels, never entry criteria.

Consequence: A future `PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL` result would only document a
complete proposed contract; it would not authorize Phase 10.6. Phase 10.6 can begin only after a
separate user-approved implementation checklist and explicit authorization. The detailed checklist
must be approved before Phase 10.5 implementation.

## 2026-08-19 - Close Phase 10.5 Human Review And Pre-Registration Gate

Decision: Close Phase 10.5 as implemented. `research:review-gate` accepts only the completed
Phase 9.28/9.29 archive scope and the source-controlled
`docs/research-reviews/phase10.5-initial.v1.json` record. It recomputes Phase 10.4 evidence in
memory and writes one validated Markdown or JSON result to standard output only.

Result: The review record SHA-256 is pinned at runtime to
`07b9d4311747452ca3f539d2e26ba68ce90b9fc8db9f9e4cd5585678e8f2193f`; it retains the approved
Phase 10.4 fingerprint `5fb59e2bf4472ea4da2a516d1298398491b812d1a3ae811d745aa46d5ee308c7`.
The generated gate fingerprint is
`2846a8509f523104417e460d0bc0a6812d161f393ade666b73faea5caa19828b`. Both output formats record
the exact 5-run / 1-attribution-report / 7-candidate evidence identity, 3/3/1 labels, Test3
concentration, all seven failed attribution gates, `NO_DEFENSIBLE_HYPOTHESIS`, and the required
`NO_STUDY_AUTHORIZED` result.

Safety result: The command uses strict enum-backed review assertions and bounded sanitized notes. It
accepts no candidate pre-registration, non-default-deny outcome, unknown record field, credential-
like content, archive-scope variation, output option, provider/RPC/HTTP option, database/runtime
option, or execution option. It writes no artifact and does not access providers/RPC/HTTP,
databases, runtime services, sessions, orders, fills, positions, wallets, signing, submission,
strategy/defaults, thresholds, providers, or monitoring.

Verification: `corepack pnpm verify` passed on 2026-08-19: format, lint, typecheck, 110 backend test
files / 360 tests, 4 shared test files / 13 tests, 2 frontend test files / 4 tests, and the secret
scan. Both explicit `research:review-gate` output modes produced the same fixed gate fingerprint.

Consequence: The future candidate-pre-registration shape remains documentation only. A generic
candidate validator and any Phase 10.6 planning/collection require separately approved scope and
independently sufficient completed evidence. Phase 10.5 authorizes neither.

## 2026-08-19 - Plan Research Restart Criteria Before Any New Shadow Study

Decision: Plan Phase 10.5A as a planning/local-validation Research Restart Criteria and Exploratory
Cohort Design phase. It is the next proposed step after Phase 10.5's `NO_STUDY_AUTHORIZED` result. It may
define an outcome-blind exploratory measurement protocol but may not collect data, create a strategy
predicate, change thresholds/defaults, enable PAPER execution, or authorize Phase 10.6A.

Reason: The closed Phase 9.28/9.29 evidence cannot responsibly select another strategy profile, but
leaving no path to obtain independent evidence would create a research dead end. A fixed broad
observational cohort can measure decision-time facts and later labels without using the labels to
choose entries or claim profitability.

Boundary: Phase 10.5A must freeze the population/sampling frame, unique-mint and market-window
deduplication, decision-time fields, provider-budget limits, observation horizons, missing-data
rules, discovery/validation split, and data-quality stop conditions before collection. Its only
permitted implementation command is a strict local stdout-only protocol validator. It makes zero
provider/RPC/HTTP calls, database accesses, market-runtime calls, filesystem data writes, strategy
changes, orders, fills, positions, wallet actions, signing, or submission.

Consequence: A separately approved Phase 10.6A may collect only the pre-registered exploratory
cohort. Its data is descriptive and not a shadow-validation or promotion result. Phase 10.6B must
review completed evidence before any materially distinct study may be proposed. Its sole positive,
non-authorizing result, `PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL`, may support drafting a
separate candidate record only; a separately approved Phase 10.6C may run that study's real-market
shadow validation.

Detailed implementation checklist:

- [NeXusTrade-Phase-10.5A-Detailed-Checklist.md](./NeXusTrade-Phase-10.5A-Detailed-Checklist.md)

## 2026-08-19 - Implement Local Exploratory Cohort Protocol Validation

Decision: Implement Phase 10.5A as one frozen source-controlled
`ExploratoryCohortProtocolV1` and a strict local stdout-only validator. The protocol path is
`docs/research-protocols/phase10.6a-exploratory-cohort.v1.json`; its SHA-256 is
`748a159464ddfae3d7821e5e18bc690d87c2ac82cf2d89b596a11f4612fce152`.

Reason: A deterministic, mechanically verified protocol preserves the evidence boundary while
leaving a reviewable route to independent future observational evidence. It fixes the population,
sampling, decision-time schema, provider budgets, horizons, split, archive contract, and stops
before any collection could be considered.

Boundary: `research:protocol:validate` reads only the approved protocol and source-controlled
evidence identity constants, writes to stdout only, and pins the protocol SHA-256. It rejects unsafe
scope, invalid records, and source inconsistencies. It makes zero provider/RPC/HTTP calls, database
reads/writes, filesystem writes, market-runtime actions, sessions, orders, fills, positions, wallet
actions, signing, or submission. It does not add a Phase 10.6A collection command, provider adapter,
runtime configuration, database migration, strategy change, or execution surface.

Consequence: The validator's
`PROTOCOL_READY_FOR_SEPARATE_COLLECTION_APPROVAL` result means only that the static design may be
submitted for a separately approved Phase 10.6A checklist and explicit user authorization. It does
not authorize collection, Phase 10.6B, Phase 10.6C, PAPER execution, default/threshold changes, or
promotion.

Verification: `corepack pnpm verify` passed on 2026-08-19: format, lint, all workspace typechecks,
113 backend test files / 368 tests, 4 shared test files / 13 tests, 2 frontend test files / 4 tests,
and the secret scan. The explicit validator emitted the fixed non-authorizing result and reported
zero provider/RPC/HTTP, database, filesystem-write, runtime, session, or execution counters.

## 2026-08-19 - Plan Bounded Exploratory Cohort Collection Before Any Live Observation

Decision: Plan Phase 10.6A as the first separately approval-gated live-observation phase. Its
implementation must use a new isolated archive-only collector that follows the frozen
`EXPLORATORY_COHORT@v2` protocol. The plan is not implementation or authorization for any provider
call.

Reason: The validated Phase 10.5A protocol supplies an outcome-blind way to obtain independent
evidence, but the existing scanner and watchlist runtimes create PAPER sessions and database rows.
They cannot safely be repurposed for research collection. A narrow collector prevents market
observation from becoming a strategy or execution workflow.

Boundary: Phase 10.6A may use only direct allowlisted discovery, market-context, quote-impact, and
later-observation capabilities after a separate implementation approval and explicit authorization
for one new archive root. It must make no database/session/strategy/PAPER/wallet/execution action;
cannot use a provider fallback or retry; must preserve decision-time/later-label separation; and
must finalize only the fixed immutable archive artifacts. Its collection result is non-authorizing.

Consequence: The detailed checklist must be approved before implementation. After implementation
verification, the user must separately authorize one named root before the first provider call. A
complete, incomplete, or data-quality-stopped archive remains subject to a separate Phase 10.6B
archive-only checklist.

Detailed implementation checklist:

- [NeXusTrade-Phase-10.6A-Detailed-Checklist.md](./NeXusTrade-Phase-10.6A-Detailed-Checklist.md)

## 2026-08-19 - Supersede the Proposed Collection Contract Before Implementation

Decision: Preserve `EXPLORATORY_COHORT@v1` unchanged and validate a separately pinned
`EXPLORATORY_COHORT@v2` protocol for Phase 10.6A planning. V2 has SHA-256
`2662a4cbc1d3458d55b64f9c4cc826561aad1cb6f6b5faf11079194377f5a0ed` and a V1 supersession
record. The local validator returned `PROTOCOL_READY_FOR_SEPARATE_COLLECTION_APPROVAL` with content
fingerprint `1fbe8a70792d872c7199d7182d095f13cce7c9908939526b44ecc7e2f872c283`.

Reason: V1's market-context and quote caps could not yield 96 valid units after an ordinary required
anchor failure. V2 raises fixed caps only to cover all 168 attempted slots and 672 planned labels;
it does not add retry, fallback, replacement, threshold change, or collection expansion. The checklist
also now fixes `discoverTokens(100)`, a slot-end-minus-60-second external invocation schedule, and
cross-process archive locking/duplicate-slot refusal.

Consequence: V2 is still a static, non-authorizing record. No collection implementation, provider
call, archive creation, strategy change, or execution action is authorized by this correction.

## 2026-08-19 - Implement Isolated Exploratory Cohort Collection Without a Live Run

Decision: Implement Phase 10.6A's V2 collector as a narrow direct-adapter command with a
source-controlled launch-record prerequisite, an injected UTC clock, immutable archive lifecycle,
and no generic runtime orchestration. The command is
`pnpm research:exploratory-cohort:collect --`; it accepts only the pinned V2 protocol, a first-run
`YYYYMMDD-0000Z` archive root, `--once`, and an optional output format.

Boundary: Implementation did not create a launch record, archive, database record, session, market
request, provider/RPC/HTTP call, wallet action, signing, submission, order, fill, or position. The
direct gateway uses DEXSCREENER only for discovery/market/later labels and JUPITER only for the
non-executable quote probe, with 168/168/168/672 fixed caps, no retry, no fallback, and no generic
provider registry or quote router. The direct JUPITER adapter retains its normal quote-route
resolution; it does not impose an undeclared direct-route-only policy.

Consequence: A stale archive lock from an interrupted process finalizes that root as
`COHORT_INCOMPLETE` before another provider call, including the narrow crash window after a new-root
lock is acquired but before initial artifacts are written. The lock is acquired before any initial
artifact, and source inventory hashes canonical sanitized provenance only. Final summaries expose
only aggregate partition/date/concentration, label/missingness, provider-budget, stop, and safety
facts. `corepack pnpm verify` passed locally on 2026-08-19: backend 114 files / 379 tests, frontend
2 / 4, shared 4 / 13. The user may be shown the implementation for a separately authorized, named
live archive root; that verification does not authorize a run.

## 2026-08-19 - Pre-Register Phase 10.6B Analysis Before Collection

Decision: Create the detailed Phase 10.6B archive-analysis checklist before the first Phase 10.6A
collection. It fixes one 60-minute later label, a finite seven-field/two-direction single-feature
catalog, outcome-blind discovery quantiles, deterministic discovery selection, held-validation,
date-stability, exact Fisher, and default-deny outcome gates. The checklist is planning only; it does
not implement or run an analyzer.

Reason: The Phase 9.29 result failed because feature variation and later labels were concentrated in
one test. Writing this contract before any new cohort labels exist removes the opportunity to select
a threshold, feature, horizon, or validation rule after observing the new data. The V2 collection
already pre-assigns `DISCOVERY` and `VALIDATION`, so the contract can require genuine held
confirmation rather than presenting exploratory discovery evidence as a result.

Boundary: A future Phase 10.6B command may read one named finalized V2 archive plus the pinned V2
protocol, write Markdown or JSON only to stdout, and make zero provider/RPC/HTTP, database,
filesystem-write, runtime, strategy, PAPER, wallet, signing, submission, order, fill, or position
action. Its sole positive outcome remains
`PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL`; it is only permission to request separate approval
to draft a human-authored future candidate record.

Consequence: Phase 10.6A remains the next operational phase and still requires a separately
authorized named root. Phase 10.6B implementation and execution both remain blocked until this
checklist is approved and a finalized Phase 10.6A archive exists.

Detailed implementation checklist:

- [NeXusTrade-Phase-10.6B-Detailed-Checklist.md](./NeXusTrade-Phase-10.6B-Detailed-Checklist.md)

## 2026-08-19 - Register One Authorized Phase 10.6A Observational Launch Without Starting It

Decision: Add the source-controlled launch record for exactly
`data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z`, starting
`2026-08-21T00:00:00.000Z`. The user explicitly authorized only this fixed V2 DEXSCREENER/JUPITER
observational collection. An external operator scheduler runbook fixes 168 two-hour invocation
starts from `2026-08-21T01:59:00.000Z` through `2026-09-03T23:59:00.000Z`.

Validation: The narrow local config/launch/protocol guard accepted the record, confirmed the approved
archive root was absent, and reported zero provider calls, database reads, and filesystem writes. No
gateway, collector, operating-system task, archive, or market request was started.

Boundary: The runbook is unarmed. It has no retry, catch-up, output redirect, background process,
internal scheduler, fallback, or execution behavior. A missed or late external slot is a safety stop,
not permission to backfill or alter the collection. This authorization does not authorize Phase
10.6B, a strategy/default change, PAPER trading, wallets, signing, submission, orders, fills,
positions, or any execution action.

Artifacts:

- [Phase 10.6A launch record](./research-launches/phase10.6a-exploratory-cohort-v2-20260821-0000Z.json)
- [Phase 10.6A external scheduler runbook](./research-launches/phase10.6a-exploratory-cohort-v2-20260821-0000Z-operator-runbook.md)

## 2026-08-19 - Plan Phase 10.6A.1 Reliability Patch Before Scheduler Arming

Decision: Create a narrow, launch-blocking Phase 10.6A.1 implementation checklist before arming
the authorized external scheduler. The patch must preserve the frozen V2 protocol byte-for-byte.
Before a normal later-slot provider call, it will ledger each elapsed unrepresented external slot as
a canonical zero-request `PAUSE_WINDOW` row with reason `EXTERNAL_INVOCATION_MISSED`. It will
finalize from the terminal canonical slot index rather than from the number of ledger rows. A
separate strict post-window closeout mode may finalize only an existing active root as incomplete;
it must construct no provider gateway and make no provider, RPC, HTTP, database, runtime, or
execution call.

Reason: The current collector correctly refuses an unscheduled/late normal observation, but a
missed middle external invocation can leave no ledger row. The former row-count terminal check can
then leave an otherwise terminal archive `COLLECTING` after the final normal scheduler slot. A
missed final normal invocation has no later ordinary slot to close the root. Availability evidence
must be recorded without recreating market observation after the fact.

Boundary: This is not a protocol V3, catch-up, retry, replacement, scheduler, provider expansion,
strategy change, analysis, or execution feature. The operator runbook remains unarmed. The normal
168 V2 collection invocations remain unchanged; the prospective finalizer is a zero-provider archive
closeout only and must obtain separate post-implementation scheduler-arming approval.

Detailed implementation checklist:

- [NeXusTrade-Phase-10.6A.1-Detailed-Checklist.md](./NeXusTrade-Phase-10.6A.1-Detailed-Checklist.md)

## 2026-08-19 - Implement Phase 10.6A.1 Before Scheduler Arming

Decision: Implement the approved Phase 10.6A.1 reliability repair without creating the authorized
archive root, making a provider call, or arming an external task. The collector now uses exact
`COLLECT_SLOT` and `FINALIZE_MISSED_SLOTS` modes. A normal later invocation validates active evidence,
records every elapsed unrepresented canonical index as zero-request
`PAUSE_WINDOW` / `EXTERNAL_INVOCATION_MISSED`, checkpoints that availability ledger while retaining
its lock, and only then constructs the direct market gateway. Active manifest, units, and source
inventory use canonical persisted hashes; unreadable, hash-invalid, or structurally unprovable
evidence receives zero archive writes and zero provider calls.

The normal lifecycle finalizes an incomplete cohort when canonical index `167` is represented rather
than when ledger row count reaches 168. The provider-free finalizer accepts only the approved existing
root and pinned launch/protocol tuple at or after `2026-09-04T01:01:00.000Z`; it appends only missing
availability rows and can finalize only `COHORT_INCOMPLETE`. It constructs no gateway and reports
zero provider/database/runtime calls for that invocation.

Boundary: The V2 protocol bytes, 168 normal two-hour starts, fixed provider caps, no-retry/no-fallback
policy, direct provider surface, selection, labels, strategy defaults, and execution boundary are
unchanged. The extra finalizer is not a 169th market observation. The runbook is updated but remains
unarmed. Phase 10.6B, strategy changes, PAPER actions, wallets, signing, submission, orders, fills,
positions, and execution remain unauthorized.

Verification: Local fake-clock/fake-gateway tests cover reconciliation, duplicate current-slot refusal
without artifact change, active-evidence hash/structure stops without writes, terminal index closeout,
and provider-free finalizer boundaries. `corepack pnpm verify` passed on 2026-08-19: backend 114 files
/ 386 tests, frontend 2 / 4, shared 4 / 13, plus formatting, lint, typechecks, and secret scan. No
live collection command or provider call was run.

## 2026-08-30 - Record The Completed Phase 10.6A Archive And Ready The Pre-Registered 10.6B Plan

Decision: Record the one separately authorized V2 observational archive as finalized
`COHORT_COMPLETE`, then reconcile the already pre-registered Phase 10.6B checklist to its immutable
input identity. The archive root is
`data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z`; it reached the fixed completion
target on 2026-08-29 with 96 valid units from 100 attempted slots. Its four final artifacts and
SHA-256 values are recorded in the Phase 10.6B checklist, along with 382 on-time and 2 missing later
observations, and zero database/execution safety counters.

Reason: The V2 contract permits terminal `COHORT_COMPLETE` as soon as its fixed 96-valid-unit
quality gate is satisfied; it does not require collecting unused remaining slots. Preserving the
actual final-file identities lets the next phase fail closed against the exact observed archive,
without treating any outcome as a reason to alter the pre-registered label, catalog, threshold, or
validation gates.

Boundary: The repeating collector task is disabled. The remaining one-time provider-free confirmation
may return the existing final state but cannot reopen, write, extend, or otherwise modify the archive.
No Phase 10.6B analyzer has been implemented or run. This record does not authorize archive analysis,
a candidate, Phase 10.6C, strategy/default/threshold changes, further collection, PAPER execution,
wallet use, signing, submission, orders, fills, or positions.

Consequence: The Phase 10.6B detailed checklist is ready for separate implementation approval. After
implementation verification, a separate explicit user approval is still required before the one named
archive can be read by the stdout-only analyzer.

Detailed implementation checklist:

- [NeXusTrade-Phase-10.6B-Detailed-Checklist.md](./NeXusTrade-Phase-10.6B-Detailed-Checklist.md)

## 2026-08-30 - Implement Phase 10.6B Analyzer With Synthetic Fixtures Only

Decision: Implement the pre-registered Phase 10.6B analyzer as an isolated, single-root, archive-only
command. It verifies the pinned V2 protocol, exact final artifact inventory, canonical hashes,
sanitized source provenance, manifest/unit/summary consistency, zero safety state, and fixed quality
gates before it can form the fourteen-rule decision-time catalog. The four approved final artifact
hashes are hard-pinned in source and checked after normal internal consistency validation, so a
self-consistent rewrite fails closed. It emits deterministic Markdown or JSON only to stdout and can
produce the non-authorizing descriptor only after the frozen discovery and held-validation gates pass.

Reason: The completed cohort can now be assessed only by the protocol fixed before its first label.
Synthetic fixtures exercise all quality outcomes, corruption failures, deterministic quantiles and
tie-breaking, unavailable fields, Fisher and date-stability rejection, the sole ready result, the
decision-time/later-label boundary, each approved artifact mismatch, and a coherently rewritten
archive without reading the completed archive.

Boundary: No Phase 10.6B analyzer command was run against the completed archive. No provider, HTTP,
database, runtime, collection, archive write, PAPER, wallet, signing, submission, order, fill, or
position action occurred. Repository-wide `pnpm test` and `pnpm verify` were deliberately not run
because this approval permits synthetic fixtures only and those broad wrappers include unrelated
database/runtime tests. Static format, lint, workspace typecheck, focused synthetic suite, and secret
scan passed.

Consequence: The analyzer implementation is ready for review only. A separate explicit approval for
`data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z` remains required before any analyzer
read or stdout result. A result, including `PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL`, cannot
authorize Phase 10.6C, a strategy/default change, PAPER execution, or promotion.

Detailed implementation checklist:

- [NeXusTrade-Phase-10.6B-Detailed-Checklist.md](./NeXusTrade-Phase-10.6B-Detailed-Checklist.md)

## 2026-09-03 - Close Phase 10.6B With No Defensible Hypothesis

Decision: After the scheduled provider-free closeout completed at 6:01 PM PDT with exit code zero,
record the result of the one separately authorized Phase 10.6B stdout-only analysis of
`data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z`. The report hard-verified all four
approved archive artifacts as `archiveIdentity: MATCHED`, found final state `COHORT_COMPLETE`, and
returned `NO_DEFENSIBLE_HYPOTHESIS` with content fingerprint
`5b57410a3fa9164ba2671f7fb118fdda65985802b56411f67e4835f1fdde39b6`.

Reason: All fixed cohort quality gates passed: 96 valid units; 46 discovery and 50 validation units;
complete primary-label coverage; 8/8 primary-label support; and label-date concentration of 18/35.
However, no pre-registered decision-time rule passed the discovery gates. `LIQUIDITY`, `MOMENTUM_5M`,
and `MOMENTUM_15M` were unavailable under their fixed coverage rules, while age, volume, and
quote-impact rules also failed the fixed discovery criteria. No rule advanced to held validation.

Boundary: The analyzer report records zero provider/RPC/HTTP, database, filesystem-write, runtime,
session, wallet, signing, submission, order, fill, position, or PAPER actions. The 3/5/15-minute rows
remained availability facts only; the fixed 60-minute later label was used only as a label against
decision-time facts. This result does not authorize a candidate, Phase 10.6C, a new collection,
strategy/default/threshold change, PAPER execution, or promotion.

Consequence: Preserve the immutable archive and retained stdout report. The only permitted immediate
research conclusion is `PRESERVE_ARCHIVE_NO_SUCCESSOR_STUDY_AUTHORIZED`; do not create a successor
protocol or infer a candidate from preliminary ledger differences.

Detailed implementation checklist:

- [NeXusTrade-Phase-10.6B-Detailed-Checklist.md](./NeXusTrade-Phase-10.6B-Detailed-Checklist.md)

## 2026-09-03 - Stage An Archive-Only Measurement Audit Before Any Further Study

Decision: Do not advance to Phase 10.6C after the completed Phase 10.6B report returned
`NO_DEFENSIBLE_HYPOTHESIS`. Establish planned Phase 10.6B.1 as the next documentation and research
step: an archive-only decision-time measurement and missingness audit. It may determine only whether
the completed V2 evidence supports drafting a separate measurement-only protocol revision.

Reason: The real analysis passed all fixed cohort quality gates but had insufficient `LIQUIDITY`
coverage and unavailable `MOMENTUM_5M` / `MOMENTUM_15M` facts under the pre-registered catalog.
Those availability limitations must be understood through outcome-blind collection evidence before the
project considers another exploratory cohort. The result did not identify a candidate predicate, so a
shadow-validation study would have no valid subject.

Boundary: Phase 10.6B.1 must inspect only decision-time availability, bounded missingness classes,
sanitized provenance/capability facts, and date/partition distributions. It must not read or use later
labels, derive a threshold, evaluate a candidate effect, modify the immutable archive, call a provider,
access a database/runtime, or create any strategy, PAPER, wallet, signing, submission, order, fill,
or position surface. This planning decision authorizes neither an audit implementation nor an archive
run; each requires separate approval after the detailed checklist is complete.

Consequence: Phase 10.6C is explicitly blocked pending a future materially distinct, separately
approved candidate. Phases 10.7 through 10.9 are blocked upstream. A future measurement-only protocol
revision and independent exploratory collection may be considered only if a separately approved
Phase 10.6B.1 result specifically supports them.

Detailed planning checklist:

- [NeXusTrade-Phase-10.6B.1-Detailed-Checklist.md](./NeXusTrade-Phase-10.6B.1-Detailed-Checklist.md)

## 2026-09-04 - Implement Phase 10.6B.1 With Synthetic Fixtures Only

Decision: Implement the approved Phase 10.6B.1 decision-time measurement and missingness audit as an
isolated, hard-pinned, stdout-only command. Its loader must lexically discard the opaque top-level
later-observation container before parsing a unit or summary projection and must aggregate only the
fixed decision-time availability, bounded provenance, date, partition, and non-later source-inventory
facts.

Verification: The implementation passed formatting, lint, workspace type checking, its focused
seven-test synthetic-fixture suite, and the secret check. The production command was not run against
the V2 archive. No provider/RPC/HTTP call, database/runtime action, archive write, scheduler action,
strategy change, PAPER action, wallet action, signing, submission, order, fill, or position occurred.

Boundary: The exact named V2 archive and its four raw hashes remain hard-pinned, but a real audit is
still separately approval-gated. Any result remains default-deny: a measurement-ready status can
support only a separate human-reviewed protocol draft, never a protocol revision, collection,
candidate, Phase 10.6C, strategy, PAPER, or execution action.

Implementation checklist:

- [NeXusTrade-Phase-10.6B.1-Detailed-Checklist.md](./NeXusTrade-Phase-10.6B.1-Detailed-Checklist.md)

## 2026-09-04 - Close Phase 10.6B.1 With A Measurement-Only Protocol-Review Result

Decision: After the user separately approved the one hard-pinned, stdout-only audit of
`data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z`, record the real result as
`MEASUREMENT_REVISION_READY_FOR_SEPARATE_PROTOCOL_REVIEW`. The run matched the pinned V2 protocol
and all four raw archive SHA-256 values, emitted content fingerprint
`843d1d27aee452f7fcccb000128fec10a38d0fbe80652fc9eb50511a9447b486`, and made zero provider/RPC/HTTP
calls, database reads/writes, filesystem writes, runtime/session/order/fill/position actions, and
wallet/signing/submission actions.

Evidence: The outcome-blind audit found replicated, attributable decision-time measurement gaps only.
`LIQUIDITY` was below the fixed 90% coverage gate in both partitions, with all unavailable facts
`UNAVAILABLE_AT_ANCHOR` from `MARKET_CONTEXT/BEST_PAIR` across nine UTC dates. `MOMENTUM_5M` and
`MOMENTUM_15M` were unavailable in every unit as `UNSUPPORTED` from the same bounded provenance pair
across nine UTC dates. No later-label member was interpreted.

Consequence: A human may now propose one separate, versioned, measurement-only protocol draft for
review. This result is not a protocol revision, collection authorization, candidate, Phase 10.6C
authorization, strategy/default/threshold change, PAPER action, promotion, wallet action, signing,
submission, order, fill, position, or live-trading authority.

## 2026-09-04 - Plan Measurement-Only Protocol Design Before Any New Collection

Decision: Establish planned Phase 10.6B.2 as the only immediate successor to the completed 10.6B.1
audit. It will create the design and static-review checklist for one potential
`EXPLORATORY_COHORT_MEASUREMENT@v3` protocol. It can use only the three aggregate availability
signatures from the completed audit, never a later label, strategy result, or inferred technical
remedy.

Boundary: The phase is documentation-first. It authorizes no V3 protocol source, validator code,
provider call, archive read, collector change, scheduler, named archive root, collection, candidate,
Phase 10.6C, strategy/default/threshold change, PAPER action, wallet action, signing, submission,
order, fill, position, or promotion. A future V3 draft must specify every collection-affecting value
and retain strict no-provider-expansion, no-retry, no-fallback, and outcome-blind measurement
boundaries before a separate implementation approval.

Detailed planning checklist:

- [NeXusTrade-Phase-10.6B.2-Detailed-Checklist.md](./NeXusTrade-Phase-10.6B.2-Detailed-Checklist.md)

## 2026-09-04 - Implement Static-Only V3 Measurement Protocol Draft

Decision: Implement the separately approved Phase 10.6B.2 design as one pinned
`EXPLORATORY_COHORT_MEASUREMENT@v3` source and an isolated stdout-only static validator. The draft
uses only the approved 10.6B.1 fingerprint, V2 root/protocol identity, and three aggregate measurement
signatures. It pre-registers direct liquidity at anchor and fixed local momentum calculations from four
pre-anchor `BEST_PAIR.priceUsd` observations at -15/-10/-5/0 minutes.

Boundary: The implementation changes no collector, gateway, provider adapter, scheduler, archive,
database/runtime, strategy, PAPER, wallet, signing, submission, order, fill, or position source. Its
synthetic-only tests and formatting/lint/typecheck/secret verification pass. Individual V2 archive
artifact hashes were intentionally excluded from the V3 draft and validator; only the allowed V2
root/protocol identity remains. The real V3 static-validator command was deliberately not run. A
separate explicit approval remains required for that stdout-only command, and its result cannot
authorize collection or execution.

Implemented artifacts:

- [phase10.6a-exploratory-cohort.v3.json](./research-protocols/phase10.6a-exploratory-cohort.v3.json)
- [NeXusTrade-Phase-10.6B.2-Detailed-Checklist.md](./NeXusTrade-Phase-10.6B.2-Detailed-Checklist.md)

## 2026-09-04 - Validate Pinned V3 Measurement Protocol Source

Decision: Run the one explicitly approved, stdout-only Phase 10.6B.2 static validator against the
pinned V3 source. It returned
`MEASUREMENT_PROTOCOL_DRAFT_READY_FOR_SEPARATE_COLLECTION_CHECKLIST_REVIEW` with content fingerprint
`b992982000ac2e0fb51cd7944a979adc0114f77a6845b3d36a3d88b9eab3e4e6` and the expected V3 SHA-256
`dd57285927474e3e646bd4a52c5d37fbb550d5cb73f836db69b02827c5360458`.

Boundary: The command read only the V3 source and fixed local constants. It reported zero provider/RPC/
HTTP, archive, database, filesystem-write, runtime, scheduler, session, and execution counters. It did
not create a collector, scheduler, archive root, or provider action. The result permits only a separate
V3 collection implementation-checklist decision; it does not authorize a collector implementation,
named archive root, provider call, collection, Phase 10.6C, PAPER action, or execution.

## 2026-09-04 - Plan V3 Measurement-Only Cohort Collector Before Any New Observation

Decision: Establish planned Phase 10.6A.2 as the only immediate successor to the passed V3 static
validation. It will create a detailed future collector contract for the frozen direct DEXSCREENER-only
measurement design: selection at anchor−16 minutes, market snapshots at −15/−10/−5/0 minutes, fixed
liquidity/momentum semantics, 168/672 request caps, immutable archives, and synthetic-only proof.

Boundary: This is planning only. It authorizes no collector source, provider call, V2 archive access,
launch record, named root, scheduler, collection, Phase 10.6C, strategy/default/threshold change,
PAPER action, wallet action, signing, submission, order, fill, position, or promotion. Before a future
implementation, the checklist requires a fail-closed fidelity review: no archive lifecycle status or
other collection behavior may be invented outside the pinned V3 protocol and existing immutable archive
safety contract.

Detailed planning checklist:

- [NeXusTrade-Phase-10.6A.2-Detailed-Checklist.md](./NeXusTrade-Phase-10.6A.2-Detailed-Checklist.md)

## 2026-09-04 - Implement V3 Measurement-Only Collector With Synthetic Evidence Only

Decision: After the separately approved checklist, implement the V3 measurement-only collector in a
new isolated module with a strict pinned-protocol/named-launch CLI, injected fake-test interfaces, and
an immutable archive/lock implementation. The completed local verification comprises format, lint,
typecheck, ten focused fake-clock/fake-gateway tests, and the secret scan.

Boundary: This implementation used no provider, V2 archive, real V3 root, named launch record,
scheduler, database/runtime, strategy, PAPER, wallet, signing, submission, order, fill, position, or
execution action. It authorizes none of those. The next possible action requires separate approval for
one named V3 root and a source-controlled launch record; scheduler authorization remains separate.

Implementation checklist:

- [NeXusTrade-Phase-10.6A.2-Detailed-Checklist.md](./NeXusTrade-Phase-10.6A.2-Detailed-Checklist.md)

## 2026-09-04 - Approve One Named V3 Measurement Launch Identity

Decision: Approve the source-controlled launch record
`phase10.6a-measurement-v3-20260904-2100Z.json` for the user-selected 14:00 PDT / 21:00 UTC anchor
on 2026-09-04. It supersedes the initially prepared uncommitted 20:00Z record before any operational
action. It pins only `data/archive/phase10.6a/measurement-v3-20260904-2100Z/`, the fixed V3 protocol
SHA, and the prior static-validation fingerprint. Local schema and identity validation passed with
zero provider calls, archive writes, or scheduler changes.

Boundary: The record does not create the physical root, arm a scheduler, invoke the collector, contact
a provider, or authorize Phase 10.6C, strategy work, PAPER, wallet, signing, submission, orders,
fills, positions, or execution. External scheduler authorization remains a separate required gate.

Named launch record:

- [phase10.6a-measurement-v3-20260904-2100Z.json](./research-launches/phase10.6a-measurement-v3-20260904-2100Z.json)

## 2026-09-04 - Authorize External Scheduler Runbook For One V3 Measurement Collection

Decision: Authorize an operator-owned external scheduler only for the approved
`measurement-v3-20260904-2100Z` launch. The provided Windows runbook starts at 13:44 PDT, repeats
every two hours for exactly 168 scheduled slots, rejects overlap/catch-up/retry/restart, and invokes
only the pinned V3 one-shot command.

Boundary: The runbook is source-controlled guidance; it does not itself register, arm, or start an
operating-system task. It does not authorize any provider beyond the fixed V3 direct DEXSCREENER calls,
another root, archive rewrite, analysis, Phase 10.6C, strategy/default change, PAPER action, wallet,
signing, submission, order, fill, position, or execution behavior.

Runbook:

- [phase10.6a-measurement-v3-20260904-2100Z-operator-runbook.md](./research-launches/phase10.6a-measurement-v3-20260904-2100Z-operator-runbook.md)

## 2026-09-09 - Add a Proposed Paper-Pilot Experiment Protocol Without Changing Active V3 Collection

Decision: Insert proposed Phase 10.7A, Paper-Pilot Experiment Protocol, after a successful Phase
10.7 promotion review and before Phase 10.8A/10.8B. It will be a documentation-only pre-registration
stage for a genuinely promoted, evidence-backed profile. Its future contract must fix a small set of
versioned experimental profiles, a shared timestamped market universe, isolated simulated portfolio
identities, cost/fill assumptions, session and risk limits, operational and P/L measures, a profile
comparison/retirement rule, and revisions only between completed pilot batches. A 4-6-hour session
and 5-7-day batch are possible future protocol values only when their sampling, independence, and
minimum-evidence requirements are fixed before any implementation.

Reason: This preserves the desired iterative paper-pilot workflow without treating short-run P/L as
proof, allowing mid-batch tuning, or letting parallel profiles share capital or select their own
market evidence. It also makes the distinction explicit: Phase 10.7A defines a future experiment;
Phase 10.8B is the separately approved operational step that could later create simulated sessions,
orders, fills, positions, and P/L records.

Boundary: This decision leaves the active `measurement-v3-20260904-2100Z` V3 collection, its frozen
protocol, named root, and operator scheduler unchanged. It authorizes no provider call, archive
analysis/write, database/runtime action, strategy/default/threshold change, PAPER configuration,
session, simulated order/fill/position/P/L, wallet action, signing, submission, or Phase 10.6C
activity. Phase 10.7A remains blocked until Phase 10.6C and Phase 10.7 have independently supplied
the required evidence.

Consequence: Phase 10.8A requires both a successful Phase 10.7 promotion review and a frozen Phase
10.7A protocol. Phase 10.8B additionally requires a separate named-pilot approval. This is a
roadmap and handoff clarification only; it does not create a Phase 10.7A implementation checklist.

## 2026-09-09 - Plan V3 Final Measurement Capability Analysis In Parallel

Decision: Create Phase 10.6B.3 as the final-archive-only V3 measurement-capability analysis plan.
It will be implemented, if separately approved, with synthetic fixtures before the active cohort
finishes. It may later determine only whether the frozen V3 availability, freshness, provenance,
population-independence, and zero-safety gates are confirmed, not confirmed, or lack minimum
evidence. A final result may preserve bounded failure facts for a separate human measurement-protocol
decision, but cannot select a remediation or a successor protocol.

Boundary: The active `measurement-v3-20260904-2100Z` root, frozen V3 protocol, and external
scheduler remain outside this planning work. The production analyzer must default-deny before an
archive read until a separately approved source-only final identity binding records the protocol and
four final artifact hashes. This decision authorizes no active/archive read, provider/RPC/HTTP call,
database/runtime action, archive write, scheduler action, strategy/default/threshold change, PAPER
configuration, session, order, fill, position, P/L, wallet action, signing, submission, Phase 10.6C,
or live-trading behavior.

Consequence: After V3 finality, final-state review, source-reviewed identity binding, and a separate
exact-root run approval remain required. No V4 protocol or additional collection is pre-authorized.

Detailed planning checklist:

- [NeXusTrade-Phase-10.6B.3-Detailed-Checklist.md](./NeXusTrade-Phase-10.6B.3-Detailed-Checklist.md)

## 2026-09-09 - Implement V3 Final Measurement Capability Analyzer In Parallel

Decision: Implement Phase 10.6B.3 with synthetic fixtures only while the named V3 measurement-only
cohort remains active. The isolated analyzer validates a final archive's exact artifact set, frozen
protocol/launch identity, injected raw artifact identity, zero safety facts, V3 availability,
freshness, provenance, population-independence, and source-inventory consistency. It emits only
deterministic bounded Markdown or JSON to stdout and classifies only the three frozen non-authorizing
measurement-capability outcomes.

Boundary: No active V3 archive, provider/RPC/HTTP surface, database, runtime, scheduler, filesystem
archive write, strategy/default/threshold behavior, PAPER configuration, session, order, fill,
position, P/L, wallet action, signing, submission, Phase 10.6C, or live-trading behavior was read,
modified, constructed, or invoked. The production identity is intentionally unset, so the command
fails with `MEASUREMENT_COHORT_ANALYSIS_IDENTITY_NOT_REGISTERED` before resolving an archive.

Verification: On 2026-09-09, format, lint, workspace typecheck, the focused 11-test synthetic suite,
and the secret scan passed. The real root remains unexamined by this phase.

Consequence: V3 final-state review, source-only binding of the four final artifact hashes, and one
exact-root stdout-only report still each require separate approval. No V4 protocol, additional
collection, candidate, Phase 10.6C, PAPER action, or promotion is pre-authorized.

Detailed implementation checklist:

- [NeXusTrade-Phase-10.6B.3-Detailed-Checklist.md](./NeXusTrade-Phase-10.6B.3-Detailed-Checklist.md)

## 2026-09-09 - Plan Engineering Hardening And The Post-V3 Development Path

Decision: Add Phase 10.6H as a parallel engineering improvement track for existing development, and
record the near-term closeout sequence and prospective requirements for later phases. The user
requested documentation changes while protecting the V3 cohort through September 18. This update
does not implement code or start a runtime.

Scope: H1 completes the analyzer's required synthetic verification before final identity binding;
H2 addresses atomic/repeat-safe accounting, schema constraints, migration readiness, and read-only
reconciliation; H3 repairs general provider limiter concurrency; H4 enforces dependency boundaries,
runtime validation, isolated automated checks, and targeted maintainability improvements.

Evidence: Source review and in-memory/fake-clock probes reproduced partial BUY persistence after a
cash-write failure, missing schema invariants, an incomplete migration readiness check, and concurrent
limiter over-admission. The existing 49 database/PAPER/HTTP tests, four frontend tests, and three
workspace typechecks passed. The analyzer's 11-test pass is retained as historical evidence, but the
claim that every planned case is covered is reopened in its checklist. No active V3 data was used.

Boundary: Documentation can proceed while collection runs. Later implementation must demonstrate a
physically separate checkout, independent dependencies, and synthetic/in-memory/temporary data; a
branch in the operational directory is not isolation. Shared source/tooling changes stay out of the
scheduled checkout through V3 closeout, and pending analyzer dependencies stay unchanged through its
report. The frozen protocol, launch, runbook, root, scheduler, provider budgets, and strategy defaults
remain unchanged. Implementation checklists do not authorize operational database migration or repair.

Consequence: The final scheduled invocation starts September 18 at 11:44 AM PDT and anchors at noon
PDT. Existing operator runbook actions and separate finality, binding, and stdout-only analysis gates
remain in force. Engineering hardening can progress regardless of the V3 capability result, but no
package advances a research gate. Confirmed capability can support only a separate decision to design
a new outcome-aware evidence-producing study; actual candidate evidence is still required before
10.6C. Applicable H2-H4 acceptance becomes an additional engineering prerequisite for future PAPER.

Future-phase scope: Record roadmap-level requirements now for 10.6C, promotion, paper protocol,
read-only operations visibility, bounded pilot, assessment, and live readiness. Detailed hypothesis
and pilot planning remain dependent on their existing upstream decisions. No successor protocol,
numerical study setting, profile, or pilot is selected. V2 remains `NO_DEFENSIBLE_HYPOTHESIS`.

Planning records:

- [NeXusTrade-Phase-10.6H-Detailed-Checklist.md](./NeXusTrade-Phase-10.6H-Detailed-Checklist.md)
- [Post-V3-Development-Plan.md](./Post-V3-Development-Plan.md)

## 2026-08-19 - Separate Paper Operations From Archive Research Views

Decision: Record a gate-dependent Phase 10.5 through Phase 10.9 pathway after Phase 10.4. A future
Phase 10.8A Paper Operations Dashboard will be a separate local operational surface, implemented
only after Phase 10.7 authorizes a controlled paper pilot. It must not be added to the Phase 10
archive-only Research Dashboard.

Reason: The current dashboard describes immutable completed research evidence. Active PAPER
operations require a different truth source and different presentation: session state, orders,
fills, positions, realized and unrealized P/L, equity, drawdown, quote provenance, and mark
freshness. Combining them would blur decision-time research evidence with current operational state.

Boundary: The initial Paper Operations Dashboard is read-only from the UI. It may read active PAPER
state through a local backend boundary, but it does not fetch provider data itself, create sessions,
place orders, sell, change a strategy, load a wallet, sign, submit, or enable live execution.
Realized P/L must use recorded fills/closed positions plus recorded fees. Unrealized P/L must use a
stored mark with source and `asOf` freshness, never an unstated or stale value.

Consequence: A passing Phase 10.7 promotion review is required before Phase 10.8A/10.8B planning.
Paper-pilot changes are versioned and applied only between fixed pilot batches; a revised strategy
returns to independent shadow validation. Phase 11 remains live-readiness hardening, Phase 12
remains tiny guarded live experiments, and a future Phase 14 gate is required before autonomous
live-wallet trading.

## Pending Phase 9 Decisions

These should be locked during Phase 9 implementation:

- Whether the first TerminalRunner implementation composes service classes directly, command runner
  classes directly, or script-like adapters around existing runner surfaces. Resolved: compose
  existing runner/service classes directly.
- Whether the default mode is `--once`, fixed `--cycles`, or continuous until interrupted.
  Resolved: default `--once`; `--cycles` or `--max-runtime-minutes` enables looping.
- Whether TerminalRunner writes structured run artifacts by default or only when `--output-dir` is
  supplied. Resolved: only when `--output-dir` is supplied.
- Whether Phase 9 validation starts from the current paper DB or a fresh `db:reset:paper`.
- How TerminalRunner computes and prints provider pressure per cycle. Resolved: summarize
  `ProviderHealth` deltas per stage, cycle, and run.
- Whether provider pressure should be read directly from `ProviderHealth` deltas or accumulated
  through stage result contracts. Resolved: stage result contracts carry ProviderHealth delta
  summaries.
- Whether a looped TerminalRunner run should create one session or reuse scanner auto-created
  sessions per cycle. Resolved: one TerminalRunner-created `PAPER` + `RUNNING` session per run.
- Whether cross-run aggregation should be a separate command or folded into TerminalRunner.
  Resolved: separate read-only `pnpm research:aggregate`.

## Pending Phase 9.2+ Provider Decisions

- Whether Jupiter token metadata should remain disabled by default after Phase 9.2B validation.
- Raydium fallback API/auth details. Resolved for Phase 9.3: use the public Raydium Trade API
  quote endpoint; no API key required for the first quote-only implementation.
- Birdeye endpoint budget by research use case.
- Titan integration API access status and suitable endpoint docs.
- Autobahn hosted API token availability versus self-hosting deferral.
- Whether QuickNode or another RPC provider is needed for reliability before live readiness.
