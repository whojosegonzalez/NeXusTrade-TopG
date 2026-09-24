import type { ResearchRunSourceConfig } from "../research/ResearchAggregateTypes.js";
import type { FastEntryAttributionRuntimeConfig } from "./FastEntryAttributionTypes.js";

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
] as const;

export function parseFastEntryAttributionArgs(
  argv: readonly string[],
): FastEntryAttributionRuntimeConfig {
  const runSources: ResearchRunSourceConfig[] = [];
  let once = false;
  let json = false;
  let outputDir: string | undefined;

  for (const arg of argv) {
    if (forbiddenPrefixes.some((prefix) => arg === prefix || arg.startsWith(prefix))) {
      throw new Error(`Fast-entry attribution rejects active-runtime or override option: ${arg}.`);
    }
    if (arg === "--once") once = true;
    else if (arg === "--json") json = true;
    else if (arg.startsWith("--output-dir=")) outputDir = nonEmpty(arg.slice(13), "--output-dir");
    else if (arg.startsWith("--label-run=")) runSources.push(parseLabelRun(arg));
    else throw new Error(`Unknown fast-entry attribution option: ${arg}`);
  }

  if (runSources.length === 0) {
    throw new Error(
      "Fast-entry attribution requires one or more --label-run=<label>:<archive-path> options.",
    );
  }
  if (new Set(runSources.map((source) => source.label)).size !== runSources.length) {
    throw new Error("Fast-entry attribution labels must be unique.");
  }

  return { once, json, runSources, ...(outputDir ? { outputDir } : {}) };
}

function parseLabelRun(arg: string): ResearchRunSourceConfig {
  const raw = arg.slice("--label-run=".length);
  const separator = raw.indexOf(":");
  if (separator <= 0 || separator === raw.length - 1) {
    throw new Error("--label-run must use <label>:<archive-path>.");
  }
  const path = nonEmpty(raw.slice(separator + 1), "--label-run path");
  const normalized = path.replace(/[\\/]+/g, "/").toLowerCase();
  if (!normalized.includes("data/archive/")) {
    throw new Error(
      "Fast-entry attribution accepts archived run directories under data/archive only.",
    );
  }
  return { label: nonEmpty(raw.slice(0, separator), "--label-run label"), path };
}

function nonEmpty(value: string, option: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${option} must not be empty.`);
  return trimmed;
}
