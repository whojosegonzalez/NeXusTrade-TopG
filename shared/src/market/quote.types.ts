import type { ProviderName } from "../providers/provider.types.js";
import type { TokenMintAddress } from "./token.types.js";

export const QUOTE_SIDES = ["BUY", "SELL"] as const;

export type QuoteSide = (typeof QUOTE_SIDES)[number];

export const QUOTE_SOURCE_TYPES = ["LIVE", "CACHE", "NONE"] as const;

export type QuoteSourceType = (typeof QUOTE_SOURCE_TYPES)[number];

export const QUOTE_FALLBACK_REASONS = [
  "NONE",
  "JUPITER_RATE_LIMITED",
  "JUPITER_COOLDOWN",
  "JUPITER_UNAVAILABLE",
  "ROUTER_POLICY",
  "FORCED_PROVIDER",
] as const;

export type QuoteFallbackReason = (typeof QUOTE_FALLBACK_REASONS)[number];

export interface QuoteRequest {
  readonly inputMint: TokenMintAddress;
  readonly outputMint: TokenMintAddress;
  readonly amountRaw: string;
  readonly side?: QuoteSide;
  readonly slippageBps?: number;
  readonly onlyDirectRoutes?: boolean;
  readonly maxAccounts?: number;
}

export interface QuoteRouteHop {
  readonly label?: string;
  readonly inputMint?: TokenMintAddress;
  readonly outputMint?: TokenMintAddress;
  readonly percent?: number;
}

export interface QuoteProvenance {
  readonly quoteProvider?: ProviderName | "NONE";
  readonly quoteSourceType?: QuoteSourceType;
  readonly fallbackReason?: QuoteFallbackReason;
  readonly attemptedProviders?: readonly ProviderName[];
  readonly providerOrder?: readonly ProviderName[];
}

export interface QuoteResult {
  readonly inputMint: TokenMintAddress;
  readonly outputMint: TokenMintAddress;
  readonly inputAmountRaw: string;
  readonly outputAmountRaw: string;
  readonly inputAmountUi?: string;
  readonly outputAmountUi?: string;
  readonly estimatedPriceImpactPct?: number;
  readonly routeSummary?: readonly QuoteRouteHop[];
  readonly minimumOutAmountRaw?: string;
  readonly contextSlot?: number;
  readonly source: ProviderName;
  readonly fetchedAt: Date;
  readonly rawReferenceId?: string;
  readonly provenance?: QuoteProvenance;
}
