import { describe, expect, it } from "vitest";

import { parseTerminalRunnerArgs } from "./TerminalRunnerConfig.js";

describe("TerminalRunnerConfig", () => {
  it("defaults to one shadow-only cycle", () => {
    expect(parseTerminalRunnerArgs([])).toMatchObject({
      once: true,
      intervalMs: 60_000,
      json: false,
      shadowOnly: true,
    });
  });

  it("switches to loop mode when cycles or max runtime is supplied", () => {
    expect(parseTerminalRunnerArgs(["--cycles=3", "--interval-ms=1000"])).toMatchObject({
      once: false,
      cycles: 3,
      intervalMs: 1000,
    });
    expect(parseTerminalRunnerArgs(["--max-runtime-minutes=120"])).toMatchObject({
      once: false,
      maxRuntimeMinutes: 120,
    });
  });

  it("parses json and output artifacts without changing safety mode", () => {
    expect(parseTerminalRunnerArgs(["--json", "--output-dir=data/phase9-runs"])).toMatchObject({
      json: true,
      outputDir: "data/phase9-runs",
      shadowOnly: true,
    });
  });

  it("rejects invalid loop combinations and bounds", () => {
    expect(() => parseTerminalRunnerArgs(["--once", "--cycles=2"])).toThrow(/cannot be combined/);
    expect(() => parseTerminalRunnerArgs(["--cycles=0"])).toThrow(/cycles/);
    expect(() => parseTerminalRunnerArgs(["--interval-ms=999"])).toThrow(/intervalMs/);
    expect(() => parseTerminalRunnerArgs(["--max-runtime-minutes=0"])).toThrow(/maxRuntimeMinutes/);
  });

  it("rejects live and paper-execution flags", () => {
    expect(() => parseTerminalRunnerArgs(["--mode=LIVE"])).toThrow(/safety boundary/);
    expect(() => parseTerminalRunnerArgs(["--paper-execute"])).toThrow(/safety boundary/);
    expect(() => parseTerminalRunnerArgs(["--enable-paper-buy"])).toThrow(/safety boundary/);
  });
});
