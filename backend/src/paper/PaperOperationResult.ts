import { z } from "zod";
const amount = z.number().int().safe();
const ref = z.string().min(1).max(256);
export const paperOperationResultSchema = z
  .object({
    version: z.literal(1),
    operationId: ref,
    side: z.enum(["BUY", "SELL"]),
    state: z.enum(["COMMITTED", "REJECTED"]),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
    orderId: ref,
    fillId: ref.optional(),
    positionId: ref.optional(),
    cashDeltaLamports: amount,
    realizedPnlDeltaLamports: amount,
    feesLamports: amount.nonnegative(),
    slippageLamports: amount.nonnegative(),
    grossProceedsLamports: amount.nonnegative(),
    priceSource: z.enum(["QUOTE", "REFRESHED_PRICE", "CACHED_RADAR_PRICE"]).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.state === "COMMITTED" && (!value.fillId || !value.positionId))
      ctx.addIssue({ code: "custom", message: "Missing committed references" });
    if (
      value.state === "REJECTED" &&
      (value.fillId ||
        value.positionId ||
        value.cashDeltaLamports ||
        value.realizedPnlDeltaLamports ||
        value.feesLamports ||
        value.slippageLamports ||
        value.grossProceedsLamports)
    )
      ctx.addIssue({ code: "custom", message: "Rejected operation has economic effects" });
    if (
      value.state === "COMMITTED" &&
      ((value.side === "BUY" && value.cashDeltaLamports >= 0) ||
        (value.side === "SELL" && value.cashDeltaLamports <= 0))
    )
      ctx.addIssue({ code: "custom", message: "Invalid cash direction" });
  });
export type PaperOperationResult = z.infer<typeof paperOperationResultSchema>;
