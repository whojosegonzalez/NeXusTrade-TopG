interface BirdeyeCacheEntry<T> {
  readonly value: T;
  readonly expiresAtMs: number;
}

export class BirdeyeCache {
  private readonly entries = new Map<string, BirdeyeCacheEntry<unknown>>();

  constructor(private readonly options: { readonly ttlMs: number }) {}

  get<T>(key: string, nowMs = Date.now()): T | undefined {
    const entry = this.entries.get(key);

    if (!entry) {
      return undefined;
    }

    if (entry.expiresAtMs <= nowMs) {
      this.entries.delete(key);
      return undefined;
    }

    return entry.value as T;
  }

  set<T>(key: string, value: T, nowMs = Date.now()): void {
    this.entries.set(key, {
      value,
      expiresAtMs: nowMs + this.options.ttlMs,
    });
  }
}
