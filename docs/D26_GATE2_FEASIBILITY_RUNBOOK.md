# NeXusTrade — Phase 12.94-D.2.6: Gate 2 Fresh-Pool Feasibility Runbook

**Document Revision:** 1.0.0  
**Phase:** Phase 12.94-D.2.6  
**Scope:** Prospective Fresh-Pool Discovery Feasibility, Funnel Telemetry & On-Chain AMM v4 Verification  
**Target Environment:** Windows 11 Quantitative Research Station (PowerShell) & Linux / Fedora 44  
**Classification:** Research Telemetry & Experimental Evaluation Protocol

---

## 1. Safety, Confinement & Security Guardrails

The D.2.6 Gate 2 experiment operates under strict, fail-closed research guardrails.

### Non-Negotiable Operational Constraints

1. **Strictly Read-Only:**
   - **Zero Key Material:** No private keys or wallet keypairs are ever loaded, created, or referenced.
   - **Zero On-Chain Transactions:** No transaction generation, signing, simulation, or broadcasting.
   - **Zero Trading Daemon Coupling:** Execution engines, Jupiter quote routes, and order placement daemons remain disabled.
   - **Wallet State Frozen:** Gen 1 wallet balance remains locked at `7.9259 SOL` (`7F2C2353AC2F62CAC1BB98703742AB19C74AC5521635AF6F49BBE777AD020ED9`).

2. **Network Fail-Closed Authorization:**
   - Outbound HTTP and RPC network calls require explicit `--network=enabled`. Without this flag, the CLI immediately terminates with exit code 1 (`[NETWORK_DISABLED]`).

3. **Allowlisted Hosts & Read-Only Endpoints:**
   - **Raydium API v3 (HTTPS GET Only):**
     - Allowlisted Host: `api-v3.raydium.io`
     - Query Path: `/pools/info/list?poolType=standard&poolSortField=default&sortType=desc&pageSize=50&page=1`
   - **Solana JSON-RPC 2.0 (HTTPS POST Only):**
     - Allowlisted Methods: `getAccountInfo`, `getMultipleAccounts`
     - Commitment: `confirmed`

4. **Rate Budgeting & Request Spacing:**
   - Maximum outbound Raydium API rate: **30 requests per minute**.
   - Minimum inter-request spacing: **2000 ms** (`--min-request-interval-ms=2000`).
   - Solana RPC rate budget: max 60 calls/minute, bounded to 2 calls per candidate verification.

5. **Resource Bounding & Clean Shutdown:**
   - Maximum process RSS memory ceiling: **256 MB** (`--max-rss-mb=256`).
   - Clean shutdown handler with libuv event loop draining, ensuring exit code 0 on Windows without assertion failures.

---

## 2. Gate 2 Experimental Objectives & Hypothesis

### Primary Research Objective

Empirically measure whether Raydium API v3's volume-ranked standard catalog (`poolType=standard&poolSortField=default&sortType=desc`) can surface genuinely fresh Raydium AMM v4 liquidity pools within a bounded 10–15 minute observational window under an active pool age threshold.

### Hypothesis Under Evaluation

Because the standard Raydium catalog endpoint sorts by 24-hour volume by default and does not expose a chronological creation-time index, top-ranked pools represent mature, high-liquidity pools.

- **Hypothesis A (Fresh Arrival):** New high-volume pools (e.g. viral meme tokens) enter the top-50 catalog within 10–15 minutes and pass the freshness filter (`poolAgeAtDiscoverySec <= maxPoolAgeSec`).
- **Hypothesis B (Catalog Saturation / Stasis):** Top-50 catalog remains composed entirely of mature pools (`poolAgeAtDiscoverySec > maxPoolAgeSec`) or unindexed pools (`openTime = "0"`).

**Crucial Research Principle:** Both outcomes are scientifically valuable. Hypothesis B is not an engineering failure; it provides authoritative empirical proof of the catalog's arrival horizon and justifies subsequent event-driven discovery mechanisms (e.g. WebSocket log subscriptions) without compromising research integrity.

---

## 3. Experimental Parameters & Funnel Accounting

### Recommended Gate 2 Configuration

- **Discovery Source:** `raydium`
- **Session Duration:** 600–900 seconds (10–15 minutes)
- **Polling Interval:** 15–30 seconds
- **Age Threshold (`--max-pool-age-sec`):**
  - **Option 1 (Aggressive Freshness):** `3600` (pools created within the last 1 hour)
  - **Option 2 (Moderate Freshness):** `86400` (pools created within the last 24 hours)
- **Target Diagnostic Yield (`--target-yield`):** 1–5 verified pools
- **Screening Ceiling (`--max-candidates-screened`):** 500 candidates

### End-to-End Funnel Metrics (D26-F3)

All sampling stages are tracked and persisted in `session-summary.json` under `discoveryFunnel`:

```json
{
  "apiPoolsReturned": 150,
  "uniquePoolsEncountered": 50,
  "repeatedPoolsSuppressed": 100,
  "preVerificationExclusions": {
    "nonSolPairs": 2,
    "nonStandardAmm": 0,
    "missingOpenTime": 1,
    "invalidOpenTime": 5,
    "futureDatedOpenTime": 0,
    "exceedsMaxPoolAge": 42,
    "totalPreVerificationExcluded": 50
  },
  "poolAgeClassifications": {
    "validAgeCount": 44,
    "missingAgeCount": 1,
    "invalidAgeCount": 5,
    "futureDatedAgeCount": 0,
    "confirmedAgeFilterPasses": 2,
    "ageFilterExclusions": 48
  },
  "verificationAttempts": 2,
  "verifiedAmmV4Pools": 2,
  "confirmedOnChainIneligible": 0,
  "rpcProviderUnavailable": 0,
  "rpcRetriesExhausted": 0,
  "unreachedCandidatesDueToStopping": 0
}
```

---

## 4. Execution Protocol (Windows PowerShell)

> [!IMPORTANT]
> **PRE-EXECUTION PREREQUISITE:**
> Do NOT execute this command until Gate 2 authorization is granted. Ensure all local tests and CI checks are 100% green.

### Step 1: Pre-Flight Environment Verification

```powershell
# 1. Verify Node.js version (v24.x expected)
node --version

# 2. Verify git status is clean and synchronized with origin/main
git status

# 3. Transpile backend TypeScript to backend/dist
node scripts/build-pilot-cli.mjs

# 4. Prepare session directory
$SESSION_DIR = "$HOME\NeXusTrade-Pilot-Data\gate2-sessions"
$LOG_DIR = "$HOME\NeXusTrade-Pilot-Data\gate2-logs"
New-Item -ItemType Directory -Force -Path $SESSION_DIR
New-Item -ItemType Directory -Force -Path $LOG_DIR
```

### Step 2: Gate 2 Execution Invocations

#### Option A: Aggressive Freshness Window (1 Hour Max Age, 10 Minutes Duration)

```powershell
node backend/dist/research/pilot/PilotLiveCollectorCli.js `
  --network=enabled `
  --discovery-source=raydium `
  --max-pool-age-sec=3600 `
  --min-request-interval-ms=2000 `
  --poll-interval-sec=20 `
  --duration-sec=600 `
  --target-yield=3 `
  --max-candidates-screened=500 `
  --max-mb=256 `
  --max-rss-mb=256 `
  --output-dir="$SESSION_DIR" `
  --log-file="$LOG_DIR\gate2-feasibility-1h.log"
```

#### Option B: Moderate Freshness Window (24 Hours Max Age, 10 Minutes Duration)

```powershell
node backend/dist/research/pilot/PilotLiveCollectorCli.js `
  --network=enabled `
  --discovery-source=raydium `
  --max-pool-age-sec=86400 `
  --min-request-interval-ms=2000 `
  --poll-interval-sec=20 `
  --duration-sec=600 `
  --target-yield=3 `
  --max-candidates-screened=500 `
  --max-mb=256 `
  --max-rss-mb=256 `
  --output-dir="$SESSION_DIR" `
  --log-file="$LOG_DIR\gate2-feasibility-24h.log"
```

---

## 5. Objective Pass / Fail / Inconclusive Evaluation Criteria

| Evaluation Outcome                                        | Telemetry Conditions                                                                                                                                                                         | Scientific Interpretation & Action                                                                                                                                                                         |
| :-------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PASS**                                                  | `verifiedAmmV4Pools >= 1`, `durationSec === 0` in observations, manifest `VALID`, exit code `0`.                                                                                             | Catalog discovery produces verified fresh Raydium AMM v4 pools. Proceed to prospective outcome observation pilot (Milestone D.2.7).                                                                        |
| **INCONCLUSIVE (Catalog Freshness Limitation Confirmed)** | `verifiedAmmV4Pools === 0`, `exceedsMaxPoolAge > 0` or `invalidOpenTime > 0`, manifest `VALID`, exit code `0`, no memory or libuv crash.                                                     | Top-50 catalog volume sorting does not surface freshly initialized pools in the given window. Authoritatively establishes the boundaries of catalog discovery; motivates real-time event-driven discovery. |
| **FAIL**                                                  | Exit code `!= 0`, unhandled promise rejection, libuv shutdown crash (`UV_HANDLE_CLOSING`), manifest checksum mismatch, memory `> 256MB`, or RPC error conflated with protocol ineligibility. | Implementation defect. Block forward progression and remediate.                                                                                                                                            |

---

## 6. Post-Execution Verification Checklist

Following run completion:

1. Verify process exit code was `0`.
2. Inspect `$LOG_DIR\gate2-feasibility-*.log` for clean shutdown.
3. Validate session manifest:
   ```powershell
   node scripts/import-pilot-archive.mjs --source-dir="$SESSION_DIR\<session-id>" --dry-run
   ```
4. Verify `market-observations.jsonl`:
   - `measurementWindow.durationSec` is `0` for instantaneous RPC snapshots.
   - `onChainSlot` is populated.
   - `flowMeasurementWindowSec` is `300` when 5m flow metrics are included.
5. Verify `session-summary.json`:
   - `discoveryFunnel` contains complete, non-null funnel statistics.
   - Rejection reasons in candidate decisions match funnel tallies.
