import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  loadVirtualWallet,
  saveVirtualWallet,
  reconcileWalletInventory,
  type ReconcileWalletOptions,
} from "../paper/VirtualWallet.js";
import { acquireProcessLock, releaseProcessLock } from "../paper/ProcessLock.js";
import {
  getCanonicalReconciliationAuditPath,
  getCanonicalReconciliationIntentPath,
  findWorkspaceRoot,
} from "../paper/CanonicalPaths.js";

export interface ReconciliationIntent {
  intentId: string;
  createdAtMs: number;
  status: "INTENT_RECORDED" | "FINALIZED";
  options: ReconcileWalletOptions;
  matchedPositionId: string;
  expectedAuditRecord?: Record<string, unknown> | undefined;
}

export function resolveIntentPath(baseDir?: string): string {
  if (baseDir) return path.resolve(baseDir, ".tmp/reconciliation-intent.json");
  return getCanonicalReconciliationIntentPath();
}

export function resolveAuditPath(baseDir?: string): string {
  if (baseDir) return path.resolve(baseDir, ".tmp/reconciliation-audit.jsonl");
  return getCanonicalReconciliationAuditPath();
}

export function appendAuditLog(auditRecord: Record<string, unknown>, baseDir?: string): void {
  const primaryPath = resolveAuditPath(baseDir);
  const line = JSON.stringify(auditRecord) + "\n";
  appendFileSync(primaryPath, line, "utf8");

  // Also sync legacy backend/.tmp mirror if it exists
  const root = baseDir ?? findWorkspaceRoot();
  const legacyDir = path.resolve(root, "backend/.tmp");
  if (existsSync(legacyDir)) {
    const legacyPath = path.resolve(legacyDir, "reconciliation-audit.jsonl");
    if (path.resolve(legacyPath) !== path.resolve(primaryPath)) {
      try {
        appendFileSync(legacyPath, line, "utf8");
      } catch (err) {
        console.warn(`[Reconcile] Warning: Failed to mirror audit log to ${legacyPath}:`, err);
      }
    }
  }
}

export function recoverInterruptedIntent(baseDir?: string): void {
  const intentPath = resolveIntentPath(baseDir);
  if (!existsSync(intentPath)) return;

  try {
    const raw = readFileSync(intentPath, "utf8");
    const intent = JSON.parse(raw) as ReconciliationIntent;
    console.warn(
      `[Reconcile] [RECOVERY] Detected interrupted reconciliation intent (${intent.intentId}, Operation: ${intent.options.operationType}, Position: ${intent.matchedPositionId}). Checking wallet state...`,
    );

    const wallet = loadVirtualWallet();
    const stillPresent = wallet.unresolvedTokens?.some(
      (t) =>
        t.positionId === intent.matchedPositionId || t.mintAddress === intent.options.identifier,
    );

    if (
      intent.options.operationType === "SIMULATED_SALE" ||
      intent.options.operationType === "FINAL_DISPOSAL"
    ) {
      if (!stillPresent) {
        console.log(
          `[Reconcile] [RECOVERY] Operation ${intent.intentId} was already applied in virtual wallet. Verifying audit log durability...`,
        );
        // Ensure audit record was written before cleaning intent
        if (intent.expectedAuditRecord) {
          const auditPath = resolveAuditPath(baseDir);
          let auditContainsRecord = false;
          if (existsSync(auditPath)) {
            const auditLines = readFileSync(auditPath, "utf8").split("\n").filter(Boolean);
            auditContainsRecord = auditLines.some((l) => {
              try {
                const parsed = JSON.parse(l);
                return (
                  parsed.reconciliationId === intent.expectedAuditRecord?.reconciliationId ||
                  parsed.intentId === intent.intentId
                );
              } catch {
                return false;
              }
            });
          }
          if (!auditContainsRecord) {
            console.log(
              `[Reconcile] [RECOVERY] Appending missing audit log entry for recovered intent ${intent.intentId}`,
            );
            appendAuditLog(intent.expectedAuditRecord, baseDir);
          }
        }
        try {
          unlinkSync(intentPath);
        } catch (err) {
          void err;
        }
        return;
      }
    }

    throw new Error(
      `[Reconcile] [FATAL] Interrupted reconciliation intent detected at ${intentPath}. Position ${intent.matchedPositionId} remains in wallet. Manual operator review required before re-attempting.`,
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes("[FATAL]")) throw err;
    throw new Error(
      `[Reconcile] [FATAL] Corrupted reconciliation intent file at ${intentPath}: ${String(err)}`,
    );
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

  // Acquire exclusive process lock before reading or mutating wallet ledger
  const lockHandle = acquireProcessLock({
    processName: "PaperReconcile",
  });

  try {
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

    // Check for prior interrupted reconciliation intent inside exclusive lock
    recoverInterruptedIntent();

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

    // Verify target position exists before intent recording
    const targetIdx = wallet.unresolvedTokens.findIndex(
      (t) => t.positionId === options.identifier || t.mintAddress === options.identifier,
    );
    if (targetIdx < 0) {
      console.error(
        `[Reconcile] Error: No unresolved position found matching '${options.identifier}'. Use --list to verify current inventory.`,
      );
      process.exit(1);
    }
    const targetPos = wallet.unresolvedTokens[targetIdx]!;

    // Dry-run compute audit record for write-ahead intent durability
    const walletSnapshot = JSON.parse(JSON.stringify(wallet));
    const dryRunResult = reconcileWalletInventory(walletSnapshot, options);

    const intentId = `rec-intent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const intent: ReconciliationIntent = {
      intentId,
      createdAtMs: Date.now(),
      status: "INTENT_RECORDED",
      options,
      matchedPositionId: targetPos.positionId,
      expectedAuditRecord: {
        ...dryRunResult.auditRecord,
        intentId,
      },
    };

    const intentPath = resolveIntentPath();
    const tempIntentPath = `${intentPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
    try {
      writeFileSync(tempIntentPath, JSON.stringify(intent, null, 2), "utf8");
      renameSync(tempIntentPath, intentPath);
    } catch (intentErr) {
      console.error("[Reconcile] [FATAL] Failed to persist write-ahead intent:", intentErr);
      process.exit(1);
    }

    // Mutate live wallet state and persist atomically
    const result = reconcileWalletInventory(wallet, options);
    saveVirtualWallet(wallet);

    // Append immutable audit log with intent linkage
    appendAuditLog({
      ...result.auditRecord,
      intentId,
    });

    // Clean up finalized intent
    try {
      unlinkSync(intentPath);
    } catch (err) {
      void err;
    }

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
  } finally {
    releaseProcessLock(lockHandle);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  runReconciliationCli();
}
