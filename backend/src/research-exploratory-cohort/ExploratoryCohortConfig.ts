import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXPLORATORY_COHORT_ARCHIVE_PREFIX,
  EXPLORATORY_COHORT_PROTOCOL_PATH,
} from "./ExploratoryCohortConstants.js";
import { ExploratoryCohortError } from "./ExploratoryCohortErrors.js";
import type { ExploratoryCohortConfig, ExploratoryCohortFormat } from "./ExploratoryCohortTypes.js";

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

export function parseExploratoryCohortArgs(argv: readonly string[]): ExploratoryCohortConfig {
  let protocol: string | undefined;
  let archiveRoot: string | undefined;
  let archiveStamp: string | undefined;
  let format: ExploratoryCohortFormat = "markdown";
  let formatSeen = false;
  let once = false;
  let finalizeMissedSlots = false;

  for (const arg of argv) {
    if (arg === "--") continue;
    if (forbiddenPrefixes.some((prefix) => arg === prefix || arg.startsWith(`${prefix}=`))) {
      throw invalidScope(
        "Exploratory collection rejects unsafe runtime, write, provider, and execution options.",
      );
    }
    if (arg === "--once") {
      if (once) throw invalidScope("Exploratory collection accepts --once at most once.");
      once = true;
      continue;
    }
    if (arg === "--finalize-missed-slots") {
      if (finalizeMissedSlots)
        throw invalidScope("Exploratory collection accepts --finalize-missed-slots at most once.");
      finalizeMissedSlots = true;
      continue;
    }
    if (arg.startsWith("--protocol=")) {
      if (protocol) throw invalidScope("Exploratory collection accepts exactly one --protocol.");
      protocol = parseProtocol(arg.slice("--protocol=".length));
      continue;
    }
    if (arg.startsWith("--archive-root=")) {
      if (archiveRoot)
        throw invalidScope("Exploratory collection accepts exactly one --archive-root.");
      const parsed = parseArchiveRoot(arg.slice("--archive-root=".length));
      archiveRoot = parsed.root;
      archiveStamp = parsed.stamp;
      continue;
    }
    if (arg.startsWith("--format=")) {
      if (formatSeen) throw invalidScope("Exploratory collection accepts --format at most once.");
      format = parseFormat(arg.slice("--format=".length));
      formatSeen = true;
      continue;
    }
    throw invalidScope("Exploratory collection received an unsupported option.");
  }

  if (!protocol || !archiveRoot || !archiveStamp || once === finalizeMissedSlots) {
    throw invalidScope(
      "Exploratory collection requires the fixed protocol, one archive root, and exactly one invocation mode.",
    );
  }
  return {
    protocol,
    archiveRoot,
    archiveStamp,
    format,
    once,
    mode: once ? "COLLECT_SLOT" : "FINALIZE_MISSED_SLOTS",
  };
}

export function resolveExploratoryCohortArchiveRoot(config: ExploratoryCohortConfig): string {
  const repoRoot = getExploratoryCohortRepoRoot();
  const archiveBase = path.join(repoRoot, "data", "archive", "phase10.6a");
  const resolved = path.resolve(repoRoot, config.archiveRoot);
  const relative = path.relative(archiveBase, resolved);
  if (
    relative !== path.basename(config.archiveRoot) ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw invalidScope(
      "Exploratory collection archive root is outside the approved Phase 10.6A path.",
    );
  }
  return resolved;
}

export function resolveExploratoryCohortProtocol(config: ExploratoryCohortConfig): string {
  const repoRoot = getExploratoryCohortRepoRoot();
  const resolved = path.resolve(repoRoot, config.protocol);
  const expected = path.join(repoRoot, EXPLORATORY_COHORT_PROTOCOL_PATH);
  if (resolved !== expected || !existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new ExploratoryCohortError(
      "EXPLORATORY_COHORT_PROTOCOL_INCONSISTENCY",
      "The fixed V2 protocol is unavailable.",
    );
  }
  return resolved;
}

export function getExploratoryCohortRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function parseProtocol(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  if (
    normalized !== EXPLORATORY_COHORT_PROTOCOL_PATH ||
    hasTraversal(normalized) ||
    isAbsoluteOrUrl(value)
  ) {
    throw invalidScope("Exploratory collection accepts only the pinned V2 protocol path.");
  }
  return EXPLORATORY_COHORT_PROTOCOL_PATH;
}

function parseArchiveRoot(value: string): { readonly root: string; readonly stamp: string } {
  const normalized = value.trim().replace(/\\/g, "/");
  if (
    hasTraversal(normalized) ||
    isAbsoluteOrUrl(value) ||
    !normalized.startsWith(EXPLORATORY_COHORT_ARCHIVE_PREFIX)
  ) {
    throw invalidScope(
      "Exploratory collection requires the fixed Phase 10.6A archive-root grammar.",
    );
  }
  const stamp = normalized.slice(EXPLORATORY_COHORT_ARCHIVE_PREFIX.length);
  if (!/^\d{8}-0000Z$/.test(stamp)) {
    throw invalidScope("The first V2 collection archive must begin at 00:00Z.");
  }
  return { root: normalized, stamp };
}

function parseFormat(value: string): ExploratoryCohortFormat {
  if (!supportedFormats.includes(value as ExploratoryCohortFormat)) {
    throw invalidScope("Exploratory collection format must be markdown or json.");
  }
  return value as ExploratoryCohortFormat;
}

function hasTraversal(value: string): boolean {
  return value
    .split("/")
    .some((part) => part === ".." || (part.length === 0 && value.includes("//")));
}

function isAbsoluteOrUrl(value: string): boolean {
  return path.isAbsolute(value) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value.trim());
}

function invalidScope(message: string): ExploratoryCohortError {
  return new ExploratoryCohortError("EXPLORATORY_COHORT_INVALID_SCOPE", message);
}
