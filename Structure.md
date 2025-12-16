# NeXusTrade - Structure & Component Tracker

## 1. Backend (The "Twin Engine" Core)
**Location:** `/backend`
**Status:** ✅ Phase 1 Complete

| File | Purpose | Key Functions | Status |
| :--- | :--- | :--- | :--- |
| `src/config.ts` | **Safety Rail:** Validates API keys & Mode. | `ConfigManager` | ✅ Ready |
| `src/database/client.ts` | **Factory:** Switches Sim/Live DB. | `prisma` instance | ✅ Ready |
| `src/test-db.ts` | **Validation:** Smoke test for DB. | `main()` | ✅ Ready |

## 2. Scanner Module (The Eyes)
**Location:** `/backend/src/scanners`
**Status:** ✅ Phase 2 Complete

| File | Purpose | Status |
| :--- | :--- | :--- |
| `interfaces.ts` | **Contract:** Defines `TokenCandidate`. | ✅ Ready |
| `helius.ts` | **Scanner:** Polls Raydium events. | ✅ Ready |
| `../test-integrated.ts` | **Validation:** Scanner+Risk Loop. | ✅ Ready |

## 3. Risk Engine (The Firewall)
**Location:** `/backend/src/risk`
**Status:** ✅ Phase 2 Complete

| File | Purpose | Status |
| :--- | :--- | :--- |
| `interfaces.ts` | **Contract:** Defines `RiskScore`. | ✅ Ready |
| `helius-risk.ts` | **Logic:** Checks Metadata/Authorities. | ✅ Ready |

## 4. Data Pipeline (The Memory)
**Location:** `/backend/src/pipeline`
**Status:** ✅ Phase 2 Complete

| File | Purpose | Status |
| :--- | :--- | :--- |
| `ingestor.ts` | **Service:** Saves tokens to `TokenRadar` DB. | ✅ Ready |
| `../check-db.ts` | **Validation:** DB write verification. | ✅ Ready |

## 5. Strategy Engine (The Brain)
**Location:** `/backend/src/strategy`
**Status:** 🏗️ Phase 3 In Progress

| File | Purpose | Status |
| :--- | :--- | :--- |
| `session-manager.ts` | **Accountant:** Tracks Session P/L & Stops. | ✅ Ready |
| `interfaces.ts` | **Contract:** Defines `IStrategy`. | ⏳ Pending |
| `simple-strategy.ts` | **Logic:** Basic "Safe Entry" rules. | ⏳ Pending |

## 6. Database (Twin Engine Persistence)
**Location:** `/backend/prisma`
**Status:** ✅ Ready