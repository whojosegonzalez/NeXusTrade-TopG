import path from "node:path";

import { getRepoRoot } from "../db/utils/paths.js";

const forbiddenPrefixes = [
  "--db",
  "--database",
  "--session",
  "--provider",
  "--strategy",
  "--threshold",
  "--score",
  "--target",
  "--stop",
  "--max-hold",
  "--observe",
  "--paper",
  "--live",
  "--wallet",
  "--sign",
  "--submit",
  "--url",
  "--http",
] as const;

export interface DashboardExportConfig {
  readonly archiveRoot: string;
  readonly includePhases: readonly string[];
  readonly includeCohorts: readonly string[];
  readonly outputDir: string;
}

export function parseDashboardExportArgs(argv: readonly string[]): DashboardExportConfig {
  let archiveRoot: string | undefined;
  let outputDir: string | undefined;
  const includePhases: string[] = [];
  const includeCohorts: string[] = [];

  for (const arg of argv) {
    if (arg === "--") continue;
    if (forbiddenPrefixes.some((prefix) => arg === prefix || arg.startsWith(prefix))) {
      throw new Error(`Dashboard export rejects active-runtime or network option: ${arg}.`);
    }
    if (arg.startsWith("--archive-root=")) {
      if (archiveRoot) throw new Error("Dashboard export accepts exactly one --archive-root.");
      archiveRoot = nonEmpty(arg.slice("--archive-root=".length), "--archive-root");
    } else if (arg.startsWith("--include-phase=")) {
      includePhases.push(parsePhase(arg.slice("--include-phase=".length)));
    } else if (arg.startsWith("--include-cohort=")) {
      includeCohorts.push(parseCohort(arg.slice("--include-cohort=".length)));
    } else if (arg.startsWith("--output-dir=")) {
      if (outputDir) throw new Error("Dashboard export accepts exactly one --output-dir.");
      outputDir = nonEmpty(arg.slice("--output-dir=".length), "--output-dir");
    } else {
      throw new Error(`Unknown dashboard export option: ${arg}`);
    }
  }

  if (!archiveRoot)
    throw new Error("Dashboard export requires --archive-root=<data/archive path>.");
  if (!outputDir) throw new Error("Dashboard export requires --output-dir=<generated data path>.");
  if (includePhases.length === 0) {
    throw new Error("Dashboard export requires one or more --include-phase=<phase> options.");
  }
  if (new Set(includePhases).size !== includePhases.length) {
    throw new Error("Dashboard export phase includes must be unique.");
  }
  if (new Set(includeCohorts).size !== includeCohorts.length) {
    throw new Error("Dashboard export cohort includes must be unique.");
  }
  if (includeCohorts.some((cohort) => !includePhases.includes(cohort.split("/")[0] as string))) {
    throw new Error("Each --include-cohort phase must also appear in --include-phase.");
  }

  return { archiveRoot, includePhases, includeCohorts, outputDir };
}

export function resolveDashboardArchiveRoot(archiveRoot: string): string {
  const repoRoot = getRepoRoot();
  const resolved = resolveFromRepo(archiveRoot);
  const expected = path.join(repoRoot, "data", "archive");
  if (resolved !== expected) {
    throw new Error("Dashboard export accepts only the canonical data/archive root.");
  }
  return resolved;
}

export function resolveDashboardOutputDir(outputDir: string): string {
  const repoRoot = getRepoRoot();
  const resolved = resolveFromRepo(outputDir);
  const allowedRoot = path.join(repoRoot, "frontend", "public", "research-dashboard-data");
  if (!isEqualOrDescendant(resolved, allowedRoot)) {
    throw new Error(
      "Dashboard export output must stay under frontend/public/research-dashboard-data.",
    );
  }
  return resolved;
}

function parsePhase(value: string): string {
  const phase = nonEmpty(value, "--include-phase");
  if (!/^phase\d+(?:\.\d+[A-Za-z]?)?$/.test(phase)) {
    throw new Error("--include-phase must be a direct canonical phase name such as phase9.28.");
  }
  return phase;
}

function parseCohort(value: string): string {
  const cohort = nonEmpty(value, "--include-cohort").replace(/\\/g, "/");
  const [phase, name, ...remaining] = cohort.split("/");
  if (!phase || !name || remaining.length > 0 || !/^phase\d+(?:\.\d+[A-Za-z]?)?$/.test(phase)) {
    throw new Error("--include-cohort must use <phase>/<direct-archive-directory>.");
  }
  if (name === "." || name === ".." || name.includes("..")) {
    throw new Error("--include-cohort must not contain traversal segments.");
  }
  return `${phase}/${name}`;
}

function nonEmpty(value: string, option: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${option} must not be empty.`);
  return trimmed;
}

function resolveFromRepo(value: string): string {
  return path.resolve(getRepoRoot(), value);
}

function isEqualOrDescendant(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
