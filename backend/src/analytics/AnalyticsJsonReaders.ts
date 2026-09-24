/** Version selects interpretation of legacy JSON; it is never persisted by this reader. */
export const ANALYTICS_LEGACY_READER_VERSION = 0;
export type AnalyticsReadStatus =
  | "OK"
  | "MISSING"
  | "MALFORMED_JSON"
  | "INVALID_FIELDS"
  | "UNSUPPORTED_VERSION";
export interface AnalyticsReadResult<T> {
  readonly status: AnalyticsReadStatus;
  readonly value: T;
}
export interface StrategySnapshot {
  readonly symbol?: string | undefined;
  readonly riskResult?: string | undefined;
  readonly riskFlags: readonly string[];
  readonly blockingFactors: readonly string[];
  readonly liquidityUsd?: string | undefined;
  readonly volume1hUsd?: string | undefined;
  readonly ageSeconds?: number | undefined;
  readonly maxPriceImpactPct?: number | undefined;
}
export interface QuoteBudgetEvidence {
  readonly selected: boolean;
  readonly selectionReason: string;
  readonly rank?: number | undefined;
  readonly candidateSignals: readonly string[];
  readonly buyQuoteObserved: boolean;
}

class Projection {
  invalid = false;
  object(value: unknown): Record<string, unknown> | undefined {
    if (value !== null && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
    if (value !== undefined) this.invalid = true;
    return undefined;
  }
  string(value: unknown): string | undefined {
    if (typeof value === "string" && value.trim() !== "") return value;
    if (value !== undefined) this.invalid = true;
    return undefined;
  }
  number(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value !== undefined) this.invalid = true;
    return undefined;
  }
  strings(value: unknown): readonly string[] {
    if (!Array.isArray(value)) {
      if (value !== undefined) this.invalid = true;
      return [];
    }
    return value.filter((item): item is string => {
      if (typeof item === "string") return true;
      this.invalid = true;
      return false;
    });
  }
}

function decode<T>(
  raw: string | null,
  version: number,
  fallback: T,
  project: (root: Record<string, unknown> | undefined, fields: Projection) => T,
): AnalyticsReadResult<T> {
  if (version !== ANALYTICS_LEGACY_READER_VERSION)
    return { status: "UNSUPPORTED_VERSION", value: fallback };
  if (!raw) return { status: "MISSING", value: fallback };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: "MALFORMED_JSON", value: fallback };
  }
  const fields = new Projection();
  const result = project(fields.object(value), fields);
  return { status: fields.invalid ? "INVALID_FIELDS" : "OK", value: result };
}

export function readStrategyProjection(
  raw: string | null,
  version = ANALYTICS_LEGACY_READER_VERSION,
): AnalyticsReadResult<StrategySnapshot> {
  return decode<StrategySnapshot>(
    raw,
    version,
    { riskFlags: [], blockingFactors: [] },
    (root, p) => {
      const radar = p.object(root?.tokenRadar),
        risk = p.object(root?.riskAssessment),
        score = p.object(root?.strategyScore),
        facts = p.object(score?.facts);
      const blockingFactors: string[] = [];
      if (Array.isArray(score?.factors)) {
        for (const value of score.factors) {
          const factor = p.object(value);
          if (factor?.passed === false)
            blockingFactors.push(p.string(factor.name) ?? p.string(factor.rule) ?? "unknown_rule");
        }
      } else if (score?.factors !== undefined) p.invalid = true;
      return {
        symbol: p.string(radar?.symbol),
        riskResult: p.string(risk?.result),
        riskFlags: p.strings(risk?.riskFlags),
        blockingFactors,
        liquidityUsd: p.string(radar?.liquidityUsd),
        volume1hUsd: p.string(radar?.volume1hUsd),
        ageSeconds: p.number(radar?.ageSeconds),
        maxPriceImpactPct: p.number(facts?.maxPriceImpactPct),
      };
    },
  );
}

/** Legacy service adapter; missing/invalid optional fields keep their prior fallback behavior. */
export function readStrategySnapshot(decision: {
  readonly inputSnapshotJson: string | null;
}): StrategySnapshot {
  return readStrategyProjection(decision.inputSnapshotJson).value;
}

export function readQuoteBudgetProjection(
  raw: string | null,
  version = ANALYTICS_LEGACY_READER_VERSION,
): AnalyticsReadResult<QuoteBudgetEvidence | undefined> {
  return decode<QuoteBudgetEvidence | undefined>(raw, version, undefined, (root, p) => {
    const budget = p.object(root?.quoteBudget),
      enrichment = p.object(root?.enrichment);
    const selected = budget?.selected,
      selectionReason = p.string(budget?.selectionReason);
    if (typeof selected !== "boolean" || !selectionReason) {
      p.invalid = true;
      return undefined;
    }
    return {
      selected,
      selectionReason,
      rank: p.number(budget?.rank),
      candidateSignals: p.strings(budget?.candidateSignals),
      buyQuoteObserved: p.object(enrichment?.buyQuote) !== undefined,
    };
  });
}
