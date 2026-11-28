# CPMM Witnessed History and On-Chain Cutoff: Step 7 Slice 1 Implementation Contract

**Status**: Contract for review, before any implementation. It turns the design-only proposal in assessment §8.38.31 into an implementation-ready contract and resolves its open points against the APIs at `ca35ebf6b4c9744b5ee339979b529785e769def8`. It authorizes no implementation, request, operator command, credential load or live run. All qualification flags remain `false`; CPMM stays excluded from admission.

## 0. Scope

**In this slice** (isolated, unwired):

- `CpmmWitnessedHistory.ts`: a pure evidence analyzer and a bounded collector that dispatches through an **injected** `PaperRequestSession`.
- Synthetic, portable tests and fixtures.
- Exact runner-pin additions for the new files, in a separate commit.

**Not in this slice**: sealing or an evidence schema (slice 2); the CPMM reconciliation evaluator and any ledger cross-check (slice 3); wiring into `cpmm-pool-observation-run.ts`; profile, budget or limit changes; qualification or admission promotion; CLI, operator script or live use. No accepted component changes: `PaperRequestSession`, the fan-out, `CpmmPoolAccountAcquisition`, `CpmmResolutionAccountingLedger`, the adapter, the decoder, the activity check, the AMM enumerator and the evaluator stay as they are.

## 1. Session integration without changing `PaperRequestSession`

The session has one constructor-time observer, `onExchangeComplete`, and per-request `onDispatched`. Both are used exactly as `CpmmPoolAccountAcquisition` already uses them.

1. **Wiring.** `CpmmWitnessedHistoryCollector` exposes `readonly onExchangeComplete: (e: PaperRequestExchangeEvidence) => void`. The owner passes it at session construction, either alone or as one observer of the accepted `createExchangeObserverFanOut` (label `witnessed-history`, which matches the fan-out's `LABEL_PATTERN`). It never throws and never returns a value, because the fan-out counts either as an instrumentation failure.
2. **Ownership by sequence.** Before each dispatch the collector creates a slot: `{ kind, url, requestBody, jsonRpcId, maxResponseBytes }`. The dispatch passes `onDispatched(entry)`, which the session calls once, synchronously, when the request is counted; the collector stores a copy of that ledger entry. `onExchangeComplete` claims evidence **only** when `evidence.entry.seq === slot.dispatched.seq`. Then every dispatch field must equal the stored entry: `seq`, `lane`, `owner`, `purpose`, `requestedIdentity`, `jsonRpcId`, `dispatchedAtMs`. The evidence must also have `method === "POST"`, `url` and `requestBody` equal to the slot's, `maxResponseBytes` equal to the slot's, and a `body` that is `null` or a `Buffer` no longer than that cap. Purpose labels are compared but are never sufficient on their own; evidence from other owners, including same-purpose requests with another `seq`, is ignored.
3. **Timing.** The session invokes the observer in `dispatch`'s `finally`, before `dispatch()` returns, so the claimed copy exists when the collector's await resumes.
4. **Failure states** (terminal, never retried): `EVIDENCE_DUPLICATED` (a second claim for the same `seq`); `EVIDENCE_ENTRY_MISMATCH:<field>`; `EVIDENCE_BODY_MISMATCH`; `EVIDENCE_MISSING` (dispatched, but no claimed evidence when `dispatch()` returned).
5. **Ledger cross-check.** The collector records `session.getLedgerLength()` before its first dispatch and, at the end, requires every `session.getLedgerSince(start)` entry whose `seq` it recorded through `onDispatched` to equal its claimed copy (`LEDGER_EVIDENCE_MISMATCH` otherwise). Entries from other owners in that range are ignored.
6. **Copies.** Each claimed exchange is copied exactly once (frozen entry, `Buffer.from(body)`). No URL, header or body is logged or written in this slice.
7. **Clock.** Times come from `session.now()` through a guard that refuses non-safe-integer and regressing reads (`CLOCK_FAILURE`), as in the acquisition.

**Request identity fields** (all lane `SOLANA_RPC`, owner `FLOW`, ids from `session.nextJsonRpcId()`):

| Request           | `purpose`                        | `requestedIdentity` |
| ----------------- | -------------------------------- | ------------------- |
| Bootstrap page    | `CPMM_HISTORY_BOOTSTRAP_PAGE`    | pool address        |
| Cutoff slot       | `CPMM_HISTORY_CUTOFF_SLOT`       | pool address        |
| Cutoff block time | `CPMM_HISTORY_CUTOFF_BLOCK_TIME` | pool address        |
| Enumeration page  | `CPMM_HISTORY_PAGE`              | pool address        |

## 2. Operations, ceilings and deadlines

One collector instance serves one pool binding on one session. It offers two operations, each callable at most once, and **never chains them automatically** (`ALREADY_STARTED` otherwise).

**`bootstrap(options)`: optional, in this slice.**

- Exactly **one** `getSignaturesForAddress` head page (`limit: 20`, `commitment: "confirmed"`, no `before`, no `minContextSlot`).
- **Its own ceiling and deadline**: 1 request; one absolute deadline of at most 10,000 ms from the operation's start; request timeout `min(10,000 ms, remaining)`; at most 5,000 ms of settled cleanup after the deadline.
- Output: a `BOOTSTRAP_PAGE` anchor claim from the page's newest record, carrying that exchange's `seq`; or `BOOTSTRAP_EMPTY` (no records: no anchor, so no window can be covered); or a failure.
- It is **not** counted in the enumeration's five requests. Per collector instance the hard ceiling is **6** requests (1 + 5).
- Why separate: an anchor's block time must be strictly before the window start (rule R6), so the bootstrap precedes the observed window, typically by at least the window length. Putting it inside the enumeration's 30,000 ms deadline would make that impossible.

**`enumerate(options)`: cutoff plus witnessed enumeration.**

- Sequence: `getSlot` → `getBlockTime(S_c)` → at most **3** `getSignaturesForAddress` pages; at most **5** requests.
- One absolute deadline of at most 30,000 ms from the operation's start; request timeout `min(10,000 ms, remaining)`; at most 5,000 ms of settled cleanup after the deadline.
- The session's ≥ 2,500 ms `SOLANA_RPC` pacing applies, so 5 requests need at least 10 s.
- A `BOOTSTRAP_PAGE` anchor requires the bootstrap exchange to have completed before `enumerate` starts (`ANCHOR_SOURCE_NOT_SETTLED` otherwise).
- **Stop rules**:
  - Stop at `ANCHOR_WITNESSED`.
  - A short page without the anchor is `ANCHOR_NOT_FOUND`; reaching the page cap is `MAX_PAGES_EXHAUSTED`.
  - Any failure is terminal, with zero further requests, and a refusal before the first dispatch sends nothing.

**Neither operation** extends or changes the session's lifetime, ceilings or pacing. A session stop, a refusal or a 429 ends the operation (`SESSION_STOPPED` / `SESSION_REFUSED`). No retry, redirect, fallback, `until`, other lane, WebSocket or follow-up.

## 3. Exact request bodies

The key order is fixed. The analyzer rebuilds each body and compares the exact strings.

- Bootstrap page: `{"jsonrpc":"2.0","id":<id>,"method":"getSignaturesForAddress","params":["<pool>",{"limit":20,"commitment":"confirmed"}]}`
- Cutoff slot: `{"jsonrpc":"2.0","id":<id>,"method":"getSlot","params":[{"commitment":"confirmed"}]}`
- Cutoff block time: `{"jsonrpc":"2.0","id":<id>,"method":"getBlockTime","params":[<S_c>]}`
- Page 1: `{"jsonrpc":"2.0","id":<id>,"method":"getSignaturesForAddress","params":["<pool>",{"limit":20,"commitment":"confirmed","minContextSlot":<S_c>}]}`
- Page k > 1: as page 1 with `"before":"<oldest signature of page k-1>"` appended after `minContextSlot`.

**Implementation precondition**: confirm against a pinned Agave source that `getSignaturesForAddress` accepts `minContextSlot` and reports an unreached minimum context slot as JSON-RPC `-32016`, and that `getBlockTime` takes only the slot. This is a public specification read; until it is done, `-32016` is mapped only through the generic `RPC_ERROR(code)`.

## 4. Response analysis

- **Transport**: claimed evidence must have HTTP 200 and `bodyState: COMPLETE`. `PARTIAL_OVERFLOW` gives `RESPONSE_LIMIT_EXCEEDED`, `NOT_READ` gives `TRANSPORT_ERROR`, and any other status gives `HTTP_ERROR`.
- **Response caps**: 65,536 bytes per page (the activity check's reviewed cap) and 4,096 bytes for `getSlot` and `getBlockTime`.
- **Pages**: parsed by the activity check's `analyzePoolActivityResponse(body, requestId)`, **unchanged**: at most 20 records, canonical signatures, safe slots, nullable bounded `blockTime`, confirmed/finalized status, no duplicates, newest-first, bounded `err`. `RPC_ERROR` `-32016` gives `CONTEXT_SLOT_NOT_REACHED` (once the precondition in §3 is met).
- **`getSlot`**: fatal UTF-8; JSON-RPC 2.0; matching id; exactly `{jsonrpc, id, result}`; `result` a safe integer ≥ 0. An error envelope gives `CUTOFF_UNAVAILABLE` with its code.
- **`getBlockTime`**: as above, with `result` a safe integer in `[1, MAX_BLOCK_TIME_SEC]` (the decoder's exported bound), or `null`, which gives `MISSING_SOURCE_CUTOFF`.
- **Continuity** (enumeration pages):
  - Page k+1's `before` is page k's oldest signature.
  - Its newest slot is ≤ page k's oldest slot.
  - No signature repeats across pages (`DUPLICATE_ACROSS_PAGES`).
  - A page whose oldest record does not advance is `NON_PROGRESSING_PAGE`.
  - Ordering and boundary breaks are `ORDERING_VIOLATION` and `BOUNDARY_VIOLATION`.
- **Bytes**: no credential scanning happens in this slice because nothing is persisted. Slice 2 seals the claimed copies through the accepted credential sanitizer, and any redacted or withheld bytes then make the evidence `EVIDENCE_LIMITED`.

## 5. Provenance: verified here, verified upstream, or supplied

"Verified here" means checked by this slice from claimed exchange bytes. That establishes what the provider **said** in that exchange, never on-chain truth or index completeness.

| Fact                            | Status in this slice                      | Supporting evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pool address and candidate mint | **Supplied assertion**, verified upstream | `RaydiumCpmmPoolStateSuccess` from an `ACQUIRED` `CpmmPoolAccountAcquisition`, which checked the CPMM owner program, vault authorities, token programs, auth bump and mints (`verification.*` all literal `true`); sealed form: acquisition evidence `ACQUIRED_REPRODUCED`. This slice checks only that `ok` is `true`, every `verification` flag is literally `true`, and both addresses equal the binding. An AMM v4-shaped context is refused (`POOL_BINDING_REFUSED`). |
| Acquisition context slot        | **Supplied assertion**, verified upstream | The acquisition's response `context.slot` (`contextSlot`). Used only as a lower bound: `S_c` below it gives `CUTOFF_BEFORE_ACQUISITION`.                                                                                                                                                                                                                                                                                                                                   |
| Cutoff slot `S_c`               | **Verified here**                         | The claimed `getSlot` exchange (`seq`, exact body, id, strict result).                                                                                                                                                                                                                                                                                                                                                                                                     |
| Cutoff time `T_c`               | **Verified here**                         | The claimed `getBlockTime` exchange, whose single param equals `S_c`.                                                                                                                                                                                                                                                                                                                                                                                                      |
| Cutoff precedes history         | **Verified here**                         | Ledger entries: `getBlockTime` completed before page 1 was dispatched, and every page carries `minContextSlot: S_c`.                                                                                                                                                                                                                                                                                                                                                       |
| `minContextSlot` was honoured   | **Provider assumption**                   | Not verifiable: neither `getSignaturesForAddress` nor `getBlockTime` returns a context slot. Recorded in `providerAssumptions`.                                                                                                                                                                                                                                                                                                                                            |
| History records                 | **Verified here** as provider content     | Claimed page exchanges, strict parse, continuity. Completeness of the provider's address index is assumed, never established.                                                                                                                                                                                                                                                                                                                                              |
| Anchor from `BOOTSTRAP_PAGE`    | **Verified here**                         | This collector's own bootstrap exchange (its `seq` is recorded in the claim). Witnessing is verified here (§6, R4).                                                                                                                                                                                                                                                                                                                                                        |
| Anchor from `LEDGER_RECORD`     | **Supplied assertion**, verified upstream | A `CpmmSignatureAccountingRecord` with non-null `verifiedSlot`. The ledger sets that only for decoder-replayable, `VERIFIED` exchanges past every pre-decoding check, and that verification is not repeated here. This slice checks signature form and slot range, and that the witnessing page record has the same slot and, when `verifiedBlockTimeSec` is non-null, the same block time.                                                                                |
| Window `[start, end)`           | **Supplied assertion** (owner input)      | Shape only: safe integers, `start < end`.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Dispatch and completion times   | Local record                              | The session clock (guarded), not on-chain time.                                                                                                                                                                                                                                                                                                                                                                                                                            |

## 6. Timestamp, null and boundary rules (exact)

Notation: `t(r) = r.blockTime × 1000` when `r.blockTime` is non-null. Windows are on-chain milliseconds `[W.start, W.end)` (inclusive start, exclusive end), matching the ledger's `CpmmAccountingWindow`.

- **R1 Units.** `blockTime` is integer seconds, so `t` is an exact multiple of 1,000. Window bounds are safe integers with `W.start < W.end`.
- **R2 One time per slot.** All records with the same slot, including the anchor's record and, at `S_c`, the cutoff, must carry the same non-null `blockTime` or `null`. Two different non-null values for one slot give `TIME_ORDER_CONTRADICTION`.
- **R3 Monotone times.** Across records ordered by slot, non-null times never decrease as slot increases. Records with slot ≤ `S_c` must have `t ≤ T_c × 1000`, and records with slot > `S_c` must have `t ≥ T_c × 1000`. Any violation gives `TIME_ORDER_CONTRADICTION`, which blocks every window.
- **R4 Anchor.** The anchor is witnessed only when its signature appears in an enumeration page with the claimed slot and, if a block time was claimed, the same block time (`ANCHOR_IDENTITY_MISMATCH` otherwise). Its page record must have a non-null `blockTime` (`ANCHOR_TIME_UNKNOWN`: no window can be covered), and its slot must be strictly below `S_c` (`ANCHOR_NOT_BEFORE_CUTOFF`).
- **R5 Classification by slot**, never by intra-slot provider order:
  - `AFTER_CUTOFF`: slot > `S_c`.
  - `BETWEEN`: anchor slot < slot ≤ `S_c`.
  - `ANCHOR_SLOT`: slot equals the anchor's slot, any record other than the anchor.
  - `OLDER_THAN_ANCHOR`: slot below the anchor's slot (records after the anchor on its page). Retained, never in a window.
- **R6 Coverage of window W**: `t(anchor) < W.start` (**strict**) and `W.end ≤ T_c × 1000`. Otherwise `WINDOW_NOT_COVERED`.
  - By R2, every `ANCHOR_SLOT` record has `t = t(anchor) < W.start`, and every record at slot `S_c` has `t = T_c × 1000 ≥ W.end`. Both lie outside W whatever their intra-slot order, so same-slot ordering is never needed.
  - The end rule is the same as the ledger's `WINDOW_BEYOND_CUTOFF` check.
- **R7 Membership.** A `BETWEEN` record with non-null `t` is in W if and only if `W.start ≤ t < W.end`.
- **R8 Null block time.** For a `BETWEEN` record with `blockTime: null` at slot `s`:
  - Let `L` be the largest `t` among non-null records with slot < `s` (the anchor included), and `U` the smallest `t` among non-null records with slot > `s`, with `T_c × 1000` as the bound when `s ≤ S_c`. A non-null record at the same slot pins `t` exactly (R2).
  - The record is outside W if `U < W.start` or `L ≥ W.end`.
  - Otherwise W is `AMBIGUOUS_TIMESTAMP`, which blocks; the record is never guessed into or out of W.
- **R9 Window result.** `COVERED` with the exact list of member signatures, or one of `WINDOW_NOT_COVERED`, `AMBIGUOUS_TIMESTAMP`, `TIME_ORDER_CONTRADICTION` or `EVIDENCE_NOT_USABLE` (the operation did not end with `ANCHOR_WITNESSED` and `CUTOFF_BOUND`). It reconciles nothing and qualifies nothing.

## 7. Outcomes

- **Operation**: `ANCHOR_WITNESSED`, `ANCHOR_NOT_FOUND`, `MAX_PAGES_EXHAUSTED`, `MAX_RECORDS_EXCEEDED`, `NON_PROGRESSING_PAGE`, `ORDERING_VIOLATION`, `BOUNDARY_VIOLATION`, `DUPLICATE_ACROSS_PAGES`, `MALFORMED_PAGE(reason)`, `BOOTSTRAP_EMPTY`.
- **Cutoff**: `CUTOFF_BOUND`, `MISSING_SOURCE_CUTOFF`, `CUTOFF_UNAVAILABLE(code)`, `INVALID_SOURCE_CUTOFF`, `CUTOFF_BEFORE_ACQUISITION`.
- **Transport and lifecycle**: `RPC_ERROR(code)`, `CONTEXT_SLOT_NOT_REACHED`, `HTTP_ERROR`, `RESPONSE_LIMIT_EXCEEDED`, `TRANSPORT_ERROR`, `DEADLINE_EXPIRED`, `OPERATOR_CANCELLED`, `CLOCK_FAILURE`, `CLEANUP_UNSETTLED`, `SESSION_STOPPED`, `SESSION_REFUSED`.
- **Evidence**: `EVIDENCE_MISSING`, `EVIDENCE_DUPLICATED`, `EVIDENCE_ENTRY_MISMATCH:<field>`, `EVIDENCE_BODY_MISMATCH`, `LEDGER_EVIDENCE_MISMATCH`.
- **Binding and anchor**: `POOL_BINDING_REFUSED`, `ANCHOR_IDENTITY_MISMATCH`, `ANCHOR_TIME_UNKNOWN`, `ANCHOR_NOT_BEFORE_CUTOFF`, `ANCHOR_SOURCE_NOT_SETTLED`.
- **Usage**: `ALREADY_STARTED`, `OPTIONS_INVALID`.

Only `ANCHOR_WITNESSED` with `CUTOFF_BOUND` and no evidence or binding failure yields usable evidence. Everything else fails closed with no retry.

**Results** carry:

- `outcome`, `cutoffOutcome` and `requestCount`;
- the claimed exchanges (frozen copies, with `seq`);
- `cutoff` (`{ slot, blockTimeSec, getSlotSeq, getBlockTimeSeq }`);
- `anchor` (the claim and its witnessing page and index);
- `records` (with their R5 class);
- `providerAssumptions`: the evaluator's `DEFAULT_PROVIDER_INDEX_ASSUMPTIONS` verbatim, plus the CPMM additions from §8.38.31 §5;
- `unresolvedUncertainties`: `DEFAULT_UNRESOLVED_UNCERTAINTIES` verbatim;
- the literal flags `isCryptographicCompletenessEstablished`, `isProductionCompletenessEstablished`, `notificationCompletenessEstablished`, `quietWindowEstablished` and `qualificationEligible`, all `false`.

**Conversions**:

- `toCpmmAccountingCutoff(e)` gives `{ slot: S_c, blockTimeMs: T_c × 1000, provenance: "ON_CHAIN_BLOCK_TIME" }`, the ledger's unchanged input type.
- `toSourceCutoffEvidence(e)` gives the evaluator's `getBlockTime` shape, with `responseField: "result"`, the parsed payload and `requestContext: { slot: S_c }`.

## 8. Portable fixtures

- **Every CI input is synthetic and committed.** A new `backend/src/candidate-scanner/fixtures/SyntheticCpmmHistoryFixture.ts` provides:
  - deterministic canonical 64-byte signatures from seeds (`encodeBase58`);
  - a synthetic CPMM binding and a minimal `RaydiumCpmmPoolStateSuccess`, following the decoder tests' `adaptedPool` pattern;
  - JSON-RPC body builders for pages, `getSlot` and `getBlockTime`;
  - a scripted `fetchFn` keyed by the **exact** request body, where an unknown body fails the test;
  - a virtual clock and timers for the session.
- **Test placement.** Tests live in `backend/src/candidate-scanner/`, so the existing measurement-analysis selection runs them in isolated verification with no config change. They inject the session's `fetchFn` and never touch `globalThis.fetch`, the network, environment files or `data/`.
- **Historical captures are optional.** At most one read-only local regression: replaying `cpmm-activity-check-02`'s sealed page through the page rules, guarded by `it.skipIf(!existsSync(...))`. Because `data/` is git-ignored it is always skipped in CI, and it is reported as skipped, never as a pass. No test depends on it.

## 9. Planned tests (synthetic; injected session, fetch, clock and timers)

**Seq ownership and evidence**

- **C01**: a same-purpose exchange from another owner, with a different `seq`, is ignored.
- **C02**: a forged exchange with a matching `seq` but a different `purpose`, `jsonRpcId`, URL or body gives the corresponding mismatch failure.
- **C03**: a duplicate claim gives `EVIDENCE_DUPLICATED`.
- **C04**: dispatched without evidence gives `EVIDENCE_MISSING`.
- **C05**: the ledger cross-check passes, and an altered ledger copy gives `LEDGER_EVIDENCE_MISMATCH`.
- **C06**: wiring through `createExchangeObserverFanOut` next to other observers works, and the collector never returns or throws.

**Operations and limits**

- **C07**: bootstrap sends exactly one request with the exact body; an empty page gives `BOOTSTRAP_EMPTY`.
- **C08**: bootstrap and enumerate are never chained, a second call is `ALREADY_STARTED`, and the instance never exceeds 6 requests.
- **C09**: `enumerate` with a `BOOTSTRAP_PAGE` anchor before the bootstrap settles gives `ANCHOR_SOURCE_NOT_SETTLED` and sends nothing.
- **C10**: the happy path has exact bodies (cutoff first, `minContextSlot`, `before` cursors), at most 5 requests and ≥ 2,500 ms spacing.
- **C11**: the stop rules: anchor on page 1, a short page, and the page cap.
- **C12**: deadlines for each operation separately (the bootstrap's 10 s and the enumeration's 30 s), cancellation, a throwing or regressing clock, a hung fetch (`CLEANUP_UNSETTLED`), a session stop and a 429. Each is followed by zero further requests and no leftover timers or listeners.

**Parsing and cutoff**

- **C13**: page rules come from the unchanged activity analyzer; malformed records are refused.
- **C14**: `getSlot` and `getBlockTime` strictness, a null block time (`MISSING_SOURCE_CUTOFF`), a forged slot param (`INVALID_SOURCE_CUTOFF`), a page dispatched before the cutoff completed, and `CUTOFF_BEFORE_ACQUISITION`.
- **C15**: overflow (`RESPONSE_LIMIT_EXCEEDED`), `NOT_READ` and non-200 responses.

**Rules R2–R9** (each with exact-boundary cases)

- **C16**: same-slot conflicting times give `TIME_ORDER_CONTRADICTION`; non-monotone times; times inconsistent with the cutoff.
- **C17**: anchor identity, unknown time and not-before-cutoff.
- **C18**: classification by slot: `ANCHOR_SLOT` records listed before or after the anchor are both outside every window, and slot-`S_c` records are outside W.
- **C19**: coverage boundaries: `t(anchor) = W.start` is not covered and `t(anchor) = W.start − 1000` is; `W.end = T_c × 1000` is covered and `W.end = T_c × 1000 + 1` is not.
- **C20**: membership at `W.start` (in) and at `W.end` (out).
- **C21**: null block times: bracketed outside W, bracketed straddling W (`AMBIGUOUS_TIMESTAMP`), and pinned by a same-slot record.

**Binding, conversions and flags**

- **C22**: binding refusals: not `ok`, a verification flag not literally `true`, mismatched addresses, and an AMM-shaped context.
- **C23**: the conversions are accepted by the **unchanged** ledger `summarize` for a covered window, and refused there with `WINDOW_BEYOND_CUTOFF` for an uncovered one; the evaluator's documented `getBlockTime` rules hold.
- **C24**: the non-certification flags are literal `false`, and the default assumptions and uncertainties are included verbatim.
- **C25**: importing is inert, there is no default fetch, and a static import check finds no `RaydiumAmmV4*` import.
- **C26** (optional, local only): the `cpmm-activity-check-02` page replay, skipped when absent.

Validation follows established practice: targeted mutations from an exit-0 baseline, TypeScript, ESLint and Prettier checks, and bounded runs of the affected suites and of full isolated verification.

## 10. Files and runner-pin impact

| File                                                                    | Change                                                                                                                  |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `backend/src/candidate-scanner/CpmmWitnessedHistory.ts`                 | New: analyzer, collector, conversions                                                                                   |
| `backend/src/candidate-scanner/CpmmWitnessedHistory.test.ts`            | New: C01–C26                                                                                                            |
| `backend/src/candidate-scanner/fixtures/SyntheticCpmmHistoryFixture.ts` | New: portable synthetic fixtures                                                                                        |
| `backend/src/scripts/paper-pilot-handoff.ts` and `.test.ts`             | Separate commit: the three exact paths added to `ALLOWED_ADDITIONS_SINCE_REVIEWED_RUNNER`, with near-miss refusal tests |
| Assessment and runbook                                                  | Short status pointers                                                                                                   |

The pin accepts **additions** by exact path only; there is no exact-blob mechanism for added files today. The pin commit therefore names exactly these three paths, refuses near-miss names, and preserves `REVIEWED_RUNNER_COMMIT` and every accepted blob entry. No other file changes.

## 11. Decisions requested from review

1. Accept the bootstrap inside this slice as a separately invoked, separately bounded operation (1 request, 10 s), outside the enumeration's 5-request and 30 s bounds, with a hard ceiling of 6 per instance. The alternative is to defer it, which leaves only `LEDGER_RECORD` anchors and therefore no quiet-window coverage.
2. Accept rule R8's bracketing (the conservative alternative: any null block time between the anchor and the cutoff blocks every window).
3. Accept owner `FLOW` and the four purpose labels above.
