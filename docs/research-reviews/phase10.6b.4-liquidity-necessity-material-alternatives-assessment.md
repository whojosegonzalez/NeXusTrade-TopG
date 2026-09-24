# Phase 10.6B.4 Liquidity-Necessity And Material-Alternatives Assessment

Status: **Assistant-proposed assessment prepared on 2026-09-24. The user accepted its proposed B.4
outcome and `UNRESOLVED` liquidity-necessity classification on 2026-09-24 within the reviewed
documentary scope. The proposal and acceptance remain distinct events.**

This assessment uses the
[Phase 10.6B.4 evidence and uncertainty ledger](./phase10.6b.4-evidence-uncertainty-ledger.md)
and only the documentary sources permitted by the
[B.4 checklist](../NeXusTrade-Phase-10.6B.4-Detailed-Checklist.md). It originated as the assistant's
human judgment proposal, not a mechanical analyzer result. The user's later acceptance is recorded
separately and does not convert the judgment into a mechanical finding.

## 1. Question That Must Precede Liquidity Necessity

A defensible necessity decision requires a concrete future research question whose validity depends
on a defined decision-time liquidity fact.

The permitted documents currently establish only that:

- V2 produced no defensible strategy hypothesis;
- V3 tested measurement availability, not strategy performance;
- B.3 found the V3 liquidity measurement unavailable too often for the frozen gate; and
- a future evidence-producing study must separately define its hypothesis, population, inputs,
  labels, and inference plan.

The permitted documents reviewed do not define the future strategy-research question. Therefore the
assessment cannot determine whether liquidity is indispensable, optional, replaceable by another
concept, or irrelevant to that future study.

## 2. Proposed Liquidity-Necessity Judgment

Proposed classification: **UNRESOLVED**

Proposed rationale:

1. Liquidity appeared as a V3 measurement objective, but inclusion in V3 is not proof that every
   future research question requires it.
2. The current roadmap explicitly says no candidate or successor hypothesis is established in the
   permitted documents reviewed.
3. Without a future research question defined in those reviewed documents, there is no valid way to
   determine what liquidity fact would be used, how it would enter the analysis, or what bias/risk
   would arise if it were absent.
4. The documents do not support the stronger NOT_REQUIRED conclusion because they do not show that
   a future study can remain valid without liquidity.
5. The documents do not support REQUIRED because they do not show that a defined future study cannot
   be evaluated without it.

This was the assistant's proposed judgment. The user accepted it on 2026-09-24 within the reviewed
documentary scope, with liquidity necessity remaining UNRESOLVED.

## 3. Material-Alternatives Assessment

| Alternative class                                         | Material in principle?                                                                                              | Documentary support now                                                                                                                        | Proposed assessment                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Repeat V3 unchanged or collect longer                     | No. It changes duration/sample only and preserves the failed method.                                                | Explicitly prohibited as remediation by the B.4 checklist.                                                                                     | REJECTED_NOT_MATERIAL                                 |
| Increase request caps or change dates/slots only          | No. These change operating quantities without changing the measurement method or semantics.                         | V3 already provided enough valid units for assessment; liquidity still failed both partition gates.                                            | REJECTED_NOT_MATERIAL                                 |
| Add retry or fallback alone                               | No under B.4's rule, and it would change provider behavior without causal evidence.                                 | B.3 cannot causally attribute missing facts; V3 prohibited retries/fallbacks.                                                                  | REJECTED_NOT_MATERIAL_AND_UNSUPPORTED                 |
| Lower the 90% availability threshold                      | No. It changes the success rule rather than repairing measurement.                                                  | Explicitly prohibited; 90% remains frozen.                                                                                                     | REJECTED_PROHIBITED                                   |
| Relabel missingness as availability                       | No. It changes accounting rather than evidence.                                                                     | Explicitly prohibited by V3/B.4 missingness rules.                                                                                             | REJECTED_PROHIBITED                                   |
| Use a different direct source for the same liquidity fact | Potentially, if semantics/provenance are defined and evidence supports relevance to availability.                   | No source, capability, value path, freshness behavior, provenance contract, or evidence of likely improvement is documented.                   | PLAUSIBLE_DESIGN_CLASS_BUT_UNSUPPORTED_AND_INCOMPLETE |
| Use a different measurement method for the same fact      | Potentially, if equivalence to the necessary fact and outcome blindness can be demonstrated.                        | No method, equivalence argument, missingness contract, timing rule, or supporting evidence is documented.                                      | PLAUSIBLE_DESIGN_CLASS_BUT_UNSUPPORTED_AND_INCOMPLETE |
| Use a different liquidity proxy or redefine the fact      | Potentially material, but it may answer a different research question rather than remediate the same measurement.   | No future question or semantic equivalence criterion is defined in the permitted documents reviewed.                                           | UNRESOLVED; REQUIRES_A_SEPARATE_RESEARCH_QUESTION     |
| Remove liquidity from a future study                      | Not a liquidity-remediation protocol. It could be valid only if a concrete future design establishes non-necessity. | No future study exists from which to make that determination.                                                                                  | UNRESOLVED; CANNOT_SUPPORT_NOT_REQUIRED               |
| Combine multiple sources                                  | Potentially material as a new provenance/missingness contract.                                                      | No documented source set, precedence, agreement rule, budget, independence treatment, or evidence supports it; fallback alone is insufficient. | PLAUSIBLE_DESIGN_CLASS_BUT_UNSUPPORTED_AND_INCOMPLETE |

No alternative passes all three necessary judgments:

1. materially different;
2. supported by the permitted evidence; and
3. complete enough to establish protocol fields without invention.

## 4. Proposed Protocol-Field Readiness

This section establishes the status of every potential protocol field before any conditional draft
could be created. It does not create a protocol draft.

| Required field or protection                                 | What existing documentation establishes                                                                                                    | Readiness for a successor draft                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Bounded research question and measurement objective          | V3's historical measurement question only; no future candidate-producing research question is defined in the permitted documents reviewed. | NOT_ESTABLISHED                                                         |
| Liquidity necessity                                          | V3 included liquidity, but no future-study dependency is documented.                                                                       | UNRESOLVED                                                              |
| Exact liquidity semantics                                    | Historical V3 semantics: finite non-negative USD `BEST_PAIR.liquidityUsd` at anchor.                                                       | HISTORICAL_BASELINE_ONLY; SUCCESSOR_SEMANTICS_NOT_ESTABLISHED           |
| Technical-validity anchor                                    | V3 used canonical identity and selection-time source metadata with a slot anchor.                                                          | HISTORICAL_BASELINE_ONLY; NO JUSTIFIED SUCCESSOR CHOICE                 |
| Outcome-blind population and sampling rule                   | V3's canonical Solana discovery universe, fixed seed/hash selection, one unit per slot, and cohort deduplication.                          | HISTORICAL_BASELINE_ONLY; CARRY-FORWARD_NOT_JUSTIFIED                   |
| Planned/minimum cohort sizes                                 | V3 used 96 planned, 72 minimum, and 168 maximum attempted slots.                                                                           | HISTORICAL_BASELINE_ONLY; SUCCESSOR VALUES_NOT_JUSTIFIED                |
| Partition assignment and minimums                            | V3 used deterministic Discovery/Validation assignment and at least 32 units per partition.                                                 | HISTORICAL_BASELINE_ONLY; SUCCESSOR VALUES_NOT_JUSTIFIED                |
| Date-support and concentration controls                      | V3 required at least 8 dates, at least 4 per partition, and at most 20% of valid units per date.                                           | PROTECTION_BASELINE_AVAILABLE; SUCCESSOR VALUES_NOT_ADOPTED             |
| Field/value/missingness schema                               | V3 fixed liquidity type/unit, eight missingness codes, and no value when unavailable.                                                      | HISTORICAL_BASELINE_ONLY; REMEDIATED FIELD CONTRACT_NOT_ESTABLISHED     |
| Proposed source category/capability                          | V3 used DEXSCREENER `MARKET_CONTEXT/BEST_PAIR`; no alternative is named or evidenced.                                                      | NOT_ESTABLISHED                                                         |
| Provenance contract                                          | V3 required exact category/source identifier.                                                                                              | PROTECTION_PRINCIPLE_ESTABLISHED; SUCCESSOR PROVENANCE_NOT_ESTABLISHED  |
| Request, concurrency, retry, and fallback budgets            | V3 fixed one request/concurrency per category, no retry, no fallback, and fixed caps.                                                      | HISTORICAL_BASELINE_ONLY; SUCCESSOR BUDGETS_NOT_JUSTIFIED               |
| Observation timing/freshness/tolerance                       | V3 measured at anchor with a 60-second maximum source-to-anchor interval.                                                                  | HISTORICAL_BASELINE_ONLY; SUCCESSOR METHOD_TIMING_NOT_ESTABLISHED       |
| Archive identity/finality/retention                          | V3 used four immutable artifacts with indefinite retention and prohibited credentials/raw payloads.                                        | PROTECTION_BASELINE_AVAILABLE; SUCCESSOR CONTRACT_NOT_DRAFTED           |
| Data-quality stops                                           | V3 defined clock, schema, secret-like-content, and provider-budget stops.                                                                  | PROTECTION_BASELINE_AVAILABLE; SUCCESSOR-SPECIFIC STOPS_NOT_ESTABLISHED |
| Availability gate                                            | At least 90% per objective per partition.                                                                                                  | ESTABLISHED_AND_FROZEN_AS_A_FLOOR                                       |
| Freshness/provenance/date/concentration/independence gates   | V3/B.4 require protections no weaker than the frozen contract.                                                                             | ESTABLISHED_AS_PROTECTION_FLOORS; SUCCESSOR MECHANICS_NOT_ESTABLISHED   |
| Independent analysis plan and negative/insufficient outcomes | B.4 requires them, but no successor objective or protocol exists.                                                                          | NOT_ESTABLISHED                                                         |
| Zero provider action during analysis and zero DB/execution   | Existing safety boundary is explicit.                                                                                                      | ESTABLISHED_AND_REQUIRED                                                |
| Downstream default denial                                    | Validation, implementation, named root, scheduler, collection, 10.6C, PAPER, and execution all require later approvals or remain disabled. | ESTABLISHED_AND_REQUIRED                                                |

Only the frozen safety/protection floors are established. The design fields that make a successor
materially different and reviewable are not. Copying all historical V3 values would repeat the failed
contract rather than justify remediation.

## 5. Evidence Validity And Proposal Completeness

Assistant-proposed and user-accepted evidence state: **VALID_NEGATIVE_DECISION**

- The B.3 documentary identity and bounded aggregate findings are mutually consistent.
- The evidence validly establishes failure of V3 liquidity availability against 90%.
- It does not establish the cause of missingness.
- It does not establish liquidity necessity for a concrete future study.
- It does not establish one supported, materially different alternative.
- It does not establish the successor-specific protocol fields listed above.

The proposal also lacks required fields, but this is not being classified primarily as
VALID_BUT_INCOMPLETE_PROPOSAL because no alternative has first cleared necessity, materiality, and
support. There is not yet a supported proposal to complete.

## 6. Archive Inspection Assessment

No archive inspection is proposed.

The unresolved matters are conceptual and evidentiary: future research purpose, necessity, semantic
equivalence, and support for an alternative. A row-level integrity inspection could reconfirm archive
structure or counts, but existing documents are already consistent on those facts. It could not
legitimately identify a provider remedy or establish a future research question under the approved
boundary.

## 7. Proposed And Accepted Assessment Conclusion

The assistant proposed:

- liquidity necessity: **UNRESOLVED**;
- evidence state: **VALID_NEGATIVE_DECISION**;
- materially different supported alternative: **NONE ESTABLISHED**;
- protocol-field readiness: **INCOMPLETE BEFORE DRAFTING**; and
- conditional protocol draft: **DO NOT CREATE**.

Under the B.4 decision mapping, these findings support the proposed outcome
`NO_NEW_MEASUREMENT_PROTOCOL_JUSTIFIED`.

The user accepted that proposed outcome and the UNRESOLVED necessity classification on 2026-09-24
within the reviewed documentary scope. The accepted decision preserves a valid negative result
without asserting that liquidity is unnecessary or that no future alternative can ever be justified.
A future planning request would need to begin with a concrete research question and independent
documentary support for why a defined liquidity fact is required and how a materially different
method could measure it. That would be new evidence and new scope, not completion of B.4.
