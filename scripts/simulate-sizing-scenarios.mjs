import fs from "fs";

const data = JSON.parse(fs.readFileSync("./.tmp/paper-session-active.json", "utf8"));
const trades = data.closedTrades;

// Baseline
const baselinePnl = trades.reduce((acc, t) => acc + t.realizedPnlSol, 0);

// Counterfactual 1: Established at 1.0 SOL (1.25x), Micro unchanged at 0.25 SOL
let pnlScen1 = 0;
for (const t of trades) {
  if (t.costBasisSol === 0.8) {
    pnlScen1 += t.realizedPnlSol * (1.0 / 0.8);
  } else {
    pnlScen1 += t.realizedPnlSol;
  }
}

// Counterfactual 2: Established at 1.0 SOL, Micro flat at 0.5 SOL (2.0x)
let pnlScen2 = 0;
for (const t of trades) {
  if (t.costBasisSol === 0.8) {
    pnlScen2 += t.realizedPnlSol * (1.0 / 0.8);
  } else {
    pnlScen2 += t.realizedPnlSol * (0.5 / 0.25);
  }
}

// Counterfactual 3: Scale-in Pyramiding on Micro-Caps
let pnlScen3 = 0;
for (const t of trades) {
  if (t.costBasisSol === 0.8) {
    pnlScen3 += t.realizedPnlSol * (1.0 / 0.8);
  } else if (t.symbol === "PARACAT") {
    // Tranche 1: 0.1369 SOL
    // Tranche 2: bought at +10% (8.526e-7 * 1.1 = 9.3786e-7), sold at 1.129e-6:
    // (1.129e-6 / 9.3786e-7 - 1) * 0.25 SOL = +20.38% * 0.25 = +0.05096 SOL
    pnlScen3 += 0.136904 + 0.05096;
  } else if (t.symbol === "SINU") {
    // Tranche 1 locked floor +10% = 0.0255 SOL.
    // Tranche 2 bought at +10%, stopped out at +10% (breakeven on tranche 2) = 0.0000 SOL.
    pnlScen3 += t.realizedPnlSol;
  } else {
    pnlScen3 += t.realizedPnlSol;
  }
}

// Counterfactual 4: Scenario 3 + Bundler Downsizing on Established
let pnlScen4 = 0;
for (const t of trades) {
  if (t.symbol === "BOT") {
    pnlScen4 += t.realizedPnlSol * 0.5; // half size (0.4 SOL) due to high bundler
  } else if (t.symbol === "cNFTs") {
    pnlScen4 += t.realizedPnlSol * 0.5; // half size (0.4 SOL) due to high bundler
  } else if (t.costBasisSol === 0.8) {
    pnlScen4 += t.realizedPnlSol * (1.0 / 0.8); // 1.0 SOL for clean established
  } else if (t.symbol === "PARACAT") {
    pnlScen4 += 0.136904 + 0.05096;
  } else {
    pnlScen4 += t.realizedPnlSol;
  }
}

console.log(
  "Baseline (Actual):",
  baselinePnl.toFixed(4),
  "SOL (" + ((baselinePnl / 10) * 100).toFixed(2) + "%)",
);
console.log(
  "Scenario 1 (Established 1.0 SOL, Micro 0.25 SOL):",
  pnlScen1.toFixed(4),
  "SOL (" + ((pnlScen1 / 10) * 100).toFixed(2) + "%)",
);
console.log(
  "Scenario 2 (Established 1.0 SOL, Micro 0.50 SOL Flat):",
  pnlScen2.toFixed(4),
  "SOL (" + ((pnlScen2 / 10) * 100).toFixed(2) + "%)",
);
console.log(
  "Scenario 3 (Established 1.0 SOL + Micro Scale-In Pyramiding):",
  pnlScen3.toFixed(4),
  "SOL (" + ((pnlScen3 / 10) * 100).toFixed(2) + "%)",
);
console.log(
  "Scenario 4 (Scen 3 + Bundler Risk Downsizing on BOT/cNFTs):",
  pnlScen4.toFixed(4),
  "SOL (" + ((pnlScen4 / 10) * 100).toFixed(2) + "%)",
);
