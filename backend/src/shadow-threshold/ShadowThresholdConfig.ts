import type { ResearchRunSourceConfig } from "../research/ResearchAggregateTypes.js";
import type { ShadowThresholdRuntimeConfig } from "./ShadowThresholdTypes.js";

type Draft = {
  -readonly [Key in keyof ShadowThresholdRuntimeConfig]?: ShadowThresholdRuntimeConfig[Key];
};

const forbiddenOptionPrefixes = [
  "--score-min=",
  "--score-max=",
  "--buy-score-threshold=",
  "--watch-score-threshold=",
  "--source-decisions=",
  "--target-pcts=",
  "--stop-pcts=",
  "--max-hold-minutes=",
  "--dedupe-mode=",
] as const;

export function defaultShadowThresholdConfig(): ShadowThresholdRuntimeConfig {
  return {
    once: false,
    json: false,
    runSources: [],
  };
}

export function parseShadowThresholdArgs(argv: readonly string[]): ShadowThresholdRuntimeConfig {
  const parsed: Draft = {};
  const runSources: ResearchRunSourceConfig[] = [];

  for (const arg of argv) {
    const forbidden = forbiddenOptionPrefixes.find((prefix) => arg.startsWith(prefix));

    if (forbidden) {
      throw new Error(
        `Narrow threshold validation uses immutable T65N@v1 settings; ${forbidden.slice(0, -1)} cannot be overridden.`,
      );
    }

    if (arg === "--once") {
      parsed.once = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg.startsWith("--label-run=")) {
      runSources.push(parseLabelRun(arg));
    } else if (arg.startsWith("--output-dir=")) {
      parsed.outputDir = nonEmpty(arg.slice("--output-dir=".length), "--output-dir");
    } else {
      throw new Error(`Unknown narrow threshold validation option: ${arg}`);
    }
  }

  const config = { ...defaultShadowThresholdConfig(), ...parsed, runSources };

  if (config.runSources.length === 0) {
    throw new Error(
      "Narrow threshold validation requires one or more --label-run=<label>:<archive-path> options.",
    );
  }

  if (new Set(config.runSources.map((source) => source.label)).size !== config.runSources.length) {
    throw new Error("Narrow threshold validation run labels must be unique.");
  }

  return config;
}

function parseLabelRun(arg: string): ResearchRunSourceConfig {
  const raw = arg.slice("--label-run=".length);
  const separator = raw.indexOf(":");

  if (separator <= 0 || separator === raw.length - 1) {
    throw new Error("--label-run must use <label>:<archive-path>.");
  }

  return {
    label: nonEmpty(raw.slice(0, separator), "--label-run label"),
    path: nonEmpty(raw.slice(separator + 1), "--label-run path"),
  };
}

function nonEmpty(value: string, option: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error(`${option} must not be empty.`);
  }

  return trimmed;
}
