# NeXusTrade — Phase 12.94-D.2.6: Gate 2 Fresh-Pool Feasibility Runbook

**Document Revision:** 2.0.0 (Post-G2 Review Corrections)
**Phase:** Phase 12.94-D.2.6
**Scope:** Prospective Fresh-Pool Discovery Feasibility, Funnel Telemetry & On-Chain AMM v4 Verification
**Target Environment:** Windows 11 Quantitative Research Station (PowerShell) & Linux / Fedora 44
**Classification:** Research Telemetry & Experimental Evaluation Protocol
**Progression Rule:** Strictly Gated. No automatic progression to Milestone D.2.7.

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
   - Storage ceiling: **256 MB** (`--max-mb=256`).
   - Clean shutdown handler with libuv event loop draining, ensuring exit code 0 on Windows without assertion failures.

---

## 2. Gate 2 Experimental Objectives & Hypotheses

### Primary Research Objective

Empirically measure whether Raydium API v3's volume-ranked standard catalog (`poolType=standard&poolSortField=default&sortType=desc`) can surface fresh Raydium AMM v4 liquidity pools within a fixed 10-minute observational window under an active pool age threshold.

### Preregistered Hypotheses

Because the standard Raydium catalog endpoint sorts by 24-hour volume by default and does not expose a chronological creation-time index, top-ranked pools represent mature, high-liquidity pools.

- **Hypothesis A (Fresh Arrival):** High-volume pools initialized within the active age window enter the top-50 catalog and pass the freshness filter (`poolAgeAtDiscoverySec <= maxPoolAgeSec`).
- **Hypothesis B (Catalog Saturation / Stasis):** Top-50 catalog remains composed entirely of mature pools (`poolAgeAtDiscoverySec > maxPoolAgeSec`) or unindexed pools (`openTime = "0"`), yielding 0 fresh pools during the fixed observation window.

**Scientific Principle:** Both outcomes are scientifically conclusive. Hypothesis B is not an engineering failure; it provides authoritative empirical proof of the catalog's arrival horizon and justifies subsequent event-driven discovery mechanisms (e.g. WebSocket log subscriptions) without compromising research integrity.

---

## 3. Preregistered Parameters & Funnel Accounting

### Preregistered Primary Configuration (24h Age Threshold)

To balance freshness with empirical feasibility, **24 hours (`--max-pool-age-sec=86400`) is preregistered as the primary experimental threshold**.

- **Discovery Source:** `raydium`
- **Session Duration:** 600 seconds (10 minutes fixed duration)
- **Target Yield:** `0` (`--target-yield=0`, disables target-yield early exit to guarantee full 10-minute observation)
- **Forward Observations:** `false` (`--forward-observations=false`, explicitly disabled for discovery feasibility)
- **Polling Interval:** 20 seconds (`--poll-interval-sec=20`)
- **Inter-Request Spacing:** 2000 ms (`--min-request-interval-ms=2000`)
- **Primary Age Threshold:** 86,400 seconds (`--max-pool-age-sec=86400`, 24 hours)
- **Safety Screening Ceiling:** 500 candidates (`--max-candidates-screened=500`)
- **Memory Ceiling:** 256 MB (`--max-rss-mb=256`)
- **Disk Ceiling:** 256 MB (`--max-mb=256`)

_(Optional Sensitivity Analysis: A subsequent 1-hour run with `--max-pool-age-sec=3600` may be executed as a sensitivity analysis, but the 24-hour run is the preregistered primary benchmark)._

### End-to-End Funnel Metrics (G2-F1 / G2-F3)

All sampling stages are tracked and persisted in `session-summary.json` under `discoveryFunnel` with strict mathematical accounting:

```json
{
  "apiPoolsReturned": 1500,
  "uniquePoolsEncountered": 50,
  "repeatedPoolsSuppressed": 1450,
  "initialSnapshotPoolsEncountered": 50,
  "laterPollArrivalsEncountered": 0,
  "preVerificationExclusions": {
    "nonSolPairs": 2,
    "nonStandardAmm": 0,
    "missingOpenTime": 0,
    "invalidOpenTime": 0,
    "futureDatedOpenTime": 0,
    "exceedsMaxPoolAge": 48,
    "totalPreVerificationExcluded": 50
  },
  "poolAgeClassifications": {
    "validAgeCount": 50,
    "missingAgeCount": 0,
    "invalidAgeCount": 0,
    "futureDatedAgeCount": 0,
    "confirmedAgeFilterPasses": 0,
    "initialSnapshotFreshPasses": 0,
    "laterPollFreshArrivals": 0,
    "ageFilterExclusions": 50
  },
  "eligibleForVerification": 0,
  "verificationAttempts": 0,
  "verifiedAmmV4Pools": 0,
  "confirmedOnChainIneligible": 0,
  "rpcProviderUnavailable": 0,
  "rpcRetriesExhausted": 0,
  "unreachedCandidatesDueToStopping": 0
}
```

### Funnel Mathematical Invariants

1. `uniquePoolsEncountered + repeatedPoolsSuppressed === apiPoolsReturned`
2. `initialSnapshotPoolsEncountered + laterPollArrivalsEncountered === uniquePoolsEncountered`
3. `validAgeCount + missingAgeCount + invalidAgeCount + futureDatedAgeCount === uniquePoolsEncountered`
4. `confirmedAgeFilterPasses + ageFilterExclusions === uniquePoolsEncountered`
5. `initialSnapshotFreshPasses + laterPollFreshArrivals === confirmedAgeFilterPasses`
6. `eligibleForVerification + totalPreVerificationExcluded === uniquePoolsEncountered`

---

## 4. Execution Protocol (Windows PowerShell)

> [!IMPORTANT]
> **PRE-EXECUTION PREREQUISITE:**
> Do NOT execute this live network command until Gate 2 authorization is granted. Ensure all local tests and CI checks are 100% green.

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

### Step 2: Primary Gate 2 Execution (Preregistered 24h Threshold, Fixed 10m Duration)

```powershell
node backend/dist/research/pilot/PilotLiveCollectorCli.js `
  --network=enabled `
  --discovery-source=raydium `
  --max-pool-age-sec=86400 `
  --min-request-interval-ms=2000 `
  --poll-interval-sec=20 `
  --duration-sec=600 `
  --target-yield=0 `
  --forward-observations=false `
  --max-candidates-screened=500 `
  --max-mb=256 `
  --max-rss-mb=256 `
  --output-dir="$SESSION_DIR" `
  --log-file="$LOG_DIR\gate2-feasibility-24h.log"
```

_(Optional Sensitivity Analysis: If desired after primary run review)_:

```powershell
node backend/dist/research/pilot/PilotLiveCollectorCli.js `
  --network=enabled `
  --discovery-source=raydium `
  --max-pool-age-sec=3600 `
  --min-request-interval-ms=2000 `
  --poll-interval-sec=20 `
  --duration-sec=600 `
  --target-yield=0 `
  --forward-observations=false `
  --max-candidates-screened=500 `
  --max-mb=256 `
  --max-rss-mb=256 `
  --output-dir="$SESSION_DIR" `
  --log-file="$LOG_DIR\gate2-feasibility-1h-sensitivity.log"
```

---

## 5. Success Definitions: Operational vs Research Success

To ensure research integrity, we explicitly separate **operational execution success** from **research empirical outcomes**:

### Operational Success Criteria

The experiment is an **operational success** if and only if:

1. Process exit code is `0`.
2. Process shuts down cleanly with zero libuv handle assertion errors (`UV_HANDLE_CLOSING`).
3. Zero unhandled promise rejections or fatal exceptions.
4. Final session status in `session-summary.json` is `FINALIZED`.
5. Final stop reason is `DURATION_EXPIRED` (or `MAX_CANDIDATES_SCREENED_REACHED` if the 500 ceiling was reached).
6. Manifest verification passes (`scripts/verify-pilot-manifest.mjs` outputs `[VALID]`).
7. Process memory remained strictly below 256 MB RSS throughout.
8. Outbound request rates remained within the 30 req/min budget.

### Research Empirical Outcomes

Once operational success is confirmed, the research results fall into one of two valid empirical scenarios:

| Research Outcome                                     | Empirical Findings                                                            | Scientific Conclusion & Next Step                                                                                                                                                                 |
| :--------------------------------------------------- | :---------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Scenario A: Catalog Arrival Observed**             | `verifiedAmmV4Pools >= 1` and `confirmedAgeFilterPasses >= 1`.                | Raydium API v3 catalog can surface fresh Raydium AMM v4 pools within the threshold. Document candidate profiles, arrival latency, and pool attributes.                                            |
| **Scenario B: Catalog Stasis / Saturation Observed** | `verifiedAmmV4Pools === 0`, `exceedsMaxPoolAge > 0` or `invalidOpenTime > 0`. | Raydium API v3 volume-ranked catalog is saturated with mature pools and does not surface fresh pools within the fixed window. Provides empirical justification for real-time WebSocket discovery. |

### Operational Failure Criteria

The experiment is an **operational failure** if:

- Process exit code `!= 0`.
- Unhandled promise rejection or libuv assertion failure occurs.
- Session status is `INTERRUPTED` or manifest fails verification (`INVALID`).
- Memory exceeds 256 MB RSS or disk exceeds 256 MB.
- RPC errors are conflated with on-chain ineligibility.

---

## 6. Post-Execution Verification Checklist

Following run completion:

1. Verify process exit code was `0`.
2. Inspect `$LOG_DIR\gate2-feasibility-24h.log` for clean shutdown.
3. Validate session manifest using the standalone, non-mutating manifest verifier:
   ```powershell
   node scripts/verify-pilot-manifest.mjs --source="$SESSION_DIR\<session-id>"
   ```
4. Verify `discovery-diagnostics.jsonl`:
   - `discoveryPollCycle` and `isInitialCatalogSnapshot` are recorded on every line.
   - `poolAgeAtDiscoverySec` matches API-reported openTime.
5. Verify `session-summary.json`:
   - `discoveryFunnel` contains complete, mathematically consistent counters.
   - `sessionStatus` is `FINALIZED`.
   - `stopReason` is `DURATION_EXPIRED`.
6. Compile findings into evidence package for governance review.
7. **Strict Rule:** No progression to Milestone D.2.7 until governance review is complete and authorized.
