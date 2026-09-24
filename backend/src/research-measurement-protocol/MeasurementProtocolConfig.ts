import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MEASUREMENT_PROTOCOL_V3_PATH } from "./MeasurementProtocolConstants.js";
import { MeasurementProtocolError } from "./MeasurementProtocolErrors.js";

const supportedFormats = ["markdown", "json"] as const;
const forbiddenPrefixes = [
  "--archive",
  "--output",
  "--output-dir",
  "--file",
  "--write",
  "--save",
  "--environment",
  "--env",
  "--provider",
  "--http",
  "--url",
  "--db",
  "--database",
  "--runtime",
  "--scanner",
  "--strategy",
  "--risk",
  "--score",
  "--threshold",
  "--target",
  "--stop",
  "--monitor",
  "--scheduler",
  "--session",
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
  "--include",
  "--phase",
  "--cohort",
  "--config",
] as const;

export type MeasurementProtocolFormat = (typeof supportedFormats)[number];

export interface MeasurementProtocolConfig {
  readonly protocol: typeof MEASUREMENT_PROTOCOL_V3_PATH;
  readonly format: MeasurementProtocolFormat;
  readonly once: boolean;
}

export function parseMeasurementProtocolArgs(argv: readonly string[]): MeasurementProtocolConfig {
  let protocol: typeof MEASUREMENT_PROTOCOL_V3_PATH | undefined;
  let format: MeasurementProtocolFormat = "markdown";
  let formatSeen = false;
  let once = false;

  for (const arg of argv) {
    if (arg === "--") continue;
    if (forbiddenPrefixes.some((prefix) => arg === prefix || arg.startsWith(`${prefix}=`))) {
      throw invalidScope(
        "Measurement protocol validation rejects archive, write, provider, runtime, database, or execution options.",
      );
    }
    if (arg === "--once") {
      if (once) throw invalidScope("Measurement protocol validation accepts --once at most once.");
      once = true;
      continue;
    }
    if (arg.startsWith("--protocol=")) {
      if (protocol) {
        throw invalidScope("Measurement protocol validation accepts exactly one --protocol.");
      }
      protocol = parseProtocolPath(arg.slice("--protocol=".length));
      continue;
    }
    if (arg === "--protocol") {
      throw invalidScope("Measurement protocol validation requires --protocol=<relative-path>.");
    }
    if (arg.startsWith("--format=")) {
      if (formatSeen) {
        throw invalidScope("Measurement protocol validation accepts --format at most once.");
      }
      format = parseFormat(arg.slice("--format=".length));
      formatSeen = true;
      continue;
    }
    if (arg === "--format") {
      throw invalidScope(
        "Measurement protocol validation requires --format=markdown or --format=json.",
      );
    }
    throw invalidScope("Measurement protocol validation received an unsupported option.");
  }

  if (!protocol) {
    throw invalidScope("Measurement protocol validation requires the approved protocol path.");
  }
  return { protocol, format, once };
}

export function resolveMeasurementProtocol(config: MeasurementProtocolConfig): string {
  const repoRoot = getMeasurementProtocolRepoRoot();
  const expectedDirectory = path.join(repoRoot, "docs", "research-protocols");
  const resolved = path.resolve(repoRoot, config.protocol);
  const relative = path.relative(expectedDirectory, resolved);
  if (
    config.protocol !== MEASUREMENT_PROTOCOL_V3_PATH ||
    relative !== path.basename(config.protocol) ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !existsSync(resolved) ||
    !statSync(resolved).isFile()
  ) {
    throw unsupportedDraft(
      "The requested measurement protocol is unavailable or outside its fixed path.",
    );
  }
  return resolved;
}

export function getMeasurementProtocolRepoRoot(): string {
  const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(sourceDirectory, "../../..");
}

function parseProtocolPath(value: string): typeof MEASUREMENT_PROTOCOL_V3_PATH {
  const normalized = value.trim().replace(/\\/g, "/");
  if (
    normalized !== MEASUREMENT_PROTOCOL_V3_PATH ||
    path.isAbsolute(value) ||
    normalized.includes("..") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(normalized)
  ) {
    throw invalidScope(
      "Measurement protocol validation accepts only the fixed repository-relative protocol path.",
    );
  }
  return MEASUREMENT_PROTOCOL_V3_PATH;
}

function parseFormat(value: string): MeasurementProtocolFormat {
  if (!supportedFormats.includes(value as MeasurementProtocolFormat)) {
    throw invalidScope("Measurement protocol validation format must be markdown or json.");
  }
  return value as MeasurementProtocolFormat;
}

function invalidScope(message: string): MeasurementProtocolError {
  return new MeasurementProtocolError("MEASUREMENT_PROTOCOL_INVALID_SCOPE", message);
}

function unsupportedDraft(message: string): MeasurementProtocolError {
  return new MeasurementProtocolError("MEASUREMENT_PROTOCOL_UNSUPPORTED_DRAFT", message);
}
