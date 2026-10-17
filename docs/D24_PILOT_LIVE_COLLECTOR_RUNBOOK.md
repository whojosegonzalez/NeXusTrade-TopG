# NeXusTrade — Milestone D.2.4 Live Read-Only Collector Runbook

**Document Revision:** 1.1.0
**Phase:** 12.94-D Milestone D.2.4  
**Scope:** Minimal Live Read-Only Linux/Fedora Pilot Collection & Windows Research Import  
**Target Environment:** Fedora Linux 44 (Collection) & Windows Quantitative Research Environment (Import & Analysis)

---

## 1. Safety, Confinement & Security Guardrails

The D.2.4 live collector is strictly an observational research instrument designed to sample live token discovery and on-chain Raydium AMM v4 liquidity states.

### Non-Negotiable Operational Constraints

1. **Strictly Read-Only:**
   - **NO Keypairs / Wallet Keys:** No private keys, seed phrases, or keypair files are required, loaded, or accepted.
   - **NO Transaction Creation:** No transaction simulation, signing, routing, or broadcast.
   - **NO Trading Daemon Dependencies:** Completely decoupled from historical execution daemons, Jupiter APIs, and paper-trading state machines.
   - **Virtual Balance Frozen:** Gen 1 virtual balance remains locked at `7.9259 SOL` (`7F2C2353AC2F62CAC1BB98703742AB19C74AC5521635AF6F49BBE777AD020ED9`).

2. **Network Fail-Closed Gating:**
   - Network access is disabled by default.
   - Requires explicit `--network=enabled` CLI flag to authorize any outbound HTTP or RPC requests.
   - Any invocation without this flag exits immediately with code `1` (`[NETWORK_DISABLED]`).

3. **Allowlisted Endpoints & RPC Methods Only:**
   - **DexScreener API (HTTPS GET Only):**
     - `https://api.dexscreener.com/token-profiles/latest/v1`
     - `https://api.dexscreener.com/latest/dex/tokens/:tokenAddress`
   - **Solana JSON-RPC 2.0 (HTTPS POST Only):**
     - `getAccountInfo` (Pool account state and owner verification)
     - `getMultipleAccounts` (Base and quote vault account balances and SPL Token owner verification)
     - All other RPC methods (`sendTransaction`, `simulateTransaction`, etc.) are unconditionally rejected.

4. **Directory Isolation:**
   - **Fedora Collection Root:** Defaults to `~/nexustrade-pilot-data/sessions/`, isolated from git checkout and historical telemetry directories.
   - **Windows Import Root:** Strictly imports into `.tmp/pilot-imports/sessions/`. Never directly mutates or overwrites historical `.tmp/telemetry/sessions/`.

5. **Resource Ceilings:**
   - **RSS Memory Ceiling:** 256 MB maximum resident set size (`--max-rss-mb=256`). Halts cleanly if exceeded.
   - **Disk Storage Quota:** 256 MB default operational ceiling (`--max-mb=256`).

---

## 2. Operator Configuration Defaults

| Setting                     | Default Value                                          | CLI Flag                      | Description                                                                   |
| --------------------------- | ------------------------------------------------------ | ----------------------------- | ----------------------------------------------------------------------------- |
| **Network Gating**          | `disabled`                                             | `--network=enabled`           | Mandatory explicit authorization for live collection                          |
| **Solana RPC**              | Public mainnet (`https://api.mainnet-beta.solana.com`) | `--rpc-url=<url>`             | Solana JSON-RPC endpoint with fail-closed 429 throttling                      |
| **DexScreener Poll**        | `30s`                                                  | `--poll-interval-sec=30`      | Profile polling interval with token deduplication                             |
| **Session Duration**        | `7200s` (2 hours)                                      | `--duration-sec=7200`         | Bounded duration box                                                          |
| **Candidate Target**        | `100`                                                  | `--target-candidates=100`     | Candidate ceiling triggering orderly collection shutdown                      |
| **Diagnostic Yield Target** | `15`                                                   | `--target-yield=15`           | Diagnostic yield monitoring benchmark (alias: `--target-diagnostic-yield=15`) |
| **Operational Storage**     | `256 MB`                                               | `--max-mb=256`                | Maximum allowed disk bytes for the session directory                          |
| **Memory Ceiling**          | `256 MB`                                               | `--max-rss-mb=256`            | RSS memory watchdog threshold                                                 |
| **Storage Directory**       | `~/nexustrade-pilot-data/sessions`                     | `--output-dir=<path>`         | Isolated Linux session directory                                              |
| **Forward Tracking**        | `true`                                                 | `--forward-observations=true` | Post-decision observations at +1m, +5m, +15m                                  |

---

## 3. Fedora 44 Deployment & Setup

### Step 3.1: Verify Prerequisites on Fedora 44 Laptop

Verify that Node.js 24+ and pnpm are installed:

```bash
# Check Node version (must be >= 24.0.0)
node --version

# Check pnpm version
pnpm --version

# Ensure isolated pilot directory exists
mkdir -p ~/nexustrade-pilot-data/sessions
```

### Step 3.2: Build TypeScript Project to Executable Distribution

From the repository root on Fedora:

```bash
pnpm install --frozen-lockfile
node scripts/build-pilot-cli.mjs
```

This compiles all required backend TypeScript modules into `backend/dist/research/pilot/PilotLiveCollectorCli.js` as pure ES Modules.

---

## 4. Running a 2-Hour Live Collection Session

Execute the live collector using the operator defaults:

```bash
node backend/dist/research/pilot/PilotLiveCollectorCli.js \
  --network=enabled \
  --duration-sec=7200 \
  --poll-interval-sec=30 \
  --target-candidates=100 \
  --target-yield=15 \
  --max-mb=256 \
  --max-rss-mb=256 \
  --forward-observations=true \
  --output-dir=$HOME/nexustrade-pilot-data/sessions
```

### Expected Output & Terminal Progression

```text
[PILOT_LIVE_COLLECTOR] Starting live read-only pilot collector session...
[PILOT_LIVE_COLLECTOR] Network: ENABLED (Authorization verified)
[PILOT_LIVE_COLLECTOR] RPC: https://api.mainnet-beta.solana.com
[PILOT_LIVE_COLLECTOR] Poll Interval: 30s | Duration Box: 7200s (2h)
[PILOT_LIVE_COLLECTOR] Output Directory: /home/operator/nexustrade-pilot-data/sessions
[PILOT_LIVE_COLLECTOR] Memory Watchdog RSS Limit: 256 MB

[COLLECTOR] Session initialized: pilot-sess-1792215300000
[COLLECTOR] Discovered token DezXAZ8... (Bonk) -> Raydium AMM AVs9TA4...
[COLLECTOR] Solana RPC verified Raydium AMM v4 pool AVs9TA4... at slot 300100200
[COLLECTOR] Candidate decision dec-1792215310000 recorded (WATCHLIST_RADAR)
[COLLECTOR] Scheduled forward observations at +1m, +5m, +15m
...
[PILOT_LIVE_COLLECTOR] Stopping condition reached: DURATION_EXPIRED
[PILOT_LIVE_COLLECTOR] Draining due forward outcomes and accounting for pending windows...
[PILOT_LIVE_COLLECTOR] Finalizing session archive...
[PILOT_LIVE_COLLECTOR] Session finalized successfully: FINALIZED
[PILOT_LIVE_COLLECTOR] SHA-256 Export manifest generated: manifest.json (VALID)
[PILOT_LIVE_COLLECTOR] Candidate Yield: 24 candidates (Diagnostic Target >= 15 MET)
```

### Stopping Semantics

The runner automatically halts cleanly and exports a sealed, verified dataset under any of the following stopping conditions:

1. `DURATION_EXPIRED`: 2-hour duration box elapsed (finalized as `FINALIZED` if candidates recorded).
2. `TARGET_REACHED`: `--target-candidates` ceiling reached (finalized as `FINALIZED`).
3. `OPERATOR_INTERRUPT`: Clean signal capture (`Ctrl+C` / `SIGINT` / `SIGTERM`) drains in-flight writes, censors remaining future targets, reconciles baselines, and seals `manifest.json` as `INTERRUPTED`.
4. `RESOURCE_CEILING_REACHED`: Memory watchdog triggers if process RSS reaches 256 MB (finalized as `INTERRUPTED`).

---

## 5. Artifact Directory Structure

Upon completion, the session directory in `~/nexustrade-pilot-data/sessions/<session-id>/` contains:

```text
~/nexustrade-pilot-data/sessions/<session-id>/
├── session-meta.json                    # Session provenance, environment, start/end timestamps
├── session-summary.json                 # Candidate counts, cohort breakdown, hypothesis summary
├── candidate-decisions.jsonl            # Canonical candidate decision records (5-tuple keys)
├── shadow-evaluations.jsonl             # Canonical shadow evaluation records
├── market-observations.jsonl            # On-chain Raydium AMM pool states & accounting
├── forward-observations.jsonl           # Outcome measurements at +1m, +5m, +15m and censored accounting
├── forward-summary.json                 # Summary totals of scheduled, completed, and truncated intervals
├── pilot-research-compatibility.json    # Exploratory classification & D.1 reconciliation
└── manifest.json                        # Authoritative SHA-256 export manifest of all files
```

---

## 6. Transfer & Import into Windows Research Environment

### Step 6.1: Copy Dataset from Fedora to Windows

Transfer the session directory from the Fedora laptop to the Windows machine via USB drive, SFTP, or SCP:

```bash
# Example SCP transfer to Windows research staging area:
scp -r ~/nexustrade-pilot-data/sessions/pilot-sess-1792215300000 user@windows-box:D:/Staging/
```

### Step 6.2: Safe Import & Manifest Integrity Verification

Use `PilotArchiveImporter` or `scripts/import-pilot-archive.mjs` to safely import and verify the dataset into `.tmp/pilot-imports/sessions/`:

```bash
# Execute isolated Windows import and verification script (non-destructive by default)
node scripts/import-pilot-archive.mjs --source="D:/Staging/pilot-sess-1792215300000"

# Optional --overwrite flag authorizes replacing an existing same-named imported session via safe backup-and-rollback
node scripts/import-pilot-archive.mjs --source="D:/Staging/pilot-sess-1792215300000" --overwrite

# Optional --no-compatibility flag skips D.1 hypothesis feasibility and readiness audit
node scripts/import-pilot-archive.mjs --source="D:/Staging/pilot-sess-1792215300000" --no-compatibility
```

The importer enforces strict, non-destructive safety guarantees:

1. **Collision Protection:** Rejects import if the destination session directory already exists. Unique session directory names are required by default.
2. **Failure-Safe Overwrite:** When `--overwrite` is explicitly provided, existing destination directories are backed up to a temporary `.backup-...` directory prior to publishing. If publishing fails, the previous destination dataset is automatically restored in full from backup, preventing data loss.
3. **Canonical Manifest Verification:** Computes all file SHA-256 hashes and validates the canonical `manifestDigestSha256` of `manifest.json`.
4. **Staging & Crash Recovery Verification:** Copies files into a disposable staging directory (`.staging-...`) and executes canonical crash recovery verification, requiring status to be `FINALIZED` with 0 torn lines and no post-recovery manifest mutation.
5. **Safe Publication:** Publishes verified staging files to `.tmp/pilot-imports/sessions/<session-id>/`.
6. **Research Compatibility:** Audits compatibility against D.1 research readiness gates (unless skipped via `--no-compatibility`) without mutating historical `.tmp/telemetry/sessions/`.
