import { createHash } from "node:crypto";
import { z } from "zod";
import type { PaperExecutionCandidate } from "./PaperExecutionCandidateSelector.js";
import type { PaperExchangeRuntimeConfig } from "./PaperExchangeConfig.js";
import type { PaperSellCandidate } from "./PaperSellCandidateSelector.js";
import type { PaperSellRuntimeConfig } from "./PaperSellConfig.js";

const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value);
const safeAmount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const quantity = z
  .string()
  .max(128)
  .regex(/^\d+(?:\.\d{1,18})?$/)
  .refine((value) => /[1-9]/.test(value))
  .transform((value) => {
    const [whole = "0", fractional = ""] = value.split(".");
    const integer = whole.replace(/^0+(?=\d)/, "");
    const fraction = fractional.replace(/0+$/, "");
    return fraction ? `${integer}.${fraction}` : integer;
  });
const common = {
  version: z.literal(1),
  mode: z.literal("PAPER"),
  sessionId: id,
  sourceId: id,
  mint: id,
  explicitIntentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/),
  baseFeeLamports: safeAmount,
  priorityFeeLamports: safeAmount,
  slippageBps: z.number().int().min(0).max(10_000),
  quoteSource: id,
};
const intentSchema = z.discriminatedUnion("side", [
  z
    .object({
      ...common,
      side: z.literal("BUY"),
      radarId: id,
      requestedLamports: safeAmount.positive(),
    })
    .strict(),
  z
    .object({
      ...common,
      side: z.literal("SELL"),
      tokens: quantity,
      allowCachedRadarPrice: z.boolean(),
      maxCachedPriceAgeMs: z.number().int().min(1_000).max(86_400_000),
      trigger: z.discriminatedUnion("type", [
        z.object({ type: z.literal("SELL_ALL") }).strict(),
        z.object({ type: z.literal("MINT"), mintAddress: id }).strict(),
      ]),
      exitContext: z
        .object({
          source: z.literal("EXIT_MANAGER"),
          trigger: z.enum(["TARGET_REACHED", "MAX_DRAWDOWN"]),
          action: z.literal("sell-all"),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);

export type PaperOperationIntent = z.input<typeof intentSchema>;
export interface PaperOperationIdentity {
  readonly id: string;
  readonly version: 1;
  readonly sessionId: string;
  readonly side: "BUY" | "SELL";
  readonly sourceId: string;
  readonly mint: string;
  readonly intentDigest: string;
  readonly intentJson: string;
}

/** Accept unknown persisted/caller input only through the versioned strict contract. */
export function identifyPaperOperation(input: unknown): PaperOperationIdentity {
  const parsed = intentSchema.safeParse(input);
  if (!parsed.success) throw new Error("PAPER_OPERATION_INVALID_INTENT");
  const intent = parsed.data;
  if (
    intent.side === "SELL" &&
    intent.trigger.type === "MINT" &&
    intent.trigger.mintAddress !== intent.mint
  )
    throw new Error("PAPER_OPERATION_INVALID_INTENT");
  const key = canonical({
    version: 1,
    mode: "PAPER",
    sessionId: intent.sessionId,
    side: intent.side,
    sourceId: intent.sourceId,
    explicitIntentId: intent.explicitIntentId,
  });
  const intentJson = canonical(intent);
  return Object.freeze({
    id: `paperop_${sha256(key)}`,
    version: 1,
    sessionId: intent.sessionId,
    side: intent.side,
    sourceId: intent.sourceId,
    mint: intent.mint,
    intentDigest: sha256(intentJson),
    intentJson,
  });
}

export function identifyPaperBuy(
  candidate: PaperExecutionCandidate,
  config: PaperExchangeRuntimeConfig,
  explicitIntentId = "initial",
): PaperOperationIdentity {
  if (
    candidate.strategyDecision.sessionId !== candidate.tokenRadar.sessionId ||
    candidate.strategyDecision.mintAddress !== candidate.tokenRadar.mintAddress
  )
    throw new Error("PAPER_OPERATION_INVALID_INTENT");
  return identifyPaperOperation({
    version: 1,
    mode: "PAPER",
    side: "BUY",
    sessionId: candidate.tokenRadar.sessionId,
    sourceId: candidate.strategyDecision.id,
    mint: candidate.tokenRadar.mintAddress,
    radarId: candidate.tokenRadar.id,
    explicitIntentId,
    requestedLamports: config.buySolLamports,
    baseFeeLamports: config.baseFeeLamports,
    priorityFeeLamports: config.priorityFeeLamports,
    slippageBps: config.slippageBps,
    quoteSource: config.quoteSource,
  });
}

export function identifyPaperSell(
  candidate: PaperSellCandidate,
  config: PaperSellRuntimeConfig,
  explicitIntentId = "initial",
): PaperOperationIdentity {
  if (
    candidate.session.id !== candidate.position.sessionId ||
    (candidate.tokenRadar &&
      (candidate.tokenRadar.sessionId !== candidate.session.id ||
        candidate.tokenRadar.mintAddress !== candidate.position.mintAddress))
  )
    throw new Error("PAPER_OPERATION_INVALID_INTENT");
  return identifyPaperOperation({
    version: 1,
    mode: "PAPER",
    side: "SELL",
    sessionId: candidate.session.id,
    sourceId: candidate.position.id,
    mint: candidate.position.mintAddress,
    explicitIntentId,
    tokens: candidate.position.tokensHeld,
    baseFeeLamports: config.baseFeeLamports,
    priorityFeeLamports: config.priorityFeeLamports,
    slippageBps: config.slippageBps,
    quoteSource: config.quoteSource,
    allowCachedRadarPrice: config.allowCachedRadarPrice,
    maxCachedPriceAgeMs: config.maxCachedPriceAgeMs,
    trigger: config.trigger,
    ...(config.exitContext ? { exitContext: config.exitContext } : {}),
  });
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`)
    .join(",")}}`;
}
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
