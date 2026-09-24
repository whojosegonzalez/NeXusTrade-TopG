export const LAMPORTS_PER_SOL = 1_000_000_000;
const LAMPORTS_PER_SOL_BIGINT = BigInt(LAMPORTS_PER_SOL);
const MAX_DECIMAL_PLACES = 18;

export interface DecimalParts {
  readonly integer: bigint;
  readonly scale: number;
}

export function parseSolToLamports(raw: string): number {
  const parts = parsePositiveDecimalParts(raw);

  if (!parts) {
    throw new Error("Invalid paper exchange option: buySol must be a positive decimal.");
  }

  const lamports =
    parts.scale >= 9
      ? parts.integer / pow10(parts.scale - 9)
      : parts.integer * pow10(9 - parts.scale);

  if (lamports <= 0n || lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Invalid paper exchange option: buySol is outside the supported range.");
  }

  return Number(lamports);
}

export function formatLamportsAsSol(lamports: number): string {
  return divideToDecimal(BigInt(lamports), LAMPORTS_PER_SOL_BIGINT, 9);
}

export function calculateSlippageLamports(lamports: number, slippageBps: number): number {
  if (
    !Number.isSafeInteger(lamports) ||
    lamports < 0 ||
    !Number.isSafeInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps > 10_000
  )
    throw new Error("ACCOUNTING_INVALID_AMOUNT");
  return Number((BigInt(lamports) * BigInt(slippageBps) + 9_999n) / 10_000n);
}

export function calculateTokensFilled(
  requestedSolLamports: number,
  priceSol: string,
): string | undefined {
  const priceParts = parsePositiveDecimalParts(priceSol);

  if (!priceParts) {
    return undefined;
  }

  const numerator = BigInt(requestedSolLamports) * pow10(priceParts.scale);
  const denominator = LAMPORTS_PER_SOL_BIGINT * priceParts.integer;

  return divideToDecimal(numerator, denominator, 12);
}

export function calculateGrossProceedsLamports(
  tokensHeld: string,
  priceSol: string,
): number | undefined {
  const tokenParts = parsePositiveDecimalParts(tokensHeld);
  const priceParts = parsePositiveDecimalParts(priceSol);

  if (!tokenParts || !priceParts) {
    return undefined;
  }

  const numerator = tokenParts.integer * priceParts.integer * LAMPORTS_PER_SOL_BIGINT;
  const denominator = pow10(tokenParts.scale + priceParts.scale);
  const lamports = numerator / denominator;

  if (lamports <= 0n || lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }

  return Number(lamports);
}

export function calculatePriceSolFromProceeds(
  proceedsLamports: number,
  tokensHeld: string,
): string | undefined {
  const tokenParts = parsePositiveDecimalParts(tokensHeld);

  if (!tokenParts || proceedsLamports <= 0) {
    return undefined;
  }

  const numerator = BigInt(proceedsLamports) * pow10(tokenParts.scale);
  const denominator = LAMPORTS_PER_SOL_BIGINT * tokenParts.integer;

  return divideToDecimal(numerator, denominator, 12);
}

export function parseTokenAmountToAtomic(tokensHeld: string, decimals: number): string | undefined {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    return undefined;
  }

  const tokenParts = parsePositiveDecimalParts(tokensHeld);

  if (!tokenParts || tokenParts.scale > decimals) {
    return undefined;
  }

  return (tokenParts.integer * pow10(decimals - tokenParts.scale)).toString();
}

export function isPositiveDecimal(raw: string | null | undefined): raw is string {
  return parsePositiveDecimalParts(raw) !== undefined;
}

function parsePositiveDecimalParts(raw: string | null | undefined): DecimalParts | undefined {
  const value = raw?.trim();

  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) {
    return undefined;
  }

  const [integerPart, fractionalPart = ""] = value.split(".");

  if (fractionalPart.length > MAX_DECIMAL_PLACES) {
    return undefined;
  }

  const normalizedDigits = `${integerPart}${fractionalPart}`.replace(/^0+/, "") || "0";
  const integer = BigInt(normalizedDigits);

  if (integer <= 0n) {
    return undefined;
  }

  return {
    integer,
    scale: fractionalPart.length,
  };
}

function divideToDecimal(numerator: bigint, denominator: bigint, fractionalDigits: number): string {
  const whole = numerator / denominator;
  let remainder = numerator % denominator;

  if (remainder === 0n) {
    return whole.toString();
  }

  let fraction = "";

  for (let index = 0; index < fractionalDigits && remainder > 0n; index += 1) {
    remainder *= 10n;
    fraction += (remainder / denominator).toString();
    remainder %= denominator;
  }

  const trimmedFraction = fraction.replace(/0+$/, "");

  return trimmedFraction.length > 0 ? `${whole}.${trimmedFraction}` : whole.toString();
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}
