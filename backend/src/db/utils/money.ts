export const LAMPORTS_PER_SOL = 1_000_000_000;

export function solToLamports(sol: string): number {
  if (!/^\d+(\.\d{1,9})?$/.test(sol)) {
    throw new Error(`Invalid SOL amount "${sol}". Use a non-negative decimal with up to 9 places.`);
  }

  const parts = sol.split(".");
  const wholePart = parts[0] ?? "0";
  const fractionalPart = parts[1] ?? "";
  const wholeLamports = BigInt(wholePart) * BigInt(LAMPORTS_PER_SOL);
  const fractionalLamports = BigInt(fractionalPart.padEnd(9, "0"));
  const lamports = wholeLamports + fractionalLamports;

  if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Lamports value exceeds JavaScript safe integer range.");
  }

  return Number(lamports);
}

export function lamportsToSolString(lamports: number): string {
  assertNonNegativeInteger(lamports, "lamports");

  const whole = Math.floor(lamports / LAMPORTS_PER_SOL);
  const fractional = String(lamports % LAMPORTS_PER_SOL)
    .padStart(9, "0")
    .replace(/0+$/, "");

  return fractional.length === 0 ? `${whole}` : `${whole}.${fractional}`;
}

export function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}
