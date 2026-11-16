# PAPER Single-Candidate Pilot — Proposal for Review

**Current status (2026-11-14):** Stage A precheck and the conditional wrapper were reviewed at commit `c440cef7eaba004e0fc15e9899f3ed58e9b7426c` and executed once under operator authorization into `data/research/prechecks/fresh-amm-v4-01` (manifest `5b65751d2adaf7e27e342d00262ffe0e8ac2ea73447b91f6de5b5fa6a146ac16`). The offline pin check passed, but Stage A terminated cleanly without a target (`SAMPLE_PRODUCED_NO_SUITABLE_TARGET`: 18 signatures outside the 0–760 s retrieval prefilter [12m 40s], 2 failed on-chain; 0 transactions retrieved, 0 market calls, 0 sockets), returning exit 3. Consequently, the live handoff check was not reached, and Stage B was not initiated. The single-execution authorization is exhausted; no further provider request, socket, capture, daemon activation, or rerun is currently authorized. Detailed analysis and the next-discovery assessment are recorded in assessment §8.37, with the proposed companion creation-watch design in §8.38.

**Watch captures (2026-11-15 & 2026-11-16; completed and independently verified offline):**

- **Watch capture 01 (`fresh-amm-v4-watch-01`, 2026-11-15)**: manifest `4160666ccda77c94faa74c6c687d8a4625cc2fbfbf3b33160528d6b861f7960c`, verified offline; ended `SUBSCRIBE_REJECTED` after 207 ms (JSON-RPC -32601 "Method 'logsSubscribe' not found" at scheme-derived WebSocket endpoint). It made one WebSocket connection and zero HTTP requests, found no target, and reached no handoff or Stage B; the wallet is unchanged. The WebSocket endpoint was subsequently separated into `SOLANA_WS_URL`.
- **Watch capture 02 (`fresh-amm-v4-watch-02`, 2026-11-16)**: manifest `9da4be7556cdcbd4db653f0483c8c28a425b5d1aff49f8cac06e178ddb827c99`, verified offline; ran from `2026-11-16T11:43:40.030Z` to `11:58:40.054Z` (900,024 ms, including 24 ms timer overshoot against the 900,000 ms ceiling). Connected to Helius WebSocket; subscription acknowledged (`subscriptionId: 30271788` at +540 ms from watch start, +134 ms from subscribe dispatch); 44 client pings sent and 44 matching pongs received; zero transaction notifications received; zero HTTP attempts; no validation or selection performed (`validation.json`: `recorded: false`, `result: null`; `selection.json`: `selected: false`). Cleanup settled at `CLEANUP_SETTLED: 1794830320187` (+133 ms after termination); report sealed at `report.sealedAtMs: 1794830320194` (+140 ms). No handoff, wait, or Stage B; wallet unchanged. Offline verification: integrity `OK`, completeness `INSUFFICIENT` (`TERMINAL_CAUSE:WATCH_ENDED_WITHOUT_CAPTURE`, `NO_QUALIFYING_NOTIFICATION_OBSERVED`), re-derivation `NOT_ELIGIBLE`, selection `NOT CONFIRMED` (native watch verifier exit code 3, distinct from the conditional wrapper's exit code 1). This 15-minute sample does not infer market-wide inactivity or broken delivery, but confirms that no qualifying notification was observed during this specific bounded interval; time-of-day variance (11:43–11:58 UTC) remains an untested hypothesis (assessment §8.38.15–§8.38.17).
- **Retrospective metadata check (run once, 2026-11-16)**: `backend/src/scripts/amm-v4-watch-retrospective.ts` is bound to watch 02 (manifest `9da4be75…7c99`, interval `1794829420030`–`1794830320054` ms) and makes exactly one `getSignaturesForAddress` request to `7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5` (limit 20, `confirmed`; 10 s deadline, 64 KiB response limit; no `getTransaction`, WebSocket, pagination, retry or redirect). The approved run (`amm-v4-watch-02-01`, manifest `71f05220…eabeeb`) received HTTP 200 in 160 ms, but sealed `MALFORMED_RESPONSE` because every record carried an extra `transactionIndex` field; that capture still verifies unchanged under its version 1 record schema. New captures use record schema version 2, which allows the field. A separate read-only reanalysis of the sealed bytes, tied to that manifest digest, finds a full page entirely older than the interval (`PAGE_OLDER_THAN_INTERVAL`, newest block time `1794551672`, 3.2 days before the watch). That is an observation about this one page, not an acquisition result, and not proof of complete history, faithful streaming or a provider fault. No rerun is authorised (assessment §8.38.16 and §8.38.19).

**Capability checks (2026-11-15 & 2026-11-16; completed and independently verified offline):**

- **Alchemy (`solana-subscription-01`, 2026-11-15)**: the single approved capability check completed with `TRANSPORT_ERROR` during the WebSocket handshake (`Unexpected server response: 403`), zero application frames, settled cleanup, verified manifest hash `25ED3117B87D2847BB70AE52B3A6B7096FC94B337156E8EC0C5BB4896C3B7506`, and Alchemy support ticket #27494 was submitted; the refusal's cause and account streaming entitlement remain unknown (assessment §8.38.13).
- **Helius (`solana-subscription-02`, 2026-11-16)**: executed by the operator using the hardened runbook against the matching Helius Mainnet WebSocket endpoint (`wss://mainnet.helius-rpc.com/?api-key=...`). Offline verification confirms integrity and capability (manifest SHA-256 `56dfbf8dce62dad4c1ff0f40c1f6cce18b9b5811b72a05d9f90ff4a58e6fa1a1`, started `2026-11-16T10:44:51.230Z`, subscription ack at +526 ms [id: 28059160], unsubscribe ack at +658 ms [`OBSERVED`, result true], cleanup complete at +790 ms, 2 outgoing frames, 2 incoming messages / 80 bytes payload, 0 notifications, no cancellation, exit 0 `CONFIRMED`). This establishes subscription and unsubscription access, not notification delivery or sustained reliability (assessment §8.38.14).

**Watch-mode update (2026-11-15; offline, for review, unapproved):** the wrapper now also has an explicit watch mode (`-Watch -WatchOutDir <new directory directly under data/research/prechecks/>`, mutually exclusive with `-PrecheckOutDir`). It runs one bounded creation watch (collector → validator → sealer, assessment §8.38.10) instead of the signature-page precheck and continues to the unchanged Stage B sequence only on a confirmed selection; see §1.7 and assessment §8.38.11. No live run is authorized and no operator live command is given.

**Historical proposal context:** This document was drafted as the prospective design and approval basis for the two-stage pilot sequence. The Stage B runner reviewed at `6855efb0e4ab5023e2c556030c42613a0ee86f53` remains frozen and unchanged (see the [runbook](./paper-single-candidate-diagnostic-runbook.md) and assessment §8.35–§8.36). The historical planning text and limits below are preserved for architectural and design reference.

**Summary:**

- **Target**: no strategy-eligible target can be named offline. The strategy admits only pools 5–15 minutes old, and the newest local evidence is five days old.
- **Proposed sequence**: one bounded on-chain **precheck** (Stage A) names at most one **provisional** fresh Raydium AMM v4 / WSOL pool. Then at most **one pilot run** (Stage B) of the reviewed runner, on exactly that pool and mint, only if an enforced handoff check passes immediately before it.
- **No ACT run**: another ACT run is not proposed. The one acquisition question it could answer (the parser on a real response) is answered offline in §1.3.

## 1. Target

### 1.1 What a strategy-eligible target must satisfy

These are the unchanged rules, checked by the runner itself:

| Requirement              | Rule                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| Pool type and identity   | Raydium AMM v4 (`675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`); candidate mint as base, WSOL as quote |
| Age at scanner intake    | 300–900 s (`CANDIDATE_SCANNER_DEFAULTS`)                                                               |
| Age at each decision     | within the maturity window (900 s ceiling for a non-established context)                               |
| Liquidity / market cap   | 0.15–0.30                                                                                              |
| LP burn                  | ≥ 90 %, from the validated on-chain LP evidence                                                        |
| Five-minute activity     | ≥ 20 transactions; average $15–$2,500; buys ≥ sells                                                    |
| Security (each decision) | LP, mint/freeze authorities, RugCheck and bundler evidence no older than 15 s                          |
| Flow (each decision)     | a qualified 60 s window, cutoff no older than 15 s                                                     |

### 1.2 Start window (PLANNING ESTIMATE)

The runner's nominal timeline comes from the offline runs and the sealed ACT captures. **These are planning estimates, not guarantees:**

| Step                                     | Nominal time after start                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| Subscription and pool layout             | about 3 s                                                                         |
| Security prefetch                        | about 59–67 s                                                                     |
| Scanner intake (market request, scanner) | about 67 s                                                                        |
| First decision (arming)                  | about 75 s                                                                        |
| Confirmation                             | about 80 s or later (at least 5 s after arming)                                   |
| Later decisions                          | at least 5 s apart; **no last-decision deadline follows** from the 8-decision cap |

Decisions are at least 5 s apart, but flow outages, transaction retrievals and security refreshes can delay any of them, so eight decisions do **not** establish a deadline of 120 s. The runtime maturity checks at each decision are authoritative: a decision made after the candidate leaves the maturity window is rejected there, and that is a valid strategy result, not a failure of this plan.

The proposed **start window is a pool age of 240–760 s**, measured on the **runner's own age source**, DexScreener `pairCreatedAt`:

- **Lower bound (240 s)**: with intake nominally about 67 s after start, the intake age is then nominally at least about 300 s.
- **Upper bound (760 s)**: it leaves about 140 s of nominal headroom before the 900 s ceiling for intake and the first decisions. It does not guarantee that any decision is made inside the maturity window.

A target named today from local evidence would be at least about 430,000 s old.

### 1.3 Locally evidenced targets and why each is out

| Target                                                                                                             | Evidence                                                                 | Status                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACT/WSOL, pool `B4PHSkL6CeZbxVqm1aUPQuVpc5ERFcaZj7u9dhtphmVX`, mint `GJAFwWjJ3vnTsrQVabjBVK2TYB1YtRCQXRDfDgUnpump` | 3 sealed exact-pair prechecks, 5 sealed diagnostics (2026-11-09)         | **Measured ineligible**: age about 64.9 million s; liquidity/market cap 0.146–0.148 (< 0.15); 4–13 five-minute transactions (< 20); every decided capture `MATURITY_WINDOW_GATE_FAILED` |
| FARTCOIN/WSOL                                                                                                      | 4 sealed diagnostics (2026-11-09)                                        | **Measured ineligible**: age about 65 million s, `MATURITY_WINDOW_GATE_FAILED`                                                                                                          |
| RAY/WSOL, pool `AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA`                                                      | sealed snapshot and decode diagnostic (no strategy decision was reached) | **Established token**, far outside the age window; its capture answered decoding, not eligibility                                                                                       |
| Raydium API v3 standard-pool page                                                                                  | `discovery/raydium-standard-pools-2026-11-09T05-40-28-324Z`              | **No target**: 20 established pools, none qualifying (CPMM program mismatch, missing open time, burn below 90 %)                                                                        |

**Offline check of the parser against real responses.** The reviewed `DexScreenerSingleCandidateMarketParser` was run offline on the three sealed, real DexScreener ACT responses (local files only, no network). Their digests match the seals: `47d2bdca…cff9`, `6d436cce…ff2c` and `4a6197be…9f8d`.

- **Accepted**: all three, with orientation `TOKEN_BASE_WSOL_QUOTE`, SOL- and USD-per-token prices, and `pairCreatedAt` 1729337799000 preserved with its provenance.
- **Classifications**: decimals, LP burn and authorities are `UNAVAILABLE`, as designed.
- **Scanner checks**: every one fails on age, on liquidity/market cap, and on five-minute transaction count.

### 1.4 Acquisition test versus strategy-eligibility test

| Test                     | What it exercises                                                                                                                                                                                  | Which target exercises it                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **Acquisition**          | live HTTP and WebSocket transports through this runner; per-request response evidence; security prefetch timing on the shared Solana lane; flow warm-up and qualification; market parsing; sealing | any active AMM v4 / WSOL pool, including ACT |
| **Strategy eligibility** | scanner intake admitting a candidate, an arming decision, then confirmation, drop, budget or expiry, all on fresh flow and fresh security evidence                                                 | only a fresh pool inside the start window    |

**An ACT run is not proposed.**

- **Where it would stop**: it would end at scanner intake (about 70 s, about 11 requests, `INTAKE_REJECTED:SCANNER_REJECTED:…`).
- **What it would answer**: only acquisition questions. The fresh-target pilot answers all of them as well.
- **Already answered offline**: the parser question (§1.3).
- **What remains open**: the runner queries `/latest/dex/tokens/<mint>`, and a real multi-pair response from that endpoint has not been captured. The per-pair schema is the same as the captured `/latest/dex/pairs` responses, and any mismatch fails closed as `INTAKE_REJECTED:MARKET_INTAKE_UNAVAILABLE`, an outcome the pilot would report as an acquisition finding.

### 1.5 Stage A: bounded on-chain precheck

_(Historical proposal text preserved below. Current status: reviewed and executed once under operator authorization in `data/research/prechecks/fresh-amm-v4-01`, ending with `SAMPLE_PRODUCED_NO_SUITABLE_TARGET`. Stage B was never initiated. See assessment §8.37.)_

**Implementation**: `backend/src/scripts/fresh-amm-v4-precheck.ts`. It reuses the existing `PaperRequestSession`, the existing transaction normalizer (`SolanaRpcTransactionFetcher.parseTransactionResponse`), the existing `initialize2` decoder (`PoolInitializationParser`) and the runner's own DexScreener parser and market endpoint. Its default is a dry run (no configuration, request or file); `--live` dispatches.

**Pinned fee destination**: `7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5`, the AMM v4 create-pool fee destination.

- **Source revision**: Raydium `raydium-amm` revision `91739d8d9f5cf347e0ce14ebe4d2bb7069fb31b6`, retrieved and checked by the review of `6515fcb`. The plan seals the revision and both immutable references.
- **Source**: the [fee-address declaration](https://github.com/raydium-io/raydium-amm/blob/91739d8d9f5cf347e0ce14ebe4d2bb7069fb31b6/program/src/processor.rs), and the [`initialize2` account vector](https://github.com/raydium-io/raydium-amm/blob/91739d8d9f5cf347e0ce14ebe4d2bb7069fb31b6/program/src/instruction.rs), where it is account index 14, matching the accepted parser's vector.
- **Self-verification**: every selected transaction must reference this address at its own `initialize2` account index 14.

**Requests (proposed limits)**: at most **3 Solana RPC requests and 1 market GET**, no WebSocket. Solana pacing 2,500 ms; the first 429 or any redirect stops the session; no retry; 10 s per request; 1 MiB per response; **30 s absolute deadline**. All other lanes are disabled.

1. **Signature page**: one `getSignaturesForAddress(fee destination, { limit: 20, commitment: "confirmed" })`, so **at most 20 signatures are inspected**. The JSON-RPC envelope must be version 2.0, echo the request id, carry no error and hold an array of at most 20 records; each record needs a valid signature, slot, `err` and block time.
2. **Retrievals**: **at most two** `getTransaction` (`json` encoding, version 0) for the newest records that succeeded on-chain and whose block time is 0–760 s old (a coarse retrieval prefilter only, not the window). Each must satisfy all of the following:
   - **Envelope**: a version 2.0 envelope with the same id and no error, and a non-null result.
   - **Signature and slot**: the returned signature is the requested one, and the slot matches the signature page.
   - **Success**: `meta.err` is null.
   - **Decoding**: exactly one AMM v4 `initialize2`, whose own account reference at index 14 is the pinned fee destination.
   - **Orientation**: the candidate is the base (coin) mint and WSOL the quote (pc) mint, the only orientation the runner supports. WSOL-base, no-WSOL and both-WSOL pools are rejected.

   The first match stops further retrievals.

3. **Market check (required)**: one GET on the runner's own endpoint (`/latest/dex/tokens/<mint>`), parsed by the runner's own parser. It must contain exactly the decoded pool, on Solana Raydium, with the decoded mint as base and WSOL as quote. It supplies `pairCreatedAt`, the runner's age source. Missing or unusable market evidence stops the handoff.

**Three time sources, kept apart**: each is sealed separately with its provenance.

| Source                          | Evidence                                                            |
| ------------------------------- | ------------------------------------------------------------------- |
| Initialization block time       | the transaction's `blockTime`, plus the signature page's block time |
| Instruction-requested open time | `open_time` from the `initialize2` instruction bytes                |
| DexScreener `pairCreatedAt`     | the runner's age source; the start window is computed from it alone |

**Honest sampling**: finding nothing establishes only that this bounded sample (at most 20 signatures, at most 2 transactions) produced no suitable target. Each signature keeps its own status, so request failures, unavailable evidence and decoded non-matches stay distinguishable:

- **Not retrieved**: failed on-chain, block time unavailable, outside the prefilter, beyond the sample bound, not reached after a match, or an invalid record.
- **`REQUEST_FAILED:<cause>`**: the retrieval failed as a request.
- **`EVIDENCE_UNAVAILABLE:<cause>`**: the response could not be used as evidence.
- **`DECODED_NONMATCH:<reason>`**: the transaction decoded but did not match.
- **`DECODED_MATCH`**: the transaction matched.

The overall outcome is one of:

- `TARGET_SELECTED`
- `SAMPLE_PRODUCED_NO_SUITABLE_TARGET`
- `REQUEST_FAILED`
- `EVIDENCE_UNAVAILABLE`
- `MARKET_EVIDENCE_UNAVAILABLE`
- `START_WINDOW_ALREADY_CLOSED`, which keeps the candidate's timestamps but does not select it
- `EVIDENCE_INVALID`
- `EVIDENCE_INCOMPLETE`

**Evidence-write failure**: if a dispatched request's evidence cannot be sealed, dispatch stops at once and that request is never repeated. The run is reported as `EVIDENCE_INCOMPLETE`, with the original cause (`CAPTURE_FAILED: …`), the request ledger and the missing sequence numbers preserved. No selection is derived, and the handoff refuses.

**A selected target is PROVISIONAL**: security and strategy eligibility are still unverified; the runner decides at runtime. The market indicators sealed with it are informational only.

**Output**: a new, sealed `data/research/prechecks/<name>/` containing:

- `plan.json`
- the request ledger, the exchange index, and one exchange file per request (credentials redacted at byte level; the RPC URL is a placeholder)
- `selection.json`
- `evidence-manifest.json`

**Not yet known**: the current creation rate of AMM v4 / WSOL pools. A result without a target is likely and valid.

**Next discovery direction**: To eliminate the timing coincidence required by point-in-time signature page sampling without polling or altering the Stage B runner, a companion creation-watch design is proposed in assessment §8.38.

### 1.6 Enforced conditional handoff

_(Historical proposal text preserved below. Current status: reviewed at `c440cef`; verified in offline tests. In the single live execution, the pin check passed, but Stage A returned exit 3 (`SAMPLE_PRODUCED_NO_SUITABLE_TARGET`), so the wrapper halted before the live handoff check was reached.)_

**Handoff check**: `backend/src/scripts/paper-pilot-handoff.ts`, read-only (git and local files). It answers `ALLOWED`, `WAIT` or `REFUSED`:

1. **Code and configuration**: the files below must equal the **pinned commit**, with nothing modified or untracked (`CODE_OR_CONFIGURATION_CHANGED`, `RELEVANT_FILES_DIRTY`):
   - `backend`
   - `shared`
   - `package.json`
   - `pnpm-lock.yaml`
   - `pnpm-workspace.yaml`
   - inherited root runtime configuration: `tsconfig.base.json` (extended by `backend/tsconfig.json`; it maps `@nexustrade/shared`), `.npmrc`, `.node-version` and `.nvmrc`
   - the wrapper

   Tooling-only files (ESLint, Prettier, EditorConfig) and `.env.example` do not affect the run. The secret `.env` is untracked and is never inspected, passed to git or printed.

   Since the reviewed runner commit `6855efb`, only the Stage A and handoff files may have been **added** in the runner's dependency surface, which includes the inherited configuration; any other change refuses (`REVIEWED_RUNNER_DEPENDENCY_CHANGED`).

2. **Evidence**: the sealed precheck must verify. It is refused on:
   - a wrong manifest kind or version
   - invalid or duplicate paths
   - a missing, modified or unlisted file (checked recursively)
   - a plan-digest mismatch
3. **Response references**: every reference is validated **before any response is read**. Each must be the canonical, confined path for its sequence number (`exchanges/NNNN.json`), listed in the verified manifest as a response, and unique; every listed response must be indexed. The ledger and the index must name exactly the same requests, and each response's purpose, lane, JSON-RPC id, times, status and error must agree with its ledger entry. Missing exchanges and capture failures refuse (`EVIDENCE_INCOMPLETE`). Only the canonical files are ever read, so a reference pointing outside the seal is refused without being opened.
4. **Reproduction**: re-deriving the selection from those responses must reproduce `selection.json` exactly. The outcome must be `TARGET_SELECTED`, and the identity canonical, candidate base / WSOL quote. Nothing is substituted.
5. **Output**: the pilot directory must be new and inside `data/research/single-candidate/`.
6. **Start window**: the clock is read **after every validation, immediately before deciding**. The age on `pairCreatedAt` must then be within 240–760 s (a planning estimate). Before the window opens, the check answers `WAIT` with the exact wait, at most 240 s. After it closes, including when it closes during validation, it refuses (`START_WINDOW_EXPIRED`).

**Wrapper**: `scripts/paper-pilot-sequence.ps1` (PowerShell 5.1 compatible). It is **inert unless `-Execute` is given**: it then runs only the pin check and the precheck dry run, and prints the plan. With `-Execute`:

1. Pin check and wallet hash.
2. One Stage A run; anything but a selected target stops.
3. Handoff check; a `WAIT` gets exactly one bounded sleep, never a loop.
4. Stage B dry run with the exact sealed identity.
5. Handoff **re-check immediately before Stage B**, which must allow the identical pool and mint.
6. One Stage B run.
7. `--verify` and the wallet hash again.

Every failure throws and stops the sequence. There is no retry, substitution or polling.

**Why not the existing tools**:

- **`scanner-discover.ts`**: it reads the default-ordered first page of the Raydium API v3 list, sorts by TVL and has no upper age bound. On 2026-11-09 it returned no qualifying pool.
- **Events collector**: it subscribes to all logs of the AMM v4 program (every swap) under a 500-message ceiling, which can be exhausted in seconds without seeing a creation.

### 1.7 Watch mode of the wrapper (proposed; offline only)

**Why**: the one live Stage A run found no target because a point-in-time signature page rarely contains a pool inside the 0–760 s prefilter (§8.37). The watch observes creations as they happen, so a candidate is young when it is found.

**What changes**: only discovery. In watch mode, step 3 of the wrapper runs `fresh-amm-v4-watch.ts --out-dir <dir> --live` once instead of the precheck. Then:

- **Continuing**: only its exit 0 (a sealed, verified, confirmed selection) continues. Any other exit ends the sequence; nothing falls back to the precheck and nothing is repeated.
- **Handoff**: both handoff checks use `--watch-evidence-dir`. They must allow the identical pool, mint, pilot directory and sealed manifest digest, and the final check rechecks the code pin, the evidence and the current start window immediately before Stage B.
- **Stage B**: the dry run, the final handoff, at most one Stage B run, its verification and the wallet checks are unchanged. The watch evidence is also verified offline at the end, on every path.

**Inert check**: without `-Execute`, watch mode runs only the pin check and the watch dry run. It loads no credentials, opens no transport and writes no evidence.

**Proposed combined ceilings (not approved)**:

- **Watch**: one WebSocket connection, no reconnect, at most 900 s of watching. The collector's cleanup (at most 5 s) and sealing are overhead outside that.
- **Validation**: at most one RPC request and one DexScreener request (10 s timeouts, 1 MiB responses), ending by min(notification + 30 s, watch start + 930 s).
- **Wait**: at most one, at most 240 s + 1 s.
- **Stage B**: its reviewed limits, unchanged (600 s lifetimes, at most 340 HTTP attempts).
- **Overhead**: offline handoffs and pin checks (git calls bounded by 20 s each), child start-ups, and local sealing and verification.
- **In all**: network time of at most 930 s for discovery plus Stage B's 600 s. The full breakdown is in assessment §8.38.11.

**Cancellation**: Ctrl+C is expected to stop the wrapper and to reach the watch child, which seals its own cancellation. No later live step runs. The final verification and wallet checks are still attempted, and one summary (the outcome, the original failure and each final-check failure) is printed from the sequence core's `finally` block, which runs even when the core never returns. The offline test (P-09) throws a real PowerShell pipeline-stop exception against stubbed hooks only. It does not deliver a console Ctrl+C to the Node child or prove that the child's sealing has finished. A watch verification racing the child's own sealing is reported as a final-check failure next to the cancellation, and the sealed run can be re-verified offline.

**Operator command**: none is given until this integration has been reviewed and a combined approval exists.

## 2. Limits (proposed, not approved)

**Stage A**: at most 3 Solana RPC requests plus 1 market GET; no WebSocket; 2,500 ms Solana pacing; 10 s per request; 1 MiB per response; 30 s absolute deadline; at most 20 signatures inspected and 2 transactions retrieved.

**Stage B**: the reviewed runner limits, unchanged. The runner at `6855efb` has no limit flags; it always uses `PROPOSED_SINGLE_CANDIDATE_LIMITS`, which its dry run prints and seals in `plan.json`.

| Group                 | Value                                                                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duration              | session and flow lifetime 600 s (absolute, from start; never extended)                                                                                                                         |
| HTTP                  | 340 attempts in total; Solana RPC 320 at ≥ 2,500 ms spacing; RugCheck 6 at 5,000 ms; Solana Tracker 6 at 5,000 ms; market 9 at 1,000 ms; 10 s per-request timeout (5 s on the flow's requests) |
| Transaction retrieval | 60 retrievals; 4 per cycle; queue ceiling 13; 300 flow HTTP attempts                                                                                                                           |
| WebSocket             | 60 notifications; 80 messages; 1,048,576 message bytes; 80 control frames; ping every 20 s, pong within 10 s, 32 pings; subscription acknowledgement within 5 s; **1 reconnect**               |
| Response size         | Solana RPC 262,144 bytes; RugCheck 4,194,304; Solana Tracker 1,048,576; market 262,144 (overflow is a marked partial, never complete evidence)                                                 |
| Security              | 6 loads, 6 refreshes, 30 s LP acquisition timeout                                                                                                                                              |
| Schedule              | prefetch lead 6 s; confirmation delay 5 s; decision interval 5 s; decision lead 1.5 s; refresh horizon 10 s; 8 decisions; 2 prefetch epochs                                                    |
| Worst-case allocation | 339 of 340 (Solana 318 of 320; RugCheck 6/6; Solana Tracker 6/6; market 9/9)                                                                                                                   |

**Combined ceilings the approval must disclose** (Stage A + Stage B):

| Ceiling                | Stage A | Stage B                                            | Combined                           |
| ---------------------- | ------- | -------------------------------------------------- | ---------------------------------- |
| HTTP attempts          | 4       | 340                                                | **344**                            |
| Transaction retrievals | 2       | 60                                                 | **62**                             |
| WebSocket connections  | 0       | up to 2 (sequential, through the single reconnect) | **up to 2 sequential connections** |

**Stop conditions** (the first to occur ends the run):

- `ENTRY_CONFIRMED_NO_EXECUTION`
- `CANDIDATE_DROPPED:<outcome>`
- `INTAKE_REJECTED:<reason>`
- `SECURITY_REFRESH_BUDGET_EXHAUSTED:…`
- `DECISION_BUDGET_EXHAUSTED_WHILE_ARMED`
- `FLOW_COLLECTION_ENDED:<reason>`: lifetime, notification, message, byte or retrieval ceilings, the reconnect ceiling, a first 429 or a redirect on the flow.
- `REQUEST_SESSION_STOPPED:<reason>`: deadline, first 429, redirect or shared ceiling.
- `OPERATOR_INTERRUPT` (Ctrl+C).

Cleanup is bounded, and every outcome is sealed.

**Smallest useful scope.** One target, one run, through its first terminal decision outcome. The nominal usage below is a planning estimate from the offline schedule and the sealed ACT runs; outages, retrievals and refreshes can lengthen it, up to the ceilings above.

| Outcome                                                        | Nominal time  | Nominal requests |
| -------------------------------------------------------------- | ------------- | ---------------- |
| Intake rejection                                               | about 70 s    | about 10–15      |
| Arm, then confirm or drop                                      | about 80–90 s | about 20–30      |
| Long armed period ending on a spent decision or refresh budget | about 150 s   | about 60         |

- **Lifetime margin**: the 600 s lifetime leaves room for one reconnect (the epoch restarts with a 65 s warm-up).
- **Evidence volume**: expected a few MiB; the worst case is about 112 MiB of bounded response bodies (Stage B) plus at most 4 MiB (Stage A).

## 3. Exact proposed operator sequence

Run from `U:\Projects\TopG` in PowerShell. `<PINNED>` is the full 40-character SHA of the reviewed commit that introduces Stage A and the wrapper; it is reported with this proposal for review. The output directories are new and must not exist.

**Step 1: inert check** (offline; pin check and precheck dry run only):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/paper-pilot-sequence.ps1 -PinnedCommit <PINNED> -PrecheckOutDir data/research/prechecks/fresh-amm-v4-01 -PilotOutDir data/research/single-candidate/pilot-01-6855efb
```

**Step 2: live sequence** (only under the combined approval; exactly once):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/paper-pilot-sequence.ps1 -PinnedCommit <PINNED> -PrecheckOutDir data/research/prechecks/fresh-amm-v4-01 -PilotOutDir data/research/single-candidate/pilot-01-6855efb -Execute
```

What step 2 performs, each at most once:

1. Pin check (offline) and wallet hash check.
2. Stage A `--live` into `data/research/prechecks/fresh-amm-v4-01`.
3. Handoff check. On `WAIT`, a single bounded sleep.
4. Stage B dry run with the sealed pool and mint.
5. Handoff re-check.
6. Stage B `--live` into `data/research/single-candidate/pilot-01-6855efb`.
7. `--verify` and the wallet hash check.

**Underlying commands** (what the wrapper runs; listed for review, not for manual use):

```bash
node backend/node_modules/tsx/dist/cli.mjs backend/src/scripts/paper-pilot-handoff.ts --pinned-commit <PINNED> --pin-only
```

```bash
node backend/node_modules/tsx/dist/cli.mjs backend/src/scripts/fresh-amm-v4-precheck.ts --out-dir data/research/prechecks/fresh-amm-v4-01 --live
```

```bash
node backend/node_modules/tsx/dist/cli.mjs backend/src/scripts/paper-pilot-handoff.ts --pinned-commit <PINNED> --precheck-dir data/research/prechecks/fresh-amm-v4-01 --pilot-out-dir data/research/single-candidate/pilot-01-6855efb
```

```bash
node backend/node_modules/tsx/dist/cli.mjs backend/src/scripts/paper-single-candidate-diagnostic.ts --pool <SEALED_POOL> --mint <SEALED_MINT> --out-dir data/research/single-candidate/pilot-01-6855efb --live
```

```bash
node backend/node_modules/tsx/dist/cli.mjs backend/src/scripts/paper-single-candidate-diagnostic.ts --verify data/research/single-candidate/pilot-01-6855efb
```

**Wallet**: the SHA-256 of `.tmp/virtual-wallet.json` must stay `7F2C2353AC2F62CAC1BB98703742AB19C74AC5521635AF6F49BBE777AD020ED9` (checked by the wrapper before Stage A and after Stage B).

## 4. What each outcome would demonstrate

Flow qualification and strategy acceptance are reported separately (`summary.json`). A passing `--verify` shows integrity only. Revalidation means re-decoding the sealed responses against `decision-inputs.json`.

| Outcome                                                                                                                                                              | Demonstrates                                                                                                                                                                                                                                     | Does not demonstrate                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **Success**: `ENTRY_CONFIRMED_NO_EXECUTION`, `evidence.complete: true`                                                                                               | The first live end-to-end PAPER entry confirmation: scanner admission, arming and retest confirmation on qualified fresh flow and fresh security evidence, every input revalidatable from sealed responses. Also every acquisition item in §1.4. | Fill quality, slippage, profitability, exits, positions                       |
| **Strategy rejection**: `INTAKE_REJECTED:SCANNER_REJECTED:<reason>`, `CANDIDATE_DROPPED:<outcome>`, or a buy-gate or security rejection recorded in `decisions.json` | The gates applied to live evidence for a fresh candidate, with the reason sealed. A valid result, not a defect. Acquisition items are still exercised up to that point.                                                                          | That the strategy can ever confirm                                            |
| **Budget or scheduling stop**: `SECURITY_REFRESH_BUDGET_EXHAUSTED`, `DECISION_BUDGET_EXHAUSTED_WHILE_ARMED`                                                          | Real refresh and decision timings under live load, informing the open refresh-before-arming gap (§8.34). The candidate was neither confirmed nor rejected.                                                                                       | A strategy conclusion                                                         |
| **Acquisition failure**: `INTAKE_REJECTED:MARKET_INTAKE_UNAVAILABLE` or `MARKET_IDENTITY_MISMATCH`                                                                   | The live market response did not provide the exact pool (for example, not yet indexed) or failed the parser; the response is sealed for diagnosis.                                                                                               | Anything about the strategy                                                   |
| **Incomplete**: `FLOW_COLLECTION_ENDED:*`, `REQUEST_SESSION_STOPPED:*`, `OPERATOR_INTERRUPT`, or `evidence.complete: false` under any stop                           | Where acquisition stopped (sealed ledger, exchanges, WebSocket observations). With `evidence.complete: false`, the summary names what is missing: unrecorded exchanges, capture failures, omitted payloads or dropped records.                   | A strategy conclusion; decisions cannot be fully revalidated                  |
| **Stage A** `SAMPLE_PRODUCED_NO_SUITABLE_TARGET`                                                                                                                     | This bounded sample (at most 20 signatures, 2 transactions) held no suitable target at that moment                                                                                                                                               | That no eligible pool exists, or that the fee-destination assumption is wrong |
| **Stage A** `REQUEST_FAILED`, `EVIDENCE_UNAVAILABLE`, `MARKET_EVIDENCE_UNAVAILABLE`, `START_WINDOW_ALREADY_CLOSED`                                                   | Where the precheck could not establish a usable provisional target; the handoff stops                                                                                                                                                            | Anything about pool availability or the strategy                              |

## 5. Decision-only boundary

- **No execution path**: the runner never calls an execution or position path. It uses the coordinator, which returns decision records only. `ENTRY_CONFIRMED_NO_EXECUTION` stops the run. `summary.json` records `executed: "NONE (decision-only: no buy, no position)"`.
- **No fills, positions, orders or wallet changes**: from the daemon module, the runner and coordinator use only the configuration loader and the pure entry-evaluation helper (`retrieveAndEvaluatePaperDaemonEntry`). Neither that helper nor the runner or coordinator references the daemon's buy (`processScannedPool`), position monitoring, the settlement journal or `.tmp/virtual-wallet.json`. Importing the daemon module is inert. There is no signing or key material for trading. Its only credentials are the read-only RPC URL and the Solana Tracker key, which are never printed or persisted.
- **No daemon**: no daemon loops, Birdeye, Smart Money or discovery traffic. The request ledger accounts for every request.
- **No reruns**: the runner refuses an existing output directory. Stage A and Stage B are each one attempt.

## 6. Approval sequence requested

_(Historical proposal context: this two-stage sequence was authorized for a single execution on 2026-11-14. Following the `SAMPLE_PRODUCED_NO_SUITABLE_TARGET` result, this authorization is exhausted. Any future execution requires a separate proposal and approval.)_

1. **Review the offline implementation**: Stage A, the handoff check, the wrapper and their regressions. The Raydium source revision for the pinned fee destination is recorded (`91739d8d9f5cf347e0ce14ebe4d2bb7069fb31b6`).
2. **One combined, conditional operator approval**, because the start window is too short for a second approval round after the precheck. It must name:
   - the pinned commit and the exact step-2 command of §3;
   - exactly one Stage A precheck;
   - at most one Stage B pilot run, only if the handoff allows it immediately before Stage B;
   - the combined ceilings: **344 HTTP attempts, including 62 transaction retrievals, and up to two sequential WebSocket connections** through the single permitted reconnect.

   A precheck without a target, an unusable market check, a refused or expired handoff, or any failure ends the sequence, with no retry. A further attempt needs a new approval.
