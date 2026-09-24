export const QUOTE_PRIORITIES = ["CRITICAL", "HIGH", "NORMAL", "LOW"] as const;

export type QuotePriority = (typeof QUOTE_PRIORITIES)[number];

export const DEFAULT_QUOTE_PRIORITY: QuotePriority = "NORMAL";

export interface QuoteRequestContext {
  readonly priority?: QuotePriority;
  readonly stage?: string;
  readonly sessionId?: string;
  readonly candidateMint?: string;
  readonly reason?: string;
  readonly allowStaleCache?: boolean;
  /** DexScreener venue identifiers already observed during candidate enrichment. */
  readonly raydiumObservedDexIds?: readonly string[];
}

export function normalizeQuotePriority(priority: QuotePriority | undefined): QuotePriority {
  return priority ?? DEFAULT_QUOTE_PRIORITY;
}

export function canSkipDuringCooldown(priority: QuotePriority): boolean {
  return priority === "LOW" || priority === "NORMAL";
}
