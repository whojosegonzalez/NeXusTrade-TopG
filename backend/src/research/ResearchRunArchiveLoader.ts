import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { getRepoRoot } from "../db/utils/paths.js";
import type { TerminalRunSummary } from "../terminal-runner/TerminalRunSummary.js";
import type { ResearchArchiveMetadata, ResearchRunSourceConfig } from "./ResearchAggregateTypes.js";

const archiveReportDirectoryNames = new Set(["threshold-validation"]);

export function loadResearchRunArchives(
  sources: readonly ResearchRunSourceConfig[],
): readonly ResearchArchiveMetadata[] {
  return sources.map((source) => loadResearchRunArchive(source));
}

function loadResearchRunArchive(source: ResearchRunSourceConfig): ResearchArchiveMetadata {
  const resolvedPath = path.isAbsolute(source.path)
    ? path.resolve(source.path)
    : path.resolve(getRepoRoot(), source.path);

  if (!existsSync(resolvedPath)) {
    throw new Error(`Research run archive not found for ${source.label}: ${resolvedPath}`);
  }

  const stats = statSync(resolvedPath);

  if (!stats.isDirectory()) {
    throw new Error(
      `Research run archive must be a directory for ${source.label}: ${resolvedPath}`,
    );
  }

  const databasePath = path.join(resolvedPath, "nexus_paper.db");

  if (!existsSync(databasePath)) {
    throw new Error(`Research run archive missing nexus_paper.db for ${source.label}.`);
  }

  const runnerJsonPath = findRunnerJson(resolvedPath, source.label);
  const terminalSummary = parseTerminalSummary(runnerJsonPath, source.label);
  const warnings: string[] = [];
  const runOutputPath = path.dirname(runnerJsonPath);
  const runnerTextPath = findOptionalFile(runOutputPath, (name) =>
    name.toLowerCase().endsWith(".txt"),
  );
  const analyticsReportPath = findOptionalFile(runOutputPath, (name) =>
    name.toLowerCase().includes("analytics"),
  );
  const calibrationReportPath = findOptionalFile(
    runOutputPath,
    (name) =>
      name.toLowerCase().includes("calibration") &&
      !name.toLowerCase().includes("shadow-calibrate"),
  );
  const shadowCalibrationReportPath = findOptionalFile(runOutputPath, (name) =>
    name.toLowerCase().includes("shadow-calibrate"),
  );

  if (!runnerTextPath) {
    warnings.push("Optional TerminalRunner text output was not found.");
  }

  if (!analyticsReportPath) {
    warnings.push("Optional analytics tail report was not found.");
  }

  if (!calibrationReportPath) {
    warnings.push("Optional calibration tail report was not found.");
  }

  if (!shadowCalibrationReportPath) {
    warnings.push("Optional shadow calibration tail report was not found.");
  }

  return {
    label: source.label,
    inputPath: source.path,
    resolvedPath,
    databasePath,
    runnerJsonPath,
    ...(runnerTextPath ? { runnerTextPath } : {}),
    ...(analyticsReportPath ? { analyticsReportPath } : {}),
    ...(calibrationReportPath ? { calibrationReportPath } : {}),
    ...(shadowCalibrationReportPath ? { shadowCalibrationReportPath } : {}),
    terminalSummary,
    warnings,
  };
}

function findRunnerJson(archivePath: string, label: string): string {
  const runnerOutputPath = findRunnerOutputPath(archivePath, label);

  const jsonFiles = listJsonFiles(runnerOutputPath);

  if (jsonFiles.length === 0) {
    throw new Error(`Research run archive missing TerminalRunner JSON for ${label}.`);
  }

  return jsonFiles[0] as string;
}

function findRunnerOutputPath(archivePath: string, label: string): string {
  const explicitRunnerOutputPath = path.join(archivePath, "runner-output");

  if (existsSync(explicitRunnerOutputPath) && statSync(explicitRunnerOutputPath).isDirectory()) {
    return explicitRunnerOutputPath;
  }

  if (listJsonFiles(archivePath).length > 0) {
    return archivePath;
  }

  const childOutputDirectories = readdirSync(archivePath)
    .map((name) => path.join(archivePath, name))
    .filter((childPath) => statSync(childPath).isDirectory())
    .filter((childPath) => !archiveReportDirectoryNames.has(path.basename(childPath).toLowerCase()))
    .filter((childPath) => listJsonFiles(childPath).length > 0);

  if (childOutputDirectories.length === 1) {
    return childOutputDirectories[0] as string;
  }

  if (childOutputDirectories.length > 1) {
    throw new Error(
      `Research run archive has multiple candidate TerminalRunner output directories for ${label}: ${childOutputDirectories
        .map((childPath) => path.basename(childPath))
        .join(", ")}.`,
    );
  }

  throw new Error(
    `Research run archive missing TerminalRunner JSON for ${label}. Expected runner-output/*.json, archive-root/*.json, or one child run folder with JSON.`,
  );
}

function listJsonFiles(directoryPath: string): string[] {
  if (!existsSync(directoryPath) || !statSync(directoryPath).isDirectory()) {
    return [];
  }

  return readdirSync(directoryPath)
    .filter((name) => name.toLowerCase().endsWith(".json"))
    .map((name) => path.join(directoryPath, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
}

function findOptionalFile(
  directoryPath: string,
  predicate: (name: string) => boolean,
): string | undefined {
  if (!existsSync(directoryPath) || !statSync(directoryPath).isDirectory()) {
    return undefined;
  }

  return readdirSync(directoryPath)
    .filter((name) => predicate(name))
    .map((name) => path.join(directoryPath, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
}

function parseTerminalSummary(runnerJsonPath: string, label: string): TerminalRunSummary {
  const parsed = JSON.parse(readFileSync(runnerJsonPath, "utf8")) as unknown;

  if (!isTerminalRunSummary(parsed)) {
    throw new Error(`TerminalRunner JSON for ${label} is not a supported run summary.`);
  }

  return parsed;
}

function isTerminalRunSummary(value: unknown): value is TerminalRunSummary {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.runId === "string" &&
    value.mode === "PAPER" &&
    value.shadowOnly === true &&
    typeof value.safetyStatus === "string" &&
    typeof value.startedAtMs === "number" &&
    typeof value.endedAtMs === "number" &&
    typeof value.durationMs === "number" &&
    typeof value.intervalMs === "number" &&
    typeof value.cycleCount === "number" &&
    Array.isArray(value.cycles) &&
    isRecord(value.providerPressure)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
