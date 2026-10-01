# Post-V3 Development Plan

Last updated: 2026-09-24

Status: V3/B.3 closeout is recorded on main: `MEASUREMENT_CAPABILITY_NOT_CONFIRMED` after liquidity availability failed the frozen 90% gate in both partitions. Collection reportedly finalized September 12 and the user confirmed the scheduler disabled. This integration reads committed source/docs and synthetic fixtures only; it does not independently inspect the operational archive or scheduler.

Current main incorporates the binding/repair (`6f8ae85`, `ae5c940`) and the completed engineering
hardening baseline. H4 merged by PR #5 at `88921e9`; later closeout/handoff documentation merged at
`b6c9e87`. See the [integration evidence](./Phase-10.6H-Main-Isolation-Integration.md) and the
[H4 verification record](./Phase-10.6H-H4-Verification.md). This engineering baseline does not
change the historical B.3 source/run provenance or authorize a successor protocol, collection,
migration, PAPER, or live action.

This plan supplies requirements for future phase checklists. It does not claim that their detailed
protocols, implementations, thresholds, sample sizes, or approvals already exist. Research-specific
planning still depends on the final evidence and the applicable separate decisions.

## 1. Current State And Two Independent Tracks

| Track       | Current state                                                                                                                                                          | Next evidence required                                                                                                         |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Research    | B.4 closed on 2026-09-24 as `NO_NEW_MEASUREMENT_PROTOCOL_JUSTIFIED`, with liquidity necessity `UNRESOLVED`, after the assistant proposal and separate user acceptance. | New separately scoped evidence defining a concrete research question and a supported materially different measurement concept. |
| Engineering | Current main includes the completed hardening baseline and scoped analytics/verification controls.                                                                     | Remaining documented reader/architecture debt only; it creates no research authority.                                          |

Engineering work can improve existing code regardless of V3's capability outcome. Engineering
completion cannot produce a hypothesis or replace independent validation. A positive V3 capability
result likewise does not establish accounting correctness, a candidate, or permission to trade.

## 2. Immediate Integration And Development Sequence

1. Completed: integrate main into isolation while preserving final identity binding, absolute
   slot-coordinate repair, and the approved engineering protections.
2. Completed: verify admitted combined synthetic/static suites without rerunning the production
   analyzer; hosted acceptance is recorded separately from local evidence.
3. Completed: synchronize status while preserving historical B.3 source/report provenance. Later
   combined-source tests do not retroactively establish that their hardening was present in B.3.
4. Completed: H4 implementation `3119487`, cross-platform correction `bde0d7c`, local checks and four hosted Ubuntu/Windows push/PR checks. See the [closed checklist](./NeXusTrade-Phase-10.6H-H4-Detailed-Checklist.md).
5. Completed: PR #5 merged H4 into main at `88921e9`; its later closeout/handoff documentation is
   merged at `b6c9e87`. Operational deployment/migrations remain separately scoped.
6. Completed and human-accepted: **10.6B.4 — Measurement Remediation Decision** from the unified
   baseline. The documentation-only investigation used existing B.3 documents and produced an
   evidence/uncertainty ledger, a liquidity-necessity and material-alternatives assessment, and a
   proposed decision memo. On 2026-09-24, the assistant proposed `UNRESOLVED` necessity,
   `VALID_NEGATIVE_DECISION`, and `NO_NEW_MEASUREMENT_PROTOCOL_JUSTIFIED`; the user subsequently
   accepted that outcome within the reviewed documentary scope on the same date. The proposal and
   acceptance remain distinct events. Because the permitted documents reviewed establish neither a
   concrete future research question nor a supported material alternative and successor protocol
   fields, no conditional protocol draft was created. No archive inspection, reader, validator,
   formatter, CLI, protocol validation, collection, or PAPER authority follows.

The earlier September 18 final-invocation waiting sequence is superseded by main's recorded early finalization and B.3 report. Do not restart the scheduler or add replacement observations. Frozen protocol, launch and runbook artifacts remain historical evidence and are not rewritten.

The only production archive is `data/archive/phase10.6a/measurement-v3-20260904-2100Z/`.
The expected final artifacts remain exactly `cohort-manifest.v1.json`, `units.v1.ndjson`,
`source-inventory.v1.json`, and `collection-summary.v1.json`. No new report belongs inside the archive.
Do not change the production identity using interim hashes or run an extra collector to force finality.

If the final slot is missed, a lock remains, the archive is incomplete/unsafe, or hashes disagree,
preserve the bounded facts for separate review. This is not a capability result and authorizes no
repair, extension, replacement, retry, or manual closeout. A data-quality-stop archive is outside
the analyzer's two accepted final outcomes and must be handled through that review.

## 3. Branch On The Final Measurement Result

| Result                                    | Human decision it can support                                                                      | What remains unavailable                                                                              |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `MEASUREMENT_CAPABILITY_CONFIRMED`        | Whether to commission a new outcome-aware research design that can produce candidate evidence.     | Automatic successor/V4 protocol, collection, candidate, 10.6C, promotion, or PAPER.                   |
| `MEASUREMENT_CAPABILITY_NOT_CONFIRMED`    | Whether a separate measurement-protocol planning task is justified by the final deficiency ledger. | A selected remedy, provider expansion, collection extension, strategy claim, or candidate.            |
| `MEASUREMENT_EVIDENCE_INSUFFICIENT`       | Preserve the evidence and decide separately whether further research planning is justified.        | Filling gaps, rerunning the same cohort, relaxing gates, automatic protocol/collection, or candidate. |
| Bounded integrity/finality/identity error | Investigate the allowed final-state facts under a separate scope.                                  | Any interpretation of that error as a valid capability report.                                        |

The prior V2 conclusion remains closed in every branch. The analyzer describes measurement evidence;
it does not choose the next research design.

## 4. Missing Research Gate Before Phase 10.6C

After confirmed capability and a separate research-governance decision, a new evidence-producing
study may be designed. This stage is explicitly present in the roadmap but has no assigned successor
protocol/version or implementation checklist yet. Assign those only when its scope is approved.

The later design must specify:

- the research question and finite hypothesis/search space, materially distinct from closed studies;
- the target population, selection rule, enrollment/decision time, and sampling independence;
- outcome labels and horizons, including availability and censoring rules;
- strict separation of decision-time inputs from later labels, with no future-information leakage;
- discovery/held-validation roles, multiplicity handling, effect criteria, stability checks, and
  minimum evidence sufficient for the planned inference;
- missingness, provider failures, timing/freshness, costs where applicable, and stop conditions;
- immutable protocol/code/schema/dependency identity and which data each analysis can access; and
- explicit negative, insufficient, and potentially candidate-supporting outcomes and their limits.

No numerical settings are selected here. Before observations begin, freeze the concrete design,
review its isolated implementation and tests, and separately authorize the named collection. After
collection, separately review the final archive and approved analysis. A candidate is available only
if that study actually meets its pre-registered criteria and receives the required human decision.
Discovery or held-validation data used there are not fresh independent Phase 10.6C evidence.

## 5. Requirements For The Next Research Gates

### Phase 10.6C — Independent Real-Market Shadow Validation

Entry: one materially distinct, evidence-supported hypothesis, a frozen versioned pre-registration,
and separate validation-study authorization. Current status: blocked; no candidate exists.

Required future checklist:

- [ ] Define the exact hypothesis/profile, permitted inputs, labels, sample/independence requirements,
      analysis plan, pass/fail/insufficient outcomes, and safety stops before collecting fresh data.
- [ ] Freeze protocol, code, dependency, schema, and analysis versions; record full evidence lineage.
- [ ] Demonstrate independence from candidate-development data, prevent later-label leakage into
      selection, and retain missed/invalid observations according to the pre-registration.
- [ ] Verify implementation synthetically and satisfy applicable H3/H4 prerequisites before named
      provider collection. No PAPER or wallet/execution surface is permitted.
- [ ] Analyze only the separately approved final scope; preserve negative/insufficient results.

Exit: a documented validation result and evidence package. Only a passing result can support a
separate 10.7 promotion review; it does not activate a strategy or authorize a pilot.

### Phase 10.7 — Promotion Review

Entry: successful independent validation and its immutable evidence identity.

- [ ] Review validity, stability, limitations, and operational assumptions against pre-registration.
- [ ] Record the exact eligible profile/version, evidence identities, reviewer decision, conditions,
      and permitted next step in a versioned promotion record.
- [ ] Keep rejection, deferral, and insufficiency explicit; defaults and execution remain unchanged
      merely because a review record exists.

Exit: a human decision on eligibility for controlled PAPER preparation. A positive decision permits
10.7A protocol work; implementation and named-pilot authority remain separately scoped.

## 6. Requirements For Future PAPER Phases

These are roadmap-level requirements, not detailed pilot planning or pre-registration. Phase 10.7
promotion is still required before that planning begins; Phase 10.7A must freeze the experiment before
the operational implementation is built or run.

| Phase                                        | Entry                                                                                                                                   | Required contract and evidence                                                                                                                                                                                                                                                                                                                                | Exit                                                                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 10.7A — Paper-Pilot Experiment Protocol      | Positive 10.7 decision for exact eligible profile versions.                                                                             | Fix experiment/portfolio identity, universe, cash/ledger semantics, costs, slippage, latency and fill model, rounding/token units, exposure/loss/session limits, stale-evidence handling, interruption/restart rules, primary measures, minimum evidence, and review cadence. Resolve any proposed cash-ledger addition. No values are selected in this plan. | Frozen protocol and implementation requirements; no execution activation.                                                               |
| 10.8A — Read-only Paper Operations Dashboard | Positive 10.7 decision and frozen 10.7A protocol.                                                                                       | Separate application boundary over recorded operational state; metric definitions and provenance, experiment/profile identity, cash/P&L reconciliation, equity/drawdown/exposure, mark freshness, missing data, and traceability to recorded trades. Synthetic fixtures first; UI has no provider, session, trade, or wallet controls.                        | Verified operator visibility; no pilot authority.                                                                                       |
| 10.8B — Controlled PAPER Pilot               | Exact promoted profile, frozen 10.7A protocol, applicable H2-H4 acceptance, required operator visibility, and one named-pilot approval. | First implement/verify the protocol using synthetic data: atomic accounting, operation identities, concurrent/repeated-call handling, persisted lifecycle, crash/restart recovery, reconciliation, stale-data/loss limits, and run bounds. Then execute only the approved named pilot with its declared costs, versions, and cadence.                         | Bounded pilot evidence, operation/error ledger, and final reconciliation for 10.9.                                                      |
| 10.9 — Pilot Assessment                      | Completed bounded pilot with retained identity and reconciliation evidence.                                                             | Establish operational validity first; distinguish simulated fills/marks from executable outcomes. Assess pre-registered performance measures, costs, missingness, independence, uncertainty, and limits only for interpretable evidence.                                                                                                                      | Preserve/reject, propose a new version with renewed validation, or separately consider live-readiness work. No automatic live approval. |

Accounting correctness is a prerequisite for interpreting a PAPER pilot, not work to postpone until
Phase 11. Existing H2 repairs improve current code without selecting future pilot assumptions.
Any new ledger/portfolio/execution capability must follow its owning future protocol and phase.

Changes inspired by a pilot are versioned, applied only between completed fixed batches, and returned
to independent shadow validation before another pilot. Do not tune an ongoing batch or reinterpret
its pre-registered gates after observing outcomes.

## 7. Later Live-Readiness Requirements

Phase 11 must explicitly design signing/secret boundaries, account and position reconciliation,
exposure controls, transaction intent/submission/confirmation states, ambiguous-outcome recovery,
emergency controls, and operational recovery evidence. A database rollback cannot undo an externally
submitted transaction; submission retries must first establish what actually happened.

Phase 12 requires separate tiny, named, bounded live-test authorization after readiness gates pass.
Phase 13 adds providers/infrastructure/strategies only when measured needs justify them. Phase 14
requires another explicit gate before any low-cap autonomous live pilot. These are future checklist
requirements only; no wallet, account, signing, submission, provider purchase, or live test is planned
in executable detail here.

## 8. Common Checklist And Definition Of Done

Every future detailed phase checklist must identify:

1. Its strict question or capability and current status.
2. Exact inputs, version identities, evidence prerequisites, and operational authority.
3. Allowed reads/writes/calls and prohibited dependencies/actions.
4. Behavior on interruption, duplication, concurrency, stale inputs, and inconsistent state.
5. Named tests and retained evidence for every required acceptance criterion.
6. Negative/insufficient results, unresolved limitations, and the precise next decision it can support.

Keep implementation completion, synthetic verification, operational authorization, observed results,
and human decisions separate in status records. Update dates and links when status changes. Historical
test passes remain historical evidence; they do not close newly identified verification gaps.

## 9. Planning And Handoff Checklist

- [x] Add Phase 10.6H with bounded packages, acceptance tests, and active-V3 isolation rules.
- [x] Record the September 18 final-slot sequence and preserve the original closeout approvals.
- [x] Make the candidate-producing research-design stage explicit before 10.6C without inventing a
      protocol, hypothesis, or future study authorization.
- [x] Assign prospective requirements to 10.6C, 10.7, 10.7A, 10.8A/B, 10.9, and 11-14.
- [x] Complete H1 engineering acceptance.
- [x] Complete the separately gated final V3 review, identity binding, and exact-root B.3 analysis.
      Historical provenance: binding `6f8ae85`, slot-ledger repair `ae5c940`, and the B.3 report
      remain distinct from later hardening integration.
- [x] Record the actual V3 result and the human decision to prepare B.4 planning only in the active
      handoff documents. The recorded result is `MEASUREMENT_CAPABILITY_NOT_CONFIRMED`; no protocol,
      collection, or execution decision has been made.
- [x] Scope and complete H2-H4 implementation/integration under the isolation and closeout rules.
      H4 acceptance merged at `88921e9`; the later closeout/handoff update is in `b6c9e87`.
- [x] Draft the detailed H2 checklist for review, including transaction/identity/schema/migration/
      reconciliation design and acceptance evidence; H2 is implemented and committed as `ff6d586`.
- [x] Draft the detailed H3 implementation checklist for user review. H3 implementation and isolated engineering acceptance are complete.
      H4 implementation, hosted acceptance and main integration are complete at `88921e9`.
- [x] Draft the detailed Phase 10.6B.4 Measurement Remediation Decision checklist for review only.
      It defines a documentation-led human review using existing B.3 reports first. Any indispensable
      archive inspection must identify the exact question, artifact, permitted fields, operation, and
      disclosure limit for separate approval. It creates no B.4 investigation, tooling implementation,
      provider call, archive action, protocol-validation, collection, or trading authority.
- [x] Complete the approved B.4 documentation-led investigation using only permitted documents.
      The assistant-prepared ledger and assessment supported a proposed `UNRESOLVED` necessity
      finding, `VALID_NEGATIVE_DECISION`, and `NO_NEW_MEASUREMENT_PROTOCOL_JUSTIFIED`. The user
      accepted that outcome within the reviewed documentary scope on 2026-09-24. No archive
      inspection or conditional protocol draft was needed, and no downstream authority was created.
- [ ] Only when upstream evidence permits, draft each detailed successor protocol/checklist and
      obtain the applicable existing research/operational approvals.
