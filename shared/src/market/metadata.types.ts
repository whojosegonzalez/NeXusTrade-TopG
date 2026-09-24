import type { ProviderName } from "../providers/provider.types.js";
import type { TokenMintAddress, TokenSymbol } from "./token.types.js";

export interface TokenSocialLink {
  readonly platform?: string;
  readonly label?: string;
  readonly url?: string;
  readonly handle?: string;
}

export interface TokenMetadataSnapshot {
  readonly mintAddress: TokenMintAddress;
  readonly symbol?: TokenSymbol;
  readonly name?: string;
  readonly decimals?: number;
  readonly supply?: string;
  readonly tokenProgram?: string;
  readonly mintAuthority?: string | null;
  readonly freezeAuthority?: string | null;
  readonly updateAuthority?: string | null;
  readonly metadataUri?: string;
  readonly imageUri?: string;
  readonly description?: string;
  readonly socialLinks?: readonly TokenSocialLink[];
  readonly source: ProviderName;
  readonly fetchedAt: Date;
}
