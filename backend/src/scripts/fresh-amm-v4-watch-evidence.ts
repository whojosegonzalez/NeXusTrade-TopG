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
 *
 * Verification is fail-closed and keeps three answers apart:
 * - integrity: manifest schema/version, required entries, unique confined paths, regular files
 *   (no links), sizes, hashes, no unlisted files at any depth, plan/report references and
 *   exchange-index/ledger agreement, all checked before any response file is consumed;
 * - completeness: whether the sealed evidence could support a selected target at all;
 * - re-derivation: for a recorded validation, the reviewed discovery verification and pure
 *   candidate derivation re-run on the sealed evidence and policy context and are compared with
 *   the recorded result. Interrupted or cancelled runs keep their recorded outcome; redaction that
 *   prevents exact re-derivation is reported as LIMITED_BY_REDACTION.
 */

import path from "node:path";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { buildEscapedSecretRegex } from "../candidate-scanner/SolanaTrackerBundlerCaptureTool.js";
import { serializeJsonPreservingBigInts } from "../research/pilot/RaydiumAmmV4SnapshotAcquisition.js";
import {
  PRECHECK_ROOT_SEGMENTS,
  RPC_URL_PLACEHOLDER,
  precheckExchangePath,
  type EvidenceFileWriter,
  type PrecheckExchange,
} from "./fresh-amm-v4-precheck.js";
import {
  DEFAULT_WATCH_VALIDATION_LIMITS,
  PROVISIONAL_TARGET_DISCLAIMER,
  REVIEWED_WATCH_POLICY,
  computeWatchValidationDeadline,
  evaluateWatchCandidateEvidence,
  resolveWatchValidationLimits,
  validateWatchedDiscoveryEvidence,
  type WatchCandidateOutcome,
  type WatchCandidateValidationResult,
  type WatchEvidenceContext,
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
    // A bounded prefix can end inside a credential: redact a trailing leading fragment.
    if (partial) {
      for (const f of forms) {
        for (let k = Math.min(f.latin1.length - 1, text.length); k >= MIN_TRAILING_FRAGMENT; k--) {
          if (text.endsWith(f.latin1.slice(0, k))) {
            text = text.slice(0, text.length - k) + REDACTED_PARTIAL;
            break;
          }
        }
      }
    }
    for (const f of forms) {
      if (text.includes(f.latin1)) throw new Error("[SEAL_REFUSED] credential bytes remain");
      if (f.escaped) {
        f.escaped.lastIndex = 0;
        if (f.escaped.test(text)) throw new Error("[SEAL_REFUSED] escaped credential remains");
        f.escaped.lastIndex = 0;
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
): { record: Record<string, unknown>; ledger: Record<string, unknown>; redacted: boolean } {
  const r = ex.response as Record<string, unknown>;
  if (r.bodyRedacted !== false) {
    throw new Error(`[SEAL_INPUT_INVALID] exchange ${ex.seq} is not an unredacted raw record`);
  }
  const original = decodeStoredBody(r.body, r.bodyEncoding);
  if (original === "INVALID") {
    throw new Error(`[SEAL_INPUT_INVALID] exchange ${ex.seq} body does not decode`);
  }
  const bodyState = r.bodyState;
  if (bodyState !== "COMPLETE" && bodyState !== "PARTIAL_OVERFLOW" && bodyState !== "NOT_READ") {
    throw new Error(`[SEAL_INPUT_INVALID] exchange ${ex.seq} body state is unknown`);
  }
  if (original === null) {
    if (r.receivedBytesSha256 !== null || bodyState !== "NOT_READ") {
      throw new Error(`[SEAL_INPUT_INVALID] exchange ${ex.seq} body accounting is inconsistent`);
    }
  } else if (
    bodyState === "NOT_READ" ||
    r.receivedBytesSha256 !== sha256(original) ||
    r.retainedBytes !== original.length ||
    (typeof r.maxResponseBytes === "number" && original.length > r.maxResponseBytes)
  ) {
    throw new Error(`[SEAL_INPUT_INVALID] exchange ${ex.seq} body does not match its digest`);
  }
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
            ? "ORIGINAL_COMPLETE_BODY_BYTES"
            : "ORIGINAL_RETAINED_PREFIX_BYTES_ONLY",
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
      const sealed = sealedExchangeRecord(ex, sanitize);
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
  if (problems.length > 0) return integrityFailure();

  // 7. Response files: kind, ledger agreement, digests (consumed only now).
  const exchanges: PrecheckExchange[] = [];
  const redactedBodies: number[] = [];
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
      if (
        resp.sanitizedBytesSha256 !== null ||
        resp.receivedBytesSha256 !== null ||
        resp.bodyRedacted !== false
      ) {
        problems.push(`EXCHANGE_BODY_ACCOUNTING_INVALID:${ix.seq}`);
      }
    } else {
      if (sha256(stored) !== resp.sanitizedBytesSha256 || stored.length !== resp.storedBytes) {
        problems.push(`EXCHANGE_BODY_DIGEST_MISMATCH:${ix.seq}`);
      }
      if (typeof resp.receivedBytesSha256 !== "string" || !HEX64.test(resp.receivedBytesSha256)) {
        problems.push(`EXCHANGE_BODY_ACCOUNTING_INVALID:${ix.seq}`);
      } else if (resp.bodyRedacted === false) {
        if (
          resp.receivedBytesSha256 !== resp.sanitizedBytesSha256 ||
          resp.reproducesReceivedDigest !== true ||
          resp.retainedBytes !== stored.length
        ) {
          problems.push(`EXCHANGE_BODY_ACCOUNTING_INVALID:${ix.seq}`);
        }
      } else if (resp.bodyRedacted === true) {
        if (resp.reproducesReceivedDigest !== false)
          problems.push(`EXCHANGE_BODY_ACCOUNTING_INVALID:${ix.seq}`);
        redactedBodies.push(ix.seq);
      } else problems.push(`EXCHANGE_BODY_ACCOUNTING_INVALID:${ix.seq}`);
    }
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
  if (problems.length > 0) return integrityFailure();

  // Completeness: could this sealed evidence support a selected target at all?
  const literalByFile = pick(redactionClaim, "literalByFile");
  const literalDerivation = isRecord(literalByFile)
    ? Object.entries(literalByFile).filter(
        ([p, n]) =>
          typeof n === "number" && n > 0 && (DERIVATION_FILES.includes(p) || RESPONSE_PATH.test(p)),
      )
    : [];
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
  for (const [p] of literalDerivation) reasons.push(`LITERAL_REDACTION:${p}`);
  if (recordedOutcome !== "TARGET_SELECTED") reasons.push(`OUTCOME:${recordedOutcome ?? "NONE"}`);
  const completeness = { sufficientForSelection: reasons.length === 0, reasons };

  // Re-derivation with the reviewed functions on the sealed evidence and policy context.
  const redactionApplied =
    redactedBodies.length > 0 || (redactedFrames?.length ?? 0) > 0 || literalDerivation.length > 0;
  const rederivation = rederive({
    recorded: recorded === true,
    result: isRecord(result) ? result : null,
    recordedOutcome,
    code,
    watchResult,
    contextDoc,
    exchanges,
    redactionApplied,
  });
  const verified = rederivation.status !== "MISMATCH";
  return {
    outDir,
    integrity: { ok: true, problems: [] },
    completeness,
    rederivation,
    terminalCause,
    runOutcome,
    recordedOutcome,
    verified,
    selectionConfirmed:
      verified && completeness.sufficientForSelection && rederivation.status === "REPRODUCED",
  };
}

function rederive(a: {
  recorded: boolean;
  result: Record<string, unknown> | null;
  recordedOutcome: WatchCandidateOutcome | null;
  code: WatchRunTerminalCode | null;
  watchResult: unknown;
  contextDoc: unknown;
  exchanges: readonly PrecheckExchange[];
  redactionApplied: boolean;
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
  const differs = (detail: string, o: string | null = null, r: string | null = null) =>
    a.redactionApplied
      ? out("LIMITED_BY_REDACTION", `Redaction prevents exact re-derivation: ${detail}`, o, r)
      : out("MISMATCH", detail, o, r);

  const supplied = pick(a.contextDoc, "suppliedContext");
  const deadlineAt = pick(supplied, "overallDeadlineAtMs");
  const limits = pick(supplied, "limits");
  const context: WatchEvidenceContext = {
    ...(typeof deadlineAt === "number" ? { overallDeadlineAtMs: deadlineAt } : {}),
    ...(isRecord(limits) ? { limits: limits as WatchEvidenceContext["limits"] } : {}),
  };
  const result = a.result;
  const completedAtMs = typeof result.completedAtMs === "number" ? result.completedAtMs : undefined;
  const verification = validateWatchedDiscoveryEvidence(
    a.watchResult as BoundedAmmV4CreationWatchResult,
    {
      nowMs: completedAtMs,
    },
  );
  if (!verification.ok) {
    const outcome =
      verification.status === "DISCOVERY_TAMPERED"
        ? "DISCOVERY_TAMPERED"
        : "DISCOVERY_EVIDENCE_INVALID";
    return outcome === a.recordedOutcome &&
      verification.reason === result.reason &&
      a.exchanges.length === 0
      ? out(
          "REPRODUCED",
          "Discovery verification re-derives the recorded rejection",
          outcome,
          verification.reason,
        )
      : differs(
          "Discovery verification of the sealed frames disagrees with the recorded result",
          outcome,
          verification.reason,
        );
  }
  if (
    a.recordedOutcome === "DISCOVERY_TAMPERED" ||
    a.recordedOutcome === "DISCOVERY_EVIDENCE_INVALID"
  ) {
    return differs(
      "Sealed frames verify, but the recorded result rejected discovery",
      "DISCOVERY_VERIFIED",
    );
  }
  if (canonical(verification.discovery) !== canonical(result.discovery)) {
    return differs("Re-derived discovery differs from the recorded discovery");
  }
  let deadline: number;
  try {
    deadline = computeWatchValidationDeadline(verification.discovery, context);
  } catch {
    return differs("Sealed policy context is invalid");
  }
  if (deadline !== result.validationDeadlineAtMs) {
    return differs("Re-derived validation deadline differs from the recorded deadline");
  }
  const pure = evaluateWatchCandidateEvidence(verification.discovery, a.exchanges, context);
  if (
    pure.outcome === a.recordedOutcome &&
    pure.reason === result.reason &&
    canonical(pure.target) === canonical(result.target)
  ) {
    return out(
      "REPRODUCED",
      "Pure derivation re-derives the recorded outcome, reason and target",
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
  return differs("Pure derivation disagrees with the recorded result", pure.outcome, pure.reason);
}
