import { describe, expect, it } from "vitest";

import { getHealthCheck } from "./healthCheck.js";

describe("getHealthCheck", () => {
  it("returns the app name, mode, node version, and status", () => {
    const health = getHealthCheck({
      appName: "NeXusTrade",
      mode: "PAPER",
    });

    expect(health.app).toBe("NeXusTrade");
    expect(health.mode).toBe("PAPER");
    expect(health.nodeVersion).toBe(process.version);
    expect(health.status).toBe("ok");
  });
});
