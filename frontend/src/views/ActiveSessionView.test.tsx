import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ActiveSessionTelemetry } from "@nexustrade/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActiveSessionView } from "./ActiveSessionView.js";

describe("ActiveSessionView", () => {
  afterEach(() => {
    cleanup();
  });

  const mockSession: ActiveSessionTelemetry = {
    sessionId: "session-test-20260925-01",
    status: "RUNNING",
    startedAtMs: Date.now() - 3600 * 1000,
    durationHours: 4,
    elapsedSeconds: 3600,
    initialPortfolioSol: 10.0,
    currentPortfolioSol: 11.25,
    realizedPnlSol: 0.75,
    unrealizedPnlSol: 0.5,
    netSessionPnlSol: 1.25,
    netSessionPnlPct: 12.5,
    openPositionCount: 1,
    maxConcurrentPositions: 3,
    closedTradesCount: 4,
    winsCount: 3,
    lossesCount: 1,
    scratchesCount: 0,
    openPositions: [
      {
        positionId: "pos-001",
        mintAddress: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",
        symbol: "POPCAT",
        entryPriceSol: 0.001,
        spotPriceSol: 0.00125,
        peakPriceSol: 0.0013,
        currentPnlBps: 2500,
        peakGainBps: 3000,
        currentStopFloorBps: 2000,
        activeTier: "TIER_1",
        drawdownState: "NORMAL",
        openedAtMs: Date.now() - 600 * 1000,
      },
    ],
    watchlist: [
      {
        poolId: "pool-watch-1",
        mintAddress: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
        symbol: "BONK",
        liquidityUsd: 15000,
        marketCapUsd: 60000,
        lmcRatio: 0.25,
        lpBurnPct: 99.5,
        assetAgeSeconds: 420,
        volume5mUsd: 4500,
        buys5m: 45,
        sells5m: 20,
        buyToSellRatio: 2.25,
        status: "WATCHING",
        discoveredAt: new Date().toISOString(),
        lastEvaluatedAt: new Date().toISOString(),
      },
    ],
    recentActivityLogs: [
      {
        timestamp: Date.now() - 60 * 1000,
        type: "RATCHET",
        message: "POPCAT stop floor advanced to TIER 1 (+20.0%)",
      },
    ],
  };

  it("renders empty state placeholder when session is undefined", () => {
    render(<ActiveSessionView session={undefined} />);
    expect(screen.getByTestId("active-session-view")).toBeDefined();
    expect(
      screen.getByText("No active paper trading daemon running or session state file found."),
    ).toBeDefined();
  });

  it("renders active session telemetry banner, counters, open position, watchlist, and logs", () => {
    render(<ActiveSessionView session={mockSession} />);

    expect(screen.getByText("+1.2500 SOL")).toBeDefined();
    expect(screen.getByText("(+12.50%)")).toBeDefined();
    expect(screen.getByText("1 / 3")).toBeDefined();
    expect(screen.getByText("POPCAT")).toBeDefined();
    expect(screen.getByText("TIER 1 LOCKED (+20%)")).toBeDefined();
    expect(screen.getByText("BONK")).toBeDefined();
    expect(screen.getByText("POPCAT stop floor advanced to TIER 1 (+20.0%)")).toBeDefined();
  });

  it("triggers pause and start exiting commands", () => {
    const onSendCommand = vi.fn();
    render(<ActiveSessionView session={mockSession} onSendCommand={onSendCommand} />);

    const pauseBtn = screen.getByText("⏸ Pause Session");
    fireEvent.click(pauseBtn);
    expect(onSendCommand).toHaveBeenCalledWith("PAUSE", undefined);

    const exitingBtn = screen.getByText("🛑 Start Exiting (Graceful Wind-Down)");
    fireEvent.click(exitingBtn);
    expect(onSendCommand).toHaveBeenCalledWith("START_EXITING", undefined);
  });

  it("triggers resume command when session is paused", () => {
    const onSendCommand = vi.fn();
    render(
      <ActiveSessionView
        session={{ ...mockSession, status: "PAUSED" }}
        onSendCommand={onSendCommand}
      />,
    );

    const resumeBtn = screen.getByText("▶ Resume Session");
    fireEvent.click(resumeBtn);
    expect(onSendCommand).toHaveBeenCalledWith("RESUME", undefined);
  });

  it("triggers manual market exit for an open position", () => {
    const onSendCommand = vi.fn();
    render(<ActiveSessionView session={mockSession} onSendCommand={onSendCommand} />);

    const marketCloseBtn = screen.getByText("Market Close Position");
    fireEvent.click(marketCloseBtn);

    expect(onSendCommand).toHaveBeenCalledWith("MANUAL_EXIT", "pos-001");
  });
});
