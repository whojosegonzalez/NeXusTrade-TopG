import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXECUTION_MODE,
  EXECUTION_MODES,
  isLiveMode,
  parseExecutionMode,
} from "./modes.js";

describe("execution modes", () => {
  it("defaults to paper mode", () => {
    expect(DEFAULT_EXECUTION_MODE).toBe("PAPER");
  });

  it("defines the supported execution modes", () => {
    expect(EXECUTION_MODES).toEqual(["PAPER", "LIVE", "BACKTEST"]);
  });

  it("parses valid modes", () => {
    expect(parseExecutionMode("PAPER")).toBe("PAPER");
    expect(parseExecutionMode("LIVE")).toBe("LIVE");
    expect(parseExecutionMode("BACKTEST")).toBe("BACKTEST");
  });

  it("parses missing or blank modes as the default", () => {
    expect(parseExecutionMode()).toBe("PAPER");
    expect(parseExecutionMode("")).toBe("PAPER");
    expect(parseExecutionMode("   ")).toBe("PAPER");
  });

  it("rejects invalid modes", () => {
    expect(() => parseExecutionMode("SIMULATED")).toThrow(/Invalid execution mode/);
  });

  it("detects live mode", () => {
    expect(isLiveMode("LIVE")).toBe(true);
    expect(isLiveMode("PAPER")).toBe(false);
    expect(isLiveMode("BACKTEST")).toBe(false);
  });
});
