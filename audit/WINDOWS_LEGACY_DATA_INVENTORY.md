# NeXusTrade — Windows Legacy-Data Inventory & Provenance Manifest

**Audit Date:** 2026-10-15T23:07:50.523Z<br/>
**Canonical Telemetry Status:** **INSUFFICIENT_EVIDENCE (NO_PERSISTED_TELEMETRY_SESSIONS)**<br/>
**Fedora Host Status:** **REPORTED_NOT_INSPECTED (Remote host untouched and unverified)**<br/>
**Milestone:** Phase 12.94-D Milestone D.2.1 — Read-Only Source Inventory

---

## 1. Executive Summary & Verification Boundaries

This manifest provides an exact, cryptographic, and schema-level inventory of all historical data persisted on disk on the Windows development host.

- **Canonical Telemetry Sessions (`.tmp/telemetry/sessions/`)**: **0 sessions** (Confirmed zero sessions; no data fabricated).
- **Legacy Sessions (`.tmp/sessions/`)**: **2 sessions** found.
- **Generation 1 Virtual Wallet**: `7.9259 SOL` (SHA-256: `7f2c2353ac2f62cac1bb98703742ab19c74ac5521635af6f49bbe777ad020ed9`).

---

## 2. Windows Legacy Sessions Detailed Inventory

### Session: `session-paper-12.93-pc-afternoon.json`

- **Full Path:** `U:\Projects\TopG\.tmp\sessions\session-paper-12.93-pc-afternoon.json`
- **File Size:** 1699 bytes
- **SHA-256 Hash:** `a9d3128dd18f652aa32ada25030874691115e04574ba7dd16436c3ba6e2bb6fa`
- **Time Span:** 2026-10-13T21:21:20.848Z to 2026-10-13T22:39:06.802Z (78 mins)
- **Capital:** Started `8.0815 SOL`, Ended `7.9259 SOL` (Net P&L: `-0.1556 SOL`)
- **Total Executed Trades:** 2

#### Executed Trades Table:

| Trade ID                                                         | Mint Address  | Symbol  | Size (SOL) | Hold (s) | Final P&L (SOL) | Exit Reason                   |
| :--------------------------------------------------------------- | :------------ | :------ | :--------- | :------- | :-------------- | :---------------------------- |
| `pos-Ct6HvaYv79FVwyr73MrEYNvLdtQouLquVmmZnuEkpump-1791926609785` | `Ct6HvaYv...` | NEIL    | 0.5        | 292s     | -0.0513 SOL     | UNCONFIRMED_PRE_BREAKEVEN_CUT |
| `pos-DxnkB7w6f2eS1nfJH8ER1MeoR3apJZQKKA6sspzFpump-1791929479591` | `DxnkB7w6...` | SEALCAT | 0.5        | 445s     | -0.1043 SOL     | CATASTROPHIC_HARD_STOP        |

#### Missing Quantitative Features:

- ❌ **baseReserve (AMM vault token balance)**
- ❌ **quoteReserve (AMM vault SOL balance)**
- ❌ **buys5m / sells5m (co-occurring transaction counts)**
- ❌ **volume5mUsd (co-occurring 5m volume)**
- ❌ **devHoldingPct (developer holding percentage)**
- ❌ **lpBurnPct (LP burn percentage)**
- ❌ **rejectedCandidates (candidate screening filter stream)**
- ❌ **samplingTrajectories (stratified sampling inclusion probabilities)**

#### Quantitative Hypothesis Feasibility for H1–H4:

- **H1 (Liquidity Depth & AMM Impact):** INELIGIBLE (Missing pre-decision point-in-time AMM reserves)
- **H2 (Order Flow Momentum):** INELIGIBLE (Missing co-occurring buys5m/sells5m/volume5m)
- **H3 (Structural Safety & Dev Holding):** INELIGIBLE (Missing verified developer holdings & LP burn status)
- **H4 (Dynamic Capacity Sizing):** INELIGIBLE (Missing verified point-in-time AMM reserves)

### Session: `session-paper-12.93-pc-day4.json`

- **Full Path:** `U:\Projects\TopG\.tmp\sessions\session-paper-12.93-pc-day4.json`
- **File Size:** 3525 bytes
- **SHA-256 Hash:** `e87fd79d07df5f28918fafbf8f214281f7531131db68612e7ca6cefa32379ef0`
- **Time Span:** 2026-10-13T09:29:48.498Z to 2026-10-13T19:00:00.487Z (570 mins)
- **Capital:** Started `8.454784653301157 SOL`, Ended `8.0815 SOL` (Net P&L: `-0.3732 SOL`)
- **Total Executed Trades:** 5

#### Executed Trades Table:

| Trade ID                                                         | Mint Address  | Symbol  | Size (SOL) | Hold (s) | Final P&L (SOL) | Exit Reason                   |
| :--------------------------------------------------------------- | :------------ | :------ | :--------- | :------- | :-------------- | :---------------------------- |
| `pos-Gq8LFQFCdxj1MoVp5yS71c9MkoQcY2k3aZt5bTBBpump-1791900901432` | `Gq8LFQFC...` | hellop  | 0.5        | 151s     | -0.0723 SOL     | UNCONFIRMED_PRE_BREAKEVEN_CUT |
| `pos-AkuditQmcgxyKw68tnZb3UPwdDWxFEfQDiorurC9pump-1791905963114` | `AkuditQm...` | DOGCART | 0.5        | 146s     | -0.054 SOL      | UNCONFIRMED_PRE_BREAKEVEN_CUT |
| `pos-3zKe2553BfmRzb89zTzb7qD9Nz7VeyXqGXnTKxBFpump-1791913006927` | `3zKe2553...` | KACY    | 0.5        | 74s      | -0.0805 SOL     | UNCONFIRMED_PRE_BREAKEVEN_CUT |
| `pos-8LfVXJjup9jYQYM5Zb7LoBvRvXEEQATxorqG2qkUpump-1791914622259` | `8LfVXJju...` | CATGPT  | 0.5        | 74s      | -0.0509 SOL     | UNCONFIRMED_PRE_BREAKEVEN_CUT |
| `pos-1zXbHKTS2VzhJuiFadePVVrMK9f94GCRtLmV2PUpump-1791915359548`  | `1zXbHKTS...` | DOPEUS  | 0.5        | 63s      | -0.1156 SOL     | CATASTROPHIC_HARD_STOP        |

#### Missing Quantitative Features:

- ❌ **baseReserve (AMM vault token balance)**
- ❌ **quoteReserve (AMM vault SOL balance)**
- ❌ **buys5m / sells5m (co-occurring transaction counts)**
- ❌ **volume5mUsd (co-occurring 5m volume)**
- ❌ **devHoldingPct (developer holding percentage)**
- ❌ **lpBurnPct (LP burn percentage)**
- ❌ **rejectedCandidates (candidate screening filter stream)**
- ❌ **samplingTrajectories (stratified sampling inclusion probabilities)**

#### Quantitative Hypothesis Feasibility for H1–H4:

- **H1 (Liquidity Depth & AMM Impact):** INELIGIBLE (Missing pre-decision point-in-time AMM reserves)
- **H2 (Order Flow Momentum):** INELIGIBLE (Missing co-occurring buys5m/sells5m/volume5m)
- **H3 (Structural Safety & Dev Holding):** INELIGIBLE (Missing verified developer holdings & LP burn status)
- **H4 (Dynamic Capacity Sizing):** INELIGIBLE (Missing verified point-in-time AMM reserves)

---

## 3. Remote Fedora Host Invariant

- **Classification:** `REPORTED_NOT_INSPECTED`
- **Operational Boundary:** Zero connections, zero SSH calls, and zero remote process signals were executed.
- **Recovery Status:** Awaiting separate operator authorization before any isolated post-run file transfer.
