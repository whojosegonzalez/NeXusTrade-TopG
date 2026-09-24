import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFormulationBArgs, runFormulationBAnalysisCli } from "./FormulationBAnalysisCli.js";
import {
  buildStandardSyntheticCohort,
  writeSyntheticArchive,
} from "./FormulationBAnalysis.test-support.js";
import { FormulationBAnalysisError } from "./FormulationBAnalysisErrors.js";

describe("FormulationBAnalysisCli", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "formulation-b-cli-"));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("parses valid CLI options correctly", () => {
    const opts = parseFormulationBArgs([
      "--archive-root=data/archive/test",
      "--format=json",
      "--once",
    ]);
    expect(opts.archiveRoot).toBe("data/archive/test");
    expect(opts.format).toBe("json");
  });

  it("defaults to markdown format", () => {
    const opts = parseFormulationBArgs(["--archive-root=data/archive/test"]);
    expect(opts.archiveRoot).toBe("data/archive/test");
    expect(opts.format).toBe("markdown");
  });

  it("fails closed on missing --archive-root", () => {
    expect(() => parseFormulationBArgs(["--format=json"])).toThrowError(FormulationBAnalysisError);
  });

  it("fails closed on path traversal in --archive-root", () => {
    expect(() => parseFormulationBArgs(["--archive-root=../escape"])).toThrowError(
      FormulationBAnalysisError,
    );
  });

  it("fails closed on unknown arguments", () => {
    expect(() =>
      parseFormulationBArgs(["--archive-root=data/archive/test", "--bad-arg"]),
    ).toThrowError(FormulationBAnalysisError);
  });

  it("runs CLI end-to-end and outputs formatted markdown", () => {
    const units = buildStandardSyntheticCohort("passing");
    writeSyntheticArchive(tempDir, { units });

    let stdout = "";
    let stderr = "";
    const exitCode = runFormulationBAnalysisCli(
      [`--archive-root=${tempDir}`, "--format=markdown"],
      (msg) => {
        stdout += msg;
      },
      (msg) => {
        stderr += msg;
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain(
      "# Formulation B: Liquidity-Independent Momentum Acceleration Analysis Report",
    );
    expect(stdout).toContain("PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL");
  });

  it("runs CLI end-to-end and outputs formatted JSON", () => {
    const units = buildStandardSyntheticCohort("passing");
    writeSyntheticArchive(tempDir, { units });

    let stdout = "";
    let stderr = "";
    const exitCode = runFormulationBAnalysisCli(
      [`--archive-root=${tempDir}`, "--format=json"],
      (msg) => {
        stdout += msg;
      },
      (msg) => {
        stderr += msg;
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout);
    expect(parsed.decisionOutcome).toBe("PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL");
    expect(parsed.protocolId).toBe("EXPLORATORY_COHORT_FORMULATION_B@v1");
  });
});
