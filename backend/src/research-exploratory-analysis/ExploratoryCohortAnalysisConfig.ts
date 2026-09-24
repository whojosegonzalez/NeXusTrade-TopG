import { existsSync, lstatSync } from "node:fs";
import path from "node:path";

import { ExploratoryCohortAnalysisError } from "./ExploratoryCohortAnalysisErrors.js";
import { getExploratoryCohortAnalysisRepoRoot } from "./ExploratoryCohortAnalysisPaths.js";
import {
  analysisFormatSchema,
  type ExploratoryCohortAnalysisFormat,
} from "./ExploratoryCohortAnalysisTypes.js";

export const EXPLORATORY_ANALYSIS_ARCHIVE_ROOT =
  "data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z" as const;

const forbiddenPrefixes = [
  "--output",
  "--output-dir",
  "--file",
  "--write",
  "--save",
  "--db",
  "--database",
  "--runtime",
  "--scanner",
  "--risk",
  "--strategy",
  "--provider",
  "--environment",
  "--env",
  "--session",
  "--score",
  "--threshold",
  "--target",
  "--stop",
  "--max-hold",
  "--observation",
  "--observe",
  "--monitor",
  "--wallet",
  "--sign",
  "--submit",
  "--paper",
  "--live",
  "--execution",
  "--order",
  "--fill",
  "--position",
  "--balance",
  "--url",
  "--http",
] as const;

export interface ExploratoryCohortAnalysisConfig {
  readonly archiveRoot: typeof EXPLORATORY_ANALYSIS_ARCHIVE_ROOT;
  readonly format: ExploratoryCohortAnalysisFormat;
  readonly once: boolean;
}

export function parseExploratoryCohortAnalysisArgs(
  argv: readonly string[],
): ExploratoryCohortAnalysisConfig {
  let archiveRoot: typeof EXPLORATORY_ANALYSIS_ARCHIVE_ROOT | undefined;
  let format: ExploratoryCohortAnalysisFormat = "markdown";
  let formatSeen = false;
  let once = false;

  for (const arg of argv) {
    if (arg === "--") continue;
    if (forbiddenPrefixes.some((prefix) => arg === prefix || arg.startsWith(`${prefix}=`))) {
      throw invalidScope(
        "Exploratory analysis rejects write, runtime, provider, database, and execution options.",
      );
    }
    if (arg === "--once") {
      if (once) throw invalidScope("Exploratory analysis accepts --once at most once.");
      once = true;
      continue;
    }
    if (arg.startsWith("--archive-root=")) {
      if (archiveRoot)
        throw invalidScope("Exploratory analysis accepts exactly one --archive-root.");
      archiveRoot = parseArchiveRoot(arg.slice("--archive-root=".length));
      continue;
    }
    if (arg === "--archive-root") {
      throw invalidScope("Exploratory analysis requires --archive-root=<relative-path>.");
    }
    if (arg.startsWith("--format=")) {
      if (formatSeen) throw invalidScope("Exploratory analysis accepts --format at most once.");
      const parsed = analysisFormatSchema.safeParse(arg.slice("--format=".length));
      if (!parsed.success)
        throw invalidScope("Exploratory analysis format must be markdown or json.");
      format = parsed.data;
      formatSeen = true;
      continue;
    }
    if (arg === "--format") {
      throw invalidScope("Exploratory analysis requires --format=markdown or --format=json.");
    }
    throw invalidScope("Exploratory analysis received an unsupported option.");
  }

  if (!archiveRoot) {
    throw invalidScope("Exploratory analysis requires the one approved archive root.");
  }
  return { archiveRoot, format, once };
}

export function resolveExploratoryCohortAnalysisArchive(
  config: ExploratoryCohortAnalysisConfig,
  repoRoot = getExploratoryCohortAnalysisRepoRoot(),
): string {
  const expected = path.join(repoRoot, ...EXPLORATORY_ANALYSIS_ARCHIVE_ROOT.split("/"));
  const resolved = path.resolve(repoRoot, config.archiveRoot);
  if (
    resolved !== expected ||
    !existsSync(resolved) ||
    !lstatSync(resolved).isDirectory() ||
    lstatSync(resolved).isSymbolicLink()
  ) {
    throw unsupportedArchive("The approved archive root is unavailable or unsafe.");
  }
  return resolved;
}

function parseArchiveRoot(value: string): typeof EXPLORATORY_ANALYSIS_ARCHIVE_ROOT {
  const normalized = value.trim().replace(/\\/g, "/");
  if (
    normalized !== EXPLORATORY_ANALYSIS_ARCHIVE_ROOT ||
    path.isAbsolute(value) ||
    normalized.split("/").includes("..") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(normalized)
  ) {
    throw invalidScope(
      "Exploratory analysis accepts only the approved repository-relative archive root.",
    );
  }
  return EXPLORATORY_ANALYSIS_ARCHIVE_ROOT;
}

function invalidScope(message: string): ExploratoryCohortAnalysisError {
  return new ExploratoryCohortAnalysisError("EXPLORATORY_ANALYSIS_INVALID_SCOPE", message);
}

function unsupportedArchive(message: string): ExploratoryCohortAnalysisError {
  return new ExploratoryCohortAnalysisError("EXPLORATORY_ANALYSIS_UNSUPPORTED_ARCHIVE", message);
}
