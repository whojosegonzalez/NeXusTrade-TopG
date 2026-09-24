import { describe, expect, it } from "vitest";

import { toDate, toIsoString } from "./timestamps.js";

describe("timestamp utilities", () => {
  it("uses Unix milliseconds with UTC display helpers", () => {
    expect(toDate(0).getTime()).toBe(0);
    expect(toIsoString(0)).toBe("1970-01-01T00:00:00.000Z");
  });
});
