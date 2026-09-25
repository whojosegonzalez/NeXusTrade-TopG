import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LivePositionsGrid } from "./LivePositionsGrid.js";
import type { LivePaperPosition } from "@nexustrade/shared";

describe("LivePositionsGrid", () => {
  it("renders empty state when no positions are active", () => {
    render(<LivePositionsGrid positions={[]} />);
    expect(screen.getByText(/No open positions currently active/i)).toBeInTheDocument();
  });

  it("renders active positions with tier badges and drawdown warning", () => {
    const mockPositions: LivePaperPosition[] = [
      {
        positionId: "pos-1",
        mintAddress: "Mint111111111111111111111111111111111111",
        symbol: "TOKEN1",
        entryPriceSol: 1.0,
        spotPriceSol: 1.25,
        peakPriceSol: 1.25,
        currentPnlBps: 2500, // +25%
        peakGainBps: 2500,
        currentStopFloorBps: 2000,
        activeTier: "TIER_1",
        drawdownState: "NORMAL",
        openedAtMs: 1_000_000,
      },
      {
        positionId: "pos-2",
        mintAddress: "Mint222222222222222222222222222222222222",
        symbol: "TOKEN2",
        entryPriceSol: 1.0,
        spotPriceSol: 0.915,
        peakPriceSol: 1.0,
        currentPnlBps: -850, // -8.5%
        peakGainBps: 0,
        currentStopFloorBps: -800,
        activeTier: "TIER_0_DRAWDOWN",
        drawdownState: "EVALUATING_DRAWDOWN",
        openedAtMs: 1_000_000,
      },
    ];

    render(<LivePositionsGrid positions={mockPositions} />);

    expect(screen.getByText("TOKEN1")).toBeInTheDocument();
    expect(screen.getByText("TIER_1")).toBeInTheDocument();
    expect(screen.getAllByText("+25.00%").length).toBeGreaterThanOrEqual(1);

    expect(screen.getByText("TOKEN2")).toBeInTheDocument();
    expect(screen.getByText("TIER_0_DRAWDOWN")).toBeInTheDocument();
    expect(screen.getByText("-8.50%")).toBeInTheDocument();
    expect(screen.getByText(/Smart Re-evaluation: Grace Period Active/i)).toBeInTheDocument();
  });
});
