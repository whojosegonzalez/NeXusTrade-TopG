import { z } from "zod";

export const jupiterPriceEntrySchema = z
  .object({
    createdAt: z.string().optional(),
    liquidity: z.number().optional(),
    usdPrice: z.number().optional(),
    blockId: z.number().int().optional(),
    decimals: z.number().int().optional(),
    priceChange24h: z.number().optional(),
  })
  .passthrough();

export const jupiterPriceResponseSchema = z.record(jupiterPriceEntrySchema);

const jupiterSwapInfoSchema = z
  .object({
    ammKey: z.string().optional(),
    label: z.string().optional(),
    inputMint: z.string().optional(),
    outputMint: z.string().optional(),
    inAmount: z.string().optional(),
    outAmount: z.string().optional(),
  })
  .passthrough();

export const jupiterQuoteResponseSchema = z
  .object({
    inputMint: z.string(),
    outputMint: z.string(),
    inAmount: z.string(),
    outAmount: z.string(),
    otherAmountThreshold: z.string().optional(),
    swapMode: z.string().optional(),
    slippageBps: z.number().optional(),
    priceImpactPct: z.string().optional(),
    routePlan: z
      .array(
        z
          .object({
            swapInfo: jupiterSwapInfoSchema.optional(),
            percent: z.number().optional(),
            bps: z.number().nullish(),
          })
          .passthrough(),
      )
      .optional(),
    contextSlot: z.number().int().optional(),
    timeTaken: z.number().optional(),
  })
  .passthrough();

export type JupiterPriceEntry = z.infer<typeof jupiterPriceEntrySchema>;
export type JupiterPriceResponse = z.infer<typeof jupiterPriceResponseSchema>;
export type JupiterQuoteResponse = z.infer<typeof jupiterQuoteResponseSchema>;
