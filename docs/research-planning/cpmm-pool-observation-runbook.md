# CPMM Pool Observation — Operator Runbook

**Status:** the live limits are not approved. The profile `PROPOSED_SHORT_OBSERVATION_PROFILE_V1` has status `PROPOSED_FOR_REVIEW_LIVE_LIMITS_NOT_APPROVED`, and live execution is `NOT_APPROVED` until independent review and the operator-limit review (roadmap Step 4) approve it. Nothing in this runbook approves a live run. Only `--help`, the dry run and the read-only verification may be used. The offline Step 4 rehearsal of this profile is recorded in `cpmm-pool-observation-step4-rehearsal.md`; Step 4 stays under review, and the rehearsal is not approval.

Entry point: `backend/src/scripts/cpmm-pool-observation.ts` (assessment §8.38.17 item 17 T, roadmap Step 3). It runs the accepted composition core (`cpmm-pool-observation-run.ts`) once for one explicit Raydium CPMM pool and candidate mint. It adds no acquisition, observation, sealing or verification logic of its own. It is observation only: no purchase, order, position, strategy, admission, daemon or paper trading.

## 1. Commands

Run every command from the repository root (`U:\Projects\TopG`). `<POOL>` and `<MINT>` are the exact base58 pool and candidate-mint addresses. `<RUN_ID>` is a new run id.

**Help** (prints usage and the plan with placeholders; nothing loaded, opened or written):

```bash
node backend/node_modules/tsx/dist/cli.mjs backend/src/scripts/cpmm-pool-observation.ts --help
```

**Dry run** (the default without `--live`; no configuration or credential loaded, no transport constructed, no request, nothing written):

```bash
node backend/node_modules/tsx/dist/cli.mjs backend/src/scripts/cpmm-pool-observation.ts --pool <POOL> --mint <MINT> --run-id <RUN_ID>
```

It prints the profile label and status, the live status, the plan digest (SHA-256) and the full plan as JSON: target, output directories, the complete effective limits, the budget and the separate local overhead.

**Verify a sealed run** (read-only and offline; see §7):

```bash
node backend/node_modules/tsx/dist/cli.mjs backend/src/scripts/cpmm-pool-observation.ts --verify data/research/cpmm-observations/<RUN_ID> --acquisition-dir data/research/cpmm-acquisitions/<RUN_ID>
```

**Live mode**: `--live` exists so that the acquiring path can be tested offline with injected dependencies. This runbook gives no live command. A live command is to be written only after the profile, or a revised one, is approved in Step 4. `--live` only selects the acquiring mode; it is not, and does not record, operator approval.

## 2. Argument rules

- The modes are `--help` (alone), `--pool --mint --run-id [--live]`, and `--verify <observation-dir> --acquisition-dir <acquisition-dir>`. Modes cannot be combined.
- `--pool` and `--mint` must be canonical base58 encodings of exactly 32 bytes and must differ. There is no discovery, target selection or substitution.
- `--run-id` matches `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` and names both bundles: `data/research/cpmm-acquisitions/<RUN_ID>` and `data/research/cpmm-observations/<RUN_ID>`. If either exists, the run is refused (`[OUTPUT_EXISTS]`) before any configuration is loaded, in the dry run too. Sealed bundles are never overwritten.
- Unknown flags, positional arguments, repeated flags (including `--flag=value` forms) and missing values are refused with fixed text (`[CLI_INVALID_ARG]`). The refusal never echoes an argument.

## 3. Configuration (live only)

- Loaded only in `--live`, after every argument and output check, through the existing daemon configuration loader (`loadDaemonEnvironment`), and resolved by the reviewed endpoint resolver (`resolveSolanaEndpoints`).
- `SOLANA_RPC_URL` must be https and `SOLANA_WS_URL` must be configured explicitly as wss. The stream URL is never derived from the RPC URL. Neither may contain a fragment.
- Refusals are fixed messages (`[MISSING_CONFIGURATION]`, `[INVALID_CONFIGURATION]`) raised before `fetch` or the `ws` client is loaded, before any signal handler is installed and before anything is written.
- Credential values, raw configuration and free exception text are never printed. Only refusals the entry point creates itself are printed as text; an error's own prefix is never trusted. A failing dependency gets a fixed refusal with its error text withheld: `[CONFIGURATION_LOAD_FAILED]` (the configuration loader), `[WS_CLIENT_LOAD_FAILED]` (the `ws` client) or `[SIGNAL_INSTALL_FAILED]` (a signal listener). Any other error prints only `[UNEXPECTED_ERROR]`. The core redacts both endpoint URLs from the evidence.

## 4. Proposed profile `PROPOSED_SHORT_OBSERVATION_PROFILE_V1` (not approved)

These are the complete effective limits the core receives in `--live`; nothing is overridden at run time. The dry run prints the same values.

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

| Code | Meaning                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------- |
| 0    | Help, dry run, or a successful run with complete, reproduced evidence (for `--verify`: complete evidence) |
| 1    | Invalid arguments, configuration, output location or setup refusal (nothing written), or unexpected error |
| 2    | Evidence intact but limited (incomplete retention, or re-derivation not reproduced)                       |
| 3    | The run failed; its evidence is intact                                                                    |
| 4    | Evidence not verified (integrity, acquisition binding or a re-derivation mismatch)                        |
| 5    | A bundle could not be sealed; nothing is reacquired                                                       |
| 6    | Cancelled (Ctrl+C or termination); the evidence is intact                                                 |
| 7    | The run would have exited 0 or 2, but a signal listener could not be removed                              |

A sealing failure takes precedence over evidence that does not verify, which takes precedence over cancellation, then a failed run, then limited evidence. A listener that could not be removed replaces only 0 and 2 (with 7); every other code is kept and the failure is still reported.

**Cancellation**: while the core runs, SIGINT and SIGTERM abort its signal (printing `[LIVE] <signal> received` once); the core then settles, seals and verifies what it has. The listeners exist only while the core runs. On every exit, removal is attempted for every listener whose registration was attempted, including one that attached and then threw, and a failed removal does not stop the others. A failed removal is reported as `SIGNAL_REMOVE_FAILED:<signal>` in the entry-point cleanup line and in the JSON report (`entryPoint.signalCleanupFailures`); the core's result and evidence are reported unchanged. A listener left attached does nothing after the run. If installing a listener fails, the core never runs and the refusal is `[SIGNAL_INSTALL_FAILED]` (exit 1), naming any failed removal.

## 7. Verification and its limitation

`--verify` reads both bundles and writes nothing. It loads no configuration or credential, so the observation's transaction responses are not re-analysed: transaction analysis is reported as unavailable and the implemented components are not reproduced. An intact bundle therefore verifies with exit code 2 (limited), not 0. Integrity, retention and the acquisition binding are still checked. A missing, altered or different acquisition bundle does not bind (exit 4).

Retention covers only what reached the recorder. A frame that the WebSocket wrapper or the `ws` client refuses (an oversized frame or control payload) is never recorded, so retention can read complete while the run failed. Such a refusal shows in `transport-diagnostics.json` (`refusedPayloadLimit`, `control.refused`) and in the owner's terminal cause, and the run exits 3 (rehearsal finding F2).

## 8. After a run

1. **Preservation**: do not edit, move or rerun into a sealed directory. A further run needs a new run id and its own approval.
2. **Wallet**: confirm the frozen virtual wallet (`.tmp/virtual-wallet.json`) is unchanged. The entry point never reads or writes it.
