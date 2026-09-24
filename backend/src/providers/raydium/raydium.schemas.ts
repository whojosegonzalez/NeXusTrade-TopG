import { z } from "zod";

export const raydiumRoutePlanHopSchema = z
  .object({
    poolId: z.string().optional(),
    inputMint: z.string().optional(),
    outputMint: z.string().optional(),
    feeMint: z.string().optional(),
    feeRate: z.number().optional(),
    feeAmount: z.string().optional(),
  })
  .passthrough();

export const raydiumQuoteDataSchema = z
  .object({
    swapType: z.string().optional(),
    inputMint: z.string(),
    inputAmount: z.string(),
    outputMint: z.string(),
    outputAmount: z.string(),
    otherAmountThreshold: z.string().optional(),
    slippageBps: z.number().optional(),
    priceImpactPct: z.union([z.number(), z.string()]).optional(),
    routePlan: z.array(raydiumRoutePlanHopSchema).optional(),
  })
  .passthrough();

export const raydiumQuoteEnvelopeSchema = z
  .object({
    id: z.string().optional(),
    success: z.boolean(),
    msg: z.string().optional(),
    version: z.string().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

export const raydiumQuoteSuccessResponseSchema = z
  .object({
    id: z.string().optional(),
    success: z.literal(true),
    version: z.string().optional(),
    data: raydiumQuoteDataSchema,
  })
  .passthrough();

export type RaydiumQuoteData = z.infer<typeof raydiumQuoteDataSchema>;
export type RaydiumQuoteSuccessResponse = z.infer<typeof raydiumQuoteSuccessResponseSchema>;
