import { afterEach, describe, expect, it, vi } from "vitest";

import { loadDashboardData } from "./dashboardData.js";

const manifest = {
  contractVersion: "1",
  generatedAt: "2026-08-18T23:00:00.000Z",
  contentFingerprint: "a".repeat(64),
  archiveRoot: "data/archive",
  requestedPhaseIncludes: ["phase9.28", "phase9.29"],
  safety: {
    mode: "PAPER",
    shadowOnly: true,
    executionDisabled: true,
    buyScoreThreshold: 90,
    watchScoreThreshold: 70,
    providerCalls: false,
    databaseWrites: false,
    sessionCreation: false,
    walletLoaded: false,
    transactionSigning: false,
    transactionSubmission: false,
  },
  inputs: [],
  resources: {
    runs: { path: "runs.v1.json", sha256: "b".repeat(64), count: 0 },
    cohorts: { path: "cohorts.v1.json", sha256: "c".repeat(64), count: 0 },
    candidates: { path: "candidates.v1.json", sha256: "d".repeat(64), count: 0 },
  },
  skippedInputs: [],
  warnings: [],
};

afterEach(() => vi.unstubAllGlobals());

describe("loadDashboardData", () => {
  it("loads only approved local generated resources", async () => {
    const fetch = vi.fn(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => (input.endsWith("manifest.v1.json") ? manifest : []),
    }));
    vi.stubGlobal("fetch", fetch);

    const data = await loadDashboardData();

    expect(data.manifest.contentFingerprint).toBe("a".repeat(64));
    expect(fetch.mock.calls.map(([input]) => input)).toEqual([
      "/research-dashboard-data/manifest.v1.json",
      "/research-dashboard-data/runs.v1.json",
      "/research-dashboard-data/cohorts.v1.json",
      "/research-dashboard-data/candidates.v1.json",
    ]);
  });

  it("reports a missing generated resource without attempting an external request", async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetch);

    await expect(loadDashboardData()).rejects.toThrow("Could not load local dashboard data (404)");
    expect(fetch).toHaveBeenCalledWith("/research-dashboard-data/manifest.v1.json", {
      method: "GET",
      credentials: "same-origin",
    });
  });

  it("rejects malformed or partial dashboard data before rendering", async () => {
    const malformedFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ contractVersion: "incompatible" }),
    }));
    vi.stubGlobal("fetch", malformedFetch);
    await expect(loadDashboardData()).rejects.toThrow();

    const partialFetch = vi.fn(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => (input.endsWith("manifest.v1.json") ? manifest : [{}]),
    }));
    vi.stubGlobal("fetch", partialFetch);
    await expect(loadDashboardData()).rejects.toThrow();
  });
});
