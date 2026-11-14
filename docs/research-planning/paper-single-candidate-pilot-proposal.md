# PAPER Single-Candidate Pilot — Proposal for Review

**Status:** proposal only; nothing in it has been executed or approved. No provider request, socket, capture, daemon activation or rerun is authorized by this document. The runner reviewed at `6855efb0e4ab5023e2c556030c42613a0ee86f53` is used unchanged (see the [runbook](./paper-single-candidate-diagnostic-runbook.md) and assessment §8.35–§8.36).

**Summary:**

- **Target**: no strategy-eligible target can be named offline. The strategy admits only pools 5–15 minutes old, and the newest local evidence is five days old.
- **Proposed sequence**: one bounded on-chain **precheck** (Stage A) names at most one fresh Raydium AMM v4 / WSOL pool. Then at most **one pilot run** (Stage B) of the reviewed runner, on that exact pool and mint, inside a fixed start window.
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

### 1.2 Start window

The runner's timeline comes from the offline runs and the sealed ACT captures:

| Step                                      | Time after start       |
| ----------------------------------------- | ---------------------- |
| Subscription and pool layout              | about 3 s              |
| Security prefetch                         | about 59–67 s          |
| Scanner intake (market request, scanner)  | about 67 s             |
| First decision (arming)                   | about 75 s             |
| Confirmation                              | about 80 s (5 s later) |
| Last possible decision (8 at 5 s spacing) | about 120 s            |

Two bounds follow:

- **Earliest start**: intake must see an age of at least 300 s, so the pool must be at least about 240 s old when the command starts.
- **Latest start**: the last decision must still fall within 900 s, allowing 20 s for live latency, so the pool can be at most about 760 s old.

The proposed **start window is pool age 240–760 s** (about 8.7 minutes). A target named today from local evidence would be at least about 430,000 s old.

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

### 1.5 Stage A: bounded on-chain precheck (proposal; NOT implemented)

**Purpose**: name at most one fresh AMM v4 / WSOL pool inside the start window, from on-chain evidence only.

**Requests**: at most 3 Solana RPC requests and 1 optional DexScreener request, with no WebSocket. They go through the existing configuration path and a request session with the reviewed rules: 2,500 ms pacing, the first 429 or any redirect stops, no retries, 10 s timeout, 1 MiB per response, and a 30 s total deadline.

1. `getSignaturesForAddress(<AMM v4 create-pool fee destination>, { limit: 20, commitment: "confirmed" })`. The fee destination is account index 14 of the accepted `initialize2` account vector (`PoolInitializationParser`).
2. Up to 2 × `getTransaction` for the newest signatures whose block time puts the pool inside the start window with at least 120 s of the window left. Each is decoded with the existing `PoolInitializationParser` (`initialize2`, 21 accounts), and selection requires all of the following:
   - **Fee destination**: account 14 equals the queried fee destination (self-verifying).
   - **Program**: the AMM v4 program.
   - **Mints**: exactly one WSOL leg.
   - **Open time**: inside the window.
3. Optional: 1 × DexScreener exact-pair GET (the existing precheck pattern). It is informational only; the runner's intake decides.

**Selection**: deterministic, choosing the newest pool that meets every rule.

**Output**: a sealed `data/research/prechecks/fresh-amm-v4-<UTC stamp>/` with the raw responses, a selection ledger, and either one provisional target or `NO_TARGET_IN_WINDOW`. A target is `{ poolId, mintAddress, openTimeSec, ageAtSelectionSec, startWindowOpensAtIso, startWindowClosesAtIso }`. The output also prints the exact pilot commands with the pool and mint filled in.

**Not proven, so it must be settled during the offline implementation and review**:

- **Fee destination address**: the local fixtures use a placeholder. The real address must come from a public, reviewable source. The first decoded `initialize2` then verifies it, and a wrong address yields `NO_TARGET_IN_WINDOW`, not a wrong target.
- **Pool-creation rate**: the current rate of AMM v4 / WSOL pool creation is unknown, since fresh tokens may now launch elsewhere (CPMM, other venues). `NO_TARGET_IN_WINDOW` is a likely and valid result.
- **Fee-account activity**: the newest 20 signatures on the fee destination may include non-creation transfers. These are rejected by decoding, not assumed.

**Why not the existing tools**:

- **`scanner-discover.ts`**: it reads the default-ordered first page of the Raydium API v3 list, sorts by TVL and has no upper age bound. On 2026-11-09 it returned no qualifying pool.
- **Events collector**: it subscribes to all logs of the AMM v4 program (every swap) under a 500-message ceiling, which can be exhausted in seconds without seeing a creation.

## 2. Pilot limits (Stage B): the reviewed limits, unchanged

The runner at `6855efb` has no limit flags. It always uses `PROPOSED_SINGLE_CANDIDATE_LIMITS`, which the dry run prints and seals in `plan.json`. Tighter limits would need a code change and another review. They are **not** proposed: every value below is a ceiling, the run stops at its first terminal outcome, and the expected usage (below) is far smaller.

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

**Smallest useful scope.** One target, one run, through its first terminal decision outcome:

- **Strategy outcomes**: intake rejection (the strategy's first gate), arming then confirmation, drop or a spent budget.
- **Expected usage**, from the offline schedule and the sealed ACT runs:

| Outcome                                                        | Expected time | Expected requests |
| -------------------------------------------------------------- | ------------- | ----------------- |
| Intake rejection                                               | about 70 s    | about 10–15       |
| Arm, then confirm or drop                                      | about 80–90 s | about 20–30       |
| Long armed period ending on a spent decision or refresh budget | ≤ about 150 s | ≤ about 60        |

- **Lifetime margin**: the 600 s lifetime leaves room for one reconnect (the epoch restarts with a 65 s warm-up). That is the only reason it exceeds the expected need.
- **Evidence volume**: expected a few MiB (RugCheck reports of 0.2–2 MB each). The worst case is about 112 MiB of bounded response bodies.

## 3. Commands (Stage B), pinned to `6855efb0e4ab5023e2c556030c42613a0ee86f53`

Run everything from `U:\Projects\TopG`. Commits after `6855efb` that touch only documentation leave the pin valid. The pin check compares the backend source and the lockfile with the reviewed commit.

**Pin check** (must exit 0 and print nothing):

```bash
git -C U:/Projects/TopG diff --quiet 6855efb0e4ab5023e2c556030c42613a0ee86f53 -- backend package.json pnpm-lock.yaml && git -C U:/Projects/TopG status --porcelain -- backend package.json pnpm-lock.yaml
```

**Fresh output directory**: `data/research/single-candidate/pilot-01-6855efb` (it does not exist; the runner refuses it if it does). `<POOL>` and `<MINT>` are the exact values from the sealed Stage A target; nothing else is substituted.

**Dry run** (no configuration, no socket, no request, nothing written; check the printed target, output directory, limits and allocation):

```bash
node backend/node_modules/tsx/dist/cli.mjs backend/src/scripts/paper-single-candidate-diagnostic.ts --pool <POOL> --mint <MINT> --out-dir data/research/single-candidate/pilot-01-6855efb
```

**Operator run** (awaiting separate approval; only while the pool's age is inside the start window; one attempt, no rerun):

```bash
node backend/node_modules/tsx/dist/cli.mjs backend/src/scripts/paper-single-candidate-diagnostic.ts --pool <POOL> --mint <MINT> --out-dir data/research/single-candidate/pilot-01-6855efb --live
```

**Integrity check afterwards** (read-only):

```bash
node backend/node_modules/tsx/dist/cli.mjs backend/src/scripts/paper-single-candidate-diagnostic.ts --verify data/research/single-candidate/pilot-01-6855efb
```

**Wallet check before and after**: the SHA-256 of `.tmp/virtual-wallet.json` must stay `7F2C2353AC2F62CAC1BB98703742AB19C74AC5521635AF6F49BBE777AD020ED9`.

## 4. What each outcome would demonstrate

Flow qualification and strategy acceptance are reported separately (`summary.json`). A passing `--verify` shows integrity only. Revalidation means re-decoding the sealed responses against `decision-inputs.json`.

| Outcome                                                                                                                                                              | Demonstrates                                                                                                                                                                                                                                     | Does not demonstrate                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| **Success**: `ENTRY_CONFIRMED_NO_EXECUTION`, `evidence.complete: true`                                                                                               | The first live end-to-end PAPER entry confirmation: scanner admission, arming and retest confirmation on qualified fresh flow and fresh security evidence, every input revalidatable from sealed responses. Also every acquisition item in §1.4. | Fill quality, slippage, profitability, exits, positions      |
| **Strategy rejection**: `INTAKE_REJECTED:SCANNER_REJECTED:<reason>`, `CANDIDATE_DROPPED:<outcome>`, or a buy-gate or security rejection recorded in `decisions.json` | The gates applied to live evidence for a fresh candidate, with the reason sealed. A valid result, not a defect. Acquisition items are still exercised up to that point.                                                                          | That the strategy can ever confirm                           |
| **Budget or scheduling stop**: `SECURITY_REFRESH_BUDGET_EXHAUSTED`, `DECISION_BUDGET_EXHAUSTED_WHILE_ARMED`                                                          | Real refresh and decision timings under live load, informing the open refresh-before-arming gap (§8.34). The candidate was neither confirmed nor rejected.                                                                                       | A strategy conclusion                                        |
| **Acquisition failure**: `INTAKE_REJECTED:MARKET_INTAKE_UNAVAILABLE` or `MARKET_IDENTITY_MISMATCH`                                                                   | The live market response did not provide the exact pool (for example, not yet indexed) or failed the parser; the response is sealed for diagnosis.                                                                                               | Anything about the strategy                                  |
| **Incomplete**: `FLOW_COLLECTION_ENDED:*`, `REQUEST_SESSION_STOPPED:*`, `OPERATOR_INTERRUPT`, or `evidence.complete: false` under any stop                           | Where acquisition stopped (sealed ledger, exchanges, WebSocket observations). With `evidence.complete: false`, the summary names what is missing: unrecorded exchanges, capture failures, omitted payloads or dropped records.                   | A strategy conclusion; decisions cannot be fully revalidated |
| **Stage A** `NO_TARGET_IN_WINDOW`                                                                                                                                    | No fresh AMM v4 / WSOL pool in the window at that moment (or the fee-destination assumption is wrong, if it never finds any `initialize2`)                                                                                                       | That eligible pools never occur                              |

## 5. Decision-only boundary

- **No execution path**: the runner never calls an execution or position path. It uses the coordinator, which returns decision records only. `ENTRY_CONFIRMED_NO_EXECUTION` stops the run. `summary.json` records `executed: "NONE (decision-only: no buy, no position)"`.
- **No fills, positions, orders or wallet changes**: from the daemon module, the runner and coordinator use only the configuration loader and the pure entry-evaluation helper (`retrieveAndEvaluatePaperDaemonEntry`). Neither that helper nor the runner or coordinator references the daemon's buy (`processScannedPool`), position monitoring, the settlement journal or `.tmp/virtual-wallet.json`. Importing the daemon module is inert. There is no signing or key material for trading. Its only credentials are the read-only RPC URL and the Solana Tracker key, which are never printed or persisted.
- **No daemon**: no daemon loops, Birdeye, Smart Money or discovery traffic. The request ledger accounts for every request.
- **No reruns**: the runner refuses an existing output directory. Stage A and Stage B are each one attempt.

## 6. Approval sequence requested

1. **Review this proposal**, including the start window and the decision to use the reviewed limits unchanged.
2. **Offline implementation** of the Stage A precheck (no network): sealed output, fail-closed decoding, the request bounds above, and offline regressions. Review it like the earlier offline tasks, including how the fee-destination address was sourced.
3. **One combined, conditional operator approval.** The start window (about 8.7 minutes) is too short for a second approval round after the precheck, so the approval must name both stages:
   - exactly one Stage A precheck;
   - at most one Stage B pilot run, only if the precheck seals a target meeting §1.5 and the operator can start within its window;
   - the exact commands of §3, with the pool and mint taken verbatim from the sealed target.

   A precheck without a target, a missed window or any failure ends the sequence, with no retry. A further attempt needs a new approval.
