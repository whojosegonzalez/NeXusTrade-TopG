import { describe, expect, it } from "vitest";
import { deriveThirdQuartile0Based } from "./FormulationBQuantile.js";

describe("FormulationBQuantile (0-based Indexing)", () => {
  it("derives Q3 accurately for 8 values using ceil(0.75 * 7) = index 6", () => {
    // 0-based: [1, 2, 3, 4, 5, 6, 7, 8] -> indices 0..7
    // k = ceil(0.75 * 7) = ceil(5.25) = 6
    // value at index 6 is 7
    const result = deriveThirdQuartile0Based([8, 1, 4, 2, 7, 3, 6, 5]);
    expect(result.n).toBe(8);
    expect(result.index0Based).toBe(6);
    expect(result.q3).toBe(7);
  });

  it("derives Q3 accurately for 10 values using ceil(0.75 * 9) = index 7", () => {
    // [0, 10, 20, 30, 40, 50, 60, 70, 80, 90] -> indices 0..9
    // k = ceil(0.75 * 9) = ceil(6.75) = 7
    // value at index 7 is 70
    const values = [90, 10, 40, 0, 70, 20, 80, 50, 30, 60];
    const result = deriveThirdQuartile0Based(values);
    expect(result.n).toBe(10);
    expect(result.index0Based).toBe(7);
    expect(result.q3).toBe(70);
  });

  it("handles identical values correctly", () => {
    const result = deriveThirdQuartile0Based([5, 5, 5, 5, 5, 5, 5, 5]);
    expect(result.q3).toBe(5);
    expect(result.index0Based).toBe(6);
  });

  it("handles negative and continuous floating point acceleration values", () => {
    const values = [-12.5, -5.2, -1.0, 0.5, 2.3, 7.8, 14.1, 25.0];
    const result = deriveThirdQuartile0Based(values);
    expect(result.n).toBe(8);
    expect(result.index0Based).toBe(6);
    expect(result.q3).toBe(14.1);
  });

  it("handles 48-element vector boundary condition (standard cohort partition)", () => {
    // n = 48 -> k = ceil(0.75 * 47) = ceil(35.25) = 36
    const values = Array.from({ length: 48 }, (_, i) => i * 2); // 0, 2, 4, ..., 94
    const result = deriveThirdQuartile0Based(values);
    expect(result.n).toBe(48);
    expect(result.index0Based).toBe(36);
    expect(result.q3).toBe(72);
  });

  it("throws error for empty array", () => {
    expect(() => deriveThirdQuartile0Based([])).toThrow("FORMULATION_B_QUANTILE_EMPTY_ARRAY");
  });
});
