# CPMM Pool Observation: Step 6 Extended-Observation Proposal

**Status**: Proposal only; **offline review only**. No live limit is approved, no live command is authorized, and no live execution takes place under this document. Roadmap Step 6 requires independent offline review and separate explicit operator approval before any live run may be scheduled.

---

## 1. Executive Summary & Context

Roadmap Step 4 (the offline rehearsal of `PROPOSED_SHORT_OBSERVATION_PROFILE_V1`, recorded in `cpmm-pool-observation-step4-rehearsal.md`) was accepted by independent review for a single bounded capture. Roadmap Step 5 (`cpmm-observation-01`) was authorized by separate operator approval, executed with the reviewed operator runbook script at commit `ac9d6f2d3836ba2605059c0e7df713e07fa1435c`, and accepted by independent review.

### Step 5 Results Summary (`cpmm-observation-01`):

- **Target**: Raydium CPMM WSOL/USDC pool `47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4`, candidate mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (USDC).
- **Execution**: 60-second observation window (`startedAtMs: 1795510166545`, `nominalEndMs: 1795510226545`, settled at `1795510226815` ms).
- **Network budget**: exactly 2 HTTP account requests (`getMultipleAccounts`), 0 transaction retrievals, 1 WebSocket connection, 2 pings matched by 2 pongs, 0 retries.
- **Activity**: 0 pool notifications arrived during the 60-second window. All 5 qualification flags remain strictly `false`.
- **Evidence & Verification**: both sealed bundles (`data/research/cpmm-acquisitions/cpmm-observation-01` and `data/research/cpmm-observations/cpmm-observation-01`) and all 18 manifest-listed files matched byte-identical. Implemented components reproduced, retention was complete, and offline credential-free `--verify` exited `0`.

While Step 5 proved end-to-end transport lifecycle, ping/pong keepalives, clean unsubscription, and offline evidence verification on live Solana mainnet, it captured an **empty transaction set** because the pool had zero on-chain swap events during that specific 60-second window.

This document proposes **Step 6**: a single bounded extended observation designed to capture live transaction activity while strictly respecting the architectural and throughput limitations of the accepted connection owner.

---

## 2. Target Rationale

### 2.1 The Observation Objective

The goal of CPMM observation is to observe, record, and reconstruct live constant-product automated market maker (CPMM) swaps on-chain over Raydium's CPMM program (`CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`). The observation exercises:

1. Real-time account notification delivery via `accountSubscribe`.
2. Signature extraction from transaction logs and ledger deduplication.
3. Serialized RPC `getTransaction` retrieval with in-flight credential redaction.
4. Exchange body parsing, pool state tracking, and local evidence sealing.
5. Offline cryptographic re-derivation and bundle verification.

### 2.2 Trade-off: Window Length vs. Pool Activity Density

The Step 5 capture demonstrated that a 60-second window on `47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4` can readily encounter zero swaps. On-chain trading activity naturally clusters; even active pools experience quiet minutes between transaction bursts.

However, selecting a high-frequency trading pool introduces severe risk under the current owner design:

- **Finding F1**: The owner's outstanding slot limit counts **unsettled hand-off envelopes**, not HTTP requests. The owner reserves a slot as soon as a notification is accepted, before the ledger checks for duplicate signatures. A burst of 5 notifications arriving in a single event-loop tick ends the run with `PROCESSING_OVERFLOW:OUTSTANDING_LIMIT` (exit 3).
- **Finding F4**: Transaction retrievals are strictly serialized and paced at 2,500 ms on `SOLANA_RPC`. The maximum throughput of the retrieval pipeline is `1,000 / 2,500 = 0.4` swaps/second (24 swaps/minute). Any pool averaging more than 0.4 swaps/second will accumulate a backlog that exhausts either the outstanding limit or the post-observation drain deadline.

### 2.3 Proposed Target Strategy

To maximize the likelihood of observing genuine swaps without risking immediate overflow:

1. **Target Selection**:
   - **Primary Option**: Retain the reviewed Raydium CPMM WSOL/USDC pool `47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4` (mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`), but execute during a known period of moderate market activity.
   - **Secondary Option**: Select an established, verified Raydium CPMM pool whose recent on-chain signature rate is historically between 1 and 4 swaps per minute (0.016 to 0.067 Hz), well below the 0.4 Hz serialized processing ceiling.
2. **Burst Expectation**: The target must have an expected burst density of $\le 4$ transactions per block, avoiding the 5-envelope overflow trigger.

---

## 3. Duration & Lifetime Composition

We propose extending the observation duration from 60 seconds to **300 seconds (5 minutes)**. A 5-minute window increases the observation window by $5\times$, significantly increasing the probability of capturing multiple organic swap transactions while maintaining strict bounds on total connection time and provider load.

### 3.1 Timing Budget & Lifetime Inequality

The accepted core enforces the lifetime composition inequality before construction:
$$\text{lifetimeMs} \ge \text{acquisition.durationMs} + \text{observationMs} + \text{unsubscribeAckTimeoutMs} + \max(\text{drainMs}, \text{cleanupTimeoutMs})$$

For the proposed Step 6 profile:

- $\text{acquisition.durationMs} = 15{,}000\text{ ms}$ (snapshot duration ceiling).
- $\text{acquisition.timeoutMs} = 5{,}000\text{ ms}$ (per-request HTTP timeout).
- $\text{observationMs} = 300{,}000\text{ ms}$ ($5\text{ minutes}$).
- $\text{unsubscribeAckTimeoutMs} = 5{,}000\text{ ms}$ (timeout to receive unsubscription confirmation).
- $\text{drainMs} = 25{,}000\text{ ms}$ (drain window to allow in-flight transaction retrievals to complete).
- $\text{cleanupTimeoutMs} = 5{,}000\text{ ms}$ (bounded transport closure).
- $\text{marginMs} = 5{,}000\text{ ms}$ (operator buffer).

$$\text{Required Minimum} = 15{,}000 + 300{,}000 + 5{,}000 + \max(25{,}000, 5{,}000) = 345{,}000\text{ ms}$$
$$\text{Proposed Session Lifetime} = 350{,}000\text{ ms } (5\text{ minutes, } 50\text{ seconds})$$

The budget accounting check passes with a $5{,}000\text{ ms}$ margin. As with earlier profiles, the session lifetime is shared and never extended.

---

## 4. HTTP and WebSocket Ceilings

### 4.1 Shared HTTP Request Budget

All HTTP requests run across a single shared session budget on `SOLANA_RPC`. There are no retries, no lane resets, and no secondary requests:

- **Acquisition requests**: exactly 2 `getMultipleAccounts` requests (discovery followed by the paced snapshot).
- **Transaction retrievals**: at most 28 `getTransaction` requests, serialized and paced.
- **Session ceiling**: **30 HTTP attempts**.
- **Other lanes** (`RUGCHECK`, `SOLANA_TRACKER`, `DEXSCREENER`): strictly 0 attempts.

### 4.2 Throughput and Pacing Justification

- **Pacing**: strictly 2,500 ms between dispatches on `SOLANA_RPC`.
- **Retrieval Duration**: 28 retrievals at 2,500 ms pacing require a minimum of $28 \times 2{,}500\text{ ms} = 70{,}000\text{ ms}$ (70 seconds) of lane time.
- In a 300-second window, 28 transactions correspond to an average rate of $\approx 5.6$ swaps per minute. This bounds total provider cost to at most 30 RPC calls while providing sufficient room to record multiple distinct trade cycles.

### 4.3 WebSocket Connection & Control Ceilings

- **Connections**: exactly 1 WebSocket connection; no reconnect, no fallback.
- **Subscriptions**: exactly 1 `accountSubscribe` on the pool address; 1 `accountUnsubscribe`.
- **Ping interval**: 20,000 ms. Over 300 seconds, the owner will dispatch $\approx 15$ pings.
- **Pong timeout**: 5,000 ms.
- **Control frame limits**:
  - `pings`: limit 16 (dispatched by client).
  - `pongReplies`: limit 16 (replies to server pings).
  - `maxControlFrames`: 36 frames of at most 125 bytes.
- **Wrapper limits**: 65,536 bytes per frame, 16 fragments, 64 buffered chunks, handshake timeout 5,000 ms, close timeout 5,000 ms.

---

## 5. Pacing, Outstanding Handoffs, Retention, and Drain

### 5.1 The 4-Outstanding Handoff Limitation (Finding F1)

In the accepted owner design:

- The owner maintains `maxOutstandingResolutions = 4`.
- Every incoming notification accepted from the collector increments the outstanding count _before_ the ledger determines if the signature is new or duplicate.
- A 5th concurrent notification while 4 are outstanding terminates the run immediately with:
  `[PROCESSING_OVERFLOW:OUTSTANDING_LIMIT]` (exit 3).

**Proposal Stance on Outstanding Limit**:

- **Recommendation**: Maintain `maxOutstandingResolutions = 4` unchanged.
- _Rationale_: Modifying the owner's concurrency architecture or queue semantics would alter accepted runtime components, requiring code changes and invalidating earlier milestone reviews. Maintaining `4` preserves exact architectural continuity with Step 4 and Step 5.
- _Operational consequence_: The target pool must not receive more than 4 notifications within a single 2,500 ms processing slice. If a burst $> 4$ occurs, the run will terminate fail-closed with exit 3, preserving sealed evidence.

### 5.2 Retention Limits

To accommodate up to 28 transactions and 300 seconds of frame traffic:

- **Collector**: `maxFrameBytes = 65,536`, `maxEpochFrames = 256`, `maxEpochBytes = 2,097,152` (2 MB), `maxRetainedFrameRecords = 257`, `maxRetainedNotifications = 256`, 1 epoch.
- **Ledger**: `maxSignatureRecords = 256`, `maxDuplicateDetailsPerRecord = 4`, 1 epoch.
- **Transaction source**: 256 tracked signatures, `maxResponseBytes = 262,144` (256 KB).
- **Observation recorder**:
  - `maxIncomingRecords = 320` ($2{,}097{,}152\text{ bytes}$).
  - `maxOutgoingRecords = 16` ($16{,}384\text{ bytes}$).
  - `maxControlRecords = 64` ($8{,}192\text{ bytes}$).
  - `maxLifecycleRecords = 128`.
  - `maxExchangeRecords = 32` (covers 2 acquisition + 28 transaction exchanges + 2 margin).
  - `maxExchangeBodyBytes = 8,388,608` (8 MB total payload storage).
  - `maxLedgerCallRecords = 512`.
  - `maxInstrumentationFailures = 16`.
  - `maxFinishCopyNodes = 400,000`.

### 5.3 Drain & Cleanup

- **Drain duration (`drainMs = 25,000 ms`)**:
  - Begins as soon as the `accountUnsubscribe` response is received at nominal end (300,000 ms).
  - Allows up to 10 serialized retrievals ($10 \times 2{,}500\text{ ms} = 25\text{ s}$) that were already queued before unsubscription to finish settling cleanly before the run concludes.
- **Cleanup (`cleanupTimeoutMs = 5,000 ms`)**:
  - Unref'd transport close wait; ensures the underlying TCP socket and event loop handles close cleanly.

---

## 6. Detailed Profile Comparison

| Group                     | Step 5 Profile (`PROPOSED_SHORT_OBSERVATION_PROFILE_V1`) | Step 6 Proposed Profile (`PROPOSED_EXTENDED_OBSERVATION_PROFILE_V1`) | Rationale                          |
| :------------------------ | :------------------------------------------------------- | :------------------------------------------------------------------- | :--------------------------------- |
| **Session Lifetime**      | 105,000 ms (1m 45s)                                      | **350,000 ms (5m 50s)**                                              | Extended observation window        |
| **Observation Duration**  | 60,000 ms (1m)                                           | **300,000 ms (5m)**                                                  | $5\times$ window to capture swaps  |
| **HTTP Attempts Ceiling** | 10 (2 acq + at most 8 retrievals)                        | **30 (2 acq + at most 28 retrievals)**                               | Sufficient headroom for trades     |
| **Pacing (`SOLANA_RPC`)** | 2,500 ms                                                 | **2,500 ms**                                                         | Strict RPC rate limit preservation |
| **Outstanding Limit**     | 4 hand-offs                                              | **4 hand-offs**                                                      | Preserves accepted owner code      |
| **Pings / Pong Replies**  | 3 pings / 4 pong replies                                 | **16 pings / 16 pong replies**                                       | Scales with 300s duration          |
| **Control Frames Limit**  | 16 frames                                                | **36 frames**                                                        | Accommodates 15 pings + 16 pongs   |
| **Drain Window**          | 20,000 ms                                                | **25,000 ms**                                                        | Drains up to 10 in-flight requests |
| **Collector Epoch Bytes** | 1,048,576 bytes (1 MB)                                   | **2,097,152 bytes (2 MB)**                                           | Accommodates 5m of notifications   |
| **Exchange Records**      | 16 records                                               | **32 records**                                                       | Accommodates up to 30 exchanges    |
| **Exchange Body Storage** | 2,621,440 bytes                                          | **8,388,608 bytes**                                                  | Safe bound for 30 full responses   |

---

## 7. Account of Busy-Pool Limitations (Rehearsal Findings F1–F5)

The Step 6 proposal explicitly accounts for the five findings identified during the Step 4 rehearsal:

1. **F1: Outstanding limit counts envelopes, not requests**:
   - _Risk_: A burst of $\ge 5$ notifications in a single tick triggers `PROCESSING_OVERFLOW:OUTSTANDING_LIMIT` (exit 3).
   - _Mitigation_: The target pool must be selected to avoid high-concurrency bot or arbitrage activity. If a burst occurs, the core fails closed, protecting the provider and sealing evidence.
2. **F2: Retention covers only what reached the recorder**:
   - _Risk_: An oversized frame ($> 65{,}536\text{ bytes}$) refused by the wrapper is not recorded, leaving retention reported as `COMPLETE` while the run exits 3.
   - _Mitigation_: Diagnostic check in `transport-diagnostics.json` (`refusedPayloadLimit`, `control.refused`) alerts operators to wrapper-level drops.
3. **F3: Drain expiry leaves cut requests pending**:
   - _Risk_: If more than 10 retrievals remain in the queue when unsubscription completes, the 25-second drain will expire before all requests finish, resulting in `DRAIN_EXPIRED` (exit 3).
   - _Mitigation_: 25,000 ms drain accommodates a realistic trailing backlog; excessive trailing backlogs trigger truthful fail-closed termination.
4. **F4: Quiet pool throughput requirement**:
   - _Risk_: Pool swaps averaging $> 24\text{ swaps/minute}$ will overwhelm the 2,500 ms serializer.
   - _Mitigation_: The pool must average $< 5.6\text{ swaps/minute}$ across the 5-minute window to complete within the 30-attempt budget.
5. **F5: Duplicate details truncation**:
   - _Risk_: More than 4 duplicate notifications for the same signature truncate duplicate details and mark retention `INCOMPLETE` (exit 2).
   - _Mitigation_: Exit 2 is accepted as a valid, non-failing terminal state that reports limited retention without triggering retries.

---

## 8. Definition of Evidentiary Value by Outcome

A critical requirement of Step 6 is defining what each potential capture outcome establishes scientifically and operationally:

### 8.1 Empty Capture (0 Notifications, Exit 0)

- **Observed**: Exactly 2 acquisition requests, 0 transaction retrievals, 1 WebSocket connection, 15 pings matched by 15 pongs, clean unsubscription, 0 pool notifications.
- **What it establishes**:
  - Proves sustained WebSocket transport stability, keepalive negotiation, and clean teardown over a continuous 5-minute duration on Solana mainnet.
  - Proves that the target pool experienced zero on-chain liquidity updates during the 300-second window.
  - Verifies that zero-transaction captures reproduce offline with complete retention and exit `0`.
- **What it does NOT establish**:
  - Does not exercise transaction parsing, transaction retrieval, ledger signature tracking, or pool state delta decoding under load.

### 8.2 Active Capture (1 to 28 Swaps, Exit 0)

- **Observed**: 2 acquisition requests, $N \in [1, 28]$ transaction retrievals, 1 WebSocket connection, $\approx 15$ pings, $N$ distinct swaps recorded and parsed, clean unsubscription.
- **What it establishes**:
  - Proves end-to-end functionality of the complete CPMM observation pipeline on live Solana mainnet.
  - Confirms live event streaming from Raydium CPMM program accounts via Helius wss.
  - Demonstrates correct serialization and pacing (2,500 ms) of `getTransaction` HTTP queries.
  - Validates on-chain swap decoding, vault balance reconciliation, and offline evidence reproduction.
  - Serves as the primary diagnostic benchmark for CPMM market structure research.

### 8.3 Failed Capture (Exit 3)

- **Observed**: The run terminates prematurely with exit 3 due to `PROCESSING_OVERFLOW:OUTSTANDING_LIMIT`, `DRAIN_EXPIRED`, `TRANSPORT_ERROR`, or `ACQUISITION_LIMIT`.
- **What it establishes**:
  - Validates the fail-closed defense-in-depth architecture under live mainnet stress.
  - Proves that when real-world market bursts exceed the design envelope, the engine terminates truthfully without:
    1. Leaking excess HTTP requests beyond budget.
    2. Overrunning process memory or persisting unsealed files.
    3. Retrying or reconnecting automatically.
  - The sealed bundles remain intact and cryptographically bound, enabling exact forensic review of the failure boundary.

### 8.4 Budget-Exhausted Capture (Exit 3 via `HTTP_ATTEMPT_CEILING_REACHED`)

- **Observed**: The run reaches 30 HTTP requests (2 acquisition + 28 transaction retrievals) before the 300-second window ends. A 29th distinct transaction is refused by the session, and the run terminates cleanly with exit 3.
- **What it establishes**:
  - Proves strict enforcement of the shared session budget ceiling on live mainnet.
  - Demonstrates that the engine prioritizes operator rate limits and cost bounds over unbounded data collection.
  - All 28 earlier retrieved transactions are fully preserved, sealed, and verified in the observation bundle.

### 8.5 Invariant Across All Outcomes

Across all possible outcomes (Empty, Active, Failed, Budget-Exhausted):

- **Trading safety**: No trading, orders, positions, strategies, or admissions occur.
- **Wallet protection**: The virtual wallet balance (7.9259 SOL) and hash (`7F2C2353...`) remain strictly unchanged.
- **Qualification flags**: All 5 qualification flags remain `false` by construction.
- **Non-reentrancy**: The run id is consumed; no retry, rerun, or overwrite is permitted.

---

## 9. Governance & Operational Constraints

1. **Step 6 is Documentation Only**: This document is a planning proposal. It does not alter runtime code, update production profiles, or authorize live execution.
2. **Prerequisites for Live Authorization**:
   - Independent review and acceptance of this Step 6 proposal.
   - Operator selection of the target pool address, candidate mint, and run ID.
   - Separate, explicit operator approval of the exact command and script hash.
3. **Repository State**: Repository remains clean at commit `ac9d6f2d3836ba2605059c0e7df713e07fa1435c`. All existing capture directories and operator runbooks are preserved byte-identical.
