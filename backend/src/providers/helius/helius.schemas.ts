import { z } from "zod";

const heliusAuthoritySchema = z
  .object({
    address: z.string().optional(),
    scopes: z.array(z.string()).optional(),
  })
  .passthrough();

const heliusMetadataSchema = z
  .object({
    name: z.string().nullish(),
    symbol: z.string().nullish(),
    description: z.string().nullish(),
  })
  .passthrough();

const heliusContentSchema = z
  .object({
    json_uri: z.string().nullish(),
    metadata: heliusMetadataSchema.optional(),
    links: z
      .object({
        image: z.string().nullish(),
        external_url: z.string().nullish(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const supplyValueSchema = z.union([z.number(), z.string()]);

const heliusTokenInfoSchema = z
  .object({
    supply: supplyValueSchema.optional(),
    decimals: z.number().int().optional(),
    token_program: z.string().optional(),
    mint_authority: z.string().nullish(),
    freeze_authority: z.string().nullish(),
  })
  .passthrough();

export const heliusAssetSchema = z
  .object({
    id: z.string().optional(),
    content: heliusContentSchema.optional(),
    authorities: z.array(heliusAuthoritySchema).optional(),
    token_info: heliusTokenInfoSchema.optional(),
  })
  .passthrough();

export const heliusPriorityFeeResultSchema = z
  .object({
    priorityFeeEstimate: z.number().optional(),
    priorityFeeLevels: z
      .object({
        min: z.number().optional(),
        low: z.number().optional(),
        medium: z.number().optional(),
        high: z.number().optional(),
        veryHigh: z.number().optional(),
        unsafeMax: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const heliusRpcResponseSchema = z
  .object({
    jsonrpc: z.string().optional(),
    id: z.union([z.string(), z.number()]).optional(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number().optional(),
        message: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type HeliusAsset = z.infer<typeof heliusAssetSchema>;
export type HeliusPriorityFeeResult = z.infer<typeof heliusPriorityFeeResultSchema>;
export type HeliusRpcResponse = z.infer<typeof heliusRpcResponseSchema>;
