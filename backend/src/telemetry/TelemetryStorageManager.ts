import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  getCanonicalCandidateDecisionsPath,
  getCanonicalMarketObservationsPath,
  getCanonicalSessionMetaPath,
  getCanonicalSessionTelemetrySummaryPath,
  getCanonicalStratifiedSamplesPath,
  getCanonicalTelemetrySessionDir,
  validateSessionId,
} from "../paper/CanonicalPaths.js";
import type {
  CandidateDecisionRecord,
  MarketObservationRecord,
  SessionTelemetryMeta,
  SessionTelemetrySummary,
  StratifiedSamplingRecord,
} from "./TelemetryTypes.js";
import { resolveStrategyRevision } from "./RevisionHelper.js";

/**
 * Validates and repairs crash-damaged JSONL file boundaries on startup / recovery.
 * If a malformed trailing line or unterminated tail is found at the very end of the file,
 * it quarantines the damaged tail to `<filePath>.corrupt-<timestamp>` and restores a valid
 * newline-terminated append boundary.
 *
 * If malformed content is found interior (followed by valid lines), it throws [FATAL_CORRUPT_LINE]
 * to fail closed against corrupt history.
 */
export function repairAndQuarantineDamagedTail<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];

  const rawBytes = readFileSync(filePath);
  if (rawBytes.length === 0) return [];

  const rawContent = rawBytes.toString("utf8");
  const rawLines = rawContent.split("\n");
  const validRecords: T[] = [];
  const validLineStrings: string[] = [];
  let damagedTailDetected = false;
  let damagedTailContent = "";
  let damagedTailLineIndex = -1;

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!.trim();
    if (raw.length === 0) continue;

    try {
      const parsed = JSON.parse(raw) as T;
      if (damagedTailDetected) {
        // A valid line appeared AFTER a corrupt line -> Interior corruption!
        throw new Error(
          `[TelemetryStorageManager] [FATAL_CORRUPT_LINE] Malformed interior line in ${filePath}:${damagedTailLineIndex + 1}. History cannot be silently truncated.`,
        );
      }
      validRecords.push(parsed);
      validLineStrings.push(JSON.stringify(parsed));
    } catch (err) {
      if (damagedTailDetected) {
        throw new Error(
          `[TelemetryStorageManager] [FATAL_CORRUPT_LINE] Multiple malformed lines in ${filePath}:${i + 1}: ${String(err)}`,
        );
      }

      // Check if this error is at the tail (all remaining lines are empty/whitespace)
      const remainingLines = rawLines.slice(i + 1).filter((l) => l.trim().length > 0);
      if (remainingLines.length === 0) {
        damagedTailDetected = true;
        damagedTailContent = raw;
        damagedTailLineIndex = i;
      } else {
        throw new Error(
          `[TelemetryStorageManager] [FATAL_CORRUPT_LINE] Malformed interior line in ${filePath}:${i + 1}: ${String(err)}`,
        );
      }
    }
  }

  // If damaged tail detected, quarantine it and restore clean append boundary
  if (damagedTailDetected) {
    const timestamp = Date.now();
    const quarantinePath = `${filePath}.corrupt-${timestamp}`;
    writeFileSync(quarantinePath, damagedTailContent, "utf8");
    console.warn(
      `[TelemetryStorageManager] Quarantined damaged tail from ${filePath}:${damagedTailLineIndex + 1} to ${quarantinePath}`,
    );

    // Rewrite file cleanly with valid lines followed by newline
    const cleanContent = validLineStrings.length > 0 ? validLineStrings.join("\n") + "\n" : "";
    const tempCleanPath = `${filePath}.${crypto.randomUUID()}.tmp`;
    writeFileSync(tempCleanPath, cleanContent, "utf8");
    renameSync(tempCleanPath, filePath);
  } else if (!rawContent.endsWith("\n") && rawContent.length > 0) {
    // If the file was not newline-terminated, append a newline to ensure safe subsequent appends
    const fixedContent = rawContent + "\n";
    const tempCleanPath = `${filePath}.${crypto.randomUUID()}.tmp`;
    writeFileSync(tempCleanPath, fixedContent, "utf8");
    renameSync(tempCleanPath, filePath);
  }

  return validRecords;
}

export class TelemetryStorageManager {
  private readonly workspaceRoot?: string | undefined;
  private readonly verifiedFiles = new Set<string>();
  private marketObservationsCount = 0;
  private candidateDecisionsCount = 0;
  private decisionWriteFailuresCount = 0;

  constructor(workspaceRoot?: string | undefined) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Performs locked/bounded recovery of a file's boundary.
   * Full scan and quarantine runs only once per file during startup / recovery.
   */
  public recoverFileBoundary<T>(filePath: string): T[] {
    const records = repairAndQuarantineDamagedTail<T>(filePath);
    this.verifiedFiles.add(filePath);
    return records;
  }

  /**
   * Fast, bounded O(1) append path.
   * Validates startup integrity once, then ensures trailing newline via single-byte inspection.
   */
  private appendJsonLineFast(filePath: string, obj: unknown): void {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Run startup recovery once per file to ensure trailing newline and repair corrupt tails
    if (!this.verifiedFiles.has(filePath)) {
      this.recoverFileBoundary(filePath);
    }

    appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf8");
  }

  public initSessionTelemetry(
    sessionId: string,
    generationId: string,
    initialBalanceSol: number,
  ): SessionTelemetryMeta {
    validateSessionId(sessionId);
    const sessionDir = getCanonicalTelemetrySessionDir(sessionId, this.workspaceRoot);
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }

    // Recover files for this session on initialization and restore durable counters
    const existingDecisions = this.recoverFileBoundary<CandidateDecisionRecord>(
      getCanonicalCandidateDecisionsPath(sessionId, this.workspaceRoot),
    );
    this.candidateDecisionsCount = existingDecisions.length;

    const existingObservations = this.recoverFileBoundary<MarketObservationRecord>(
      getCanonicalMarketObservationsPath(sessionId, this.workspaceRoot),
    );
    this.marketObservationsCount = existingObservations.length;

    this.recoverFileBoundary(getCanonicalStratifiedSamplesPath(sessionId, this.workspaceRoot));

    const metaPath = getCanonicalSessionMetaPath(sessionId, this.workspaceRoot);
    if (existsSync(metaPath)) {
      let existingMeta: SessionTelemetryMeta;
      try {
        existingMeta = JSON.parse(readFileSync(metaPath, "utf8")) as SessionTelemetryMeta;
      } catch (err) {
        const quarantinePath = `${metaPath}.corrupt-${Date.now()}`;
        try {
          renameSync(metaPath, quarantinePath);
        } catch {
          // ignore rename failure
        }
        throw new Error(
          `[TelemetryStorageManager] [FATAL_CORRUPT_SESSION_META] Corrupted session metadata in ${metaPath}; quarantined to ${quarantinePath}: ${String(err)}`,
        );
      }

      // Prohibit session ID reuse with a different generation ID
      if (existingMeta.generationId !== generationId) {
        throw new Error(
          `[TelemetryStorageManager] [FATAL_SESSION_GENERATION_MISMATCH] Session "${sessionId}" is already registered to generation "${existingMeta.generationId}", cannot re-bind to "${generationId}".`,
        );
      }

      // Phase 12.94-B B4-03 Policy:
      // Same-session resume with active follow-up tracker replay is NOT supported.
      // Explicitly mark interrupted session so downstream research filters out incomplete monitoring trajectories.
      if (existingMeta.sessionStatus !== "FINALIZED") {
        existingMeta = {
          ...existingMeta,
          sessionStatus: "INTERRUPTED",
          isInterruptedSession: true,
          resumedFromPriorCrash: true,
        };
        const tempPath = `${metaPath}.${crypto.randomUUID()}.tmp`;
        const fd = openSync(tempPath, "w");
        try {
          writeFileSync(fd, JSON.stringify(existingMeta, null, 2), "utf8");
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tempPath, metaPath);
      }

      return existingMeta;
    }

    const meta: SessionTelemetryMeta = {
      sessionId,
      generationId,
      strategyRevision: resolveStrategyRevision(),
      startedAtIso: new Date().toISOString(),
      initialWalletBalanceSol: initialBalanceSol,
      environment: {
        platform: os.platform(),
        nodeVersion: process.version,
      },
      sessionStatus: "ACTIVE",
      isInterruptedSession: false,
    };

    const tempPath = `${metaPath}.${crypto.randomUUID()}.tmp`;
    const fd = openSync(tempPath, "w");
    try {
      writeFileSync(fd, JSON.stringify(meta, null, 2), "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, metaPath);

    return meta;
  }

  public appendCandidateDecision(record: CandidateDecisionRecord): void {
    validateSessionId(record.sessionId);
    const filePath = getCanonicalCandidateDecisionsPath(record.sessionId, this.workspaceRoot);
    try {
      this.appendJsonLineFast(filePath, record);
      this.candidateDecisionsCount++;
    } catch (err) {
      this.decisionWriteFailuresCount++;
      throw err;
    }
  }

  public appendMarketObservation(record: MarketObservationRecord): void {
    validateSessionId(record.sessionId);
    const filePath = getCanonicalMarketObservationsPath(record.sessionId, this.workspaceRoot);
    this.appendJsonLineFast(filePath, record);
    this.marketObservationsCount++;
  }

  public appendStratifiedSample(record: StratifiedSamplingRecord): void {
    validateSessionId(record.sessionId);
    const filePath = getCanonicalStratifiedSamplesPath(record.sessionId, this.workspaceRoot);
    this.appendJsonLineFast(filePath, record);
  }

  public readCandidateDecisions(sessionId: string): CandidateDecisionRecord[] {
    validateSessionId(sessionId);
    const filePath = getCanonicalCandidateDecisionsPath(sessionId, this.workspaceRoot);
    return repairAndQuarantineDamagedTail<CandidateDecisionRecord>(filePath);
  }

  public readMarketObservations(sessionId: string): MarketObservationRecord[] {
    validateSessionId(sessionId);
    const filePath = getCanonicalMarketObservationsPath(sessionId, this.workspaceRoot);
    return repairAndQuarantineDamagedTail<MarketObservationRecord>(filePath);
  }

  public readStratifiedSamples(sessionId: string): StratifiedSamplingRecord[] {
    validateSessionId(sessionId);
    const filePath = getCanonicalStratifiedSamplesPath(sessionId, this.workspaceRoot);
    return repairAndQuarantineDamagedTail<StratifiedSamplingRecord>(filePath);
  }

  public getCandidateDecisionsCount(): number {
    return this.candidateDecisionsCount;
  }

  public getMarketObservationsCount(): number {
    return this.marketObservationsCount;
  }

  public getDecisionWriteFailures(): number {
    return this.decisionWriteFailuresCount;
  }

  public getDecisionWriteFailuresCount(): number {
    return this.decisionWriteFailuresCount;
  }

  public isSummaryMatching(
    existing: SessionTelemetrySummary,
    candidate: Omit<SessionTelemetrySummary, "sessionId" | "closedAtIso">,
  ): boolean {
    if (
      existing.generationId !== candidate.generationId ||
      existing.strategyRevision !== candidate.strategyRevision ||
      existing.startedAtIso !== candidate.startedAtIso ||
      Boolean(existing.isCompleteSession) !== Boolean(candidate.isCompleteSession) ||
      Boolean(existing.isInterruptedSession) !== Boolean(candidate.isInterruptedSession) ||
      existing.totalCandidatesScreened !== candidate.totalCandidatesScreened ||
      existing.totalDecisionsRecorded !== candidate.totalDecisionsRecorded ||
      existing.totalMarketObservationsRecorded !== candidate.totalMarketObservationsRecorded ||
      existing.totalStratifiedCandidatesTracked !== candidate.totalStratifiedCandidatesTracked ||
      existing.decisionWriteFailures !== candidate.decisionWriteFailures ||
      (existing.decisionCallbackErrors ?? 0) !== (candidate.decisionCallbackErrors ?? 0) ||
      (existing.rateShedCount ?? 0) !== (candidate.rateShedCount ?? 0) ||
      (existing.totalScannerDecisionsRecorded ?? 0) !==
        (candidate.totalScannerDecisionsRecorded ?? 0) ||
      (existing.totalTriggerDecisionsRecorded ?? 0) !==
        (candidate.totalTriggerDecisionsRecorded ?? 0) ||
      (existing.totalExecutedBuyDecisionsRecorded ?? 0) !==
        (candidate.totalExecutedBuyDecisionsRecorded ?? 0) ||
      existing.missedWinnersCount !== candidate.missedWinnersCount ||
      existing.avoidedRugsCount !== candidate.avoidedRugsCount
    ) {
      return false;
    }

    const cohorts: Array<keyof SessionTelemetrySummary["cohortBreakdown"]> = [
      "filteredRejected",
      "watchlistRadar",
      "triggerRejected",
      "executedBuy",
    ];
    for (const c of cohorts) {
      if ((existing.cohortBreakdown[c] ?? 0) !== (candidate.cohortBreakdown[c] ?? 0)) {
        return false;
      }
    }

    const existingRejections = existing.topRejectionReasons ?? {};
    const candidateRejections = candidate.topRejectionReasons ?? {};
    const existingKeys = Object.keys(existingRejections).sort();
    const candidateKeys = Object.keys(candidateRejections).sort();
    if (existingKeys.length !== candidateKeys.length) {
      return false;
    }
    for (let i = 0; i < existingKeys.length; i++) {
      const key = existingKeys[i]!;
      if (key !== candidateKeys[i]) {
        return false;
      }
      if (existingRejections[key] !== candidateRejections[key]) {
        return false;
      }
    }

    return true;
  }

  public finalizeSessionTelemetry(
    sessionId: string,
    summaryData: Omit<SessionTelemetrySummary, "sessionId" | "closedAtIso">,
  ): SessionTelemetrySummary {
    validateSessionId(sessionId);
    const summaryPath = getCanonicalSessionTelemetrySummaryPath(sessionId, this.workspaceRoot);
    const metaPath = getCanonicalSessionMetaPath(sessionId, this.workspaceRoot);
    const closedAtIso = new Date().toISOString();

    // 1. Authoritative session metadata validation (B5-02)
    if (!existsSync(metaPath)) {
      throw new Error(
        `[TelemetryStorageManager] [FATAL_MISSING_SESSION_META] Cannot finalize session "${sessionId}": session-meta.json does not exist.`,
      );
    }

    let meta: SessionTelemetryMeta;
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf8")) as SessionTelemetryMeta;
      if (meta.generationId !== summaryData.generationId) {
        throw new Error(
          `[TelemetryStorageManager] [FATAL_SESSION_GENERATION_MISMATCH] Cannot finalize session "${sessionId}" with generation "${summaryData.generationId}" when metadata belongs to "${meta.generationId}".`,
        );
      }
    } catch (metaErr) {
      if (
        metaErr instanceof Error &&
        metaErr.message.includes("FATAL_SESSION_GENERATION_MISMATCH")
      ) {
        throw metaErr;
      }
      const quarantinePath = `${metaPath}.corrupt-${Date.now()}`;
      try {
        renameSync(metaPath, quarantinePath);
      } catch {
        // ignore rename failure
      }
      throw new Error(
        `[TelemetryStorageManager] [FATAL_CORRUPT_SESSION_META] Cannot finalize session "${sessionId}" with corrupted metadata: ${String(metaErr)}`,
      );
    }

    // 2. Derive interruption/completeness authoritatively from persisted metadata (B5-02)
    const isPersistedInterrupted = Boolean(meta.isInterruptedSession);
    if (isPersistedInterrupted) {
      if (summaryData.isCompleteSession === true || summaryData.isInterruptedSession === false) {
        throw new Error(
          `[TelemetryStorageManager] [FATAL_INVALID_COMPLETENESS_OVERRIDE] Cannot finalize interrupted session "${sessionId}" with isCompleteSession=true or isInterruptedSession=false. Persisted session metadata authoritatively marks this session as INTERRUPTED.`,
        );
      }
    }

    const isInterruptedSession =
      isPersistedInterrupted ||
      summaryData.isInterruptedSession === true ||
      summaryData.isCompleteSession === false;
    const isCompleteSession = !isInterruptedSession;

    const candidateSummary: Omit<SessionTelemetrySummary, "sessionId" | "closedAtIso"> = {
      ...summaryData,
      isCompleteSession,
      isInterruptedSession,
    };

    // 3. Robust finalization check (B4-03, B5-02 & B5-03):
    // Verify canonical complete summary matches, including observations, execution, follow-up, cohorts, completeness, and rejection distributions.
    if (existsSync(summaryPath)) {
      try {
        const existing = JSON.parse(readFileSync(summaryPath, "utf8")) as SessionTelemetrySummary;
        if (existing.generationId !== candidateSummary.generationId) {
          throw new Error(
            `[TelemetryStorageManager] [FATAL_SESSION_GENERATION_MISMATCH] Session summary already exists under generation "${existing.generationId}", cannot overwrite with "${candidateSummary.generationId}".`,
          );
        }
        if (this.isSummaryMatching(existing, candidateSummary)) {
          return existing;
        }
        throw new Error(
          `[TelemetryStorageManager] [FATAL_SESSION_ALREADY_FINALIZED] Session "${sessionId}" already has a finalized summary with conflicting metrics, rejection distribution, or completeness. Cannot destructively overwrite a finalized session summary.`,
        );
      } catch (parseErr) {
        if (
          parseErr instanceof Error &&
          (parseErr.message.includes("FATAL_SESSION_GENERATION_MISMATCH") ||
            parseErr.message.includes("FATAL_SESSION_ALREADY_FINALIZED"))
        ) {
          throw parseErr;
        }
        // Malformed summary on disk: quarantine before proceeding
        const quarantinePath = `${summaryPath}.corrupt-${Date.now()}`;
        renameSync(summaryPath, quarantinePath);
      }
    }

    const summary: SessionTelemetrySummary = {
      ...candidateSummary,
      sessionId,
      closedAtIso,
    };

    const tempPath = `${summaryPath}.${crypto.randomUUID()}.tmp`;
    const fd = openSync(tempPath, "w");
    try {
      writeFileSync(fd, JSON.stringify(summary, null, 2), "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, summaryPath);

    // 4. Update meta.json with closedAtIso and final sessionStatus (B5-02: fail closed, do not silently swallow failures)
    const updatedMeta: SessionTelemetryMeta = {
      ...meta,
      closedAtIso,
      sessionStatus: isInterruptedSession ? "INTERRUPTED" : "FINALIZED",
      isInterruptedSession,
    };
    const tempMetaPath = `${metaPath}.${crypto.randomUUID()}.tmp`;
    const metaFd = openSync(tempMetaPath, "w");
    try {
      writeFileSync(metaFd, JSON.stringify(updatedMeta, null, 2), "utf8");
      fsyncSync(metaFd);
    } finally {
      closeSync(metaFd);
    }
    renameSync(tempMetaPath, metaPath);

    return summary;
  }
}
