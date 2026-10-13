import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { findWorkspaceRoot, getCanonicalWalletPath } from "./CanonicalPaths.js";

export interface UnresolvedTokenInventory {
  readonly positionId: string;
  readonly mintAddress: string;
  readonly symbol?: string | undefined;
  readonly tokensHeld: number;
  readonly costBasisSol: number;
  readonly initialCostBasisSol?: number | undefined;
  readonly initialTokensHeld?: number | undefined;
  readonly realizedProceedsSol?: number | undefined;
  readonly lastObservedPriceSol: number;
  readonly lastObservedAtMs: number;
  readonly reasonForMissingData: string;
  readonly sessionId: string;
  readonly estimatedLiquidationSol?: number | undefined;
}

export interface VirtualWalletState {
  walletAddress: string;
  currentBalanceSol: number;
  initialBalanceSol: number;
  totalSessionsCompleted: number;
  allTimeRealizedPnlSol: number;
  lastUpdatedMs: number;
  settledSessionIds?: string[];
  unresolvedTokens?: UnresolvedTokenInventory[];
}

export const DEFAULT_VIRTUAL_WALLET: VirtualWalletState = {
  walletAddress: "SimulatedVirtualWallet111111111111111111111111",
  currentBalanceSol: 10.0,
  initialBalanceSol: 10.0,
  totalSessionsCompleted: 0,
  allTimeRealizedPnlSol: 0.0,
  lastUpdatedMs: 0,
  settledSessionIds: [],
  unresolvedTokens: [],
};

export function resolveVirtualWalletFile(customPath?: string): string {
  if (customPath) return path.resolve(customPath);
  return getCanonicalWalletPath();
}

export function checkLegacyWalletConflict(canonicalPath: string): void {
  const root = findWorkspaceRoot();
  const legacyPath = path.resolve(root, "backend/.tmp/virtual-wallet.json");
  if (path.resolve(canonicalPath) === legacyPath) return;

  if (existsSync(canonicalPath) && existsSync(legacyPath)) {
    try {
      const cRaw = readFileSync(canonicalPath, "utf8");
      const lRaw = readFileSync(legacyPath, "utf8");
      if (cRaw.trim() === lRaw.trim()) return;

      const cParsed = JSON.parse(cRaw);
      const lParsed = JSON.parse(lRaw);
      const balanceMismatch =
        Math.abs((cParsed.currentBalanceSol ?? 0) - (lParsed.currentBalanceSol ?? 0)) > 1e-6;
      const pnlMismatch =
        Math.abs((cParsed.allTimeRealizedPnlSol ?? 0) - (lParsed.allTimeRealizedPnlSol ?? 0)) >
        1e-6;
      const sessionMismatch =
        JSON.stringify(cParsed.settledSessionIds ?? []) !==
        JSON.stringify(lParsed.settledSessionIds ?? []);
      const tokenMismatch =
        JSON.stringify(cParsed.unresolvedTokens ?? []) !==
        JSON.stringify(lParsed.unresolvedTokens ?? []);

      if (balanceMismatch || pnlMismatch || sessionMismatch || tokenMismatch) {
        throw new Error(
          `[VirtualWallet] [FATAL] Divergent legacy virtual wallet files detected between canonical path (${canonicalPath}) and legacy path (${legacyPath}). ` +
            `Canonical balance: ${cParsed.currentBalanceSol} SOL, Legacy balance: ${lParsed.currentBalanceSol} SOL. ` +
            `Execution halted to require operator review and prevent split-ledger state.`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("[FATAL]")) throw err;
      throw new Error(
        `[VirtualWallet] [FATAL] Error verifying legacy wallet paths (${canonicalPath} vs ${legacyPath}): ${String(err)}`,
      );
    }
  } else if (!existsSync(canonicalPath) && existsSync(legacyPath)) {
    console.log(
      `[VirtualWallet] [MIGRATION] Migrating legacy wallet from ${legacyPath} to canonical path ${canonicalPath}`,
    );
    mkdirSync(path.dirname(canonicalPath), { recursive: true });
    copyFileSync(legacyPath, canonicalPath);
  }
}

export function loadVirtualWallet(customPath?: string): VirtualWalletState {
  const filePath = resolveVirtualWalletFile(customPath);
  if (!customPath) {
    checkLegacyWalletConflict(filePath);
  }
  if (existsSync(filePath)) {
    let raw = "";
    try {
      raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof parsed.currentBalanceSol === "number" &&
        Number.isFinite(parsed.currentBalanceSol) &&
        typeof parsed.allTimeRealizedPnlSol === "number" &&
        Number.isFinite(parsed.allTimeRealizedPnlSol) &&
        typeof parsed.totalSessionsCompleted === "number" &&
        Number.isFinite(parsed.totalSessionsCompleted)
      ) {
        return {
          walletAddress: parsed.walletAddress || DEFAULT_VIRTUAL_WALLET.walletAddress,
          currentBalanceSol: parsed.currentBalanceSol,
          initialBalanceSol:
            typeof parsed.initialBalanceSol === "number" &&
            Number.isFinite(parsed.initialBalanceSol)
              ? parsed.initialBalanceSol
              : 10.0,
          totalSessionsCompleted: parsed.totalSessionsCompleted,
          allTimeRealizedPnlSol: parsed.allTimeRealizedPnlSol,
          lastUpdatedMs:
            typeof parsed.lastUpdatedMs === "number" && Number.isFinite(parsed.lastUpdatedMs)
              ? parsed.lastUpdatedMs
              : Date.now(),
          settledSessionIds: Array.isArray(parsed.settledSessionIds)
            ? parsed.settledSessionIds
            : [], // P0-C: Safe backward-compatible migration without data loss
          unresolvedTokens: Array.isArray(parsed.unresolvedTokens) ? parsed.unresolvedTokens : [], // P0-1: Safe backward-compatible migration for unresolved tokens
        };
      }
      throw new Error(`Invalid wallet structure or non-finite values in ${filePath}`);
    } catch (parseErr) {
      console.error(
        `[PaperDaemon] Corrupt or unreadable virtual wallet at ${filePath}. Creating backup and failing closed...`,
        parseErr,
      );
      const corruptBackup = `${filePath}.corrupt-${Date.now()}`;
      try {
        writeFileSync(corruptBackup, raw, "utf8");
        console.warn(`[PaperDaemon] Preserved corrupt virtual wallet state at ${corruptBackup}`);
      } catch {
        // ignore backup error
      }
      throw new Error(
        `[PaperDaemon] [FATAL] Virtual wallet corrupted or invalid at ${filePath}. Preserved backup at ${corruptBackup}. Startup aborted to fail closed.`,
      );
    }
  }
  const checkDir = customPath ? path.dirname(customPath) : process.cwd();
  const pastSessionsExist = customPath
    ? existsSync(path.join(checkDir, "past-sessions.json")) ||
      existsSync(path.join(checkDir, "sessions"))
    : existsSync(".tmp/past-sessions.json") ||
      existsSync("backend/.tmp/past-sessions.json") ||
      existsSync(".tmp/sessions");
  if (pastSessionsExist) {
    throw new Error(
      `[PaperDaemon] [FATAL] Virtual wallet missing at ${filePath}, but prior session history exists. Startup aborted to fail closed and prevent accidental 10.0 SOL reset. Use --reset-wallet if a fresh session lineage is explicitly intended.`,
    );
  }
  return {
    ...DEFAULT_VIRTUAL_WALLET,
    settledSessionIds: [],
    unresolvedTokens: [],
    lastUpdatedMs: Date.now(),
  };
}

export function saveVirtualWallet(wallet: VirtualWalletState, customPath?: string): void {
  const primaryPath = resolveVirtualWalletFile(customPath);
  const dir = path.dirname(primaryPath);
  mkdirSync(dir, { recursive: true });
  const tempPath = `${primaryPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
  const payload = JSON.stringify(wallet, null, 2);
  writeFileSync(tempPath, payload, "utf8");
  renameSync(tempPath, primaryPath);

  // Synchronize legacy backend/.tmp mirror atomically if it exists, ensuring zero divergence
  if (!customPath) {
    const root = findWorkspaceRoot();
    const legacyPath = path.resolve(root, "backend/.tmp/virtual-wallet.json");
    if (primaryPath !== legacyPath && existsSync(path.dirname(legacyPath))) {
      try {
        const legacyTemp = `${legacyPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
        writeFileSync(legacyTemp, payload, "utf8");
        renameSync(legacyTemp, legacyPath);
      } catch (err) {
        console.warn(
          `[VirtualWallet] Warning: Failed to sync legacy mirror at ${legacyPath}:`,
          err,
        );
      }
    }
  }
}

export function settleSessionInWallet(
  wallet: VirtualWalletState,
  sessionId: string,
  finalCashSol: number,
  initialPortfolioSol: number,
  nowMsTimestamp?: number,
  unresolvedPositions?: readonly {
    positionId: string;
    mintAddress: string;
    symbol?: string | undefined;
    tokensHeld: number;
    costBasisSol: number;
    initialCostBasisSol?: number | undefined;
    initialTokensHeld?: number | undefined;
    realizedProceedsSol?: number | undefined;
    lastObservedPriceSol: number;
    lastObservedAtMs: number;
    reasonForMissingData: string;
  }[],
  sessionRealizedPnlSol?: number,
  reconciledPositionIds?: readonly string[],
): boolean {
  wallet.settledSessionIds = wallet.settledSessionIds ?? [];
  if (wallet.settledSessionIds.includes(sessionId)) {
    return false; // Already settled: idempotent no-op
  }
  wallet.settledSessionIds.push(sessionId);
  wallet.currentBalanceSol = Number(finalCashSol.toFixed(4));

  // P0-1: Settle realized P&L strictly from closed trades and incremental session gains.
  // Do not book unsold unresolved tokens as realized loss!
  const netRealizedPnlSol =
    sessionRealizedPnlSol !== undefined
      ? Number(sessionRealizedPnlSol.toFixed(4))
      : Number((finalCashSol - initialPortfolioSol).toFixed(4));
  wallet.allTimeRealizedPnlSol = Number(
    (wallet.allTimeRealizedPnlSol + netRealizedPnlSol).toFixed(4),
  );

  // P0-1 & P0-R2: Prune reconciled positions from wallet inventory
  wallet.unresolvedTokens = wallet.unresolvedTokens ?? [];
  if (reconciledPositionIds && reconciledPositionIds.length > 0) {
    const reconciledSet = new Set(reconciledPositionIds);
    wallet.unresolvedTokens = wallet.unresolvedTokens.filter(
      (t) => !reconciledSet.has(t.positionId) && !reconciledSet.has(t.mintAddress),
    );
  }

  // P0-1: Record unresolved token holdings into wallet inventory so they are never lost
  if (unresolvedPositions && unresolvedPositions.length > 0) {
    for (const pos of unresolvedPositions) {
      const existingIdx = wallet.unresolvedTokens.findIndex((t) => t.positionId === pos.positionId);
      const inventoryItem: UnresolvedTokenInventory = {
        positionId: pos.positionId,
        mintAddress: pos.mintAddress,
        ...(pos.symbol ? { symbol: pos.symbol } : {}),
        tokensHeld: pos.tokensHeld,
        costBasisSol: pos.costBasisSol,
        initialCostBasisSol: pos.initialCostBasisSol,
        initialTokensHeld: pos.initialTokensHeld,
        realizedProceedsSol: pos.realizedProceedsSol,
        lastObservedPriceSol: pos.lastObservedPriceSol,
        lastObservedAtMs: pos.lastObservedAtMs,
        reasonForMissingData: pos.reasonForMissingData,
        sessionId: (pos as { sessionId?: string }).sessionId ?? sessionId,
        ...("estimatedLiquidationSol" in pos && typeof pos.estimatedLiquidationSol === "number"
          ? { estimatedLiquidationSol: pos.estimatedLiquidationSol }
          : {}),
      };
      if (existingIdx >= 0) {
        wallet.unresolvedTokens[existingIdx] = inventoryItem;
      } else {
        wallet.unresolvedTokens.push(inventoryItem);
      }
    }
  }

  wallet.totalSessionsCompleted += 1;
  wallet.lastUpdatedMs = nowMsTimestamp ?? Date.now();
  return true;
}

export interface ReconcileWalletOptions {
  identifier: string; // positionId or mintAddress
  operationType: "SIMULATED_SALE" | "WRITE_DOWN" | "FINAL_DISPOSAL";
  exitPriceSol?: number;
  writeDownEstimatedSol?: number;
  reason?: string;
  nowMsTimestamp?: number;
}

export interface ReconcileWalletResult {
  operationType: "SIMULATED_SALE" | "WRITE_DOWN" | "FINAL_DISPOSAL";
  matchedPosition: UnresolvedTokenInventory;
  proceedsSol: number;
  incrementalPnlSol: number;
  updatedWallet: VirtualWalletState;
  auditRecord: {
    timestamp: number;
    sessionId?: string | undefined;
    positionId: string;
    mintAddress: string;
    symbol?: string | undefined;
    tokensHeld: number;
    costBasisSol: number;
    operationType: string;
    exitPriceSol?: number | undefined;
    proceedsSol: number;
    incrementalPnlSol: number;
    reason: string;
    previousBalanceSol: number;
    newBalanceSol: number;
    previousAllTimePnlSol: number;
    newAllTimePnlSol: number;
  };
}

export function reconcileWalletInventory(
  wallet: VirtualWalletState,
  options: ReconcileWalletOptions,
): ReconcileWalletResult {
  wallet.unresolvedTokens = wallet.unresolvedTokens ?? [];
  const idx = wallet.unresolvedTokens.findIndex(
    (t) => t.positionId === options.identifier || t.mintAddress === options.identifier,
  );
  if (idx < 0) {
    throw new Error(
      `[VirtualWallet] No unresolved position found for identifier '${options.identifier}'`,
    );
  }
  const pos = wallet.unresolvedTokens[idx]!;
  const now = options.nowMsTimestamp ?? Date.now();
  const prevBalance = wallet.currentBalanceSol;
  const prevPnl = wallet.allTimeRealizedPnlSol;

  if (options.operationType === "WRITE_DOWN") {
    const updatedEst = Math.max(0, options.writeDownEstimatedSol ?? 0);
    wallet.unresolvedTokens[idx] = {
      ...pos,
      estimatedLiquidationSol: updatedEst,
      lastObservedAtMs: now,
    };
    wallet.lastUpdatedMs = now;
    return {
      operationType: "WRITE_DOWN",
      matchedPosition: pos,
      proceedsSol: 0,
      incrementalPnlSol: 0,
      updatedWallet: wallet,
      auditRecord: {
        timestamp: now,
        sessionId: pos.sessionId,
        positionId: pos.positionId,
        mintAddress: pos.mintAddress,
        symbol: pos.symbol,
        tokensHeld: pos.tokensHeld,
        costBasisSol: pos.costBasisSol,
        operationType: "WRITE_DOWN",
        proceedsSol: 0,
        incrementalPnlSol: 0,
        reason: options.reason ?? "Manual valuation adjustment / write-down",
        previousBalanceSol: prevBalance,
        newBalanceSol: prevBalance,
        previousAllTimePnlSol: prevPnl,
        newAllTimePnlSol: prevPnl,
      },
    };
  }

  if (options.operationType === "FINAL_DISPOSAL") {
    const incrementalPnlSol = Number((-pos.costBasisSol).toFixed(4));
    wallet.allTimeRealizedPnlSol = Number(
      (wallet.allTimeRealizedPnlSol + incrementalPnlSol).toFixed(4),
    );
    wallet.unresolvedTokens.splice(idx, 1);
    wallet.lastUpdatedMs = now;
    return {
      operationType: "FINAL_DISPOSAL",
      matchedPosition: pos,
      proceedsSol: 0,
      incrementalPnlSol,
      updatedWallet: wallet,
      auditRecord: {
        timestamp: now,
        sessionId: pos.sessionId,
        positionId: pos.positionId,
        mintAddress: pos.mintAddress,
        symbol: pos.symbol,
        tokensHeld: pos.tokensHeld,
        costBasisSol: pos.costBasisSol,
        operationType: "FINAL_DISPOSAL",
        proceedsSol: 0,
        incrementalPnlSol,
        reason: options.reason ?? "Permanent disposal / abandonment",
        previousBalanceSol: prevBalance,
        newBalanceSol: prevBalance,
        previousAllTimePnlSol: prevPnl,
        newAllTimePnlSol: wallet.allTimeRealizedPnlSol,
      },
    };
  }

  // SIMULATED_SALE
  const exitPriceSol = options.exitPriceSol ?? 0;
  if (exitPriceSol <= 0 || !Number.isFinite(exitPriceSol)) {
    throw new Error(`[VirtualWallet] Invalid exitPriceSol ${exitPriceSol} for simulated sale`);
  }
  const proceedsSol = Number((pos.tokensHeld * exitPriceSol).toFixed(4));
  const incrementalPnlSol = Number((proceedsSol - pos.costBasisSol).toFixed(4));

  wallet.currentBalanceSol = Number((wallet.currentBalanceSol + proceedsSol).toFixed(4));
  wallet.allTimeRealizedPnlSol = Number(
    (wallet.allTimeRealizedPnlSol + incrementalPnlSol).toFixed(4),
  );
  wallet.unresolvedTokens.splice(idx, 1);
  wallet.lastUpdatedMs = now;

  return {
    operationType: "SIMULATED_SALE",
    matchedPosition: pos,
    proceedsSol,
    incrementalPnlSol,
    updatedWallet: wallet,
    auditRecord: {
      timestamp: now,
      sessionId: pos.sessionId,
      positionId: pos.positionId,
      mintAddress: pos.mintAddress,
      symbol: pos.symbol,
      tokensHeld: pos.tokensHeld,
      costBasisSol: pos.costBasisSol,
      operationType: "SIMULATED_SALE",
      exitPriceSol,
      proceedsSol,
      incrementalPnlSol,
      reason: options.reason ?? "Simulated operator sale",
      previousBalanceSol: prevBalance,
      newBalanceSol: wallet.currentBalanceSol,
      previousAllTimePnlSol: prevPnl,
      newAllTimePnlSol: wallet.allTimeRealizedPnlSol,
    },
  };
}
