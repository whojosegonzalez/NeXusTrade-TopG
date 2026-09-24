export interface RaydiumPreflightCacheEntry {
  readonly inputMint: string;
  readonly outputMint: string;
  readonly status: "FOUND" | "NO_POOL" | "FAILED";
  readonly poolsFound: number;
  readonly productTypes: readonly string[];
  readonly message?: string;
  readonly createdAtMs: number;
}

export interface RaydiumPreflightCacheOptions {
  readonly ttlMs: number;
  readonly now?: () => number;
}

export class RaydiumPreflightCache {
  private readonly entries = new Map<string, RaydiumPreflightCacheEntry>();
  private readonly now: () => number;

  constructor(private readonly options: RaydiumPreflightCacheOptions) {
    this.now = options.now ?? Date.now;
  }

  get(inputMint: string, outputMint: string): RaydiumPreflightCacheEntry | undefined {
    const key = makePreflightKey(inputMint, outputMint);
    const entry = this.entries.get(key);

    if (!entry) {
      return undefined;
    }

    if (this.now() - entry.createdAtMs > this.options.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }

    return entry;
  }

  set(entry: Omit<RaydiumPreflightCacheEntry, "createdAtMs">): RaydiumPreflightCacheEntry {
    const cacheEntry: RaydiumPreflightCacheEntry = {
      ...entry,
      createdAtMs: this.now(),
    };

    this.entries.set(makePreflightKey(entry.inputMint, entry.outputMint), cacheEntry);

    return cacheEntry;
  }
}

function makePreflightKey(inputMint: string, outputMint: string): string {
  return [inputMint, outputMint].sort().join("|");
}
