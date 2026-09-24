import { existsSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockFormulationBProviderClient } from "./FormulationBCollection.test-support.js";
import { runFormulationBCollectionCli } from "./FormulationBCollectionCli.js";

const CLI_TEST_ARCHIVE = "node_modules/.cache/test-cli-formulation-b-archive";

describe("FormulationBCollectionCli", () => {
  beforeEach(() => {
    if (existsSync(CLI_TEST_ARCHIVE)) {
      rmSync(CLI_TEST_ARCHIVE, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (existsSync(CLI_TEST_ARCHIVE)) {
      rmSync(CLI_TEST_ARCHIVE, { recursive: true, force: true });
    }
  });

  it("returns exit code 1 when required arguments are missing", async () => {
    const errLogs: string[] = [];
    const exitCode = await runFormulationBCollectionCli(
      [],
      undefined,
      () => {},
      (msg) => errLogs.push(msg),
    );

    expect(exitCode).toBe(1);
    expect(errLogs.length).toBeGreaterThan(0);
    expect(errLogs[0]).toContain("FORMULATION_B_COLLECTION_INVALID_SCOPE");
  });

  it("returns exit code 0 on successful synthetic run with mock provider", async () => {
    const outLogs: string[] = [];
    const provider = new MockFormulationBProviderClient();
    const exitCode = await runFormulationBCollectionCli(
      [`--archive-root=${CLI_TEST_ARCHIVE}`, "--rate-limit-ms=0"],
      provider,
      (msg) => outLogs.push(msg),
      () => {},
    );

    expect(exitCode).toBe(0);
    expect(outLogs.length).toBeGreaterThan(0);
    const parsed = JSON.parse(outLogs[0] ?? "{}");
    expect(parsed.status).toBe("SUCCESS");
    expect(parsed.finalOutcome).toBe("COHORT_COMPLETE");
  });

  it("returns exit code 1 on collection error with proper error code prefix", async () => {
    const errLogs: string[] = [];
    const provider = new MockFormulationBProviderClient({
      injectedLiquidityKey: "liquidityUsd", // triggers FORMULATION_B_LIQUIDITY_PROHIBITION_STOP
    });

    const exitCode = await runFormulationBCollectionCli(
      [`--archive-root=${CLI_TEST_ARCHIVE}`, "--rate-limit-ms=0"],
      provider,
      () => {},
      (msg) => errLogs.push(msg),
    );

    expect(exitCode).toBe(1);
    expect(errLogs.length).toBeGreaterThan(0);
    expect(errLogs[0]).toContain("FORMULATION_B_LIQUIDITY_PROHIBITION_STOP");
  });
});
