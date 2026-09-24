export function nowMs(): number {
  return Date.now();
}

export function toDate(timestampMs: number): Date {
  return new Date(timestampMs);
}

export function toIsoString(timestampMs: number): string {
  return toDate(timestampMs).toISOString();
}
