import { describe, expect, it } from "vitest";

import { parseFastShadowArgs } from "./FastShadowConfig.js";
import { parseFastShadowValidationArgs } from "./FastShadowValidationConfig.js";

describe("FastShadowConfig", () => {
  it("requires an explicit session and bounds tail mode", () => {
    expect(() => parseFastShadowArgs([])).toThrow("--session-id");
    expect(() =>
      parseFastShadowArgs(["--session-id=session", "--once", "--max-runtime-minutes=20"]),
    ).toThrow("cannot combine");
    expect(parseFastShadowArgs(["--session-id=session", "--max-runtime-minutes=20"])).toMatchObject(
      {
        sessionId: "session",
        once: false,
        maxRuntimeMinutes: 20,
        intervalMs: 60_000,
      },
    );
  });

  it("rejects execution and profile-override flags", () => {
    expect(() => parseFastShadowArgs(["--session-id=session", "--paper-execute"])).toThrow(
      "rejects execution",
    );
    expect(() => parseFastShadowArgs(["--session-id=session", "--horizons=1,2"])).toThrow(
      "profile-override",
    );
    expect(() => parseFastShadowValidationArgs(["--db=data/nexus_paper.db"])).toThrow(
      "rejects active-runtime",
    );
    expect(() => parseFastShadowValidationArgs(["--label-run=one:data/not-archive/run"])).toThrow(
      "data/archive",
    );
    expect(
      parseFastShadowValidationArgs(["--label-run=one:data\\\\archive\\\\phase9.28\\\\run"]),
    ).toMatchObject({
      runSources: [{ label: "one", path: "data\\\\archive\\\\phase9.28\\\\run" }],
    });
  });
});
