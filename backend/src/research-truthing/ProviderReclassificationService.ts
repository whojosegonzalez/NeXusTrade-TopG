import type { ProviderHealthRecord } from "../db/schema/index.js";
import { parseJson } from "../db/utils/json.js";
import type { ShadowCalibrationRawRun } from "../shadow-calibration/ShadowCalibrationTypes.js";
import type {
  ResearchTruthingProviderReclassification,
  ResearchTruthingProviderRowClass,
} from "./ResearchTruthingTypes.js";

const PROVIDER_CLASSES: readonly ResearchTruthingProviderRowClass[] = [
  "LIVE_OK",
  "LIVE_RATE_LIMITED",
  "LIVE_PROVIDER_FAILURE",
  "ROUTER_CACHE_HIT",
  "ROUTER_COOLDOWN_SKIP",
  "POLICY_BUDGET_SKIP",
  "POLICY_DISABLED",
  "DIAGNOSTIC_ONLY",
  "UNKNOWN_OR_UNCLASSIFIED",
];

export class ProviderReclassificationService {
  summarize(
    runs: readonly ShadowCalibrationRawRun[],
  ): readonly ResearchTruthingProviderReclassification[] {
    const byProvider = new Map<string, ProviderHealthRecord[]>();

    for (const row of runs.flatMap((run) => run.providerHealth)) {
      byProvider.set(row.provider, [...(byProvider.get(row.provider) ?? []), row]);
    }

    return [...byProvider.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([provider, rows]) => summarizeProvider(provider, rows));
  }
}

function summarizeProvider(
  provider: string,
  rows: readonly ProviderHealthRecord[],
): ResearchTruthingProviderReclassification {
  const classes = createEmptyClassCounts();
  const statusCounts: Record<string, number> = {};
  const failureCounts: Record<string, number> = {};
  const diagnosticCounts: Record<string, number> = {};

  for (const row of rows) {
    const context = readContext(row);
    const classification = classifyRow(row, context);

    classes[classification] += 1;
    increment(statusCounts, row.status);
    increment(failureCounts, readFailureKey(context, row.errorMessage));
    increment(diagnosticCounts, readDiagnosticKey(context));
  }

  return {
    provider,
    total: rows.length,
    classes,
    statusCounts,
    failureCounts,
    diagnosticCounts,
  };
}

export function classifyProviderHealthForTruthing(
  row: ProviderHealthRecord,
): ResearchTruthingProviderRowClass {
  return classifyRow(row, readContext(row));
}

function classifyRow(
  row: ProviderHealthRecord,
  context: Readonly<Record<string, unknown>>,
): ResearchTruthingProviderRowClass {
  const quoteSource = readString(context.quoteSource);
  const heliusEvidenceSource = readString(context.heliusEvidenceSource);
  const rpcCacheStatus = readString(context.rpcCacheStatus);
  const birdeyeCacheStatus = readString(context.birdeyeCacheStatus);
  const birdeyeFailure = readString(context.birdeyeFailureCategory);
  const operation = readString(context.operation);

  if (row.status === "DISABLED") {
    return "POLICY_DISABLED";
  }

  if (birdeyeFailure === "BIRDEYE_CU_BUDGET_EXHAUSTED" || context.birdeyeBudgetReason) {
    return "POLICY_BUDGET_SKIP";
  }

  if (
    quoteSource === "CACHE" ||
    heliusEvidenceSource === "CACHE" ||
    rpcCacheStatus === "HIT" ||
    birdeyeCacheStatus === "HIT"
  ) {
    return "ROUTER_CACHE_HIT";
  }

  if (quoteSource === "SKIPPED_COOLDOWN" || heliusEvidenceSource === "SKIPPED_COOLDOWN") {
    return "ROUTER_COOLDOWN_SKIP";
  }

  if (
    operation === "pool-preflight" ||
    operation === "mint-price" ||
    context.raydiumPreflightStatus ||
    context.raydiumMintPriceAvailable
  ) {
    return "DIAGNOSTIC_ONLY";
  }

  if (row.status === "OK" || row.status === "DEGRADED") {
    return "LIVE_OK";
  }

  if (row.status === "RATE_LIMITED" || row.rateLimited) {
    return "LIVE_RATE_LIMITED";
  }

  if (row.status === "ERROR") {
    return "LIVE_PROVIDER_FAILURE";
  }

  return "UNKNOWN_OR_UNCLASSIFIED";
}

function readFailureKey(
  context: Readonly<Record<string, unknown>>,
  errorMessage: string | null,
): string | undefined {
  return (
    readString(context.errorCode) ??
    readString(context.raydiumFailureCategory) ??
    readString(context.birdeyeFailureCategory) ??
    readString(context.rpcFailureCategory) ??
    readString(context.dasFailureCategory) ??
    (errorMessage ? "ERROR_MESSAGE_PRESENT" : undefined)
  );
}

function readDiagnosticKey(context: Readonly<Record<string, unknown>>): string | undefined {
  return (
    readString(context.raydiumPreflightStatus) ??
    readString(context.raydiumFailureCategory) ??
    readString(context.birdeyeEndpoint) ??
    readString(context.authorityEvidenceSource) ??
    readString(context.dasProvider)
  );
}

function readContext(row: ProviderHealthRecord): Readonly<Record<string, unknown>> {
  if (!row.contextJson) {
    return {};
  }

  try {
    const parsed = parseJson<unknown>(row.contextJson);

    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function createEmptyClassCounts(): Record<ResearchTruthingProviderRowClass, number> {
  return Object.fromEntries(
    PROVIDER_CLASSES.map((classification) => [classification, 0]),
  ) as Record<ResearchTruthingProviderRowClass, number>;
}

function increment(counts: Record<string, number>, key: string | undefined): void {
  if (!key) {
    return;
  }

  counts[key] = (counts[key] ?? 0) + 1;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
