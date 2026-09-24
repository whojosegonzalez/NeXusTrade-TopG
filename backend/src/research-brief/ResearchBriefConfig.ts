import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { ResearchBriefError } from "./ResearchBriefErrors.js";
import { getResearchBriefRepoRoot } from "./ResearchBriefPaths.js";

const supportedPhases = ["phase9.28", "phase9.29"] as const;
const supportedFormats = ["markdown", "json"] as const;

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

export type ResearchBriefFormat = (typeof supportedFormats)[number];

export interface ResearchBriefConfig {
  readonly archiveRoot: "data/archive";
  readonly includePhases: readonly (typeof supportedPhases)[number][];
  readonly includeCohorts: readonly string[];
  readonly format: ResearchBriefFormat;
  readonly once: boolean;
}

export function parseResearchBriefArgs(argv: readonly string[]): ResearchBriefConfig {
  let archiveRoot: "data/archive" | undefined;
  let format: ResearchBriefFormat = "markdown";
  let once = false;
  const includePhases: (typeof supportedPhases)[number][] = [];
  const includeCohorts: string[] = [];

  for (const arg of argv) {
    if (arg === "--") continue;
    if (forbiddenPrefixes.some((prefix) => arg === prefix || arg.startsWith(`${prefix}=`))) {
      throw invalidScope(
        "Research brief rejects write, runtime, provider, database, or execution options.",
      );
    }
    if (arg === "--once") {
      if (once) throw invalidScope("Research brief accepts --once at most once.");
      once = true;
    } else if (arg.startsWith("--archive-root=")) {
      if (archiveRoot) throw invalidScope("Research brief accepts exactly one --archive-root.");
      archiveRoot = parseArchiveRoot(arg.slice("--archive-root=".length));
    } else if (arg.startsWith("--include-phase=")) {
      includePhases.push(parsePhase(arg.slice("--include-phase=".length)));
    } else if (arg.startsWith("--include-cohort=")) {
      includeCohorts.push(parseCohort(arg.slice("--include-cohort=".length)));
    } else if (arg.startsWith("--format=")) {
      format = parseFormat(arg.slice("--format=".length));
    } else {
      throw invalidScope("Research brief received an unsupported option.");
    }
  }

  if (!archiveRoot) throw invalidScope("Research brief requires --archive-root=data/archive.");
  if (includePhases.length === 0) {
    throw invalidScope("Research brief requires one or more --include-phase options.");
  }
  if (new Set(includePhases).size !== includePhases.length) {
    throw invalidScope("Research brief phase includes must be unique.");
  }
  if (new Set(includeCohorts).size !== includeCohorts.length) {
    throw invalidScope("Research brief cohort includes must be unique.");
  }
  if (includeCohorts.length > 1) {
    throw invalidScope("Research brief supports at most one explicit cohort in the first pass.");
  }
  if (includeCohorts.some((cohort) => !includePhases.includes(cohort.split("/")[0] as never))) {
    throw invalidScope("Each research brief cohort phase must be explicitly included.");
  }
  if (includePhases.includes("phase9.29") && includeCohorts.length !== 1) {
    throw new ResearchBriefError(
      "RESEARCH_BRIEF_AMBIGUOUS_REPORT",
      "Phase 9.29 requires one explicit canonical attribution cohort.",
    );
  }
  if (includeCohorts.some((cohort) => !cohort.startsWith("phase9.29/"))) {
    throw invalidScope("The first research brief supports an explicit cohort only for phase9.29.");
  }

  return {
    archiveRoot,
    includePhases: [...includePhases].sort(),
    includeCohorts: [...includeCohorts].sort(),
    format,
    once,
  };
}

export function resolveResearchBriefArchiveRoot(config: ResearchBriefConfig): string {
  const repoRoot = getResearchBriefRepoRoot();
  const expected = path.join(repoRoot, "data", "archive");
  const resolved = path.resolve(repoRoot, config.archiveRoot);
  if (resolved !== expected || !existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw invalidScope("Research brief accepts only the available canonical data/archive root.");
  }
  return resolved;
}

function parseArchiveRoot(value: string): "data/archive" {
  const normalized = value.trim().replace(/\\/g, "/");
  if (
    normalized !== "data/archive" ||
    path.isAbsolute(value) ||
    isUrlShaped(value) ||
    hasTraversal(value)
  ) {
    throw invalidScope("Research brief accepts only the relative canonical data/archive root.");
  }
  return "data/archive";
}

function parsePhase(value: string): (typeof supportedPhases)[number] {
  const phase = value.trim();
  if (!supportedPhases.includes(phase as (typeof supportedPhases)[number])) {
    throw invalidScope("Research brief supports only the known phase9.28 and phase9.29 archives.");
  }
  return phase as (typeof supportedPhases)[number];
}

function parseCohort(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  const [phase, directory, ...remaining] = normalized.split("/");
  if (
    !phase ||
    !directory ||
    remaining.length > 0 ||
    phase !== "phase9.29" ||
    directory === "." ||
    directory === ".." ||
    directory.includes("..") ||
    hasTraversal(normalized) ||
    isUrlShaped(normalized)
  ) {
    throw invalidScope("Research brief cohorts must use phase9.29/<direct-archive-directory>.");
  }
  return `${phase}/${directory}`;
}

function parseFormat(value: string): ResearchBriefFormat {
  if (!supportedFormats.includes(value as ResearchBriefFormat)) {
    throw invalidScope("Research brief format must be markdown or json.");
  }
  return value as ResearchBriefFormat;
}

function hasTraversal(value: string): boolean {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .some((segment) => segment === "..");
}

function isUrlShaped(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value.trim());
}

function invalidScope(message: string): ResearchBriefError {
  return new ResearchBriefError("RESEARCH_BRIEF_INVALID_SCOPE", message);
}
