/**
 * Phase 12.94-C: Execution Storage Manager & Cross-File Consistency Validator
 *
 * Implements crash-safe, append-only JSONL persistence for:
 * - execution-quotes.jsonl
 * - simulated-fills.jsonl
 *
 * Guarantees:
 * 1. Startup / Pre-Append Crash Recovery: executes repairAndQuarantineDamagedTail()
 *    before appending, preventing damaged tails from becoming corrupt interior lines.
 * 2. Fail-Closed Cross-File Reconciliation: enforces that missing JSONL files with
 *    positive summary counts, mismatched session/generation IDs, or orphaned fill references
 *    strictly fail verification.
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
  private readonly repairedFiles = new Set<string>();

  constructor(workspaceRoot?: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Appends an executable quote record to canonical execution-quotes.jsonl.
   * Performs crash-tail quarantine repair before appending on first access.
   */
  public recordQuote(quote: ExecutableQuoteRecord): void {
    const validSessionId = validateSessionId(quote.sessionId);
    const sessionDir = getCanonicalTelemetrySessionDir(validSessionId, this.workspaceRoot);
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }

    const quotesPath = getCanonicalExecutionQuotesPath(validSessionId, this.workspaceRoot);
    // 1. Crash recovery repair on initial access before append
    if (!this.repairedFiles.has(quotesPath)) {
      repairAndQuarantineDamagedTail<ExecutableQuoteRecord>(quotesPath);
      this.repairedFiles.add(quotesPath);
    }

    // 2. Durable append with fsync
    this.appendSyncWithFsync(quotesPath, JSON.stringify(quote));
  }

  /**
   * Appends a simulated fill record to canonical simulated-fills.jsonl for a given session.
   * Performs crash-tail quarantine repair before appending on first access.
   */
  public recordFill(sessionId: string, fill: SimulatedFillRecord): void {
    const validSessionId = validateSessionId(sessionId);
    const sessionDir = getCanonicalTelemetrySessionDir(validSessionId, this.workspaceRoot);
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }

    const fillsPath = getCanonicalSimulatedFillsPath(validSessionId, this.workspaceRoot);
    // 1. Crash recovery repair on initial access before append
    if (!this.repairedFiles.has(fillsPath)) {
      repairAndQuarantineDamagedTail<SimulatedFillRecord>(fillsPath);
      this.repairedFiles.add(fillsPath);
    }

    // 2. Durable append with fsync
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

  // 6. Candidate Decisions Accounting Check (Fail Closed on Missing File with Positive Summary)
  const decisionsPath = path.join(sessionDir, "candidate-decisions.jsonl");
  const expectedDecisionsCount = summary.totalDecisionsRecorded ?? 0;

  if (expectedDecisionsCount > 0 && !existsSync(decisionsPath)) {
    return {
      valid: false,
      reason: `Missing candidate-decisions.jsonl when summary reports ${expectedDecisionsCount} total decisions`,
    };
  }

  if (existsSync(decisionsPath)) {
    try {
      const records = repairAndQuarantineDamagedTail<CandidateDecisionRecord>(decisionsPath);
      if (
        summary.totalDecisionsRecorded !== undefined &&
        records.length !== summary.totalDecisionsRecorded
      ) {
        return {
          valid: false,
          reason: `Decisions count mismatch: persisted records=${records.length} vs summary totalDecisionsRecorded=${summary.totalDecisionsRecorded}`,
        };
      }
    } catch (err) {
      return {
        valid: false,
        reason: `Decisions file corrupted or unreadable: ${String(err)}`,
      };
    }
  }

  // 7. Market Observations Accounting Check (Fail Closed on Missing File with Positive Summary)
  const obsPath = path.join(sessionDir, "market-observations.jsonl");
  const expectedObsCount = summary.totalMarketObservationsRecorded ?? 0;

  if (expectedObsCount > 0 && !existsSync(obsPath)) {
    return {
      valid: false,
      reason: `Missing market-observations.jsonl when summary reports ${expectedObsCount} total observations`,
    };
  }

  if (existsSync(obsPath)) {
    try {
      const records = repairAndQuarantineDamagedTail<MarketObservationRecord>(obsPath);
      if (records.length !== expectedObsCount) {
        return {
          valid: false,
          reason: `Observations count mismatch: persisted records=${records.length} vs summary totalMarketObservationsRecorded=${expectedObsCount}`,
        };
      }
    } catch (err) {
      return {
        valid: false,
        reason: `Observations file corrupted or unreadable: ${String(err)}`,
      };
    }
  }

  // 8. Execution Quotes & Fills Integrity and Referential Check
  const quotesPath = path.join(sessionDir, "execution-quotes.jsonl");
  const fillsPath = path.join(sessionDir, "simulated-fills.jsonl");
  const quotesById = new Map<string, ExecutableQuoteRecord>();

  if (existsSync(quotesPath)) {
    try {
      const quoteRecords = repairAndQuarantineDamagedTail<ExecutableQuoteRecord>(quotesPath);
      for (const q of quoteRecords) {
        if (!q.quoteId || typeof q.quoteId !== "string") {
          return {
            valid: false,
            reason: `Execution quote record missing required quoteId`,
          };
        }
        if (quotesById.has(q.quoteId)) {
          return {
            valid: false,
            reason: `Duplicate quote ID '${q.quoteId}' found in execution-quotes.jsonl`,
          };
        }
        if (q.sessionId !== summary.sessionId) {
          return {
            valid: false,
            reason: `Quote record '${q.quoteId}' has mismatched session ID '${q.sessionId}' (expected '${summary.sessionId}')`,
          };
        }
        if (q.generationId !== summary.generationId) {
          return {
            valid: false,
            reason: `Quote record '${q.quoteId}' has mismatched generation ID '${q.generationId}' (expected '${summary.generationId}')`,
          };
        }
        quotesById.set(q.quoteId, q);
      }
    } catch (err) {
      return {
        valid: false,
        reason: `Execution quotes file corrupted or unreadable: ${String(err)}`,
      };
    }
  }

  if (existsSync(fillsPath)) {
    try {
      const fillRecords = repairAndQuarantineDamagedTail<SimulatedFillRecord>(fillsPath);
      if (fillRecords.length > 0 && !existsSync(quotesPath)) {
        return {
          valid: false,
          reason: `Missing execution-quotes.jsonl when simulated-fills.jsonl contains ${fillRecords.length} fills`,
        };
      }

      const fillIdSet = new Set<string>();

      for (const f of fillRecords) {
        if (!f.fillId || typeof f.fillId !== "string") {
          return {
            valid: false,
            reason: `Simulated fill record missing required fillId`,
          };
        }
        if (fillIdSet.has(f.fillId)) {
          return {
            valid: false,
            reason: `Duplicate fill ID '${f.fillId}' found in simulated-fills.jsonl`,
          };
        }
        fillIdSet.add(f.fillId);

        const referencedQuote = quotesById.get(f.quoteId);
        if (!referencedQuote) {
          return {
            valid: false,
            reason: `Simulated fill '${f.fillId}' references non-existent quote ID '${f.quoteId}'`,
          };
        }

        // Shared identity referential checks (mint, pool, side, decisionEventId)
        if (f.mintAddress !== referencedQuote.mintAddress) {
          return {
            valid: false,
            reason: `Simulated fill '${f.fillId}' mint '${f.mintAddress}' does not match quote mint '${referencedQuote.mintAddress}'`,
          };
        }
        if (f.poolId !== referencedQuote.poolId) {
          return {
            valid: false,
            reason: `Simulated fill '${f.fillId}' pool ID '${f.poolId}' does not match quote pool ID '${referencedQuote.poolId}'`,
          };
        }
        if (f.side !== referencedQuote.side) {
          return {
            valid: false,
            reason: `Simulated fill '${f.fillId}' side '${f.side}' does not match quote side '${referencedQuote.side}'`,
          };
        }
        if (f.decisionEventId !== referencedQuote.decisionEventId) {
          return {
            valid: false,
            reason: `Simulated fill '${f.fillId}' decisionEventId '${f.decisionEventId}' does not match quote decisionEventId '${referencedQuote.decisionEventId}'`,
          };
        }
      }
    } catch (err) {
      return {
        valid: false,
        reason: `Simulated fills file corrupted or unreadable: ${String(err)}`,
      };
    }
  }

  return { valid: true };
}
