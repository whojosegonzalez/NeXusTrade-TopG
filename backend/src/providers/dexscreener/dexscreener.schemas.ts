import { z } from "zod";

const dexTokenSchema = z
  .object({
    address: z.string().nullish(),
    name: z.string().nullish(),
    symbol: z.string().nullish(),
  })
  .passthrough();

const dexTxnSchema = z
  .object({
    buys: z.number().int().optional(),
    sells: z.number().int().optional(),
  })
  .passthrough();

export const dexScreenerPairSchema = z
  .object({
    chainId: z.string().optional(),
    dexId: z.string().optional(),
    url: z.string().optional(),
    pairAddress: z.string().optional(),
    baseToken: dexTokenSchema.optional(),
    quoteToken: dexTokenSchema.optional(),
    priceNative: z.string().nullish(),
    priceUsd: z.string().nullish(),
    txns: z
      .object({
        m5: dexTxnSchema.optional(),
        h1: dexTxnSchema.optional(),
        h6: dexTxnSchema.optional(),
        h24: dexTxnSchema.optional(),
      })
      .passthrough()
      .optional(),
    volume: z
      .object({
        m5: z.number().optional(),
        h1: z.number().optional(),
        h6: z.number().optional(),
        h24: z.number().optional(),
      })
      .passthrough()
      .optional(),
    liquidity: z
      .object({
        usd: z.number().nullish(),
        base: z.number().optional(),
        quote: z.number().optional(),
      })
      .nullish(),
    fdv: z.number().nullish(),
    marketCap: z.number().nullish(),
    pairCreatedAt: z.number().int().nullish(),
  })
  .passthrough();

export const dexScreenerPairListSchema = z.array(dexScreenerPairSchema);

export const dexScreenerWrappedPairsSchema = z
  .object({
    schemaVersion: z.string().optional(),
    pairs: dexScreenerPairListSchema.nullish(),
  })
  .passthrough();

export const dexScreenerTokenProfileSchema = z
  .object({
    chainId: z.string().optional(),
    tokenAddress: z.string().optional(),
    icon: z.string().optional(),
    description: z.string().nullish(),
  })
  .passthrough();

export const dexScreenerTokenProfileListSchema = z.union([
  z.array(dexScreenerTokenProfileSchema),
  z
    .object({
      data: z.array(dexScreenerTokenProfileSchema).optional(),
    })
    .passthrough(),
  dexScreenerTokenProfileSchema,
]);

export type DexScreenerPair = z.infer<typeof dexScreenerPairSchema>;
export type DexScreenerTokenProfile = z.infer<typeof dexScreenerTokenProfileSchema>;
