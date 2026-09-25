import { z } from "zod";

export const ratchetTierSchema = z.enum([
  "HARD_STOP",
  "TIER_0_DRAWDOWN",
  "SCRATCH",
  "TIER_1",
  "TIER_2",
]);

export type RatchetTier = z.infer<typeof ratchetTierSchema>;

export const drawdownStateSchema = z.enum(["NORMAL", "EVALUATING_DRAWDOWN"]);

export type DrawdownState = z.infer<typeof drawdownStateSchema>;

export const livePaperPositionSchema = z.object({
  positionId: z.string(),
  mintAddress: z.string(),
  symbol: z.string().optional(),
  entryPriceSol: z.number(),
  spotPriceSol: z.number(),
  peakPriceSol: z.number(),
  currentPnlBps: z.number(),
  peakGainBps: z.number(),
  currentStopFloorBps: z.number(),
  activeTier: ratchetTierSchema,
  drawdownState: drawdownStateSchema,
  openedAtMs: z.number(),
});

export type LivePaperPosition = z.infer<typeof livePaperPositionSchema>;

export const scannerRadarItemSchema = z.object({
  poolId: z.string(),
  mintAddress: z.string(),
  symbol: z.string(),
  liquidityUsd: z.number(),
  marketCapUsd: z.number(),
  lmcRatio: z.number(),
  lpBurnPct: z.number(),
  assetAgeSeconds: z.number(),
  admitted: z.boolean(),
  rejectionReason: z.string().optional(),
  discoveredAt: z.string(),
});

export type ScannerRadarItem = z.infer<typeof scannerRadarItemSchema>;

export const closedTradeSchema = z.object({
  positionId: z.string(),
  mintAddress: z.string(),
  entryPriceSol: z.number(),
  exitPriceSol: z.number(),
  costBasisSol: z.number(),
  proceedsSol: z.number(),
  realizedPnlSol: z.number(),
  realizedPnlBps: z.number(),
  exitReason: z.string(),
  openedAtMs: z.number(),
  closedAtMs: z.number(),
});

export type ClosedTrade = z.infer<typeof closedTradeSchema>;

export const paperTradingSessionSnapshotSchema = z.object({
  sessionId: z.string(),
  status: z.enum(["RUNNING", "STOPPED", "HALTED"]),
  initialPortfolioSol: z.number(),
  currentPortfolioSol: z.number(),
  totalRealizedPnlSol: z.number(),
  totalUnrealizedPnlSol: z.number(),
  openPositions: z.array(livePaperPositionSchema),
  closedTrades: z.array(closedTradeSchema),
});

export type PaperTradingSessionSnapshot = z.infer<typeof paperTradingSessionSnapshotSchema>;
