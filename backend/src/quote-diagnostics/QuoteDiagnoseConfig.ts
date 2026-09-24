import { parseTokenMintAddress, type TokenMintAddress } from "@nexustrade/shared";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const QUOTE_DIAGNOSE_MODES = ["router", "raydium", "preflight", "all"] as const;

export type QuoteDiagnoseMode = (typeof QUOTE_DIAGNOSE_MODES)[number];

export interface QuoteDiagnoseConfig {
  readonly once: boolean;
  readonly inputMint: TokenMintAddress;
  readonly outputMint: TokenMintAddress;
  readonly amountRaw: string;
  readonly slippageBps: number;
  readonly mode: QuoteDiagnoseMode;
  readonly json: boolean;
  readonly roundTrip: boolean;
  readonly outputDir?: string;
}

export function parseQuoteDiagnoseArgs(argv: readonly string[]): QuoteDiagnoseConfig {
  if (argv.includes("--session-id") || argv.some((arg) => arg.startsWith("--session-id="))) {
    throw new Error("quote:diagnose does not accept --session-id.");
  }

  const once = argv.includes("--once");

  if (!once) {
    throw new Error("quote:diagnose requires --once.");
  }

  const inputMint = parseTokenMintAddress(readOption(argv, "input-mint") ?? SOL_MINT);
  const outputMint = parseTokenMintAddress(readOption(argv, "output-mint") ?? USDC_MINT);
  const amountRaw = parseAmountRaw(readOption(argv, "amount-raw") ?? "100000000");
  const slippageBps = parseIntegerRange(readOption(argv, "slippage-bps") ?? "100", {
    name: "slippage-bps",
    min: 0,
    max: 10_000,
  });
  const mode = parseMode(readOption(argv, "mode") ?? "all");
  const outputDir = readOption(argv, "output-dir");

  return {
    once,
    inputMint,
    outputMint,
    amountRaw,
    slippageBps,
    mode,
    json: argv.includes("--json"),
    roundTrip: argv.includes("--round-trip"),
    ...(outputDir ? { outputDir } : {}),
  };
}

function readOption(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function parseMode(value: string): QuoteDiagnoseMode {
  if ((QUOTE_DIAGNOSE_MODES as readonly string[]).includes(value)) {
    return value as QuoteDiagnoseMode;
  }

  throw new Error(`Invalid --mode. Expected one of: ${QUOTE_DIAGNOSE_MODES.join(", ")}.`);
}

function parseAmountRaw(value: string): string {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("--amount-raw must be a positive integer string.");
  }

  return value;
}

function parseIntegerRange(
  value: string,
  options: { readonly name: string; readonly min: number; readonly max: number },
): number {
  const parsed = Number.parseInt(value, 10);

  if (
    !Number.isFinite(parsed) ||
    String(parsed) !== value ||
    parsed < options.min ||
    parsed > options.max
  ) {
    throw new Error(
      `--${options.name} must be an integer from ${options.min} through ${options.max}.`,
    );
  }

  return parsed;
}
