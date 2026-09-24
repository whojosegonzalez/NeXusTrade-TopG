import { strategyDecisionValues, type StrategyDecision } from "../db/schema/index.js";

export type ShadowEntryProfileId =
  | "P001"
  | "P002"
  | "P003"
  | "P004"
  | "P005"
  | "P006"
  | "P007"
  | "P008"
  | "P009"
  | "P010"
  | "P011";
export type ShadowEntryTimingMode = "decision" | "first_entry" | "latest_entry";
export type ShadowEntryEarlyDrawdownMode =
  | "off"
  | "warn_only"
  | "reject_5"
  | "reject_10"
  | "reject_15"
  | "require_recovery";

export interface ShadowEntryDbSourceConfig {
  readonly label: string;
  readonly path: string;
}

export interface ShadowEntryRuntimeConfig {
  readonly once: boolean;
  readonly json: boolean;
  readonly targetPcts: readonly number[];
  readonly stopPcts: readonly number[];
  readonly maxHoldMinutes: readonly number[];
  readonly confirmationHorizonsMinutes: readonly number[];
  readonly confirmationMinReturnPcts: readonly number[];
  readonly earlyDrawdownModes: readonly ShadowEntryEarlyDrawdownMode[];
  readonly recoveryConfirmationReturnPcts: readonly number[];
  readonly recoveryWindowMinutes: readonly number[];
  readonly scoreBucketSize: number;
  readonly minScore: number;
  readonly sourceDecisions: readonly StrategyDecision[];
  readonly entryTimingModes: readonly ShadowEntryTimingMode[];
  readonly profileIds: readonly ShadowEntryProfileId[];
  readonly portfolioStartingSol: number;
  readonly portfolioPositionSizeSol: number;
  readonly portfolioGoalPct: number;
  readonly portfolioMaxPositions: number;
  readonly dbSources: readonly ShadowEntryDbSourceConfig[];
  readonly sessionId?: string;
}

type MutableShadowEntryConfigDraft = {
  -readonly [Key in keyof ShadowEntryRuntimeConfig]?: ShadowEntryRuntimeConfig[Key];
};

const DEFAULTS = {
  targetPcts: [10, 15, 25],
  stopPcts: [10, 15, 25],
  maxHoldMinutes: [15, 30, 60],
  confirmationHorizonsMinutes: [1, 2, 3],
  confirmationMinReturnPcts: [0, 2, 5],
  earlyDrawdownModes: [
    "off",
    "warn_only",
    "reject_5",
    "reject_10",
    "reject_15",
    "require_recovery",
  ] as readonly ShadowEntryEarlyDrawdownMode[],
  recoveryConfirmationReturnPcts: [0, 2, 5],
  recoveryWindowMinutes: [3, 5, 10, 15],
  scoreBucketSize: 5,
  minScore: 50,
  sourceDecisions: ["BUY", "WATCH", "SKIP"] as readonly StrategyDecision[],
  entryTimingModes: ["decision", "first_entry", "latest_entry"] as readonly ShadowEntryTimingMode[],
  profileIds: [
    "P001",
    "P002",
    "P003",
    "P004",
    "P005",
    "P006",
    "P007",
    "P008",
    "P009",
    "P010",
    "P011",
  ] as readonly ShadowEntryProfileId[],
  portfolioStartingSol: 1,
  portfolioPositionSizeSol: 0.01,
  portfolioGoalPct: 25,
  portfolioMaxPositions: 5,
} as const;

const PROFILE_ALIASES: Readonly<Record<string, ShadowEntryProfileId>> = {
  p001: "P001",
  baseline_raw_buy: "P001",
  p002: "P002",
  score65_confirmed: "P002",
  p003: "P003",
  duplicate_attention: "P003",
  p004: "P004",
  score55_research: "P004",
  p005: "P005",
  quote_control: "P005",
  p006: "P006",
  recovery_after_drawdown: "P006",
  p007: "P007",
  watch_first_confirmed: "P007",
  p008: "P008",
  duplicate_attention_confirmed: "P008",
  p009: "P009",
  score65_79_confirmed: "P009",
  p010: "P010",
  high_score75_research: "P010",
  p011: "P011",
  watch_duplicate_hybrid: "P011",
};

export function defaultShadowEntryConfig(): ShadowEntryRuntimeConfig {
  return {
    once: false,
    json: false,
    targetPcts: DEFAULTS.targetPcts,
    stopPcts: DEFAULTS.stopPcts,
    maxHoldMinutes: DEFAULTS.maxHoldMinutes,
    confirmationHorizonsMinutes: DEFAULTS.confirmationHorizonsMinutes,
    confirmationMinReturnPcts: DEFAULTS.confirmationMinReturnPcts,
    earlyDrawdownModes: DEFAULTS.earlyDrawdownModes,
    recoveryConfirmationReturnPcts: DEFAULTS.recoveryConfirmationReturnPcts,
    recoveryWindowMinutes: DEFAULTS.recoveryWindowMinutes,
    scoreBucketSize: DEFAULTS.scoreBucketSize,
    minScore: DEFAULTS.minScore,
    sourceDecisions: DEFAULTS.sourceDecisions,
    entryTimingModes: DEFAULTS.entryTimingModes,
    profileIds: DEFAULTS.profileIds,
    portfolioStartingSol: DEFAULTS.portfolioStartingSol,
    portfolioPositionSizeSol: DEFAULTS.portfolioPositionSizeSol,
    portfolioGoalPct: DEFAULTS.portfolioGoalPct,
    portfolioMaxPositions: DEFAULTS.portfolioMaxPositions,
    dbSources: [],
  };
}

export function parseShadowEntryArgs(argv: readonly string[]): ShadowEntryRuntimeConfig {
  const parsed: MutableShadowEntryConfigDraft = {};
  const dbSources: ShadowEntryDbSourceConfig[] = [];

  for (const arg of argv) {
    if (arg === "--once") {
      parsed.once = true;
      continue;
    }

    if (arg === "--json") {
      parsed.json = true;
      continue;
    }

    if (arg.startsWith("--label-db=")) {
      dbSources.push(parseLabelDbOption(arg));
      continue;
    }

    if (arg.startsWith("--db=")) {
      const dbPath = arg.slice("--db=".length).trim();

      if (!dbPath) {
        throw new Error("Invalid shadow entries option: --db must not be empty.");
      }

      dbSources.push({ label: `db${dbSources.length + 1}`, path: dbPath });
      continue;
    }

    if (arg.startsWith("--session-id=")) {
      const sessionId = arg.slice("--session-id=".length).trim();

      if (!sessionId) {
        throw new Error("Invalid shadow entries option: --session-id must not be empty.");
      }

      parsed.sessionId = sessionId;
      continue;
    }

    if (arg.startsWith("--profile=")) {
      parsed.profileIds = [parseProfileId(arg.slice("--profile=".length))];
      continue;
    }

    if (arg.startsWith("--profiles=")) {
      parsed.profileIds = parseProfileList(arg, "--profiles");
      continue;
    }

    if (arg.startsWith("--target-pcts=")) {
      parsed.targetPcts = parseNumberListOption(arg, "--target-pcts");
      continue;
    }

    if (arg.startsWith("--stop-pcts=")) {
      parsed.stopPcts = parseNumberListOption(arg, "--stop-pcts");
      continue;
    }

    if (arg.startsWith("--max-hold-minutes=")) {
      parsed.maxHoldMinutes = parseIntegerListOption(arg, "--max-hold-minutes");
      continue;
    }

    if (arg.startsWith("--confirmation-horizons=")) {
      parsed.confirmationHorizonsMinutes = parseIntegerListOption(arg, "--confirmation-horizons");
      continue;
    }

    if (arg.startsWith("--confirmation-min-return-pcts=")) {
      parsed.confirmationMinReturnPcts = parseNumberListOption(
        arg,
        "--confirmation-min-return-pcts",
      );
      continue;
    }

    if (arg.startsWith("--early-drawdown-mode=")) {
      parsed.earlyDrawdownModes = [
        parseEarlyDrawdownMode(arg.slice("--early-drawdown-mode=".length)),
      ];
      continue;
    }

    if (arg.startsWith("--early-drawdown-modes=")) {
      parsed.earlyDrawdownModes = parseEarlyDrawdownModeList(arg, "--early-drawdown-modes");
      continue;
    }

    if (arg.startsWith("--recovery-confirmation-return-pcts=")) {
      parsed.recoveryConfirmationReturnPcts = parseNumberListOption(
        arg,
        "--recovery-confirmation-return-pcts",
      );
      continue;
    }

    if (arg.startsWith("--recovery-window-minutes=")) {
      parsed.recoveryWindowMinutes = parseIntegerListOption(arg, "--recovery-window-minutes");
      continue;
    }

    if (arg.startsWith("--score-bucket-size=")) {
      parsed.scoreBucketSize = parseIntegerOption(arg, "--score-bucket-size");
      continue;
    }

    if (arg.startsWith("--min-score=")) {
      parsed.minScore = parseIntegerOption(arg, "--min-score");
      continue;
    }

    if (arg.startsWith("--source-decisions=")) {
      parsed.sourceDecisions = parseDecisionListOption(arg, "--source-decisions");
      continue;
    }

    if (arg.startsWith("--entry-timing=")) {
      parsed.entryTimingModes = [parseTimingMode(arg.slice("--entry-timing=".length))];
      continue;
    }

    if (arg.startsWith("--entry-timings=")) {
      parsed.entryTimingModes = parseTimingModeList(arg, "--entry-timings");
      continue;
    }

    if (arg.startsWith("--portfolio-starting-sol=")) {
      parsed.portfolioStartingSol = parseNumberOption(arg, "--portfolio-starting-sol");
      continue;
    }

    if (arg.startsWith("--portfolio-position-size-sol=")) {
      parsed.portfolioPositionSizeSol = parseNumberOption(arg, "--portfolio-position-size-sol");
      continue;
    }

    if (arg.startsWith("--portfolio-goal-pct=")) {
      parsed.portfolioGoalPct = parseNumberOption(arg, "--portfolio-goal-pct");
      continue;
    }

    if (arg.startsWith("--portfolio-max-positions=")) {
      parsed.portfolioMaxPositions = parseIntegerOption(arg, "--portfolio-max-positions");
      continue;
    }

    throw new Error(`Unknown shadow entries option: ${arg}`);
  }

  return validateShadowEntryConfig({
    ...defaultShadowEntryConfig(),
    ...parsed,
    dbSources,
  });
}

export function validateShadowEntryConfig(
  config: ShadowEntryRuntimeConfig,
): ShadowEntryRuntimeConfig {
  validateNonEmpty("targetPcts", config.targetPcts);
  validateNonEmpty("stopPcts", config.stopPcts);
  validateNonEmpty("maxHoldMinutes", config.maxHoldMinutes);
  validateNonEmpty("confirmationHorizonsMinutes", config.confirmationHorizonsMinutes);
  validateNonEmpty("confirmationMinReturnPcts", config.confirmationMinReturnPcts);
  validateNonEmpty("earlyDrawdownModes", config.earlyDrawdownModes);
  validateNonEmpty("recoveryConfirmationReturnPcts", config.recoveryConfirmationReturnPcts);
  validateNonEmpty("recoveryWindowMinutes", config.recoveryWindowMinutes);
  validateNonEmpty("sourceDecisions", config.sourceDecisions);
  validateNonEmpty("entryTimingModes", config.entryTimingModes);
  validateNonEmpty("profileIds", config.profileIds);

  for (const value of config.targetPcts) validatePositiveNumber("targetPct", value);
  for (const value of config.stopPcts) validatePositiveNumber("stopPct", value);
  for (const value of config.maxHoldMinutes) validatePositiveInteger("maxHoldMinutes", value);
  for (const value of config.confirmationHorizonsMinutes) {
    validatePositiveInteger("confirmationHorizonMinutes", value);
  }
  for (const value of config.confirmationMinReturnPcts) {
    validateFiniteNumber("confirmationMinReturnPct", value);
  }
  for (const value of config.recoveryConfirmationReturnPcts) {
    validateFiniteNumber("recoveryConfirmationReturnPct", value);
  }
  for (const value of config.recoveryWindowMinutes)
    validatePositiveInteger("recoveryWindowMinutes", value);

  validatePositiveInteger("scoreBucketSize", config.scoreBucketSize);
  validateScore("minScore", config.minScore);
  validatePositiveNumber("portfolioStartingSol", config.portfolioStartingSol);
  validatePositiveNumber("portfolioPositionSizeSol", config.portfolioPositionSizeSol);
  validatePositiveNumber("portfolioGoalPct", config.portfolioGoalPct);
  validatePositiveInteger("portfolioMaxPositions", config.portfolioMaxPositions);

  if (config.portfolioPositionSizeSol > config.portfolioStartingSol) {
    throw new Error(
      "Invalid shadow entries option: portfolioPositionSizeSol must not exceed portfolioStartingSol.",
    );
  }

  assertUniqueLabels(config.dbSources);

  return {
    ...config,
    targetPcts: uniqueNumbers(config.targetPcts),
    stopPcts: uniqueNumbers(config.stopPcts),
    maxHoldMinutes: uniqueNumbers(config.maxHoldMinutes).sort((left, right) => left - right),
    confirmationHorizonsMinutes: uniqueNumbers(config.confirmationHorizonsMinutes).sort(
      (left, right) => left - right,
    ),
    confirmationMinReturnPcts: uniqueNumbers(config.confirmationMinReturnPcts).sort(
      (left, right) => left - right,
    ),
    earlyDrawdownModes: unique(config.earlyDrawdownModes),
    recoveryConfirmationReturnPcts: uniqueNumbers(config.recoveryConfirmationReturnPcts).sort(
      (left, right) => left - right,
    ),
    recoveryWindowMinutes: uniqueNumbers(config.recoveryWindowMinutes).sort(
      (left, right) => left - right,
    ),
    sourceDecisions: unique(config.sourceDecisions),
    entryTimingModes: unique(config.entryTimingModes),
    profileIds: unique(config.profileIds),
  };
}

function parseLabelDbOption(arg: string): ShadowEntryDbSourceConfig {
  const raw = arg.slice("--label-db=".length).trim();
  const separatorIndex = raw.indexOf(":");

  if (separatorIndex <= 0 || separatorIndex === raw.length - 1) {
    throw new Error("Invalid shadow entries option: --label-db must use <label>:<path>.");
  }

  const label = raw.slice(0, separatorIndex).trim();
  const dbPath = raw.slice(separatorIndex + 1).trim();

  if (!label || !dbPath) {
    throw new Error("Invalid shadow entries option: --label-db must use <label>:<path>.");
  }

  return { label, path: dbPath };
}

function parseProfileList(arg: string, name: string): readonly ShadowEntryProfileId[] {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!raw) {
    throw new Error(`Invalid shadow entries option: ${name} must not be empty.`);
  }

  return raw.split(",").map(parseProfileId);
}

function parseProfileId(value: string): ShadowEntryProfileId {
  const normalized = value.trim().toLowerCase();
  const profileId = PROFILE_ALIASES[normalized];

  if (!profileId) {
    throw new Error(
      "Invalid shadow entries option: profile must be one of P001-P011 or a known profile name.",
    );
  }

  return profileId;
}

function parseEarlyDrawdownModeList(
  arg: string,
  name: string,
): readonly ShadowEntryEarlyDrawdownMode[] {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!raw) {
    throw new Error(`Invalid shadow entries option: ${name} must not be empty.`);
  }

  return raw.split(",").map(parseEarlyDrawdownMode);
}

function parseEarlyDrawdownMode(value: string): ShadowEntryEarlyDrawdownMode {
  const normalized = value.trim().toLowerCase();

  if (
    normalized !== "off" &&
    normalized !== "warn_only" &&
    normalized !== "reject_5" &&
    normalized !== "reject_10" &&
    normalized !== "reject_15" &&
    normalized !== "require_recovery"
  ) {
    throw new Error(
      "Invalid shadow entries option: early drawdown mode must be off, warn_only, reject_5, reject_10, reject_15, or require_recovery.",
    );
  }

  return normalized;
}

function parseTimingModeList(arg: string, name: string): readonly ShadowEntryTimingMode[] {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!raw) {
    throw new Error(`Invalid shadow entries option: ${name} must not be empty.`);
  }

  return raw.split(",").map(parseTimingMode);
}

function parseTimingMode(value: string): ShadowEntryTimingMode {
  const normalized = value.trim().toLowerCase();

  if (normalized !== "decision" && normalized !== "first_entry" && normalized !== "latest_entry") {
    throw new Error(
      "Invalid shadow entries option: entry timing must be decision, first_entry, or latest_entry.",
    );
  }

  return normalized;
}

function parseDecisionListOption(arg: string, name: string): readonly StrategyDecision[] {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!raw) {
    throw new Error(`Invalid shadow entries option: ${name} must not be empty.`);
  }

  return raw.split(",").map((value) => {
    const decision = value.trim();

    if (!strategyDecisionValues.includes(decision as StrategyDecision)) {
      throw new Error(
        `Invalid shadow entries option: ${name} must contain valid StrategyDecision values (${strategyDecisionValues.join(
          ", ",
        )}).`,
      );
    }

    return decision as StrategyDecision;
  });
}

function parseIntegerOption(arg: string, name: string): number {
  const raw = arg.slice(`${name}=`.length);
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || String(parsed) !== raw) {
    throw new Error(`Invalid shadow entries option: ${name} must be an integer.`);
  }

  return parsed;
}

function parseNumberOption(arg: string, name: string): number {
  const raw = arg.slice(`${name}=`.length).trim();
  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || raw === "") {
    throw new Error(`Invalid shadow entries option: ${name} must be a finite number.`);
  }

  return parsed;
}

function parseIntegerListOption(arg: string, name: string): readonly number[] {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!raw) {
    throw new Error(`Invalid shadow entries option: ${name} must not be empty.`);
  }

  return raw.split(",").map((value) => {
    const trimmed = value.trim();
    const parsed = Number.parseInt(trimmed, 10);

    if (!Number.isFinite(parsed) || String(parsed) !== trimmed) {
      throw new Error(
        `Invalid shadow entries option: ${name} must be a comma-separated integer list.`,
      );
    }

    return parsed;
  });
}

function parseNumberListOption(arg: string, name: string): readonly number[] {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!raw) {
    throw new Error(`Invalid shadow entries option: ${name} must not be empty.`);
  }

  return raw.split(",").map((value) => {
    const trimmed = value.trim();
    const parsed = Number(trimmed);

    if (!Number.isFinite(parsed) || trimmed === "") {
      throw new Error(
        `Invalid shadow entries option: ${name} must be a comma-separated number list.`,
      );
    }

    return parsed;
  });
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid shadow entries option: ${name} must be a positive integer.`);
  }
}

function validatePositiveNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid shadow entries option: ${name} must be a positive number.`);
  }
}

function validateFiniteNumber(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid shadow entries option: ${name} must be a finite number.`);
  }
}

function validateScore(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error(`Invalid shadow entries option: ${name} must be an integer from 0 to 100.`);
  }
}

function validateNonEmpty(name: string, value: readonly unknown[]): void {
  if (value.length === 0) {
    throw new Error(`Invalid shadow entries option: ${name} must not be empty.`);
  }
}

function assertUniqueLabels(sources: readonly ShadowEntryDbSourceConfig[]): void {
  const seen = new Set<string>();

  for (const source of sources) {
    if (!source.label.trim()) {
      throw new Error("Invalid shadow entries option: database labels must not be empty.");
    }

    if (!source.path.trim()) {
      throw new Error("Invalid shadow entries option: database paths must not be empty.");
    }

    if (seen.has(source.label)) {
      throw new Error(`Invalid shadow entries option: duplicate database label ${source.label}.`);
    }

    seen.add(source.label);
  }
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)];
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
