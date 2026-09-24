import type { ProviderSuccess } from "@nexustrade/shared";

import type { HeliusAsset } from "./helius.schemas.js";

export interface HeliusEvidenceCacheOptions {
  readonly metadataTtlMs: number;
  readonly riskEvidenceTtlMs: number;
  readonly now?: () => number;
}

export type HeliusEvidenceCacheKind = "TOKEN_METADATA" | "RISK_EVIDENCE";

interface CacheEntry {
  readonly result: ProviderSuccess<HeliusAsset>;
  readonly createdAtMs: number;
}

export class HeliusEvidenceCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly now: () => number;

  constructor(private readonly options: HeliusEvidenceCacheOptions) {
    this.now = options.now ?? Date.now;
  }

  get(
    kind: HeliusEvidenceCacheKind,
    mintAddress: string,
  ): ProviderSuccess<HeliusAsset> | undefined {
    const key = makeCacheKey(kind, mintAddress);
    const entry = this.entries.get(key);

    if (!entry) {
      return undefined;
    }

    if (this.now() - entry.createdAtMs > this.ttlFor(kind)) {
      this.entries.delete(key);
      return undefined;
    }

    return entry.result;
  }

  set(
    kind: HeliusEvidenceCacheKind,
    mintAddress: string,
    result: ProviderSuccess<HeliusAsset>,
  ): void {
    this.entries.set(makeCacheKey(kind, mintAddress), {
      result,
      createdAtMs: this.now(),
    });
  }

  private ttlFor(kind: HeliusEvidenceCacheKind): number {
    return kind === "TOKEN_METADATA" ? this.options.metadataTtlMs : this.options.riskEvidenceTtlMs;
  }
}

function makeCacheKey(kind: HeliusEvidenceCacheKind, mintAddress: string): string {
  return `${kind}:${mintAddress}`;
}
