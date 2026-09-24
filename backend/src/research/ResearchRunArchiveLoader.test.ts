import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { formatTerminalRunJson } from "../terminal-runner/TerminalRunSummary.js";
import { loadResearchRunArchives } from "./ResearchRunArchiveLoader.js";

describe("ResearchRunArchiveLoader", () => {
  it("loads TerminalRunner JSON from a nested single child run folder", () => {
    const archivePath = makeArchive("nested");
    const runOutputPath = path.join(archivePath, "phase9-test");

    mkdirSync(runOutputPath, { recursive: true });
    writeFileSync(
      path.join(runOutputPath, "terminal.json"),
      formatTerminalRunJson(summary()),
      "utf8",
    );
    writeFileSync(path.join(runOutputPath, "analytics-tail60.txt"), "analytics", "utf8");
    writeFileSync(path.join(runOutputPath, "calibration-tail60.txt"), "calibration", "utf8");
    writeFileSync(
      path.join(runOutputPath, "shadow-calibrate-tail60.txt"),
      "shadow calibration",
      "utf8",
    );

    const [archive] = loadResearchRunArchives([{ label: "Nested", path: archivePath }]);

    expect(archive?.runnerJsonPath).toBe(path.join(runOutputPath, "terminal.json"));
    expect(archive?.terminalSummary.runId).toBe("terminal_test");
    expect(archive?.analyticsReportPath).toBe(path.join(runOutputPath, "analytics-tail60.txt"));
    expect(archive?.calibrationReportPath).toBe(path.join(runOutputPath, "calibration-tail60.txt"));
    expect(archive?.shadowCalibrationReportPath).toBe(
      path.join(runOutputPath, "shadow-calibrate-tail60.txt"),
    );
    expect(archive?.warnings).toEqual([]);
  });

  it("fails clearly when multiple child folders contain runner JSON", () => {
    const archivePath = makeArchive("ambiguous");

    for (const child of ["run-a", "run-b"]) {
      const runOutputPath = path.join(archivePath, child);
      mkdirSync(runOutputPath, { recursive: true });
      writeFileSync(
        path.join(runOutputPath, "terminal.json"),
        formatTerminalRunJson(summary()),
        "utf8",
      );
    }

    expect(() => loadResearchRunArchives([{ label: "Ambiguous", path: archivePath }])).toThrow(
      /multiple candidate TerminalRunner output directories/i,
    );
  });

  it("does not mistake a Phase 9.27 threshold report folder for TerminalRunner output", () => {
    const archivePath = makeArchive("threshold-report");
    const runOutputPath = path.join(archivePath, "phase9-test");
    const thresholdOutputPath = path.join(archivePath, "threshold-validation");

    mkdirSync(runOutputPath, { recursive: true });
    mkdirSync(thresholdOutputPath, { recursive: true });
    writeFileSync(
      path.join(runOutputPath, "terminal.json"),
      formatTerminalRunJson(summary()),
      "utf8",
    );
    writeFileSync(path.join(thresholdOutputPath, "shadow-threshold.json"), "{}", "utf8");

    const [archive] = loadResearchRunArchives([{ label: "ThresholdReport", path: archivePath }]);

    expect(archive?.runnerJsonPath).toBe(path.join(runOutputPath, "terminal.json"));
  });
});

function makeArchive(label: string): string {
  const archivePath = mkdtempSync(path.join(os.tmpdir(), `nexustrade-${label}-`));

  writeFileSync(path.join(archivePath, "nexus_paper.db"), "", "utf8");

  return archivePath;
}

function summary() {
  return {
    runId: "terminal_test",
    sessionId: "session_test",
    mode: "PAPER" as const,
    shadowOnly: true as const,
    safetyStatus: "PASS" as const,
    startedAtMs: 1_800_000_000_000,
    endedAtMs: 1_800_000_001_000,
    durationMs: 1_000,
    intervalMs: 60_000,
    cycleCount: 0,
    cycles: [],
    providerPressure: {
      total: 0,
      statusCounts: {
        OK: 0,
        DEGRADED: 0,
        RATE_LIMITED: 0,
        ERROR: 0,
        DISABLED: 0,
      },
      liveRows: 0,
      routerRows: 0,
      liveRateLimitedCount: 0,
      liveErrorCount: 0,
      liveRateLimitedPercent: 0,
      routerCacheHits: 0,
      routerCooldownSkips: 0,
      routerUnavailable: 0,
      routerCooldownSkipPercent: 0,
      combinedRateLimitedPercent: 0,
      quoteSourceTypeCounts: {},
      quoteFallbackReasonCounts: {},
      authorityEvidenceSourceCounts: {},
      mintAuthorityStateCounts: {},
      freezeAuthorityStateCounts: {},
      rpcCacheStatusCounts: {},
      rpcFailureCategoryCounts: {},
      dasProviderCounts: {},
      dasFailureCategoryCounts: {},
      raydiumFailureCategoryCounts: {},
      raydiumPreflightStatusCounts: {},
      heliusEvidenceSourceCounts: {},
      heliusCacheStatusCounts: {},
      birdeyeEndpointCounts: {},
      birdeyeCacheStatusCounts: {},
      birdeyeFailureCategoryCounts: {},
      birdeyeSelectionReasonCounts: {},
      birdeyeBudgetReasonCounts: {},
      providers: [],
    },
    stopped: false,
  };
}
