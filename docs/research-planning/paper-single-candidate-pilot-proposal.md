# PAPER Single-Candidate Pilot — Proposal for Review

**Status:** proposal only; nothing in it has been executed or approved. No provider request, socket, capture, daemon activation or rerun is authorized by this document. The Stage B runner reviewed at `6855efb0e4ab5023e2c556030c42613a0ee86f53` is used unchanged (see the [runbook](./paper-single-candidate-diagnostic-runbook.md) and assessment §8.35–§8.36). Stage A and the conditional wrapper are implemented offline and await review; every limit in this document is **proposed, not approved**.

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

### 1.5 Stage A: bounded on-chain precheck (implemented offline; awaiting review)

**Implementation**: `backend/src/scripts/fresh-amm-v4-precheck.ts`. It reuses the existing `PaperRequestSession`, the existing transaction normalizer (`SolanaRpcTransactionFetcher.parseTransactionResponse`), the existing `initialize2` decoder (`PoolInitializationParser`) and the runner's own DexScreener parser and market endpoint. Its default is a dry run (no configuration, request or file); `--live` dispatches.

**Pinned fee destination**: `7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5`, the AMM v4 create-pool fee destination.

- **Source**: declared in Raydium's mainnet [`program/src/processor.rs`](https://github.com/raydium-io/raydium-amm/blob/master/program/src/processor.rs); it is account index 14 of the upstream `initialize2` account vector ([`program/src/instruction.rs`](https://github.com/raydium-io/raydium-amm/blob/master/program/src/instruction.rs)), matching the accepted parser's vector.
- **Source revision**: the `master` branch as cited in the operator review of 2026-11-14. The commit SHA was **not** retrieved, because no network access was authorized; it should be recorded at review. The plan seals this statement.
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

**A selected target is PROVISIONAL**: security and strategy eligibility are still unverified; the runner decides at runtime. The market indicators sealed with it are informational only.

**Output**: a new, sealed `data/research/prechecks/<name>/` containing:

- `plan.json`
- the request ledger, the exchange index, and one exchange file per request (credentials redacted at byte level; the RPC URL is a placeholder)
- `selection.json`
- `evidence-manifest.json`

**Not yet known**: the current creation rate of AMM v4 / WSOL pools. A result without a target is likely and valid.

### 1.6 Enforced conditional handoff (implemented offline; awaiting review)

**Handoff check**: `backend/src/scripts/paper-pilot-handoff.ts`, read-only (git and local files). It answers `ALLOWED`, `WAIT` or `REFUSED`:

1. **Code and configuration**: the files below must equal the **pinned commit**, with nothing modified or untracked (`CODE_OR_CONFIGURATION_CHANGED`, `RELEVANT_FILES_DIRTY`):
   - `backend`
   - `shared`
   - `package.json`
   - `pnpm-lock.yaml`
   - `pnpm-workspace.yaml`
   - the wrapper

   Since the reviewed runner commit `6855efb`, only the Stage A and handoff files may have been **added** in the runner's dependency surface; any other change refuses (`REVIEWED_RUNNER_DEPENDENCY_CHANGED`).

2. **Evidence**: the sealed precheck must verify. It is refused on:
   - a wrong manifest kind or version
   - invalid or duplicate paths
   - a missing, modified or unlisted file (checked recursively)
   - a plan-digest mismatch
3. **Reproduction**: re-deriving the selection from the sealed responses must reproduce `selection.json` exactly. The outcome must be `TARGET_SELECTED`, and the identity canonical, candidate base / WSOL quote. Nothing is substituted.
4. **Start window**: the age on `pairCreatedAt` must be within 240–760 s (a planning estimate). Before the window opens, the check answers `WAIT` with the exact wait, at most 240 s. After it closes, it refuses (`START_WINDOW_EXPIRED`).
5. **Output**: the pilot directory must be new and inside `data/research/single-candidate/`.

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

1. **Review the offline implementation**: Stage A, the handoff check, the wrapper and their regressions. Record the Raydium source revision for the pinned fee destination.
2. **One combined, conditional operator approval**, because the start window is too short for a second approval round after the precheck. It must name:
   - the pinned commit and the exact step-2 command of §3;
   - exactly one Stage A precheck;
   - at most one Stage B pilot run, only if the handoff allows it immediately before Stage B;
   - the combined ceilings: **344 HTTP attempts, including 62 transaction retrievals, and up to two sequential WebSocket connections** through the single permitted reconnect.

   A precheck without a target, an unusable market check, a refused or expired handoff, or any failure ends the sequence, with no retry. A further attempt needs a new approval.
