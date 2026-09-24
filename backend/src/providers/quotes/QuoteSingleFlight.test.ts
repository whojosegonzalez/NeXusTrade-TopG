import { describe, expect, it } from "vitest";

import { parseTokenMintAddress, type QuoteRequest } from "@nexustrade/shared";

import { QuoteSingleFlight } from "./QuoteSingleFlight.js";

const request: QuoteRequest = {
  inputMint: parseTokenMintAddress("So11111111111111111111111111111111111111112"),
  outputMint: parseTokenMintAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  amountRaw: "10000000",
};

describe("QuoteSingleFlight", () => {
  it("shares an in-flight identical request without caching the completed result", async () => {
    let calls = 0;
    let release: ((value: string) => void) | undefined;
    const flight = new QuoteSingleFlight({ enabled: true, ttlMs: 1_000 });
    const action = () => {
      calls += 1;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    };

    const first = flight.run("JUPITER", request, action);
    await Promise.resolve();
    const second = flight.run("JUPITER", request, action);
    release?.("quote");

    await expect(first).resolves.toMatchObject({ value: "quote", joined: false });
    await expect(second).resolves.toMatchObject({ value: "quote", joined: true, waiters: 1 });
    expect(calls).toBe(1);

    await flight.run("JUPITER", request, async () => {
      calls += 1;
      return "fresh";
    });
    expect(calls).toBe(2);
  });

  it("keeps distinct request keys separate and clears failures", async () => {
    let calls = 0;
    const flight = new QuoteSingleFlight({ enabled: true, ttlMs: 1_000 });

    await expect(
      flight.run("JUPITER", request, async () => {
        calls += 1;
        throw new Error("temporary failure");
      }),
    ).rejects.toThrow("temporary failure");

    await flight.run("JUPITER", { ...request, amountRaw: "20000000" }, async () => {
      calls += 1;
      return "different-key";
    });
    await flight.run("JUPITER", request, async () => {
      calls += 1;
      return "after-failure";
    });

    expect(calls).toBe(3);
  });
});
