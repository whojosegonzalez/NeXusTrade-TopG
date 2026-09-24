import type { ProviderSuccess, TokenMintAddress } from "@nexustrade/shared";

import type { ParsedMintAccountSnapshot } from "./SolanaRpcMintAccountParser.js";

interface CacheEntry {
  readonly result: ProviderSuccess<ParsedMintAccountSnapshot>;
  readonly expiresAtMs: number;
}

export interface SolanaRpcMintAccountCacheOptions {
  readonly ttlMs: number;
}

export class SolanaRpcMintAccountCache {
  private readonly entries = new Map<TokenMintAddress, CacheEntry>();

  constructor(private readonly options: SolanaRpcMintAccountCacheOptions) {}

  get(mintAddress: TokenMintAddress): ProviderSuccess<ParsedMintAccountSnapshot> | undefined {
    const entry = this.entries.get(mintAddress);

    if (!entry) {
      return undefined;
    }

    if (Date.now() > entry.expiresAtMs) {
      this.entries.delete(mintAddress);
      return undefined;
    }

    return entry.result;
  }

  set(mintAddress: TokenMintAddress, result: ProviderSuccess<ParsedMintAccountSnapshot>): void {
    this.entries.set(mintAddress, {
      result,
      expiresAtMs: Date.now() + this.options.ttlMs,
    });
  }
}
