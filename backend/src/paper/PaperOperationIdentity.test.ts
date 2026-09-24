import { describe, expect, it } from "vitest";
import { identifyPaperOperation } from "./PaperOperationIdentity.js";

const buy = {
  version: 1,
  mode: "PAPER",
  side: "BUY",
  sessionId: "session",
  sourceId: "decision",
  mint: "mint",
  radarId: "radar",
  explicitIntentId: "initial",
  requestedLamports: 10_000_000,
  baseFeeLamports: 5_000,
  priorityFeeLamports: 0,
  slippageBps: 100,
  quoteSource: "TOKEN_RADAR_PRICE",
};
describe("H2 operation identity contract", () => {
  it("keeps restart/key-order replay stable without volatile inputs", () => {
    const reversed = Object.fromEntries(Object.entries(buy).reverse());
    expect(identifyPaperOperation(JSON.parse(JSON.stringify(reversed)))).toEqual(
      identifyPaperOperation(buy),
    );
  });
  it("keeps the logical key but conflicts on changed economics", () => {
    const old = identifyPaperOperation(buy);
    const changed = identifyPaperOperation({ ...buy, baseFeeLamports: 6_000 });
    expect(changed.id).toBe(old.id);
    expect(changed.intentDigest).not.toBe(old.intentDigest);
  });
  it.each(["sessionId", "sourceId", "explicitIntentId"])("distinguishes new %s intent", (key) => {
    expect(identifyPaperOperation({ ...buy, [key]: "different" }).id).not.toBe(
      identifyPaperOperation(buy).id,
    );
  });
  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid lamports %s",
    (amount) => {
      expect(() => identifyPaperOperation({ ...buy, requestedLamports: amount })).toThrow(
        "INVALID_INTENT",
      );
    },
  );
  it("rejects unknown fields and unversioned input", () => {
    expect(() => identifyPaperOperation({ ...buy, quoteTimestamp: 1 })).toThrow("INVALID_INTENT");
    expect(() => identifyPaperOperation({ ...buy, version: 2 })).toThrow("INVALID_INTENT");
  });
  it("canonicalizes full SELL quantities without floating point loss and binds trigger policy", () => {
    const { radarId: _radar, requestedLamports: _amount, ...common } = buy;
    void _radar;
    void _amount;
    const sell = {
      ...common,
      side: "SELL",
      sourceId: "position",
      tokens: "00010.000000000000000001",
      allowCachedRadarPrice: false,
      maxCachedPriceAgeMs: 60_000,
      trigger: { type: "SELL_ALL" },
    };
    const first = identifyPaperOperation(sell);
    expect(first).toEqual(identifyPaperOperation({ ...sell, tokens: "10.000000000000000001" }));
    const changed = identifyPaperOperation({ ...sell, allowCachedRadarPrice: true });
    expect(changed.id).toBe(first.id);
    expect(changed.intentDigest).not.toBe(first.intentDigest);
    expect(() => identifyPaperOperation({ ...sell, tokens: "0" })).toThrow("INVALID_INTENT");
    expect(() =>
      identifyPaperOperation({ ...sell, trigger: { type: "MINT", mintAddress: "other" } }),
    ).toThrow("INVALID_INTENT");
  });
});
