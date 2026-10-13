import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

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
  const candidates = [
    path.resolve(process.cwd(), ".tmp/virtual-wallet.json"),
    path.resolve(process.cwd(), "backend/.tmp/virtual-wallet.json"),
    path.resolve(process.cwd(), "../.tmp/virtual-wallet.json"),
    path.resolve(process.cwd(), "../backend/.tmp/virtual-wallet.json"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  if (existsSync(path.resolve(process.cwd(), "backend/.tmp"))) {
    return path.resolve(process.cwd(), "backend/.tmp/virtual-wallet.json");
  }
  return path.resolve(process.cwd(), ".tmp/virtual-wallet.json");
}

export function loadVirtualWallet(customPath?: string): VirtualWalletState {
  const filePath = resolveVirtualWalletFile(customPath);
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
  const pastSessionsExist =
    existsSync(".tmp/past-sessions.json") ||
    existsSync("backend/.tmp/past-sessions.json") ||
    existsSync(".tmp/sessions");
  if (pastSessionsExist) {
    console.warn(
      `[PaperDaemon] [WALLET_WARNING] No virtual-wallet.json found at ${filePath}, but prior session history exists. Initializing default 10.0 SOL wallet.`,
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
): boolean {
  wallet.settledSessionIds = wallet.settledSessionIds ?? [];
  if (wallet.settledSessionIds.includes(sessionId)) {
    return false; // Already settled: idempotent no-op
  }
  wallet.settledSessionIds.push(sessionId);
  wallet.currentBalanceSol = Number(finalCashSol.toFixed(4));

  // P0-1: Settle realized P&L strictly from closed trades.
  // Do not book unsold unresolved tokens as realized loss!
  const netRealizedPnlSol =
    sessionRealizedPnlSol !== undefined
      ? Number(sessionRealizedPnlSol.toFixed(4))
      : Number((finalCashSol - initialPortfolioSol).toFixed(4));
  wallet.allTimeRealizedPnlSol = Number(
    (wallet.allTimeRealizedPnlSol + netRealizedPnlSol).toFixed(4),
  );

  // P0-1: Record unresolved token holdings into wallet inventory so they are never lost
  wallet.unresolvedTokens = wallet.unresolvedTokens ?? [];
  if (unresolvedPositions && unresolvedPositions.length > 0) {
    for (const pos of unresolvedPositions) {
      if (!wallet.unresolvedTokens.some((t) => t.positionId === pos.positionId)) {
        wallet.unresolvedTokens.push({
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
          sessionId,
        });
      }
    }
  }

  wallet.totalSessionsCompleted += 1;
  wallet.lastUpdatedMs = nowMsTimestamp ?? Date.now();
  return true;
}
