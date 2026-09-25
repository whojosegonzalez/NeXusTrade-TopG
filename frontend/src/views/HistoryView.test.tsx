import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { HistoricalSessionSummary } from "@nexustrade/shared";
import { afterEach, describe, expect, it } from "vitest";

import { HistoryView } from "./HistoryView.js";

describe("HistoryView", () => {
  afterEach(() => {
    cleanup();
  });

  const mockSessions: readonly HistoricalSessionSummary[] = [
    {
      sessionId: "session-20260924-001",
      startedAt: "2026-09-24T18:00:00.000Z",
      endedAt: "2026-09-24T22:00:00.000Z",
      durationMinutes: 240,
      startingCapitalSol: 10.0,
      endingCapitalSol: 11.5,
      netPnlSol: 1.5,
      netPnlPct: 15.0,
      totalTrades: 3,
      winsCount: 2,
      lossesCount: 1,
      scratchesCount: 0,
      winRatePct: 66.7,
      trades: [
        {
          tradeId: "trade-001",
          poolId: "pool-raydium-01",
          mintAddress: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",
          symbol: "POPCAT",
          entryPriceSol: 0.001,
          exitPriceSol: 0.00145,
          sizeSol: 1.0,
          enteredAt: "2026-09-24T18:10:00.000Z",
          exitedAt: "2026-09-24T18:25:00.000Z",
          holdDurationSeconds: 900,
          peakGainBps: 4800,
          finalPnlBps: 4500,
          finalPnlSol: 0.45,
          finalTier: "TIER_2",
          exitReason: "RATCHET_TIER_2_TRAIL_EXIT",
        },
      ],
    },
  ];

  it("renders empty state message when no sessions exist", () => {
    render(<HistoryView sessions={[]} />);
    expect(screen.getByTestId("history-view")).toBeDefined();
    expect(screen.getByText("No historical trading sessions found in archive.")).toBeDefined();
  });

  it("renders cumulative performance stats and session table", () => {
    render(<HistoryView sessions={mockSessions} />);

    expect(screen.getAllByText(/\+1.5000 SOL/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/66.7%/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("session-20260924-001")).toBeDefined();
    expect(screen.getByRole("img", { name: "Cumulative Equity Curve" })).toBeDefined();
  });

  it("expands and collapses trade drill-down section", () => {
    render(<HistoryView sessions={mockSessions} />);

    const expandBtn = screen.getByText("View Trades (1)");
    fireEvent.click(expandBtn);

    expect(screen.getByTestId("trade-drilldown")).toBeDefined();
    expect(screen.getByText("POPCAT")).toBeDefined();
    expect(screen.getByText("RATCHET_TIER_2_TRAIL_EXIT")).toBeDefined();

    const hideBtn = screen.getByText("Hide Trades");
    fireEvent.click(hideBtn);

    expect(screen.queryByTestId("trade-drilldown")).toBeNull();
  });
});
