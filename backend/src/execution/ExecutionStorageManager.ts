/**
 * Phase 12.94-C: Execution Storage Manager & Cross-File Consistency Validator
 *
 * Implements crash-safe, append-only JSONL persistence for:
 * - execution-quotes.jsonl
 * - simulated-fills.jsonl
 *
 * Provides authoritative cross-file session finalization verification:
 * - verifySessionCrossFileConsistency() enforces generation identity, session identity,
 *   interrupted session flags, and observation/decision accounting coherence across files.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import {
  getCanonicalExecutionQuotesPath,
  getCanonicalSimulatedFillsPath,
  getCanonicalTelemetrySessionDir,
  validateSessionId,
} from "../paper/CanonicalPaths.js";
import { repairAndQuarantineDamagedTail } from "../telemetry/TelemetryStorageManager.js";
import type {
  CrossFileConsistencyCheckResult,
  ExecutableQuoteRecord,
  SimulatedFillRecord,
} from "./ExecutionTypes.js";
import type {
  CandidateDecisionRecord,
  MarketObservationRecord,
  SessionTelemetryMeta,
  SessionTelemetrySummary,
} from "../telemetry/TelemetryTypes.js";

export class ExecutionStorageManager {
  private readonly workspaceRoot?: string | undefined;

  constructor(workspaceRoot?: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Appends an executable quote record to canonical execution-quotes.jsonl.
   */
  public recordQuote(quote: ExecutableQuoteRecord): void {
    const validSessionId = validateSessionId(quote.sessionId);
    const sessionDir = getCanonicalTelemetrySessionDir(validSessionId, this.workspaceRoot);
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }

    const quotesPath = getCanonicalExecutionQuotesPath(validSessionId, this.workspaceRoot);
    this.appendSyncWithFsync(quotesPath, JSON.stringify(quote));
  }

  /**
   * Appends a simulated fill record to canonical simulated-fills.jsonl for a given session.
   */
  public recordFill(sessionId: string, fill: SimulatedFillRecord): void {
    this.recordFillForSession(sessionId, fill);
  }

  /**
   * Appends a simulated fill record explicitly with sessionId.
   */
  public recordFillForSession(sessionId: string, fill: SimulatedFillRecord): void {
    const validSessionId = validateSessionId(sessionId);
    const sessionDir = getCanonicalTelemetrySessionDir(validSessionId, this.workspaceRoot);
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }

    const fillsPath = getCanonicalSimulatedFillsPath(validSessionId, this.workspaceRoot);
    this.appendSyncWithFsync(fillsPath, JSON.stringify(fill));
  }

  /**
   * Reads all quotes for a session, quarantining any damaged tail.
   */
  public getQuotesForSession(sessionId: string): ExecutableQuoteRecord[] {
    const validSessionId = validateSessionId(sessionId);
    const quotesPath = getCanonicalExecutionQuotesPath(validSessionId, this.workspaceRoot);
    return repairAndQuarantineDamagedTail<ExecutableQuoteRecord>(quotesPath);
  }

  /**
   * Reads all fills for a session, quarantining any damaged tail.
   */
  public getFillsForSession(sessionId: string): SimulatedFillRecord[] {
    const validSessionId = validateSessionId(sessionId);
    const fillsPath = getCanonicalSimulatedFillsPath(validSessionId, this.workspaceRoot);
    return repairAndQuarantineDamagedTail<SimulatedFillRecord>(fillsPath);
  }

  /**
   * Writes a line with an fsync flush for atomic durability.
   */
  private appendSyncWithFsync(filePath: string, line: string): void {
    if (!existsSync(filePath)) {
      const fd = openSync(filePath, "w");
      closeSync(fd);
    }
    appendFileSync(filePath, line + "\n", { encoding: "utf8" });
    const fd = openSync(filePath, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

/**
 * Authoritative cross-file session finalization validator.
 * Enforces consistency between session-meta.json, session-summary.json,
 * candidate-decisions.jsonl, market-observations.jsonl, and execution files.
 */
export function verifySessionCrossFileConsistency(
  sessionDir: string,
): CrossFileConsistencyCheckResult {
  if (!existsSync(sessionDir)) {
    return {
      valid: false,
      reason: `Session directory '${sessionDir}' does not exist`,
    };
  }

  const metaPath = path.join(sessionDir, "session-meta.json");
  const summaryPath = path.join(sessionDir, "session-summary.json");

  // 1. Mandatory Metadata & Summary Files Check
  if (!existsSync(metaPath)) {
    return {
      valid: false,
      reason: `Mandatory session-meta.json missing in '${sessionDir}'`,
    };
  }
  if (!existsSync(summaryPath)) {
    return {
      valid: false,
      reason: `Mandatory session-summary.json missing in '${sessionDir}'`,
    };
  }

  let meta: SessionTelemetryMeta;
  let summary: SessionTelemetrySummary;

  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8")) as SessionTelemetryMeta;
  } catch (err) {
    return {
      valid: false,
      reason: `Failed to parse session-meta.json: ${String(err)}`,
    };
  }

  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8")) as SessionTelemetrySummary;
  } catch (err) {
    return {
      valid: false,
      reason: `Failed to parse session-summary.json: ${String(err)}`,
    };
  }

  // 2. Session ID Match Check
  if (meta.sessionId !== summary.sessionId) {
    return {
      valid: false,
      reason: `Session ID mismatch: meta '${meta.sessionId}' vs summary '${summary.sessionId}'`,
    };
  }

  // 3. Generation ID Match Check
  if (meta.generationId !== summary.generationId) {
    return {
      valid: false,
      reason: `Generation ID mismatch: meta '${meta.generationId}' vs summary '${summary.generationId}'`,
    };
  }

  // 4. Strategy Revision Match Check
  if (meta.strategyRevision !== summary.strategyRevision) {
    return {
      valid: false,
      reason: `Strategy revision mismatch: meta '${meta.strategyRevision}' vs summary '${summary.strategyRevision}'`,
    };
  }

  // 5. Interrupted Status & Completeness Coherence
  const metaInterrupted = Boolean(meta.isInterruptedSession);
  const summaryInterrupted = Boolean(summary.isInterruptedSession);

  if (metaInterrupted !== summaryInterrupted) {
    return {
      valid: false,
      reason: `Interrupted session flag mismatch: meta isInterrupted=${metaInterrupted} vs summary isInterrupted=${summaryInterrupted}`,
    };
  }

  if (metaInterrupted && summary.isCompleteSession === true) {
    return {
      valid: false,
      reason: "Invalid session state: interrupted session marked as complete in summary",
    };
  }

  // 6. Candidate Decisions Accounting Check
  const decisionsPath = path.join(sessionDir, "candidate-decisions.jsonl");
  if (existsSync(decisionsPath)) {
    try {
      const records = repairAndQuarantineDamagedTail<CandidateDecisionRecord>(decisionsPath);
      const expectedCount = summary.totalDecisionsRecorded;
      if (expectedCount !== undefined && records.length !== expectedCount) {
        return {
          valid: false,
          reason: `Decisions count mismatch: persisted records=${records.length} vs summary totalDecisionsRecorded=${expectedCount}`,
        };
      }
    } catch (err) {
      return {
        valid: false,
        reason: `Decisions file corrupted or unreadable: ${String(err)}`,
      };
    }
  }

  // 7. Market Observations Accounting Check
  const obsPath = path.join(sessionDir, "market-observations.jsonl");
  if (existsSync(obsPath)) {
    try {
      const records = repairAndQuarantineDamagedTail<MarketObservationRecord>(obsPath);
      const expectedCount = summary.totalMarketObservationsRecorded;
      if (expectedCount !== undefined && records.length !== expectedCount) {
        return {
          valid: false,
          reason: `Observations count mismatch: persisted records=${records.length} vs summary totalMarketObservationsRecorded=${expectedCount}`,
        };
      }
    } catch (err) {
      return {
        valid: false,
        reason: `Observations file corrupted or unreadable: ${String(err)}`,
      };
    }
  }

  // 8. Execution Quotes & Fills Integrity Check
  const quotesPath = path.join(sessionDir, "execution-quotes.jsonl");
  if (existsSync(quotesPath)) {
    try {
      repairAndQuarantineDamagedTail<ExecutableQuoteRecord>(quotesPath);
    } catch (err) {
      return {
        valid: false,
        reason: `Execution quotes file corrupted or unreadable: ${String(err)}`,
      };
    }
  }

  const fillsPath = path.join(sessionDir, "simulated-fills.jsonl");
  if (existsSync(fillsPath)) {
    try {
      repairAndQuarantineDamagedTail<SimulatedFillRecord>(fillsPath);
    } catch (err) {
      return {
        valid: false,
        reason: `Simulated fills file corrupted or unreadable: ${String(err)}`,
      };
    }
  }

  return { valid: true };
}
