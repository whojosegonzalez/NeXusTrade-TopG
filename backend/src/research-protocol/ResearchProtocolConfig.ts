import { existsSync, statSync } from "node:fs";
import path from "node:path";

import {
  APPROVED_EXPLORATORY_PROTOCOL_PATHS,
  type ApprovedExploratoryProtocolPath,
} from "./ResearchProtocolConstants.js";
import { ResearchProtocolError } from "./ResearchProtocolErrors.js";
import { getResearchProtocolRepoRoot } from "./ResearchProtocolPaths.js";

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

export type ResearchProtocolFormat = (typeof supportedFormats)[number];

export interface ResearchProtocolConfig {
  readonly protocol: ApprovedExploratoryProtocolPath;
  readonly format: ResearchProtocolFormat;
  readonly once: boolean;
}

export function parseResearchProtocolArgs(argv: readonly string[]): ResearchProtocolConfig {
  let protocol: ApprovedExploratoryProtocolPath | undefined;
  let format: ResearchProtocolFormat = "markdown";
  let formatSeen = false;
  let once = false;

  for (const arg of argv) {
    if (arg === "--") continue;
    if (forbiddenPrefixes.some((prefix) => arg === prefix || arg.startsWith(`${prefix}=`))) {
      throw invalidScope(
        "Research protocol validation rejects write, runtime, provider, database, or execution options.",
      );
    }
    if (arg === "--once") {
      if (once) throw invalidScope("Research protocol validation accepts --once at most once.");
      once = true;
      continue;
    }
    if (arg.startsWith("--protocol=")) {
      if (protocol) {
        throw invalidScope("Research protocol validation accepts exactly one --protocol.");
      }
      protocol = parseProtocolPath(arg.slice("--protocol=".length));
      continue;
    }
    if (arg === "--protocol") {
      throw invalidScope("Research protocol validation requires --protocol=<relative-path>.");
    }
    if (arg.startsWith("--format=")) {
      if (formatSeen) {
        throw invalidScope("Research protocol validation accepts --format at most once.");
      }
      format = parseFormat(arg.slice("--format=".length));
      formatSeen = true;
      continue;
    }
    if (arg === "--format") {
      throw invalidScope(
        "Research protocol validation requires --format=markdown or --format=json.",
      );
    }
    throw invalidScope("Research protocol validation received an unsupported option.");
  }

  if (!protocol) {
    throw invalidScope("Research protocol validation requires the approved protocol path.");
  }
  return { protocol, format, once };
}

export function resolveResearchProtocol(config: ResearchProtocolConfig): string {
  const repoRoot = getResearchProtocolRepoRoot();
  const expectedDirectory = path.join(repoRoot, "docs", "research-protocols");
  const resolved = path.resolve(repoRoot, config.protocol);
  const relative = path.relative(expectedDirectory, resolved);
  if (
    !APPROVED_EXPLORATORY_PROTOCOL_PATHS.includes(config.protocol) ||
    relative !== path.basename(config.protocol) ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !existsSync(resolved) ||
    !statSync(resolved).isFile()
  ) {
    throw invalidRecord("The requested protocol is unavailable or outside the approved catalog.");
  }
  return resolved;
}

function parseProtocolPath(value: string): ApprovedExploratoryProtocolPath {
  const normalized = value.trim().replace(/\\/g, "/");
  if (
    !APPROVED_EXPLORATORY_PROTOCOL_PATHS.includes(normalized as ApprovedExploratoryProtocolPath) ||
    path.isAbsolute(value) ||
    normalized.includes("..") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(normalized)
  ) {
    throw invalidScope(
      "Research protocol validation accepts only the approved repository-relative protocol.",
    );
  }
  return normalized as ApprovedExploratoryProtocolPath;
}

function parseFormat(value: string): ResearchProtocolFormat {
  if (!supportedFormats.includes(value as ResearchProtocolFormat)) {
    throw invalidScope("Research protocol validation format must be markdown or json.");
  }
  return value as ResearchProtocolFormat;
}

function invalidScope(message: string): ResearchProtocolError {
  return new ResearchProtocolError("RESEARCH_PROTOCOL_INVALID_SCOPE", message);
}

function invalidRecord(message: string): ResearchProtocolError {
  return new ResearchProtocolError("RESEARCH_PROTOCOL_INVALID_RECORD", message);
}
