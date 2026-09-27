import { cleanup, render, screen } from "@testing-library/react";
import type { HistoricalSessionSummary } from "@nexustrade/shared";
import { afterEach, describe, expect, it } from "vitest";

import { HistoryView } from "./HistoryView.js";

describe("HistoryView", () => {
  afterEach(() => {
    cleanup();
  });

  const mockSessions: readonly HistoricalSessionSummary[] = [
    {
      sessionId: "session-paper-12.4-01",
      startedAt: "2026-09-26T14:30:00.000Z",
      endedAt: "2026-09-26T18:30:00.000Z",
      durationMinutes: 240,
      startingCapitalSol: 10.0,
      endingCapitalSol: 10.708,
      netPnlSol: 0.708,
      netPnlPct: 7.08,
      totalTrades: 12,
      buysCount: 12,
      sellsCount: 12,
      winsCount: 8,
      lossesCount: 4,
      scratchesCount: 0,
      winRatePct: 66.67,
      coinsWatchedCount: 73,
      missedOpportunitiesCount: 0,
      trades: [],
    },
    {
      sessionId: "session-paper-12.5-01",
      startedAt: "2026-09-26T20:00:00.000Z",
      endedAt: "2026-09-27T00:00:00.000Z",
      durationMinutes: 240,
      startingCapitalSol: 10.0,
      endingCapitalSol: 9.974,
      netPnlSol: -0.026,
      netPnlPct: -0.26,
      totalTrades: 7,
      buysCount: 7,
      sellsCount: 7,
      winsCount: 2,
      lossesCount: 5,
      scratchesCount: 0,
      winRatePct: 28.57,
      coinsWatchedCount: 54,
      missedOpportunitiesCount: 0,
      trades: [],
    },
    {
      sessionId: "session-paper-12.3-01",
      startedAt: "2026-09-25T18:00:00.000Z",
      endedAt: "2026-09-25T22:00:00.000Z",
      durationMinutes: 240,
      startingCapitalSol: 10.0,
      endingCapitalSol: 9.58,
      netPnlSol: -0.42,
      netPnlPct: -4.2,
      totalTrades: 8,
      buysCount: 8,
      sellsCount: 8,
      winsCount: 3,
      lossesCount: 5,
      scratchesCount: 0,
      winRatePct: 37.5,
      coinsWatchedCount: 48,
      missedOpportunitiesCount: 0,
      trades: [],
    },
  ];

  it("renders empty state message when no sessions exist", () => {
    render(<HistoryView sessions={[]} />);
    expect(screen.getByTestId("history-view")).toBeDefined();
    expect(screen.getByText("No historical trading sessions found in archive.")).toBeDefined();
  });

  it("renders cumulative performance stats and date-grouped sections", () => {
    render(<HistoryView sessions={mockSessions} />);

    expect(screen.getByTestId("history-view")).toBeDefined();
    expect(screen.getByTestId("day-section-2026-09-26")).toBeDefined();
    expect(screen.getByTestId("day-section-2026-09-25")).toBeDefined();

    // Check sessions rendered under date groups
    expect(screen.getByTestId("session-row-session-paper-12.4-01")).toBeDefined();
    expect(screen.getByTestId("session-row-session-paper-12.5-01")).toBeDefined();
    expect(screen.getByTestId("session-row-session-paper-12.3-01")).toBeDefined();

    // Total watched across sessions = 73 + 54 + 48 = 175
    expect(screen.getAllByText(/175/).length).toBeGreaterThanOrEqual(1);

    // Check column values
    expect(screen.getByText("73 candidates")).toBeDefined();
    expect(screen.getByText("54 candidates")).toBeDefined();
    expect(screen.getByText("48 candidates")).toBeDefined();
  });

  it("renders correct daily P/L and capital delta aggregation in date headers", () => {
    render(<HistoryView sessions={mockSessions} />);

    // September 26 has 2 sessions: +0.708 and -0.026 = +0.6820 SOL
    expect(screen.getByText(/2 Sessions Ran/)).toBeDefined();
    expect(screen.getByText(/1 Session Ran/)).toBeDefined();
    expect(screen.getByText(/\+0.6820 SOL/)).toBeDefined();
  });
});
