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
  readonly sessions: readonly FedoraSessionRecord[];
  readonly operationalNotice: string;
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
      sessions: [],
      operationalNotice,
    };
  }

  const parsedSessions: FedoraSessionRecord[] = [];

  for (const fileName of files.sort()) {
    const fullPath = path.join(stagingDir, fileName);
    const content = fs.readFileSync(fullPath);
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content.toString("utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }

    const rawTrades = Array.isArray(parsed.trades)
      ? (parsed.trades as Record<string, unknown>[])
      : [];
    const trades: FedoraTradeRecord[] = rawTrades.map((t) => ({
      tradeId: String(t.tradeId || ""),
      mintAddress: String(t.mintAddress || ""),
      symbol: String(t.symbol || ""),
      entryPriceSol: Number(t.entryPriceSol || 0),
      exitPriceSol: Number(t.exitPriceSol || 0),
      sizeSol: Number(t.sizeSol || 0),
      enteredAtIso: String(t.enteredAt || ""),
      exitedAtIso: String(t.exitedAt || ""),
      netPnlSol: Number(t.finalPnlSol ?? t.netPnlSol ?? 0),
      exitReason: String(t.exitReason || "UNKNOWN"),
    }));

    parsedSessions.push({
      sessionId: String(parsed.sessionId || fileName.replace(/\.json$/, "")),
      archiveFileName: fileName,
      sha256,
      startedAtIso: String(parsed.startedAt || ""),
      endedAtIso: String(parsed.endedAt || ""),
      startingCapitalSol: Number(parsed.startingCapitalSol || 0),
      endingCapitalSol: Number(parsed.endingCapitalSol || 0),
      netPnlSol: Number(parsed.netPnlSol || 0),
      totalTrades: trades.length,
      trades,
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
    sessions: parsedSessions,
    operationalNotice,
  };
}
