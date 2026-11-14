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

**Verify a sealed run's integrity** (read-only; no configuration, no network; exit code 0 only if every integrity check passes). This is integrity verification only: matching hashes show the files are as sealed, not that the decisions or the strategy were re-validated (see §8):

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
- Values are never printed or persisted:
  - **Evidence files**: every configured credential (the key, the RPC URL, the derived WebSocket URL and their credential parts) is replaced in literal and escaped forms. Generic credential-pattern rewriting is not applied to evidence, because it would also alter provider data (for example any JSON key named `token`). A file is refused (`[SEAL_REFUSED]`) if any credential remains. Request headers are never recorded, and the RPC URL appears only as a placeholder.
  - **Terminal output and errors**: after configuration is loaded, every printed line, the stop reason and every propagated error are redacted with the configured credentials and the generic credential patterns. Stop codes and the first failure cause stay readable.
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

| File                     | Contents                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plan.json`              | the full plan (target, endpoints without credentials, limits, allocation, boundaries); its SHA-256 is the plan digest                                                          |
| `report.json`            | the coordinator report, stop reason, first failure cause and plan digest                                                                                                       |
| `summary.json`           | flow qualification and strategy acceptance, reported separately; request totals by lane; evidence completeness                                                                 |
| `request-ledger.json`    | the shared session ledger, attempts by lane and refusals by reason                                                                                                             |
| `request-exchanges.json` | the index of response evidence: one entry per dispatched request, any missing sequence numbers and any capture failures                                                        |
| `exchanges/NNNN.json`    | one file per dispatched request, named by its ledger sequence (see below)                                                                                                      |
| `decisions.json`         | every decision, with decision-time age                                                                                                                                         |
| `decision-inputs.json`   | the flow and security inputs each decision consumed, the intake's security read, and the requests of every security refresh                                                    |
| `disarms.json`           | every disarm                                                                                                                                                                   |
| `market-responses.json`  | bounded market responses with their parse outcome                                                                                                                              |
| `security-evidence.json` | the final security evidence cache state                                                                                                                                        |
| `flow-evidence.json`     | flow status, retained snapshot results, recorded gaps and the final epoch state                                                                                                |
| `ws-observations.json`   | bounded WebSocket observations: receipt time, transport, epoch state at receipt and size of each event; payloads up to the flow's message-byte ceiling; a count of any dropped |
| `evidence-manifest.json` | kind and version, SHA-256 and size of every file, the report reference, the plan digest, the approval label and the request ledger                                             |

**Response evidence** (`exchanges/NNNN.json`) comes from the request session's own bounded read; the runner sends nothing extra. Each file holds:

- **Request identity**: lane, owner, purpose, requested identity, JSON-RPC id, method, URL (the RPC URL is a placeholder), and for JSON-RPC the method and public parameters.
- **Timing and outcome**: dispatch and completion times, HTTP status, error, and the content-type, content-length and retry-after headers.
- **Body**: the response body as received, with its state:
  - `COMPLETE`: the whole body was read within the limit.
  - `PARTIAL_OVERFLOW`: only the retained prefix of a body over the limit. It is never complete evidence.
  - `NOT_READ`: no body bytes were retained (for example a 429, a redirect, a timeout or a network error).
- **Digests**: `receivedBytesSha256` is the SHA-256 of the original bytes. For a partial body it covers the retained prefix only. If redaction changed the body, `bodyRedacted` is true and `reproducesReceivedDigest` is false. The manifest's digests are of the sanitized files.

**Decision inputs** are recorded as each decision reads them. They stay in `decision-inputs.json` after the cache is refreshed or a flow snapshot is retired:

- **Each flow read**: the evaluation time, the result, and the snapshot it selected (summary, frozen reconciliation result and accounted history signatures), with the epoch state and recorded gaps at that moment.
- **Each security read**: the evidence as the reader saw it, the pending (withheld) components, and the source of each component (retrieval time, the refresh that produced it and that refresh's request sequence numbers).

`summary.json` keeps `flowQualification` apart from `strategyAcceptance`. A qualified flow snapshot does not mean the strategy accepted the candidate, and `executed` is always `NONE (decision-only: no buy, no position)`. `summary.evidence.complete` is false if any dispatched request lacks response evidence, a capture failed, or a WebSocket observation was dropped.

## 8. After a run

1. **Integrity**: run the verification command. It fails closed on:
   - **Manifest**: a missing manifest, invalid JSON, or the wrong kind or version.
   - **Paths**: invalid, absolute or traversal paths, and duplicate entries.
   - **Entries**: invalid sizes, digests or categories, and missing required core entries.
   - **Files**: missing files, modified files, non-regular entries, and unlisted files (checked recursively, including `exchanges/`).
   - **References**: a report reference that disagrees with its entry or its file, a plan digest that disagrees with `plan.json` or `report.json`, and response files missing from the index.

   Every result states its scope: integrity only.

2. **Revalidation**: integrity is not revalidation. To review a decision, start from its entry in `decision-inputs.json`:
   - **Flow**: re-decode the in-window transactions from the sealed `getTransaction` responses with the existing decoder, take block times from the sealed history responses, and compare with the recorded counts.
   - **Security**: compare each security component with the response files of the refresh that produced it.

   The offline regression E-01 does exactly this.

3. **Preservation**: do not edit, move or rerun into a sealed directory. A further run needs a new directory and its own approval.
4. **Wallet**: confirm the frozen virtual wallet (`.tmp/virtual-wallet.json`) is unchanged. The runner never reads or writes it.
