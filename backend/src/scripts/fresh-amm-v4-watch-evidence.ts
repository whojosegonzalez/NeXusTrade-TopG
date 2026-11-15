/**
 * NeXusTrade — offline artifact layer for ONE watched AMM v4 discovery run (sealing + verification).
 *
 * Seals SUPPLIED evidence only: the run plan, the reviewed collector's result, the reviewed
 * validator's result, its bounded exchange records and the run's terminal cause. It collects
 * nothing, reads no credentials from the environment, constructs no transport and starts no
 * daemon. Handoff integration, CLI activation and live execution are later work.
 *
 * Sealing:
 * - Exclusive-create (`wx`) writes into a NEW directory under `data/research/prechecks/`; an existing
 *   directory or file is never overwritten. The manifest is written last, so a run whose writes
 *   failed part-way has no manifest and is never reported as sealed. A write failure is returned as
 *   ARTIFACT_WRITE_FAILED with the original run cause; nothing is retried or re-acquired.
 * - Credentials are supplied explicitly and never logged or persisted; request headers are never
 *   recorded. Credential bytes are redacted BEFORE text/base64 encoding (bodies and watch frames),
 *   other strings by literal value only (generic provider fields such as `token` are kept). The
 *   original-byte digest stays distinct from the sanitized-byte digest, with truthful redaction and
 *   reproduction flags. A residual credential refuses the seal before anything is written.
 * - Terminal causes (completion, a watch that ended without capture, operator cancellation, run
 *   failure) are recorded explicitly and must agree with the supplied results.
 * - Exchange records are bound to the policy limits resolved independently from the supplied
 *   context: each body's state, declared and effective limit, digest scope, lengths and flags
 *   must be what the bounded request session produces under those limits.
 *
 * Verification is fail-closed and keeps three answers apart:
 * - integrity: manifest schema/version, required entries, unique confined paths, regular files
 *   (no links), sizes, hashes, no unlisted files at any depth, plan/report references,
 *   exchange-index/ledger agreement and the policy context, all checked before any response file
 *   is consumed; then each response's body accounting against the resolved limits;
 * - completeness: whether the sealed evidence could support a selected target at all;
 * - re-derivation: for a recorded validation, the reviewed discovery verification and pure
 *   candidate derivation re-run on the sealed evidence and policy context and are compared with
 *   the recorded result. Interrupted or cancelled runs keep their recorded outcome. A difference
 *   is LIMITED_BY_REDACTION only when the redacted evidence it depends on could have caused it;
 *   contradictions in evidence that redaction did not touch remain MISMATCH.
 */

import path from "node:path";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { buildEscapedSecretRegex } from "../candidate-scanner/SolanaTrackerBundlerCaptureTool.js";
import { serializeJsonPreservingBigInts } from "../research/pilot/RaydiumAmmV4SnapshotAcquisition.js";
import {
  PRECHECK_ROOT_SEGMENTS,
  RPC_URL_PLACEHOLDER,
  evaluateInitializationExchange,
  precheckExchangePath,
  type EvidenceFileWriter,
  type PrecheckExchange,
} from "./fresh-amm-v4-precheck.js";
import { SINGLE_CANDIDATE_PUBLIC_ENDPOINTS } from "./paper-single-candidate-diagnostic.js";
import {
  DEFAULT_WATCH_VALIDATION_LIMITS,
  PROVISIONAL_TARGET_DISCLAIMER,
  REVIEWED_WATCH_POLICY,
  computeWatchValidationDeadline,
  evaluateWatchCandidateEvidence,
  resolveWatchValidationLimits,
  validateWatchedDiscoveryEvidence,
  type WatchCandidateOutcome,
  type WatchCandidateTarget,
  type WatchCandidateValidationLimits,
  type WatchCandidateValidationResult,
  type WatchEvidenceContext,
  type WatchedDiscoveryEvidence,
} from "../candidate-scanner/AmmV4WatchCandidateValidation.js";
import type { BoundedAmmV4CreationWatchResult } from "../candidate-scanner/BoundedAmmV4CreationWatch.js";

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

export const WATCH_EVIDENCE_MANIFEST_KIND = "PAPER_FRESH_AMM_V4_WATCH_EVIDENCE_MANIFEST" as const;
export const WATCH_EVIDENCE_MANIFEST_VERSION = 1 as const;
export const WATCH_EVIDENCE_REPORT_KIND = "PAPER_FRESH_AMM_V4_WATCH_EVIDENCE_REPORT" as const;
export const WATCH_EXCHANGE_KIND = "PAPER_WATCH_EXCHANGE_EVIDENCE" as const;
export const WATCH_DISCOVERY_MODE = "WATCH_LOGS_SUBSCRIBE" as const;

export const WATCH_EVIDENCE_FILES = Object.freeze({
  plan: "plan.json",
  context: "context.json",
  watchObservations: "watch-observations.json",
  requestLedger: "request-ledger.json",
  requestExchanges: "request-exchanges.json",
  validation: "validation.json",
  selection: "selection.json",
  report: "report.json",
  manifest: "evidence-manifest.json",
});

/** Every file the manifest must list (the manifest itself is not listed). */
export const WATCH_EVIDENCE_REQUIRED_FILES: readonly string[] = Object.freeze([
  WATCH_EVIDENCE_FILES.plan,
  WATCH_EVIDENCE_FILES.context,
  WATCH_EVIDENCE_FILES.watchObservations,
  WATCH_EVIDENCE_FILES.requestLedger,
  WATCH_EVIDENCE_FILES.requestExchanges,
  WATCH_EVIDENCE_FILES.validation,
  WATCH_EVIDENCE_FILES.selection,
  WATCH_EVIDENCE_FILES.report,
]);

/** Files whose content the re-derivation consumes (redaction there can prevent reproduction). */
const DERIVATION_FILES: readonly string[] = [
  WATCH_EVIDENCE_FILES.context,
  WATCH_EVIDENCE_FILES.watchObservations,
  WATCH_EVIDENCE_FILES.validation,
];

const EXCHANGES_DIR = "exchanges";
const RESPONSE_PATH = /^exchanges\/\d{4}\.json$/;
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const REDACTED = "[REDACTED]";
const REDACTED_PARTIAL = "[REDACTED_PARTIAL]";
/** A partial body ending in at least this many leading bytes of a credential is redacted. */
const MIN_TRAILING_FRAGMENT = 4;
/** Minimum length of an explicitly supplied additional secret (avoids redacting common text). */
const MIN_SUPPLIED_SECRET = 6;
const ALLOWED_RESPONSE_HEADERS = new Set(["content-type", "content-length", "retry-after"]);
const MAX_WALK_DEPTH = 4;

const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isSafeInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Key-order independent JSON for comparisons. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isRecord(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

// ---------------------------------------------------------------------------------------------
// Terminal causes
// ---------------------------------------------------------------------------------------------

export type WatchRunTerminalCode =
  | "COMPLETED"
  | "WATCH_ENDED_WITHOUT_CAPTURE"
  | "OPERATOR_CANCELLED"
  | "RUN_FAILED";
export type WatchRunStage = "WATCH" | "VALIDATION" | "RUN";

export interface WatchRunTerminalCause {
  readonly code: WatchRunTerminalCode;
  readonly stage: WatchRunStage;
  readonly detail: string | null;
}

const TERMINAL_CODES: readonly string[] = [
  "COMPLETED",
  "WATCH_ENDED_WITHOUT_CAPTURE",
  "OPERATOR_CANCELLED",
  "RUN_FAILED",
];
const STAGES: readonly string[] = ["WATCH", "VALIDATION", "RUN"];

/**
 * The terminal cause must agree with the results: cancellation anywhere is recorded as
 * cancellation, completion needs a captured watch and a recorded validation, and a watch that
 * ended without capture has no validation. Returns a problem code, or null.
 */
export function terminalCauseProblem(
  cause: unknown,
  watchStatus: unknown,
  validationOutcome: string | null,
): string | null {
  if (
    !isRecord(cause) ||
    !TERMINAL_CODES.includes(cause.code as string) ||
    !STAGES.includes(cause.stage as string) ||
    !(cause.detail === null || typeof cause.detail === "string")
  ) {
    return "TERMINAL_CAUSE_MALFORMED";
  }
  const captured = watchStatus === "NOTIFICATION_CAPTURED";
  const watchCancelled = watchStatus === "OPERATOR_CANCELLED";
  const validationCancelled = validationOutcome === "OPERATOR_CANCELLED";
  const hasValidation = validationOutcome !== null;
  if (hasValidation && !captured) return "VALIDATION_WITHOUT_CAPTURED_WATCH";
  if ((watchCancelled || validationCancelled) && cause.code !== "OPERATOR_CANCELLED") {
    return "CANCELLATION_NOT_PRESERVED";
  }
  switch (cause.code) {
    case "COMPLETED":
      return cause.stage === "VALIDATION" && captured && hasValidation
        ? null
        : "COMPLETED_CAUSE_INCONSISTENT";
    case "WATCH_ENDED_WITHOUT_CAPTURE":
      return cause.stage === "WATCH" && !captured && !watchCancelled && !hasValidation
        ? null
        : "WATCH_CAUSE_INCONSISTENT";
    case "OPERATOR_CANCELLED":
      return (cause.stage === "WATCH" && watchCancelled && !hasValidation) ||
        (cause.stage === "VALIDATION" && captured && validationCancelled) ||
        (cause.stage === "RUN" && captured && !hasValidation)
        ? null
        : "CANCELLATION_CAUSE_INCONSISTENT";
    default:
      return typeof cause.detail === "string" && cause.detail.trim().length > 0
        ? null
        : "RUN_FAILED_WITHOUT_DETAIL";
  }
}

// ---------------------------------------------------------------------------------------------
// Redaction (reviewed precheck pattern: Latin-1 byte mapping + escaped forms, literal only)
// ---------------------------------------------------------------------------------------------

export interface WatchEvidenceCredentials {
  readonly rpcUrl?: string | undefined;
  readonly wssUrl?: string | undefined;
  /** Further secret values (each at least 6 characters). */
  readonly additional?: readonly string[] | undefined;
}

function credentialSecrets(c: WatchEvidenceCredentials): string[] {
  if (!isRecord(c)) throw new Error("[SEAL_INPUT_INVALID] credentials must be supplied explicitly");
  const secrets = new Set<string>();
  const addUrl = (name: string, raw: unknown) => {
    if (raw === undefined) return;
    if (typeof raw !== "string" || raw.length === 0) {
      throw new Error(`[SEAL_INPUT_INVALID] credentials.${name} must be a non-empty string`);
    }
    secrets.add(raw);
    try {
      const u = new URL(raw);
      if (u.username) secrets.add(u.username);
      if (u.password) secrets.add(u.password);
      for (const v of u.searchParams.values()) if (v.length >= 6) secrets.add(v);
      for (const seg of u.pathname.split("/")) if (seg.length >= 16) secrets.add(seg);
    } catch {
      // Not a URL: the whole value is the secret.
    }
  };
  addUrl("rpcUrl", c.rpcUrl);
  addUrl("wssUrl", c.wssUrl);
  const additional: readonly unknown[] = Array.isArray(c.additional) ? c.additional : [];
  if (c.additional !== undefined && !Array.isArray(c.additional)) {
    throw new Error("[SEAL_INPUT_INVALID] credentials.additional must be an array");
  }
  for (const [i, s] of additional.entries()) {
    if (typeof s !== "string" || s.length < MIN_SUPPLIED_SECRET) {
      throw new Error(
        `[SEAL_INPUT_INVALID] credentials.additional[${i}] must be at least ${MIN_SUPPLIED_SECRET} characters`,
      );
    }
    secrets.add(s);
  }
  if (secrets.size === 0) {
    throw new Error("[SEAL_INPUT_INVALID] at least one credential must be supplied for redaction");
  }
  return [...secrets].sort((a, b) => b.length - a.length);
}

function escapedRegex(secret: string): RegExp | null {
  try {
    return buildEscapedSecretRegex(secret);
  } catch {
    return null;
  }
}

interface SanitizedBytes {
  readonly redacted: boolean;
  readonly encoding: "utf8" | "base64";
  readonly stored: string;
  readonly bytes: Buffer;
}

/**
 * Number of complete credential characters matched from `t[pos]` (secret character `k` onwards)
 * when the match runs exactly to the end of `t`, or -1. Each character may appear literally or as
 * `\u00XX` (the reviewed escaped form; case-insensitive like `buildEscapedSecretRegex`), and the
 * text may end inside an escape sequence. A match of the whole secret is not a trailing fragment
 * (whole forms are redacted before this runs). `lower` is the lower-cased Latin-1 text and
 * `secret` the Latin-1 credential.
 */
function fragmentCharsToEnd(lower: string, pos: number, secret: string, k: number): number {
  if (pos === lower.length) return k < secret.length ? k : -1;
  if (k === secret.length) return -1;
  const ch = secret[k] as string;
  let best = -1;
  if (lower[pos] === ch.toLowerCase()) best = fragmentCharsToEnd(lower, pos + 1, secret, k + 1);
  const escape = `\\u00${ch.charCodeAt(0).toString(16).padStart(2, "0")}`.toLowerCase();
  const rest = lower.slice(pos, pos + escape.length);
  if (rest === escape) {
    best = Math.max(best, fragmentCharsToEnd(lower, pos + escape.length, secret, k + 1));
  } else if (pos + rest.length === lower.length && escape.startsWith(rest)) {
    best = Math.max(best, k); // the retained prefix ends inside this character's escape sequence
  }
  return best;
}

/**
 * Start of the longest trailing credential fragment (literal, escaped or mixed, possibly cut inside
 * an escape sequence) covering at least MIN_TRAILING_FRAGMENT credential characters, or null.
 */
function trailingFragmentStart(text: string, secret: string): number | null {
  const lower = text.toLowerCase();
  const span = secret.length * 6; // an escaped character is at most six bytes
  for (let start = Math.max(0, text.length - span); start < text.length; start++) {
    if (fragmentCharsToEnd(lower, start, secret, 0) >= MIN_TRAILING_FRAGMENT) return start;
  }
  return null;
}

/** Credential redaction on bytes (Latin-1 maps bytes 1:1), applied before text or base64 storage. */
function byteSanitizer(secrets: readonly string[]) {
  const forms = secrets.map((s) => {
    const latin1 = Buffer.from(s, "utf8").toString("latin1");
    return { latin1, escaped: escapedRegex(latin1) };
  });
  return (original: Buffer, partial: boolean): SanitizedBytes => {
    let text = original.toString("latin1");
    for (const f of forms) {
      text = text.split(f.latin1).join(REDACTED);
      if (f.escaped) text = text.replace(f.escaped, REDACTED);
    }
    // A bounded prefix can end inside a credential in any form (literal, escaped or mixed, even
    // inside an escape sequence): redact the trailing fragment.
    if (partial) {
      for (const f of forms) {
        const start = trailingFragmentStart(text, f.latin1);
        if (start !== null) text = text.slice(0, start) + REDACTED_PARTIAL;
      }
    }
    for (const f of forms) {
      if (text.includes(f.latin1)) throw new Error("[SEAL_REFUSED] credential bytes remain");
      if (f.escaped) {
        f.escaped.lastIndex = 0;
        if (f.escaped.test(text)) throw new Error("[SEAL_REFUSED] escaped credential remains");
        f.escaped.lastIndex = 0;
      }
      if (partial && trailingFragmentStart(text, f.latin1) !== null) {
        throw new Error("[SEAL_REFUSED] a trailing credential fragment remains");
      }
    }
    const bytes = Buffer.from(text, "latin1");
    const asUtf8 = bytes.toString("utf8");
    const isUtf8 = Buffer.from(asUtf8, "utf8").equals(bytes);
    return {
      redacted: !bytes.equals(original),
      encoding: isUtf8 ? "utf8" : "base64",
      stored: isUtf8 ? asUtf8 : bytes.toString("base64"),
      bytes,
    };
  };
}

/** Literal (value-based) redaction of strings; key names are never used to redact. */
function textRedactor(secrets: readonly string[]) {
  const forms = secrets.map((s) => ({ s, escaped: escapedRegex(s) }));
  const redact = (t: string): string => {
    let out = t;
    for (const f of forms) {
      out = out.split(f.s).join(REDACTED);
      if (f.escaped) out = out.replace(f.escaped, REDACTED);
    }
    return out;
  };
  let count = 0;
  const deep = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redact(v);
      if (r !== v) count++;
      return r;
    }
    if (Array.isArray(v)) return v.map(deep);
    if (Buffer.isBuffer(v))
      throw new Error("[SEAL_INPUT_INVALID] raw buffers are not JSON evidence");
    if (isRecord(v)) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [deep(k) as string, deep(x)]));
    }
    return v;
  };
  const takeCount = () => {
    const c = count;
    count = 0;
    return c;
  };
  return { redact, deep, takeCount };
}

const COMPLETE_DIGEST_SCOPE = "ORIGINAL_COMPLETE_BODY_BYTES";
const PREFIX_DIGEST_SCOPE = "ORIGINAL_RETAINED_PREFIX_BYTES_ONLY";

/** The response ceiling the reviewed validator's request session applies to a lane. */
function laneResponseLimit(lane: unknown, limits: WatchCandidateValidationLimits): number | null {
  if (lane === "SOLANA_RPC") return limits.rpcMaxResponseBytes;
  if (lane === "DEXSCREENER") return limits.dexscreenerMaxResponseBytes;
  return null;
}

/**
 * Body accounting that the bounded request session can produce under the independently resolved
 * lane limit L:
 * - COMPLETE: no error, a status, retained = observed <= L, complete-body digest scope;
 * - PARTIAL_OVERFLOW: RESPONSE_TOO_LARGE, a status, exactly L retained bytes of observed > L,
 *   prefix-only digest scope;
 * - NOT_READ: an error and no body, counts, digests, scope or encoding.
 * The declared maxResponseBytes must equal L, `completeEvidence` must equal COMPLETE, stored
 * lengths and the canonical encoding must match the stored bytes, and the redaction and
 * reproduction flags must agree with the digests. `stored` is the decoded stored body and
 * `storedDigest` its declared digest. Returns problem names (empty when consistent).
 */
function bodyAccountingProblems(
  ex: { readonly lane: unknown; readonly error: unknown; readonly httpStatus: unknown },
  r: Record<string, unknown>,
  stored: Buffer | null,
  storedDigest: unknown,
  limits: WatchCandidateValidationLimits,
): string[] {
  const limit = laneResponseLimit(ex.lane, limits);
  if (limit === null) return ["LANE_UNKNOWN"];
  const p: string[] = [];
  if (r.maxResponseBytes !== limit) p.push("DECLARED_LIMIT_MISMATCH");
  const state = r.bodyState;
  if (r.completeEvidence !== (state === "COMPLETE")) p.push("COMPLETE_EVIDENCE_FLAG");
  if (state === "NOT_READ") {
    if (
      stored !== null ||
      r.retainedBytes !== null ||
      r.observedBytes !== null ||
      r.receivedBytesSha256 !== null ||
      r.receivedDigestScope !== null ||
      r.bodyEncoding !== null ||
      r.storedBytes !== null ||
      r.bodyRedacted !== false ||
      r.reproducesReceivedDigest !== false
    ) {
      p.push("UNREAD_BODY_ACCOUNTING");
    }
    if (typeof ex.error !== "string") p.push("UNREAD_BODY_WITHOUT_ERROR");
    return p;
  }
  if (state !== "COMPLETE" && state !== "PARTIAL_OVERFLOW") return [...p, "BODY_STATE_UNKNOWN"];
  if (stored === null) return [...p, "BODY_MISSING"];
  if (!isSafeInt(ex.httpStatus)) p.push("HTTP_STATUS_MISSING");
  if (r.storedBytes !== stored.length) p.push("STORED_BYTES");
  const utf8 = Buffer.from(stored.toString("utf8"), "utf8").equals(stored);
  if (r.bodyEncoding !== (utf8 ? "utf8" : "base64")) p.push("BODY_ENCODING");
  if (typeof r.receivedBytesSha256 !== "string" || !HEX64.test(r.receivedBytesSha256)) {
    p.push("RECEIVED_DIGEST");
  }
  if (!isSafeInt(r.retainedBytes) || !isSafeInt(r.observedBytes)) return [...p, "BYTE_COUNTS"];
  if (state === "COMPLETE") {
    if (ex.error !== null) p.push("COMPLETE_BODY_WITH_ERROR");
    if (r.retainedBytes > limit) p.push("RETAINED_EXCEEDS_LIMIT");
    if (r.observedBytes !== r.retainedBytes) p.push("OBSERVED_BYTES");
    if (r.receivedDigestScope !== COMPLETE_DIGEST_SCOPE) p.push("DIGEST_SCOPE");
  } else {
    if (ex.error !== "RESPONSE_TOO_LARGE") p.push("PARTIAL_BODY_ERROR");
    if (r.retainedBytes !== limit) p.push("RETAINED_PREFIX_LENGTH");
    if (r.observedBytes <= limit) p.push("OBSERVED_BYTES");
    if (r.receivedDigestScope !== PREFIX_DIGEST_SCOPE) p.push("DIGEST_SCOPE");
  }
  if (r.bodyRedacted === false) {
    if (
      r.retainedBytes !== stored.length ||
      r.reproducesReceivedDigest !== true ||
      r.receivedBytesSha256 !== storedDigest
    ) {
      p.push("UNREDACTED_BODY_DIGEST");
    }
  } else if (r.bodyRedacted === true) {
    if (r.reproducesReceivedDigest !== false || r.receivedBytesSha256 === storedDigest) {
      p.push("REDACTED_BODY_FLAGS");
    }
  } else p.push("REDACTION_FLAG");
  return p;
}

function decodeStoredBody(body: unknown, encoding: unknown): Buffer | null | "INVALID" {
  if (body === null && encoding === null) return null;
  if (typeof body !== "string") return "INVALID";
  if (encoding === "utf8") return Buffer.from(body, "utf8");
  if (encoding === "base64") {
    if (body.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body)) return "INVALID";
    const bytes = Buffer.from(body, "base64");
    return bytes.toString("base64") === body ? bytes : "INVALID";
  }
  return "INVALID";
}

// ---------------------------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------------------------

export interface SealWatchEvidenceInput {
  readonly projectRoot: string;
  /** New directory name under data/research/prechecks/ (letters, digits, `.`, `_`, `-`). */
  readonly runName: string;
  readonly plan: Readonly<Record<string, unknown>>;
  readonly watchResult: BoundedAmmV4CreationWatchResult;
  readonly validation: WatchCandidateValidationResult | null;
  /** Bounded exchange records; default: the validation result's records (must agree with it). */
  readonly exchanges?: readonly PrecheckExchange[] | undefined;
  readonly terminalCause: WatchRunTerminalCause;
  /** The policy/deadline context the validation ran under. */
  readonly policyContext?: WatchEvidenceContext | undefined;
  /** Supplied explicitly; used only for redaction, never logged or persisted. */
  readonly credentials: WatchEvidenceCredentials;
  readonly clock?: (() => number) | undefined;
  /** Offline tests only: replaces the exclusive writer (to force a write failure). */
  readonly writeEvidenceFile?: EvidenceFileWriter | undefined;
}

export interface WatchEvidenceManifestEntry {
  readonly path: string;
  readonly category: "EVIDENCE" | "RESPONSE";
  readonly sha256: string;
  readonly bytes: number;
}

export interface WatchEvidenceRedactionSummary {
  readonly applied: boolean;
  readonly frames: readonly number[];
  readonly bodies: readonly number[];
  readonly literalByFile: Readonly<Record<string, number>>;
  readonly reproducible: boolean;
  readonly limitation: string | null;
}

export type SealWatchEvidenceFailure =
  | "SEAL_INPUT_INVALID"
  | "SEAL_REFUSED"
  | "OUTPUT_DIRECTORY_UNAVAILABLE"
  | "ARTIFACT_WRITE_FAILED";

export type SealWatchEvidenceResult =
  | {
      readonly ok: true;
      readonly status: "SEALED";
      readonly sealed: true;
      readonly outDir: string;
      readonly manifestSha256: string;
      readonly files: readonly WatchEvidenceManifestEntry[];
      readonly runCause: WatchRunTerminalCause;
      readonly recordedOutcome: WatchCandidateOutcome | null;
      readonly redaction: WatchEvidenceRedactionSummary;
    }
  | {
      readonly ok: false;
      readonly status: SealWatchEvidenceFailure;
      readonly sealed: false;
      readonly reason: string;
      readonly outDir: string | null;
      readonly failedFile: string | null;
      /** Files exclusively created before the failure; none of them is sealed (no manifest). */
      readonly filesWritten: readonly string[];
      /** The original run cause, preserved as supplied (detail redacted). */
      readonly runCause: unknown;
      readonly recordedOutcome: WatchCandidateOutcome | null;
    };

interface PreparedFile {
  readonly path: string;
  readonly category: "EVIDENCE" | "RESPONSE";
  readonly content: string;
}

function sealedExchangeRecord(
  ex: PrecheckExchange,
  sanitize: ReturnType<typeof byteSanitizer>,
  limits: WatchCandidateValidationLimits,
): { record: Record<string, unknown>; ledger: Record<string, unknown>; redacted: boolean } {
  const r = ex.response as Record<string, unknown>;
  if (r.bodyRedacted !== false) {
    throw new Error(`[SEAL_INPUT_INVALID] exchange ${ex.seq} is not an unredacted raw record`);
  }
  const original = decodeStoredBody(r.body, r.bodyEncoding);
  if (original === "INVALID") {
    throw new Error(`[SEAL_INPUT_INVALID] exchange ${ex.seq} body does not decode`);
  }
  if (original !== null && r.receivedBytesSha256 !== sha256(original)) {
    throw new Error(`[SEAL_INPUT_INVALID] exchange ${ex.seq} body does not match its digest`);
  }
  // Bound to the independently resolved policy limits, never to the record's own claims.
  const accounting = bodyAccountingProblems(
    ex,
    r,
    original,
    original === null ? null : sha256(original),
    limits,
  );
  if (accounting.length > 0) {
    throw new Error(
      `[SEAL_INPUT_INVALID] exchange ${ex.seq} body accounting contradicts the resolved policy limits (${accounting.join(",")})`,
    );
  }
  const bodyState = r.bodyState as "COMPLETE" | "PARTIAL_OVERFLOW" | "NOT_READ";
  const s = original === null ? null : sanitize(original, bodyState === "PARTIAL_OVERFLOW");
  const headers: Record<string, unknown> = {};
  if (isRecord(r.headers)) {
    for (const [k, v] of Object.entries(r.headers)) {
      if (ALLOWED_RESPONSE_HEADERS.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
    }
  }
  const sanitizedBytesSha256 = s === null ? null : sha256(s.bytes);
  const redacted = s?.redacted ?? false;
  const file = precheckExchangePath(ex.seq);
  const record = {
    kind: WATCH_EXCHANGE_KIND,
    seq: ex.seq,
    purpose: ex.purpose,
    lane: ex.lane,
    jsonRpcId: ex.jsonRpcId,
    request: {
      method: ex.request.method ?? null,
      url: ex.lane === "SOLANA_RPC" ? RPC_URL_PLACEHOLDER : ex.request.url,
      headersRecorded: false,
      rpcMethod: ex.request.rpcMethod,
      rpcParams: ex.request.rpcParams,
    },
    dispatchedAtMs: ex.dispatchedAtMs,
    completedAtMs: ex.completedAtMs,
    httpStatus: ex.httpStatus,
    error: ex.error,
    response: {
      headers,
      bodyState,
      completeEvidence: bodyState === "COMPLETE",
      retainedBytes: original?.length ?? null,
      observedBytes: r.observedBytes ?? null,
      maxResponseBytes: r.maxResponseBytes ?? null,
      receivedBytesSha256: original === null ? null : sha256(original),
      receivedDigestScope:
        original === null
          ? null
          : bodyState === "COMPLETE"
            ? COMPLETE_DIGEST_SCOPE
            : PREFIX_DIGEST_SCOPE,
      bodyEncoding: s?.encoding ?? null,
      storedBytes: s?.bytes.length ?? null,
      sanitizedBytesSha256,
      bodyRedacted: redacted,
      reproducesReceivedDigest: original !== null && !redacted,
      body: s?.stored ?? null,
    },
  };
  const ledger = {
    seq: ex.seq,
    purpose: ex.purpose,
    lane: ex.lane,
    file,
    dispatchedAtMs: ex.dispatchedAtMs,
    completedAtMs: ex.completedAtMs,
    httpStatus: ex.httpStatus,
    error: ex.error,
    bodyState,
    receivedBytesSha256: record.response.receivedBytesSha256,
    sanitizedBytesSha256,
    bodyRedacted: redacted,
  };
  return { record, ledger, redacted };
}

function checkSealInputs(input: SealWatchEvidenceInput): readonly PrecheckExchange[] {
  if (!isRecord(input.plan)) throw new Error("[SEAL_INPUT_INVALID] plan must be a JSON object");
  const w = input.watchResult as unknown;
  if (
    !isRecord(w) ||
    typeof w.status !== "string" ||
    !isRecord(w.observations) ||
    !Array.isArray(w.observations.applicationFrames)
  ) {
    throw new Error("[SEAL_INPUT_INVALID] watchResult is not a collector result");
  }
  const v = input.validation;
  if (
    v !== null &&
    (!isRecord(v) || typeof v.outcome !== "string" || !Array.isArray(v.exchanges))
  ) {
    throw new Error("[SEAL_INPUT_INVALID] validation is not a validation result");
  }
  const problem = terminalCauseProblem(input.terminalCause, w.status, v?.outcome ?? null);
  if (problem !== null) throw new Error(`[SEAL_INPUT_INVALID] ${problem}`);

  const ctx = input.policyContext ?? {};
  try {
    resolveWatchValidationLimits(ctx.limits);
    if (v?.discovery) {
      const recomputed = computeWatchValidationDeadline(v.discovery, ctx);
      if (recomputed !== v.validationDeadlineAtMs) {
        throw new Error("[SEAL_INPUT_INVALID] POLICY_CONTEXT_DOES_NOT_MATCH_RECORDED_DEADLINE");
      }
    }
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    throw new Error(m.startsWith("[SEAL_INPUT_INVALID]") ? m : `[SEAL_INPUT_INVALID] ${m}`);
  }

  const exchanges = input.exchanges ?? v?.exchanges ?? [];
  if (v === null && exchanges.length > 0) {
    throw new Error("[SEAL_INPUT_INVALID] exchanges supplied without a validation result");
  }
  if (
    v !== null &&
    input.exchanges !== undefined &&
    canonical(input.exchanges) !== canonical(v.exchanges)
  ) {
    throw new Error("[SEAL_INPUT_INVALID] exchanges differ from the validation result's records");
  }
  if (exchanges.length > DEFAULT_WATCH_VALIDATION_LIMITS.maxHttpAttempts) {
    throw new Error("[SEAL_INPUT_INVALID] more exchange records than the reviewed request bound");
  }
  for (const [i, ex] of exchanges.entries()) {
    if (!isRecord(ex) || ex.seq !== i + 1 || !isRecord(ex.request) || !isRecord(ex.response)) {
      throw new Error("[SEAL_INPUT_INVALID] exchange records must be contiguous from seq 1");
    }
  }
  if (v !== null) {
    if (
      !isSafeInt(v.httpAttempts) ||
      v.httpAttempts < exchanges.length ||
      v.httpAttempts > DEFAULT_WATCH_VALIDATION_LIMITS.maxHttpAttempts
    ) {
      throw new Error("[SEAL_INPUT_INVALID] httpAttempts disagrees with the exchange records");
    }
  }
  return exchanges;
}

/**
 * Seals supplied evidence of one watched run into a new directory. Returns SEALED only after every
 * file, the manifest last, was exclusively created.
 */
export function sealWatchEvidence(input: SealWatchEvidenceInput): SealWatchEvidenceResult {
  let redactForReport: (t: string) => string = () => REDACTED;
  const recordedOutcome = isRecord(input.validation)
    ? ((input.validation.outcome as WatchCandidateOutcome | undefined) ?? null)
    : null;
  const causeForReport = (): unknown => {
    const c = input.terminalCause as unknown;
    if (!isRecord(c)) return c ?? null;
    return {
      code: c.code,
      stage: c.stage,
      detail: typeof c.detail === "string" ? redactForReport(c.detail) : (c.detail ?? null),
    };
  };
  const fail = (
    status: SealWatchEvidenceFailure,
    reason: string,
    extra: { outDir?: string | null; failedFile?: string | null; filesWritten?: string[] } = {},
  ): SealWatchEvidenceResult => ({
    ok: false,
    status,
    sealed: false,
    reason: redactForReport(reason),
    outDir: extra.outDir ?? null,
    failedFile: extra.failedFile ?? null,
    filesWritten: extra.filesWritten ?? [],
    runCause: causeForReport(),
    recordedOutcome,
  });
  const failFromError = (e: unknown): SealWatchEvidenceResult => {
    const m = e instanceof Error ? e.message : String(e);
    return fail(m.startsWith("[SEAL_REFUSED]") ? "SEAL_REFUSED" : "SEAL_INPUT_INVALID", m);
  };

  // 1. Inputs and credentials (no file system access yet).
  let secrets: string[];
  try {
    secrets = credentialSecrets(input.credentials);
  } catch (e) {
    return failFromError(e);
  }
  const text = textRedactor(secrets);
  redactForReport = text.redact;
  if (typeof input.runName !== "string" || !RUN_NAME.test(input.runName)) {
    return fail("SEAL_INPUT_INVALID", "[SEAL_INPUT_INVALID] runName is not a safe directory name");
  }

  // 2. Prepare every file in memory; a residual credential refuses the seal before any write.
  let prepared: PreparedFile[];
  let manifestSha256: string;
  let entries: WatchEvidenceManifestEntry[];
  let redaction: WatchEvidenceRedactionSummary;
  let runCause: WatchRunTerminalCause;
  try {
    const exchanges = checkSealInputs(input);
    const sanitize = byteSanitizer(secrets);
    const v = input.validation;
    const ctx = input.policyContext ?? {};
    runCause = {
      code: input.terminalCause.code,
      stage: input.terminalCause.stage,
      detail: input.terminalCause.detail === null ? null : text.redact(input.terminalCause.detail),
    };
    const literalByFile: Record<string, number> = {};
    prepared = [];
    const add = (rel: string, data: unknown, category: "EVIDENCE" | "RESPONSE"): string => {
      text.takeCount();
      const content = serializeJsonPreservingBigInts(text.deep(data)) + "\n";
      literalByFile[rel] = text.takeCount();
      for (const s of secrets) {
        if (content.includes(s) || content.includes(JSON.stringify(s).slice(1, -1))) {
          throw new Error(`[SEAL_REFUSED] a credential would be persisted in ${rel}`);
        }
      }
      prepared.push({ path: rel, category, content });
      return content;
    };

    // Plan.
    const planContent = add(WATCH_EVIDENCE_FILES.plan, input.plan, "EVIDENCE");
    const planDigestSha256 = sha256(planContent);

    // Policy and deadline context.
    const resolvedLimits = resolveWatchValidationLimits(ctx.limits);
    add(
      WATCH_EVIDENCE_FILES.context,
      {
        kind: "PAPER_WATCH_POLICY_CONTEXT",
        suppliedContext: {
          overallDeadlineAtMs: ctx.overallDeadlineAtMs ?? null,
          limits: ctx.limits ?? null,
        },
        resolvedLimits,
        reviewedWatchPolicy: REVIEWED_WATCH_POLICY,
        defaultValidationLimits: DEFAULT_WATCH_VALIDATION_LIMITS,
        recordedValidationDeadlineAtMs: v?.validationDeadlineAtMs ?? null,
        recomputedValidationDeadlineAtMs: v?.discovery
          ? computeWatchValidationDeadline(v.discovery, ctx)
          : null,
      },
      "EVIDENCE",
    );

    // Watch observations (frame bytes redacted before encoding; original digests kept).
    const w = JSON.parse(serializeJsonPreservingBigInts(input.watchResult)) as Record<
      string,
      unknown
    >;
    const obs = w.observations as Record<string, unknown>;
    const frameRedactions: Record<string, unknown>[] = [];
    obs.applicationFrames = (obs.applicationFrames as unknown[]).map((f, index) => {
      if (!isRecord(f) || typeof f.payload !== "string") return f;
      const original = Buffer.from(f.payload, "utf8");
      const s = sanitize(original, false);
      if (!s.redacted) return f;
      if (s.encoding !== "utf8") throw new Error("[SEAL_REFUSED] a redacted frame is not text");
      frameRedactions.push({
        index,
        originalSha256: sha256(original),
        originalByteLength: original.length,
        sanitizedSha256: sha256(s.bytes),
        sanitizedByteLength: s.bytes.length,
      });
      return { ...f, payload: s.stored };
    });
    add(
      WATCH_EVIDENCE_FILES.watchObservations,
      {
        kind: "PAPER_WATCH_OBSERVATIONS",
        discoveryMode: WATCH_DISCOVERY_MODE,
        reviewedWatchPolicy: REVIEWED_WATCH_POLICY,
        frameRedactions,
        watchResult: w,
      },
      "EVIDENCE",
    );

    // Exchanges, ledger and index.
    const ledger: Record<string, unknown>[] = [];
    const redactedBodies: number[] = [];
    for (const ex of exchanges) {
      const sealed = sealedExchangeRecord(ex, sanitize, resolvedLimits);
      add(precheckExchangePath(ex.seq), sealed.record, "RESPONSE");
      ledger.push(sealed.ledger);
      if (sealed.redacted) redactedBodies.push(ex.seq);
    }
    const httpAttempts = v?.httpAttempts ?? 0;
    add(
      WATCH_EVIDENCE_FILES.requestLedger,
      { kind: "PAPER_WATCH_REQUEST_LEDGER", httpAttempts, entries: ledger },
      "EVIDENCE",
    );
    add(
      WATCH_EVIDENCE_FILES.requestExchanges,
      {
        kind: "PAPER_WATCH_EXCHANGE_INDEX",
        httpAttempts,
        missingExchangeCount: httpAttempts - exchanges.length,
        exchanges: exchanges.map((ex) => ({
          seq: ex.seq,
          purpose: ex.purpose,
          file: precheckExchangePath(ex.seq),
        })),
      },
      "EVIDENCE",
    );

    // Validation and selection.
    add(
      WATCH_EVIDENCE_FILES.validation,
      v === null
        ? { kind: "PAPER_WATCH_VALIDATION", recorded: false, result: null }
        : {
            kind: "PAPER_WATCH_VALIDATION",
            recorded: true,
            result: {
              ok: v.ok,
              outcome: v.outcome,
              reason: v.reason,
              target: v.target,
              discovery: v.discovery,
              httpAttempts: v.httpAttempts,
              exchangeCount: exchanges.length,
              validationDeadlineAtMs: v.validationDeadlineAtMs,
              completedAtMs: v.completedAtMs,
              disclaimer: v.disclaimer,
            },
          },
      "EVIDENCE",
    );
    const runOutcome = runCause.code === "COMPLETED" ? (v?.outcome ?? null) : runCause.code;
    const selected = runCause.code === "COMPLETED" && v?.outcome === "TARGET_SELECTED";
    add(
      WATCH_EVIDENCE_FILES.selection,
      {
        kind: "PAPER_WATCH_SELECTION",
        discoveryMode: WATCH_DISCOVERY_MODE,
        terminalCause: runCause,
        runOutcome,
        watchStatus: input.watchResult.status,
        watchReason: input.watchResult.reason,
        recordedOutcome: v?.outcome ?? null,
        reason: v?.reason ?? null,
        selected,
        target: v?.target ?? null,
        discovery: v?.discovery ?? null,
        disclaimer: PROVISIONAL_TARGET_DISCLAIMER,
      },
      "EVIDENCE",
    );

    // Report (references every other file), then the manifest.
    const derivationLiteral = Object.entries(literalByFile).some(
      ([p, n]) => n > 0 && (DERIVATION_FILES.includes(p) || RESPONSE_PATH.test(p)),
    );
    const applied =
      frameRedactions.length > 0 ||
      redactedBodies.length > 0 ||
      Object.values(literalByFile).some((n) => n > 0);
    const reproducible =
      frameRedactions.length === 0 && redactedBodies.length === 0 && !derivationLiteral;
    redaction = {
      applied,
      frames: frameRedactions.map((f) => f.index as number),
      bodies: redactedBodies,
      literalByFile: { ...literalByFile },
      reproducible,
      limitation: reproducible
        ? null
        : "Credential redaction changed evidence the re-derivation consumes; exact re-derivation is not possible from the sealed files.",
    };
    add(
      WATCH_EVIDENCE_FILES.report,
      {
        kind: WATCH_EVIDENCE_REPORT_KIND,
        version: WATCH_EVIDENCE_MANIFEST_VERSION,
        sealedAtMs: (input.clock ?? Date.now)(),
        discoveryMode: WATCH_DISCOVERY_MODE,
        terminalCause: runCause,
        runOutcome,
        recordedOutcome: v?.outcome ?? null,
        selected,
        planDigestSha256,
        files: {
          plan: WATCH_EVIDENCE_FILES.plan,
          context: WATCH_EVIDENCE_FILES.context,
          watchObservations: WATCH_EVIDENCE_FILES.watchObservations,
          requestLedger: WATCH_EVIDENCE_FILES.requestLedger,
          requestExchanges: WATCH_EVIDENCE_FILES.requestExchanges,
          validation: WATCH_EVIDENCE_FILES.validation,
          selection: WATCH_EVIDENCE_FILES.selection,
        },
        exchangeFiles: exchanges.map((ex) => precheckExchangePath(ex.seq)),
        credentialsRecorded: false,
        requestHeadersRecorded: false,
        redaction,
        disclaimer: PROVISIONAL_TARGET_DISCLAIMER,
        scope:
          "Offline sealing of supplied evidence only. Handoff integration, CLI activation and live execution are not implemented here.",
      },
      "EVIDENCE",
    );
    entries = prepared.map((f) => ({
      path: f.path,
      category: f.category,
      sha256: sha256(f.content),
      bytes: Buffer.byteLength(f.content, "utf8"),
    }));
    const manifestContent =
      serializeJsonPreservingBigInts({
        kind: WATCH_EVIDENCE_MANIFEST_KIND,
        version: WATCH_EVIDENCE_MANIFEST_VERSION,
        planDigestSha256,
        reportFile: WATCH_EVIDENCE_FILES.report,
        files: entries,
      }) + "\n";
    manifestSha256 = sha256(manifestContent);
    prepared.push({
      path: WATCH_EVIDENCE_FILES.manifest,
      category: "EVIDENCE",
      content: manifestContent,
    });
  } catch (e) {
    return failFromError(e);
  }

  // 3. A new directory (never an existing one), then exclusive writes, manifest last, no retry.
  const root = path.resolve(input.projectRoot, ...PRECHECK_ROOT_SEGMENTS);
  const outDir = path.join(root, input.runName);
  try {
    mkdirSync(root, { recursive: true });
    mkdirSync(outDir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return fail(
      "OUTPUT_DIRECTORY_UNAVAILABLE",
      code === "EEXIST"
        ? "Output directory already exists; captures are never overwritten"
        : `Output directory could not be created (${code ?? "UNKNOWN"})`,
      { outDir },
    );
  }
  const filesWritten: string[] = [];
  const writeFile = input.writeEvidenceFile ?? writeFileSync;
  for (const f of prepared) {
    try {
      if (f.category === "RESPONSE" && !filesWritten.some((p) => RESPONSE_PATH.test(p))) {
        mkdirSync(path.join(outDir, EXCHANGES_DIR));
      }
      writeFile(path.join(outDir, ...f.path.split("/")), f.content, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const m = e instanceof Error ? e.message : String(e);
      return fail(
        "ARTIFACT_WRITE_FAILED",
        `Write of ${f.path} failed (${code ?? m}); evidence is not sealed`,
        {
          outDir,
          failedFile: f.path,
          filesWritten,
        },
      );
    }
    filesWritten.push(f.path);
  }
  return {
    ok: true,
    status: "SEALED",
    sealed: true,
    outDir,
    manifestSha256,
    files: entries,
    runCause,
    recordedOutcome: input.validation?.outcome ?? null,
    redaction,
  };
}

// ---------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------

export type WatchRederivationStatus =
  | "REPRODUCED"
  | "MISMATCH"
  | "NOT_ELIGIBLE"
  | "LIMITED_BY_REDACTION"
  | "NOT_ATTEMPTED";

export interface WatchEvidenceVerification {
  readonly outDir: string;
  readonly integrity: { readonly ok: boolean; readonly problems: readonly string[] };
  readonly completeness: {
    readonly sufficientForSelection: boolean;
    readonly reasons: readonly string[];
  };
  readonly rederivation: {
    readonly status: WatchRederivationStatus;
    readonly detail: string;
    readonly recordedOutcome: string | null;
    readonly rederivedOutcome: string | null;
    readonly rederivedReason: string | null;
  };
  readonly terminalCause: WatchRunTerminalCause | null;
  readonly runOutcome: string | null;
  readonly recordedOutcome: WatchCandidateOutcome | null;
  /** Integrity holds and the re-derivation found no contradiction. */
  readonly verified: boolean;
  /** Only true for a completed run whose sealed evidence re-derives the recorded target exactly. */
  readonly selectionConfirmed: boolean;
  /**
   * The recorded target, taken from the same in-memory snapshot that was verified, only when
   * `selectionConfirmed` is true; otherwise null. Deeply frozen: callers use this value and never
   * reopen the evidence files.
   */
  readonly confirmedTarget: WatchCandidateTarget | null;
}

/** Recorded outcomes that can come from acquisition events the exchange records alone do not show. */
const ACQUISITION_OUTCOMES: ReadonlySet<string> = new Set([
  "VALIDATION_DEADLINE_EXPIRED",
  "SESSION_STOPPED",
  "TRANSACTION_REQUEST_FAILED",
  "MARKET_REQUEST_FAILED",
  "TRANSACTION_EVIDENCE_UNAVAILABLE",
]);

/** Every path component under `dir` must be a real directory or (last) a regular file, no links. */
function lstatConfined(
  dir: string,
  rel: string,
): { ok: true; size: number } | { ok: false; problem: string } {
  const parts = rel.split("/");
  let cur = dir;
  for (const [i, part] of parts.entries()) {
    cur = path.join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return { ok: false, problem: `MISSING_FILE:${rel}` };
    }
    if (st.isSymbolicLink()) return { ok: false, problem: `LINK_REJECTED:${rel}` };
    const last = i === parts.length - 1;
    if (!last && !st.isDirectory()) return { ok: false, problem: `NOT_A_DIRECTORY:${rel}` };
    if (last) {
      if (!st.isFile()) return { ok: false, problem: `NOT_REGULAR_FILE:${rel}` };
      if (st.nlink > 1) return { ok: false, problem: `LINK_REJECTED:${rel}` };
      return { ok: true, size: st.size };
    }
  }
  return { ok: false, problem: `MISSING_FILE:${rel}` };
}

/** Lists files at any depth; links, unknown directories and special files are problems. */
function walk(dir: string, problems: string[]): string[] {
  const files: string[] = [];
  const visit = (abs: string, rel: string, depth: number) => {
    if (depth > MAX_WALK_DEPTH) {
      problems.push(`DIRECTORY_TOO_DEEP:${rel}`);
      return;
    }
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      problems.push(`DIRECTORY_UNREADABLE:${rel || "."}`);
      return;
    }
    for (const name of names) {
      const childRel = rel ? `${rel}/${name}` : name;
      const childAbs = path.join(abs, name);
      let st;
      try {
        st = lstatSync(childAbs);
      } catch {
        problems.push(`UNREADABLE_ENTRY:${childRel}`);
        continue;
      }
      if (st.isSymbolicLink()) problems.push(`LINK_REJECTED:${childRel}`);
      else if (st.isDirectory()) {
        if (childRel !== EXCHANGES_DIR) problems.push(`UNLISTED_DIRECTORY:${childRel}`);
        visit(childAbs, childRel, depth + 1);
      } else if (st.isFile()) files.push(childRel);
      else problems.push(`NOT_REGULAR_FILE:${childRel}`);
    }
  };
  visit(dir, "", 0);
  return files;
}

const pick = (o: unknown, k: string): unknown => (isRecord(o) ? o[k] : undefined);

/** Fail-closed verification of a sealed watch evidence directory (read-only). */
export function verifyWatchEvidence(outDir: string): WatchEvidenceVerification {
  const problems: string[] = [];
  const notAttempted = (detail: string) => ({
    status: "NOT_ATTEMPTED" as const,
    detail,
    recordedOutcome: null,
    rederivedOutcome: null,
    rederivedReason: null,
  });
  const integrityFailure = (): WatchEvidenceVerification => ({
    outDir,
    integrity: { ok: false, problems: [...problems] },
    completeness: { sufficientForSelection: false, reasons: ["INTEGRITY_FAILED"] },
    rederivation: notAttempted("Integrity failed; no evidence was consumed"),
    terminalCause: null,
    runOutcome: null,
    recordedOutcome: null,
    verified: false,
    selectionConfirmed: false,
    confirmedTarget: null,
  });

  // 1. The directory and the manifest.
  try {
    const st = lstatSync(outDir);
    if (st.isSymbolicLink() || !st.isDirectory()) problems.push("OUTPUT_DIRECTORY_INVALID");
  } catch {
    problems.push("OUTPUT_DIRECTORY_MISSING");
  }
  if (problems.length > 0) return integrityFailure();
  const manifestStat = lstatConfined(outDir, WATCH_EVIDENCE_FILES.manifest);
  if (!manifestStat.ok) {
    problems.push(
      manifestStat.problem.startsWith("MISSING_FILE")
        ? "MANIFEST_MISSING"
        : `MANIFEST_${manifestStat.problem}`,
    );
    return integrityFailure();
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(path.join(outDir, WATCH_EVIDENCE_FILES.manifest), "utf8"));
  } catch {
    problems.push("MANIFEST_NOT_JSON");
    return integrityFailure();
  }
  if (!isRecord(manifest) || manifest.kind !== WATCH_EVIDENCE_MANIFEST_KIND) {
    problems.push("MANIFEST_KIND_INVALID");
    return integrityFailure();
  }
  if (manifest.version !== WATCH_EVIDENCE_MANIFEST_VERSION) {
    problems.push("MANIFEST_VERSION_UNSUPPORTED");
    return integrityFailure();
  }
  if (manifest.reportFile !== WATCH_EVIDENCE_FILES.report)
    problems.push("MANIFEST_REPORT_REFERENCE_INVALID");
  if (typeof manifest.planDigestSha256 !== "string" || !HEX64.test(manifest.planDigestSha256)) {
    problems.push("MANIFEST_PLAN_DIGEST_INVALID");
  }
  if (!Array.isArray(manifest.files)) {
    problems.push("MANIFEST_FILES_INVALID");
    return integrityFailure();
  }

  // 2. Entries: schema, safe unique confined paths, categories, regular files, sizes, hashes.
  const listed = new Map<string, WatchEvidenceManifestEntry>();
  const seenFolded = new Set<string>();
  const contents = new Map<string, Buffer>();
  const resolvedDir = path.resolve(outDir);
  for (const e of manifest.files as unknown[]) {
    if (
      !isRecord(e) ||
      Object.keys(e).sort().join(",") !== "bytes,category,path,sha256" ||
      typeof e.path !== "string" ||
      (e.category !== "EVIDENCE" && e.category !== "RESPONSE") ||
      typeof e.sha256 !== "string" ||
      !HEX64.test(e.sha256) ||
      !isSafeInt(e.bytes)
    ) {
      problems.push("MANIFEST_ENTRY_MALFORMED");
      continue;
    }
    const p = e.path;
    const abs = path.resolve(resolvedDir, ...p.split("/"));
    if (
      !SAFE_PATH.test(p) ||
      p.split("/").some((seg) => seg === "." || seg === "..") ||
      !abs.startsWith(resolvedDir + path.sep)
    ) {
      problems.push(`UNSAFE_PATH:${p}`);
      continue;
    }
    if (p === WATCH_EVIDENCE_FILES.manifest) {
      problems.push("MANIFEST_LISTS_ITSELF");
      continue;
    }
    if (seenFolded.has(p.toLowerCase())) {
      problems.push(`DUPLICATE_ENTRY:${p}`);
      continue;
    }
    seenFolded.add(p.toLowerCase());
    if ((e.category === "RESPONSE") !== RESPONSE_PATH.test(p)) {
      problems.push(`CATEGORY_INVALID:${p}`);
      continue;
    }
    const entry = e as unknown as WatchEvidenceManifestEntry;
    listed.set(p, entry);
    const st = lstatConfined(resolvedDir, p);
    if (!st.ok) {
      problems.push(st.problem);
      continue;
    }
    if (st.size !== entry.bytes) {
      problems.push(`SIZE_MISMATCH:${p}`);
      continue;
    }
    const bytes = readFileSync(abs);
    if (bytes.length !== entry.bytes) problems.push(`SIZE_MISMATCH:${p}`);
    else if (sha256(bytes) !== entry.sha256) problems.push(`HASH_MISMATCH:${p}`);
    else contents.set(p, bytes);
  }
  for (const req of WATCH_EVIDENCE_REQUIRED_FILES) {
    if (!listed.has(req)) problems.push(`REQUIRED_ENTRY_MISSING:${req}`);
  }

  // 3. Nothing unlisted at any depth (recursive), no links, no unknown directories.
  for (const f of walk(resolvedDir, problems)) {
    if (f !== WATCH_EVIDENCE_FILES.manifest && !listed.has(f)) problems.push(`UNLISTED_FILE:${f}`);
  }
  if (problems.length > 0) return integrityFailure();

  // 4. Core documents, plan and report references (response files are not consumed yet).
  const docs = new Map<string, unknown>();
  for (const [p, entry] of listed) {
    if (entry.category !== "EVIDENCE") continue;
    try {
      docs.set(p, JSON.parse((contents.get(p) as Buffer).toString("utf8")));
    } catch {
      problems.push(`NOT_JSON:${p}`);
    }
  }
  if (problems.length > 0) return integrityFailure();
  const report = docs.get(WATCH_EVIDENCE_FILES.report);
  const selection = docs.get(WATCH_EVIDENCE_FILES.selection);
  const validationDoc = docs.get(WATCH_EVIDENCE_FILES.validation);
  const watchDoc = docs.get(WATCH_EVIDENCE_FILES.watchObservations);
  const contextDoc = docs.get(WATCH_EVIDENCE_FILES.context);
  const ledgerDoc = docs.get(WATCH_EVIDENCE_FILES.requestLedger);
  const indexDoc = docs.get(WATCH_EVIDENCE_FILES.requestExchanges);

  if (
    pick(report, "kind") !== WATCH_EVIDENCE_REPORT_KIND ||
    pick(report, "version") !== WATCH_EVIDENCE_MANIFEST_VERSION
  ) {
    problems.push("REPORT_KIND_INVALID");
  }
  const planDigest = sha256(contents.get(WATCH_EVIDENCE_FILES.plan) as Buffer);
  if (manifest.planDigestSha256 !== planDigest) problems.push("PLAN_DIGEST_MISMATCH:manifest");
  if (pick(report, "planDigestSha256") !== planDigest) problems.push("PLAN_DIGEST_MISMATCH:report");
  const reportFiles = pick(report, "files");
  const expectedReportFiles: Record<string, string> = {
    plan: WATCH_EVIDENCE_FILES.plan,
    context: WATCH_EVIDENCE_FILES.context,
    watchObservations: WATCH_EVIDENCE_FILES.watchObservations,
    requestLedger: WATCH_EVIDENCE_FILES.requestLedger,
    requestExchanges: WATCH_EVIDENCE_FILES.requestExchanges,
    validation: WATCH_EVIDENCE_FILES.validation,
    selection: WATCH_EVIDENCE_FILES.selection,
  };
  if (!isRecord(reportFiles) || canonical(reportFiles) !== canonical(expectedReportFiles)) {
    problems.push("REPORT_FILE_REFERENCES_INVALID");
  }
  if (
    pick(report, "credentialsRecorded") !== false ||
    pick(report, "requestHeadersRecorded") !== false
  ) {
    problems.push("REPORT_RECORDING_FLAGS_INVALID");
  }

  // 5. Exchange index and ledger agreement (still before consuming any response file).
  const index = pick(indexDoc, "exchanges");
  const ledgerEntries = pick(ledgerDoc, "entries");
  const httpAttempts = pick(ledgerDoc, "httpAttempts");
  const indexed: { seq: number; purpose: unknown; file: string }[] = [];
  if (!Array.isArray(index) || !Array.isArray(ledgerEntries) || !isSafeInt(httpAttempts)) {
    problems.push("EXCHANGE_INDEX_OR_LEDGER_MALFORMED");
    return integrityFailure();
  }
  for (const [i, x] of index.entries()) {
    const seq = pick(x, "seq");
    const file = pick(x, "file");
    if (seq !== i + 1 || typeof file !== "string" || file !== precheckExchangePath(i + 1)) {
      problems.push(`EXCHANGE_INDEX_REFERENCE_INVALID:${i + 1}`);
      continue;
    }
    if (listed.get(file)?.category !== "RESPONSE") {
      problems.push(`EXCHANGE_REFERENCE_UNLISTED:${file}`);
      continue;
    }
    indexed.push({ seq, purpose: pick(x, "purpose"), file });
  }
  const indexedFiles = new Set(indexed.map((x) => x.file));
  for (const [p, entry] of listed) {
    if (entry.category === "RESPONSE" && !indexedFiles.has(p))
      problems.push(`UNINDEXED_RESPONSE:${p}`);
  }
  const reportExchangeFiles = pick(report, "exchangeFiles");
  if (canonical(reportExchangeFiles) !== canonical(indexed.map((x) => x.file))) {
    problems.push("REPORT_EXCHANGE_REFERENCES_INVALID");
  }
  if (ledgerEntries.length !== index.length) problems.push("LEDGER_INDEX_COUNT_MISMATCH");
  for (const [i, le] of ledgerEntries.entries()) {
    const ix = indexed[i];
    if (
      !ix ||
      pick(le, "seq") !== ix.seq ||
      pick(le, "file") !== ix.file ||
      pick(le, "purpose") !== ix.purpose
    ) {
      problems.push(`LEDGER_INDEX_MISMATCH:${i + 1}`);
    }
  }
  if (pick(indexDoc, "httpAttempts") !== httpAttempts)
    problems.push("LEDGER_INDEX_ATTEMPTS_MISMATCH");
  const missingExchangeCount = (httpAttempts as number) - index.length;
  if (
    missingExchangeCount < 0 ||
    pick(indexDoc, "missingExchangeCount") !== missingExchangeCount ||
    (httpAttempts as number) > DEFAULT_WATCH_VALIDATION_LIMITS.maxHttpAttempts
  ) {
    problems.push("EXCHANGE_ACCOUNTING_INVALID");
  }

  // 6. Validation, selection and terminal cause agree with each other.
  const recorded = pick(validationDoc, "recorded");
  const result = pick(validationDoc, "result");
  if (recorded !== true && recorded !== false) problems.push("VALIDATION_DOCUMENT_MALFORMED");
  if (recorded === true) {
    if (!isRecord(result) || typeof result.outcome !== "string")
      problems.push("VALIDATION_DOCUMENT_MALFORMED");
    else {
      if (result.exchangeCount !== index.length)
        problems.push("VALIDATION_EXCHANGE_COUNT_MISMATCH");
      if (result.httpAttempts !== httpAttempts) problems.push("VALIDATION_ATTEMPTS_MISMATCH");
    }
  } else if (recorded === false && (index.length !== 0 || httpAttempts !== 0 || result !== null)) {
    problems.push("EXCHANGES_WITHOUT_VALIDATION");
  }
  const recordedOutcome =
    recorded === true && isRecord(result) ? (result.outcome as WatchCandidateOutcome) : null;
  const watchResult = pick(watchDoc, "watchResult");
  const watchStatus = pick(watchResult, "status");
  const cause = pick(report, "terminalCause");
  const causeProblem = terminalCauseProblem(cause, watchStatus, recordedOutcome);
  if (causeProblem !== null) problems.push(`TERMINAL_CAUSE:${causeProblem}`);
  if (canonical(pick(selection, "terminalCause")) !== canonical(cause))
    problems.push("SELECTION_CAUSE_MISMATCH");
  const terminalCause = causeProblem === null ? (cause as unknown as WatchRunTerminalCause) : null;
  const code = terminalCause?.code ?? null;
  const runOutcome = code === "COMPLETED" ? recordedOutcome : code;
  const selected = code === "COMPLETED" && recordedOutcome === "TARGET_SELECTED";
  if (
    pick(report, "recordedOutcome") !== recordedOutcome ||
    pick(selection, "recordedOutcome") !== recordedOutcome
  ) {
    problems.push("RECORDED_OUTCOME_MISMATCH");
  }
  if (pick(report, "runOutcome") !== runOutcome || pick(selection, "runOutcome") !== runOutcome) {
    problems.push("RUN_OUTCOME_MISMATCH");
  }
  if (pick(report, "selected") !== selected || pick(selection, "selected") !== selected) {
    problems.push("SELECTED_FLAG_INVALID");
  }
  if (pick(selection, "watchStatus") !== watchStatus)
    problems.push("SELECTION_WATCH_STATUS_MISMATCH");
  if (
    recorded === true &&
    isRecord(result) &&
    (canonical(pick(selection, "target")) !== canonical(result.target) ||
      canonical(pick(selection, "discovery")) !== canonical(result.discovery) ||
      pick(selection, "reason") !== result.reason)
  ) {
    problems.push("SELECTION_DIFFERS_FROM_VALIDATION");
  }

  // Policy context: limits resolved independently by the reviewed resolver from the supplied
  // context (the recorded `resolvedLimits` are only compared, never trusted).
  const supplied = pick(contextDoc, "suppliedContext");
  const suppliedLimits = pick(supplied, "limits");
  const suppliedDeadline = pick(supplied, "overallDeadlineAtMs");
  let limits: WatchCandidateValidationLimits | null = null;
  if (
    pick(contextDoc, "kind") !== "PAPER_WATCH_POLICY_CONTEXT" ||
    !isRecord(supplied) ||
    !(suppliedLimits === null || isRecord(suppliedLimits)) ||
    !(suppliedDeadline === null || isSafeInt(suppliedDeadline))
  ) {
    problems.push("CONTEXT_MALFORMED");
  } else {
    try {
      limits = resolveWatchValidationLimits(
        isRecord(suppliedLimits)
          ? (suppliedLimits as Partial<WatchCandidateValidationLimits>)
          : undefined,
      );
    } catch {
      problems.push("CONTEXT_LIMITS_INVALID");
    }
  }
  if (limits !== null && canonical(pick(contextDoc, "resolvedLimits")) !== canonical(limits)) {
    problems.push("CONTEXT_RESOLVED_LIMITS_MISMATCH");
  }
  if (
    canonical(pick(contextDoc, "reviewedWatchPolicy")) !== canonical(REVIEWED_WATCH_POLICY) ||
    canonical(pick(contextDoc, "defaultValidationLimits")) !==
      canonical(DEFAULT_WATCH_VALIDATION_LIMITS)
  ) {
    problems.push("CONTEXT_POLICY_MISMATCH");
  }
  const recordedDeadline =
    recorded === true && isRecord(result) ? (result.validationDeadlineAtMs ?? null) : null;
  if (
    pick(contextDoc, "recordedValidationDeadlineAtMs") !== recordedDeadline ||
    pick(contextDoc, "recomputedValidationDeadlineAtMs") !==
      (recorded === true && isRecord(result) && isRecord(result.discovery)
        ? recordedDeadline
        : null)
  ) {
    problems.push("CONTEXT_DEADLINE_MISMATCH");
  }
  if (problems.length > 0 || limits === null) return integrityFailure();

  // 7. Response files: kind, ledger agreement, digests (consumed only now).
  const exchanges: PrecheckExchange[] = [];
  const redactedBodies: number[] = [];
  const consumedLiteral: { file: string; seq: number; fields: string[] }[] = [];
  const bodyStates: { seq: number; state: unknown }[] = [];
  for (const [i, ix] of indexed.entries()) {
    let ex: unknown;
    try {
      ex = JSON.parse((contents.get(ix.file) as Buffer).toString("utf8"));
    } catch {
      problems.push(`NOT_JSON:${ix.file}`);
      continue;
    }
    const le = ledgerEntries[i];
    const resp = pick(ex, "response");
    const req = pick(ex, "request");
    if (pick(ex, "kind") !== WATCH_EXCHANGE_KIND || !isRecord(resp) || !isRecord(req)) {
      problems.push(`EXCHANGE_MALFORMED:${ix.seq}`);
      continue;
    }
    const fields: [string, unknown, unknown][] = [
      ["seq", pick(ex, "seq"), pick(le, "seq")],
      ["purpose", pick(ex, "purpose"), pick(le, "purpose")],
      ["lane", pick(ex, "lane"), pick(le, "lane")],
      ["dispatchedAtMs", pick(ex, "dispatchedAtMs"), pick(le, "dispatchedAtMs")],
      ["completedAtMs", pick(ex, "completedAtMs"), pick(le, "completedAtMs")],
      ["httpStatus", pick(ex, "httpStatus"), pick(le, "httpStatus")],
      ["error", pick(ex, "error"), pick(le, "error")],
      ["bodyState", resp.bodyState, pick(le, "bodyState")],
      ["receivedBytesSha256", resp.receivedBytesSha256, pick(le, "receivedBytesSha256")],
      ["sanitizedBytesSha256", resp.sanitizedBytesSha256, pick(le, "sanitizedBytesSha256")],
      ["bodyRedacted", resp.bodyRedacted, pick(le, "bodyRedacted")],
    ];
    for (const [name, a, b] of fields) {
      if (canonical(a) !== canonical(b))
        problems.push(`EXCHANGE_LEDGER_MISMATCH:${ix.seq}:${name}`);
    }
    if (req.headersRecorded !== false || "headers" in req)
      problems.push(`REQUEST_HEADERS_RECORDED:${ix.seq}`);
    const stored = decodeStoredBody(resp.body, resp.bodyEncoding);
    if (stored === "INVALID") {
      problems.push(`EXCHANGE_BODY_UNDECODABLE:${ix.seq}`);
      continue;
    }
    if (stored === null) {
      if (resp.sanitizedBytesSha256 !== null) {
        problems.push(`EXCHANGE_BODY_ACCOUNTING_INVALID:${ix.seq}:SANITIZED_DIGEST`);
      }
    } else if (sha256(stored) !== resp.sanitizedBytesSha256) {
      problems.push(`EXCHANGE_BODY_DIGEST_MISMATCH:${ix.seq}`);
    }
    // Body state, declared and effective limits, digest scope, lengths and flags, against the
    // independently resolved lane limit.
    for (const name of bodyAccountingProblems(
      { lane: pick(ex, "lane"), error: pick(ex, "error"), httpStatus: pick(ex, "httpStatus") },
      resp,
      stored,
      resp.sanitizedBytesSha256,
      limits,
    )) {
      problems.push(`EXCHANGE_BODY_ACCOUNTING_INVALID:${ix.seq}:${name}`);
    }
    if (stored !== null && resp.bodyRedacted === true) redactedBodies.push(ix.seq);
    const consumed = consumedRedactedFields(ex);
    if (consumed.length > 0) consumedLiteral.push({ file: ix.file, seq: ix.seq, fields: consumed });
    bodyStates.push({ seq: ix.seq, state: resp.bodyState });
    exchanges.push(ex as unknown as PrecheckExchange);
  }
  const redactionClaim = pick(report, "redaction");
  const frameRedactions = pick(watchDoc, "frameRedactions");
  const redactedFrames = Array.isArray(frameRedactions)
    ? frameRedactions.map((f) => pick(f, "index"))
    : null;
  if (redactedFrames === null) problems.push("FRAME_REDACTIONS_MALFORMED");
  if (
    canonical(pick(redactionClaim, "bodies")) !== canonical(redactedBodies) ||
    canonical(pick(redactionClaim, "frames")) !== canonical(redactedFrames)
  ) {
    problems.push("REDACTION_CLAIM_MISMATCH");
  }
  // Literal-redaction claims name listed files that actually carry the marker; the summary flags
  // agree with the claims (a claim can only widen what the re-derivation attributes to redaction).
  const literalByFile = pick(redactionClaim, "literalByFile");
  const literalCount = new Map<string, number>();
  if (!isRecord(literalByFile)) problems.push("REDACTION_CLAIM_MISMATCH:literalByFile");
  else {
    for (const [p, n] of Object.entries(literalByFile)) {
      if (!isSafeInt(n) || !listed.has(p) || p === WATCH_EVIDENCE_FILES.report) {
        problems.push(`REDACTION_CLAIM_MISMATCH:${p}`);
        continue;
      }
      const markers = (contents.get(p) as Buffer).toString("utf8").split(REDACTED).length - 1;
      if (n > markers) problems.push(`REDACTION_CLAIM_UNSUPPORTED:${p}`);
      if (n > 0) literalCount.set(p, n);
    }
  }
  const literalDerivation = [...literalCount.keys()].filter(
    (p) => DERIVATION_FILES.includes(p) || RESPONSE_PATH.test(p),
  );
  const claimedApplied =
    redactedBodies.length > 0 || (redactedFrames?.length ?? 0) > 0 || literalCount.size > 0;
  const claimedReproducible =
    redactedBodies.length === 0 &&
    (redactedFrames?.length ?? 0) === 0 &&
    literalDerivation.length === 0;
  if (
    pick(redactionClaim, "applied") !== claimedApplied ||
    pick(redactionClaim, "reproducible") !== claimedReproducible
  ) {
    problems.push("REDACTION_CLAIM_MISMATCH:flags");
  }
  if (problems.length > 0) return integrityFailure();

  // Completeness: could this sealed evidence support a selected target at all?
  const reasons: string[] = [];
  if (code !== "COMPLETED") reasons.push(`TERMINAL_CAUSE:${code}`);
  if (watchStatus !== "NOTIFICATION_CAPTURED")
    reasons.push(`WATCH_DID_NOT_CAPTURE:${String(watchStatus)}`);
  if (recorded !== true) reasons.push("VALIDATION_NOT_RECORDED");
  if (missingExchangeCount > 0) reasons.push(`MISSING_EXCHANGES:${missingExchangeCount}`);
  for (const b of bodyStates) {
    if (b.state !== "COMPLETE") reasons.push(`PARTIAL_OR_UNREAD_BODY:${b.seq}:${String(b.state)}`);
  }
  for (const s of redactedBodies) reasons.push(`BODY_REDACTED:${s}`);
  for (const f of redactedFrames ?? []) reasons.push(`FRAME_REDACTED:${String(f)}`);
  for (const p of literalDerivation) reasons.push(`LITERAL_REDACTION:${p}`);
  if (recordedOutcome !== "TARGET_SELECTED") reasons.push(`OUTCOME:${recordedOutcome ?? "NONE"}`);
  const completeness = { sufficientForSelection: reasons.length === 0, reasons };

  // Re-derivation with the reviewed functions on the sealed evidence and policy context. Which
  // evidence redaction touched is tracked per input, so only a difference that the redacted
  // evidence could have caused is reported as a limitation.
  const rederivation = rederive({
    recorded: recorded === true,
    result: isRecord(result) ? result : null,
    recordedOutcome,
    code,
    watchResult,
    contextDoc,
    exchanges,
    scope: {
      frames:
        (redactedFrames?.length ?? 0) > 0 ||
        literalCount.has(WATCH_EVIDENCE_FILES.watchObservations),
      recorded: literalCount.has(WATCH_EVIDENCE_FILES.validation),
      bodies: new Set(redactedBodies),
      // Only claimed literal redaction inside fields the derivation reads; a redacted response
      // header (or any other unread string) cannot explain a derivation difference.
      exchangeLiteral: new Map(
        consumedLiteral.filter((c) => literalCount.has(c.file)).map((c) => [c.seq, c.fields]),
      ),
    },
  });
  const verified = rederivation.status !== "MISMATCH";
  const selectionConfirmed =
    verified && completeness.sufficientForSelection && rederivation.status === "REPRODUCED";
  return {
    outDir,
    integrity: { ok: true, problems: [] },
    completeness,
    rederivation,
    terminalCause,
    runOutcome,
    recordedOutcome,
    verified,
    selectionConfirmed,
    // The re-derivation reproduced exactly this snapshot's recorded target (a fresh copy, so no
    // later change to the files or to the parsed documents can reach it).
    confirmedTarget:
      selectionConfirmed && isRecord(result) && isRecord(result.target)
        ? deepFreeze(structuredClone(result.target) as unknown as WatchCandidateTarget)
        : null,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Which sealed inputs credential redaction changed. */
interface RedactionScope {
  /** Watch frame bytes or watch-observation strings (the discovery verification's inputs). */
  readonly frames: boolean;
  /** Strings of the recorded validation result (the comparison's recorded side). */
  readonly recorded: boolean;
  /** Response bodies by exchange seq. */
  readonly bodies: ReadonlySet<number>;
  /**
   * Exchange-record fields that the pure derivation reads and that carry the redaction marker, by
   * seq (claimed files only). Response headers and other unread strings are never listed.
   */
  readonly exchangeLiteral: ReadonlyMap<number, readonly string[]>;
}

/**
 * Exchange-record fields the pure derivation reads: the request policy (purpose, lane, method,
 * URL, RPC method and params), the transaction decode (JSON-RPC id, error) and the body checks
 * (state, encoding). The body itself is excluded: its redaction is tracked as a body redaction,
 * and an unredacted body is bound to the received bytes by the accounting checks.
 */
function consumedRedactedFields(ex: unknown): string[] {
  const marked = (v: unknown): boolean =>
    typeof v === "string"
      ? v.includes(REDACTED)
      : Array.isArray(v)
        ? v.some(marked)
        : isRecord(v)
          ? Object.entries(v).some(([k, x]) => k.includes(REDACTED) || marked(x))
          : false;
  const req = pick(ex, "request");
  const resp = pick(ex, "response");
  const fields: [string, unknown][] = [
    ["purpose", pick(ex, "purpose")],
    ["lane", pick(ex, "lane")],
    ["jsonRpcId", pick(ex, "jsonRpcId")],
    ["error", pick(ex, "error")],
    ["request.method", pick(req, "method")],
    ["request.url", pick(req, "url")],
    ["request.rpcMethod", pick(req, "rpcMethod")],
    ["request.rpcParams", pick(req, "rpcParams")],
    ["response.bodyState", pick(resp, "bodyState")],
    ["response.bodyEncoding", pick(resp, "bodyEncoding")],
  ];
  return fields.filter(([, v]) => marked(v)).map(([name]) => name);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Deep equality where, with `allowRedacted`, a recorded string carrying the redaction marker
 * matches a derived string that equals it outside the redacted spans. Numbers, booleans, null
 * and structure must match exactly.
 */
function sameModuloRedaction(derived: unknown, recorded: unknown, allowRedacted: boolean): boolean {
  if (typeof recorded === "string" && typeof derived === "string") {
    if (derived === recorded) return true;
    if (!allowRedacted || !recorded.includes(REDACTED)) return false;
    const pattern = recorded.split(REDACTED).map(escapeRegExp).join("[\\s\\S]+");
    return new RegExp(`^${pattern}$`).test(derived);
  }
  if (Array.isArray(recorded) || Array.isArray(derived)) {
    return (
      Array.isArray(recorded) &&
      Array.isArray(derived) &&
      recorded.length === derived.length &&
      recorded.every((v, i) => sameModuloRedaction(derived[i], v, allowRedacted))
    );
  }
  if (isRecord(recorded) || isRecord(derived)) {
    if (!isRecord(recorded) || !isRecord(derived)) return false;
    const keys = (o: Record<string, unknown>) =>
      Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort();
    const rk = keys(recorded);
    return (
      canonical(rk) === canonical(keys(derived)) &&
      rk.every((k) => sameModuloRedaction(derived[k], recorded[k], allowRedacted))
    );
  }
  return canonical(derived) === canonical(recorded);
}

/** Discovery fields that are numbers: credential redaction can never change them. */
const NUMERIC_DISCOVERY_FIELDS = [
  "slot",
  "subscriptionId",
  "notificationReceivedAtMs",
  "watchStartedAtMs",
] as const;

/**
 * With redacted frames the discovery proof cannot be re-verified exactly, but the recorded
 * discovery's numbers must still agree with the sealed watch metadata, which redaction does not
 * change. Returns a contradiction, or null.
 */
function frameMetadataContradiction(
  watchResult: unknown,
  discovery: Record<string, unknown>,
): string | null {
  const obs = pick(watchResult, "observations");
  const frames = pick(obs, "applicationFrames");
  const last = Array.isArray(frames) ? frames[frames.length - 1] : undefined;
  let frameSlot: unknown;
  try {
    const payload = pick(last, "payload");
    frameSlot =
      typeof payload === "string"
        ? pick(pick(pick(pick(JSON.parse(payload), "params"), "result"), "context"), "slot")
        : undefined;
  } catch {
    frameSlot = undefined;
  }
  const checks: [string, unknown, unknown][] = [
    ["watchStartedAtMs", discovery.watchStartedAtMs, pick(obs, "startedAtMs")],
    ["notificationReceivedAtMs", discovery.notificationReceivedAtMs, pick(last, "timestampMs")],
    ["subscriptionId", discovery.subscriptionId, pick(obs, "subscriptionId")],
    ["slot", discovery.slot, pick(pick(watchResult, "notification"), "slot")],
    ...(typeof frameSlot === "number"
      ? [["slot (notification frame)", discovery.slot, frameSlot] as [string, unknown, unknown]]
      : []),
  ];
  const bad = checks.filter(([, a, b]) => !isSafeInt(a) || a !== b).map(([n]) => n);
  return bad.length > 0
    ? `Recorded discovery numbers contradict the sealed watch metadata (${bad.join(", ")}); redaction cannot change numbers`
    : null;
}

/** Recorded outcomes reachable only after the transaction qualified and the market body was read. */
const MARKET_BODY_OUTCOMES: ReadonlySet<string> = new Set([
  "TARGET_SELECTED",
  "START_WINDOW_ALREADY_CLOSED",
  "MARKET_NONMATCH",
  "MARKET_EVIDENCE_UNAVAILABLE",
]);
const TARGET_OUTCOMES: ReadonlySet<string> = new Set([
  "TARGET_SELECTED",
  "START_WINDOW_ALREADY_CLOSED",
]);
const TRANSACTION_STAGE_INVALID_REASONS: ReadonlySet<string> = new Set([
  "MARKET_REQUEST_WITHOUT_QUALIFIED_TRANSACTION",
  "MARKET_REQUEST_NOT_FOR_DECODED_MINT",
]);

type RedactionCause = "TRANSACTION_BODY" | "MARKET_BODY" | "EXCHANGE_RECORD";

/**
 * The redacted evidence that the pure derivation actually consumed and that stopped it, or null
 * when the derivation's result depends on no redacted evidence (then any difference from the
 * recorded result is a contradiction that redaction cannot explain).
 */
function redactionCauseOf(
  pure: { readonly outcome: string; readonly reason: string | null },
  exchanges: readonly PrecheckExchange[],
  discovery: WatchedDiscoveryEvidence,
  scope: RedactionScope,
): RedactionCause | null {
  const [tx, market] = exchanges;
  if (
    tx &&
    scope.bodies.has(tx.seq) &&
    (pure.reason === "EVIDENCE_UNAVAILABLE:BODY_REDACTED" ||
      pure.reason === "MARKET_REQUEST_WITHOUT_QUALIFIED_TRANSACTION")
  ) {
    const ev = evaluateInitializationExchange(tx, {
      signature: discovery.signature,
      slot: discovery.slot,
    });
    if (!ev.ok && ev.status === "EVIDENCE_UNAVAILABLE:BODY_REDACTED") return "TRANSACTION_BODY";
  }
  if (
    market &&
    scope.bodies.has(market.seq) &&
    pure.outcome === "MARKET_EVIDENCE_UNAVAILABLE" &&
    pure.reason === "BODY_REDACTED"
  ) {
    return "MARKET_BODY";
  }
  // Redacted fields that the derivation reads (request identity, JSON-RPC id, error strings) feed
  // the request policy and decode; attributed conservatively, while the recorded result is still
  // checked against every fact the unredacted evidence derives independently.
  if (scope.exchangeLiteral.size > 0) return "EXCHANGE_RECORD";
  return null;
}

/** Recorded outcomes that stop at the transaction stage. */
const TRANSACTION_STAGE_OUTCOMES: ReadonlySet<string> = new Set([
  "TRANSACTION_REQUEST_FAILED",
  "TRANSACTION_EVIDENCE_UNAVAILABLE",
  "TRANSACTION_NONMATCH",
]);

/** Exchange fields the transaction decode reads whose qualifying value the evidence fixes. */
const DECODE_SUBSTITUTED_FIELDS: ReadonlySet<string> = new Set([
  "request.rpcMethod",
  "request.rpcParams",
  "jsonRpcId",
]);

/**
 * The sealed exchanges with each redacted field the derivation reads replaced by the value a
 * compliant, qualifying request carries, where the redacted string admits that value (the marker
 * spans could hide it). Bodies, times and sequence numbers stay as sealed, so everything the
 * derivation computes from them is unchanged: the original exchanges derive exactly what these
 * derive, or fail a check on a redacted field. A redacted string that cannot hold the qualifying
 * value (and a redacted error, which was non-null) is left as sealed: the original failed too.
 */
function qualifyingSubstitution(
  exchanges: readonly PrecheckExchange[],
  discovery: WatchedDiscoveryEvidence,
  scope: RedactionScope,
): { exchanges: PrecheckExchange[]; substituted: Map<number, string[]> } {
  const substituted = new Map<number, string[]>();
  const out: PrecheckExchange[] = [];
  for (const [i, sealed] of exchanges.entries()) {
    const fields = scope.exchangeLiteral.get(sealed.seq) ?? [];
    if (fields.length === 0 || i > 1) {
      out.push(sealed);
      continue;
    }
    const ex = JSON.parse(JSON.stringify(sealed)) as Record<string, unknown> & {
      request: Record<string, unknown>;
    };
    const done: string[] = [];
    const put = (name: string, holder: Record<string, unknown>, key: string, value: unknown) => {
      const current = holder[key];
      if (
        fields.includes(name) &&
        typeof current === "string" &&
        typeof value === "string" &&
        sameModuloRedaction(value, current, true)
      ) {
        holder[key] = value;
        done.push(name);
      }
    };
    if (i === 0) {
      put("purpose", ex, "purpose", "PRECHECK_TRANSACTION");
      put("lane", ex, "lane", "SOLANA_RPC");
      put("request.method", ex.request, "method", "POST");
      put("request.url", ex.request, "url", RPC_URL_PLACEHOLDER);
      put("request.rpcMethod", ex.request, "rpcMethod", "getTransaction");
      const params = ex.request.rpcParams;
      if (Array.isArray(params)) {
        put(
          "request.rpcParams",
          params as unknown as Record<string, unknown>,
          "0",
          discovery.signature,
        );
      }
      let bodyId: unknown;
      try {
        bodyId = pick(JSON.parse(String(sealed.response.body)), "id");
      } catch {
        bodyId = undefined;
      }
      put("jsonRpcId", ex, "jsonRpcId", bodyId);
    } else {
      put("purpose", ex, "purpose", "PRECHECK_MARKET");
      put("lane", ex, "lane", "DEXSCREENER");
      put("request.method", ex.request, "method", "GET");
      const tx = out[0];
      const txEval = tx
        ? evaluateInitializationExchange(tx, {
            signature: discovery.signature,
            slot: discovery.slot,
          })
        : null;
      if (txEval?.ok === true) {
        put(
          "request.url",
          ex.request,
          "url",
          SINGLE_CANDIDATE_PUBLIC_ENDPOINTS.marketUrlFor(txEval.init.mintAddress),
        );
      }
    }
    if (done.length > 0) substituted.set(sealed.seq, done);
    out.push(ex as unknown as PrecheckExchange);
  }
  return { exchanges: out, substituted };
}

/**
 * Parts of the recorded result that do not depend on the redacted evidence must still agree with
 * the sealed evidence. Returns a contradiction, or null.
 */
function recordedContradiction(
  cause: RedactionCause,
  result: Record<string, unknown>,
  recordedOutcome: string | null,
  discovery: WatchedDiscoveryEvidence,
  exchanges: readonly PrecheckExchange[],
  scope: RedactionScope,
  context: WatchEvidenceContext,
): string | null {
  const same = (derived: unknown, recordedValue: unknown) =>
    sameModuloRedaction(derived, recordedValue, scope.recorded);
  const outcome = recordedOutcome ?? "";
  const target = result.target;
  if (TARGET_OUTCOMES.has(outcome) !== isRecord(target)) {
    return "The recorded target's presence contradicts the recorded outcome";
  }
  const [tx, market] = exchanges;
  // With an unredacted body, the transaction's evaluation is an independent fact. It is exact when
  // no field the decode reads was substituted; with substituted fields it is what the body derives
  // if the request qualified (the original derived exactly that, or failed).
  const qualifying = qualifyingSubstitution(exchanges, discovery, scope);
  const txQualifying = qualifying.exchanges[0];
  const txEval =
    tx && txQualifying && !scope.bodies.has(tx.seq)
      ? evaluateInitializationExchange(txQualifying, {
          signature: discovery.signature,
          slot: discovery.slot,
        })
      : null;
  const txExact =
    tx !== undefined &&
    !(qualifying.substituted.get(tx.seq) ?? []).some((f) => DECODE_SUBSTITUTED_FIELDS.has(f));
  if (txEval !== null) {
    if (txEval.ok && txExact && TRANSACTION_STAGE_OUTCOMES.has(outcome)) {
      return "The unredacted transaction evidence qualifies, but the recorded outcome stops at the transaction stage; redaction cannot explain that";
    }
    if (!txEval.ok && MARKET_BODY_OUTCOMES.has(outcome)) {
      return "The unredacted transaction evidence does not qualify, but the recorded outcome needs a qualified transaction; redaction cannot explain that";
    }
  }
  if (cause === "TRANSACTION_BODY") {
    if (
      outcome === "EXCHANGE_EVIDENCE_INVALID" &&
      !TRANSACTION_STAGE_INVALID_REASONS.has(String(result.reason))
    ) {
      return "The sealed request policy passes, but the recorded result rejected it; the redacted transaction body cannot explain that";
    }
    if (!market && MARKET_BODY_OUTCOMES.has(outcome) && outcome !== "MARKET_EVIDENCE_UNAVAILABLE") {
      return "The recorded outcome needs a market exchange that was never sealed";
    }
  }
  if (cause === "MARKET_BODY") {
    if (!MARKET_BODY_OUTCOMES.has(outcome)) {
      return "The sealed transaction qualifies and the market body was read, but the recorded outcome is not one that follows; the redacted market body cannot explain that";
    }
  }
  if (!isRecord(target)) return null;
  const init = pick(target, "initialization");
  const marketPart = pick(target, "market");
  if (!tx || !market) return "A recorded target needs both exchanges";
  const expectedMarketUrl = SINGLE_CANDIDATE_PUBLIC_ENDPOINTS.marketUrlFor(
    String(target.mintAddress),
  );
  const marketUrlMatches =
    same(market.request.url, expectedMarketUrl) ||
    (scope.exchangeLiteral.get(market.seq)?.includes("request.url") === true &&
      sameModuloRedaction(expectedMarketUrl, market.request.url, true));
  if (
    pick(init, "slot") !== discovery.slot ||
    pick(init, "exchangeSeq") !== tx.seq ||
    pick(marketPart, "exchangeSeq") !== market.seq ||
    pick(marketPart, "receivedAtMs") !== market.completedAtMs ||
    !same(discovery.signature, pick(init, "signature")) ||
    !marketUrlMatches
  ) {
    return "The recorded target's discovery, exchange or market-request identity contradicts the sealed evidence";
  }
  if (txEval !== null) {
    // The unredacted transaction body re-derives the initialization independently.
    const ev = txEval;
    if (!ev.ok) return "The sealed transaction no longer qualifies";
    const derived = {
      poolId: ev.init.poolId,
      mintAddress: ev.init.mintAddress,
      signature: ev.init.signature,
      slot: ev.init.slot,
      transactionBlockTimeSec: ev.init.transactionBlockTimeSec,
      instructionRequestedOpenTimeSec: ev.init.instructionRequestedOpenTimeSec,
    };
    const recordedInit = {
      poolId: target.poolId,
      mintAddress: target.mintAddress,
      signature: pick(init, "signature"),
      slot: pick(init, "slot"),
      transactionBlockTimeSec: pick(init, "transactionBlockTimeSec"),
      instructionRequestedOpenTimeSec: pick(init, "instructionRequestedOpenTimeSec"),
    };
    if (!same(derived, recordedInit)) {
      return "The recorded target's initialization contradicts the unredacted transaction evidence";
    }
  }
  // With both bodies unredacted, the whole target re-derives from the qualifying substitution: a
  // recorded target must be exactly what it derives.
  if (cause === "EXCHANGE_RECORD" && exchanges.every((ex) => !scope.bodies.has(ex.seq))) {
    const derived = evaluateWatchCandidateEvidence(discovery, qualifying.exchanges, context);
    if (derived.outcome !== outcome || !same(derived.target, target)) {
      return "The recorded target differs from what the unredacted bodies derive even with the redacted request fields at their qualifying values; redaction cannot explain that";
    }
  }
  return null;
}

function rederive(a: {
  recorded: boolean;
  result: Record<string, unknown> | null;
  recordedOutcome: WatchCandidateOutcome | null;
  code: WatchRunTerminalCode | null;
  watchResult: unknown;
  contextDoc: unknown;
  exchanges: readonly PrecheckExchange[];
  scope: RedactionScope;
}): WatchEvidenceVerification["rederivation"] {
  const out = (
    status: WatchRederivationStatus,
    detail: string,
    rederivedOutcome: string | null = null,
    rederivedReason: string | null = null,
  ) => ({ status, detail, recordedOutcome: a.recordedOutcome, rederivedOutcome, rederivedReason });
  if (!a.recorded || a.result === null) {
    return out(
      "NOT_ELIGIBLE",
      `No validation was recorded (terminal cause ${a.code ?? "UNKNOWN"}); nothing to re-derive`,
    );
  }
  if (a.recordedOutcome === "OPERATOR_CANCELLED") {
    return out(
      "NOT_ELIGIBLE",
      "Operator cancellation is an acquisition event; the recorded outcome is preserved and no target is derived",
    );
  }
  const limited = (detail: string, o: string | null = null, r: string | null = null) =>
    out("LIMITED_BY_REDACTION", `Redaction prevents exact re-derivation: ${detail}`, o, r);
  const mismatch = (detail: string, o: string | null = null, r: string | null = null) =>
    out("MISMATCH", detail, o, r);

  const supplied = pick(a.contextDoc, "suppliedContext");
  const deadlineAt = pick(supplied, "overallDeadlineAtMs");
  const limits = pick(supplied, "limits");
  const context: WatchEvidenceContext = {
    ...(typeof deadlineAt === "number" ? { overallDeadlineAtMs: deadlineAt } : {}),
    ...(isRecord(limits) ? { limits: limits as WatchEvidenceContext["limits"] } : {}),
  };
  const result = a.result;
  const recordedDiscovery = isRecord(result.discovery) ? result.discovery : null;
  const completedAtMs = typeof result.completedAtMs === "number" ? result.completedAtMs : undefined;

  // 1. Discovery (inputs: the watch frames). Redaction there can only explain a difference when
  //    the frames were redacted; the derivation then continues from the recorded discovery, whose
  //    numbers must still agree with the sealed watch metadata.
  const verification = validateWatchedDiscoveryEvidence(
    a.watchResult as BoundedAmmV4CreationWatchResult,
    { nowMs: completedAtMs },
  );
  type Rederivation = ReturnType<typeof out>;
  const continueFromRecorded = (
    why: string,
    o: string | null,
    r: string | null,
  ): { stop: Rederivation } | { discovery: WatchedDiscoveryEvidence; limitation: string } => {
    if (!a.scope.frames) return { stop: mismatch(why, o, r) };
    if (recordedDiscovery === null) {
      return {
        stop: limited(
          `${why}; the watch frames are redacted and no recorded discovery remains to check`,
          o,
          r,
        ),
      };
    }
    const contradiction = frameMetadataContradiction(a.watchResult, recordedDiscovery);
    if (contradiction !== null) return { stop: mismatch(contradiction, o, r) };
    return {
      discovery: recordedDiscovery as unknown as WatchedDiscoveryEvidence,
      limitation: `${why}; the watch frames are redacted, so the recorded discovery (whose numbers agree with the sealed watch metadata) is used for the remaining checks`,
    };
  };
  let discovery: WatchedDiscoveryEvidence;
  let discoveryLimitation: string | null = null;
  if (!verification.ok) {
    const outcome =
      verification.status === "DISCOVERY_TAMPERED"
        ? "DISCOVERY_TAMPERED"
        : "DISCOVERY_EVIDENCE_INVALID";
    if (
      outcome === a.recordedOutcome &&
      a.exchanges.length === 0 &&
      sameModuloRedaction(verification.reason, result.reason, a.scope.recorded)
    ) {
      return verification.reason === result.reason
        ? out(
            "REPRODUCED",
            "Discovery verification re-derives the recorded rejection",
            outcome,
            verification.reason,
          )
        : limited("the recorded rejection reason is redacted", outcome, verification.reason);
    }
    const next = continueFromRecorded(
      "Discovery verification of the sealed frames disagrees with the recorded result",
      outcome,
      verification.reason,
    );
    if ("stop" in next) return next.stop;
    discovery = next.discovery;
    discoveryLimitation = next.limitation;
  } else if (
    a.recordedOutcome === "DISCOVERY_TAMPERED" ||
    a.recordedOutcome === "DISCOVERY_EVIDENCE_INVALID"
  ) {
    return (a.scope.frames ? limited : mismatch)(
      "Sealed frames verify, but the recorded result rejected discovery",
      "DISCOVERY_VERIFIED",
    );
  } else if (
    recordedDiscovery === null ||
    NUMERIC_DISCOVERY_FIELDS.some((k) => verification.discovery[k] !== recordedDiscovery[k])
  ) {
    return mismatch(
      "Re-derived discovery differs from the recorded discovery in fields redaction cannot change",
    );
  } else if (canonical(verification.discovery) !== canonical(recordedDiscovery)) {
    if (
      !a.scope.frames &&
      sameModuloRedaction(verification.discovery, recordedDiscovery, a.scope.recorded)
    ) {
      discovery = verification.discovery;
      discoveryLimitation = "the recorded discovery strings are redacted";
    } else {
      const next = continueFromRecorded(
        "Re-derived discovery strings differ from the recorded discovery",
        null,
        null,
      );
      if ("stop" in next) return next.stop;
      discovery = next.discovery;
      discoveryLimitation = next.limitation;
    }
  } else {
    discovery = verification.discovery;
  }

  // 2. Deadline (numbers and policy context only; redaction cannot change it).
  let deadline: number;
  try {
    deadline = computeWatchValidationDeadline(discovery, context);
  } catch {
    return mismatch("Sealed policy context is invalid");
  }
  if (deadline !== result.validationDeadlineAtMs) {
    return mismatch("Re-derived validation deadline differs from the recorded deadline");
  }

  // 3. Pure candidate derivation on the sealed exchanges.
  const pure = evaluateWatchCandidateEvidence(discovery, a.exchanges, context);
  if (
    pure.outcome === a.recordedOutcome &&
    pure.reason === result.reason &&
    canonical(pure.target) === canonical(result.target)
  ) {
    return discoveryLimitation === null
      ? out(
          "REPRODUCED",
          "Pure derivation re-derives the recorded outcome, reason and target",
          pure.outcome,
          pure.reason,
        )
      : limited(
          `${discoveryLimitation}; the exchanges re-derive the recorded outcome, reason and target`,
          pure.outcome,
          pure.reason,
        );
  }
  if (ACQUISITION_OUTCOMES.has(a.recordedOutcome ?? "") && pure.outcome !== "TARGET_SELECTED") {
    return out(
      "NOT_ELIGIBLE",
      "The recorded outcome comes from acquisition (an interruption or an undispatched request) that the exchange records alone do not show; it is preserved",
      pure.outcome,
      pure.reason,
    );
  }
  const cause = redactionCauseOf(pure, a.exchanges, discovery, a.scope);
  if (cause === null) {
    if (
      a.scope.recorded &&
      pure.outcome === a.recordedOutcome &&
      sameModuloRedaction(
        { reason: pure.reason, target: pure.target },
        { reason: result.reason, target: result.target },
        true,
      )
    ) {
      return limited(
        "the recorded reason or target strings are redacted; everything else re-derives",
        pure.outcome,
        pure.reason,
      );
    }
    return mismatch(
      "Pure derivation disagrees with the recorded result, and it consumed no redacted evidence that could explain the difference",
      pure.outcome,
      pure.reason,
    );
  }
  const contradiction = recordedContradiction(
    cause,
    result,
    a.recordedOutcome,
    discovery,
    a.exchanges,
    a.scope,
    context,
  );
  if (contradiction !== null) return mismatch(contradiction, pure.outcome, pure.reason);
  const what =
    cause === "TRANSACTION_BODY"
      ? "the redacted transaction body stops the derivation"
      : cause === "MARKET_BODY"
        ? "the redacted market body stops the derivation; the transaction-derived target parts re-derive"
        : `redacted exchange fields that the derivation reads (${[...a.scope.exchangeLiteral]
            .map(([seq, fields]) => `exchange ${seq}: ${fields.join(", ")}`)
            .join("; ")}) feed the request checks; the independently derivable parts agree`;
  return limited(
    discoveryLimitation === null ? what : `${discoveryLimitation}; ${what}`,
    pure.outcome,
    pure.reason,
  );
}
