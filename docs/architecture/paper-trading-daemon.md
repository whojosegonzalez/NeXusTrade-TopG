# Paper Trading Daemon Architecture

**Component**: `PaperTradingDaemon`  
**Source Location**: `backend/src/paper/PaperTradingDaemon.ts`, `backend/src/scripts/paper-trading-daemon.ts`  
**Active Phase**: Phase 11 & Phase 12 (Hardened through Sub-Phase 12.88)

---

## 1. Overview & Core Philosophy

The **Paper Trading Daemon** is TopG's autonomous market execution engine. It coordinates real-time market ingestion, in-memory candidate tracking, position lifecycle execution, counterfactual opportunity analysis, and cross-session continuous wallet accounting.

Key architectural properties:

- **High-Frequency Autonomous Polling**: 2,000ms tick interval querying live DexScreener spot order books.
- **Deterministic Risk Isolation**: In-memory execution with zero disk latency during tick loops.
- **Continuous Virtual Wallet Accounting**: Real-time SOL balance compounding across multiple consecutive sessions.
- **Counterfactual Opportunity Tracking**: Auditing rejected candidates in real-time to detect false-negatives (missed runners) and true-negatives (avoided rugs).

---

## 2. Daemon Pipeline Architecture

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Autonomous 2,000ms Execution Loop (paper-trading-daemon.ts)                            │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. Heartbeat & Duration Telemetry: daemon.heartbeat(now)                               │
│ 2. Position Ticking:                                                                   │
│    • Fetch live DexScreener spot price for each open position                          │
│    • Evaluate DynamicRatchetService for stop-loss, profit-taking, or emergency cuts   │
│    • Execute partial scale-outs (50% T1, 25% T2) or full liquidations                  │
│ 3. Candidate Scanner Ingestion:                                                        │
│    • Ingest Birdeye Trending and Raydium/pump.fun candidates                          │
│    • Prune expired candidates via CandidateWatchlistService                            │
│ 4. Stage 1 & Stage 2 Buy Gate Confirmation:                                            │
│    • Preliminary in-memory gate evaluation (unblocks candidate established runners)   │
│    • Fetch live spot price and RugCheck metrics                                       │
│    • Full fail-closed gate evaluation (12 gates)                                       │
│    • Retest Pullback Gate confirmation                                                 │
│ 5. Dynamic Sizing & Position Entry:                                                   │
│    • Calculate wallet-scaled position size                                             │
│    • Commit position into PaperTradingDaemon in-memory store                           │
│ 6. Background Telemetry & State Persistence:                                          │
│    • Persist active session state to .tmp/paper-session-active.json                   │
│    • Counterfactual sample prices of all rejected and dropped candidates               │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Continuous Virtual Wallet Persistence

To simulate real-world account growth across multiple trading sessions without reset bias, the daemon integrates with the **Continuous Virtual Wallet**:

- **State File**: `.tmp/virtual-wallet.json` and `backend/.tmp/virtual-wallet.json`
- **Schema**:
  ```json
  {
    "walletAddress": "SimulatedVirtualWallet111111111111111111111111",
    "currentBalanceSol": 11.2465,
    "initialBalanceSol": 10.0,
    "totalSessionsCompleted": 5,
    "allTimeRealizedPnlSol": 1.2465,
    "lastUpdatedMs": 1790891950741
  }
  ```
- **Lifecycle**:
  - On session startup: loads `currentBalanceSol` as starting capital.
  - On session halt: adds net realized PnL to `allTimeRealizedPnlSol`, updates `currentBalanceSol`, increments `totalSessionsCompleted`, and archives session history to `.tmp/past-sessions.json`.

---

## 4. Proportional Dynamic Position Sizing

Position sizes compound dynamically as wallet equity grows:

$$\text{walletScale} = \min\left(1.25, \max\left(1.0, \frac{\text{currentCash}}{10.0}\right)\right)$$

- **Established Runners**: $\text{establishedBaseSize} = \min(1.25, \text{round}(1.0 \times \text{walletScale}))$.
  - Downsized to $0.50\text{ SOL}$ if bundler concentration $>60\%$ or top 10 concentration $>30\%$.
- **Micro-Cap Probes**: $\text{microProbeBaseSize} = \min(0.35, \text{round}(0.25 \times \text{walletScale}))$.
- **Gas Reserve Guardrail**: Enforces minimum $0.05\text{ SOL}$ reserved for transaction fees.
- **Slot Capacity Ceiling**: Caps position size at $\frac{\text{currentCash} - 0.05}{\text{maxOpenPositions}}$ to prevent single-position over-allocation.

---

## 5. Counterfactual Opportunity Tracking

The daemon continuously benchmarks its decisions against what the market actually did:

- **Missed Winners**: Rejected or dropped tokens whose post-rejection price surged $\ge +15\%$.
- **Avoided Rugs**: Rejected tokens whose post-rejection price dumped $\le -30\%$ (most crash $-99\%$ to $-100\%$).
- **Analytics Output**: Generated on-demand via `pnpm daemon:analytics`, providing complete transparency into strategy precision and false-negative rates.
