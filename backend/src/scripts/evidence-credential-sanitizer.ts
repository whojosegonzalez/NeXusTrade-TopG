/**
 * Evidence credential sanitizer (assessment §8.38.17 item 17 D). Offline helper; no consumer yet.
 *
 * Credentials are supplied explicitly. The module reads no file, environment, network, socket,
 * clock or timer and never logs; it only derives secret values and sanitizes one byte payload.
 *
 * Provenance (ported, not imported; the source modules and their private helpers are unchanged):
 * - Secret derivation: `credentialSecrets` in `scripts/fresh-amm-v4-watch-evidence.ts` (whole URL,
 *   user name, password, query values of at least 6 characters, path segments of at least 16, and
 *   explicitly supplied secrets of at least 6), sorted longest first.
 * - Byte redaction: `byteSanitizer`, `fragmentCharsToEnd` and `trailingFragmentStart` in
 *   `scripts/fresh-amm-v4-watch-evidence.ts` (bytes mapped 1:1 to Latin-1; literal and `\u00XX`
 *   forms; trailing fragments of partial prefixes; refusal on residue), with the escaped-form
 *   pattern of `buildEscapedSecretRegex` in `candidate-scanner/SolanaTrackerBundlerCaptureTool.ts`.
 * - Detection: `scanString` and `scanAll` in
 *   `candidate-scanner/RaydiumCpmmTransactionSourceAdapter.ts` (8-character lower-cased prefixes;
 *   up to 4 rounds of backslash then percent decoding; parsed JSON keys and string values,
 *   traversed iteratively).
 *
 * Supported forms:
 * - REDACTED to `[REDACTED]`: each secret's UTF-8 bytes literally, and each character either
 *   literally or as `\u00XX` (hex in either case), mixed freely, matched case-insensitively.
 * - REDACTED to `[REDACTED_PARTIAL]` (only when `partial` is true): a trailing fragment covering at
 *   least 4 leading characters of a secret, literal, escaped or mixed, possibly cut inside an escape.
 *   A partial payload ending in fewer than 4 leading characters of a secret is not redacted.
 * - DETECTED (payload withheld, never redacted): after redaction, any secret's first 8 characters
 *   (the whole secret when shorter), matched exactly (case-preserving) and also case-insensitively
 *   through a context-free fold (`toLowerCase`, then final sigma `ς` mapped to `σ`, the only
 *   context-sensitive mapping of `toLowerCase`), in two compatible representations: its UTF-8
 *   bytes mapped to Latin-1 (matching literal and byte-level percent-encoded material) and its
 *   Unicode text (matching `\uXXXX` escapes including surrogate pairs, UTF-8 percent-encoding and
 *   parsed JSON). Both are searched in the raw payload's byte view and in its UTF-8 decoded view
 *   (which also covers literal and escaped characters mixed in one credential) and, for complete
 *   UTF-8 JSON, in every parsed key and string value, each also after up to 4 rounds of
 *   `\uXXXX`, `\xXX`, `\/` and percent decoding (runs of `%XX` decoded as UTF-8 when valid,
 *   otherwise byte for byte). Still changing after 4 rounds: inconclusive (withheld).
 * - DETECTED in partial payloads: a decoded tail that ends in at least 4 leading characters of a
 *   secret (in either representation, exactly or folded) is withheld; it cannot be redacted on
 *   bytes. No Unicode normalization is applied.
 * - Derivation also protects the strictly decoded form of URL user names, passwords and qualifying
 *   path segments, and the raw encoded form of qualifying query values; malformed or unsupported
 *   percent-encoding is refused.
 * Not redacted or detected: credentials split across separate payloads, transformed by other
 * encodings (base64, hex, compression), or shorter than the forms above.
 */
import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

// ---------------------------------------------------------------------------------------------
// Bounds (helper bounds; independent of any live request or response limit)
// ---------------------------------------------------------------------------------------------

export const EVIDENCE_REDACTED = "[REDACTED]";
export const EVIDENCE_REDACTED_PARTIAL = "[REDACTED_PARTIAL]";

export const EVIDENCE_SANITIZER_LIMITS = Object.freeze({
  /** Payload bytes accepted per call. */
  maxPayloadBytes: 8 * 1024 * 1024,
  /** Stored bytes may grow by markers to at most 2 x original + 4096 bytes. */
  outputGrowthFactor: 2,
  outputGrowthSlackBytes: 4096,
  /** Supplied URLs and additional secrets per derivation. */
  maxUrls: 16,
  maxAdditional: 64,
  /** Secrets per derivation result and per sanitize call. */
  maxSecrets: 128,
  /** Explicit additional secrets: at least this many characters. */
  minSuppliedSecretChars: 6,
  /** Every secret (and supplied URL): at most this many characters. */
  maxSecretChars: 4096,
  /** URL query values and path segments that become secrets. */
  minQueryValueChars: 6,
  minPathSegmentChars: 16,
  /** Detection: lower-cased leading characters of each secret. */
  detectionPrefixChars: 8,
  /** Detection: decoding rounds before a scan is inconclusive. */
  maxDecodeRounds: 4,
  /** Partial payloads: minimum credential characters in a redacted trailing fragment. */
  minTrailingFragmentChars: 4,
  /** Trailing-fragment matching steps per call (exhaustion withholds). */
  maxFragmentSteps: 20_000_000,
  /** Parsed JSON: nodes visited and nesting depth (exhaustion withholds). */
  maxJsonNodes: 2_000_000,
  maxJsonDepth: 100_000,
  /** Characters examined by detection across all strings and rounds (exhaustion withholds). */
  maxScanChars: 256 * 1024 * 1024,
} as const);

const L = EVIDENCE_SANITIZER_LIMITS;

// ---------------------------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------------------------

export interface EvidenceSanitizeScope {
  /** The payload is a bounded prefix of a longer body (trailing fragments are redacted). */
  readonly partial: boolean;
  /** Inspect parsed JSON keys and string values when the stored bytes are complete UTF-8 JSON. */
  readonly parseJson: boolean;
}

export type EvidenceJsonInspection =
  | "INSPECTED"
  | "NOT_REQUESTED"
  | "NOT_APPLICABLE_PARTIAL"
  | "NOT_UTF8"
  | "NOT_JSON"
  /** Parsing was requested, but the raw scan already found credential material. */
  | "SKIPPED_RAW_DETECTED";

export type EvidenceWithheldReason =
  | "CREDENTIAL_MATERIAL_DETECTED"
  | "CREDENTIAL_SCAN_INCONCLUSIVE"
  | "SCAN_BUDGET_EXHAUSTED"
  | "OUTPUT_LIMIT_EXCEEDED";

export type SanitizedEvidenceBytes =
  | {
      readonly status: "STORED";
      /** UTF-8 when the sanitized bytes are valid UTF-8, otherwise base64 of those bytes. */
      readonly encoding: "utf8" | "base64";
      readonly stored: string;
      /** Sanitized bytes (before encoding). */
      readonly storedBytes: number;
      /** SHA-256 of the sanitized bytes, before encoding. */
      readonly storedSha256: string;
      readonly originalBytes: number;
      /** SHA-256 of the original bytes (never of the stored text or a manifest file). */
      readonly originalSha256: string;
      /** True when the sanitized bytes differ from the original. */
      readonly redacted: boolean;
      /** `[REDACTED]` replacements made (literal and escaped forms). */
      readonly redactions: number;
      readonly partialFragmentRedacted: boolean;
      /** Marker texts already present in the original (so markers are not all redactions). */
      readonly preexistingMarkers: number;
      readonly jsonInspection: EvidenceJsonInspection;
    }
  | {
      readonly status: "WITHHELD";
      readonly reason: EvidenceWithheldReason;
      readonly originalBytes: number;
      readonly originalSha256: string;
      readonly jsonInspection: EvidenceJsonInspection | null;
    };

// ---------------------------------------------------------------------------------------------
// Safe input reading (no coercion, getter or proxy trap)
// ---------------------------------------------------------------------------------------------

const isProxy = utilTypes.isProxy;
const getOwnDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const NativeUint8Array = Uint8Array;
const TYPED_ARRAY_PROTOTYPE = getPrototypeOf(Uint8Array.prototype) as object;

function intrinsicGetter(proto: object, key: PropertyKey): (this: unknown) => unknown {
  const get = getOwnDescriptor(proto, key)?.get;
  if (typeof get !== "function") throw new Error("[EVIDENCE_SANITIZER_INIT] missing intrinsic");
  return get;
}
const typedArrayName = intrinsicGetter(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag);
const typedArrayBuffer = intrinsicGetter(TYPED_ARRAY_PROTOTYPE, "buffer");
const typedArrayByteOffset = intrinsicGetter(TYPED_ARRAY_PROTOTYPE, "byteOffset");
const typedArrayByteLength = intrinsicGetter(TYPED_ARRAY_PROTOTYPE, "byteLength");
const arrayBufferDetached = getOwnDescriptor(ArrayBuffer.prototype, "detached")?.get ?? null;

const isSafeNonNegative = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function inputError(message: string): Error {
  return new Error(`[EVIDENCE_SANITIZER_INPUT] ${message}`);
}

/** A genuine, non-proxy array of own data-property strings (copied); null otherwise. */
function readStringArray(v: unknown, maxLength: number): string[] | null {
  // The proxy check comes first: Array.isArray throws on a revoked proxy.
  if (isProxy(v) || !Array.isArray(v) || getPrototypeOf(v) !== Array.prototype) return null;
  const ld = getOwnDescriptor(v, "length");
  if (!ld || !("value" in ld) || !isSafeNonNegative(ld.value) || ld.value > maxLength) return null;
  const out: string[] = [];
  for (let i = 0; i < ld.value; i++) {
    const d = getOwnDescriptor(v, String(i));
    if (!d || !("value" in d) || typeof d.value !== "string") return null;
    out.push(d.value);
  }
  return out;
}

/** A copy of a genuine Uint8Array's own bytes, bounded before any copy; null otherwise. */
function payloadCopy(v: unknown): Buffer | "TOO_LARGE" | null {
  if (typeof v !== "object" || v === null || isProxy(v)) return null;
  try {
    if (Reflect.apply(typedArrayName, v, []) !== "Uint8Array") return null;
    const length = Reflect.apply(typedArrayByteLength, v, []);
    const offset = Reflect.apply(typedArrayByteOffset, v, []);
    if (!isSafeNonNegative(length) || !isSafeNonNegative(offset)) return null;
    const buffer = Reflect.apply(typedArrayBuffer, v, []) as ArrayBuffer;
    if (arrayBufferDetached !== null) {
      try {
        if (Reflect.apply(arrayBufferDetached, buffer, []) === true) return null;
      } catch {
        // A SharedArrayBuffer has no detached state.
      }
    }
    if (length > L.maxPayloadBytes) return "TOO_LARGE";
    return Buffer.from(new NativeUint8Array(buffer, offset, length));
  } catch {
    return null;
  }
}

/** Exactly { partial: boolean, parseJson: boolean } as own data properties; null otherwise. */
function readScope(v: unknown): EvidenceSanitizeScope | null {
  if (typeof v !== "object" || v === null || isProxy(v) || Array.isArray(v)) return null;
  const proto = getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return null;
  const keys = Reflect.ownKeys(v);
  if (keys.length !== 2) return null;
  const partial = getOwnDescriptor(v, "partial");
  const parseJson = getOwnDescriptor(v, "parseJson");
  if (!partial || !("value" in partial) || typeof partial.value !== "boolean") return null;
  if (!parseJson || !("value" in parseJson) || typeof parseJson.value !== "boolean") return null;
  return { partial: partial.value, parseJson: parseJson.value };
}

// ---------------------------------------------------------------------------------------------
// Secret derivation (ported from fresh-amm-v4-watch-evidence.ts `credentialSecrets`)
// ---------------------------------------------------------------------------------------------

/** One round of strict percent-decoding; malformed or non-UTF-8 sequences are refused. */
function decodeComponent(component: string): string {
  try {
    return decodeURIComponent(component);
  } catch {
    throw inputError("each url component must use valid percent-encoding");
  }
}

/**
 * Secret values from explicitly supplied endpoint URLs and additional secrets: the whole URL, its
 * user name and password, query values of at least 6 characters and path segments of at least 16,
 * plus each additional secret (at least 6 characters). Deduplicated, longest first, frozen. Inputs
 * are read without coercion, getters or proxy traps, and are neither mutated nor frozen.
 */
export function deriveEvidenceSecrets(
  urls: readonly string[],
  additional: readonly string[],
): readonly string[] {
  const u = readStringArray(urls, L.maxUrls);
  if (u === null) throw inputError(`urls must be an array of at most ${L.maxUrls} strings`);
  const a = readStringArray(additional, L.maxAdditional);
  if (a === null) {
    throw inputError(`additional must be an array of at most ${L.maxAdditional} strings`);
  }
  const secrets = new Set<string>();
  for (const raw of u) {
    if (raw.length === 0 || raw.length > L.maxSecretChars) {
      throw inputError(`each url must be 1..${L.maxSecretChars} characters`);
    }
    secrets.add(raw);
    let parsed: URL | null = null;
    try {
      parsed = new URL(raw);
    } catch {
      // Not a URL: the whole value is the secret.
    }
    if (parsed !== null) {
      // User name and password at any length (as reviewed), raw and strictly decoded.
      for (const component of [parsed.username, parsed.password]) {
        if (component) {
          secrets.add(component);
          const decoded = decodeComponent(component);
          if (decoded) secrets.add(decoded);
        }
      }
      // Query values: decoded (as reviewed) and raw encoded, each when it qualifies.
      for (const v of parsed.searchParams.values()) {
        if (v.length >= L.minQueryValueChars) secrets.add(v);
      }
      for (const pair of parsed.search.slice(1).split("&")) {
        const eq = pair.indexOf("=");
        const rawValue = eq === -1 ? "" : pair.slice(eq + 1);
        const decoded = decodeComponent(rawValue.replace(/\+/g, " "));
        if (rawValue.length >= L.minQueryValueChars) secrets.add(rawValue);
        if (decoded.length >= L.minQueryValueChars) secrets.add(decoded);
      }
      // Path segments: qualifying raw segments and their strictly decoded forms.
      for (const seg of parsed.pathname.split("/")) {
        if (seg.length >= L.minPathSegmentChars) {
          secrets.add(seg);
          const decoded = decodeComponent(seg);
          if (decoded) secrets.add(decoded);
        }
      }
    }
  }
  for (const s of a) {
    if (s.length < L.minSuppliedSecretChars || s.length > L.maxSecretChars) {
      throw inputError(
        `each additional secret must be ${L.minSuppliedSecretChars}..${L.maxSecretChars} characters`,
      );
    }
    secrets.add(s);
  }
  if (secrets.size === 0) throw inputError("at least one credential must be supplied");
  if (secrets.size > L.maxSecrets)
    throw inputError(`at most ${L.maxSecrets} secrets are supported`);
  for (const s of secrets) {
    if (s.length > L.maxSecretChars) {
      throw inputError(`each derived secret must be at most ${L.maxSecretChars} characters`);
    }
  }
  return Object.freeze([...secrets].sort((x, y) => y.length - x.length));
}

// ---------------------------------------------------------------------------------------------
// Byte redaction (ported from fresh-amm-v4-watch-evidence.ts `byteSanitizer`)
// ---------------------------------------------------------------------------------------------

/** `buildEscapedSecretRegex` (SolanaTrackerBundlerCaptureTool.ts): each char literal or \u00XX. */
function escapedSecretRegex(secret: string): RegExp | null {
  try {
    const charPatterns = Array.from(secret).map((char) => {
      const code = char.charCodeAt(0);
      const hexLower = code.toString(16).padStart(4, "0").toLowerCase();
      const hexUpper = hexLower.toUpperCase();
      const escapedChar = char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return `(?:${escapedChar}|\\\\u00(?:${hexLower.slice(2)}|${hexUpper.slice(2)}))`;
    });
    return new RegExp(charPatterns.join(""), "gi");
  } catch {
    return null;
  }
}

class BudgetExhausted extends Error {}
class OutputExceeded extends Error {}
class SealRefused extends Error {}

/**
 * Number of complete credential characters matched from `lower[pos]` (secret character `k` on)
 * when the match runs exactly to the end of the text, or -1 (watch-evidence rule). Each character
 * may appear literally or as `\u00XX`, and the text may end inside an escape sequence. A match of
 * the whole secret is not a trailing fragment. `steps` bounds the work.
 */
function fragmentCharsToEnd(
  lower: string,
  pos: number,
  secret: string,
  k: number,
  steps: { n: number },
): number {
  if (++steps.n > L.maxFragmentSteps) throw new BudgetExhausted();
  if (pos === lower.length) return k < secret.length ? k : -1;
  if (k === secret.length) return -1;
  const ch = secret[k] as string;
  let best = -1;
  if (lower[pos] === ch.toLowerCase()) {
    best = fragmentCharsToEnd(lower, pos + 1, secret, k + 1, steps);
  }
  const escape = `\\u00${ch.charCodeAt(0).toString(16).padStart(2, "0")}`.toLowerCase();
  const rest = lower.slice(pos, pos + escape.length);
  if (rest === escape) {
    best = Math.max(best, fragmentCharsToEnd(lower, pos + escape.length, secret, k + 1, steps));
  } else if (pos + rest.length === lower.length && escape.startsWith(rest)) {
    best = Math.max(best, k); // the retained prefix ends inside this character's escape sequence
  }
  return best;
}

/**
 * Start of the longest trailing fragment covering at least the minimum characters, or null. Only
 * the last `secret.length * 6` characters can hold one (an escaped character is at most six
 * bytes), so only that tail is lower-cased; positions are those of the full text.
 */
function trailingFragmentStart(text: string, secret: string, steps: { n: number }): number | null {
  const base = Math.max(0, text.length - secret.length * 6);
  const lower = text.slice(base).toLowerCase();
  for (let start = 0; start < lower.length; start++) {
    if (fragmentCharsToEnd(lower, start, secret, 0, steps) >= L.minTrailingFragmentChars) {
      return base + start;
    }
  }
  return null;
}

function countOccurrences(text: string, needle: string): number {
  let n = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) n++;
  return n;
}

// ---------------------------------------------------------------------------------------------
// Detection (ported from RaydiumCpmmTransactionSourceAdapter.ts `scanString` / `scanAll`)
// ---------------------------------------------------------------------------------------------

const unescapeBackslash = (s: string) =>
  s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, "/");
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lenientUtf8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
/** Runs of `%XX` decode as UTF-8 text when valid, otherwise byte for byte (Latin-1). */
const percentDecode = (s: string) =>
  s.replace(/(?:%[0-9a-fA-F]{2})+/g, (run: string) => {
    const bytes = Buffer.from(run.replace(/%/g, ""), "hex");
    try {
      return strictUtf8.decode(bytes);
    } catch {
      return bytes.toString("latin1");
    }
  });

type ScanResult = "FOUND" | "INCONCLUSIVE" | "CLEAN";

/**
 * Context-free case fold: `toLowerCase` maps a capital sigma to `ς` or `σ` depending on what
 * follows it (Final_Sigma), so the same credential could fold differently inside a prefix, a whole
 * secret and a larger text. Mapping `ς` to `σ` afterwards removes that context. Exact,
 * case-preserving matching is always applied as well.
 */
const fold = (t: string) => t.toLowerCase().replace(/ς/g, "σ");

/** A lower-cased secret form for trailing-fragment checks, with its KMP failure table. */
interface FragmentPattern {
  readonly pattern: string;
  readonly fail: Int32Array;
}

function fragmentPattern(pattern: string): FragmentPattern {
  const fail = new Int32Array(pattern.length);
  for (let i = 1, k = 0; i < pattern.length; i++) {
    while (k > 0 && pattern[i] !== pattern[k]) k = fail[k - 1] as number;
    if (pattern[i] === pattern[k]) k++;
    fail[i] = k;
  }
  return { pattern, fail };
}

/** Characters (code points) of the longest secret prefix that `lower` ends with (linear). */
function trailingPrefixChars(lower: string, f: FragmentPattern, budget: { chars: number }): number {
  // `lower` is the text in the same case form as the pattern (exact or folded).
  const m = f.pattern.length;
  if (m === 0) return 0;
  const start = Math.max(0, lower.length - m);
  budget.chars += m;
  if (budget.chars > L.maxScanChars) throw new BudgetExhausted();
  let q = 0;
  for (let i = start; i < lower.length; i++) {
    while (q > 0 && (q === m || lower[i] !== f.pattern[q])) q = f.fail[q - 1] as number;
    if (lower[i] === f.pattern[q]) q++;
  }
  return Array.from(f.pattern.slice(0, q)).length;
}

/** Needles and partial-tail patterns, exact (case-preserving) and folded. */
interface Matchers {
  readonly exactNeedles: readonly string[];
  readonly foldedNeedles: readonly string[];
  /** Null unless the payload is partial. */
  readonly exactFragments: readonly FragmentPattern[] | null;
  readonly foldedFragments: readonly FragmentPattern[] | null;
}

function scanString(s: string, m: Matchers, budget: { chars: number }): ScanResult {
  let cur = s;
  for (let round = 0; ; round++) {
    // Two passes per round: exact (case-preserving) and folded.
    budget.chars += cur.length * 2;
    if (budget.chars > L.maxScanChars) throw new BudgetExhausted();
    if (m.exactNeedles.some((n) => cur.includes(n))) return "FOUND";
    if (m.exactFragments !== null) {
      for (const f of m.exactFragments) {
        if (trailingPrefixChars(cur, f, budget) >= L.minTrailingFragmentChars) return "FOUND";
      }
    }
    const folded = fold(cur);
    if (m.foldedNeedles.some((n) => folded.includes(n))) return "FOUND";
    if (m.foldedFragments !== null) {
      for (const f of m.foldedFragments) {
        if (trailingPrefixChars(folded, f, budget) >= L.minTrailingFragmentChars) return "FOUND";
      }
    }
    const next = percentDecode(unescapeBackslash(cur));
    if (next === cur) return "CLEAN";
    if (round + 1 >= L.maxDecodeRounds) return "INCONCLUSIVE";
    cur = next;
  }
}

/** Parsed keys and string values, traversed with an explicit work list (no recursion). */
function scanParsed(parsed: unknown, m: Matchers, budget: { chars: number }) {
  let worst: ScanResult = "CLEAN";
  const work: { v: unknown; depth: number }[] = [{ v: parsed, depth: 0 }];
  let nodes = 0;
  while (work.length > 0) {
    const item = work.pop() as { v: unknown; depth: number };
    if (++nodes > L.maxJsonNodes || item.depth > L.maxJsonDepth) throw new BudgetExhausted();
    const v = item.v;
    if (typeof v === "string") {
      const r = scanString(v, m, budget);
      if (r === "FOUND") return "FOUND";
      if (r === "INCONCLUSIVE") worst = r;
    } else if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) work.push({ v: v[i], depth: item.depth + 1 });
    } else if (v !== null && typeof v === "object") {
      for (const k of Object.keys(v)) {
        const r = scanString(k, m, budget);
        if (r === "FOUND") return "FOUND";
        if (r === "INCONCLUSIVE") worst = r;
        work.push({ v: (v as Record<string, unknown>)[k], depth: item.depth + 1 });
      }
    }
  }
  return worst;
}

// ---------------------------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------------------------

const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

interface SecretForm {
  readonly latin1: string;
  readonly escaped: RegExp | null;
  /** The first 8 characters of the UTF-8 bytes mapped to Latin-1 (exact). */
  readonly byteNeedle: string;
  /** The first 8 code points of the Unicode text (exact). */
  readonly unicodeNeedle: string;
  /** Whole secret in both representations, exact and folded, for partial-payload tails. */
  readonly exactFragments: readonly FragmentPattern[];
  readonly foldedFragments: readonly FragmentPattern[];
}

function secretForms(secrets: readonly string[]): readonly SecretForm[] {
  const markers = [EVIDENCE_REDACTED.toLowerCase(), EVIDENCE_REDACTED_PARTIAL.toLowerCase()];
  return secrets.map((s) => {
    const latin1 = Buffer.from(s, "utf8").toString("latin1");
    const byteNeedle = latin1.slice(0, L.detectionPrefixChars);
    const unicodeNeedle = Array.from(s).slice(0, L.detectionPrefixChars).join("");
    // A secret (or its detection prefix) inside a marker could never be redacted to a marker.
    if (markers.some((m) => m.includes(fold(byteNeedle)) || m.includes(fold(unicodeNeedle)))) {
      throw inputError("a secret collides with a redaction marker");
    }
    const patterns = (forms: readonly string[]) =>
      [...new Set(forms)].map((f) => fragmentPattern(f));
    return {
      latin1,
      escaped: escapedSecretRegex(latin1),
      byteNeedle,
      unicodeNeedle,
      exactFragments: patterns([s, latin1]),
      foldedFragments: patterns([fold(s), fold(latin1)]),
    };
  });
}

/**
 * Sanitizes one payload: redacts each secret on bytes (literal and `\u00XX`, and trailing
 * fragments of partial payloads), refuses residue, then withholds the payload if any secret's
 * prefix is still detectable (raw text and, for complete UTF-8 JSON, parsed keys and values) or
 * the scan is inconclusive or exhausted. The sanitized bytes are hashed before encoding. The input
 * is copied; caller values are never mutated or frozen.
 * @throws `[EVIDENCE_SANITIZER_INPUT] ...` for invalid input and `[SEAL_REFUSED] ...` for residue.
 */
export function sanitizeEvidenceBytes(
  original: Uint8Array,
  secrets: readonly string[],
  scope: EvidenceSanitizeScope,
): SanitizedEvidenceBytes {
  const copy = payloadCopy(original);
  if (copy === null) throw inputError("original must be a genuine Uint8Array");
  if (copy === "TOO_LARGE") {
    throw inputError(`original must be at most ${L.maxPayloadBytes} bytes`);
  }
  const list = readStringArray(secrets, L.maxSecrets);
  if (list === null || list.length === 0) {
    throw inputError(`secrets must be an array of 1..${L.maxSecrets} strings`);
  }
  for (const s of list) {
    if (s.length === 0 || s.length > L.maxSecretChars) {
      throw inputError(`each secret must be 1..${L.maxSecretChars} characters`);
    }
  }
  const sc = readScope(scope);
  if (sc === null) throw inputError("scope must be exactly { partial, parseJson } booleans");
  const forms = secretForms(list);
  const originalSha256 = sha256Hex(copy);
  const withheld = (
    reason: EvidenceWithheldReason,
    jsonInspection: EvidenceJsonInspection | null,
  ): SanitizedEvidenceBytes =>
    Object.freeze({
      status: "WITHHELD" as const,
      reason,
      originalBytes: copy.length,
      originalSha256,
      jsonInspection,
    });
  const maxOutput = copy.length * L.outputGrowthFactor + L.outputGrowthSlackBytes;
  try {
    // 1. Redaction on bytes (Latin-1 maps bytes 1:1), before any text or base64 encoding.
    let text = copy.toString("latin1");
    const preexistingMarkers =
      countOccurrences(text, EVIDENCE_REDACTED) + countOccurrences(text, EVIDENCE_REDACTED_PARTIAL);
    let redactions = 0;
    for (const f of forms) {
      // Growth is predicted before any larger string is built.
      const parts = text.split(f.latin1);
      const literal = parts.length - 1;
      if (text.length + literal * (EVIDENCE_REDACTED.length - f.latin1.length) > maxOutput) {
        throw new OutputExceeded();
      }
      redactions += literal;
      text = parts.join(EVIDENCE_REDACTED);
      if (f.escaped) {
        f.escaped.lastIndex = 0;
        let predicted = text.length;
        text = text.replace(f.escaped, (match: string) => {
          predicted += EVIDENCE_REDACTED.length - match.length;
          if (predicted > maxOutput) throw new OutputExceeded();
          redactions++;
          return EVIDENCE_REDACTED;
        });
      }
    }
    const steps = { n: 0 };
    let partialFragmentRedacted = false;
    if (sc.partial) {
      for (const f of forms) {
        const start = trailingFragmentStart(text, f.latin1, steps);
        if (start !== null) {
          text = text.slice(0, start) + EVIDENCE_REDACTED_PARTIAL;
          partialFragmentRedacted = true;
        }
      }
    }
    if (text.length > maxOutput) return withheld("OUTPUT_LIMIT_EXCEEDED", null);
    // 2. Residue: any redactable form still present refuses the seal (fixed messages).
    for (const f of forms) {
      if (text.includes(f.latin1)) throw new SealRefused("[SEAL_REFUSED] CREDENTIAL_BYTES_REMAIN");
      if (f.escaped) {
        f.escaped.lastIndex = 0;
        if (f.escaped.test(text))
          throw new SealRefused("[SEAL_REFUSED] ESCAPED_CREDENTIAL_REMAINS");
        f.escaped.lastIndex = 0;
      }
      if (sc.partial && trailingFragmentStart(text, f.latin1, steps) !== null) {
        throw new SealRefused("[SEAL_REFUSED] TRAILING_FRAGMENT_REMAINS");
      }
    }
    const bytes = Buffer.from(text, "latin1");
    const asUtf8 = bytes.toString("utf8");
    const isUtf8 = Buffer.from(asUtf8, "utf8").equals(bytes);
    // 3. Detection after redaction, in both representations: the raw byte view and the UTF-8
    //    decoded view (each with trailing-fragment checks for partial payloads), then parsed JSON
    //    keys and string values.
    const exactNeedles = [...new Set(forms.flatMap((f) => [f.byteNeedle, f.unicodeNeedle]))];
    const matchers: Matchers = {
      exactNeedles,
      foldedNeedles: [...new Set(exactNeedles.map(fold))],
      exactFragments: sc.partial ? forms.flatMap((f) => f.exactFragments) : null,
      foldedFragments: sc.partial ? forms.flatMap((f) => f.foldedFragments) : null,
    };
    const parsedMatchers: Matchers = { ...matchers, exactFragments: null, foldedFragments: null };
    const budget = { chars: 0 };
    let worst: ScanResult = "CLEAN";
    for (const view of [text, lenientUtf8.decode(bytes)]) {
      const r = scanString(view, matchers, budget);
      if (r === "FOUND") {
        worst = r;
        break;
      }
      if (r === "INCONCLUSIVE") worst = r;
    }
    let jsonInspection: EvidenceJsonInspection = sc.parseJson
      ? "SKIPPED_RAW_DETECTED"
      : "NOT_REQUESTED";
    if (worst !== "FOUND" && sc.parseJson) {
      if (sc.partial) jsonInspection = "NOT_APPLICABLE_PARTIAL";
      else if (!isUtf8) jsonInspection = "NOT_UTF8";
      else {
        let parsed: unknown;
        let ok = true;
        try {
          parsed = JSON.parse(asUtf8);
        } catch (e) {
          // Only a syntax error means "not JSON"; anything else (for example, nesting too deep for
          // the parser) is an exhausted scan and withholds the payload.
          if (!(e instanceof SyntaxError)) throw new BudgetExhausted();
          ok = false;
        }
        if (!ok) jsonInspection = "NOT_JSON";
        else {
          jsonInspection = "INSPECTED";
          const r = scanParsed(parsed, parsedMatchers, budget);
          if (r === "FOUND" || (r === "INCONCLUSIVE" && worst === "CLEAN")) worst = r;
        }
      }
    }
    if (worst === "FOUND") return withheld("CREDENTIAL_MATERIAL_DETECTED", jsonInspection);
    if (worst === "INCONCLUSIVE") return withheld("CREDENTIAL_SCAN_INCONCLUSIVE", jsonInspection);
    // 4. The sanitized bytes are hashed before encoding; the parsed value is never reserialized.
    return Object.freeze({
      status: "STORED" as const,
      encoding: isUtf8 ? ("utf8" as const) : ("base64" as const),
      stored: isUtf8 ? asUtf8 : bytes.toString("base64"),
      storedBytes: bytes.length,
      storedSha256: sha256Hex(bytes),
      originalBytes: copy.length,
      originalSha256,
      redacted: !bytes.equals(copy),
      redactions,
      partialFragmentRedacted,
      preexistingMarkers,
      jsonInspection,
    });
  } catch (e) {
    if (e instanceof SealRefused) throw new Error(e.message);
    if (e instanceof BudgetExhausted) return withheld("SCAN_BUDGET_EXHAUSTED", null);
    if (e instanceof OutputExceeded) return withheld("OUTPUT_LIMIT_EXCEEDED", null);
    // Any other failure while scanning is uncertainty: withheld, never stored.
    return withheld("CREDENTIAL_SCAN_INCONCLUSIVE", null);
  }
}
