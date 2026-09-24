export interface TimeRangeFilter {
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly limit?: number;
}

export function requireRecord<T>(record: T | undefined, message: string): T {
  if (!record) {
    throw new Error(message);
  }

  return record;
}

export function limitOrDefault(limit: number | undefined, fallback = 100): number {
  if (limit === undefined) {
    return fallback;
  }

  if (!Number.isInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new Error("Query limit must be an integer between 1 and 10000.");
  }

  return limit;
}
