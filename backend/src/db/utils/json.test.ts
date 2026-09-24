import { describe, expect, it } from "vitest";

import { parseJson, redactSensitiveFields, stringifyJson } from "./json.js";

describe("json utilities", () => {
  it("stringifies with sensitive fields redacted", () => {
    expect(
      stringifyJson({
        ok: true,
        apiKey: "abc",
        nested: {
          walletSecret: "def",
        },
      }),
    ).toBe('{"ok":true,"apiKey":"[REDACTED]","nested":{"walletSecret":"[REDACTED]"}}');
  });

  it("parses typed JSON values", () => {
    expect(parseJson<{ ok: true }>('{"ok":true}')).toEqual({ ok: true });
  });

  it("throws controlled parse errors", () => {
    expect(() => parseJson("{")).toThrow(/Failed to parse stored JSON/);
  });

  it("redacts nested arrays", () => {
    expect(
      redactSensitiveFields({
        items: [{ privateKey: "secret" }],
      }),
    ).toEqual({
      items: [{ privateKey: "[REDACTED]" }],
    });
  });
});
