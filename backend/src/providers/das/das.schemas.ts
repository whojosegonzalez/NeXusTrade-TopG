import { z } from "zod";

const dasMetadataSchema = z
  .object({
    name: z.string().nullish(),
    symbol: z.string().nullish(),
    description: z.string().nullish(),
  })
  .passthrough();

const dasContentSchema = z
  .object({
    json_uri: z.string().nullish(),
    metadata: dasMetadataSchema.optional(),
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

const dasTokenInfoSchema = z
  .object({
    supply: supplyValueSchema.optional(),
    decimals: z.number().int().optional(),
    token_program: z.string().optional(),
    mint_authority: z.string().nullish(),
    freeze_authority: z.string().nullish(),
  })
  .passthrough();

const dasAuthoritySchema = z
  .object({
    address: z.string().optional(),
    scopes: z.array(z.string()).optional(),
  })
  .passthrough();

export const dasAssetSchema = z
  .object({
    id: z.string().optional(),
    content: dasContentSchema.optional(),
    authorities: z.array(dasAuthoritySchema).optional(),
    token_info: dasTokenInfoSchema.optional(),
  })
  .passthrough();

export const dasRpcResponseSchema = z
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

export type DasAsset = z.infer<typeof dasAssetSchema>;
export type DasRpcResponse = z.infer<typeof dasRpcResponseSchema>;
