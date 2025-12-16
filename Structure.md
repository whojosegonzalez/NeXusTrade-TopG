# NeXusTrade - Structure & Component Tracker

## 1. Backend (The "Twin Engine" Core)
**Location:** `/backend`
**Status:** ✅ Phase 1 Complete

| File | Purpose | Key Functions | Status |
| :--- | :--- | :--- | :--- |
| `src/config.ts` | **Safety Rail:** Validates API keys & Mode on startup. | `ConfigManager` | ✅ Ready |
| `src/database/client.ts` | **Factory:** Switches Sim/Live DB based on config. | `prisma` instance | ✅ Ready |
| `src/test-db.ts` | **Validation:** Smoke test for database connectivity. | `main()` | ✅ Ready |
| `src/index.ts` | **Entry Point:** Starts the bot. | `main()` | ⏳ Pending |

## 2. Scanner Module (The Eyes)
**Location:** `/backend/src/scanners`
**Status:** ✅ Phase 2 Complete

| File | Purpose | Key Functions | Status |
| :--- | :--- | :--- | :--- |
| `interfaces.ts` | **Contract:** Defines standard `TokenCandidate` & `IScanner`. | `TokenCandidate` | ✅ Ready |
| `helius.ts` | **Implementation:** Polls Helius for Raydium liquidity events. | `start()`, `scan()` | ✅ Ready |
| `../test-scanner.ts`| **Validation:** Runs the scanner in isolation to verify data. | `main()` | ✅ Ready |
| `../test-integrated.ts` | **Validation:** Runs Scanner + Risk Loop (Integration Test). | `main()` | ✅ Ready |

## 3. Risk Engine (The Firewall)
**Location:** `/backend/src/risk`
**Status:** ✅ Phase 2 Complete

| File | Purpose | Key Functions | Status |
| :--- | :--- | :--- | :--- |
| `interfaces.ts` | **Contract:** Defines `RiskScore` and `IRiskEngine`. | `RiskScore` | ✅ Ready |
| `helius-risk.ts` | **Implementation:** Checks token metadata (Mint/Freeze) via DAS. | `evaluate()` | ✅ Ready |
| `../test-risk.ts` | **Validation:** Checks specific mints for rug risk. | `main()` | ✅ Ready |

## 4. Shared (Type Definitions)
**Location:** `/shared`
**Status:** ⏳ Pending

## 5. Database (Twin Engine Persistence)
**Location:** `/backend/prisma`
**Status:** ✅ Ready

- **Live DB:** `nexus_live.db` (Real funds, encrypted keys)
- **Sim DB:** `nexus_sim.db` (Paper money, simulated latency)