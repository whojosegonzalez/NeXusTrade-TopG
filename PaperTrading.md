# NeXusTrade - Paper Trading Optimization Plan
**Objective:** Evolve the bot from a "Code Prototype" into a "Market-Ready Strategy Engine" by diversifying data sources and robustifying price logic.

## 🏗️ Phase A: Sensory Expansion (Finding More Coins)
**Goal:** Don't rely just on the "Sniper" (0-second old coins). Find "Trending" and "gaining" coins too.
- [x] **Scanner Factory:** Refactor `BotEngine` to accept multiple scanners running in parallel.
- [ ] **DexScreener Scanner:** Implement polling for "Trending" and "New Pairs" via DexScreener API.
- [ ] **Birdeye Scanner:** (Optional) Implement "Most Traded" scanner.
- [ ] **Dedup Logic:** Ensure the same coin found by Helius AND DexScreener isn't processed twice.

## 🧠 Phase B: Price Intelligence (The Aggregator)
**Goal:** Never fail to get a price. If Jupiter is blind, ask someone else.
- [ ] **Price Aggregator Service:** A class that queries sources in priority order:
    1. **Jupiter API:** (Fastest, trade-ready).
    2. **DexScreener API:** (Best coverage for new coins).
    3. **Birdeye API:** (Deep historical data).
    4. **Direct RPC:** (Read the Raydium AMM state directly from chain).
- [ ] **Liquidity Check:** Before buying, check if liquidity > $X to avoid "Ghost Pools."

## 💾 Phase C: Data & Analytics (The Report Card)
**Goal:** Track performance over time (H/D/W/M/Y).
- [ ] **Database Upgrade:** Add `SystemLog` table for debugging.
- [ ] **Database Upgrade:** Add `PLSnapshot` table.
    - *Action:* Take a snapshot of (Wallet Balance + Unrealized PnL) every 5 minutes.
    - *Purpose:* Allows drawing an "Equity Curve" graph.
- [ ] **Export Script:** Create a tool to dump `Trade` and `Session` data to CSV for Excel/Python analysis.

## 🧪 Phase D: The Great Simulation
**Goal:** Run the bot for 6-12 hours in "Paper Mode" and analyze the results.
- [ ] **Long Run Test:** Run the bot on Mainnet (Simulated) for a full trading session.
- [ ] **Log Analysis:** Review why specific trades failed or succeeded.
- [ ] **Parameter Tuning:** Adjust `TakeProfit`, `StopLoss`, and `TrailingStop` based on real data.