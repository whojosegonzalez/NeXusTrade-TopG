# NeXusTrade — Phase 12.94-D.2.5 Raydium Discovery Runbook

**Document Revision:** 1.0.0  
**Phase:** Phase 12.94-D.2.5  
**Scope:** Bounded Raydium API v3 Catalog Discovery, Canonical AMM v4 On-Chain Verification, and Diagnostic Telemetry  
**Target Environment:** Windows 11 Quantitative Research Station (PowerShell) & Linux / Fedora 44

---

## 1. Safety, Confinement & Security Guardrails

The D.2.5 discovery adapter extends the accepted D.2.4 live collector with bounded, read-only Raydium API v3 catalog polling.

### Non-Negotiable Operational Constraints

1. **Strictly Read-Only:**
   - **NO Private Keys or Keypairs:** Zero private key loading, generation, or signing.
   - **NO Transaction Broadcasting:** Zero transaction creation, simulation, or submission.
   - **NO Trading Engine Interactions:** Completely decoupled from execution daemons, Jupiter APIs, and order routing.
   - **Wallet State Frozen:** Gen 1 wallet balance remains locked at `7.9259 SOL` (`7F2C2353AC2F62CAC1BB98703742AB19C74AC5521635AF6F49BBE777AD020ED9`).

2. **Network Fail-Closed Authorization:**
   - Outbound HTTP and RPC calls require explicit `--network=enabled`. Without this flag, the process exits with code 1 (`[NETWORK_DISABLED]`).

3. **Allowlisted Hosts & Methods:**
   - **Raydium API v3 (HTTPS GET Only):**
     - Endpoint: `https://api-v3.raydium.io/pools/info/list`
     - Parameters: `poolType=standard&poolSortField=default&sortType=desc&pageSize=50&page=1`
   - **Solana JSON-RPC 2.0 (HTTPS POST Only):**
     - Methods: `getAccountInfo`, `getMultipleAccounts`
     - Commitments: `confirmed`

4. **Rate Budgeting & Spacing (D25-F4):**
   - **Request Budget:** Strictly **30 requests per minute** (minimum inter-request spacing: **2000 ms**).
   - Built-in rate limiter halts outbound calls and defers polling cycles if the rate budget is exceeded.

5. **Decoupled Arrival Measurement (D25-F2):**
   - **Target Yield (`--target-yield` / `--target-candidates`, default: 15):** The desired yield of verified `WATCHLIST_RADAR` pools.
   - **Safety Ceiling (`--max-candidates-screened`, default: 500):** A hard stop ceiling preventing runaway memory or disk usage, ensuring mature catalog results do not prematurely halt observation before fresh arrivals appear.

6. **Error Classification & Deferred Retry Queue (D25-F1):**
   - **Transient Provider Errors (429 rate limit, timeout, network disconnect):** Candidate pools are placed in a deferred verification queue (max 3 retries, 2000 ms backoff).
   - If retries exhaust or shutdown occurs, candidate is finalized as `FILTERED_REJECTED` with primary reason `RPC_VERIFICATION_EXHAUSTED` and provider error provenance retained.
   - **Confirmed On-Chain Ineligibility (unauthorized program owner, null account, malformed data, vault mismatch):** Immediately recorded as `FILTERED_REJECTED` without retry.
   - Under no circumstances is a candidate promoted to `WATCHLIST_RADAR` without positive cryptographic verification.

7. **Structured Provenance & Sidecar (D25-F3):**
   - Candidate decisions preserve: `poolAgeAtDiscoverySec`, `firstSeenEpochMs`, `discoverySource`, `discoveryEndpoint`, `discoveryPage`, `discoverySortField`.
   - Comprehensive provenance is persisted in `discovery-diagnostics.jsonl` and registered in `manifest.json`.

---

## 2. Gate 1: Windows Live Discovery Smoke Test (Filter-Disabled Mode)

> [!IMPORTANT]
> **GATE 1 APPROVAL GATE:** Do not run Gate 1 until explicit operator authorization is granted. Ensure all local tests and GitHub Actions CI checks have completed green.

### Purpose

Validate end-to-end Raydium API v3 catalog retrieval, pool parsing, pool-ID deduplication, and independent on-chain AMM v4 verification on Windows in a bounded 10-minute session with age filtering disabled (`--max-pool-age-sec=0`).

### Prerequisites (Windows PowerShell)

```powershell
# 1. Ensure isolated data and log directories exist under $HOME
New-Item -ItemType Directory -Force -Path "$HOME\NeXusTrade-Pilot-Data\sessions"
New-Item -ItemType Directory -Force -Path "$HOME\NeXusTrade-Pilot-Data\logs"

# 2. Verify Node.js version (must be >= 24.0.0)
node --version

# 3. Ensure CLI executable is built
node scripts/build-pilot-cli.mjs
```

### Gate 1 Execution Command

```powershell
node backend/dist/research/pilot/PilotLiveCollectorCli.js `
  --network=enabled `
  --discovery-source=raydium `
  --max-pool-age-sec=0 `
  --min-request-interval-ms=2000 `
  --poll-interval-sec=30 `
  --duration-sec=600 `
  --target-candidates=15 `
  --target-yield=15 `
  --max-candidates-screened=500 `
  --max-mb=256 `
  --max-rss-mb=256 `
  --output-dir="$HOME\NeXusTrade-Pilot-Data\sessions" `
  --log-file="$HOME\NeXusTrade-Pilot-Data\logs\gate1-smoke.log"
```

### Gate 1 Success Criteria

1. Exit code `0` upon duration expiry (600s) or target yield reached.
2. Operational log written to `$HOME\NeXusTrade-Pilot-Data\logs\gate1-smoke.log`.
3. Session directory created under `$HOME\NeXusTrade-Pilot-Data\sessions\pilot-sess-<timestamp>`.
4. `candidate-decisions.jsonl` contains at least one candidate with `discoverySource: "raydium"` and valid pool age.
5. If eligible AMM v4 pools are verified, they are classified as `WATCHLIST_RADAR` with `market-observations.jsonl` records.
6. `discovery-diagnostics.jsonl` is generated with complete provenance fields.
7. `manifest.json` is generated, valid, and hashes all files accurately.
8. Process RSS memory remains < 256 MB throughout execution.

---

## 3. Gate 2: Windows Arrival Measurement Session (Age Filter Active)

### Purpose

Measure real-time arrival rate of genuinely fresh Raydium pools (age <= 300s) over a 2-hour observation window.

### Gate 2 Execution Command

```powershell
node backend/dist/research/pilot/PilotLiveCollectorCli.js `
  --network=enabled `
  --discovery-source=raydium `
  --max-pool-age-sec=300 `
  --min-request-interval-ms=2000 `
  --poll-interval-sec=30 `
  --duration-sec=7200 `
  --target-candidates=15 `
  --target-yield=15 `
  --max-candidates-screened=500 `
  --max-mb=256 `
  --max-rss-mb=256 `
  --output-dir="$HOME\NeXusTrade-Pilot-Data\sessions" `
  --log-file="$HOME\NeXusTrade-Pilot-Data\logs\gate2-arrival.log"
```

---

## 4. Session Integrity & Verification

Upon session completion, verify the manifest directly:

```powershell
# Using the canonical archive importer to verify session integrity
node scripts/import-pilot-archive.mjs --source="$HOME\NeXusTrade-Pilot-Data\sessions\<session-folder>"
```
