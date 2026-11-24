# CPMM Pool Observation: Step 6 Extended-Observation Proposal

**Status**: Proposal only; **offline review only**. No live limit is approved, no live command is authorized, and no live execution takes place under this document. Roadmap Step 6 requires independent offline review and separate explicit operator approval before any live run may be scheduled.

---

## 1. Executive Summary & Context

Roadmap Step 4 (the offline rehearsal of `PROPOSED_SHORT_OBSERVATION_PROFILE_V1`, recorded in `cpmm-pool-observation-step4-rehearsal.md`) was accepted by independent review for a single bounded capture. Roadmap Step 5 (`cpmm-observation-01`) was authorized by separate operator approval, executed with the reviewed operator runbook script at commit `ac9d6f2d3836ba2605059c0e7df713e07fa1435c`, and accepted by independent review.

### Step 5 Results Summary (`cpmm-observation-01`):

- **Target**: Raydium CPMM WSOL/USDC pool `47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4`, candidate mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (USDC).
- **Execution**: 60-second observation window (`startedAtMs: 1795510166545`, `nominalEndMs: 1795510226545`, settled at `1795510226815` ms).
- **Protocol**: acknowledged `logsSubscribe` with pool-address `mentions` filter (`{"mentions":["47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4"]}`) at `confirmed` commitment, acknowledged `logsUnsubscribe`, clean transport closure.
- **Network budget**: exactly 2 HTTP account requests (`getMultipleAccounts` on `SOLANA_RPC`), 0 transaction retrievals, 1 WebSocket connection, 2 pings matched by 2 pongs, 0 retries, 0 follow-up requests.
- **Activity**: 0 pool notifications were received during the 60-second window. All 5 qualification flags remain strictly `false`:
  - `notificationCompletenessEstablished: false`
  - `quietWindowEstablished: false`
  - `qualificationEligible: false`
  - `replayableCaptureEstablished: false`
  - `admissionEligible: false`
- **Evidence & Verification**: both sealed bundles (`data/research/cpmm-acquisitions/cpmm-observation-01` and `data/research/cpmm-observations/cpmm-observation-01`) and all 18 manifest-listed files matched byte-identical. Implemented components reproduced, retention was complete, and offline credential-free `--verify` exited `0`.

While Step 5 proved end-to-end transport lifecycle, ping/pong keepalives, clean unsubscription, and offline evidence verification on live Solana mainnet, it captured an **empty notification set** because zero notifications were delivered by the provider during that specific 60-second window.

This document proposes **Step 6**: a single bounded extended observation designed to capture live transaction activity while strictly respecting the architectural and throughput limitations of the accepted connection owner.

---

## 2. Subscription Protocol & Target Rationale

### 2.1 The Subscription Protocol

The observation engine interacts with Solana mainnet over WebSocket using the JSON-RPC `logsSubscribe` and `logsUnsubscribe` methods:

1. **Subscription Request**:
   ```json
   {
     "jsonrpc": "2.0",
     "id": 1,
     "method": "logsSubscribe",
     "params": [
       { "mentions": ["47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4"] },
       { "commitment": "confirmed" }
     ]
   }
   ```
2. **Unsubscription Request**:
   ```json
   {
     "jsonrpc": "2.0",
     "id": 2,
     "method": "logsUnsubscribe",
     "params": [51204270]
   }
   ```

The subscription monitors log messages mentioning the CPMM pool address at `confirmed` commitment. Notifications delivered over this channel trigger downstream signature parsing and ledger deduplication.

### 2.2 Empirical Observation vs. On-Chain Inferences

The Step 5 capture established an empirical fact: **0 pool notifications were received** from the provider WebSocket connection during the 60-second observation window.

An empty notification set does **not** prove:

- that the target pool was dormant;
- that zero on-chain swap events occurred on Solana mainnet;
- that no liquidity updates took place.

It establishes strictly that no notifications satisfying the `logsSubscribe` filter were delivered over the active WebSocket transport during that time.

### 2.3 Trade-off: Window Length vs. Pool Activity Density

On-chain trading activity naturally clusters; even active pools experience quiet minutes between transaction bursts. A 60-second observation window easily falls within a quiet gap between trade clusters.

However, selecting a high-frequency trading pool introduces severe risk under the accepted owner design:

- **Finding F1**: The owner's outstanding slot limit counts **unsettled hand-off envelopes**, not HTTP requests. The owner reserves a slot as soon as a notification is accepted, before the ledger checks for duplicate signatures. A burst of 5 notifications arriving in a single event-loop tick ends the run with `PROCESSING_OVERFLOW:OUTSTANDING_LIMIT` (exit 3).
- **Finding F4**: Transaction retrievals are strictly serialized and paced at a minimum of 2,500 ms on `SOLANA_RPC`. With network round-trip time and request timeouts (up to 10,000 ms), actual throughput is strictly bounded below 24 requests/minute. Any pool averaging more than a few swaps per minute risks accumulating an unresolvable backlog.

### 2.4 Proposed Target Strategy

To maximize the likelihood of observing genuine swaps without risking immediate overflow:

1. **Target Selection**:
   - **Primary Option**: Retain the reviewed Raydium CPMM WSOL/USDC pool `47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4` (mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`), but observe over a 300-second window during a period of moderate market activity.
   - **Secondary Option**: Select an established, verified Raydium CPMM pool whose recent on-chain signature rate is historically between 1 and 4 notifications per minute (0.016 to 0.067 Hz), well below the serialized processing ceiling.
2. **Burst Expectation**: The target pool must have an expected burst density of $\le 4$ notifications per block, avoiding the 5-envelope overflow trigger.

---

## 3. Timing Budget & Absolute Deadlines

We propose extending the observation duration from 60 seconds to **300 seconds (5 minutes)**. A 5-minute window increases observation time by $5\times$, significantly increasing the probability of capturing multiple organic trade cycles while strictly bounding total connection time and provider load.

### 3.1 Derivation from `CpmmPoolConnectionOwner` Absolute Deadlines

In `CpmmPoolConnectionOwner.ts` (lines 979–1006, 1318–1336), all lifecycle checkpoints are calculated as absolute timestamps anchored to observation start ($t_0 = \text{startedAtMs}$):

1. **Acknowledgement Deadline**:
   $$\text{ackDeadlineMs} = t_0 + \text{ackTimeoutMs} = t_0 + 10{,}000\text{ ms}$$
2. **Nominal Observation End**:
   $$\text{nominalEndMs} = t_0 + \text{observationMs} = t_0 + 300{,}000\text{ ms}$$
   At `now >= nominalEndMs`, the owner transitions from `OBSERVING` to `UNSUBSCRIBING` and dispatches `logsUnsubscribe`.
3. **Intake End Deadline**:
   $$\text{intakeEndMs} = \text{nominalEndMs} + \text{unsubscribeAckTimeoutMs} = t_0 + 300{,}000\text{ ms} + 5{,}000\text{ ms} = t_0 + 305{,}000\text{ ms}$$
   At `now >= intakeEndMs`, all further incoming notifications are refused (`stopIntake("INTAKE_DEADLINE")`).
4. **Drain Deadline**:
   $$\text{drainDeadlineMs} = \text{intakeEndMs} + \text{drainMs} = t_0 + 305{,}000\text{ ms} + 25{,}000\text{ ms} = t_0 + 330{,}000\text{ ms}$$
   _Crucial architectural rule_: `drainDeadlineMs` is calculated directly from `intakeEndMs`, **not** from when the unsubscription response happens to arrive.
5. **Run Ceiling**:
   $$\text{runCeilingMs} = \text{intakeEndMs} + \max(\text{drainMs}, \text{cleanupTimeoutMs}) = t_0 + 305{,}000\text{ ms} + \max(25{,}000, 5{,}000) = t_0 + 330{,}000\text{ ms}$$
6. **Session Lifetime Inequality**:
   The engine validates before construction that the session deadline accommodates the run ceiling:
   $$\text{lifetimeMs} \ge \text{acquisition.durationMs} + \text{observationMs} + \text{unsubscribeAckTimeoutMs} + \max(\text{drainMs}, \text{cleanupTimeoutMs})$$
   $$\text{Required Minimum} = 15{,}000 + 300{,}000 + 5{,}000 + 25{,}000 = 345{,}000\text{ ms}$$
   $$\text{Proposed Session Lifetime} = 350{,}000\text{ ms } (5\text{ minutes, } 50\text{ seconds})$$
   The session lifetime passes with a $5{,}000\text{ ms}$ operator buffer.

### 3.2 Framing of the 25-Second Drain Window

The 25,000 ms drain window is a **deliberate cutoff**, not an assumption about settling time:

- The owner maintains at most 4 outstanding handoffs at any moment; there is no queue of 10 requests.
- Each `getTransaction` request requires minimum 2,500 ms dispatch spacing, plus network RTT and up to 10,000 ms request timeout.
- Rather than estimating settling time or waiting indefinitely for in-flight requests, 25 seconds is enforced as a strict, deliberate cutoff bounding post-observation wait.
- If in-flight work or trailing handoffs do not settle before `drainDeadlineMs` ($t_0 + 330{,}000\text{ ms}$), the owner halts fail-closed with `DRAIN_EXPIRED` (exit 3) and records pending work truthfully in `session-ledger.json`.

---

## 4. HTTP and WebSocket Ceilings

### 4.1 Shared HTTP Request Budget

All HTTP requests share a single strict session budget on `SOLANA_RPC`. There are no retries, no lane resets, and no secondary requests:

- **Acquisition requests**: exactly 2 `getMultipleAccounts` requests (discovery followed by the paced snapshot).
- **Transaction retrievals**: at most 28 `getTransaction` requests, serialized and paced.
- **Session ceiling**: **30 HTTP attempts**.
- **Other lanes** (`RUGCHECK`, `SOLANA_TRACKER`, `DEXSCREENER`): strictly 0 attempts.

### 4.2 Throughput, Pacing, and Timeouts

- **Pacing**: minimum 2,500 ms between dispatches on `SOLANA_RPC`.
- **Request timeouts**: 10,000 ms per transaction retrieval HTTP request; 5,000 ms per acquisition HTTP request.
- **Throughput calculation**:
  - The theoretical upper bound of serialized 2,500 ms pacing is $1{,}000 / 2{,}500 = 0.4\text{ req/s}$ ($24\text{ req/min}$), assuming 0 ms network RTT.
  - Across a 300-second window, 28 transaction retrievals represent an average rate of $\le 5.6\text{ retrievals/minute}$.
  - This bounds total provider cost to at most 30 RPC calls while providing sufficient room to record multiple distinct trade cycles.

### 4.3 WebSocket Connection & Control Ceilings

- **Connections**: exactly 1 WebSocket connection; no reconnect, no fallback.
- **Subscriptions**: exactly 1 `logsSubscribe` on the pool address; 1 `logsUnsubscribe`.
- **Ping interval**: 20,000 ms.
- **Pong timeout**: 5,000 ms.
- **Punctual synthetic ping schedule and timer delays**:
  - Client keepalive pings are dispatched only when `pongBy = now + pongTimeoutMs < nominalEndMs`.
  - With $t_0 = 0$, `nominalEndMs = 300,000`, `pingIntervalMs = 20,000`, `pongTimeoutMs = 5,000`:
    - Dispatches occur punctually at $t = 20\text{s}, 40\text{s}, 60\text{s}, \dots, 280\text{s}$ (14 pings). For each, $\text{pongBy} = t + 5\text{s} \le 285\text{s} < 300\text{s}$.
    - At $t = 300\text{s}$, `now >= nominalEndMs` triggers unsubscription, and $\text{pongBy} = 305\text{s} \ge 300\text{s}$ suppresses any 15th ping.
  - In a synthetic test with zero timer drift, **exactly 14 client pings** are dispatched, matched by 14 received pongs. In a live runtime with real timer delays or event-loop jitter, fewer pings may be dispatched within the observation window; 14 represents the punctual synthetic schedule ceiling.
- **Control frame limits**:
  - `pings`: limit 16 (dispatched by client; accommodates 14 clean pings with headroom of 2).
  - `pongReplies`: limit 16 (replies to server-initiated pings).
  - `maxControlFrames`: 36 frames of at most 125 bytes. Crucially, `CpmmPoolConnectionOwner` tracks `controlFrames` as **incoming** control frames: `this.pingsReceived + this.pongsReceived` (incoming pings from server + incoming pongs from server). Outgoing client keepalive pings are counted separately by client dispatch limits (`pings: 16`), not by `controlFrames`. A clean run with 14 received pongs and 0 server pings registers 14 incoming control frames (well within the 36-frame ceiling).
- **Wrapper limits**: 65,536 bytes per frame, 16 fragments, 64 buffered chunks, handshake timeout 5,000 ms, close timeout 5,000 ms.

---

## 5. Handoff Model, Retention, and Drain Dynamics

### 5.1 The 4-Outstanding Handoff Model (Finding F1)

In the accepted owner design:

- The owner maintains `maxOutstandingResolutions = 4`.
- Every incoming notification envelope accepted from the collector increments the outstanding count **before** the ledger determines if the signature is new or duplicate.
- A 5th concurrent notification while 4 are outstanding terminates the run immediately with:
  `[PROCESSING_OVERFLOW:OUTSTANDING_LIMIT]` (exit 3).
- **Preservation of Contract**: The proposal maintains `maxOutstandingResolutions = 4` unchanged to preserve accepted component contracts.

### 5.2 Expanded Retention Limits

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

---

## 6. Account of Busy-Pool Limitations (Rehearsal Findings F1–F8)

The Step 6 proposal explicitly accounts for all findings identified during rehearsal:

1. **F1: Outstanding limit counts envelopes, not requests**:
   - The owner reserves a slot for every accepted notification before the ledger knows whether it is a duplicate. Five notifications delivered in one tick end the run with `PROCESSING_OVERFLOW:OUTSTANDING_LIMIT` (exit 3), even if all are duplicates that need no request.
   - _Operating envelope_: Target pool must have expected arrival rate of 1 to 4 notifications per minute and burst density $\le 4$.
2. **F2: Retention covers only what reached the recorder**:
   - Frames refused by the transport wrapper or `ws` client (e.g. $> 65{,}536\text{ bytes}$) drop before reaching the recorder. Retention may report `COMPLETE` while the run exits 3.
   - _Forensic check_: `transport-diagnostics.json` (`refusedPayloadLimit`, `control.refused`) records wrapper drops truthfully.
3. **F3: Drain expiry stops waiting for in-flight work**:
   - When `drainDeadlineMs` passes, the owner settles without waiting for cut requests. The record stays `PENDING`, retention reports `EXCHANGE_MISSING` and `PENDING_WORK`, and the run terminates with exit 3.
   - _Design role_: 25,000 ms drain bounds total execution time without hanging on unresponsive RPC requests.
4. **F4: Practical capacity requires a quiet pool**:
   - Serialized 2,500 ms minimum dispatch spacing limits throughput to at most 24 requests/minute theoretically, and $\approx 5.6\text{ req/min}$ average under the 30-attempt budget.
   - _Operating envelope_: Target pool must average $< 5.6\text{ swaps/minute}$ across the 5-minute window.
5. **F5: Duplicate details truncation**:
   - At most 4 duplicate details are retained per signature. A 5th duplicate marks retention `INCOMPLETE` (exit 2).
   - _Evidence status_: Exit 2 is a non-failing terminal state that faithfully reports incomplete retention without triggering retries.
6. **F6: Control-frame and retention limits bind only in an unclean run**:
   - The owner's `maxControlFrames = 36` counts incoming control frames (`this.pingsReceived + this.pongsReceived`). A punctual clean run with 14 incoming pongs and 0 incoming pings registers 14 incoming control frames. Reaching 36 incoming control frames requires unsolicited pongs or server ping floods, ending the run fail-closed with `CONTROL_FRAME_LIMIT:INCOMING_CONTROL_FRAMES` (exit 3); a 17th server ping triggers `CONTROL_FRAME_LIMIT:PONG_REPLY_LIMIT` (exit 3).
   - In parallel, the observation recorder's retention limit `maxControlRecords = 64` bounds recorded control events (outgoing calls, completions, and incoming events). A punctual clean run generates 42 control records ($14 \times 3 \le 64$), keeping retention `COMPLETE`. A server ping flood (e.g. 16 server pings + 14 keepalive pings = 90 records) reaches the retention boundary, safely dropping excess control records and reporting `INCOMPLETE` retention with reason `RECORDS_DROPPED:control` (exit 2).
7. **F7: Lifetime allowance for acquisition sealing**:
   - Acquisition plus local sealing and verification must finish within 20,000 ms of session open. Past that, the stage boundary check halts the run before any WebSocket connection is established.
8. **F8: Sanitizer encoding coverage and limitations**:
   - The sanitizer detects and redacts literal, escaped, URL-encoded, and raw binary/decoded UTF-8 forms of endpoint credentials and secrets before diagnostic or file output. It does not detect arbitrary re-encoded credentials (such as arbitrary nested base64, hex, or compressed payloads) inside unstructured payloads; this remains a recognized architectural limitation.

---

## 7. Pipeline Stage Separation & Evidentiary Value by Outcome

### 7.1 Separation of Pipeline Stages

Conclusions must strictly distinguish between the four stages of the observation pipeline:

$$\text{Notifications} \longrightarrow \text{Signatures} \longrightarrow \text{Retrieval Attempts} \longrightarrow \text{Decoded Swaps}$$

1. **Notifications**: Raw WebSocket message frames delivered under `logsSubscribe`.
2. **Signatures**: Transaction signatures extracted from log messages. Multiple notifications can deliver the same signature (duplicates).
3. **Retrieval Attempts**: Serialized HTTP `getTransaction` queries dispatched on `SOLANA_RPC` for previously unobserved signatures.
4. **Decoded Swaps**: Successfully retrieved, parsed, and schema-validated CPMM swap operations for the target pool updating pool vault reserves.

Not every notification yields a new signature. Not every signature yields a successful retrieval. Not every retrieved transaction is a swap (it may be a non-swap instruction, liquidity deposit/withdrawal, or failed transaction).

### 7.2 Outcome Matrix (Conditional on Actual Evidence Files)

Outcome conclusions are **strictly conditional** on the actual evidence files (`report.json`, `owner-report.json`, `ledger.json`, `session-ledger.json`, `transport-diagnostics.json`, manifests) and do not promise full replayability, reconciliation, sealing, or complete retention from an exit code alone:

| Outcome                               | Exit Code | Observed Evidence State                                                                                                                                                                                   | Evidentiary Value Established                                                                                                                                                                                                        | Limitations & What is NOT Established                                                                                                        |
| :------------------------------------ | :-------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------- |
| **Empty Capture**                     | 0         | Exactly 2 acq requests, 0 retrievals, 1 WS, exactly 14 pings matched by 14 pongs, acknowledged unsubscribe, 0 notifications in `collector-report.json` and `ledger.json`, retention `COMPLETE`.           | Proves sustained 5-minute transport stability, keepalive negotiation, and clean teardown on live Solana mainnet. Proves zero notifications were received under the subscription filter. Offline `--verify` exits 0.                  | Does NOT establish pool dormancy or zero on-chain swaps. Does not exercise signature deduplication, transaction retrieval, or swap decoding. |
| **Active Capture**                    | 0         | 2 acq requests, $N \in [1, 28]$ retrievals, 1 WS, 14 pings, $N$ distinct signatures in ledger, $N$ complete exchange records, decoded swap events matching CPMM instruction schema, retention `COMPLETE`. | Proves complete end-to-end pipeline: live log streaming, signature extraction, deduplication, 2,500 ms serialized retrieval, swap decoding, and offline bundle verification. Primary diagnostic benchmark for CPMM market structure. | Valid only for the specific retrieved transactions. Does not prove completeness of on-chain activity outside the received notifications.     |
| **Duplicate Truncation**              | 2         | Any signature receiving $\ge 5$ duplicate notifications. Retention reports `INCOMPLETE` (reason `DUPLICATE_DETAILS_TRUNCATED`). Bundles sealed.                                                           | Proves ledger duplicate tracking and bounds enforcement under repetitive notification streams. Non-failing exit code 2 truthful reporting.                                                                                           | Retention is incomplete. Does not permit qualification or replay certification.                                                              |
| **Failed Capture (Overflow / Drain)** | 3         | Premature exit due to `PROCESSING_OVERFLOW:OUTSTANDING_LIMIT` (burst $> 4$), `DRAIN_EXPIRED` (trailing work $> 25\text{s}$), `TRANSPORT_ERROR`, or `ACQUISITION_LIMIT`. Evidence sealed.                  | Validates fail-closed architecture under live stress: no excess HTTP requests leaked, no unsealed files persisted, no automatic retries. Forensic review enabled via manifests.                                                      | Observation objective not met. Work remains pending or cut.                                                                                  |
| **Budget-Exhausted Capture**          | 3         | Exactly 30 HTTP attempts reached (2 acq + 28 retrievals). 29th signature refused with `HTTP_ATTEMPT_CEILING_REACHED`. Clean unsubscription and sealed bundles.                                            | Proves strict enforcement of shared session budget ceiling on live mainnet. Rate limits and cost bounds prioritized over unbounded data collection. All 28 earlier retrieved transactions preserved.                                 | Observation stopped before nominal end due to budget limit.                                                                                  |

### 7.3 Invariants Across All Outcomes

Across all possible outcomes:

- **Trading Safety**: Strictly 0 orders, trades, positions, strategies, or admissions.
- **Wallet Invariant**: Virtual wallet balance (7.9259 SOL) and hash (`7F2C2353...`) remain strictly unchanged before and after execution.
- **Qualification Flags**: All 5 qualification flags remain `false` by construction.
- **Non-reentrancy**: The run ID is consumed; no retry, rerun, or overwrite is permitted.

---

## 8. Detailed Profile Comparison

| Group                        | Step 5 Profile (`PROPOSED_SHORT_OBSERVATION_PROFILE_V1`) | Step 6 Proposed Profile (`PROPOSED_EXTENDED_OBSERVATION_PROFILE_V1`) | Rationale                                                           |
| :--------------------------- | :------------------------------------------------------- | :------------------------------------------------------------------- | :------------------------------------------------------------------ |
| **Session Lifetime**         | 105,000 ms (1m 45s)                                      | **350,000 ms (5m 50s)**                                              | Extended observation window                                         |
| **Observation Duration**     | 60,000 ms (1m)                                           | **300,000 ms (5m)**                                                  | $5\times$ window to capture trade activity                          |
| **HTTP Attempts Ceiling**    | 10 (2 acq + at most 8 retrievals)                        | **30 (2 acq + at most 28 retrievals)**                               | Headroom for multiple swap cycles                                   |
| **Pacing (`SOLANA_RPC`)**    | 2,500 ms minimum dispatch spacing                        | **2,500 ms minimum dispatch spacing**                                | Strict RPC rate limit preservation                                  |
| **Outstanding Limit**        | 4 hand-offs (`maxOutstandingResolutions`)                | **4 hand-offs (`maxOutstandingResolutions`)**                        | Preserves accepted owner contract                                   |
| **Pings Dispatched (Clean)** | 2 client pings (at 20s, 40s)                             | **14 client pings (at 20s, 40s, ..., 280s)**                         | Punctual synthetic ceiling; allows fewer with timer delays          |
| **Ping / Pong Reply Limits** | 3 pings / 4 pong replies                                 | **16 pings / 16 pong replies**                                       | Bounded headroom for extended window                                |
| **Control Frames Limit**     | 16 incoming frames                                       | **36 incoming frames**                                               | Incoming pings + pongs; accommodates 14 pongs + 16 pings + headroom |
| **Drain Window**             | 20,000 ms                                                | **25,000 ms**                                                        | Deliberate cutoff bounding post-obs wait                            |
| **Collector Epoch Bytes**    | 1,048,576 bytes (1 MB)                                   | **2,097,152 bytes (2 MB)**                                           | Accommodates 5m of notifications                                    |
| **Exchange Records**         | 16 records                                               | **32 records**                                                       | Accommodates up to 30 exchanges                                     |
| **Exchange Body Storage**    | 2,621,440 bytes                                          | **8,388,608 bytes (8 MB)**                                           | Safe bound for 30 full responses                                    |

---

## 9. Narrow Implementation Plan

### 9.1 Profile Design and Preservation of Accepted Components

To maintain strict modularity and zero regression:

1. **Byte-Identical Preservation**:
   - `PROPOSED_SHORT_OBSERVATION_PROFILE_V1` and its frozen SHA-256 digest (`8cd48f31a9dd8a157c91341dbee0acb0f773fbf2b29eef20ea4fb978f533cf78`) are preserved completely byte-identical.
2. **Separately Selected Extended Profile**:
   - Introduce `PROPOSED_EXTENDED_OBSERVATION_PROFILE_V1` as a distinct frozen constant.
   - CLI selection via explicit flag: `--profile short` (default) vs `--profile extended`.
3. **Zero Refactoring of Accepted Components**:
   - No edits to `CpmmPoolConnectionOwner.ts`, `CpmmPoolObservationRecorder.ts`, `CpmmPoolWebSocketTransport.ts`, `CpmmResolutionAccountingLedger.ts`, `cpmm-pool-observation-run.ts`, or `cpmm-pool-observation-evidence.ts`.

### 9.2 Proposed Files

1. `backend/src/scripts/cpmm-pool-observation.ts`:
   - Add definition and export of `PROPOSED_EXTENDED_OBSERVATION_PROFILE_V1`.
   - Add profile selection logic in CLI argument parser.
2. `backend/src/scripts/cpmm-pool-observation.test.ts`:
   - Add 10 offline rehearsal test cases (OC30–OC39).

### 9.3 Proposed Offline Rehearsal Test Cases (OC30–OC39)

| Test Case | Scenario & Focus                                                | Expected Exit | Expected Outcome & Evidence State                                                                                                                 |
| :-------- | :-------------------------------------------------------------- | :------------ | :------------------------------------------------------------------------------------------------------------------------------------------------ |
| **OC30**  | Extended profile schema & frozen digest validation              | 0             | Extended profile matches schema; digest matches frozen constant; short profile digest (`8cd48f31...`) unchanged.                                  |
| **OC31**  | Timing budget inequality validation                             | 0             | $350{,}000\text{ ms} \ge 15{,}000 + 300{,}000 + 5{,}000 + \max(25{,}000, 5{,}000) = 345{,}000\text{ ms}$ verified; margin is $5{,}000\text{ ms}$. |
| **OC32**  | Clean 300s run with zero notifications                          | 0             | Exactly 14 pings dispatched, 14 pongs received, clean unsubscription, exit 0, bundle verified offline.                                            |
| **OC33**  | Active capture with moderate transaction rate ($N \in [1, 28]$) | 0             | Serialized 2,500 ms pacing enforced; signatures deduplicated; swaps decoded; vault balances updated; exit 0.                                      |
| **OC34**  | Burst of 5 notifications in single tick (Finding F1)            | 3             | Fails closed with `PROCESSING_OVERFLOW:OUTSTANDING_LIMIT`; 0 excess HTTP requests leaked; evidence sealed.                                        |
| **OC35**  | HTTP attempt ceiling reached (28 retrievals exhausted)          | 3             | 29th signature refused; fails closed with `HTTP_ATTEMPT_CEILING_REACHED`; all 28 transactions sealed intact.                                      |
| **OC36**  | Drain window expiration with trailing pending work (Finding F3) | 3             | In-flight work taking $> 25{,}000\text{ ms}$ triggers `DRAIN_EXPIRED`; pending work truthfully recorded in ledger.                                |
| **OC37**  | Duplicate detail truncation (Finding F5)                        | 2             | 5th duplicate of a signature truncates duplicate details; retention marked `INCOMPLETE`; exit 2.                                                  |
| **OC38**  | Control-frame and retention limits (Finding F6)                 | 2 / 3         | 16 pings answered with pong replies, drops excess records at 64-record retention boundary (exit 2); 17th ping ends run with exit 3.               |
| **OC39**  | Credential protection & cancellation under extended execution   | 6 / 3         | Cancellation exits 6; supported literal/URL/binary credentials redacted; retains arbitrary re-encoding limitation (Finding F8).                   |

---

## 10. Governance & Operational Constraints

1. **Step 6 is Documentation Only**: This document is an offline planning proposal. It does not alter runtime code, update production profiles, or authorize live execution.
2. **Prerequisites for Live Authorization**:
   - Independent review and acceptance of this Step 6 proposal.
   - Operator selection of the target pool address, candidate mint, and run ID.
   - Implementation and passing of offline rehearsal test cases OC30–OC39 under external 60-second test limits.
   - Separate, explicit operator approval of the exact command and script hash.
3. **Repository State**: Repository remains clean at commit `ac9d6f2d3836ba2605059c0e7df713e07fa1435c`. All existing capture directories (`data/research/cpmm-acquisitions/cpmm-observation-01` and `data/research/cpmm-observations/cpmm-observation-01`), the virtual wallet (`.tmp/virtual-wallet.json`), and the operator runbook script (`.tmp/runbooks/cpmm-observation-01-operator.ps1`) are preserved byte-identical.
