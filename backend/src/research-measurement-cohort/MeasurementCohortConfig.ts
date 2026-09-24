import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MEASUREMENT_COHORT_LAUNCH_PREFIX,
  MEASUREMENT_COHORT_PROTOCOL_PATH,
} from "./MeasurementCohortConstants.js";
import { MeasurementCohortError } from "./MeasurementCohortErrors.js";
import type { MeasurementCohortConfig, MeasurementCohortFormat } from "./MeasurementCohortTypes.js";

const formats = ["markdown", "json"] as const;
const forbiddenPrefixes = [
  "--archive",
  "--root",
  "--output",
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
  "--monitor",
  "--scheduler",
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
  "--include",
  "--phase",
  "--cohort",
] as const;

export function parseMeasurementCohortArgs(argv: readonly string[]): MeasurementCohortConfig {
  let protocol: string | undefined;
  let launch: string | undefined;
  let format: MeasurementCohortFormat = "markdown";
  let formatSeen = false;
  let once = false;
  for (const arg of argv) {
    if (arg === "--") continue;
    if (forbiddenPrefixes.some((prefix) => arg === prefix || arg.startsWith(`${prefix}=`))) {
      throw invalidScope(
        "Measurement collection rejects archive overrides and unsafe runtime or execution options.",
      );
    }
    if (arg === "--once") {
      if (once) throw invalidScope("Measurement collection accepts --once at most once.");
      once = true;
      continue;
    }
    if (arg.startsWith("--protocol=")) {
      if (protocol) throw invalidScope("Measurement collection accepts exactly one --protocol.");
      protocol = fixedProtocol(arg.slice("--protocol=".length));
      continue;
    }
    if (arg.startsWith("--launch=")) {
      if (launch) throw invalidScope("Measurement collection accepts exactly one --launch.");
      launch = launchPath(arg.slice("--launch=".length));
      continue;
    }
    if (arg.startsWith("--format=")) {
      if (formatSeen) throw invalidScope("Measurement collection accepts --format at most once.");
      const value = arg.slice("--format=".length);
      if (!formats.includes(value as MeasurementCohortFormat))
        throw invalidScope("Format must be markdown or json.");
      format = value as MeasurementCohortFormat;
      formatSeen = true;
      continue;
    }
    throw invalidScope("Measurement collection received an unsupported option.");
  }
  if (!protocol || !launch || !once) {
    throw invalidScope(
      "Measurement collection requires the fixed V3 protocol, one source-controlled launch record, and --once.",
    );
  }
  return { protocol, launch, format, once: true };
}

export function measurementCohortRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function resolveFixedMeasurementProtocol(config: MeasurementCohortConfig): string {
  const resolved = path.resolve(measurementCohortRepoRoot(), config.protocol);
  const expected = path.join(measurementCohortRepoRoot(), MEASUREMENT_COHORT_PROTOCOL_PATH);
  if (resolved !== expected || !existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new MeasurementCohortError(
      "MEASUREMENT_COHORT_PROTOCOL_INCONSISTENCY",
      "The fixed V3 measurement protocol is unavailable.",
    );
  }
  return resolved;
}

export function resolveMeasurementLaunch(config: MeasurementCohortConfig): string {
  const root = measurementCohortRepoRoot();
  const resolved = path.resolve(root, config.launch);
  const allowed = path.join(root, "docs", "research-launches");
  const relative = path.relative(allowed, resolved);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !existsSync(resolved) ||
    !statSync(resolved).isFile()
  ) {
    throw new MeasurementCohortError(
      "MEASUREMENT_COHORT_LAUNCH_INCONSISTENCY",
      "The named V3 launch record is unavailable.",
    );
  }
  return resolved;
}

function fixedProtocol(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  if (normalized !== MEASUREMENT_COHORT_PROTOCOL_PATH || unsafePath(value)) {
    throw invalidScope("Measurement collection accepts only the pinned V3 protocol path.");
  }
  return MEASUREMENT_COHORT_PROTOCOL_PATH;
}

function launchPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  const suffix = normalized.slice(MEASUREMENT_COHORT_LAUNCH_PREFIX.length);
  if (
    !normalized.startsWith(MEASUREMENT_COHORT_LAUNCH_PREFIX) ||
    !/^\d{8}-\d{4}Z\.json$/.test(suffix) ||
    unsafePath(value)
  ) {
    throw invalidScope(
      "Measurement collection accepts only a named source-controlled V3 launch record.",
    );
  }
  return normalized;
}

function unsafePath(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value.trim()) ||
    value.split(/[\\/]/).includes("..")
  );
}

function invalidScope(message: string): MeasurementCohortError {
  return new MeasurementCohortError("MEASUREMENT_COHORT_INVALID_SCOPE", message);
}
