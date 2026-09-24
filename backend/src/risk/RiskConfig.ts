import { solToLamports } from "../db/utils/money.js";
import type { TokenRadarStatus } from "../db/schema/index.js";

export const RISK_DEFAULTS = {
  statuses: ["DISCOVERED", "WATCHING"] as const,
  sinceHours: 24,
  limit: 50,
  concurrency: 3,
  probeAmountSol: "0.01",
} as const;

export const RISK_BOUNDS = {
  sinceHours: {
    min: 1,
    max: 24 * 30,
  },
  limit: {
    min: 1,
    max: 500,
  },
  concurrency: {
    min: 1,
    max: 10,
  },
} as const;

export const RISK_EVALUATABLE_STATUSES = ["DISCOVERED", "WATCHING"] as const;

export type RiskEvaluatableStatus = (typeof RISK_EVALUATABLE_STATUSES)[number];

export interface RiskRuntimeConfig {
  readonly statuses: readonly RiskEvaluatableStatus[];
  readonly sinceHours: number;
  readonly limit: number;
  readonly concurrency: number;
  readonly probeAmountSol: string;
  readonly probeAmountLamports: number;
  readonly once: boolean;
  readonly dryRun: boolean;
  readonly sessionId?: string;
}

type MutableRiskConfigDraft = {
  -readonly [Key in keyof Omit<RiskRuntimeConfig, "probeAmountLamports">]?: Omit<
    RiskRuntimeConfig,
    "probeAmountLamports"
  >[Key];
};

export function defaultRiskConfig(): RiskRuntimeConfig {
  return {
    statuses: RISK_DEFAULTS.statuses,
    sinceHours: RISK_DEFAULTS.sinceHours,
    limit: RISK_DEFAULTS.limit,
    concurrency: RISK_DEFAULTS.concurrency,
    probeAmountSol: RISK_DEFAULTS.probeAmountSol,
    probeAmountLamports: solToLamports(RISK_DEFAULTS.probeAmountSol),
    once: false,
    dryRun: false,
  };
}

export function parseRiskArgs(argv: readonly string[]): RiskRuntimeConfig {
  const parsed: MutableRiskConfigDraft = {};

  for (const arg of argv) {
    if (arg === "--once") {
      parsed.once = true;
      continue;
    }

    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (arg.startsWith("--session-id=")) {
      const sessionId = arg.slice("--session-id=".length).trim();

      if (!sessionId) {
        throw new Error("Invalid risk option: --session-id must not be empty.");
      }

      parsed.sessionId = sessionId;
      continue;
    }

    if (arg.startsWith("--status=")) {
      parsed.statuses = parseStatusList(arg.slice("--status=".length));
      continue;
    }

    if (arg.startsWith("--since-hours=")) {
      parsed.sinceHours = parseIntegerOption(arg, "--since-hours");
      continue;
    }

    if (arg.startsWith("--limit=")) {
      parsed.limit = parseIntegerOption(arg, "--limit");
      continue;
    }

    if (arg.startsWith("--concurrency=")) {
      parsed.concurrency = parseIntegerOption(arg, "--concurrency");
      continue;
    }

    if (arg.startsWith("--probe-sol=")) {
      parsed.probeAmountSol = arg.slice("--probe-sol=".length).trim();
      continue;
    }

    throw new Error(`Unknown risk option: ${arg}`);
  }

  return validateRiskConfig({
    ...defaultRiskConfig(),
    ...parsed,
  });
}

export function validateRiskConfig(config: RiskRuntimeConfig): RiskRuntimeConfig {
  validateIntegerRange("sinceHours", config.sinceHours, RISK_BOUNDS.sinceHours);
  validateIntegerRange("limit", config.limit, RISK_BOUNDS.limit);
  validateIntegerRange("concurrency", config.concurrency, RISK_BOUNDS.concurrency);

  const probeAmountLamports = solToLamports(config.probeAmountSol);

  if (probeAmountLamports <= 0) {
    throw new Error("Invalid risk option: probeAmountSol must be greater than zero.");
  }

  if (config.statuses.length === 0) {
    throw new Error("Invalid risk option: at least one status is required.");
  }

  return {
    ...config,
    probeAmountLamports,
  };
}

function parseStatusList(raw: string): readonly RiskEvaluatableStatus[] {
  const statuses = raw
    .split(",")
    .map((status) => status.trim())
    .filter((status) => status.length > 0);

  if (statuses.length === 0) {
    throw new Error("Invalid risk option: --status must include at least one status.");
  }

  for (const status of statuses) {
    if (!isRiskEvaluatableStatus(status)) {
      throw new Error(
        `Invalid risk option: status must be one of ${RISK_EVALUATABLE_STATUSES.join(", ")}.`,
      );
    }
  }

  return [...new Set(statuses)] as RiskEvaluatableStatus[];
}

function isRiskEvaluatableStatus(status: string): status is RiskEvaluatableStatus {
  return RISK_EVALUATABLE_STATUSES.includes(status as RiskEvaluatableStatus);
}

function parseIntegerOption(arg: string, name: string): number {
  const raw = arg.slice(`${name}=`.length);
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || String(parsed) !== raw) {
    throw new Error(`Invalid risk option: ${name} must be an integer.`);
  }

  return parsed;
}

function validateIntegerRange(
  name: string,
  value: number,
  bounds: { readonly min: number; readonly max: number },
): void {
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(
      `Invalid risk option: ${name} must be an integer between ${bounds.min} and ${bounds.max}.`,
    );
  }
}

export function isRiskEvaluatableTokenRadarStatus(
  status: TokenRadarStatus,
): status is RiskEvaluatableStatus {
  return isRiskEvaluatableStatus(status);
}
