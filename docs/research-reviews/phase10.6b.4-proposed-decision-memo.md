# Phase 10.6B.4 Proposed Measurement Remediation Decision Memo

Status: **Assistant proposal prepared 2026-09-24; accepted by the user on 2026-09-24 within the
reviewed documentary scope. Phase 10.6B.4 is closed as
`NO_NEW_MEASUREMENT_PROTOCOL_JUSTIFIED` with liquidity necessity `UNRESOLVED`.**

This memo preserves two distinct events: the assistant's proposed judgment and the user's subsequent
acceptance. The original proposal remains recorded in Sections 4 and 5; the acceptance is recorded in
Section 8 under the approved
[Phase 10.6B.4 checklist](../NeXusTrade-Phase-10.6B.4-Detailed-Checklist.md).

## 1. Evidence Reviewed

The proposal relies on:

- [the B.4 evidence and uncertainty ledger](./phase10.6b.4-evidence-uncertainty-ledger.md);
- [the B.4 liquidity-necessity and material-alternatives assessment](./phase10.6b.4-liquidity-necessity-material-alternatives-assessment.md);
- the exact documented V3/B.3 identity and historical provenance recorded there; and
- only the existing documents permitted by the B.4 checklist.

No operational archive was inspected. The production analyzer was not rerun. No tooling, provider,
database, collector, scheduler, strategy, PAPER, wallet, signing, submission, order, fill, position,
or execution surface was used.

## 2. Documentary Integrity

Proposed integrity finding: **VALID FOR DOCUMENTARY DECISION**

The permitted documents consistently record:

- the pinned V3 identity and B.3 fingerprint;
- final B.3 status `MEASUREMENT_CAPABILITY_NOT_CONFIRMED`;
- a sufficient/independent assessment population;
- liquidity availability of 60.344828% Discovery and 63.157895% Validation;
- failure of the unchanged 90% liquidity-availability gate in both partitions;
- passage of the recorded liquidity date-support, provenance, and freshness gates;
- passage of the two fixed momentum objectives within their exact V3 contract; and
- the historical source-lineage limitation and zero analysis-side-effect facts.

The permitted documents reviewed contain no documentary contradiction. This is a mechanical
consistency finding, not a new archive certification. The separate judgment that supplemental
archive inspection is unnecessary is recorded in the
[ledger](./phase10.6b.4-evidence-uncertainty-ledger.md) as a human judgment, not as a mechanical
consequence of consistency.

## 3. Observed Facts, Uncertainties, And Prohibited Claims

Observed:

- V3's direct anchor-time liquidity method did not meet the frozen availability gate.
- The result replicated across Discovery and Validation partitions.
- Population sufficiency and independence passed, so B.3 could classify the measurement capability.
- B.3 did not select a remedy.

Unresolved:

- a concrete future research question within the permitted documents reviewed;
- whether that question requires liquidity;
- the exact liquidity fact required by that question;
- the cause of V3 liquidity missingness;
- a materially different supported measurement method; and
- successor-specific protocol settings.

Not supported and therefore not claimed:

- that a named provider, endpoint, route, timing condition, payload, or market regime caused the
  missingness;
- that retries, fallbacks, longer collection, or a lower gate would remediate it;
- that liquidity is unnecessary;
- that V3 momentum availability proves strategy quality; or
- that current engineering hardening upgrades the historical research result.

## 4. Proposed Human Judgments

| Judgment                      | Assistant proposal                    | Basis                                                                                                                      |
| ----------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Evidence validity             | VALID                                 | Documentary identities and bounded B.3 findings are mutually consistent.                                                   |
| Liquidity necessity           | UNRESOLVED                            | No concrete future research question is defined in the permitted documents reviewed against which necessity can be judged. |
| Material alternative          | NONE ESTABLISHED                      | Existing documents name no evidenced alternative with defined semantics, provenance, timing, and gate relevance.           |
| Protocol completeness         | INCOMPLETE BEFORE DRAFTING            | Only historical V3 values and frozen protection floors are known; successor-defining fields remain unjustified.            |
| Review state                  | VALID_NEGATIVE_DECISION               | Evidence is valid, but the necessity/materiality/support gates do not justify a protocol.                                  |
| Conditional protocol draft    | NOT CREATED                           | B.4 prohibits drafting when necessity is unresolved or no supported materially different alternative exists.               |
| Proposed B.4 decision outcome | NO_NEW_MEASUREMENT_PROTOCOL_JUSTIFIED | Required by the checklist's mapping for UNRESOLVED necessity and a valid negative decision.                                |

These rows preserve the assistant's proposed judgments as originally presented. The user's later
acceptance is recorded separately in Section 8.

## 5. Proposed Decision

**Proposed outcome: `NO_NEW_MEASUREMENT_PROTOCOL_JUSTIFIED`**

Proposed rationale:

1. B.3 validly established a liquidity-availability deficiency under V3.
2. The permitted documents reviewed do not define a future research question that makes liquidity
   REQUIRED.
3. The existing evidence also does not justify NOT_REQUIRED, so necessity remains UNRESOLVED.
4. No materially different alternative is supported strongly enough to establish its protocol fields.
5. Lowering 90%, extending/repeating V3, changing counts/dates alone, or adding retry/fallback alone
   cannot satisfy materiality.
6. Creating a conditional draft now would require inventing operational values and evidence rather
   than documenting a defensible design.

This is a valid negative governance decision, not an evidence-integrity failure and not a claim that
future remediation is impossible.

## 6. Conditional Draft Decision

No conditional protocol draft accompanies this memo.

The assessment establishes protocol-field status before this decision. It finds that the permitted
documents reviewed do not establish the future research question, liquidity necessity, successor
semantics/method/source, provenance contract, timing, budgets, cohort design, or analysis plan. Only
the frozen 90% floor, other protection floors, zero-side-effect requirements, and downstream
default-denial boundary are ready to carry forward.

## 7. Consequence Of Acceptance

The user's acceptance closes Phase 10.6B.4 with
`NO_NEW_MEASUREMENT_PROTOCOL_JUSTIFIED` and liquidity necessity `UNRESOLVED`.

It permits only:

- retaining the ledger, assessment, and accepted decision memo;
- updating handoff/decision documentation to record the accepted negative result; and
- separately considering a future planning question if new documentary evidence supplies a concrete
  research hypothesis and an evidence-supported, materially different measurement concept.

Acceptance does not authorize:

- a protocol draft or automated protocol validation;
- archive inspection or analyzer rerun;
- provider evaluation, implementation, or calls;
- collector changes, named root, scheduler, or collection;
- Phase 10.6C or strategy promotion;
- PAPER sessions/trades; or
- wallet loading, signing, submission, orders, fills, positions, or any execution behavior.

## 8. Human Review Record

Current human-review status: **ACCEPTED AND CLOSED**

### Proposal event

- Date: 2026-09-24
- Actor: assistant
- Proposed evidence state: `VALID_NEGATIVE_DECISION`
- Proposed liquidity necessity: `UNRESOLVED`
- Proposed outcome: `NO_NEW_MEASUREMENT_PROTOCOL_JUSTIFIED`
- Conditional protocol draft: not created

### Acceptance event

- Date: 2026-09-24
- Actor: user/human reviewer
- Decision: accepted the proposed B.4 outcome
  `NO_NEW_MEASUREMENT_PROTOCOL_JUSTIFIED` within the reviewed documentary scope
- Liquidity necessity: accepted as `UNRESOLVED`
- Scope: the permitted existing documents reviewed by B.4 only
- Authority: documentation closeout only

This acceptance does not authorize archive inspection, analyzer rerun, tooling, automated protocol
validation, a protocol draft, provider access, collector changes, a named root, a scheduler,
collection, Phase 10.6C, strategy promotion, PAPER activity, wallets, signing, submission, orders,
fills, positions, or execution behavior.
