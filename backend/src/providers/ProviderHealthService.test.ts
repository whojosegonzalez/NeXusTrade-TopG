import { afterEach, describe, expect, it } from "vitest";

import { createProviderError, providerFailure, providerSuccess } from "@nexustrade/shared";

import type { TestDatabaseContext } from "../db/testing/createTestDatabase.js";
import { createTestDatabase } from "../db/testing/createTestDatabase.js";
import { createRepositories } from "../db/repositories/index.js";
import { ProviderHealthService } from "./ProviderHealthService.js";

describe("ProviderHealthService", () => {
  let testDb: TestDatabaseContext | undefined;

  afterEach(() => {
    testDb?.cleanup();
    testDb = undefined;
  });

  it("writes provider health and system logs for success and failure", () => {
    testDb = createTestDatabase();
    const repos = createRepositories(testDb.context.db);
    const service = new ProviderHealthService({
      providerHealth: repos.providerHealth,
      systemLogs: repos.systemLogs,
    });

    service.recordResult(
      "price",
      providerSuccess({
        provider: "MOCK",
        data: { ok: true },
        latencyMs: 7,
      }),
    );
    service.recordResult(
      "quote",
      providerFailure({
        provider: "MOCK",
        error: createProviderError({
          code: "RATE_LIMITED",
          message: "Slow down.",
          statusCode: 429,
        }),
        latencyMs: 9,
      }),
    );

    expect(repos.providerHealth.listProviderHealth({ provider: "MOCK" })).toHaveLength(2);
    expect(repos.providerHealth.getLatestProviderStatus("MOCK")?.status).toBe("RATE_LIMITED");
    expect(repos.systemLogs.listLogs({ scope: "PROVIDER" })).toHaveLength(2);
  });
});
