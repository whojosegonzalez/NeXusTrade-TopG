# NeXusTrade - Master Implementation Plan

This document tracks the phased rollout of the NeXusTrade bot, moving from a local simulation environment to a live trading terminal.

---

## ✅ Phase 1: Foundation & Architecture (Completed)
- [x] **Project Scaffolding:** Monorepo structure (Backend/Frontend/Shared).
- [x] **Twin Engine Database:** SQLite implementation with `prisma.config.ts`.
- [x] **Safety Rails:** `ConfigManager` to enforce `SIMULATION_MODE`.
- [x] **Persistence:** Session and Trade tables defined and migrated.

## ✅ Phase 2: The Sensory System (Current)
**Goal:** Detect new tokens and filter out scams immediately.
- [x] **Scanner Module:** Poll Helius RPC for new Raydium Pools.
- [x] **Risk Engine:** Implement "Rug Check" (Mint/Freeze authority) using Helius DAS.
- [x] **Data Pipeline:** Save detected tokens to the `TokenRadar` database table.

## ✅ Phase 3: The Strategy Engine (The Brain)
**Goal:** Decide *when* to buy based on math, not just hype.
- [x] **Session Manager:** Track real-time P/L, Stop Loss, and Max Positions.
- [x] **Scoring Logic:** Implement basic strategy rules (Risk > 80).
- [x] **Simulation Loop:** Full cycle (Scan -> Risk -> Decide -> Trade).
- [x] **Real-World Paper Trading:** Integrated Jupiter Price Oracle for realistic simulation.
- [x] **Position Manager:** Track prices and sell at +30% profit or -30% loss.

## ⏳ Phase 4: The Live Engine (The Hands)
**Goal:** Swap "Monopoly Money" for real SOL.
- [ ] **Wallet Manager:** Securely load private keys (Decrypt in memory).
- [ ] **Jupiter Integration:** Fetch real swap routes and execute transactions.
- [ ] **Circuit Breakers:** Hard-coded limits (e.g., Max 1 SOL per day).

## ⏳ Phase 5: The User Interface (Control Center)
**Goal:** Visual dashboard to monitor the bot.
- [ ] **API Layer:** Express.js server to expose bot status.
- [ ] **Frontend:** React dashboard with "Terminal" view and P/L charts.
- [ ] **Control:** Start/Stop buttons and configuration forms.

## ⏳ Phase 6: Optimization
- [ ] **Jito Bundles:** Anti-MEV protection for live trades.
- [ ] **Dynamic Fees:** Auto-adjust priority fees during congestion.