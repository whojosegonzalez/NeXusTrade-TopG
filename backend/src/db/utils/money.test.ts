import { describe, expect, it } from "vitest";

import { lamportsToSolString, solToLamports } from "./money.js";

describe("money utilities", () => {
  it("converts SOL strings to integer lamports", () => {
    expect(solToLamports("0.1")).toBe(100_000_000);
    expect(solToLamports("2")).toBe(2_000_000_000);
    expect(solToLamports("0.000000001")).toBe(1);
  });

  it("converts lamports to SOL display strings", () => {
    expect(lamportsToSolString(100_000_000)).toBe("0.1");
    expect(lamportsToSolString(2_000_000_001)).toBe("2.000000001");
  });

  it("rejects invalid or over-precise SOL values", () => {
    expect(() => solToLamports("-1")).toThrow(/Invalid SOL amount/);
    expect(() => solToLamports("0.0000000001")).toThrow(/Invalid SOL amount/);
  });
});
