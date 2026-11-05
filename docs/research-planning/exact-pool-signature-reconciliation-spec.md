# NeXusTrade — Exact-Pool Signature-History Reconciliation Specification

**Document ID**: `NXT-SPEC-SIG-RECONCILIATION-V2`  
**Location**: `docs/research-planning/exact-pool-signature-reconciliation-spec.md`  
**Status**: **OFFLINE DESIGN SPECIFICATION (READ-ONLY / NO CODE MODIFICATIONS AUTHORIZED)**  
**Verification Date**: November 2026  
**Execution Authority**: **READ-ONLY DOCUMENTATION REPOSITORY. PRODUCTION SOURCE COMPLETENESS REMAINS UNPROVEN. ZERO RUNTIME MODIFICATIONS AUTHORIZED.**

---

## 1. Executive Summary & Purpose

This design specification defines the architecture, cursor mechanics, failure modes, and budget feasibility for **Exact-Pool Signature-History Reconciliation** using Solana JSON-RPC `getSignaturesForAddress`.

### Core Architectural Separation & Verdict

This specification establishes a strict technical distinction between three separate capabilities:

1. **Recovery of Specific Missed Transactions**: **FEASIBLE**. When WebSocket notifications are dropped, targeted signature queries can identify and backfill specific missing transactions.
2. **Conditional History Enumeration Between Witnessed Boundaries**: **FEASIBLE**. If two on-chain boundaries $S_{\text{start}}$ and $S_{\text{end}}$ are positively connected by verified signatures, intervening transactions can be enumerated and resolved.
3. **Certification of a Complete Rolling Time Window**: **UNSUPPORTED / UNPROVEN**. Indexer replication lag, multi-node RPC inconsistency, unverified upper time boundaries, and nullable/coarse timestamps prevent certifying that _every_ transaction in a sliding $[T - 60\text{s}, T]$ window was observed.

> [!IMPORTANT]
> **Defensible Architectural Conclusion: `RECOVERY_ONLY`**:  
> Exact-pool signature reconciliation is specified strictly as an **offline recovery and backfill mechanism** between witnessed boundaries. It does **not** certify production source completeness. The production completeness gate remains firmly closed: `isProductionCompletenessEstablished = false`.

---

## 2. Reconciliation Anchor & Verified-History Cursor Model

### 2.1 The Critical Anchor Pitfall: The Missed-B Counter-Example

A foundational defect in naive reconciliation protocols is treating the most recently received WebSocket notification ($S_{\text{latestWS}}$) as proof that all prior history was captured.

```mermaid
sequenceDiagram
    participant Chain as Solana On-Chain Pool
    participant WSS as WebSocket logsSubscribe
    participant Coord as Subscription Coordinator
    participant Recon as Signature Reconciler

    Note over Chain: T0: Baseline signature A established
    Note over Coord: S_verified = A (buys=0; cut established)
    Note over Chain: T1: Transaction B confirmed (DROPPED BY SOCKET)
    Chain--xCoord: [Frame Dropped / Disconnect Gap]
    Note over Chain: T2: Transaction C confirmed
    Chain->>Coord: Notification C received (S_latestWS = C)

    rect rgb(255, 230, 230)
    Note over Recon: FLAWED PROTOCOL:<br/>Queries until: C (or anchors to C).<br/>Transaction B is skipped and permanently concealed!
    end

    rect rgb(230, 255, 230)
    Note over Recon: CORRECT PROTOCOL:<br/>Freezes target C from history batch.<br/>Queries until: S_verified (A).<br/>Retrieves [C, B], discovers B, fetches both,<br/>then advances S_verified to C.
    end
```

#### Detailed Failure Mechanics:

1. Candidate pool $P$ experiences three confirmed transactions in chronological order: $A \rightarrow B \rightarrow C$.
2. Transaction $A$ is the established, independently verified history boundary ($S_{\text{verified}} = A$).
3. Transaction $B$ is confirmed on-chain at slot $S_B$. The WebSocket notification for $B$ is dropped due to socket buffer overflow, TCP reset, or RPC publisher lag.
4. Transaction $C$ is confirmed on-chain at slot $S_C$. The WebSocket notification for $C$ is received by the coordinator ($S_{\text{latestWS}} = C$).
5. **The Pitfall**: If reconciliation anchors to $C$ as "already observed" and only queries for signatures _after_ $C$ (or queries backward stopping at $C$), **missed transaction $B$ is completely concealed**. The flow tracker will evaluate absorption ratios with missing volume, violating fail-closed safety.

---

### 2.2 Dual-Cursor Architecture & Official RPC Contract

To ensure that dropped notifications do not conceal history, the protocol maintains two distinct, non-fungible cursors:

1. **$S_{\text{latestWS}}$ (Unverified Observation Hint)**:
   - The newest signature received via `logsSubscribe`.
   - Represents an unverified forward notification hint.
   - **Never** advances trade coverage, establishes a verified boundary, or certifies history completeness.
2. **$S_{\text{verified}}$ (Verified-History Watermark)**:
   - The newest confirmed transaction signature up to which _every_ preceding transaction has been enumerated via RPC, fetched via `getTransaction`, and successfully decoded.
   - Initialized at candidate admission baseline ($S_0$) and advanced strictly by the reconciler upon positive boundary verification.

#### Solana JSON-RPC Contract: `getSignaturesForAddress`

Per the official Solana specification ([Solana `getSignaturesForAddress` Documentation](https://solana.com/docs/rpc/http/getsignaturesforaddress)):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "getSignaturesForAddress",
  "params": [
    "<candidatePoolId>",
    {
      "limit": 20,
      "before": "<signature>",
      "until": "<signature>",
      "commitment": "confirmed"
    }
  ]
}
```

- **Sort Order**: Results are returned ordered from **newest to oldest**.
- **Returned Fields per Record**:
  - `signature`: string (base58 transaction signature).
  - `slot`: number (slot in which transaction was processed).
  - `err`: TransactionError | null.
  - `memo`: string | null.
  - `blockTime`: number | null (estimated production Unix timestamp in seconds; nullable).
  - `confirmationStatus`: "processed" | "confirmed" | "finalized".
  - _(Note: There is NO transaction index field returned in `getSignaturesForAddress`)_.
- **`until` Parameter Mechanics**: Search stops backward in time when it encounters this signature (exclusive). If found, the search stops and returns results up to (but not including) this signature.
- **`before` Parameter Mechanics**: Search starts backward in time _before_ this signature (exclusive). Used for backward pagination.

---

### 2.3 Positive Boundary Proof vs. Short Pages

> [!CAUTION]
> **A Short Page or Empty Response Does NOT Prove Boundary Termination**:
>
> - The `until` parameter excludes the boundary signature from the returned records.
> - The JSON-RPC response format supplies **no explicit boolean flag** indicating whether the search stopped because `until` was encountered, or because available ledger history was exhausted/pruned, or because the queried node had indexed no records.
> - Therefore, receiving fewer than `limit` records (or an empty array `[]`) does **not** independently prove that $S_{\text{verified}}$ was reached or that the chain is complete.

#### Rule for Positive Boundary Evidence:

To establish positive boundary evidence connecting a new batch to an existing anchor $S_{\text{verified}}$:

1. **Explicit Ingestion or Linkage**: The pagination traversal must either:
   - Paginate backward using `before` without an exclusionary `until` until a page is returned that **actually contains the known anchor $S_{\text{verified}}$**, OR
   - Query a contiguous signature window where the oldest returned signature's parent block/slot linkage is independently confirmed.
2. **Fail-Closed on Unreached Boundary**: If pagination terminates without explicitly returning or confirming the known anchor (e.g. ledger pruned, timeout, or boundary missing), the reconciler **must return `UNKNOWN`** and record `UNRESOLVABLE_HISTORY_GAP`. The boundary is unestablished, and $S_{\text{verified}}$ **must not advance**.

---

## 3. Bounded Protocol Specification

### 3.1 Lifecycle States & Epoch Cancellation

In accordance with [`RaydiumCandidateSubscriptionCoordinator.ts`](file:///u:/Projects/TopG/backend/src/candidate-scanner/RaydiumCandidateSubscriptionCoordinator.ts#L65-L142):

- **Lifecycle State Machine**: `DISCONNECTED` $\rightarrow$ `CONNECTING` $\rightarrow$ `SUBSCRIBING` $\rightarrow$ `SUBSCRIBED` $\rightarrow$ `CLOSED`.
- **Connection Epoch**: The coordinator increments `connectionEpoch` inside `attachTransport(transport: ISolanaWebSocketTransport)` when attaching a new or replacement transport, **not** immediately on disconnect.
- **Disconnect Tracking**: When a transport closes or encounters an error, the coordinator enters `DISCONNECTED`, records `disconnectedAtMs`, and logs a `SUBSCRIPTION_DISCONNECT` gap.
- **Job Cancellation Invariant**: Any in-flight reconciliation job is cancelled and its results discarded if:
  1. The coordinator status is no longer `SUBSCRIBED` (e.g. `DISCONNECTED`, `CONNECTING`, or `CLOSED`), OR
  2. The coordinator's active `connectionEpoch` does not exactly match the epoch in which the reconciliation request was dispatched.

---

### 3.2 Baseline Establishment Semantics ($S_0$)

1. **Initial History Cut**:
   - At candidate admission, the reconciler executes:
     `getSignaturesForAddress(candidatePoolId, { limit: 1, commitment: "confirmed" })`.
   - The returned signature (if present) establishes the baseline history cut $S_0 = S_{\text{verified}}$.
2. **Honest Baseline Accounting**:
   - Establishing $S_0$ does **not** retrieve or decode transaction $S_0$, and does **not** count it as a trade (e.g. `buys = 0`).
   - Establishing $S_0$ does **not** claim observation from admission tick $T_{\text{admit}}$. Any transactions occurring between admission and baseline lookup are unobserved unless explicitly backfilled. The start boundary is strictly the confirmed slot/blockTime of $S_0$, and pre-$S_0$ history is marked `NOT_OBSERVED`.
3. **Empty Initial Response**:
   - If the baseline lookup returns an empty array `[]`, the baseline is marked **`BASELINE_UNESTABLISHED`**.
   - An empty response does not prove the pool was newly initialized or that history is complete. No synthetic "genesis anchor" may be invented. Observation cannot begin until a positive baseline is established.

---

### 3.3 Traversal, Freezing Targets & Pagination

1. **Target Freezing**:
   - When a reconciliation check runs, the target signature $S_{\text{target}}$ is **frozen from the newest signature returned in the RPC history batch**.
   - $S_{\text{latestWS}}$ is only an unverified hint; it never becomes a reconciliation target until RPC actually returns it.
2. **Pagination with Batch Size $L$**:
   - Batch size $L = 20$ is an **explicit batching parameter**, not a completeness guarantee.
   - Initial query: `getSignaturesForAddress(candidatePoolId, { limit: L, commitment: "confirmed" })`.
   - If the known anchor $S_{\text{verified}}$ is not present in the returned array, the reconciler paginates backward:
     `getSignaturesForAddress(candidatePoolId, { limit: L, before: S_oldestInPage, commitment: "confirmed" })`.
   - Traversal continues until a page is returned containing $S_{\text{verified}}$, providing positive proof of boundary continuity.
3. **Concurrent Notifications During Traversal**:
   - While backward pagination is in progress, new live WebSocket notifications may arrive.
   - The coordinator queues incoming notifications in an unverified buffer without interrupting the backward pagination job.
   - Once the batch resolving back to $S_{\text{verified}}$ completes, $S_{\text{verified}}$ advances to the frozen $S_{\text{target}}$. The next cycle then queries backward from the newly frozen target, naturally capturing the buffered arrivals.

---

### 3.4 Data Models & Separation of Concerns

#### 1. RPC Data Realities (No Transaction Indexes, Nullable blockTime):

- `getSignaturesForAddress` returns only `{ err, memo, signature, slot, blockTime, confirmationStatus }`.
- It does **not** return transaction indexes within a block.
- `blockTime` is nullable and represents coarse integer seconds. Multiple transactions in the same block/slot share identical slot and blockTime values.
- **Ordering Rule**: Transactions within the same slot are processed in the order returned by RPC (matching validator ledger execution order). No unbudgeted `getBlock` calls may be made to extract transaction indexes.

#### 2. Distinct Deduplication Layers:

- **Transaction Deduplication**: The reconciler maintains a set of processed transaction signatures (`txSignature`) to prevent fetching the same Solana transaction twice.
- **Swap Deduplication**: [`RollingTradeFlowTracker`](file:///u:/Projects/TopG/backend/src/candidate-scanner/RollingTradeFlowTracker.ts#L46-L60) maintains its own canonical swap identity key:
  $$\text{eventId} = \$\{ \text{signature} \} : \$\{ \text{outerInstructionIndex} \} : \$\{ \text{swapIndex} \}$$
  This accounts for multiple swaps within a single transaction without double-counting.

#### 3. Actual Integration Methods:

- Transactions are fetched via `getTransaction(signature)`.
- Valid swaps are ingested using the actual accepted method:
  [`RollingTradeFlowTracker.ingestTrade(event: TradeEvent)`](file:///u:/Projects/TopG/backend/src/candidate-scanner/RollingTradeFlowTracker.ts#L564).
  _(Note: `recordTrade()` does not exist)_.

#### 4. Immutable Stream Gaps:

- Backfill success does **not** automatically erase recorded `StreamGap` records in the tracker.
- In the accepted architecture, collection gaps represent permanent historical telemetry; backfilling transactions recovers trade flow data, but does not retroactively claim uninterrupted WebSocket liveness.

#### 5. Explicit Retry Budget Policy:

- Any retry of a failed `getTransaction` or `getSignaturesForAddress` query must explicitly specify `purpose: "RETRY"`.
- Retries consume global requests, respect $\ge 2,500\text{ ms}$ spacing, and are capped at $\le 1$ attempt. If denied by the budget manager, the transaction is marked unresolved immediately.

---

## 4. Honest Coverage Boundary & Environmental Constraints

### 4.1 What Evidence Establishes a Completed Observation Interval?

To declare an observation interval $[T_{\text{start}}, T_{\text{end}}]$ complete, the system must possess verifiable positive evidence:

1. **Lower Boundary**: Anchored to a confirmed transaction signature $S_{\text{start}}$ with verified `blockTime` $\le T_{\text{start}}$.
2. **Upper Boundary**: Anchored to a confirmed transaction signature $S_{\text{end}}$ with verified `blockTime` $\ge T_{\text{end}}$.
3. **Contiguous Chain**: Positive boundary proof connecting $S_{\text{end}}$ to $S_{\text{start}}$ via explicit signature pagination.
4. **Complete Resolution**: Every transaction in the chain fetched via `getTransaction` and decoded via `ingestTrade()`.

### 4.2 Prohibited Coverage Proxies & RPC Realities

> [!CAUTION]
> **Prohibited Proxies for Coverage**:
>
> 1. **Empty History Response (`[]`)**: Does not prove the absence of transactions; multi-node replication lag can cause a node to return empty results for newly confirmed slots.
> 2. **Short Page ($< L$)**: Does not prove boundary termination; ledger pruning or query constraints produce short pages without reaching the anchor.
> 3. **Host HTTP Response Time**: Receipt timestamp at the host does not certify that the RPC node has indexed transactions up to that host timestamp.
> 4. **`getSlot` Call**: Reports the node's current slot height ([Solana `getSlot`](https://solana.com/docs/rpc/http/getslot)), but does **not** certify that secondary indexers servicing `getSignaturesForAddress` have indexed all transactions through that slot.
> 5. **Open WebSocket**: Socket liveness does not prove zero dropped frames.

### 4.3 Environmental Constraints

- **Commitment Parity**: All RPC queries (`getSignaturesForAddress`, `getTransaction`, `getAccountInfo`) and WebSocket streams (`logsSubscribe`) must strictly use `commitment: "confirmed"`. Mixing `processed` and `confirmed` produces unresolvable fork contradictions.
- **Multi-Node Cluster Replication Lag**: Load-balanced RPC endpoints route requests across heterogeneous nodes. A WebSocket notification emitted by Node 1 can be received at the host while Node 2 (servicing HTTP RPC) lags by 1–3 slots. Reconciliation queries dispatched immediately upon WebSocket receipt risk reading stale state.
- **Nullable blockTime**: When `blockTime` is null or identical across same-slot transactions, wall-clock duration cannot be mathematically proven.
- **Unproven Upper Boundary Verdict**: Because node progress does not prove complete pool history indexing through host wall-clock time, **the upper time boundary remains unproven**. The system must return **`UNKNOWN`** and keep `isProductionCompletenessEstablished = false`.

---

## 5. Feasibility Recalculation Under Enforced Controls

### 5.1 Enforced Budget Controls

The protocol must operate strictly within active constraints in [`GlobalResourceBudgetManager.ts`](file:///u:/Projects/TopG/backend/src/research/prospective/GlobalResourceBudgetManager.ts#L66-L129):

1. **Provider Pacing**: $\ge 2,500\text{ ms}$ minimum spacing between dispatches to the same provider (`minProviderSpacingMs = 2500`).
2. **Pacing Dispatch Formula**: For $N$ serial dispatches to the same provider, the minimum elapsed time between the 1st dispatch and the $N$-th dispatch is:
   $$\Delta T_{\text{pacing}} \ge (N - 1) \times 2,500\text{ ms} = (N - 1) \times 2.5\text{ seconds}$$
   Total elapsed wall-clock time is:
   $$T_{\text{total}} = T_{\text{initial\_wait}} + \Delta T_{\text{pacing}} + \sum_{i=1}^{N} T_{\text{latency}, i}$$
3. **Session Ceilings**: Hard ceiling of **25–50 total requests** in pilot configurations (default `maxTotalRequests = 120`).
4. **Enrichment Limit**: `maxEnrichmentAttempts = 10`.
   - **Critical Constraint**: In [`RaydiumAmmV4TransactionSourceAdapter.ts`](file:///u:/Projects/TopG/backend/src/candidate-scanner/RaydiumAmmV4TransactionSourceAdapter.ts#L380), the default purpose is `CANDIDATE_ENRICHMENT`. Under this default, **at most 10 requests total** can be made across the entire session before the manager rejects calls with `MAX_ENRICHMENT_ATTEMPTS_REACHED`.
5. **Reserved Forward Capacity**: `minReservedForwardRequests = 4` (stops non-quote requests when within 4 calls of `maxTotalRequests`).
6. **Global Scope**: All external calls (Solana RPC, RugCheck, DexScreener) count toward `totalRequests`.

---

### 5.2 Scenario Workload Recalculation

We evaluate demand across three assumed candidate tracking profiles over a 5-minute ($300\text{ s}$) observation window, assuming prior discovery/screening has already consumed **15 global requests** (10 DexScreener polls, 3 RugCheck reports, 2 RPC mint checks):

$$\text{Global Total} = N_{\text{prior}} (15) + N_{\text{baseline\_RPC}} + N_{\text{history\_RPC}} + N_{\text{tx\_retrieval\_RPC}} + N_{\text{boundary\_RPC}} + N_{\text{external}}$$

#### Scenario 1: Quiet Candidate Pool (0 Transactions during 5m window)

- Proposed Purpose: History queries proposed as `FORWARD_OBSERVATION`.
- $N_{\text{baseline\_RPC}} = 1$ `getSignaturesForAddress`.
- $N_{\text{history\_RPC}} = 5$ periodic checks (1 every 60s, each returning positive boundary proof or `UNKNOWN`).
- $N_{\text{tx\_retrieval\_RPC}} = 0$.
- $N_{\text{boundary\_RPC}} = 0$.
- **Solana RPC Subtotal**: **6 calls**.
- **Global Session Total**: $15\text{ prior} + 6\text{ RPC} = \mathbf{21\text{ requests}}$ (fits within 50-request ceiling).
- **Pacing Feasibility**: 6 dispatches require at least $(6 - 1) \times 2.5\text{ s} = \mathbf{12.5\text{ seconds}}$ of pacing spread over 300s. **Feasible**.
- **Coverage Outcome**: Zero trades observed; upper boundary uncertified $\rightarrow$ **`UNKNOWN`** (`isProductionCompletenessEstablished = false`).

#### Scenario 2: Moderate Activity Pool (3 Transactions over 5m window)

- Proposed Purpose:
  - History queries: `FORWARD_OBSERVATION`.
  - Transaction retrievals: `CANDIDATE_ENRICHMENT` (3 attempts, within the 10-attempt cap).
- $N_{\text{baseline\_RPC}} = 1$.
- $N_{\text{history\_RPC}} = 5$.
- $N_{\text{tx\_retrieval\_RPC}} = 3$ `getTransaction`.
- $N_{\text{boundary\_RPC}} = 0$.
- **Solana RPC Subtotal**: **9 calls**.
- **Global Session Total**: $15\text{ prior} + 9\text{ RPC} = \mathbf{24\text{ requests}}$ (within 50 ceiling; enrichment requests = 3, within 10 cap).
- **Pacing Feasibility**: 9 dispatches require $(9 - 1) \times 2.5\text{ s} = \mathbf{20.0\text{ seconds}}$ pacing spread over 300s. **Feasible**.
- **Coverage Outcome**: 3 trades recovered and ingested; window uncertified $\rightarrow$ **`RECOVERY_ONLY`** (`isProductionCompletenessEstablished = false`).

#### Scenario 3: Volatile Retest Surge (15 Transactions in a 60-Second Surge)

- **Immediate Blocker under Defaults**:
  - If transaction retrievals default to `CANDIDATE_ENRICHMENT`, the 11th transaction is **blocked immediately** by `MAX_ENRICHMENT_ATTEMPTS_REACHED` ($10 \text{ cap}$).
  - Declaring a 15-transaction retrieval feasible under default adapter configuration is **factually false**.
- **Analysis Even If Configured as `FORWARD_OBSERVATION`**:
  - $N_{\text{history\_RPC}} = 2$ signature queries.
  - $N_{\text{tx\_retrieval\_RPC}} = 15$ `getTransaction` calls.
  - Solana RPC Subtotal = 17 calls.
  - Global Total = $15\text{ prior} + 17\text{ RPC} = \mathbf{32\text{ requests}}$.
  - Pacing Requirement: 17 dispatches require at least $(17 - 1) \times 2.5\text{ s} = \mathbf{40.0\text{ seconds}}$ of serialized pacing intervals alone!
  - Adding response latency ($\sim 200\text{ ms} \times 17 = 3.4\text{ s}$), total dispatch time is $\mathbf{\approx 43.4\text{ seconds}}$.
  - Consumes 32 of 50 requests. If another candidate surges or if discovery continues, `minReservedForwardRequests = 4` blocks non-quote requests at 46 calls.
- **Feasibility Conclusion**: **Infeasible under default `CANDIDATE_ENRICHMENT`**; marginal/severely delayed under `FORWARD_OBSERVATION`.

---

## 6. Protocol Fixture Scenarios

### Fixture 1: The Missed-B Resolution ($A \rightarrow B \rightarrow C$)

- Context: Baseline cut established at $A$. WebSocket drops notification for $B$, but receives $C$.

| Step  | On-Chain Event     | WebSocket Event         | Coordinator State      | Reconciler Action         | RPC Query & Parameters                               | Result Returned | Cursors & Tracker State                                                                                       |
| :---- | :----------------- | :---------------------- | :--------------------- | :------------------------ | :--------------------------------------------------- | :-------------- | :------------------------------------------------------------------------------------------------------------ |
| **1** | Baseline cut       | None                    | `SUBSCRIBED` (Epoch 1) | Baseline established      | `getSignaturesForAddress(P, {limit: 1})`             | `[A]`           | $S_{\text{verified}} = A$. **buys = 0** (A is cut, not decoded).                                              |
| **2** | Tx B confirmed     | **DROPPED**             | `SUBSCRIBED` (Epoch 1) | None                      | None                                                 | None            | $S_{\text{verified}} = A$. Tx B unobserved.                                                                   |
| **3** | Tx C confirmed     | Notification C received | `SUBSCRIBED` (Epoch 1) | Reconcile triggered       | `getSignaturesForAddress(P, {before: C, limit: 10})` | `[B, A]`        | **Positive boundary proof**: Array contains known anchor $A$.                                                 |
| **4** | Fetch transactions | None                    | `SUBSCRIBED` (Epoch 1) | Dispatch `getTransaction` | `getTransaction(B)` then `getTransaction(C)`         | Swaps returned  | Validated pool context; calls `tracker.ingestTrade(B)` then `ingestTrade(C)`.                                 |
| **5** | Cursor advance     | None                    | `SUBSCRIBED` (Epoch 1) | Advance watermark         | None                                                 | None            | All resolved. $S_{\text{verified}}$ advances to $C$. **Missed B recovered**. Window status remains `UNKNOWN`. |

---

### Fixture 2: Multi-Page Backward Pagination ($L = 10$, 25 New Transactions)

- Context: $S_{\text{verified}} = S_0$. 25 transactions ($S_{25} \dots S_1$) occurred since $S_0$.

| Query Step     | Method Call & Parameters                                | Signatures Returned                          | Boundary Check                                | Action Taken                                                                                   |
| :------------- | :------------------------------------------------------ | :------------------------------------------- | :-------------------------------------------- | :--------------------------------------------------------------------------------------------- |
| **Page 1**     | `getSignaturesForAddress(P, {limit: 10})`               | $[S_{25}, S_{24}, \dots, S_{16}]$ (10 items) | Anchor $S_0$ not in page; page full ($= 10$). | Buffer signatures. Prepare backward query with `before: S_16`.                                 |
| **Page 2**     | `getSignaturesForAddress(P, {limit: 10, before: S_16})` | $[S_{15}, S_{14}, \dots, S_6]$ (10 items)    | Anchor $S_0$ not in page; page full ($= 10$). | Buffer signatures. Prepare backward query with `before: S_6`.                                  |
| **Page 3**     | `getSignaturesForAddress(P, {limit: 10, before: S_6})`  | $[S_5, S_4, S_3, S_2, S_1, S_0]$ (6 items)   | **Anchor $S_0$ Found** in returned records!   | **Positive Boundary Established**. Complete contiguous chain confirmed.                        |
| **Resolution** | Dispatch `getTransaction` for $S_1 \dots S_{25}$        | 25 transactions fetched                      | Dispatched under budget policy                | Calls `tracker.ingestTrade()` for each valid swap. $S_{\text{verified}}$ advances to $S_{25}$. |

---

### Fixture 3: Quiet Period Across Skipped Slots (Honest `UNKNOWN` Verdict)

- Context: $S_{\text{verified}} = A$ at Slot 100. Zero pool transactions occur in Slots 101–105.

| Step  | Slot Sequence       | Pool P Activity           | Reconciler Query                          | Result                         | Interpretation & State                                                                                                                                                        |
| :---- | :------------------ | :------------------------ | :---------------------------------------- | :----------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | Slot 100            | Baseline cut              | Baseline query                            | `[A]`                          | $S_{\text{verified}} = A$.                                                                                                                                                    |
| **2** | Slots 101–105       | Zero transactions for $P$ | None                                      | None                           | No notifications received.                                                                                                                                                    |
| **3** | Slot 106 tick       | Periodic audit check      | `getSignaturesForAddress(P, {limit: 10})` | `[A]` (Only anchor A returned) | **Anchor Witnessed**. Proof that zero transactions occurred between A and query execution.                                                                                    |
| **4** | Coverage Evaluation | Window check              | Evaluate observation window               | Upper boundary unproven        | **Honest Verdict**: Node progress does not certify unindexed pool history through host time. Window coverage = **`UNKNOWN`** (`isProductionCompletenessEstablished = false`). |

---

### Fixture 4: Interrupted Reconciliation During WebSocket Disconnect

- Context: Reconciler is paginating when transport drops. Coordinator enters `DISCONNECTED`.

| Step  | System Event               | Coordinator State                          | In-Flight Job Handling        | Recovery Action on Reconnect                                                                                                                                   |
| :---- | :------------------------- | :----------------------------------------- | :---------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | Active pagination          | `SUBSCRIBED` (Epoch 1)                     | Page 2 query in-flight        | Network drops.                                                                                                                                                 |
| **2** | Transport Closes           | Enters `DISCONNECTED`                      | Status no longer `SUBSCRIBED` | In-flight Page 2 response arrives; **cancelled and discarded** due to status check. `StreamGap` recorded.                                                      |
| **3** | `attachTransport()` called | Increments to Epoch 2; enters `SUBSCRIBED` | Clean reconciler state        | New reconciliation job triggered anchoring to persistent $S_{\text{verified}} = A$.                                                                            |
| **4** | Backfill Dispatched        | `SUBSCRIBED` (Epoch 2)                     | Dispatches fresh pagination   | Missing transactions recovered and ingested via `ingestTrade()`. Recorded `StreamGap` **remains in tracker history**. Production completeness remains `false`. |

---

## 7. Defensible Conclusion & Implementation Recommendation

### 7.1 Defensible Outcome: `RECOVERY_ONLY`

1. **Recovery is Feasible**: Detecting and retrieving specific missed transactions between witnessed on-chain anchors using `getSignaturesForAddress` and `getTransaction` is technically and mathematically sound.
2. **Certification is Unsupported**: Certifying that an entire continuous rolling 60-second time window has been observed with 100% gapless completeness cannot be established via polling alone due to multi-node replication lag, unverified upper time boundaries, and nullable timestamps.
3. **Verdict**: The protocol must be designated strictly as **`RECOVERY_ONLY`**. The production completeness gate must **remain closed** (`isProductionCompletenessEstablished = false`).

---

### 7.2 Smallest Proposed Implementation Patch

When implementation is authorized, the smallest isolated offline patch consists of:

1. **Isolated Offline Helper**: Create `backend/src/candidate-scanner/ExactPoolSignatureReconciler.ts` containing only:
   - The dual-cursor state machine ($S_{\text{verified}}$ and frozen targets).
   - Bounded backward pagination requiring positive anchor confirmation.
   - Dispatch of `getTransaction` using explicit purpose and budget accounting.
   - Ingestion of decoded swaps via `tracker.ingestTrade()`.
2. **Deterministic Offline Unit Tests**: Create `ExactPoolSignatureReconciler.test.ts` testing Fixtures 1–4 using deterministic mock RPC transports and synthetic clocks.
3. **No Live Execution**: Keep the helper offline; do not wire it to live daemon loops or modify `isProductionCompletenessEstablished`.

---

## 8. Document Lineage & Historical References

- [`api-provider-capabilities-and-cost-roadmap.md`](file:///u:/Projects/TopG/docs/research-planning/api-provider-capabilities-and-cost-roadmap.md): API provider matrix and rate limits.
- [`RaydiumCandidateSubscriptionCoordinator.ts`](file:///u:/Projects/TopG/backend/src/candidate-scanner/RaydiumCandidateSubscriptionCoordinator.ts): Active coordinator lifecycle and gap tracking.
- [`RaydiumAmmV4TransactionSourceAdapter.ts`](file:///u:/Projects/TopG/backend/src/candidate-scanner/RaydiumAmmV4TransactionSourceAdapter.ts): Accepted transaction adapter and context validation.
- [`RollingTradeFlowTracker.ts`](file:///u:/Projects/TopG/backend/src/candidate-scanner/RollingTradeFlowTracker.ts): Rolling 60s micro-flow accumulator and `ingestTrade()` method.
- [`GlobalResourceBudgetManager.ts`](file:///u:/Projects/TopG/backend/src/research/prospective/GlobalResourceBudgetManager.ts): Enforced provider pacing and session request ceilings.
- [`phase-12.94d-milestone-d3-3-paper-readiness-assessment.md`](file:///u:/Projects/TopG/docs/research-planning/phase-12.94d-milestone-d3-3-paper-readiness-assessment.md): Phase 12.94-D Milestone D.3.3 source-accurate readiness assessment.
