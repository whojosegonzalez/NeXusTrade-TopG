# CPMM Pool Observation — Operator Runbook

**Status:** Roadmap Step 4 (offline rehearsal) was accepted for a single bounded capture, Roadmap Step 5 (`cpmm-observation-01`) passed under separate operator approval and independent review, and Roadmap Step 6 (`cpmm-observation-02`, `--profile extended` at commit `0002d0b18e3337d23ee813c058c783a3e4341925`) passed as a bounded extended transport/evidence observation and was independently verified offline. For both `cpmm-observation-01` and `cpmm-observation-02`, all 18 manifest-listed files match and offline verification exits `0`, with zero notifications received and all five qualification flags `false`. Live transaction-processing coverage remains outstanding. Live execution remains **NOT_APPROVED** for any further run: earlier approvals are consumed and do not cover further captures. Nothing in this runbook approves a live run. Only `--help`, the dry run and read-only verification may be used.

Entry point: `backend/src/scripts/cpmm-pool-observation.ts` (assessment §8.38.17 item 17 T, roadmap Step 3). It runs the accepted composition core (`cpmm-pool-observation-run.ts`) once for one explicit Raydium CPMM pool and candidate mint. It adds no acquisition, observation, sealing or verification logic of its own. It is observation only: no purchase, order, position, strategy, admission, daemon or paper trading.

## 1. Commands

Run every command from the repository root (`U:\Projects\TopG`). `<POOL>` and `<MINT>` are the exact base58 pool and candidate-mint addresses. `<RUN_ID>` is a new run id.

**Help** (prints usage and the plan with placeholders; nothing loaded, opened or written):

```bash
node backend/node_modules/tsx/dist/cli.mjs backend/src/scripts/cpmm-pool-observation.ts --help
```

**Dry run** (the default without `--live`; no configuration or credential loaded, no transport constructed, no request, nothing written):

```bash
node backend/node_modules/tsx/dist/cli.mjs backend/src/scripts/cpmm-pool-observation.ts --pool <POOL> --mint <MINT> --run-id <RUN_ID> [--profile <short|extended>]
```

It prints the profile label and status, the live status, the plan digest (SHA-256) and the full plan as JSON: target, output directories, the complete effective limits, the budget and the separate local overhead. Specifying `--profile extended` builds and displays the plan under the proposed extended limits.

**Verify a sealed run** (read-only and offline; see §7):

```bash
node backend/node_modules/tsx/dist/cli.mjs backend/src/scripts/cpmm-pool-observation.ts --verify data/research/cpmm-observations/<RUN_ID> --acquisition-dir data/research/cpmm-acquisitions/<RUN_ID>
```

Examples (verifying the accepted Step 5 and Step 6 captures):

```bash
node backend/node_modules/tsx/dist/cli.mjs backend/src/scripts/cpmm-pool-observation.ts --verify data/research/cpmm-observations/cpmm-observation-01 --acquisition-dir data/research/cpmm-acquisitions/cpmm-observation-01
node backend/node_modules/tsx/dist/cli.mjs backend/src/scripts/cpmm-pool-observation.ts --verify data/research/cpmm-observations/cpmm-observation-02 --acquisition-dir data/research/cpmm-acquisitions/cpmm-observation-02
```

For empty-transaction captures like `cpmm-observation-01` and `cpmm-observation-02`, this verification exits `0` (complete evidence).

**Live mode**: `--live` exists so that the acquiring path can be tested offline with injected dependencies. This runbook gives no live command. A live command is to be written only after the profile, or a revised one, is approved in Step 4. `--live` only selects the acquiring mode; it is not, and does not record, operator approval.

## 2. Argument rules

- The modes are `--help` (alone), `--pool --mint --run-id [--profile <short|extended>] [--live]`, and `--verify <observation-dir> --acquisition-dir <acquisition-dir>`. Modes cannot be combined.
- `--profile` optionally selects the observation profile (`short` [default] or `extended`). `--profile` cannot be combined with `--help` or `--verify`. Missing, unknown, or repeated `--profile` values are refused with `[CLI_INVALID_ARG]`. Both profiles remain strictly not approved for live use.
- `--pool` and `--mint` must be canonical base58 encodings of exactly 32 bytes and must differ. There is no discovery, target selection or substitution.
- `--run-id` matches `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` and names both bundles: `data/research/cpmm-acquisitions/<RUN_ID>` and `data/research/cpmm-observations/<RUN_ID>`. If either exists, the run is refused (`[OUTPUT_EXISTS]`) before any configuration is loaded, in the dry run too. Sealed bundles are never overwritten.
- Unknown flags, positional arguments, repeated flags (including `--flag=value` forms) and missing values are refused with fixed text (`[CLI_INVALID_ARG]`). The refusal never echoes an argument.

## 3. Configuration (live only)

- Loaded only in `--live`, after every argument and output check, through the existing daemon configuration loader (`loadDaemonEnvironment`), and resolved by the reviewed endpoint resolver (`resolveSolanaEndpoints`).
- `SOLANA_RPC_URL` must be https and `SOLANA_WS_URL` must be configured explicitly as wss. The stream URL is never derived from the RPC URL. Neither may contain a fragment.
- Refusals are fixed messages (`[MISSING_CONFIGURATION]`, `[INVALID_CONFIGURATION]`) raised before `fetch` or the `ws` client is loaded, before any signal handler is installed and before anything is written.
- Credential values, raw configuration and free exception text are never printed. Only refusals the entry point creates itself are printed as text; an error's own prefix is never trusted. A failing dependency gets a fixed refusal with its error text withheld: `[CONFIGURATION_LOAD_FAILED]` (the configuration loader), `[WS_CLIENT_LOAD_FAILED]` (the `ws` client) or `[SIGNAL_INSTALL_FAILED]` (a signal listener). Any other error prints only `[UNEXPECTED_ERROR]`. The core redacts both endpoint URLs from the evidence.

## 4. Proposed profiles (not approved)

### Short profile `PROPOSED_SHORT_OBSERVATION_PROFILE_V1` (default)

These are the complete effective limits the core receives in `--live` with `--profile short`; nothing is overridden at run time. The dry run prints the same values.

| Group              | Proposed values                                                                                                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session            | lifetime 105,000 ms; 10 HTTP attempts; request timeout 10,000 ms                                                                                                                                                                                                                                       |
| Lanes              | `SOLANA_RPC` 10 attempts, pacing 2,500 ms, 262,144 bytes per response; `RUGCHECK`, `SOLANA_TRACKER` and `DEXSCREENER` 0 attempts                                                                                                                                                                       |
| Acquisition        | duration 15,000 ms; timeout 5,000 ms; 16,384 bytes per response                                                                                                                                                                                                                                        |
| Connection owner   | observation 60,000 ms; subscribe ack 10,000 ms; unsubscribe ack 5,000 ms; ping every 20,000 ms; pong 5,000 ms; 3 pings; 4 pong replies; 16 control frames of at most 125 bytes; 4 outstanding retrievals; 8 retained unprocessed; drain 20,000 ms; cleanup 5,000 ms                                    |
| WebSocket wrapper  | 65,536 bytes per frame; 16 fragments; 64 buffered chunks; handshake 5,000 ms; close 5,000 ms                                                                                                                                                                                                           |
| Collector          | 65,536 bytes per frame; 128 frames and 1,048,576 bytes per epoch; 129 retained frame records; 128 retained notifications; 1 epoch                                                                                                                                                                      |
| Ledger             | 128 signature records; 4 duplicate details per record; 1 epoch                                                                                                                                                                                                                                         |
| Transaction source | 128 tracked signatures; 262,144 bytes per response                                                                                                                                                                                                                                                     |
| Evidence recorders | 10 pending exchange evidence; observation recorder: 160 incoming records (1,048,576 bytes), 8 outgoing (8,192 bytes), 64 control (8,192 bytes), 128 lifecycle, 16 exchanges (2,621,440 body bytes), 256 ledger calls, 16 instrumentation failures, 262,144 bytes per record, 200,000 finish-copy nodes |
| Fan-out            | 8 retained failures                                                                                                                                                                                                                                                                                    |
| Run constants      | epoch 1; subscribe request id 1; unsubscribe request id 2                                                                                                                                                                                                                                              |

### Extended profile `PROPOSED_EXTENDED_OBSERVATION_PROFILE_V1`

Selected via `--profile extended`. Both profiles remain strictly not approved for live use.

| Group              | Proposed extended values                                                                                                                                                                                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session            | lifetime 350,000 ms; 30 HTTP attempts; request timeout 10,000 ms                                                                                                                                                                                                                                         |
| Lanes              | `SOLANA_RPC` 30 attempts, pacing 2,500 ms, 262,144 bytes per response; `RUGCHECK`, `SOLANA_TRACKER` and `DEXSCREENER` 0 attempts                                                                                                                                                                         |
| Acquisition        | duration 15,000 ms; timeout 5,000 ms; 16,384 bytes per response                                                                                                                                                                                                                                          |
| Connection owner   | observation 300,000 ms; subscribe ack 10,000 ms; unsubscribe ack 5,000 ms; ping every 20,000 ms; pong 5,000 ms; 16 pings; 16 pong replies; 36 control frames of at most 125 bytes; 4 outstanding retrievals; 8 retained unprocessed; drain 25,000 ms; cleanup 5,000 ms                                   |
| WebSocket wrapper  | 65,536 bytes per frame; 16 fragments; 64 buffered chunks; handshake 5,000 ms; close 5,000 ms                                                                                                                                                                                                             |
| Collector          | 65,536 bytes per frame; 256 frames and 2,097,152 bytes per epoch; 257 retained frame records; 256 retained notifications; 1 epoch                                                                                                                                                                        |
| Ledger             | 256 signature records; 4 duplicate details per record; 1 epoch                                                                                                                                                                                                                                           |
| Transaction source | 256 tracked signatures; 262,144 bytes per response                                                                                                                                                                                                                                                       |
| Evidence recorders | 30 pending exchange evidence; observation recorder: 320 incoming records (2,097,152 bytes), 16 outgoing (16,384 bytes), 64 control (8,192 bytes), 128 lifecycle, 32 exchanges (8,388,608 body bytes), 512 ledger calls, 16 instrumentation failures, 262,144 bytes per record, 400,000 finish-copy nodes |
| Fan-out            | 8 retained failures                                                                                                                                                                                                                                                                                      |
| Run constants      | epoch 1; subscribe request id 1; unsubscribe request id 2                                                                                                                                                                                                                                                |

Values in the offline tests are test inputs, not approved live limits.

## 5. Budget

**Session lifetime** (one shared lifetime, never extended): acquisition 15,000 + observation 60,000 + unsubscribe ack 5,000 + max(drain 20,000, cleanup 5,000) = 100,000 ms, plus a 5,000 ms margin = 105,000 ms.

**Requests** (one shared budget, never reset; no retries):

| Use                    | Attempts                                                                 |
| ---------------------- | ------------------------------------------------------------------------ |
| Account acquisition    | 2 `getMultipleAccounts` (discovery, then the paced snapshot)             |
| Transaction retrievals | at most 8 `getTransaction` (what remains), serialized on the lane        |
| Other lanes            | 0                                                                        |
| **Session ceiling**    | **10**                                                                   |
| WebSocket              | 1 connection, 1 subscription; no reconnect, retry, fallback or follow-up |

**Outstanding limit** (the owner's 4 outstanding retrievals): the owner reserves a slot for every notification it hands to the ledger, before the ledger knows whether the signature is a duplicate. The limit therefore counts hand-offs that have not settled, not requests. A fifth hand-off while four are unsettled ends the run with `PROCESSING_OVERFLOW:OUTSTANDING_LIMIT` (exit 3), even if all five are duplicates that need no request. Notifications that arrive in the same tick count together. With retrievals serialized and paced at 2,500 ms, a run can finish cleanly only on a quiet pool: at most 8 distinct swaps in the observation window, and never a fifth hand-off while four are unsettled. A busy pool ends with truthful, sealed evidence and no excess request (rehearsal findings F1 and F4).

**Local sealing and verification** (file writes and offline re-derivation; no request or connection):

- The **acquisition** bundle is sealed and verified after the snapshot and before observation, while the shared session lifetime runs. That time uses the lifetime: observation starts only if the remaining lifetime still covers the owner's ceiling, so a slow seal ends the run at the stage boundary (`SESSION_LIFETIME_INSUFFICIENT`, or `SESSION_STOPPED` once the lifetime has run out) instead of extending anything.
- The **observation** bundle is sealed and verified after the session has shut down. That time is outside the session lifetime.
- The evidence limits (the sanitizer's 8,388,608 bytes per file; the verifier's 1,048,576-byte manifest, 8,388,608 bytes per file, 268,435,456 bytes in total and 4,096 entries) bound the data written and read, not the time taken. There is no hard wall-clock bound on local sealing and verification.
- The **shutdown fallback** is separate: once the result is known, the exit code is set and the process drains. Only a process still alive 5,000 ms later is forced to exit, with the same code and `[CPMM_POOL_OBSERVATION_SHUTDOWN_FORCED]`. It does not bound sealing or verification, which finish before the result.

## 6. Outcome reporting and exit codes

A live run prints separate lines for the execution status and first failure, the clock failure and cancellation, cleanup failures, the entry point's own cleanup failures (`SIGNAL_REMOVE_FAILED:<signal>`), the session stop reason and the owner's terminal cause, the request counts (HTTP attempts, acquisition requests, transaction retrievals, WebSocket connections), each bundle's path and seal, acquisition integrity and computed outcome, observation integrity, retention, re-derivation, the acquisition binding and the five qualification flags (all `false`). The last line is the same report as JSON. The run then ends: no follow-up, retry or reacquisition.

| Code | Meaning                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | Help, dry run, or a successful run with complete, reproduced evidence (for `--verify`: complete evidence, including zero-transaction captures)   |
| 1    | Invalid arguments, configuration, output location or setup refusal (nothing written), or unexpected error                                        |
| 2    | Evidence intact but limited (incomplete retention, or transaction responses present but re-derivation not reproduced due to missing credentials) |
| 3    | The run failed; its evidence is intact                                                                                                           |
| 4    | Evidence not verified (integrity, acquisition binding or a re-derivation mismatch)                                                               |
| 5    | A bundle could not be sealed; nothing is reacquired                                                                                              |
| 6    | Cancelled (Ctrl+C or termination); the evidence is intact                                                                                        |
| 7    | The run would have exited 0 or 2, but a signal listener could not be removed                                                                     |

A sealing failure takes precedence over evidence that does not verify, which takes precedence over cancellation, then a failed run, then limited evidence. A listener that could not be removed replaces only 0 and 2 (with 7); every other code is kept and the failure is still reported.

**Cancellation**: while the core runs, SIGINT and SIGTERM abort its signal (printing `[LIVE] <signal> received` once); the core then settles, seals and verifies what it has. The listeners exist only while the core runs. On every exit, removal is attempted for every listener whose registration was attempted, including one that attached and then threw, and a failed removal does not stop the others. A failed removal is reported as `SIGNAL_REMOVE_FAILED:<signal>` in the entry-point cleanup line and in the JSON report (`entryPoint.signalCleanupFailures`); the core's result and evidence are reported unchanged. A listener left attached does nothing after the run. If installing a listener fails, the core never runs and the refusal is `[SIGNAL_INSTALL_FAILED]` (exit 1), naming any failed removal.

## 7. Verification and its limitation

`--verify` reads both bundles and writes nothing. It loads no configuration or credential.

- **Empty-transaction capture**: when an observation captures zero transaction responses (e.g. `cpmm-observation-01` or `cpmm-observation-02`, where zero pool notifications arrived and no transaction retrievals were dispatched), no transaction re-analysis is required. All implemented components (collector, ledger, transport, owner report, pool context) are reproduced, retention is complete, and offline verification exits `0` (`complete evidence`).
- **Capture with transaction responses**: when an observation contains transaction responses, re-analysing them without the run's provider credentials is unavailable (`ANALYSIS_CREDENTIALS_NOT_SUPPLIED`). Because transaction outcomes are not re-decoded offline, an otherwise intact bundle verifies as limited (exit `2`).

Integrity, retention and the acquisition binding are checked in both cases. A missing, altered or different acquisition bundle does not bind (exit 4).

Retention covers only what reached the recorder. A frame that the WebSocket wrapper or the `ws` client refuses (an oversized frame or control payload) is never recorded, so retention can read complete while the run failed. Such a refusal shows in `transport-diagnostics.json` (`refusedPayloadLimit`, `control.refused`) and in the owner's terminal cause, and the run exits 3 (rehearsal finding F2).

## 8. After a run

1. **Preservation**: do not edit, move or rerun into a sealed directory. A further run needs a new run id and its own approval.
2. **Wallet**: confirm the frozen virtual wallet (`.tmp/virtual-wallet.json`) is unchanged. The entry point never reads or writes it.

## 9. Accepted Step 5 Capture: `cpmm-observation-01`

Roadmap Step 5 was executed under explicit operator approval for run ID `cpmm-observation-01` at commit `ac9d6f2d3836ba2605059c0e7df713e07fa1435c` and accepted by independent offline review.

- **Target**: Raydium CPMM WSOL/USDC pool `47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4`, candidate mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (USDC).
- **Bundles & manifests**:
  - Acquisition bundle: `data/research/cpmm-acquisitions/cpmm-observation-01`, manifest SHA-256 `49273a4fa5b1dfb55c9d8184e3e2e0a711e28d778ea99a5581db68f2d2df8d83` (7 files). Outcome `ACQUIRED`, integrity `VERIFIED`, re-derivation `ACQUIRED_REPRODUCED`.
  - Observation bundle: `data/research/cpmm-observations/cpmm-observation-01`, manifest SHA-256 `f8026f11a99b6a548f91437d2763f01c43836cb8664f5bec21a209e80ec3b845` (11 files). Observation binding `REPRODUCED`.
  - Total: 18 manifest-listed files, byte-identical.
- **Protocol execution**: 60-second observation (`startedAtMs: 1795510166545`, nominal end `1795510226545`, settled `1795510226815`), acknowledged `logsSubscribe` (`149` bytes, `{ mentions: ["47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4"] }`, `confirmed` commitment; ack `42` bytes, subscription ID `51204270`), acknowledged `logsUnsubscribe` (`71` bytes; ack `38` bytes), 2 pings matched by 2 pongs, clean transport closure.
- **Requests & budget**: exactly 2 HTTP account requests (discovery and paced snapshot), 0 transaction retrievals, 1 WebSocket connection. No retries, no secondary requests.
- **Activity**: 0 pool notifications were received during the 60-second observation window. All 5 qualification flags remain `false`.
- **Wallet & verification**: virtual wallet unchanged (`7f2c2353ac2f62cac1bb98703742ab19c74ac5521635af6f49bbe777ad020ed9`). Offline credential-free verification (`--verify`) exits `0`.

## 10. Verified Step 6 Capture: `cpmm-observation-02`

Roadmap Step 6 was executed under separate operator approval for run ID `cpmm-observation-02` (`--profile extended`) via `.tmp/runbooks/cpmm-observation-02-operator.ps1` (SHA-256 `4d92f7825e91eb7ad7749afb78e362ced4a7e9d8338c886832ce53ef3ab92b8d`) at commit `0002d0b18e3337d23ee813c058c783a3e4341925`, and passed independent verification as a bounded extended transport/evidence observation.

- **Target**: Raydium CPMM WSOL/USDC pool `47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4`, candidate mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (USDC).
- **Bundles & manifests**:
  - Acquisition bundle: `data/research/cpmm-acquisitions/cpmm-observation-02`, manifest SHA-256 `960b66a19d8a7a74e5391af896febe546d8558b90f0c5852798a8a5e49a0af5f` (7 files). Outcome `ACQUIRED`, integrity `VERIFIED`, re-derivation `ACQUIRED_REPRODUCED`, snapshot slot `473455432`.
  - Observation bundle: `data/research/cpmm-observations/cpmm-observation-02`, manifest SHA-256 `ee813da654c2fc7c090d789827f93cc1acfceab827cb15257adb58afa2fbaaeb` (11 files). Binding `REPRODUCED`, retention `COMPLETE`.
  - Total: 18 manifest-listed files, byte-identical.
- **Protocol execution**: 300-second nominal window (`startedAtMs: 1795547184385`, nominal end `1795547484385`, `UNSUBSCRIBE_RESPONSE` at `1795547484531`, settled `1795547484667`), acknowledged `logsSubscribe` (`149` bytes, `{ mentions: ["47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4"] }`, `confirmed` commitment; ack `42` bytes, subscription ID `55625496`), acknowledged `logsUnsubscribe` (`71` bytes; ack `38` bytes), 14 client pings matched by 14 pongs (recorder control `42/42`), normal `1000` close, zero cleanup failures.
- **Requests & budget**: exactly 2 HTTP account requests (`getMultipleAccounts` on `SOLANA_RPC`), 0 transaction retrievals, 1 WebSocket connection. No retries, reconnects, or secondary requests.
- **Activity & remaining gap**: 0 pool notifications received, 0 transaction retrievals, 0 decoded swaps; all 5 qualification flags remain `false`. Live transaction-processing coverage remains outstanding.
- **Offline binding audit & next prerequisite**: Offline inspection confirms the wire subscription matches `poolAddress` (which `RaydiumCpmmSwapDecoder` requires at swap instruction account index 3) and that cumulative protocol fees/reserves shifted on this pool between `01` (slot `473283318`) and `02` (slot `473455432`), while effective depth remained small (`~163.06` USDC / `~2.35` WSOL). Zero notifications establishes only that no matching events arrived during the window (not pool dormancy or provider fault). Before another capture is proposed, a bounded single-page activity/target check (assessment §8.38.20) is needed to screen for quiet-to-moderate recent cadence (`~1`–`4`/min, burst `<= 4`) while strictly separating activity metadata, received notifications, and verified swaps.
- **Wallet & verification**: virtual wallet unchanged (`7f2c2353ac2f62cac1bb98703742ab19c74ac5521635af6f49bbe777ad020ed9`). Both sealed operator scripts (`01` and `02`) remain preserved and consumed. Offline credential-free `--verify` exits `0`.

## 11. Pre-Capture Bounded Activity-Page Checker (Not Approved for Live Use)

Entry point: `backend/src/scripts/cpmm-pool-activity-check.ts` (assessment §8.38.20). Dispatches at most one HTTP `getSignaturesForAddress` query (`limit: 20`, `confirmed` commitment, 10 s deadline, 64 KiB cap) for an explicit pool address, with zero transaction retrievals, zero DexScreener lookups, zero WebSockets, zero pagination, and zero retries. Live execution is **NOT_APPROVED**; only `--help`, the inert dry run, and offline `--verify` may be used:

```bash
node backend/node_modules/tsx/dist/cli.mjs backend/src/scripts/cpmm-pool-activity-check.ts --help
node backend/node_modules/tsx/dist/cli.mjs backend/src/scripts/cpmm-pool-activity-check.ts --pool <POOL> --out-dir data/research/cpmm-activity-checks/<RUN_NAME>
node backend/node_modules/tsx/dist/cli.mjs backend/src/scripts/cpmm-pool-activity-check.ts --verify data/research/cpmm-activity-checks/<RUN_NAME>
```

Offline-review hardening (`AC14`–`AC18`): CLI parser errors return fixed refusal text without echoing positional URLs or unknown options; acquisition is gated by one 10-second wall window whose deadline (`deadlineAtMs`) bounds every session/request timer across startup, `open()`, and `dispatch()` delays; malformed `blockTime` (> `8_640_000_000_000`) or deeply nested/oversized `err` structures (> depth `32` or > `1_024` nodes) seal `MALFORMED_RESPONSE` (`exit 3`); and `--verify` enforces `lstatSync` non-link/regular-file/size caps (`64 KiB` manifest, `512 KiB` artifacts) before reading any bytes. Pin-only verification requires `paper-pilot-handoff.ts --pin-only --pinned-commit <COMMIT>`.

## 12. Accepted Pre-Capture Check: `cpmm-activity-check-01` and Target Review

Approved pre-capture activity check `cpmm-activity-check-01` executed via `.tmp/runbooks/cpmm-activity-check-01-operator.ps1` (SHA-256 `e5d5535063315bd305d97d5dfb806c6641843171ffbeddb2ff300ed6b819d4ae`) at commit `c6920a407c0042959bfa42483357acc39363d17a` and was accepted by independent review. That operator approval is now **consumed**.

- **Bundle & verification**: `data/research/cpmm-activity-checks/cpmm-activity-check-01` (`evidence-manifest.json` SHA-256 `1cd1c6a7fd069170b7e7f170e0808e21d52dce54250e7dfb01504c41f5cf7312`); `PAGE_RECEIVED`, integrity `OK`, offline reanalysis `REPRODUCED`, exits `0`. Wallet unchanged (`7f2c2353ac2f62cac1bb98703742ab19c74ac5521635af6f49bbe777ad020ed9`).
- **Observed metadata**: 1 `getSignaturesForAddress` request; 20 records returned (`13` succeeded, `7` failed `InstructionError: [0, { Custom: 1 }]`, `0` null `blockTime`, `maxPerSlot: 1`); returned `blockTime` span `2026-11-24 17:46:57`–`22:05:30` UTC (`15,513` s $\approx$ `4.31` hours; `13` succeeded records span `13,428` s across `12` gaps for a mean succeeded interval of `18.65` min; newest record `1,322` s old at check start `22:27:32.770Z`).
- **Alignment with Captures `01` & `02`**: No returned `blockTime` falls inside Capture `02`'s nominal window (`19:06:24`–`19:11:24` UTC; nearest straddled records at `19:04:52Z` and `19:31:21Z`), and Capture `01` (`08:49:26`–`08:50:26` UTC) predates the oldest returned record (`17:46:57Z`) so the returned page cannot explain Capture `01`.
- **Limitations**: Full page of 20 is potentially truncated; all 9 `nonCertifications` remain `false` (no verified swaps, complete history, provider fault, or qualification established).
- **Target decision & smallest next step (planning only)**: Do not repeat an extended observation on `47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4`. Public read-only research (`2026-11-24T22:51:58Z`–`59Z`, assessment §8.38.21) shortlisted three WSOL-paired Raydium CPMM candidates and recommends `USELESS` / WSOL (`Q2sPHPdUWFMg7M7wwrQKLrn619cAucfRsmhVJffodSp`, candidate mint `Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk`) for one separately approved single-page check via `cpmm-pool-activity-check.ts`. Recency/cadence thresholds are selection heuristics (never guarantees of future notifications, successful capture, retention sufficiency, or qualification); `maxPerSlot <= 4` does not bound outstanding handoffs because different-slot notifications, delayed delivery, duplicates, or slow serialized retrievals can still overflow the four-handoff limit; and existing extended limits (`300 s`, `30` HTTP attempts / up to `28` retrievals at `2,500 ms` spacing, `4` outstanding handoffs) remain hard ceilings with possible early refusal. No operator wrapper or live execution is created or approved.

## 13. Accepted Pre-Capture Check: `cpmm-activity-check-02` (`CYBERLEEK/WSOL`)

Independent review selected `CYBERLEEK/WSOL` after refreshed public metadata (`2026-11-24T23:02:13Z`, provisional selection clues only) reported `3` tx over `5m` and `58` over `1h`. Approved check `cpmm-activity-check-02` executed at commit `70d16467ad91c80325361d4c4575b6b02ee5059c` via `.tmp/runbooks/cpmm-activity-check-02-operator.ps1` (SHA-256 `1fd370ae4c4d879bb59099967722f26d4179af7291303cdf7b831e852ba703b7`) and was accepted by independent review. That metadata-check approval is now **consumed**.

- **Bundle & verification**: Pool `G8kgi7aUpeX8EVR8VMkrth9SKEv5BietWC33UjAiiMGh` (ref mint `ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg`), `data/research/cpmm-activity-checks/cpmm-activity-check-02` (`evidence-manifest.json` SHA-256 `8e7a119b47871737086fa460394af3269929d49380eebd0cbd23a12b91c02d7b`); `PAGE_RECEIVED`, integrity `OK`, reanalysis `REPRODUCED`, exits `0`. Wallet unchanged (`7f2c2353ac2f62cac1bb98703742ab19c74ac5521635af6f49bbe777ad020ed9`).
- **Observed metadata**: 1 `getSignaturesForAddress` request; `20` records (`18` succeeded, `2` failed `InstructionError: [1, { Custom: 1 }]`, `0` null `blockTime`), `20` distinct slots (`maxPerSlot: 1`); returned `blockTime` range `2026-11-24T23:42:45Z`–`23:57:19Z` (`874` s span); check started `23:58:17.902Z` (newest record age `58` s).
- **Limitations**: Full page of `20` is potentially truncated; all nine `nonCertifications` remain `false`. These facts do not establish future notification capacity, verified swaps, complete history, or qualification (different-slot notifications, delayed delivery, duplicates, and slow serialized retrievals can still overflow the 4-handoff ceiling).

## 14. Bounded Diagnostic Capture: `cpmm-observation-03` & Solana v1 (`SIMD-0385`) Next-Step Design

Approved extended capture `cpmm-observation-03` on `CYBERLEEK/WSOL` (`G8kgi7aUpeX8EVR8VMkrth9SKEv5BietWC33UjAiiMGh`, candidate mint `ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg`) executed at commit `9873edae6d0823e7edf5cf6307beb6c977c97a10` via `.tmp/runbooks/cpmm-observation-03-operator.ps1` (SHA-256 `fa9dec6f8fccf53d7d7e50f82a041c2481ef7380675ca1805ececbc64376ee2e`) and was accepted by independent review as a **bounded diagnostic capture**. This capture approval is now **consumed**.

- **Bundles & integrity**: Acquisition `data/research/cpmm-acquisitions/cpmm-observation-03` (`57f6f2329ca20d8e5df72ef167f609e58ddb13e0072b0bc9abdbf7d8390a84eb`, `7` files) and observation `data/research/cpmm-observations/cpmm-observation-03` (`12f5fac06c54ba51d17e845a2e607ca8cfa72bf1566440851946a73cf8757f0e`, `16` files). Retention `COMPLETE`; **all `23` manifest-listed files match**. Wallet unchanged (`7f2c2353ac2f62cac1bb98703742ab19c74ac5521635af6f49bbe777ad020ed9`).
- **Execution & decoded findings**: Five-minute (`300 s`, `2026-11-25T00:18:28.234Z`–`00:23:28.234Z`) observation completed cleanly (`14` matching ping/pong exchanges, acknowledged unsubscribe, zero cleanup failures). `5` notifications; `7` HTTP requests (`2` acquisition + `5` `getTransaction` retrievals `000003.json`–`000007.json`).
  - `000003.json` (`seq: 3`, sig `39suvMcMTQeQoqPH2CD4StqZoDLD3Vr6c6ZaF1WBzuwBC1CGmtyBnhZ5WgoHXoVUnWn4FJo6vYnnwQjczJ51f7mF`, `version: 0`, slot `473542878`): produced `1` decoded swap accepted by the tracker (`INGESTED: 1`); credentialed live execution + pure-decoder cross-check reproduced it (`Exit code 0`).
  - `000004.json`–`000007.json` (`seq: 4`–`7`): retained HTTP `200` JSON-RPC error `-32015` responses (`transaction version 1` rejected against requests capped at `"maxSupportedTransactionVersion": 0`), recorded as `UNRESOLVED` / `TRANSACTION_UNAVAILABLE` (`RPC_ERROR` / `JSON_RPC_ERROR`).
- **Verification mode & qualification status**: Credential-free `--verify` exits **`2`** (`ANALYSIS_CREDENTIALS_NOT_SUPPLIED`)—it verifies manifests/retention/binding (`ACQUIRED_REPRODUCED`, `REPRODUCED`) but skips transaction-response re-analysis (`transaction analysis UNAVAILABLE`) and must **not** be reported as full transaction-analysis reproduction. **All qualification flags remain `false`.**
- **Proposed smallest Solana v1 (`SIMD-0385`) change before another live capture** (full audit in assessment §8.38.23):
  1. **Decoder (`RaydiumCpmmSwapDecoder.ts`)**: Extend `version` check (`"legacy" | 0 | 1`); branch `version === 1` separately in `resolveAccounts()` (SIMD-0385 has no `addressTableLookups` and empty `meta.loadedAddresses`, matching `"legacy"`, unlike the current `v0` `else` branch); validate `message.transactionConfig` (`UiTransactionConfig` `{ priorityFee, computeUnitLimit, loadedAccountsDataSizeLimit, heapSize }`, forbidden on `"legacy"`/`0`); ignore v1 `ComputeBudgetProgram` no-op instructions.
  2. **Adapter & Evidence Verifier (`RaydiumCpmmTransactionSourceAdapter.ts`, `cpmm-pool-observation-evidence.ts`)**: Keep `CPMM_GET_TRANSACTION_CONFIG` (`maxSupportedTransactionVersion: 0`) intact and add `CPMM_GET_TRANSACTION_V1_CONFIG` (`maxSupportedTransactionVersion: 1`), gating `expectedRequestBody` by evidence schema version (preserving schema v1/v2 `maxSupportedTransactionVersion: 0` so `cpmm-observation-03` does **not** fail with `MISMATCH:REQUEST_BODY`, while enforcing `1` on schema v3+).
  3. **Tests & Fixture Provenance**: Add regression tests preserving `"legacy"`/`0` + historical `03` replay, rejecting unknown/malformed versions or invalid `v1` fields, and testing a synthetic `SIMD-0385` `v1` payload. Note explicitly that `000004.json`–`000007.json` hold only `-32015` errors (zero v1 payload); synthetic `v1` test fixtures must never be presented—and relabelled `v0` fixtures must never be substituted—as genuine observed `v1` mainnet evidence.

## 15. Solana v1 (`SIMD-0385`) Compatibility: Implemented Offline

This implements the §14 design. Full detail is in assessment §8.38.24. All work was offline: no RPC, socket, credential read, live execution or operator packet. No capture was modified. All qualification flags remain `false`.

- **Request policy:**
  - `CPMM_GET_TRANSACTION_CONFIG` (cap `0`) is preserved for historical evidence.
  - New runs send `CPMM_GET_TRANSACTION_V1_CONFIG` (cap `1`), exported as `CPMM_RUN_TRANSACTION_REQUEST`.
  - The adapter's `maxSupportedTransactionVersion` is required, and response versions are bound to it: cap 0 accepts legacy/v0; cap 1 accepts legacy/v0/v1. A contradictory or unknown version is `UNRESOLVED` / `UNSUPPORTED_TRANSACTION_VERSION`.
- **Decoder:**
  - v1 is static-only: no `addressTableLookups`, and `loadedAddresses` empty.
  - `transactionConfig` must have exactly four keys, with `null` when unset; it is forbidden on legacy/v0.
  - SIMD-0385 limits are enforced: 12 signatures, 64 accounts, 64 instructions, 255 accounts per instruction, 4,096 bytes recomputed exactly, and the heap range.
  - Application limit: `priorityFee` must be at most `Number.MAX_SAFE_INTEGER`.
  - Sources are pinned: SIMD `6cc17538`, Agave `318c00ca` and solana-sdk `7b382f65`.
- **Evidence schemas:**
  - Schema 1: unbound, cap 0.
  - Schema 2: bound, cap 0 (for example, `cpmm-observation-03`).
  - Schema 3: bound, cap 1, with `transactionRequest` stated in the plan and the report. New runs seal schema 3.
  - Every acquisition-bound schema verifies its dependency. Unknown schemas and inconsistent manifest/report/context/plan policies are refused. The policy comes from the manifest and is never inferred from a response.
- **Historical verification:** credential-free verification of captures `01`–`03` is byte-identical before and after the change. Capture `03` still has five cap-0 requests matched and four retained `-32015` exchanges recorded as `RPC_ERROR` / `JSON_RPC_ERROR`. Its transaction analysis is still `UNAVAILABLE` without credentials, which is not full re-analysis.
- **Before any new capture:**
  - ~~Refresh the stale `adapter`/`decoder` component pins.~~ Done in a follow-up commit after independent review accepted `0d3e6de06b4ef384dd5e893f34db7ec52459fc5b`: both now pin `0d3e6de` (verified as the last commit changing each file); the other seven pins were checked and are current. No operator packet has been prepared.
  - Recompute the plan digests: the CLI plan now includes `transactionRequest`.
  - Prepare a separately approved operator packet.

  The v1 fixtures are **synthetic** and are not observed mainnet evidence.

## 16. Bounded Diagnostic Capture `cpmm-observation-04` & Retrospective v1 Retrieval Proposal

Independent review accepted `cpmm-observation-04` (`CYBERLEEK/WSOL`, `--profile extended`) as a **successful bounded diagnostic capture**. It ran at commit `161b24d4e326480338bbe137687067e07eb0be19` via `.tmp/runbooks/cpmm-observation-04-operator.ps1` (SHA-256 `6a0e83cb7fa3c641e89e3e2a41580a5b0eca9fd461923fc2f22b8e66092e7886`). Its approval is **consumed**. Full detail is in assessment §8.38.25.

- **Execution:**
  - Full `300 s` window (`2026-11-27T10:37:20.431Z`–`10:42:20.431Z`).
  - `3` HTTP requests (`2` acquisition, `1` `getTransaction`).
  - `1` WebSocket; `14`/`14` ping/pong; acknowledged unsubscribe; close `1000`; clean shutdown.
  - Wallet unchanged.
- **Evidence:**
  - Acquisition `dddaf814f672ffbf75386619789cdefc911cb17a2ac28216a4807946d8955801`: `VERIFIED` / `ACQUIRED_REPRODUCED`.
  - Observation `916c26ae6ebf15b84f23fcf38140596348b4cb04e1bc095a42bde3924c6783c0`: integrity `OK`, binding `REPRODUCED`.
  - Retention `COMPLETE`.
- **Result:**
  - One corroborated **BUY** from a **version-0** transaction: `1NzN8L6f…`, slot `474519283`, `10,315` lamports in for `683,735,286` base units out.
  - Ingested once; corroborated by the credentialed live re-derivation and an offline pure-decoder cross-check.
- **Policy exercised:** the cap-1 request policy (`maxSupportedTransactionVersion: 1`) and the schema-3 acquisition binding were exercised successfully.
- **Limitations:**
  - Credential-free `--verify` exits `2` (`ANALYSIS_CREDENTIALS_NOT_SUPPLIED`); this is **not** full transaction re-analysis.
  - Genuine v1 payload validation remains **open**: no v1 transaction has been observed.
  - All five qualification flags remain `false`.
- **Proposal, design only (assessment §8.38.26):**
  - What: one bounded retrospective cap-1 `getTransaction` for capture-03 signature `4XcLrDWBcAHkgmK8oF9PqeKitaJy1sNZG2xetTuL8EbazpGjexiCBo2BUGThoV2FgdG8h7AF58imedW2sjtBMimm` (slot `473543189`; `exchanges/000004.json` holds only the cap-0 request and the `-32015` error).
  - Limits: `1` request, `0` WebSocket, `0` retries or fallback, `10 s` timeout, `15 s` session, `256 KiB` response cap.
  - Evidence: sealed as separate supplemental evidence under `data/research/cpmm-retrospective-transactions/`, bound read-only to capture 03's verified manifests, exchange, notification and ledger record.
  - Isolation: never counted as fresh flow, never ingested, never modifying either capture.
  - Not authorized: no implementation, operator command, credential load, request, socket or rerun.

## 17. Retrospective Cap-1 Transaction Tool: Implemented Offline

The §16 design is implemented, with the review's corrections. Full detail is in assessment §8.38.27.

- **Files:** `backend/src/scripts/cpmm-retrospective-transaction.ts`, plus synthetic tests.
- **Not done:** no operator script, credential load, request, socket or execution. Captures and wallet are unchanged, and all qualification flags remain `false`.
- **Request:**
  - At most **one** cap-1 `getTransaction`, for the fixed capture-03 signature `4XcLrDWB…` (owner `SECURITY`, purpose `CPMM_RETROSPECTIVE_GET_TRANSACTION`).
  - Preflight binds capture 03 read-only (manifests, exchange, notification, ledger record, pool). A refusal sends nothing.
  - One absolute `15 s` deadline starts before the session. The `10 s` request timeout is capped by the remaining time, and at most `5 s` of settled cleanup follows.
  - Cancellation and clock failures prevent success through the final decision.
- **Analysis:**
  - Live analysis uses the accepted credential-aware analyzer.
  - Credential-free `--verify` replays the pure decoder plus strict envelope, id, signature, slot and request checks. It does not repeat the credential scan, and it cannot replay redacted, withheld or incomplete bytes.
- **Outcomes:**
  - A bound version-1 payload refused by the decoder stays `UNRESOLVED` and does not establish a decoder defect.
  - `TRANSACTION_FAILED` is separate.
  - JSON-RPC errors, including `-32015`, stay `RPC_ERROR`.
  - The source's version claim is compared only after identity and slot binding.
- **Evidence:** separate, exclusive-create supplemental bundles under `data/research/cpmm-retrospective-transactions/`. They are never fresh flow and never ingested.
- **Validation:**
  - 11/11 synthetic tests; 16/17 targeted mutations caught, and the 17th is equivalent (a redundant timeout cap).
  - The real dry run bound capture 03 (`VERIFIED`) and wrote nothing.
  - The handoff pin allowlist was extended exactly (13/13).
- **Before any execution:** a separate operator packet and explicit operator approval.

- **Review blockers on `989190d` reproduced and fixed** (assessment §8.38.28):
  - **Listener cleanup:** the terminal decision now runs after listener cleanup and re-checks cancellation (including the external signal) and the guarded clock.
  - **Response accounting:** the sealed response is checked against the bounded reader: body state, original/observed/stored bytes, and the 262,144-byte cap.
  - **Timing:** dispatch must be strictly before the deadline; start/dispatch/completion/end ordering and attempt/entry/response presence are checked.
  - **Validation:** 14/14 tests; 26/26 targeted mutations caught after a clean baseline.
  - **Not done:** no operator packet or execution.
- **Two remaining cases on `641ee35` reproduced and fixed** (assessment §8.38.29):
  - **Final clock read:** the terminal decision reads the guarded clock before sampling internal and external cancellation.
  - **Overflow prefix:** `PARTIAL_OVERFLOW` must retain exactly 262,144 original bytes, as the bounded reader does.
  - **Validation:** 16/16 tests; 28/28 targeted mutations caught after an exit-0 baseline.
  - **Not done:** no operator packet or execution.

## 18. Retrospective Retrieval `cpmm-retrospective-tx-01` & Witnessed-History Proposal

Independent review accepted `cpmm-retrospective-tx-01`. It ran once at commit `facddd85e7f4b0c59ae6419e693b350dafac9201` via `.tmp/runbooks/cpmm-retrospective-tx-01-operator.ps1` (SHA-256 `414bb7cf9eb31aae02fb1063afe4f88cc3aa260353f9baa60de7983f7a3755e3`). Full detail is in assessment §8.38.30.

- **Evidence:** manifest SHA-256 `5493be0be933cf26845e6c307f23e4bd9d0434e5d542e86b30478872b403e92f` under `data/research/cpmm-retrospective-transactions/cpmm-retrospective-tx-01`.
- **Request:** exactly **one** HTTP request: a cap-1 `getTransaction` (owner `SECURITY`), completed in 137 ms.
- **Response:** complete **24,580 bytes**, stored unredacted. It is a **version-1** transaction with the expected signature `4XcLrDWB…` at slot `473543189` (`meta.err: null`, static accounts only, all four `transactionConfig` keys present).
- **Result:** one historical **SELL** (`4,400,618,230,899` base units in, `83,488,739` lamports out), decoder logs `CORROBORATED`. This is the first observed genuine v1 payload, and the v1 path decoded it exactly. Broader v1 coverage is still not established.
- **Verification:** integrity `OK`, source `VERIFIED`, replay `REPRODUCED`, offline `--verify` exit `0`. The credential-aware scan is not repeated offline.
- **Unchanged:** no fresh flow and no ingestion. The one-request approval is **consumed**. Captures `03` and `04` and their recorded outcomes are unchanged (capture 03's `000004.json` is still `RPC_ERROR` / `JSON_RPC_ERROR`). The wallet is unchanged, and all qualification flags remain `false`.
- **Proposal, design only (assessment §8.38.31):** CPMM-bound witnessed history and on-chain cutoff evidence, as an isolated, unwired first slice (`CpmmWitnessedHistory.ts`).
  - Cutoff: a sealed `getSlot` → `getBlockTime(slot)` pair.
  - History: then at most 3 newest-first `getSignaturesForAddress` pages (`limit: 20`, `minContextSlot` = cutoff slot, `before` cursors) until a bound anchor appears.
  - Bounds: at most 5 requests, one 30 s deadline, no retries or `until`.
  - Reuse: the AMM enumerator's contract semantics, the evaluator's cutoff rules and assumptions, and the activity check's page analyzer, all unchanged. No AMM v4 context is spoofed.
  - Use: it supplies the CPMM ledger's existing cutoff input and a signature set for a later reconciliation evaluator.
  - Limits: the evidence stays provider-relative, never cryptographic completeness.
  - Not authorized: no implementation, operator command, credential load, request, socket or rerun.

## 19. Step 7 Slice 1 Contract: Witnessed History and Cutoff (For Review)

The implementation contract for the isolated history/cutoff slice is in [`cpmm-witnessed-history-step7-contract.md`](cpmm-witnessed-history-step7-contract.md) (assessment §8.38.32). It covers:

- sequence-based exchange ownership without changing `PaperRequestSession`;
- verified versus supplied facts;
- exact same-slot, null-time and window-boundary rules;
- the bootstrap as a separate one-request operation;
- portable synthetic fixtures.

It was revised after review (contract §11): the bootstrap and enumeration limits are accepted as offline implementation limits only, the null-time rule is simplified, and exactly-once sequence accounting, refusal of overlapping operations, bounded waiting and the final decision boundary are added. Nothing is implemented, run or authorized by it.
