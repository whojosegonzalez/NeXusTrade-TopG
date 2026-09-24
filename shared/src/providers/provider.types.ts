export const PROVIDER_NAMES = [
  "JUPITER",
  "DEXSCREENER",
  "HELIUS",
  "RAYDIUM",
  "SOLANA_RPC",
  "QUICKNODE_DAS",
  "ALCHEMY_DAS",
  "BIRDEYE",
  "RUGCHECK",
  "MOCK",
] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

export const PROVIDER_CAPABILITIES = [
  "PRICE",
  "QUOTE",
  "TOKEN_METADATA",
  "LIQUIDITY",
  "TOKEN_DISCOVERY",
  "RISK_EVIDENCE",
  "PRIORITY_FEE",
] as const;

export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

export interface ProviderAttribution {
  readonly source: ProviderName;
  readonly fetchedAt: Date;
  readonly rawReferenceId?: string;
}

export function isProviderName(value: string): value is ProviderName {
  return PROVIDER_NAMES.includes(value.toUpperCase() as ProviderName);
}

export function parseProviderName(value: string): ProviderName {
  const normalized = value.trim().toUpperCase();

  if (isProviderName(normalized)) {
    return normalized;
  }

  throw new Error(
    `Invalid provider name "${value}". Expected one of: ${PROVIDER_NAMES.join(", ")}.`,
  );
}
