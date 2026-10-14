import {
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

function getStrategyRevision(): string {
  return process.env.GIT_COMMIT || "7e58ea5";
}

function appendJsonLine(filePath: string, obj: unknown): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const line = JSON.stringify(obj) + "\n";
  const fd = openSync(filePath, "a");
  try {
    writeFileSync(fd, line, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readJsonLines<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const records: T[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (raw.length === 0) continue;
    try {
      records.push(JSON.parse(raw) as T);
    } catch (err) {
      // If trailing partial line from crash, warn and skip
      if (i === lines.length - 1 || i === lines.length - 2) {
        console.warn(
          `[TelemetryStorageManager] Skipping partial trailing line at ${filePath}:${i + 1}: ${String(err)}`,
        );
      } else {
        throw new Error(
          `[TelemetryStorageManager] [FATAL_CORRUPT_LINE] Malformed line in ${filePath}:${i + 1}: ${String(err)}`,
        );
      }
    }
  }

  return records;
}

export class TelemetryStorageManager {
  private readonly workspaceRoot?: string | undefined;

  constructor(workspaceRoot?: string | undefined) {
    this.workspaceRoot = workspaceRoot;
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

    const metaPath = getCanonicalSessionMetaPath(sessionId, this.workspaceRoot);
    if (existsSync(metaPath)) {
      try {
        return JSON.parse(readFileSync(metaPath, "utf8")) as SessionTelemetryMeta;
      } catch {
        // Fall through to rewrite if corrupt
      }
    }

    const meta: SessionTelemetryMeta = {
      sessionId,
      generationId,
      strategyRevision: getStrategyRevision(),
      startedAtIso: new Date().toISOString(),
      initialWalletBalanceSol: initialBalanceSol,
      environment: {
        platform: os.platform(),
        nodeVersion: process.version,
      },
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
    appendJsonLine(filePath, record);
  }

  public appendMarketObservation(record: MarketObservationRecord): void {
    validateSessionId(record.sessionId);
    const filePath = getCanonicalMarketObservationsPath(record.sessionId, this.workspaceRoot);
    appendJsonLine(filePath, record);
  }

  public appendStratifiedSample(record: StratifiedSamplingRecord): void {
    validateSessionId(record.sessionId);
    const filePath = getCanonicalStratifiedSamplesPath(record.sessionId, this.workspaceRoot);
    appendJsonLine(filePath, record);
  }

  public readCandidateDecisions(sessionId: string): CandidateDecisionRecord[] {
    validateSessionId(sessionId);
    const filePath = getCanonicalCandidateDecisionsPath(sessionId, this.workspaceRoot);
    return readJsonLines<CandidateDecisionRecord>(filePath);
  }

  public readMarketObservations(sessionId: string): MarketObservationRecord[] {
    validateSessionId(sessionId);
    const filePath = getCanonicalMarketObservationsPath(sessionId, this.workspaceRoot);
    return readJsonLines<MarketObservationRecord>(filePath);
  }

  public readStratifiedSamples(sessionId: string): StratifiedSamplingRecord[] {
    validateSessionId(sessionId);
    const filePath = getCanonicalStratifiedSamplesPath(sessionId, this.workspaceRoot);
    return readJsonLines<StratifiedSamplingRecord>(filePath);
  }

  public finalizeSessionTelemetry(
    sessionId: string,
    summaryData: Omit<SessionTelemetrySummary, "sessionId" | "closedAtIso">,
  ): SessionTelemetrySummary {
    validateSessionId(sessionId);
    const summaryPath = getCanonicalSessionTelemetrySummaryPath(sessionId, this.workspaceRoot);
    const closedAtIso = new Date().toISOString();

    const summary: SessionTelemetrySummary = {
      ...summaryData,
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

    // Update meta.json with closedAtIso
    const metaPath = getCanonicalSessionMetaPath(sessionId, this.workspaceRoot);
    if (existsSync(metaPath)) {
      try {
        const currentMeta = JSON.parse(readFileSync(metaPath, "utf8")) as SessionTelemetryMeta;
        const updatedMeta: SessionTelemetryMeta = {
          ...currentMeta,
          closedAtIso,
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
      } catch {
        // ignore meta update error
      }
    }

    return summary;
  }
}
