import { z } from "zod";

export const raydiumPoolInfoSchema = z
  .object({
    id: z.string().optional(),
    type: z.string().optional(),
    programId: z.string().optional(),
    mintA: z.unknown().optional(),
    mintB: z.unknown().optional(),
  })
  .passthrough();

const raydiumPoolListDataSchema = z
  .object({
    data: z.array(raydiumPoolInfoSchema).optional(),
    count: z.number().optional(),
  })
  .passthrough();

export const raydiumPoolsByMintResponseSchema = z
  .object({
    id: z.string().optional(),
    success: z.boolean().optional(),
    msg: z.string().optional(),
    data: z.union([z.array(raydiumPoolInfoSchema), raydiumPoolListDataSchema]).optional(),
  })
  .passthrough();

export type RaydiumPoolInfo = z.infer<typeof raydiumPoolInfoSchema>;
export type RaydiumPoolsByMintResponse = z.infer<typeof raydiumPoolsByMintResponseSchema>;
