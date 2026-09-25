import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionControlIpcService } from "./SessionControlIpcService.js";
import type { ActiveSessionTelemetry } from "@nexustrade/shared";

describe("SessionControlIpcService", () => {
  const testTmpDir = path.resolve(process.cwd(), ".tmp", "test-ipc");
  const ipc = new SessionControlIpcService({ tmpDir: testTmpDir });

  afterEach(() => {
    ipc.clear();
    if (fs.existsSync(testTmpDir)) {
      fs.rmSync(testTmpDir, { recursive: true, force: true });
    }
  });

  it("dispatches and polls commands in FIFO order", () => {
    ipc.dispatchCommand("PAUSE");
    ipc.dispatchCommand("START_EXITING");
    ipc.dispatchCommand("MANUAL_EXIT", "pos-123");

    const cmd1 = ipc.pollNextCommand();
    expect(cmd1?.action).toBe("PAUSE");

    const cmd2 = ipc.pollNextCommand();
    expect(cmd2?.action).toBe("START_EXITING");

    const cmd3 = ipc.pollNextCommand();
    expect(cmd3?.action).toBe("MANUAL_EXIT");
    expect(cmd3?.targetPositionId).toBe("pos-123");

    const cmd4 = ipc.pollNextCommand();
    expect(cmd4).toBeNull();
  });

  it("writes and reads active session state atomically", () => {
    const mockState: ActiveSessionTelemetry = {
      sessionId: "test-session-123",
      status: "RUNNING",
      startedAtMs: 1_000_000,
      durationHours: 6,
      elapsedSeconds: 120,
      initialPortfolioSol: 10.0,
      currentPortfolioSol: 10.5,
      realizedPnlSol: 0.3,
      unrealizedPnlSol: 0.2,
      netSessionPnlSol: 0.5,
      netSessionPnlPct: 5.0,
      openPositionCount: 1,
      maxConcurrentPositions: 3,
      closedTradesCount: 2,
      winsCount: 2,
      lossesCount: 0,
      scratchesCount: 0,
      openPositions: [],
      watchlist: [],
      recentActivityLogs: [
        {
          timestamp: 1_000_050,
          type: "BUY",
          message: "Bought 1.0 SOL of TEST_TOKEN",
        },
      ],
    };

    ipc.writeActiveSessionState(mockState);
    const read = ipc.readActiveSessionState();

    expect(read).not.toBeNull();
    expect(read?.sessionId).toBe("test-session-123");
    expect(read?.currentPortfolioSol).toBe(10.5);
    expect(read?.recentActivityLogs.length).toBe(1);
  });
});
