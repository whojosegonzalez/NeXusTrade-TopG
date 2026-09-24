import { describe, expect, it } from "vitest";
import { ProviderRateLimiter } from "../http/providerRateLimiter.js";

describe("H3 concurrent admission", () => {
  it("H-03 permits only one waiting caller at each limit-one boundary", async () => {
    let now = 0;
    const sleepers: (() => void)[] = [];
    const limiter = new ProviderRateLimiter(
      () => now,
      () => new Promise<void>((resolve) => sleepers.push(resolve)),
    );
    await limiter.waitForSlot("MOCK", 1);
    const admitted: string[] = [];
    const a = limiter.waitForSlot("MOCK", 1).then(() => admitted.push("a"));
    const b = limiter.waitForSlot("MOCK", 1).then(() => admitted.push("b"));
    now = 60_000;
    for (const wake of sleepers.splice(0)) wake();
    for (let n = 0; n < 5; n++) await Promise.resolve();
    expect(admitted).toEqual(["a"]);
    now = 120_000;
    for (const wake of sleepers.splice(0)) wake();
    await Promise.all([a, b]);
    expect(admitted).toEqual(["a", "b"]);
  });
});
