import { describe, expect, it } from "vitest";
import { parseFormulationBCollectionArgs } from "./FormulationBCollectionConfig.js";
import { FormulationBCollectionError } from "./FormulationBCollectionErrors.js";

describe("FormulationBCollectionConfig", () => {
  it("parses valid arguments with defaults", () => {
    const config = parseFormulationBCollectionArgs(["--archive-root=archives/formulation-b/run-1"]);
    expect(config.archiveRoot).toBe("archives/formulation-b/run-1");
    expect(config.targetSlots).toBe(96);
    expect(config.days).toBe(8);
    expect(config.slotsPerDay).toBe(12);
    expect(config.dryRun).toBe(false);
    expect(config.rateLimitMs).toBe(1000);
    expect(config.requestTimeoutMs).toBe(5000);
  });

  it("parses custom arguments and flags correctly", () => {
    const config = parseFormulationBCollectionArgs([
      "--archive-root=archives/test",
      "--target-slots=48",
      "--days=4",
      "--slots-per-day=12",
      "--dry-run",
      "--rate-limit-ms=500",
      "--timeout-ms=3000",
      "--once",
    ]);
    expect(config.archiveRoot).toBe("archives/test");
    expect(config.targetSlots).toBe(48);
    expect(config.days).toBe(4);
    expect(config.slotsPerDay).toBe(12);
    expect(config.dryRun).toBe(true);
    expect(config.rateLimitMs).toBe(500);
    expect(config.requestTimeoutMs).toBe(3000);
  });

  it("throws when --archive-root is missing", () => {
    expect(() => parseFormulationBCollectionArgs([])).toThrowError(FormulationBCollectionError);
  });

  it("throws when --archive-root contains path traversal or invalid characters", () => {
    expect(() => parseFormulationBCollectionArgs(["--archive-root=../bad/path"])).toThrowError(
      FormulationBCollectionError,
    );

    expect(() => parseFormulationBCollectionArgs(["--archive-root=bad*path"])).toThrowError(
      FormulationBCollectionError,
    );
  });

  it("throws when duplicate --archive-root is provided", () => {
    expect(() =>
      parseFormulationBCollectionArgs(["--archive-root=path1", "--archive-root=path2"]),
    ).toThrowError(FormulationBCollectionError);
  });

  it("throws on invalid numeric parameters", () => {
    expect(() =>
      parseFormulationBCollectionArgs(["--archive-root=path", "--target-slots=-5"]),
    ).toThrowError(FormulationBCollectionError);

    expect(() => parseFormulationBCollectionArgs(["--archive-root=path", "--days=0"])).toThrowError(
      FormulationBCollectionError,
    );

    expect(() =>
      parseFormulationBCollectionArgs(["--archive-root=path", "--slots-per-day=abc"]),
    ).toThrowError(FormulationBCollectionError);
  });

  it("throws on unrecognized arguments", () => {
    expect(() =>
      parseFormulationBCollectionArgs(["--archive-root=path", "--unknown-flag"]),
    ).toThrowError(FormulationBCollectionError);
  });
});
