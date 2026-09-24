import { z } from "zod";

export const birdeyeEnvelopeSchema = z
  .object({
    success: z.boolean().optional(),
    data: z.unknown().optional(),
    message: z.string().optional(),
    msg: z.string().optional(),
  })
  .passthrough();

export type BirdeyeEnvelope = z.infer<typeof birdeyeEnvelopeSchema>;
