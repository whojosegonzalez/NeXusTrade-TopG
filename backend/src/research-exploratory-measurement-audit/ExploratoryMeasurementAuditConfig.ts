import { existsSync, lstatSync } from "node:fs";
import path from "node:path";

import { ExploratoryMeasurementAuditError } from "./ExploratoryMeasurementAuditErrors.js";
import { EXPLORATORY_MEASUREMENT_AUDIT_ARCHIVE_ROOT } from "./ExploratoryMeasurementAuditIdentity.js";
import { getExploratoryMeasurementAuditRepoRoot } from "./ExploratoryMeasurementAuditPaths.js";
import {
  auditFormatSchema,
  type ExploratoryMeasurementAuditFormat,
} from "./ExploratoryMeasurementAuditTypes.js";

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
  "--phase",
  "--cohort",
  "--include",
] as const;

export interface ExploratoryMeasurementAuditConfig {
  readonly archiveRoot: typeof EXPLORATORY_MEASUREMENT_AUDIT_ARCHIVE_ROOT;
  readonly format: ExploratoryMeasurementAuditFormat;
  readonly once: boolean;
}

export function parseExploratoryMeasurementAuditArgs(
  argv: readonly string[],
): ExploratoryMeasurementAuditConfig {
  let archiveRoot: typeof EXPLORATORY_MEASUREMENT_AUDIT_ARCHIVE_ROOT | undefined;
  let format: ExploratoryMeasurementAuditFormat = "markdown";
  let formatSeen = false;
  let once = false;
  for (const arg of argv) {
    if (arg === "--") continue;
    if (forbiddenPrefixes.some((prefix) => arg === prefix || arg.startsWith(`${prefix}=`))) {
      throw invalidScope(
        "Measurement audit rejects write, provider, runtime, and execution options.",
      );
    }
    if (arg === "--once") {
      if (once) throw invalidScope("Measurement audit accepts --once at most once.");
      once = true;
      continue;
    }
    if (arg.startsWith("--archive-root=")) {
      if (archiveRoot) throw invalidScope("Measurement audit accepts exactly one --archive-root.");
      archiveRoot = parseArchiveRoot(arg.slice("--archive-root=".length));
      continue;
    }
    if (arg === "--archive-root")
      throw invalidScope("Measurement audit requires --archive-root=<relative-path>.");
    if (arg.startsWith("--format=")) {
      if (formatSeen) throw invalidScope("Measurement audit accepts --format at most once.");
      const parsed = auditFormatSchema.safeParse(arg.slice("--format=".length));
      if (!parsed.success) throw invalidScope("Measurement audit format must be markdown or json.");
      format = parsed.data;
      formatSeen = true;
      continue;
    }
    if (arg === "--format")
      throw invalidScope("Measurement audit requires --format=markdown or --format=json.");
    throw invalidScope("Measurement audit received an unsupported option.");
  }
  if (!archiveRoot) throw invalidScope("Measurement audit requires the one approved archive root.");
  return { archiveRoot, format, once };
}

export function resolveExploratoryMeasurementAuditArchive(
  config: ExploratoryMeasurementAuditConfig,
  repoRoot = getExploratoryMeasurementAuditRepoRoot(),
): string {
  const expected = path.join(repoRoot, ...EXPLORATORY_MEASUREMENT_AUDIT_ARCHIVE_ROOT.split("/"));
  const resolved = path.resolve(repoRoot, config.archiveRoot);
  if (
    resolved !== expected ||
    !existsSync(resolved) ||
    !lstatSync(resolved).isDirectory() ||
    lstatSync(resolved).isSymbolicLink()
  ) {
    throw unsupported("The approved archive root is unavailable or unsafe.");
  }
  return resolved;
}

function parseArchiveRoot(value: string): typeof EXPLORATORY_MEASUREMENT_AUDIT_ARCHIVE_ROOT {
  const normalized = value.trim().replace(/\\/g, "/");
  if (
    normalized !== EXPLORATORY_MEASUREMENT_AUDIT_ARCHIVE_ROOT ||
    path.isAbsolute(value) ||
    normalized.split("/").includes("..") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(normalized)
  ) {
    throw invalidScope(
      "Measurement audit accepts only the approved repository-relative archive root.",
    );
  }
  return EXPLORATORY_MEASUREMENT_AUDIT_ARCHIVE_ROOT;
}

function invalidScope(message: string): ExploratoryMeasurementAuditError {
  return new ExploratoryMeasurementAuditError(
    "EXPLORATORY_MEASUREMENT_AUDIT_INVALID_SCOPE",
    message,
  );
}

function unsupported(message: string): ExploratoryMeasurementAuditError {
  return new ExploratoryMeasurementAuditError(
    "EXPLORATORY_MEASUREMENT_AUDIT_UNSUPPORTED_ARCHIVE",
    message,
  );
}
