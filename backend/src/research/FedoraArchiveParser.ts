/**
 * Phase 12.94-D Milestone D.2.1: Read-Only Fedora Archive Parser
 *
 * Isolated offline parser for post-run Fedora endurance archives.
 * Strictly operates on locally staged, read-only files in `.tmp/fedora_recovery/raw/`.
 * ZERO network connectivity, ZERO SSH execution, ZERO process signaling to remote hosts.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ProvenanceClass, UnavailabilityReason } from "./ResearchTypes.js";

export interface FedoraTradeRecord {
  readonly tradeId: string;
  readonly mintAddress: string;
  readonly symbol: string;
  readonly entryPriceSol: number;
  readonly exitPriceSol: number;
  readonly sizeSol: number;
  readonly enteredAtIso: string;
  readonly exitedAtIso: string;
  readonly netPnlSol: number;
  readonly exitReason: string;
}

export interface FedoraQuarantinedFile {
  readonly fileName: string;
  readonly sha256: string;
  readonly rejectionReason: string;
}

export interface FedoraSessionRecord {
  readonly sessionId: string;
  readonly archiveFileName: string;
  readonly sha256: string;
  readonly startedAtIso: string;
  readonly endedAtIso: string;
  readonly startingCapitalSol: number;
  readonly endingCapitalSol: number;
  readonly netPnlSol: number;
  readonly totalTrades: number;
  readonly trades: readonly FedoraTradeRecord[];
  readonly fieldProvenance: Record<string, ProvenanceClass>;
  readonly unavailabilityReasons: Record<string, UnavailabilityReason>;
}

export interface FedoraArchiveAuditResult {
  readonly status: "REPORTED_NOT_INSPECTED" | "ARCHIVE_CONFIRMED_PARSED";
  readonly stagingDir: string;
  readonly filesAuditedCount: number;
  readonly sessionsAuditedCount: number;
  readonly malformedOrUnrelatedFilesCount: number;
  readonly quarantinedFiles: readonly FedoraQuarantinedFile[];
  readonly sessions: readonly FedoraSessionRecord[];
  readonly operationalNotice: string;
}

interface ValidatedFedoraData {
  sessionId: string;
  startedAtIso: string;
  endedAtIso: string;
  startingCapitalSol: number;
  endingCapitalSol: number;
  netPnlSol: number;
  trades: FedoraTradeRecord[];
}

function validateFedoraSessionPayload(
  parsed: unknown,
): { isValid: true; data: ValidatedFedoraData } | { isValid: false; reason: string } {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { isValid: false, reason: "Payload must be a non-null JSON object" };
  }

  const p = parsed as Record<string, unknown>;

  // 1. Session ID validation
  if (typeof p.sessionId !== "string" || p.sessionId.trim().length === 0) {
    return { isValid: false, reason: "Missing or invalid sessionId string" };
  }
  const sessionId = p.sessionId.trim();
  if (!sessionId.startsWith("session-fedora-") && !sessionId.startsWith("session-paper-")) {
    return {
      isValid: false,
      reason: `sessionId '${sessionId}' does not follow canonical endurance session prefix ('session-fedora-' or 'session-paper-')`,
    };
  }

  // 2. Timestamps validation
  const rawStartedAt = p.startedAt ?? p.startedAtIso;
  const rawEndedAt = p.endedAt ?? p.endedAtIso;

  if (typeof rawStartedAt !== "string" || typeof rawEndedAt !== "string") {
    return { isValid: false, reason: "Missing mandatory startedAt or endedAt timestamp string" };
  }

  const startMs = Date.parse(rawStartedAt);
  const endMs = Date.parse(rawEndedAt);

  if (!Number.isFinite(startMs) || startMs <= 0) {
    return { isValid: false, reason: `Invalid non-ISO startedAt timestamp: ${rawStartedAt}` };
  }
  if (!Number.isFinite(endMs) || endMs <= 0) {
    return { isValid: false, reason: `Invalid non-ISO endedAt timestamp: ${rawEndedAt}` };
  }
  if (endMs < startMs) {
    return {
      isValid: false,
      reason: `Incoherent session timeline: endedAt (${rawEndedAt}) precedes startedAt (${rawStartedAt})`,
    };
  }

  // 3. Financial capital amounts validation (strictly finite numbers)
  if (
    typeof p.startingCapitalSol !== "number" ||
    !Number.isFinite(p.startingCapitalSol) ||
    p.startingCapitalSol <= 0
  ) {
    return {
      isValid: false,
      reason: `startingCapitalSol must be a positive finite number, got: ${String(p.startingCapitalSol)}`,
    };
  }

  if (
    typeof p.endingCapitalSol !== "number" ||
    !Number.isFinite(p.endingCapitalSol) ||
    p.endingCapitalSol < 0
  ) {
    return {
      isValid: false,
      reason: `endingCapitalSol must be a non-negative finite number, got: ${String(p.endingCapitalSol)}`,
    };
  }

  if (typeof p.netPnlSol !== "number" || !Number.isFinite(p.netPnlSol)) {
    return {
      isValid: false,
      reason: `netPnlSol must be a finite number, got: ${String(p.netPnlSol)}`,
    };
  }

  // 4. Trades validation
  if (!Array.isArray(p.trades)) {
    return { isValid: false, reason: "trades must be an array" };
  }

  const validatedTrades: FedoraTradeRecord[] = [];
  for (let idx = 0; idx < p.trades.length; idx++) {
    const rawTrade = p.trades[idx];
    if (typeof rawTrade !== "object" || rawTrade === null || Array.isArray(rawTrade)) {
      return { isValid: false, reason: `trades[${idx}] must be a non-null object` };
    }
    const t = rawTrade as Record<string, unknown>;

    if (typeof t.tradeId !== "string" || t.tradeId.trim().length === 0) {
      return { isValid: false, reason: `trades[${idx}].tradeId must be a non-empty string` };
    }
    if (typeof t.mintAddress !== "string" || t.mintAddress.trim().length === 0) {
      return { isValid: false, reason: `trades[${idx}].mintAddress must be a non-empty string` };
    }
    const symbol = typeof t.symbol === "string" ? t.symbol.trim() : "UNKNOWN";

    if (
      typeof t.entryPriceSol !== "number" ||
      !Number.isFinite(t.entryPriceSol) ||
      t.entryPriceSol <= 0
    ) {
      return {
        isValid: false,
        reason: `trades[${idx}].entryPriceSol must be a positive finite number, got: ${String(t.entryPriceSol)}`,
      };
    }
    if (
      typeof t.exitPriceSol !== "number" ||
      !Number.isFinite(t.exitPriceSol) ||
      t.exitPriceSol <= 0
    ) {
      return {
        isValid: false,
        reason: `trades[${idx}].exitPriceSol must be a positive finite number, got: ${String(t.exitPriceSol)}`,
      };
    }
    if (typeof t.sizeSol !== "number" || !Number.isFinite(t.sizeSol) || t.sizeSol <= 0) {
      return {
        isValid: false,
        reason: `trades[${idx}].sizeSol must be a positive finite number, got: ${String(t.sizeSol)}`,
      };
    }

    const tradeEnteredAt = t.enteredAt ?? t.enteredAtIso;
    const tradeExitedAt = t.exitedAt ?? t.exitedAtIso;
    if (typeof tradeEnteredAt !== "string" || typeof tradeExitedAt !== "string") {
      return {
        isValid: false,
        reason: `trades[${idx}] missing enteredAt or exitedAt timestamp string`,
      };
    }
    const tradeEnteredMs = Date.parse(tradeEnteredAt);
    const tradeExitedMs = Date.parse(tradeExitedAt);
    if (!Number.isFinite(tradeEnteredMs) || !Number.isFinite(tradeExitedMs)) {
      return { isValid: false, reason: `trades[${idx}] contains invalid timestamp strings` };
    }
    if (tradeExitedMs < tradeEnteredMs) {
      return { isValid: false, reason: `trades[${idx}].exitedAt precedes enteredAt` };
    }

    const tradePnl = t.finalPnlSol ?? t.netPnlSol;
    if (typeof tradePnl !== "number" || !Number.isFinite(tradePnl)) {
      return {
        isValid: false,
        reason: `trades[${idx}] finalPnlSol/netPnlSol must be a finite number, got: ${String(tradePnl)}`,
      };
    }

    const exitReason = typeof t.exitReason === "string" ? t.exitReason.trim() : "UNKNOWN";

    validatedTrades.push({
      tradeId: t.tradeId.trim(),
      mintAddress: t.mintAddress.trim(),
      symbol,
      entryPriceSol: t.entryPriceSol,
      exitPriceSol: t.exitPriceSol,
      sizeSol: t.sizeSol,
      enteredAtIso: tradeEnteredAt,
      exitedAtIso: tradeExitedAt,
      netPnlSol: tradePnl,
      exitReason,
    });
  }

  return {
    isValid: true,
    data: {
      sessionId,
      startedAtIso: rawStartedAt,
      endedAtIso: rawEndedAt,
      startingCapitalSol: p.startingCapitalSol,
      endingCapitalSol: p.endingCapitalSol,
      netPnlSol: p.netPnlSol,
      trades: validatedTrades,
    },
  };
}

export function parseFedoraArchiveDirectory(stagingDir: string): FedoraArchiveAuditResult {
  const operationalNotice =
    "STRICTLY OFFLINE: No network connections or SSH commands were made to remote Fedora host.";

  if (!fs.existsSync(stagingDir)) {
    return {
      status: "REPORTED_NOT_INSPECTED",
      stagingDir,
      filesAuditedCount: 0,
      sessionsAuditedCount: 0,
      malformedOrUnrelatedFilesCount: 0,
      quarantinedFiles: [],
      sessions: [],
      operationalNotice,
    };
  }

  const files = fs.readdirSync(stagingDir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    return {
      status: "REPORTED_NOT_INSPECTED",
      stagingDir,
      filesAuditedCount: 0,
      sessionsAuditedCount: 0,
      malformedOrUnrelatedFilesCount: 0,
      quarantinedFiles: [],
      sessions: [],
      operationalNotice,
    };
  }

  const quarantinedFiles: FedoraQuarantinedFile[] = [];
  const parsedSessions: FedoraSessionRecord[] = [];

  for (const fileName of files.sort()) {
    const fullPath = path.join(stagingDir, fileName);
    const content = fs.readFileSync(fullPath);
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content.toString("utf8"));
    } catch (err) {
      quarantinedFiles.push({
        fileName,
        sha256,
        rejectionReason: `CORRUPT_JSON_PARSE_ERROR: ${(err as Error).message}`,
      });
      continue;
    }

    const validation = validateFedoraSessionPayload(parsedJson);
    if (!validation.isValid) {
      quarantinedFiles.push({
        fileName,
        sha256,
        rejectionReason: validation.reason,
      });
      continue;
    }

    const data = validation.data;
    parsedSessions.push({
      sessionId: data.sessionId,
      archiveFileName: fileName,
      sha256,
      startedAtIso: data.startedAtIso,
      endedAtIso: data.endedAtIso,
      startingCapitalSol: data.startingCapitalSol,
      endingCapitalSol: data.endingCapitalSol,
      netPnlSol: data.netPnlSol,
      totalTrades: data.trades.length,
      trades: data.trades,
      fieldProvenance: {
        netPnlSol: "OBSERVED",
        tradeTimestamps: "OBSERVED",
        solSize: "OBSERVED",
        baseReserve: "UNAVAILABLE",
        quoteReserve: "UNAVAILABLE",
        volume5mUsd: "UNAVAILABLE",
        buys5m: "UNAVAILABLE",
        sells5m: "UNAVAILABLE",
        devHoldingPct: "UNAVAILABLE",
        lpBurnPct: "UNAVAILABLE",
      },
      unavailabilityReasons: {
        baseReserve: "FIELD_NOT_COLLECTED_IN_GENERATION",
        quoteReserve: "FIELD_NOT_COLLECTED_IN_GENERATION",
        volume5mUsd: "FIELD_NOT_COLLECTED_IN_GENERATION",
        buys5m: "FIELD_NOT_COLLECTED_IN_GENERATION",
        sells5m: "FIELD_NOT_COLLECTED_IN_GENERATION",
        devHoldingPct: "FIELD_NOT_COLLECTED_IN_GENERATION",
        lpBurnPct: "FIELD_NOT_COLLECTED_IN_GENERATION",
      },
    });
  }

  return {
    status: parsedSessions.length > 0 ? "ARCHIVE_CONFIRMED_PARSED" : "REPORTED_NOT_INSPECTED",
    stagingDir,
    filesAuditedCount: files.length,
    sessionsAuditedCount: parsedSessions.length,
    malformedOrUnrelatedFilesCount: quarantinedFiles.length,
    quarantinedFiles,
    sessions: parsedSessions,
    operationalNotice,
  };
}
