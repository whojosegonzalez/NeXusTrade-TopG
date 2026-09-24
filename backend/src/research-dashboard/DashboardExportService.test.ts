import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getRepoRoot } from "../db/utils/paths.js";
import { assertNoCredentialLikeValue, DashboardExportService } from "./DashboardExportService.js";

const outputDir = "frontend/public/research-dashboard-data/test-output";
const config = {
  archiveRoot: "data/archive",
  includePhases: ["phase9.28", "phase9.29"],
  includeCohorts: ["phase9.29/combined-valid-three-20260818-1539"],
  outputDir,
} as const;
const reportPath =
  "data/archive/phase9.29/combined-valid-three-20260818-1539/shadow-fast-attribution-2026-08-18T22-37-25-084Z.json";
const archiveDatabasePath =
  "data/archive/phase9.28/test1-phase9.28-test1-20260817-1921/nexus_paper.db";

afterEach(() => {
  const resolvedOutput = path.join(getRepoRoot(), outputDir);
  if (existsSync(resolvedOutput)) rmSync(resolvedOutput, { recursive: true, force: true });
});

describe("DashboardExportService", () => {
  it("exports the approved Phase 9.28/9.29 evidence deterministically without network access", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const sourceHashBefore = hashFile(reportPath);
    const databaseHashBefore = hashFile(archiveDatabasePath);
    const databaseMtimeBefore = statSync(path.join(getRepoRoot(), archiveDatabasePath)).mtimeMs;
    const first = new DashboardExportService({
      config,
      now: () => new Date("2026-08-18T23:00:00.000Z"),
    }).build();
    const second = new DashboardExportService({
      config,
      now: () => new Date("2026-08-18T23:15:00.000Z"),
    }).build();

    expect(first.manifest.generatedAt).not.toBe(second.manifest.generatedAt);
    expect(first.manifest.contentFingerprint).toBe(second.manifest.contentFingerprint);
    expect(first.cohorts).toHaveLength(1);
    expect(first.candidates).toHaveLength(7);
    expect(first.runs.length).toBeGreaterThanOrEqual(3);
    expect(first.runs.every((run) => run.reportKinds?.[0] === "TERMINAL_RUNNER_SUMMARY")).toBe(
      true,
    );
    const test3 = first.runs.find((run) =>
      run.archivePath.endsWith("test3-phase9.28-test3-20260818-1153"),
    );
    expect(
      test3?.providerPressure.find((provider) => provider.provider === "JUPITER"),
    ).toMatchObject({
      controllerDeferrals: 35,
    });
    expect(
      test3?.providerPressure.find((provider) => provider.provider === "RAYDIUM"),
    ).toMatchObject({
      venueGuardSkips: 33,
      venueGuardAllows: 2,
    });
    expect(new Set(first.candidates.map((candidate) => candidate.outcomeLabel.label))).toEqual(
      new Set(["TARGET_FIRST", "STOP_FIRST", "MAX_HOLD"]),
    );
    expect(
      first.candidates.every((candidate) =>
        candidate.decisionFeatures.every(
          (feature) =>
            feature.availability === "AVAILABLE_AT_DECISION_TIME" || feature.value === undefined,
        ),
      ),
    ).toBe(true);
    expect(
      first.candidates.every(
        (candidate) =>
          candidate.outcomeLabel.description === "Later observation; not an entry input.",
      ),
    ).toBe(true);
    expect(first.cohorts[0]?.labelCounts).toMatchObject({
      TARGET_FIRST: 3,
      STOP_FIRST: 3,
      MAX_HOLD: 1,
    });
    expect(first.manifest.safety).toMatchObject({ providerCalls: false, databaseWrites: false });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(hashFile(reportPath)).toBe(sourceHashBefore);
    expect(hashFile(archiveDatabasePath)).toBe(databaseHashBefore);
    expect(statSync(path.join(getRepoRoot(), archiveDatabasePath)).mtimeMs).toBe(
      databaseMtimeBefore,
    );
    fetchSpy.mockRestore();
  });

  it("writes only generated dashboard resources and preserves the archive source", () => {
    const sourceHashBefore = hashFile(reportPath);
    const databaseHashBefore = hashFile(archiveDatabasePath);
    const result = new DashboardExportService({ config }).write();

    expect(result.writtenFiles).toHaveLength(4);
    expect(result.writtenFiles.every((file) => file.includes("research-dashboard-data"))).toBe(
      true,
    );
    expect(hashFile(reportPath)).toBe(sourceHashBefore);
    expect(hashFile(archiveDatabasePath)).toBe(databaseHashBefore);
  });

  it("fails closed for credential-like output content", () => {
    expect(() => assertNoCredentialLikeValue({ value: "Bearer should-not-export" })).toThrow(
      "credential-like",
    );
  });

  it("rejects ambiguous Phase 9.29 report selection without an explicit cohort", () => {
    expect(() =>
      new DashboardExportService({
        config: { ...config, includeCohorts: [] },
      }).build(),
    ).toThrow("exactly one canonical Phase 9.29 attribution report");
  });
});

function hashFile(filePath: string): string {
  return createHash("sha256")
    .update(readFileSync(path.join(getRepoRoot(), filePath)))
    .digest("hex");
}
