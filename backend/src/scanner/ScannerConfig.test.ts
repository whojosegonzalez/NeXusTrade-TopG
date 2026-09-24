import { describe, expect, it } from "vitest";

import { defaultScannerConfig, parseScannerArgs } from "./ScannerConfig.js";

describe("ScannerConfig", () => {
  it("uses Phase 4 defaults", () => {
    expect(defaultScannerConfig()).toEqual({
      intervalMs: 60_000,
      limit: 25,
      concurrency: 3,
      once: false,
      dryRun: false,
    });
  });

  it("parses scanner CLI arguments", () => {
    expect(
      parseScannerArgs([
        "--once",
        "--dry-run",
        "--session-id=session_123",
        "--interval-ms=30000",
        "--limit=10",
        "--concurrency=2",
      ]),
    ).toEqual({
      intervalMs: 30_000,
      limit: 10,
      concurrency: 2,
      once: true,
      dryRun: true,
      sessionId: "session_123",
    });
  });

  it("rejects invalid runtime values", () => {
    expect(() => parseScannerArgs(["--interval-ms=9999"])).toThrow(/intervalMs/);
    expect(() => parseScannerArgs(["--limit=101"])).toThrow(/limit/);
    expect(() => parseScannerArgs(["--concurrency=0"])).toThrow(/concurrency/);
    expect(() => parseScannerArgs(["--unknown"])).toThrow(/Unknown scanner option/);
  });
});
