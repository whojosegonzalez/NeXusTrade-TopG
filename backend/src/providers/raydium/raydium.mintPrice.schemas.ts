import { z } from "zod";

export const raydiumMintPriceResponseSchema = z
  .object({
    id: z.string().optional(),
    success: z.boolean().optional(),
    msg: z.string().optional(),
    data: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export type RaydiumMintPriceResponse = z.infer<typeof raydiumMintPriceResponseSchema>;
