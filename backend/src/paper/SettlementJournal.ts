import path from "node:path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { BACKFILLED_PAST_SESSIONS, type HistoricalSessionSummary } from "@nexustrade/shared";
import {
  getCanonicalJournalPath,
  getCanonicalSessionFilePath,
  getCanonicalPastSessionsPath,
  getCanonicalWalletPath,
  getCanonicalSessionsDir,
  findWorkspaceRoot,
} from "./CanonicalPaths.js";
import { loadVirtualWallet, saveVirtualWallet, settleSessionInWallet } from "./VirtualWallet.js";

export { findWorkspaceRoot };

export type SettlementJournalStage =
  | "STARTED"
  | "SESSION_FILE_WRITTEN"
  | "PAST_SESSIONS_WRITTEN"
  | "WALLET_SETTLED"
  | "COMMITTED";

export interface SettlementJournalEntry {
  sessionId: string;
  stage: SettlementJournalStage;
  startedAtMs: number;
  updatedAtMs?: number | undefined;
  sessionSummary: HistoricalSessionSummary;
  liquidCashSol: number;
  initialPortfolioSol: number;
  sessionNewRealizedPnlSol: number;
  unresolvedPositions?:
    | readonly {
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
      }[]
    | undefined;
  reconciledPositionIds?: readonly string[] | undefined;
}

export interface RecoverJournalOptions {
  journalPath?: string | undefined;
  workspaceRoot?: string | undefined;
  baseDir?: string | undefined;
  walletPath?: string | undefined;
}

export interface RecoverJournalResult {
  recovered: boolean;
  sessionId?: string | undefined;
  stageReplayed?: SettlementJournalStage | undefined;
}

export function resolveJournalPath(customBaseDir?: string): string {
  const root = customBaseDir ?? findWorkspaceRoot();
  return getCanonicalJournalPath(root);
}

/**
 * Atomically writes or updates the settlement journal.
 * Throws on failure to ensure fail-closed behavior.
 */
export function writeSettlementJournal(
  entry: SettlementJournalEntry,
  customJournalPath?: string,
): void {
  const journalPath = customJournalPath ?? getCanonicalJournalPath();
  const dir = path.dirname(journalPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tempPath = `${journalPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
  try {
    writeFileSync(tempPath, JSON.stringify(entry, null, 2), "utf8");
    renameSync(tempPath, journalPath);
  } catch (err) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // ignore temp cleanup error
    }
    throw new Error(
      `[SettlementJournal] [FATAL] Settlement journal write failed at stage ${entry.stage}: ${String(err)}. Archival aborted to fail closed.`,
    );
  }
}

/**
 * Updates stage and writes atomically.
 */
export function updateSettlementJournalStage(
  stage: SettlementJournalStage,
  currentEntry: SettlementJournalEntry,
  customJournalPath?: string,
): SettlementJournalEntry {
  currentEntry.stage = stage;
  currentEntry.updatedAtMs = Date.now();
  writeSettlementJournal(currentEntry, customJournalPath);
  return currentEntry;
}

/**
 * Removes settlement journal file once committed.
 */
export function cleanSettlementJournal(customJournalPath?: string): void {
  const journalPath = customJournalPath ?? getCanonicalJournalPath();
  if (existsSync(journalPath)) {
    try {
      unlinkSync(journalPath);
    } catch (err) {
      console.warn(`[SettlementJournal] Warning: Failed to clean journal at ${journalPath}:`, err);
    }
  }
}

/**
 * Replays any pending settlement operations recorded in the journal.
 * Strictly idempotent: safe to call repeatedly.
 * Replays session file, past-sessions.json, and virtual wallet settlement.
 */
export function recoverSettlementJournal(options?: RecoverJournalOptions): RecoverJournalResult {
  const root = options?.workspaceRoot ?? options?.baseDir ?? findWorkspaceRoot();
  const canonicalJournalPath = getCanonicalJournalPath(root);
  const legacyJournalPath = path.resolve(root, "backend/.tmp/settlement-journal.json");

  // If options.journalPath is explicitly provided (e.g. In tests), use it directly.
  // Otherwise, inspect canonical vs legacy paths with strict fail-closed safety.
  let journalPathToRecover: string | undefined;

  if (options?.journalPath) {
    journalPathToRecover = options.journalPath;
  } else {
    const hasCanonical = existsSync(canonicalJournalPath);
    const hasLegacy =
      path.resolve(canonicalJournalPath) !== legacyJournalPath && existsSync(legacyJournalPath);

    if (hasCanonical && hasLegacy) {
      throw new Error(
        `[SettlementJournal] [FATAL] Conflicting settlement journals found simultaneously at canonical path (${canonicalJournalPath}) and legacy path (${legacyJournalPath}). Manual operator review required. Recovery halted.`,
      );
    }
    if (!hasCanonical && hasLegacy) {
      throw new Error(
        `[SettlementJournal] [FATAL] Legacy settlement journal found at ${legacyJournalPath}, but canonical journal is missing at ${canonicalJournalPath}. Automatic replay is disabled; manual operator review required.`,
      );
    }
    if (hasCanonical) {
      journalPathToRecover = canonicalJournalPath;
    }
  }

  if (!journalPathToRecover || !existsSync(journalPathToRecover)) {
    return { recovered: false };
  }

  const journalPath = journalPathToRecover;
  let entry: SettlementJournalEntry;
  try {
    const raw = readFileSync(journalPath, "utf8");
    entry = JSON.parse(raw) as SettlementJournalEntry;
  } catch (readErr) {
    throw new Error(
      `[SettlementJournal] [FATAL] Corrupted settlement journal at ${journalPath}: ${String(readErr)}. Manual inspection required.`,
    );
  }

  if (!entry || !entry.sessionId || entry.stage === "COMMITTED") {
    cleanSettlementJournal(journalPath);
    return { recovered: false };
  }

  console.warn(
    `[SettlementJournal] [RECOVERY] Detected uncommitted settlement journal for session ${entry.sessionId} at stage ${entry.stage}. Replaying remaining settlement operations...`,
  );

  const initialStage = entry.stage;
  const targetBaseDir = root;

  // Replay Stage 1: Individual session file
  if (entry.stage === "STARTED") {
    const sessionsDir = getCanonicalSessionsDir(targetBaseDir);
    if (!existsSync(sessionsDir)) {
      mkdirSync(sessionsDir, { recursive: true });
    }
    const sessionFile = getCanonicalSessionFilePath(entry.sessionId, targetBaseDir);
    if (!existsSync(sessionFile)) {
      const tempSessionFile = `${sessionFile}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
      writeFileSync(tempSessionFile, JSON.stringify(entry.sessionSummary, null, 2), "utf8");
      renameSync(tempSessionFile, sessionFile);
      console.log(
        `[SettlementJournal] [RECOVERY] Replayed individual session file: ${sessionFile}`,
      );
    }
    updateSettlementJournalStage("SESSION_FILE_WRITTEN", entry, journalPath);
  }

  // Replay Stage 2: past-sessions.json
  if (entry.stage === "SESSION_FILE_WRITTEN") {
    const pastSessionsPath = getCanonicalPastSessionsPath(targetBaseDir);
    let pastSessions: HistoricalSessionSummary[] = [];
    if (existsSync(pastSessionsPath)) {
      const pastRaw = readFileSync(pastSessionsPath, "utf8");
      try {
        const parsed = JSON.parse(pastRaw);
        if (Array.isArray(parsed)) {
          pastSessions = parsed;
        } else {
          throw new Error("past-sessions.json is not an array");
        }
      } catch (parseErr) {
        const corruptBackup = `${pastSessionsPath}.corrupt-${Date.now()}`;
        try {
          writeFileSync(corruptBackup, pastRaw, "utf8");
        } catch {
          // ignore backup failure
        }
        throw new Error(
          `[SettlementJournal] [FATAL] Corrupted past-sessions.json encountered during journal recovery: ${String(parseErr)}. Backed up to ${corruptBackup}. Recovery halted to prevent historical data loss.`,
        );
      }
    } else {
      pastSessions = [...BACKFILLED_PAST_SESSIONS];
    }

    const existingIdx = pastSessions.findIndex((s) => s.sessionId === entry.sessionId);
    if (existingIdx < 0) {
      pastSessions.unshift(entry.sessionSummary);
      const tempPast = `${pastSessionsPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
      writeFileSync(tempPast, JSON.stringify(pastSessions, null, 2), "utf8");
      renameSync(tempPast, pastSessionsPath);
      console.log(
        `[SettlementJournal] [RECOVERY] Replayed past-sessions.json index update for session ${entry.sessionId}`,
      );
    }
    updateSettlementJournalStage("PAST_SESSIONS_WRITTEN", entry, journalPath);
  }

  // Replay Stage 3: Virtual wallet settlement
  if (entry.stage === "PAST_SESSIONS_WRITTEN") {
    const walletPath = options?.walletPath ?? getCanonicalWalletPath(targetBaseDir);
    const wallet = loadVirtualWallet(walletPath);
    if (!wallet.settledSessionIds?.includes(entry.sessionId)) {
      const settled = settleSessionInWallet(
        wallet,
        entry.sessionId,
        entry.liquidCashSol,
        entry.initialPortfolioSol,
        Date.now(),
        entry.unresolvedPositions,
        entry.sessionNewRealizedPnlSol,
        entry.reconciledPositionIds,
      );
      if (settled) {
        saveVirtualWallet(wallet, walletPath);
        console.log(
          `[SettlementJournal] [RECOVERY] Replayed virtual wallet settlement for session ${entry.sessionId}. New Balance: ${wallet.currentBalanceSol} SOL`,
        );
      }
    }
    updateSettlementJournalStage("WALLET_SETTLED", entry, journalPath);
  }

  // Replay Stage 4: Journal commitment / cleanup
  cleanSettlementJournal(journalPath);
  console.log(
    `[SettlementJournal] [RECOVERY] Settlement journal for session ${entry.sessionId} fully recovered and cleaned.`,
  );

  return {
    recovered: true,
    sessionId: entry.sessionId,
    stageReplayed: initialStage,
  };
}
