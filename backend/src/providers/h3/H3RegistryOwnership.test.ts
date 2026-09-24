import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderHttpClientOptions, ProviderHttpClient } from "../http/ProviderHttpClient.js";
import type * as HttpModule from "../http/ProviderHttpClient.js";
import { ProviderRateLimiter } from "../http/providerRateLimiter.js";
import { createProviderConfig } from "../config/providerConfig.js";
import { createProviderRegistry } from "../ProviderRegistry.js";
import { H3FakeScheduler } from "./H3FakeScheduler.js";

const captured = vi.hoisted(() => ({
  clients: [] as { options: ProviderHttpClientOptions; client: ProviderHttpClient }[],
  calls: [] as string[],
}));
vi.mock("../http/ProviderHttpClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof HttpModule>();
  return {
    ...actual,
    ProviderHttpClient: class extends actual.ProviderHttpClient {
      constructor(options: ProviderHttpClientOptions) {
        super({
          ...options,
          fetchImpl: async (input) => {
            captured.calls.push(String(input));
            return new Response("{}");
          },
        });
        captured.clients.push({ options, client: this });
      }
    },
  };
});

function registry(rateLimiter?: ProviderRateLimiter) {
  const config = createProviderConfig({
    NODE_ENV: "test",
    PROVIDERS_ENABLED: "JUPITER,RAYDIUM",
    JUPITER_API_KEY: "synthetic-fixture",
  });
  createProviderRegistry({
    config: {
      ...config,
      rateLimitsPerMinute: { ...config.rateLimitsPerMinute, JUPITER: 1, RAYDIUM: 1 },
    },
    mode: "PAPER",
    ...(rateLimiter ? { rateLimiter } : {}),
  });
}
describe("H3 registry admission ownership", () => {
  beforeEach(() => {
    captured.clients.length = 0;
    captured.calls.length = 0;
  });
  it("shares Jupiter and Raydium endpoints within a registry but isolates their provider budgets", async () => {
    const time = new H3FakeScheduler();
    const limiter = new ProviderRateLimiter(time.clock, time.sleep);
    registry(limiter);
    const jupiter = captured.clients.filter((entry) => entry.options.provider === "JUPITER");
    const raydium = captured.clients.filter((entry) => entry.options.provider === "RAYDIUM");
    expect(jupiter).toHaveLength(2);
    expect(raydium).toHaveLength(2);
    expect(captured.clients.every((entry) => entry.options.rateLimiter === limiter)).toBe(true);
    await jupiter[0]!.client.getJson();
    const jp = jupiter[1]!.client.getJson();
    await raydium[0]!.client.getJson();
    const rp = raydium[1]!.client.getJson();
    await time.flush();
    expect(captured.calls).toHaveLength(2);
    await time.advance(60_000);
    expect((await Promise.all([jp, rp])).every((result) => result.ok)).toBe(true);
    expect(captured.calls).toHaveLength(4);
  });
  it("creates distinct default instances and shares only an explicitly injected instance", () => {
    registry();
    registry();
    expect(captured.clients[0]!.options.rateLimiter).not.toBe(
      captured.clients[4]!.options.rateLimiter,
    );
    const shared = new ProviderRateLimiter();
    registry(shared);
    registry(shared);
    expect(captured.clients.slice(8).every((entry) => entry.options.rateLimiter === shared)).toBe(
      true,
    );
  });
});
