import { existsSync, appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  loadVirtualWallet,
  saveVirtualWallet,
  reconcileWalletInventory,
  type ReconcileWalletOptions,
} from "../paper/VirtualWallet.js";

function checkActiveDaemonLock(): void {
  const activePaths = [".tmp/paper-session-active.json", "backend/.tmp/paper-session-active.json"];
  for (const activePath of activePaths) {
    if (existsSync(activePath)) {
      try {
        const raw = readFileSync(activePath, "utf8");
        const activeState = JSON.parse(raw);
        if (activeState.status === "RUNNING") {
          const lastTick = activeState.lastTickAtMs ?? 0;
          if (Date.now() - lastTick < 60_000) {
            console.error(
              `[Reconcile] [FATAL] Active paper trading daemon detected (Session: ${activeState.sessionId}, status: RUNNING). Reconciliation cannot run concurrently with an active trading session.`,
            );
            process.exit(1);
          }
        }
      } catch {
        // ignore parse errors
      }
    }
  }
}

function appendAuditLog(auditRecord: Record<string, unknown>): void {
  const auditDirs = [".tmp", "backend/.tmp"];
  const line = JSON.stringify(auditRecord) + "\n";
  for (const dir of auditDirs) {
    if (existsSync(dir)) {
      const logPath = path.join(dir, "reconciliation-audit.jsonl");
      try {
        appendFileSync(logPath, line, "utf8");
      } catch (err) {
        console.error(`[Reconcile] Warning: Failed to write audit log to ${logPath}:`, err);
      }
    }
  }
}

export function runReconciliationCli(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== "--"),
    options: {
      list: { type: "boolean" },
      "position-id": { type: "string" },
      mint: { type: "string" },
      sale: { type: "boolean" },
      "simulated-sale": { type: "boolean" },
      "price-sol": { type: "string" },
      price: { type: "string" },
      provenance: { type: "string" },
      "write-down": { type: "boolean" },
      "estimated-sol": { type: "string" },
      dispose: { type: "boolean" },
      "final-disposal": { type: "boolean" },
      reason: { type: "string" },
    },
    strict: false,
  });

  const wallet = loadVirtualWallet();
  wallet.unresolvedTokens = wallet.unresolvedTokens ?? [];

  if (values.list) {
    console.log("=== UNRESOLVED TOKEN INVENTORY ===");
    if (wallet.unresolvedTokens.length === 0) {
      console.log("No unresolved token positions in virtual wallet.");
    } else {
      wallet.unresolvedTokens.forEach((t, i) => {
        console.log(
          `[${i + 1}] Position ID: ${t.positionId} | Mint: ${t.mintAddress} | Symbol: ${t.symbol ?? "N/A"} | Tokens: ${t.tokensHeld} | Basis: ${t.costBasisSol.toFixed(4)} SOL | Est Liquidation: ${(t.estimatedLiquidationSol ?? 0).toFixed(4)} SOL | Session: ${t.sessionId}`,
        );
      });
    }
    return;
  }

  const identifier = values["position-id"] ?? values.mint;
  if (!identifier || typeof identifier !== "string") {
    console.error(
      "[Reconcile] Error: Missing --position-id=<ID> or --mint=<MINT>. Use --list to view unresolved inventory.",
    );
    process.exit(1);
  }

  // Enforce concurrency lock check before executing any mutation
  checkActiveDaemonLock();

  const isSale = values.sale === true || values["simulated-sale"] === true;
  const isWriteDown = values["write-down"] === true;
  const isDispose = values.dispose === true || values["final-disposal"] === true;

  const activeModes = [isSale, isWriteDown, isDispose].filter(Boolean).length;
  if (activeModes === 0) {
    console.error(
      "[Reconcile] Error: Must specify an operation: --sale, --write-down, or --dispose.",
    );
    process.exit(1);
  }
  if (activeModes > 1) {
    console.error(
      "[Reconcile] Error: Conflicting operations specified. Choose exactly one of: --sale, --write-down, or --dispose.",
    );
    process.exit(1);
  }

  let options: ReconcileWalletOptions;

  if (isSale) {
    const rawPrice = values["price-sol"] ?? values.price;
    const priceSol = typeof rawPrice === "string" ? parseFloat(rawPrice) : NaN;
    if (!Number.isFinite(priceSol) || priceSol <= 0) {
      console.error("[Reconcile] Error: --sale requires valid --price-sol > 0");
      process.exit(1);
    }
    const provenance =
      typeof values.provenance === "string"
        ? values.provenance
        : typeof values.reason === "string"
          ? values.reason
          : "Simulated sale at operator-specified market price";

    options = {
      identifier,
      operationType: "SIMULATED_SALE",
      exitPriceSol: priceSol,
      reason: provenance,
    };
  } else if (isWriteDown) {
    const rawEst = values["estimated-sol"];
    const estimatedSol = typeof rawEst === "string" ? parseFloat(rawEst) : 0;
    if (!Number.isFinite(estimatedSol) || estimatedSol < 0) {
      console.error("[Reconcile] Error: --write-down requires valid --estimated-sol >= 0");
      process.exit(1);
    }
    options = {
      identifier,
      operationType: "WRITE_DOWN",
      writeDownEstimatedSol: estimatedSol,
      reason:
        typeof values.reason === "string"
          ? values.reason
          : `Manual valuation adjustment to ${estimatedSol} SOL`,
    };
  } else {
    // isDispose
    const reason = values.reason;
    if (!reason || typeof reason !== "string") {
      console.error(
        "[Reconcile] Error: --dispose requires explicit --reason explaining why inventory is permanently closed.",
      );
      process.exit(1);
    }
    options = {
      identifier,
      operationType: "FINAL_DISPOSAL",
      reason,
    };
  }

  try {
    const result = reconcileWalletInventory(wallet, options);
    saveVirtualWallet(wallet);
    appendAuditLog(result.auditRecord);

    console.log("=== RECONCILIATION EXECUTED SUCCESSFULLY ===");
    console.log(`Operation:        ${result.operationType}`);
    console.log(`Position ID:      ${result.matchedPosition.positionId}`);
    console.log(`Mint Address:     ${result.matchedPosition.mintAddress}`);
    console.log(`Tokens Affected:  ${result.matchedPosition.tokensHeld}`);
    console.log(`Cost Basis:       ${result.matchedPosition.costBasisSol.toFixed(4)} SOL`);
    console.log(`Proceeds Realized:${result.proceedsSol.toFixed(4)} SOL`);
    console.log(
      `PnL Delta:        ${result.incrementalPnlSol >= 0 ? "+" : ""}${result.incrementalPnlSol.toFixed(4)} SOL`,
    );
    console.log(`New Cash Balance: ${wallet.currentBalanceSol.toFixed(4)} SOL`);
    console.log(
      `All-Time Realized:${wallet.allTimeRealizedPnlSol >= 0 ? "+" : ""}${wallet.allTimeRealizedPnlSol.toFixed(4)} SOL`,
    );
    console.log(`Remaining Tokens: ${wallet.unresolvedTokens.length}`);
    console.log(`Audit Provenance: ${result.auditRecord.reason}`);
  } catch (err) {
    console.error("[Reconcile] Reconciliation failed:", err);
    process.exit(1);
  }
}

if (process.argv[1]?.includes("reconcile-unresolved")) {
  runReconciliationCli();
}
