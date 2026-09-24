import { describe, expect, it } from "vitest";

import { mergeTokenEnrichmentSources } from "./enrichment.types.js";

describe("token enrichment helpers", () => {
  it("adds provider sources without duplicates", () => {
    expect(mergeTokenEnrichmentSources(["DEXSCREENER"], "JUPITER")).toEqual([
      "DEXSCREENER",
      "JUPITER",
    ]);
    expect(mergeTokenEnrichmentSources(["DEXSCREENER"], "DEXSCREENER")).toEqual(["DEXSCREENER"]);
    expect(mergeTokenEnrichmentSources(["DEXSCREENER"], undefined)).toEqual(["DEXSCREENER"]);
  });
});
