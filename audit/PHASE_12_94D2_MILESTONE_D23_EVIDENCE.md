# NeXusTrade — Phase 12.94-D.2.3 Implementation Evidence Report

**Document ID:** `NT-D23-EVIDENCE-v1`  
**Milestone:** Phase 12.94-D.2.3 (Solana Empirical Research Pilot Foundation)  
**Parent Addendum:** `audit/PHASE_12_94D2_MILESTONE_D23_ADDENDUM.md` (Commit: `e23f321`)  
**Parent Audit Review:** `c:\Users\whojo\Downloads\NeXusTrade_D23_Commit_e23f321_Independent_Addendum_Review.md`  
**Execution Environment:** Windows Offline Research Environment  
**Status:** IMPLEMENTATION COMPLETE — READY FOR INDEPENDENT AUDIT

---

## 1. Executive Summary & Authorizations

Milestone **Phase 12.94-D.2.3** implements the strictly offline, read-only Solana empirical research pilot components in `backend/src/research/pilot/`. This implementation fulfills the requirements established in the Architecture Addendum (commit `e23f321`) and resolves all mandatory technical findings **D23P-01 through D23P-04** identified in the Independent Addendum Review.

### Operational Boundaries & Safety Guarantees

1. **Zero Real Network Execution:** No outbound network connections, real RPC endpoints, or DexScreener HTTP calls are enabled. All adapters operate against synthetic, deterministic fixtures.
2. **Zero Live Deployment:** Remote Fedora deployment, 2-hour live collection runs, and background daemon polling remain strictly unauthorized and deferred.
3. **Generation 1 Virtual Wallet Immutable:** The continuous virtual wallet balance remains untouched at **`7.9259 SOL`** with canonical SHA-256 hash **`7F2C2353AC2F62CAC1BB98703742AB19C74AC5521635AF6F49BBE777AD020ED9`**.
4. **Historical Subsystems Intact:** Legacy `backend/src/shadow/` and closed milestone `backend/src/research/shadow/` (D.2.2) remain strictly untouched.
5. **Windows Engine Paused:** Zero background trading or paper engine daemons are active.

---

## 2. Technical Findings Resolution Matrix

| Finding ID  | Title                                                 | Summary of Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Authoritative Module                                                           | Status       |
| :---------- | :---------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------- | :----------- |
| **D23P-01** | Correct Raydium AMM v4 Binary Layout                  | Authoritative Raydium SDK V2 752-byte layout parsed with exact offsets (`baseDecimal`: 32, `quoteDecimal`: 40, `baseVault`: 336, `quoteVault`: 368, `baseMint`: 400, `quoteMint`: 432, `baseNeedTakePnl`: 640, `quoteNeedTakePnl`: 648). Exact `bigint` math for token amounts. Dynamic orientation detection (`TOKEN_BASE_SOL_QUOTE`, `SOL_BASE_TOKEN_QUOTE`, `NON_SOL_PAIR`). 165-byte SPL token account vault parsing.                                                                                                                                                                                                                              | `RaydiumAmmParser.ts`                                                          | **RESOLVED** |
| **D23P-02** | Vault Balances vs Effective Reserves & Slot Coherence | Vault balances explicitly classified as `VAULT_ONLY_PROXY`. Slippage and execution feasibility marked `UNAVAILABLE` (`executionFeasible: false`, `effectiveReservesAvailable: false`). Single-request slot coherence enforced via `getMultipleAccounts`. Cross-request slot discrepancies detected via `detectSlotDiscrepancy`.                                                                                                                                                                                                                                                                                                                        | `RaydiumAmmParser.ts`<br/>`SolanaRpcResponseAdapter.ts`                        | **RESOLVED** |
| **D23P-03** | Clock-Domain Separation & Schema Bridge               | Strict separation of UTC epoch ms (`Date.now()`) for causal monotonicity (`requestEpoch <= receiptEpoch <= decisionEpoch`) and monotonic host clock (`performance.now()`) for duration profiling. Two-stage candidate discovery adapter with promotional bias tagging (`DEXSCREENER_PROMOTIONAL_PROFILE`) and truthful null source timestamps. Schema bridge projecting empirical observations into canonical `CandidateDecisionRecord`, `ShadowEvaluationRecord`, and `MarketObservationRecord` using the accepted 5-tuple composite key (`[decisionEventId, sessionId, generationId, mintAddress, poolId]`) with observational screening provenance. | `PilotClock.ts`<br/>`DexScreenerResponseAdapter.ts`<br/>`PilotSchemaBridge.ts` | **RESOLVED** |
| **D23P-04** | Session Export Manifest & Crash Recovery              | Deterministic SHA-256 export manifest (`manifest.json`) generated on session completion recording file sizes, line counts, SHA-256 digests, and manifest hash digest. Crash recovery mechanism (`recoverSession`) isolates corrupt/torn lines into `.corrupt-<timestamp>` sidecars, repairs unfinalized sessions to `INTERRUPTED`, and enforces dual-file consensus (`session-meta.json` + `session-summary.json`). Confinement and 20 MB / 256 MB resource budgets enforced.                                                                                                                                                                          | `PilotExportManifest.ts`<br/>`PilotCollectorRunner.ts`                         | **RESOLVED** |

---

## 3. Component Architecture & Implementation Details

### 3.1 Authoritative Raydium AMM v4 Parser (`RaydiumAmmParser.ts`)

- **Binary Layout:** Conforms to Raydium SDK V2 authoritative layout:
  - Total length: exactly 752 bytes (`RAYDIUM_AMM_V4_LAYOUT_LENGTH = 752`).
  - `status`: offset 0..8 (`u64`)
  - `baseDecimal`: offset 32..40 (`u64` little-endian)
  - `quoteDecimal`: offset 40..48 (`u64` little-endian)
  - `baseVault`: offset 336..368 (32 bytes Pubkey)
  - `quoteVault`: offset 368..400 (32 bytes Pubkey)
  - `baseMint`: offset 400..432 (32 bytes Pubkey)
  - `quoteMint`: offset 432..464 (32 bytes Pubkey)
  - `baseNeedTakePnl`: offset 640..648 (`u64` little-endian)
  - `quoteNeedTakePnl`: offset 648..656 (`u64` little-endian)
- **SPL Token Account Parser:** Parses 165-byte SPL token account buffers:
  - `mint`: offset 0..32 (32 bytes Pubkey)
  - `owner`: offset 32..64 (32 bytes Pubkey)
  - `amount`: offset 64..72 (`u64` little-endian `bigint`)
- **Pair Orientation:** Evaluates mints against Wrapped SOL (`So11111111111111111111111111111111111111112`):
  - `quoteMint === WSOL_MINT`: `TOKEN_BASE_SOL_QUOTE` (standard meme token paired with SOL quote).
  - `baseMint === WSOL_MINT`: `SOL_BASE_TOKEN_QUOTE` (inverted pair where SOL is base).
  - Neither: `NON_SOL_PAIR`.
- **Reserve Accounting:** Enforces `VAULT_ONLY_PROXY` classification. Because Raydium AMM v4 swaps execute against effective reserves that incorporate the OpenOrders account and uncollected PnL adjustments, vault balances cannot guarantee swap execution feasibility or quote accuracy without OpenOrders. Thus, `executionFeasible` and `effectiveReservesAvailable` are strictly set to `false`.

### 3.2 Solana RPC Response Adapter (`SolanaRpcResponseAdapter.ts`)

- **Single-Request Slot Coherence:** Decodes `getMultipleAccounts` RPC responses, extracting the top-level `context.slot` and attributing all returned account buffers to that exact slot.
- **Cross-Request Slot Discrepancy Detection:** Implements `detectSlotDiscrepancy(slotA, slotB, maxAllowedDelta)` to flag observations where pool state and vault states were retrieved across differing slots.

### 3.3 DexScreener Candidate Discovery Adapter (`DexScreenerResponseAdapter.ts`)

- **Two-Stage Discovery Pipeline:**
  1. `parseDexScreenerTokenProfilesResponse`: Parses promotional token profiles (`/token-profiles/latest/v1`), extracting mint addresses, symbols, and promotional descriptions.
  2. `parseDexScreenerPairsResponse`: Parses pair summaries (`/latest/dex/tokens/:mint`), validating Raydium AMM dexId, base58 mints, liquidity USD, volume, and buy/sell metrics.
- **Selection Bias & Provenance:** Explicitly labels candidates as `DEXSCREENER_PROMOTIONAL_PROFILE` to prevent selection bias from being masked as unbiased pool creation.
- **Truthful Null Timestamps:** DexScreener HTTP responses do not contain an attested block or on-chain transaction timestamp. The adapter sets `sourceTimestampMs: null` and registers `"sourceTimestampMs"` in `missingFields` instead of fabricating timestamps from HTTP `Date` headers or `pairCreatedAt`.

### 3.4 Dual-Domain Clock (`PilotClock.ts`)

- **UTC Epoch Domain:** Uses `Date.now()` exclusively for absolute timestamps across records and verifies causal monotonicity (`requestEpoch <= receiptEpoch <= decisionEpoch`) via `validateCausalEpochOrdering`.
- **Host Monotonic Domain:** Uses `performance.now()` strictly for internal duration and latency measurements (`computeMonotonicElapsed`).
- **Deterministic Clock:** Implements `DeterministicPilotClock` for offline reproducibility and replay testing.

### 3.5 Pilot Schema Bridge (`PilotSchemaBridge.ts`)

- **Accepted 5-Tuple Composite Key:** Relates records via `compositeId = [decisionEventId, sessionId, generationId, mintAddress, poolId]`.
- **Canonical Schema Compatibility:** Maps empirical pilot observations to canonical research records:
  - `CandidateDecisionRecord`: Tagged with cohort `WATCHLIST_RADAR` or `FILTERED_REJECTED`, decisionType `CANDIDATE_DISCOVERY_PROFILE`, and selection bias `DEXSCREENER_PROMOTIONAL_PROFILE`.
  - `ShadowEvaluationRecord`: Evaluates shadow qualification against empirical liquidity and flow thresholds without generating buy orders.
  - `MarketObservationRecord`: Carries empirical reserve proxies, flow metrics, on-chain slots, and slot discrepancy flags.
- **Observational Screening Provenance:** Records are marked `provenance: "D23_OBSERVATIONAL_SCREENING"` and `providerIdentity: "dexscreener_solana_pilot"`, ensuring downstream research never misattributes screening passes as trading signals.

### 3.6 Export Manifest & Verification (`PilotExportManifest.ts`)

- **File Manifest:** Inspects all files in the session directory, computing individual SHA-256 hashes, file sizes, and line counts.
- **Manifest Digest:** Computes SHA-256 over canonical JSON string of sorted file entries.
- **Verification Engine:** `verifySessionExportManifest` verifies on-disk file integrity against `manifest.json`, detecting tampered content, missing files, or unauthorized extra files.

### 3.7 Pilot Collector Runner & Recovery (`PilotCollectorRunner.ts`)

- **Bounded State Machine:** Transitions through `PENDING` $\to$ `ACTIVE` $\to$ `FINALIZED` or `INTERRUPTED`.
- **Resource Enforcement:** Enforces maximum candidate quota (100), unique pool quota (20), 2-hour duration box (7200s), 20 MB disk storage limit, and 256 MB RSS memory ceiling.
- **Crash Recovery:** `recoverSession` scans session directories, isolates malformed or torn JSONL lines to `.corrupt-<timestamp>` sidecars, repairs unfinalized or active sessions to `INTERRUPTED` with `interruptionReason: "RECOVERED_FROM_UNGRACEFUL_PROCESS_INTERRUPTION"`, and updates `session-meta.json` and `session-summary.json`.

---

## 4. Verification Suite & Test Results

### 4.1 Unit & Integration Test Breakdown

The new D.2.3 pilot test suites comprise **27 tests** across two test files:

1. **`RaydiumAmmParser.test.ts` (12 tests):**
   - Validates authoritative 752-byte Raydium AMM v4 binary decoding.
   - Verifies exact field extraction (`baseDecimal`: 9, `quoteDecimal`: 9, vaults, mints, PnL).
   - Rejects buffers with invalid lengths (e.g. 751 or 753 bytes).
   - Verifies SPL token account 165-byte buffer parsing.
   - Tests pair orientation: `TOKEN_BASE_SOL_QUOTE`, `SOL_BASE_TOKEN_QUOTE`, and `NON_SOL_PAIR`.
   - Verifies reserve proxy calculation, spot pricing, and `VAULT_ONLY_PROXY` classification (`executionFeasible: false`).

2. **`PilotAdaptersAndRunner.test.ts` (15 tests):**
   - Verifies DexScreener token profiles parsing and Base58 validation.
   - Verifies DexScreener pairs parsing, null source timestamp handling, and promotional bias labeling.
   - Verifies Solana RPC `getMultipleAccounts` parsing and single-request slot coherence.
   - Verifies cross-request slot discrepancy detection (`detectSlotDiscrepancy`).
   - Verifies causal epoch ordering (`requestEpoch <= receiptEpoch <= decisionEpoch`) and lookahead rejection.
   - Verifies host monotonic elapsed calculation.
   - Verifies deterministic clock behavior.
   - Verifies schema bridge translation into canonical decision, evaluation, and observation records.
   - Verifies SHA-256 export manifest generation and corruption detection.
   - Verifies runner lifecycle, quota enforcement, and automatic manifest generation upon finalization.
   - Verifies session crash recovery, torn line isolation, and status repair to `INTERRUPTED`.

### 4.2 Comprehensive Repository Verification Summary

All four repository test suites were executed in isolated environments via `scripts/verify-isolated.mjs all`:

| Suite / Check                           | Command                                           | Tests / Visits          | Result                            |
| :-------------------------------------- | :------------------------------------------------ | :---------------------- | :-------------------------------- |
| **Dependency Isolation**                | `scripts/check-isolation.mjs`                     | 877 links               | **PASSED**                        |
| **Architecture Boundaries**             | `scripts/architecture-check.mjs`                  | 77 modules              | **PASSED**                        |
| **TypeScript Compilation**              | `tsc` (backend, shared, frontend, vitest configs) | 4 configs               | **PASSED**                        |
| **Static Code Analysis**                | `eslint`                                          | All files               | **PASSED (0 errors, 0 warnings)** |
| **Code Formatting**                     | `prettier --check`                                | All files               | **PASSED**                        |
| **Secret Detection**                    | `scripts/check-secrets.mjs`                       | All files               | **PASSED (0 secrets)**            |
| **Git Hygiene**                         | `git diff --check`                                | Workspace               | **PASSED**                        |
| **Architecture & Isolation Unit Tests** | `node --test`                                     | 27 tests                | **PASSED**                        |
| **Measurement & Analysis Suite**        | `vitest.measurement-analysis.config.ts`           | 727 tests               | **PASSED**                        |
| **H2 Database Suite**                   | `vitest.h2.config.ts`                             | 194 tests               | **PASSED**                        |
| **H3 Providers Suite**                  | `vitest.h3.config.ts`                             | 98 tests                | **PASSED**                        |
| **H4 Analytics Suite**                  | `vitest.h4.config.ts`                             | 18 tests                | **PASSED**                        |
| **Total Passing Tests**                 | —                                                 | **1,064 / 1,064 tests** | **100% PASSED (Exit Code: 0)**    |

---

## 5. Security & Safety Invariants Affirmation

We affirm the following mandatory safety invariants:

1. **Virtual Wallet Balance:** `.tmp/virtual-wallet.json` remains exactly **`7.9259 SOL`** with SHA-256 hash **`7F2C2353AC2F62CAC1BB98703742AB19C74AC5521635AF6F49BBE777AD020ED9`**.
2. **Untouched Subsystems:** `backend/src/shadow/` and `backend/src/research/shadow/` have not been altered or refactored.
3. **Trading Engine Paused:** Windows paper trading daemon is stopped (0 active processes).
4. **Offline Isolation:** Pilot components contain zero real HTTP/WebSocket client instances; all operations are offline and fixture-driven.
5. **No Remote Fedora Contact:** Fedora host was not contacted and remains reported not inspected.
