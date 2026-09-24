import type * as NodeFs from "node:fs";
import {
  readFileSync,
  readdirSync,
  existsSync,
  lstatSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeasurementCohortAnalysisIdentity } from "./MeasurementCohortAnalysisIdentity.js";
import { makeFinalFixture, cleanupFixtures } from "./MeasurementCohortAnalysis.test-support.js";

const state = vi.hoisted(() => ({
  root: "",
  identity: undefined as MeasurementCohortAnalysisIdentity | undefined,
  guarded: false,
}));
vi.mock("./MeasurementCohortAnalysisIdentity.js", async (original) => ({
  ...(await original<object>()),
  get MEASUREMENT_COHORT_ANALYSIS_APPROVED_IDENTITY() {
    return state.identity;
  },
}));
vi.mock("./MeasurementCohortAnalysisPaths.js", async (original) => ({
  ...(await original<object>()),
  getMeasurementCohortAnalysisRepoRoot: () => state.root,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof NodeFs>();
  return {
    ...fs,
    existsSync: vi.fn(fs.existsSync),
    lstatSync: vi.fn(fs.lstatSync),
    realpathSync: vi.fn(fs.realpathSync),
    readdirSync: vi.fn(fs.readdirSync),
    readFileSync: vi.fn((...args: Parameters<typeof fs.readFileSync>) => {
      if (state.guarded) {
        const relative = path.relative(state.root, String(args[0]));
        if (
          relative.startsWith("..") ||
          path.isAbsolute(relative) ||
          path.basename(String(args[0])).startsWith(".env")
        )
          throw new Error("Read escaped the synthetic CLI root");
      }
      return fs.readFileSync(...args);
    }),
    writeFileSync: vi.fn((...args: Parameters<typeof fs.writeFileSync>) => {
      if (state.guarded) throw new Error("Analyzer attempted a filesystem write");
      return fs.writeFileSync(...args);
    }),
  };
});
const savedArgv = process.argv;
const savedExitCode = process.exitCode;
beforeEach(() => {
  vi.resetModules();
  state.guarded = false;
  state.identity = undefined;
});
afterEach(() => {
  state.guarded = false;
  vi.restoreAllMocks();
  process.argv = savedArgv;
  process.exitCode = savedExitCode;
  cleanupFixtures();
  vi.clearAllMocks();
});
async function entry(args: string[]) {
  process.argv = ["node", "synthetic-analyzer", ...args];
  process.exitCode = undefined;
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.clearAllMocks();
  state.guarded = true;
  // This imports the entrypoint under a fixture-only identity/root. It does not invoke the production command.
  await import("../scripts/research-measurement-cohort-analyze.js");
  state.guarded = false;
  return { stdout, stderr };
}
describe("H1 synthetic entrypoint channels", () => {
  it.each(["json", "markdown"])(
    "emits only %s stdout on successful synthetic analysis",
    async (format) => {
      const fixture = makeFinalFixture();
      state.root = fixture.repoRoot;
      state.identity = fixture.identity;
      const filesBefore = readdirSync(fixture.root).map(
        (file) => [file, readFileSync(path.join(fixture.root, file))] as const,
      );
      const { stdout, stderr } = await entry([`--format=${format}`, "--once"]);
      expect(stdout).toHaveBeenCalledTimes(1);
      expect(stderr).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
      expect(String(stdout.mock.calls[0]![0])).toContain("MEASUREMENT_CAPABILITY_CONFIRMED");
      expect(writeFileSync).not.toHaveBeenCalled();
      for (const [file, bytes] of filesBefore)
        expect(readFileSync(path.join(fixture.root, file))).toEqual(bytes);
      expect(readdirSync(fixture.root)).toEqual(filesBefore.map(([file]) => file));
    },
  );
  it.each(["identity", "scope", "hash", "missing", "label"])(
    "emits a bounded stderr-only %s failure",
    async (failure) => {
      const fixture = makeFinalFixture();
      state.root = fixture.repoRoot;
      state.identity = fixture.identity;
      let args: string[] = [];
      const codes = {
        identity: "IDENTITY_NOT_REGISTERED",
        scope: "INVALID_SCOPE",
        hash: "SOURCE_INCONSISTENCY",
        missing: "ARCHIVE_NOT_FINAL",
        label: "LABEL_QUARANTINE_VIOLATION",
      };
      if (failure === "identity") state.identity = undefined;
      if (failure === "scope") args = ["--identity=synthetic-sensitive-value"];
      if (failure === "hash")
        state.identity = {
          ...fixture.identity,
          artifacts: { ...fixture.identity.artifacts, "units.v1.ndjson": "0".repeat(64) },
        };
      if (failure === "missing") state.root = path.join(fixture.repoRoot, "absent");
      if (failure === "label") {
        const support = await import("./MeasurementCohortAnalysis.test-support.js");
        const file = path.join(fixture.root, "collection-summary.v1.json");
        const summary = JSON.parse(readFileSync(file, "utf8"));
        summary.laterObservations = [];
        writeFileSync(file, JSON.stringify(summary));
        state.identity = support.rewriteInternalHashes(fixture.root);
      }
      const { stdout, stderr } = await entry(args);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
      const error = String(stderr.mock.calls[0]![0]);
      expect(error).toMatch(
        new RegExp(
          `^MEASUREMENT_COHORT_ANALYSIS_${codes[failure as keyof typeof codes]}: [^\\n]+\\n$`,
        ),
      );
      expect(error.length).toBeLessThan(300);
      expect(error).not.toContain(fixture.root);
      expect(error).not.toContain("synthetic-sensitive-value");
      expect(writeFileSync).not.toHaveBeenCalled();
      if (failure === "identity" || failure === "scope")
        for (const operation of [readFileSync, readdirSync, existsSync, lstatSync, realpathSync])
          expect(operation).not.toHaveBeenCalled();
    },
  );
});
