# PAPER Single-Candidate Diagnostic — Operator Runbook

**Status:** live execution is `LIVE_EXECUTION_AWAITING_SEPARATE_OPERATOR_APPROVAL`. Nothing in this runbook approves a live run or its limits. Only the dry run and the read-only verification may be used without a separate, explicit operator approval.

Runner: `backend/src/scripts/paper-single-candidate-diagnostic.ts` (assessment §8.35). It drives the accepted `PaperSingleCandidateCoordinator` for one fixed Raydium AMM v4 pool and its candidate mint, and stops at entry confirmation or another terminal outcome. It is decision-only: it makes no buy, opens no position, places no order and changes no wallet.

## 1. Commands

Run every command from the repository root (`U:\Projects\TopG`). `<POOL>` and `<MINT>` are the exact base58 pool and candidate-mint addresses. `<new-run-name>` must be a directory that does not exist yet.

**Dry run** (the default; no configuration loaded, no socket, no request, nothing written):

```bash
node backend/node_modules/tsx/dist/cli.mjs backend/src/scripts/paper-single-candidate-diagnostic.ts --pool <POOL> --mint <MINT> --out-dir data/research/single-candidate/<new-run-name>
```

**Live run** (proposed; **awaiting separate operator approval**; do not run until approved):

```bash
node backend/node_modules/tsx/dist/cli.mjs backend/src/scripts/paper-single-candidate-diagnostic.ts --pool <POOL> --mint <MINT> --out-dir data/research/single-candidate/<new-run-name> --live
```

**Verify a sealed run** (read-only; no configuration, no network; exit code 0 only if the manifest matches):

```bash
node backend/node_modules/tsx/dist/cli.mjs backend/src/scripts/paper-single-candidate-diagnostic.ts --verify data/research/single-candidate/<run-name>
```

## 2. Argument rules

- `--pool`, `--mint` and `--out-dir` are required. Both addresses must be canonical base58 and must differ. Unknown flags, positional arguments and repeated flags (including `--flag=value` forms) are refused (`[CLI_INVALID_ARG]`), so a second `--pool` cannot silently replace the first.
- `--live` and `--dry-run` together are refused. Without `--live` the run is a dry run.
- `--out-dir` must resolve strictly inside `data/research/single-candidate/` (not the directory itself, no traversal outside it) and must not exist (`[OUTPUT_EXISTS]`). Historical captures are never overwritten. One run per new directory; there are no retries and no reruns.
- There is no target substitution and no discovery: the market response must contain exactly the requested pool, on Solana, as a Raydium AMM v4 pair with the candidate mint as base and WSOL as quote. Anything else ends the run at intake (`INTAKE_REJECTED`).

## 3. Prerequisites (live only)

- `SOLANA_RPC_URL` (http or https; the WebSocket URL is derived as ws or wss) and `SOLANA_TRACKER_API_KEY`, loaded through the existing daemon configuration loader (`loadDaemonEnvironment`). Missing values stop the run before any request (`[MISSING_CONFIGURATION]`).
- Values are never printed or persisted. Every evidence file is redacted, and the seal is refused (`[SEAL_REFUSED]`) if any secret remains in the content.
- The operator should first run the dry run with the same arguments and keep its printed plan. The live run seals its own `plan.json` and prints its plan digest. The plan includes `mode`, so the two digests differ; every other plan field (target, output directory, endpoints, limits, allocation, stop conditions, boundaries) must be identical.

## 4. Proposed limits (not approved)

| Group           | Proposed values                                                                                                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session         | lifetime 600,000 ms; 340 attempts; request timeout 10,000 ms                                                                                                                                                                                                                                                  |
| Solana RPC lane | 320 attempts; pacing 2,500 ms; 262,144 bytes per response                                                                                                                                                                                                                                                     |
| RugCheck lane   | 6 attempts; pacing 5,000 ms; 4,194,304 bytes                                                                                                                                                                                                                                                                  |
| Solana Tracker  | 6 attempts; pacing 5,000 ms; 1,048,576 bytes                                                                                                                                                                                                                                                                  |
| Market lane     | 9 attempts; pacing 1,000 ms; 262,144 bytes                                                                                                                                                                                                                                                                    |
| Flow            | lifetime 600,000 ms; 300 HTTP attempts; 60 notifications; 60 retrievals; 1 reconnect; 4 retrievals per cycle; queue 13; pacing 2,500 ms; timeout 5,000 ms; 262,144 bytes; ack 5,000 ms; ping every 20,000 ms; pong 10,000 ms; 32 pings; 80 WebSocket messages; 1,048,576 bytes per message; 80 control frames |
| Loader          | LP acquisition timeout 30,000 ms; 6 loads                                                                                                                                                                                                                                                                     |
| Cache           | 6 refreshes                                                                                                                                                                                                                                                                                                   |
| Schedule        | prefetch lead 6,000 ms; confirmation delay 5,000 ms; decision interval 5,000 ms; decision lead 1,500 ms; refresh horizon 10,000 ms; tick 250 ms; 8 decisions; 2 prefetch epochs                                                                                                                               |

Values in the offline tests (for example 150,000 ms lifetimes) are test limits, not approved live limits.

## 5. Worst-case request allocation

The runner computes this from the limits and refuses to plan (`[PLAN_INVALID]`) if any lane or the session cannot hold it.

| Lane           | Allocation                                                                                                            | Ceiling |
| -------------- | --------------------------------------------------------------------------------------------------------------------- | ------- |
| Solana RPC     | flow 300 (the one reconnect draws on the same budget) + security 3 per load × 6 loads (LP pool, LP batch, mint) = 318 | 320     |
| RugCheck       | 1 per load × 6 = 6                                                                                                    | 6       |
| Solana Tracker | 1 per load × 6 = 6                                                                                                    | 6       |
| Market         | 1 intake + 8 decisions = 9                                                                                            | 9       |
| **Session**    | **339**                                                                                                               | **340** |

At 2.5 s pacing the Solana lane can carry at most about 240 requests in the 600 s lifetime, so the session deadline binds before the flow attempt ceiling.

## 6. Stop conditions

The run ends at the first of: `ENTRY_CONFIRMED_NO_EXECUTION` (confirmation; no buy, no position); `CANDIDATE_DROPPED`; `INTAKE_REJECTED`; `SECURITY_REFRESH_BUDGET_EXHAUSTED` or `DECISION_BUDGET_EXHAUSTED_WHILE_ARMED`; `FLOW_COLLECTION_ENDED`; `REQUEST_SESSION_STOPPED` (deadline, first 429, any redirect, shared ceiling); `OPERATOR_INTERRUPT` (Ctrl+C). After a stop, timers and sockets are cleaned up and the evidence is sealed. Failed and interrupted runs are sealed too.

## 7. Evidence

Written to the new output directory with exclusive-create writes:

| File                     | Contents                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `plan.json`              | the full plan (target, endpoints without credentials, limits, allocation, boundaries)        |
| `report.json`            | the coordinator report and stop reason                                                       |
| `summary.json`           | flow qualification and strategy acceptance, reported separately; request totals by lane      |
| `request-ledger.json`    | the shared session ledger, attempts by lane and refusals by reason                           |
| `decisions.json`         | every decision, with decision-time age                                                       |
| `disarms.json`           | every disarm                                                                                 |
| `market-responses.json`  | bounded market responses with their parse outcome                                            |
| `security-evidence.json` | the security evidence cache state                                                            |
| `flow-evidence.json`     | flow status and snapshot results                                                             |
| `evidence-manifest.json` | SHA-256 and size of every file, the report reference, the plan digest and the approval label |

`summary.json` keeps `flowQualification` apart from `strategyAcceptance`. A qualified flow snapshot does not mean the strategy accepted the candidate, and `executed` is always `NONE (decision-only: no buy, no position)`.

## 8. After a run

1. Run the verification command; it reports `MISSING:`, `MODIFIED:`, `UNLISTED:`, `REPORT_NOT_LISTED` or `MANIFEST_MISSING` problems.
2. Do not edit, move or rerun into a sealed directory. A further run needs a new directory and its own approval.
3. Confirm the frozen virtual wallet (`.tmp/virtual-wallet.json`) is unchanged; the runner never reads or writes it.
