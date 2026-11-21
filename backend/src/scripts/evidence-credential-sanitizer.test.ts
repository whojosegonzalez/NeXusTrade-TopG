/**
 * Evidence credential sanitizer: synthetic offline tests (assessment §8.38.17 item 17 D).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_REDACTED,
  EVIDENCE_REDACTED_PARTIAL,
  EVIDENCE_SANITIZER_LIMITS as L,
  deriveEvidenceSecrets,
  sanitizeEvidenceBytes,
  type SanitizedEvidenceBytes,
} from "./evidence-credential-sanitizer.js";

const KEY = "k3yS3cr3tAbCdEfGh1234";
const RPC_URL = `https://rpc.example.test/v1/abcdefghijklmnopqrstu?api-key=${KEY}&n=abc`;
const QUOTED = 'pa"ss_word99';
const SECRETS = deriveEvidenceSecrets([RPC_URL], [QUOTED]);
const COMPLETE = { partial: false, parseJson: true } as const;
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const utf8 = (s: string) => Buffer.from(s, "utf8");
const esc = (s: string) =>
  [...s].map((c) => `\\u00${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");
const pct = (s: string) =>
  [...s].map((c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).join("");

function stored(r: SanitizedEvidenceBytes): Buffer {
  if (r.status !== "STORED") throw new Error(`not stored: ${r.reason}`);
  return r.encoding === "utf8" ? utf8(r.stored) : Buffer.from(r.stored, "base64");
}
const thrown = (fn: () => unknown): Error => {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a throw");
};
/** No credential, credential prefix, host or path secret in any rendering of `v`. */
function expectSecretFree(v: unknown, label = "value"): void {
  const text = (
    typeof v === "string" ? v : v instanceof Error ? `${v.message}\n${v.stack}` : JSON.stringify(v)
  ).toLowerCase();
  for (const f of [
    KEY.slice(0, 8),
    "rpc.example.test",
    'pa"ss',
    'pa\\"ss',
    "abcdefghijklmnopqrstu",
  ]) {
    expect(text, `${label}: ${f}`).not.toContain(f.toLowerCase());
  }
}
function trapCounter<T extends object>(t: T): { proxy: T; traps: () => number } {
  let n = 0;
  const handler: ProxyHandler<T> = {};
  for (const trap of [
    "get",
    "has",
    "ownKeys",
    "getOwnPropertyDescriptor",
    "getPrototypeOf",
    "isExtensible",
    "preventExtensions",
    "defineProperty",
    "set",
  ] as const) {
    (handler as Record<string, unknown>)[trap] = (...a: unknown[]) => {
      n++;
      return (Reflect[trap] as (...x: unknown[]) => unknown)(...a);
    };
  }
  return { proxy: new Proxy(t, handler), traps: () => n };
}
const revoked = <T extends object>(t: T): T => {
  const r = Proxy.revocable(t, {});
  r.revoke();
  return r.proxy;
};

describe("evidence credential sanitizer (synthetic, offline)", () => {
  it("S1: derivation keeps the reviewed rules, longest first, frozen, without touching the inputs", () => {
    const urls = [
      "https://user1:pw-secret-9@host.example.test/aaaaaaaaaaaaaaaa/short?k=sixsix&s=five5",
      "not a url at all",
    ];
    const additional = ["extra-secret"];
    const s = deriveEvidenceSecrets(urls, additional);
    expect([...s].sort()).toEqual(
      [
        urls[0],
        "user1",
        "pw-secret-9",
        "aaaaaaaaaaaaaaaa", // path segment of 16
        "sixsix", // query value of 6
        "not a url at all",
        "extra-secret",
      ].sort(),
    );
    expect(s).not.toContain("short"); // path segment of 5
    expect(s).not.toContain("five5"); // query value of 5
    for (let i = 1; i < s.length; i++)
      expect(s[i - 1]!.length).toBeGreaterThanOrEqual(s[i]!.length);
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(urls) || Object.isFrozen(additional)).toBe(false);
    expect(urls).toHaveLength(2);
    // Duplicates collapse.
    expect(deriveEvidenceSecrets([KEY, KEY], [KEY])).toEqual([KEY]);
  });

  it("S2: derivation input is validated without coercion, getters or traps, with fixed messages", () => {
    let runs = 0;
    const getterUrls = [RPC_URL];
    Object.defineProperty(getterUrls, 0, { get: () => (runs++, RPC_URL) });
    const trap = trapCounter([RPC_URL]);
    const cases: [unknown, unknown, RegExp][] = [
      [RPC_URL, [], /urls must be/],
      [trap.proxy, [], /urls must be/],
      [revoked([RPC_URL]), [], /urls must be/],
      [getterUrls, [], /urls must be/],
      [[new String(RPC_URL)], [], /urls must be/],
      [Array.from({ length: L.maxUrls + 1 }, () => RPC_URL), [], /urls must be/],
      [[""], [], /each url must be/],
      [["x".repeat(L.maxSecretChars + 1)], [], /each url must be/],
      [[RPC_URL], revoked([KEY]), /additional must be/],
      [[RPC_URL], [KEY.slice(0, 5)], /each additional secret/],
      [[], [], /at least one credential/],
    ];
    for (const [urls, additional, re] of cases) {
      const e = thrown(() => deriveEvidenceSecrets(urls as never, additional as never));
      expect(e.message, String(re)).toMatch(re);
      expect(e.message.startsWith("[EVIDENCE_SANITIZER_INPUT] ")).toBe(true);
      expectSecretFree(e, String(re));
    }
    expect(runs).toBe(0);
    expect(trap.traps()).toBe(0);
  });

  it("S3: clean UTF-8 and binary payloads round-trip byte for byte", () => {
    const json = utf8(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: "é ✓", n: [1, 2] } }));
    const r = sanitizeEvidenceBytes(json, SECRETS, COMPLETE);
    expect(r).toMatchObject({
      status: "STORED",
      encoding: "utf8",
      redacted: false,
      redactions: 0,
      jsonInspection: "INSPECTED",
      storedBytes: json.length,
      originalBytes: json.length,
    });
    expect(stored(r).equals(json)).toBe(true);
    expect(r.status === "STORED" && r.storedSha256).toBe(sha256(json));
    const binary = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x7f, 0xc3, 0x28]);
    const b = sanitizeEvidenceBytes(binary, SECRETS, { partial: false, parseJson: true });
    expect(b).toMatchObject({
      status: "STORED",
      encoding: "base64",
      redacted: false,
      jsonInspection: "NOT_UTF8",
    });
    expect(stored(b).equals(binary)).toBe(true);
    const empty = sanitizeEvidenceBytes(new Uint8Array(0), SECRETS, COMPLETE);
    expect(empty).toMatchObject({ status: "STORED", storedBytes: 0, jsonInspection: "NOT_JSON" });
    // Only a view's own bytes are read; a shadowed length is ignored.
    const framed = Buffer.concat([utf8("XX"), json, utf8("YY")]);
    expect(
      stored(sanitizeEvidenceBytes(framed.subarray(2, 2 + json.length), SECRETS, COMPLETE)).equals(
        json,
      ),
    ).toBe(true);
    const shadow = Buffer.from(json);
    Object.defineProperty(shadow, "length", { value: 1 });
    Object.defineProperty(shadow, "byteLength", { value: 1 });
    expect(sanitizeEvidenceBytes(shadow, SECRETS, COMPLETE).originalBytes).toBe(json.length);
  });

  it("S4: literal, escaped, mixed and case-varied credentials are redacted on bytes before encoding", () => {
    const mixed = [...KEY].map((c, i) => (i % 2 ? esc(c) : c)).join("");
    for (const [label, form] of [
      ["literal", KEY],
      ["escaped", esc(KEY)],
      ["escaped upper-case hex", esc(KEY).toUpperCase().replace(/\\U00/g, "\\u00")],
      ["mixed", mixed],
      ["literal other case", KEY.toUpperCase()],
    ] as const) {
      const body = utf8(`{"log":"before ${form} after"}`);
      const r = sanitizeEvidenceBytes(body, SECRETS, COMPLETE);
      expect(r.status, label).toBe("STORED");
      const out = stored(r).toString("utf8");
      expect(out, label).toBe(`{"log":"before ${EVIDENCE_REDACTED} after"}`);
      expect(r.status === "STORED" && r.redacted && r.redactions, label).toBe(1);
      expect(r.status === "STORED" && r.storedSha256, label).toBe(sha256(stored(r)));
      expect(r.status === "STORED" && r.originalSha256, label).toBe(sha256(body));
      expectSecretFree(r, label);
    }
    // Credential-bearing invalid UTF-8: redacted on bytes, stored as base64 of the sanitized bytes.
    const bin = Buffer.concat([Buffer.from([0xff, 0x00]), utf8(KEY), Buffer.from([0xfe])]);
    const b = sanitizeEvidenceBytes(bin, SECRETS, COMPLETE);
    expect(b).toMatchObject({ status: "STORED", encoding: "base64", redacted: true });
    const decoded = stored(b);
    expect(
      decoded.equals(
        Buffer.concat([Buffer.from([0xff, 0x00]), utf8(EVIDENCE_REDACTED), Buffer.from([0xfe])]),
      ),
    ).toBe(true);
    expect(decoded.includes(utf8(KEY))).toBe(false);
    expect(b.status === "STORED" && b.storedSha256).toBe(sha256(decoded));
    expect(b.status === "STORED" && b.storedSha256).not.toBe(b.originalSha256);
    expectSecretFree(b, "binary");
  });

  it("S5: partial payloads redact trailing fragments of at least four characters, including inside escapes", () => {
    const partial = { partial: true, parseJson: false } as const;
    const cases: [string, string, boolean][] = [
      ["literal 4", KEY.slice(0, 4), true],
      ["literal 12", KEY.slice(0, 12), true],
      ["escaped 5", esc(KEY.slice(0, 5)), true],
      ["mixed 6", KEY.slice(0, 3) + esc(KEY.slice(3, 6)), true],
      ["truncated escape after 4", KEY.slice(0, 4) + "\\u00", true],
      ["truncated escape inside the 5th", KEY.slice(0, 4) + esc(KEY[4]!).slice(0, 5), true],
      ["literal 3 (below the minimum)", KEY.slice(0, 3), false],
    ];
    for (const [label, tail, redacted] of cases) {
      const body = utf8(`{"log":"prefix ${tail}`);
      const r = sanitizeEvidenceBytes(body, SECRETS, partial);
      expect(r.status, label).toBe("STORED");
      const out = stored(r).toString("utf8");
      if (redacted) {
        expect(out, label).toBe(`{"log":"prefix ${EVIDENCE_REDACTED_PARTIAL}`);
        expect(r.status === "STORED" && r.partialFragmentRedacted, label).toBe(true);
      } else {
        expect(out, label).toBe(`{"log":"prefix ${tail}`);
        expect(r.status === "STORED" && r.redacted, label).toBe(false);
      }
    }
    // The same tail in a complete payload is not a fragment (only whole forms are redacted there).
    const complete = sanitizeEvidenceBytes(utf8(`x ${KEY.slice(0, 4)}`), SECRETS, {
      partial: false,
      parseJson: false,
    });
    expect(stored(complete).toString()).toBe(`x ${KEY.slice(0, 4)}`);
  });

  it("S6: forms that are only detectable withhold the payload; parsed keys and values are inspected", () => {
    const withheld = (body: string, scope: { partial: boolean; parseJson: boolean } = COMPLETE) =>
      sanitizeEvidenceBytes(utf8(body), SECRETS, scope);
    const cases: [string, string][] = [
      ["percent-encoded", `{"log":"${pct(KEY)}"}`],
      [
        "\\x-escaped",
        `{"log":"${[...KEY].map((c) => `\\\\x${c.charCodeAt(0).toString(16)}`).join("")}"}`,
      ],
      ["eight-character prefix", `{"log":"${KEY.slice(0, 8)}"}`],
      ["parsed value only (JSON quote escape)", JSON.stringify({ log: `x ${QUOTED} y` })],
      ["parsed key only", JSON.stringify({ [QUOTED]: 1 })],
    ];
    for (const [label, body] of cases) {
      const r = withheld(body);
      expect(r, label).toMatchObject({
        status: "WITHHELD",
        reason: "CREDENTIAL_MATERIAL_DETECTED",
      });
      expectSecretFree(r, label);
    }
    // Without JSON (plain text, binary, or parsing not requested), the raw scan alone detects.
    const rawOnly: [string, Buffer, { partial: boolean; parseJson: boolean }][] = [
      ["plain text, percent-encoded", utf8(`log line ${pct(KEY)}`), COMPLETE],
      [
        "binary, eight-character prefix",
        Buffer.concat([Buffer.from([0xff]), utf8(KEY.slice(0, 8))]),
        COMPLETE,
      ],
      [
        "JSON not requested, backslash-x escaped",
        utf8('{"l":"' + "\\x" + KEY.charCodeAt(0).toString(16) + KEY.slice(1) + '"}'),
        { partial: false, parseJson: false },
      ],
    ];
    for (const [label, body, scope] of rawOnly) {
      expect(sanitizeEvidenceBytes(body, SECRETS, scope), label).toMatchObject({
        status: "WITHHELD",
        reason: "CREDENTIAL_MATERIAL_DETECTED",
      });
    }
    // The parsed-only forms need parsing: without it they are reported as not inspected.
    const notParsed = withheld(JSON.stringify({ log: QUOTED }), {
      partial: false,
      parseJson: false,
    });
    expect(notParsed).toMatchObject({ status: "STORED", jsonInspection: "NOT_REQUESTED" });
    // Escapes nested beyond the decoding bound are inconclusive.
    let nested = "%41";
    for (let i = 0; i < 6; i++) nested = nested.replace(/%/g, "%25");
    expect(withheld(`{"log":"${nested}"}`)).toMatchObject({
      status: "WITHHELD",
      reason: "CREDENTIAL_SCAN_INCONCLUSIVE",
    });
    // Within the bound, decoded clean text is stored unchanged.
    const twice = "%2541";
    const ok = withheld(`{"log":"${twice}"}`);
    expect(stored(ok).toString()).toBe(`{"log":"${twice}"}`);
  });

  it("S7: residue refuses the seal; marker collisions are refused or counted", () => {
    // Redacting the shorter secret creates the longer one (already processed): residue.
    const e = thrown(() =>
      sanitizeEvidenceBytes(utf8("xx abcdefzzzzz yy"), ["ED]zzzzz", "abcdef"], COMPLETE),
    );
    expect(e.message).toBe("[SEAL_REFUSED] CREDENTIAL_BYTES_REMAIN");
    // Secrets that a marker would contain are refused before any work.
    for (const s of ["REDACTED", "[REDACTED]", "redacted_partial", "ACTED]"]) {
      const m = thrown(() => sanitizeEvidenceBytes(utf8("x"), [s], COMPLETE)).message;
      expect(m, s).toBe("[EVIDENCE_SANITIZER_INPUT] a secret collides with a redaction marker");
    }
    // Marker text already in the original is kept byte for byte and counted.
    const body = utf8(
      `{"log":"${EVIDENCE_REDACTED} and ${EVIDENCE_REDACTED_PARTIAL} then ${KEY}"}`,
    );
    const r = sanitizeEvidenceBytes(body, SECRETS, COMPLETE);
    expect(r).toMatchObject({
      status: "STORED",
      preexistingMarkers: 2,
      redactions: 1,
      redacted: true,
    });
    expect(stored(r).toString()).toBe(
      `{"log":"${EVIDENCE_REDACTED} and ${EVIDENCE_REDACTED_PARTIAL} then ${EVIDENCE_REDACTED}"}`,
    );
  });

  it("S8: wide and deep JSON within bounds is inspected; beyond the bounds it is withheld", () => {
    const wide = utf8(JSON.stringify(Array.from({ length: 200_000 }, (_, i) => `v${i}`)));
    expect(sanitizeEvidenceBytes(wide, SECRETS, COMPLETE)).toMatchObject({
      status: "STORED",
      jsonInspection: "INSPECTED",
    });
    const wideHidden = utf8(
      JSON.stringify([...Array.from({ length: 200_000 }, () => 0), { [QUOTED]: 1 }]),
    );
    expect(sanitizeEvidenceBytes(wideHidden, SECRETS, COMPLETE)).toMatchObject({
      status: "WITHHELD",
      reason: "CREDENTIAL_MATERIAL_DETECTED",
    });
    const depth = 5_000;
    const deep = utf8("[".repeat(depth) + JSON.stringify(QUOTED) + "]".repeat(depth));
    expect(sanitizeEvidenceBytes(deep, SECRETS, COMPLETE)).toMatchObject({
      status: "WITHHELD",
      reason: "CREDENTIAL_MATERIAL_DETECTED",
      jsonInspection: "INSPECTED",
    });
    const deepClean = utf8("[".repeat(depth) + "1" + "]".repeat(depth));
    expect(sanitizeEvidenceBytes(deepClean, SECRETS, COMPLETE)).toMatchObject({ status: "STORED" });
    // Beyond the node bound (or the parser's own depth): withheld, never stored uninspected.
    const tooMany = utf8("[" + "0,".repeat(L.maxJsonNodes) + "0]");
    expect(sanitizeEvidenceBytes(tooMany, SECRETS, COMPLETE)).toMatchObject({
      status: "WITHHELD",
      reason: "SCAN_BUDGET_EXHAUSTED",
    });
    const tooDeep = utf8("[".repeat(L.maxJsonDepth + 10) + "]".repeat(L.maxJsonDepth + 10));
    expect(sanitizeEvidenceBytes(tooDeep, SECRETS, COMPLETE)).toMatchObject({
      status: "WITHHELD",
      reason: "SCAN_BUDGET_EXHAUSTED",
    });
  });

  it("S9: payload and output bounds", () => {
    const atLimit = Buffer.alloc(L.maxPayloadBytes, 0x61);
    expect(sanitizeEvidenceBytes(atLimit, [KEY], { partial: false, parseJson: false }).status).toBe(
      "STORED",
    );
    const over = Buffer.alloc(L.maxPayloadBytes + 1, 0x61);
    expect(thrown(() => sanitizeEvidenceBytes(over, [KEY], COMPLETE)).message).toBe(
      `[EVIDENCE_SANITIZER_INPUT] original must be at most ${L.maxPayloadBytes} bytes`,
    );
    // Markers growing a payload past 2 x original + 4096 bytes are withheld, never built.
    const growth = Buffer.alloc(10_000, 0x71); // "q" x 10000 with secret "q": 10x growth
    expect(
      sanitizeEvidenceBytes(growth, ["q"], { partial: false, parseJson: false }),
    ).toMatchObject({
      status: "WITHHELD",
      reason: "OUTPUT_LIMIT_EXCEEDED",
    });
    const escapedGrowth = utf8("\\u0071".repeat(100) + "q".repeat(5_000));
    expect(
      sanitizeEvidenceBytes(escapedGrowth, ["q"], { partial: false, parseJson: false }),
    ).toMatchObject({
      status: "WITHHELD",
      reason: "OUTPUT_LIMIT_EXCEEDED",
    });
    const fits = utf8("aqa");
    expect(
      stored(sanitizeEvidenceBytes(fits, ["q"], { partial: false, parseJson: false })).toString(),
    ).toBe(`a${EVIDENCE_REDACTED}a`);
  });

  it("S10: sanitize input is validated without getters or traps, and caller values stay unchanged", () => {
    let runs = 0;
    const getterSecrets = [KEY];
    Object.defineProperty(getterSecrets, 0, { get: () => (runs++, KEY) });
    const getterScope = { partial: false };
    Object.defineProperty(getterScope, "parseJson", {
      get: () => (runs++, true),
      enumerable: true,
    });
    const viewTrap = trapCounter(utf8("x"));
    const secretsTrap = trapCounter([KEY]);
    const scopeTrap = trapCounter({ partial: false, parseJson: true });
    const det = new ArrayBuffer(4);
    const detView = new Uint8Array(det);
    structuredClone(det, { transfer: [det] });
    const body = utf8(`{"k":"${KEY}"}`);
    const cases: [unknown, unknown, unknown, string][] = [
      ["text", SECRETS, COMPLETE, "original must be a genuine Uint8Array"],
      [new Uint16Array(2), SECRETS, COMPLETE, "original must be a genuine Uint8Array"],
      [body.buffer, SECRETS, COMPLETE, "original must be a genuine Uint8Array"],
      [viewTrap.proxy, SECRETS, COMPLETE, "original must be a genuine Uint8Array"],
      [revoked(utf8("x")), SECRETS, COMPLETE, "original must be a genuine Uint8Array"],
      [detView, SECRETS, COMPLETE, "original must be a genuine Uint8Array"],
      [body, [], COMPLETE, `secrets must be an array of 1..${L.maxSecrets} strings`],
      [body, KEY, COMPLETE, `secrets must be an array of 1..${L.maxSecrets} strings`],
      [body, secretsTrap.proxy, COMPLETE, `secrets must be an array of 1..${L.maxSecrets} strings`],
      [body, revoked([KEY]), COMPLETE, `secrets must be an array of 1..${L.maxSecrets} strings`],
      [body, getterSecrets, COMPLETE, `secrets must be an array of 1..${L.maxSecrets} strings`],
      [body, [KEY, 5], COMPLETE, `secrets must be an array of 1..${L.maxSecrets} strings`],
      [
        body,
        Array.from({ length: L.maxSecrets + 1 }, (_, i) => `${KEY}${i}`),
        COMPLETE,
        `secrets must be an array of 1..${L.maxSecrets} strings`,
      ],
      [body, [""], COMPLETE, `each secret must be 1..${L.maxSecretChars} characters`],
      [
        body,
        ["s".repeat(L.maxSecretChars + 1)],
        COMPLETE,
        `each secret must be 1..${L.maxSecretChars} characters`,
      ],
      [body, SECRETS, { partial: false }, "scope must be exactly { partial, parseJson } booleans"],
      [
        body,
        SECRETS,
        { partial: 0, parseJson: true },
        "scope must be exactly { partial, parseJson } booleans",
      ],
      [
        body,
        SECRETS,
        { ...COMPLETE, extra: 1 },
        "scope must be exactly { partial, parseJson } booleans",
      ],
      [body, SECRETS, getterScope, "scope must be exactly { partial, parseJson } booleans"],
      [body, SECRETS, scopeTrap.proxy, "scope must be exactly { partial, parseJson } booleans"],
      [
        body,
        SECRETS,
        revoked({ ...COMPLETE }),
        "scope must be exactly { partial, parseJson } booleans",
      ],
    ];
    for (const [o, s, sc, message] of cases) {
      const e = thrown(() => sanitizeEvidenceBytes(o as never, s as never, sc as never));
      expect(e.message, message).toBe(`[EVIDENCE_SANITIZER_INPUT] ${message}`);
      expectSecretFree(e, message);
    }
    expect(runs).toBe(0);
    expect(viewTrap.traps() + secretsTrap.traps() + scopeTrap.traps()).toBe(0);
    // Caller values: unchanged and never frozen.
    const callerBody = utf8(`{"k":"${KEY}"}`);
    const before = Buffer.from(callerBody);
    const callerSecrets = [...SECRETS];
    const callerScope = { partial: false, parseJson: true };
    sanitizeEvidenceBytes(callerBody, callerSecrets, callerScope);
    expect(callerBody.equals(before)).toBe(true);
    expect(Object.isFrozen(callerSecrets) || Object.isFrozen(callerScope)).toBe(false);
    expect(callerSecrets).toEqual([...SECRETS]);
  });

  it("S11: results are frozen, secret-free and truthful about digests", () => {
    const bodies = [
      utf8(`{"a":"${KEY}","b":"${esc(KEY)}","url":"${RPC_URL}"}`),
      utf8(`{"x":"${pct(KEY)}"}`),
      Buffer.concat([utf8(KEY), Buffer.from([0xff])]),
    ];
    for (const body of bodies) {
      const r = sanitizeEvidenceBytes(body, SECRETS, COMPLETE);
      expect(Object.isFrozen(r)).toBe(true);
      expect(r.originalSha256).toBe(sha256(body));
      expect(r.originalBytes).toBe(body.length);
      expectSecretFree(r, r.status);
      if (r.status === "STORED") {
        expect(r.storedSha256).toBe(sha256(stored(r)));
        expect(r.storedSha256).not.toBe(r.originalSha256);
        expect(r.redacted).toBe(true);
      }
    }
  });

  it("S12: source boundary: no file, environment, network, timer, clock or logging use", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./evidence-credential-sanitizer.ts", import.meta.url)),
      "utf8",
    );
    const imports = [...src.matchAll(/^import[^;]*from "([^"]+)";/gm)].map((m) => m[1]);
    expect(imports).toEqual(["node:crypto", "node:util"]);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const forbidden of [
      /require\(/,
      /node:fs|node:net|node:tls|node:http|node:dns|node:child_process/,
      /process\./,
      /console\./,
      /fetch\(/,
      /setTimeout|setInterval|setImmediate/,
      /Date\.now|new Date/,
      /\.stringify\(/,
    ]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
  });
});
