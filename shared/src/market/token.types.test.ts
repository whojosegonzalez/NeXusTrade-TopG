import { describe, expect, it } from "vitest";

import { isSolanaMintAddress, parseTokenMintAddress } from "./token.types.js";

describe("token identity types", () => {
  it("accepts Solana mint-like base58 strings", () => {
    const mint = "So11111111111111111111111111111111111111112";

    expect(isSolanaMintAddress(mint)).toBe(true);
    expect(parseTokenMintAddress(mint)).toBe(mint);
  });

  it("rejects invalid mint-like strings", () => {
    expect(isSolanaMintAddress("not a mint")).toBe(false);
    expect(isSolanaMintAddress("0OIl11111111111111111111111111111111111111")).toBe(false);
    expect(() => parseTokenMintAddress("not a mint")).toThrow(/Invalid Solana mint address/);
  });
});
