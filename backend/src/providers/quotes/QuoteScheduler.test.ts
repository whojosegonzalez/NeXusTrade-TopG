import { describe, expect, it } from "vitest";

import { QuoteScheduler } from "./QuoteScheduler.js";

describe("QuoteScheduler", () => {
  it("spaces live calls for the same provider and operation", async () => {
    let nowMs = 1_000;
    const waits: number[] = [];
    const scheduler = new QuoteScheduler({
      enabled: true,
      minIntervalMsByProvider: { JUPITER: 100 },
      clock: () => nowMs,
      wait: async (ms) => {
        waits.push(ms);
        nowMs += ms;
      },
    });

    expect((await scheduler.schedule("JUPITER", "quote", async () => "first")).waitMs).toBe(0);
    expect((await scheduler.schedule("JUPITER", "quote", async () => "second")).waitMs).toBe(100);
    expect(waits).toEqual([100]);
  });

  it("keeps providers independent and does not delay when disabled", async () => {
    const enabled = new QuoteScheduler({
      enabled: true,
      minIntervalMsByProvider: { JUPITER: 100, RAYDIUM: 100 },
      clock: () => 1_000,
    });
    await enabled.schedule("JUPITER", "quote", async () => 1);
    expect((await enabled.schedule("RAYDIUM", "quote", async () => 2)).waitMs).toBe(0);

    const scheduler = new QuoteScheduler({
      enabled: false,
      minIntervalMsByProvider: { JUPITER: 100 },
    });

    expect((await scheduler.schedule("JUPITER", "quote", async () => 1)).waitMs).toBe(0);
  });
});
