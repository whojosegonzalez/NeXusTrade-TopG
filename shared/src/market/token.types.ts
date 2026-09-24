export const CHAIN_IDS = ["solana"] as const;

export type ChainId = (typeof CHAIN_IDS)[number];

declare const tokenMintAddressBrand: unique symbol;

export type TokenMintAddress = string & {
  readonly [tokenMintAddressBrand]: "TokenMintAddress";
};

export type TokenSymbol = string;

export interface TokenIdentity {
  readonly chainId: ChainId;
  readonly mintAddress: TokenMintAddress;
  readonly symbol?: TokenSymbol;
  readonly name?: string;
  readonly decimals?: number;
  readonly logoUri?: string;
  readonly tokenProgram?: string;
}

const SOLANA_BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isChainId(value: string): value is ChainId {
  return CHAIN_IDS.includes(value as ChainId);
}

export function isSolanaMintAddress(value: string): value is TokenMintAddress {
  return SOLANA_BASE58_PATTERN.test(value);
}

export function parseTokenMintAddress(value: string): TokenMintAddress {
  const normalized = value.trim();

  if (!isSolanaMintAddress(normalized)) {
    throw new Error(`Invalid Solana mint address: "${value}".`);
  }

  return normalized;
}
