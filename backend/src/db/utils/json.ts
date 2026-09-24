const sensitiveKeyPattern = /(api[_-]?key|private[_-]?key|secret|seed|mnemonic|wallet|keypair)/i;

export function stringifyJson(value: unknown): string {
  return JSON.stringify(redactSensitiveFields(value));
}

export function parseJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown JSON parse error";
    throw new Error(`Failed to parse stored JSON: ${message}`);
  }
}

export function redactSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveFields(item));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      sensitiveKeyPattern.test(key) ? "[REDACTED]" : redactSensitiveFields(nestedValue),
    ]),
  );
}
