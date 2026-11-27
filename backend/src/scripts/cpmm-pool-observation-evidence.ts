/**
 * CPMM pool observation evidence: offline sealing and integrity verification (assessment §8.38.17
 * item 17 D–G and S). An optional acquisition dependency is verified offline, separately
 * from observation integrity and re-derivation.
 *
 * - **Sealing** (`sealCpmmObservationEvidence`) consumes the accepted recorder's frozen snapshot
 *   and explicitly supplied plan, component versions, pool context and credentials. Inputs are
 *   read through own data properties only (no getter, no proxy trap) and copied; caller objects
 *   are never mutated or frozen. Payload bytes are sanitized with the accepted credential
 *   sanitizer before any text or base64 encoding; original and stored digests stay distinct.
 *   Every file is rendered and scanned for credential residue before the output directory
 *   exists. Then a new directory is created exclusively, every file is written exclusively, and
 *   the manifest is written last. Nothing is retried or re-acquired.
 * - **Verification** (`verifyCpmmObservationEvidence`) is read-only and fail-closed. Integrity
 *   and retention are reported separately; retention is derived from the sealed evidence, never
 *   from recorded completeness flags. An integrity failure stops all further processing.
 *
 * Importing this module is inert: it reads no environment, configuration, clock or network, has
 * no CLI, and starts nothing. File-system access happens only inside the two exported functions.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { types as utilTypes } from "node:util";

import {
  CPMM_EXCHANGE_ENDPOINT_LABEL,
  type CpmmObservationSnapshot,
} from "../candidate-scanner/CpmmPoolObservationRecorder.js";
import {
  CPMM_FRAME_DISPOSITIONS,
  CpmmPoolNotificationCollector,
} from "../candidate-scanner/CpmmPoolNotificationCollector.js";
import { adaptRaydiumCpmmPoolState } from "../candidate-scanner/RaydiumCpmmPoolStateAdapter.js";
import {
  CPMM_INVALID_CODES,
  type CpmmAccountResult,
  type CpmmAccountingDisposition,
  type CpmmBlockingClass,
  type CpmmDuplicateOccurrence,
  type CpmmEpochAccounting,
  type CpmmIngestionAccounting,
  type CpmmLedgerCounters,
  type CpmmLedgerLimits,
  type CpmmPolicyPending,
  type CpmmSignatureAccountingRecord,
} from "../candidate-scanner/CpmmResolutionAccountingLedger.js";
import { isValidSolanaSignature } from "../candidate-scanner/ExactPoolHistoryEnumerator.js";
import {
  CPMM_MIN_SECRET_CHARS,
  CPMM_TX_PURPOSE,
  analyzeCpmmTransactionResponse,
  cpmmGetTransactionRequestBody,
  type CpmmMaxSupportedTransactionVersion,
} from "../candidate-scanner/RaydiumCpmmTransactionSourceAdapter.js";
import {
  verifyCpmmPoolAcquisitionForBinding,
  type CpmmPoolAcquisitionVerification,
} from "./cpmm-pool-acquisition-evidence.js";
import {
  EVIDENCE_SANITIZER_LIMITS,
  deriveEvidenceSecrets,
  sanitizeEvidenceBytes,
  type EvidenceSanitizeScope,
} from "./evidence-credential-sanitizer.js";

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

export const CPMM_EVIDENCE_MANIFEST_KIND = "CPMM_POOL_OBSERVATION_EVIDENCE_MANIFEST" as const;
export const CPMM_EVIDENCE_MANIFEST_VERSION = 1 as const;
export const CPMM_EVIDENCE_SCHEMA_VERSION = 1 as const;
const BOUND_SCHEMA_VERSION = 2 as const;
/** Acquisition-bound evidence whose requests carried `maxSupportedTransactionVersion: 1`. */
export const CPMM_V1_CAPABLE_EVIDENCE_SCHEMA_VERSION = 3 as const;
type EvidenceSchemaVersion =
  | typeof CPMM_EVIDENCE_SCHEMA_VERSION
  | typeof BOUND_SCHEMA_VERSION
  | typeof CPMM_V1_CAPABLE_EVIDENCE_SCHEMA_VERSION;

/**
 * What each evidence schema binds, explicitly (no schema is inferred from another or from a
 * response): whether the observation is bound to a sealed acquisition dependency, and the
 * `getTransaction` request policy every sealed request must have carried exactly.
 *  - 1: unbound, cap 0 (historical); 2: acquisition-bound, cap 0 (historical, e.g.
 *    cpmm-observation-03); 3: acquisition-bound, cap 1 (v1-capable; new runs).
 * Any other schema is unsupported. Schema 3 has no unbound variant.
 */
export interface CpmmEvidenceSchemaPolicy {
  readonly acquisitionBound: boolean;
  readonly maxSupportedTransactionVersion: CpmmMaxSupportedTransactionVersion;
}
export const CPMM_EVIDENCE_SCHEMA_POLICIES: Readonly<
  Record<EvidenceSchemaVersion, CpmmEvidenceSchemaPolicy>
> = Object.freeze({
  [CPMM_EVIDENCE_SCHEMA_VERSION]: Object.freeze({
    acquisitionBound: false,
    maxSupportedTransactionVersion: 0,
  }),
  [BOUND_SCHEMA_VERSION]: Object.freeze({
    acquisitionBound: true,
    maxSupportedTransactionVersion: 0,
  }),
  [CPMM_V1_CAPABLE_EVIDENCE_SCHEMA_VERSION]: Object.freeze({
    acquisitionBound: true,
    maxSupportedTransactionVersion: 1,
  }),
});
/** The policy of a known schema; null for anything else (no prototype lookup, no coercion). */
function schemaPolicy(v: unknown): CpmmEvidenceSchemaPolicy | null {
  switch (v) {
    case CPMM_EVIDENCE_SCHEMA_VERSION:
    case BOUND_SCHEMA_VERSION:
    case CPMM_V1_CAPABLE_EVIDENCE_SCHEMA_VERSION:
      return CPMM_EVIDENCE_SCHEMA_POLICIES[v];
    default:
      return null;
  }
}
/**
 * The request-policy record a v1-capable plan and report carry (schema 3 only; schemas 1 and 2
 * never carry it, which keeps their sealed bytes and checks unchanged).
 */
export const CPMM_V1_CAPABLE_TRANSACTION_REQUEST = Object.freeze({
  maxSupportedTransactionVersion: 1,
} as const);
const ACQUIRED_BOUND = "ACQUIRED_BOUND" as const;
const BINDING_POSITIONS = [
  ["pool", "POOL"],
  ["vault0", "VAULT0"],
  ["vault1", "VAULT1"],
] as const;
/** Under the caller's project root: `data/research/cpmm-observations/<runId>/`. */
export const CPMM_EVIDENCE_ROOT_SEGMENTS: readonly string[] = Object.freeze([
  "data",
  "research",
  "cpmm-observations",
]);

export const CPMM_EVIDENCE_FILES = Object.freeze({
  plan: "run-plan.json",
  poolContext: "pool-context.json",
  ownerReport: "owner-report.json",
  transportDiagnostics: "transport-diagnostics.json",
  transportRecords: "transport-records.json",
  collector: "collector.json",
  ledger: "ledger.json",
  sessionLedger: "session-ledger.json",
  exchangeIndex: "exchanges/index.json",
  recording: "recording.json",
  report: "report.json",
  manifest: "cpmm-observation-manifest.json",
} as const);

/** Every file the manifest must list (it never lists itself). */
export const CPMM_EVIDENCE_REQUIRED_FILES: readonly string[] = Object.freeze(
  Object.values(CPMM_EVIDENCE_FILES).filter((f) => f !== CPMM_EVIDENCE_FILES.manifest),
);

const FILE_KINDS: Readonly<Record<string, string>> = Object.freeze({
  [CPMM_EVIDENCE_FILES.plan]: "CPMM_OBSERVATION_RUN_PLAN",
  [CPMM_EVIDENCE_FILES.poolContext]: "CPMM_OBSERVATION_POOL_CONTEXT",
  [CPMM_EVIDENCE_FILES.ownerReport]: "CPMM_OBSERVATION_OWNER_REPORT",
  [CPMM_EVIDENCE_FILES.transportDiagnostics]: "CPMM_OBSERVATION_TRANSPORT_DIAGNOSTICS",
  [CPMM_EVIDENCE_FILES.transportRecords]: "CPMM_OBSERVATION_TRANSPORT_RECORDS",
  [CPMM_EVIDENCE_FILES.collector]: "CPMM_OBSERVATION_COLLECTOR",
  [CPMM_EVIDENCE_FILES.ledger]: "CPMM_OBSERVATION_LEDGER",
  [CPMM_EVIDENCE_FILES.sessionLedger]: "CPMM_OBSERVATION_SESSION_LEDGER",
  [CPMM_EVIDENCE_FILES.exchangeIndex]: "CPMM_OBSERVATION_EXCHANGE_INDEX",
  [CPMM_EVIDENCE_FILES.recording]: "CPMM_OBSERVATION_RECORDING",
  [CPMM_EVIDENCE_FILES.report]: "CPMM_OBSERVATION_REPORT",
});
const EXCHANGE_FILE_KIND = "CPMM_OBSERVATION_EXCHANGE";

/** Accepted component versions (commit identifiers supplied by the caller). */
export const CPMM_COMPONENT_VERSION_KEYS: readonly string[] = Object.freeze([
  "owner",
  "wrapper",
  "collector",
  "ledger",
  "adapter",
  "decoder",
  "session",
  "recorder",
  "sanitizer",
]);
const PLAN_LIMIT_KEYS = [
  "owner",
  "wrapper",
  "collector",
  "ledger",
  "adapter",
  "sessionLanes",
  "recorder",
] as const;

/** The five item F flags: always false in every outcome. */
export const CPMM_EVIDENCE_FALSE_FLAGS = Object.freeze({
  notificationCompletenessEstablished: false,
  quietWindowEstablished: false,
  qualificationEligible: false,
  replayableCaptureEstablished: false,
  admissionEligible: false,
} as const);

/** Fixed bounds established before any untrusted metadata is read or allocated from. */
export const CPMM_EVIDENCE_VERIFIER_LIMITS = Object.freeze({
  maxManifestBytes: 1024 * 1024,
  /** A sealed file is never larger than one sanitizer payload (its residue scan is whole-file). */
  maxFileBytes: EVIDENCE_SANITIZER_LIMITS.maxPayloadBytes,
  maxTotalBytes: 256 * 1024 * 1024,
  /** Listed files (the manifest excluded), and directory entries walked. */
  maxEntries: 4096,
  maxWalkDepth: 2,
  /**
   * Nesting depth of any parsed document, checked iteratively before anything recursive (copies,
   * comparisons, freezing) touches it. Sealed inputs are at most 64 deep, plus the file's wrapping.
   */
  maxDocumentDepth: 80,
});

const SEAL_LIMITS = Object.freeze({
  maxInputNodes: 4_000_000,
  maxInputDepth: 64,
  maxStringChars: 1024 * 1024,
  maxExchanges: CPMM_EVIDENCE_VERIFIER_LIMITS.maxEntries - CPMM_EVIDENCE_REQUIRED_FILES.length,
  maxAccountDataBytes: EVIDENCE_SANITIZER_LIMITS.maxPayloadBytes,
});

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const LABEL = /^[A-Z][A-Z0-9_]{0,63}$/;
const FIXED_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const EXCHANGE_FILE = /^exchanges\/(\d{6})\.json$/;
const ERRNO = /^E[A-Z0-9]{1,30}$/;

const OMISSIONS: ReadonlySet<string> = new Set([
  "BYTE_ALLOWANCE",
  "OVERSIZE_NOT_HASHED",
  "NOT_BYTES",
]);
const WITHHELD_REASONS: ReadonlySet<string> = new Set([
  "CREDENTIAL_MATERIAL_DETECTED",
  "CREDENTIAL_SCAN_INCONCLUSIVE",
  "SCAN_BUDGET_EXHAUSTED",
  "OUTPUT_LIMIT_EXCEEDED",
]);
const JSON_INSPECTIONS: ReadonlySet<string> = new Set([
  "INSPECTED",
  "NOT_REQUESTED",
  "NOT_APPLICABLE_PARTIAL",
  "NOT_UTF8",
  "NOT_JSON",
  "SKIPPED_RAW_DETECTED",
]);
const TRANSPORT_CATEGORIES = ["incoming", "outgoing", "control", "lifecycle"] as const;

const exchangePath = (seq: number): string => `exchanges/${String(seq).padStart(6, "0")}.json`;
const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------------------------------------
// Safe input reading (own data properties only; no getter, proxy trap or coercion)
// ---------------------------------------------------------------------------------------------

const isProxy = utilTypes.isProxy;
const isUint8Array = utilTypes.isUint8Array;
const getOwnDesc = Object.getOwnPropertyDescriptor;
const getProto = Object.getPrototypeOf;
const reflectOwnKeys = Reflect.ownKeys;
const reflectApply = Reflect.apply;
const typedArrayProto = getProto(Uint8Array.prototype) as object;
function typedArrayGetter(name: string): (this: unknown) => unknown {
  const d = getOwnDesc(typedArrayProto, name);
  if (!d || typeof d.get !== "function") throw new Error("[CPMM_EVIDENCE_INIT] intrinsics");
  return d.get as (this: unknown) => unknown;
}
const taByteLength = typedArrayGetter("byteLength");
const taByteOffset = typedArrayGetter("byteOffset");
const taBuffer = typedArrayGetter("buffer");

type SealStatus =
  | "SEAL_INPUT_INVALID"
  | "SEAL_REFUSED"
  | "OUTPUT_DIRECTORY_UNAVAILABLE"
  | "ARTIFACT_WRITE_FAILED";

/** A fixed-code sealing failure (never carries caller text or a raw exception). */
class SealFailure {
  constructor(
    public readonly status: SealStatus,
    public readonly code: string,
  ) {}
}
function invalid(code: string): never {
  throw new SealFailure("SEAL_INPUT_INVALID", code);
}
function refused(code: string): never {
  throw new SealFailure("SEAL_REFUSED", code);
}

function plainRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "object" || v === null || isProxy(v) || Array.isArray(v)) return null;
  const proto = getProto(v) as unknown;
  return proto === Object.prototype || proto === null ? (v as Record<string, unknown>) : null;
}

/** An own data property of a plain record; an accessor or proxy is invalid input. */
function own(o: Record<string, unknown>, key: string, code: string): unknown {
  const d = getOwnDesc(o, key);
  if (d === undefined) return undefined;
  if (!("value" in d)) invalid(`${code}_ACCESSOR`);
  return d.value;
}

function exactRecord(
  v: unknown,
  keys: readonly string[],
  code: string,
  optional: readonly string[] = [],
) {
  const o = plainRecord(v);
  if (o === null) invalid(`${code}_NOT_PLAIN_OBJECT`);
  const present = reflectOwnKeys(o);
  for (const k of present) {
    if (typeof k !== "string" || (!keys.includes(k) && !optional.includes(k))) {
      invalid(`${code}_UNEXPECTED_KEY`);
    }
  }
  for (const k of keys) if (!present.includes(k)) invalid(`${code}_MISSING_KEY`);
  const out: Record<string, unknown> = {};
  for (const k of [...keys, ...optional]) out[k] = own(o, k, code);
  return out;
}

/**
 * Plain JSON data only, copied: primitives, arrays and plain objects through own data
 * properties. Bigints become `{ "$bigint": "<decimal>" }` and non-finite numbers
 * `{ "$number": "NaN" | "Infinity" | "-Infinity" }`; object properties holding `undefined` are
 * omitted. Keys beginning with `$` are refused (reserved for those tags).
 */
function copyPlain(v: unknown, budget: { nodes: number }, depth: number): unknown {
  if (--budget.nodes < 0) invalid("INPUT_TOO_LARGE");
  if (depth > SEAL_LIMITS.maxInputDepth) invalid("INPUT_TOO_DEEP");
  switch (typeof v) {
    case "string":
      if (v.length > SEAL_LIMITS.maxStringChars) invalid("INPUT_STRING_TOO_LONG");
      return v;
    case "boolean":
      return v;
    case "number":
      return Number.isFinite(v) ? (Object.is(v, -0) ? 0 : v) : { $number: String(v) };
    case "bigint":
      return { $bigint: v.toString() };
    case "object": {
      if (v === null) return null;
      if (isProxy(v)) invalid("INPUT_PROXY");
      if (Array.isArray(v)) {
        const len = getOwnDesc(v, "length")!.value as number;
        const out: unknown[] = [];
        for (let i = 0; i < len; i++) {
          const d = getOwnDesc(v, String(i));
          if (d === undefined || !("value" in d)) invalid("INPUT_ARRAY_ELEMENT_INVALID");
          if (d.value === undefined) invalid("INPUT_ARRAY_ELEMENT_INVALID");
          out.push(copyPlain(d.value, budget, depth + 1));
        }
        return out;
      }
      const o = plainRecord(v);
      if (o === null) invalid("INPUT_NOT_PLAIN_DATA");
      const out: Record<string, unknown> = {};
      for (const k of reflectOwnKeys(o)) {
        if (typeof k !== "string") invalid("INPUT_SYMBOL_KEY");
        if (k.startsWith("$")) invalid("INPUT_RESERVED_KEY");
        const d = getOwnDesc(o, k)!;
        if (!("value" in d)) invalid("INPUT_ACCESSOR");
        if (!d.enumerable || d.value === undefined) continue;
        Object.defineProperty(out, k, {
          value: copyPlain(d.value, budget, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    default:
      return invalid("INPUT_UNSUPPORTED_VALUE");
  }
}

function copyBytes(v: unknown, maxBytes: number, code: string): Buffer {
  if (typeof v !== "object" || v === null || isProxy(v) || !isUint8Array(v)) invalid(code);
  const length = reflectApply(taByteLength, v, []) as number;
  if (length > maxBytes) invalid(`${code}_TOO_LARGE`);
  const buffer = reflectApply(taBuffer, v, []) as ArrayBufferLike;
  const offset = reflectApply(taByteOffset, v, []) as number;
  return Buffer.from(new Uint8Array(buffer, offset, length));
}

/** Strict, canonical base64 only. */
function strictBase64(s: unknown): Buffer | null {
  if (typeof s !== "string" || s.length % 4 !== 0 || !BASE64.test(s)) return null;
  const b = Buffer.from(s, "base64");
  return b.toString("base64") === s ? b : null;
}

const isValidUtf8 = (b: Buffer): boolean => {
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
    return true;
  } catch {
    return false;
  }
};
const isWellFormedText = (s: string): boolean => Buffer.from(s, "utf8").toString("utf8") === s;

// ---------------------------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------------------------

export interface CpmmPoolAccountInput {
  readonly address: string;
  readonly ownerProgramId: string;
  readonly slot: number;
  readonly data: Uint8Array;
}

export interface CpmmPoolContextInput {
  readonly target: { readonly poolAddress: string; readonly candidateMint: string };
  readonly poolAccount: CpmmPoolAccountInput;
  readonly vault0Account: CpmmPoolAccountInput;
  readonly vault1Account: CpmmPoolAccountInput;
  /** The adapted pool the run used (plain data; bigints are tagged on copy). */
  readonly adaptedPool: unknown;
  /** Legacy input marker. Binding, if requested, is computed rather than supplied here. */
  readonly acquisition: "SUPPLIED_UNVERIFIED";
}

export interface CpmmObservationPlanInput {
  /** Component kinds and versions as plain labels. */
  readonly kinds: Readonly<Record<string, string>>;
  readonly limits: {
    readonly owner: unknown;
    readonly wrapper: unknown;
    readonly collector: unknown;
    readonly ledger: unknown;
    readonly adapter: unknown;
    readonly sessionLanes: unknown;
    /** Must equal the snapshot's recorder limits. */
    readonly recorder: unknown;
  };
  readonly binding: unknown;
  readonly epoch: number;
  readonly subscribeRequestId: number;
  readonly unsubscribeRequestId: number;
  /** Fixed labels only (never an endpoint URL). */
  readonly endpointLabels: Readonly<Record<string, string>>;
}

export interface SealCpmmObservationInput {
  /** Absolute; the run directory is `<projectRoot>/data/research/cpmm-observations/<runId>`. */
  readonly projectRoot: string;
  readonly runId: string;
  /** The accepted recorder's frozen snapshot (`finish()`). */
  readonly snapshot: CpmmObservationSnapshot;
  readonly plan: CpmmObservationPlanInput;
  readonly componentVersions: Readonly<Record<string, string>>;
  readonly poolContext: CpmmPoolContextInput;
  /** Optional absolute path to a sealed acquisition bundle. Only its manifest digest is persisted. */
  readonly acquisitionDir?: string;
  /** Endpoint URLs and extra secrets for redaction; never persisted. */
  readonly credentials: {
    readonly urls: readonly string[];
    readonly additional: readonly string[];
  };
  /** The recorder's `lateActivity()` read at sealing time, or null. */
  readonly lateActivity: Readonly<Record<string, number>> | null;
  /** Tests only: replaces the exclusive file write (same arguments as `writeFileSync`). */
  readonly writeEvidenceFile?: (
    absolutePath: string,
    content: string,
    options: { readonly encoding: "utf8"; readonly flag: "wx" },
  ) => void;
}

export interface CpmmEvidenceManifestEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface CpmmEvidencePayloadSummary {
  readonly stored: number;
  readonly redacted: number;
  readonly withheld: number;
  readonly omitted: number;
}

export type SealCpmmObservationResult =
  | {
      readonly ok: true;
      readonly status: "SEALED";
      readonly outDir: string;
      readonly manifestSha256: string;
      readonly files: readonly CpmmEvidenceManifestEntry[];
      readonly payloads: CpmmEvidencePayloadSummary;
      readonly rederivation: "NOT_IMPLEMENTED";
    }
  | {
      readonly ok: false;
      readonly status: SealStatus;
      /** A fixed code; never caller text or a raw exception. */
      readonly code: string;
      readonly outDir: string | null;
      readonly failedFile: string | null;
      /** Relative paths of files created before the failure (no manifest among them). */
      readonly filesWritten: readonly string[];
      readonly directoriesCreated: readonly string[];
    };

/** The sealed form of one payload: exactly one of stored, withheld or omitted. */
interface SealedPayload {
  originalBytes: number | null;
  originalSha256: string | null;
  storedEncoding: "utf8" | "base64" | null;
  stored: string | null;
  storedBytes: number | null;
  storedSha256: string | null;
  payloadRedacted: boolean;
  redactions: number;
  partialFragmentRedacted: boolean;
  jsonInspection: string | null;
  payloadOmitted: string | null;
  withheldReason: string | null;
}

const SEALED_PAYLOAD_KEYS = [
  "originalBytes",
  "originalSha256",
  "storedEncoding",
  "stored",
  "storedBytes",
  "storedSha256",
  "payloadRedacted",
  "redactions",
  "partialFragmentRedacted",
  "jsonInspection",
  "payloadOmitted",
  "withheldReason",
];

interface PayloadSealer {
  seal(snapshotPayload: unknown, scope: EvidenceSanitizeScope): SealedPayload | null;
  sealBytes(bytes: Buffer, scope: EvidenceSanitizeScope): SealedPayload;
  readonly summary: { stored: number; redacted: number; withheld: number; omitted: number };
}

function sanitizeOrRefuse(
  bytes: Buffer,
  secrets: readonly string[],
  scope: EvidenceSanitizeScope,
): ReturnType<typeof sanitizeEvidenceBytes> {
  try {
    return sanitizeEvidenceBytes(bytes, secrets, scope);
  } catch (e) {
    const m = e instanceof Error ? e.message : "";
    const code = /^\[SEAL_REFUSED\] ([A-Z_]{1,64})$/.exec(m);
    if (code) refused(code[1]!);
    return invalid("SANITIZER_INPUT_REFUSED");
  }
}

function payloadSealer(secrets: readonly string[]): PayloadSealer {
  const summary = { stored: 0, redacted: 0, withheld: 0, omitted: 0 };
  const sealBytes = (bytes: Buffer, scope: EvidenceSanitizeScope): SealedPayload => {
    const r = sanitizeOrRefuse(bytes, secrets, scope);
    if (r.status === "WITHHELD") {
      summary.withheld++;
      return {
        originalBytes: r.originalBytes,
        originalSha256: r.originalSha256,
        storedEncoding: null,
        stored: null,
        storedBytes: null,
        storedSha256: null,
        payloadRedacted: false,
        redactions: 0,
        partialFragmentRedacted: false,
        jsonInspection: r.jsonInspection,
        payloadOmitted: null,
        withheldReason: r.reason,
      };
    }
    summary.stored++;
    if (r.redacted) summary.redacted++;
    return {
      originalBytes: r.originalBytes,
      originalSha256: r.originalSha256,
      storedEncoding: r.encoding,
      stored: r.stored,
      storedBytes: r.storedBytes,
      storedSha256: r.storedSha256,
      payloadRedacted: r.redacted,
      redactions: r.redactions,
      partialFragmentRedacted: r.partialFragmentRedacted,
      jsonInspection: r.jsonInspection,
      payloadOmitted: null,
      withheldReason: null,
    };
  };
  /** A recorder payload `{ byteLength, sha256, base64, omitted }` (already a copy). */
  const seal = (p: unknown, scope: EvidenceSanitizeScope): SealedPayload | null => {
    if (p === null || p === undefined) return null;
    const o = exactRecord(p, ["byteLength", "sha256", "base64", "omitted"], "SNAPSHOT_PAYLOAD");
    const byteLength = o.byteLength;
    const digest = o.sha256;
    if (byteLength !== null && !(Number.isSafeInteger(byteLength) && (byteLength as number) >= 0)) {
      invalid("SNAPSHOT_PAYLOAD_INCONSISTENT");
    }
    if (digest !== null && !(typeof digest === "string" && HEX64.test(digest))) {
      invalid("SNAPSHOT_PAYLOAD_INCONSISTENT");
    }
    if (o.omitted !== null) {
      if (typeof o.omitted !== "string" || !OMISSIONS.has(o.omitted) || o.base64 !== null) {
        invalid("SNAPSHOT_PAYLOAD_INCONSISTENT");
      }
      summary.omitted++;
      return {
        originalBytes: byteLength as number | null,
        originalSha256: digest as string | null,
        storedEncoding: null,
        stored: null,
        storedBytes: null,
        storedSha256: null,
        payloadRedacted: false,
        redactions: 0,
        partialFragmentRedacted: false,
        jsonInspection: null,
        payloadOmitted: o.omitted,
        withheldReason: null,
      };
    }
    const bytes = strictBase64(o.base64);
    if (bytes === null || bytes.length !== byteLength || sha256(bytes) !== digest) {
      invalid("SNAPSHOT_PAYLOAD_INCONSISTENT");
    }
    return sealBytes(bytes, scope);
  };
  return { seal, sealBytes, summary };
}

const TEXT_SCOPE: EvidenceSanitizeScope = Object.freeze({ partial: false, parseJson: true });
const BINARY_SCOPE: EvidenceSanitizeScope = Object.freeze({ partial: false, parseJson: false });

function asArray(v: unknown, code: string): unknown[] {
  if (!Array.isArray(v)) invalid(code);
  return v;
}
function asRecord(v: unknown, code: string): Record<string, unknown> {
  const o = plainRecord(v);
  if (o === null) invalid(code);
  return o;
}
function safeInt(v: unknown, code: string, min = 0): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) invalid(code);
  return v;
}

/** Validates and copies the plan (labels only; the recorder limits must match the snapshot). */
function readPlan(v: unknown, budget: { nodes: number }): Record<string, unknown> {
  const p = exactRecord(
    v,
    [
      "kinds",
      "limits",
      "binding",
      "epoch",
      "subscribeRequestId",
      "unsubscribeRequestId",
      "endpointLabels",
    ],
    "PLAN",
    ["transactionRequest"],
  );
  const kinds = asRecord(copyPlain(p.kinds, budget, 0), "PLAN_KINDS_INVALID");
  for (const k of Object.keys(kinds)) {
    if (typeof kinds[k] !== "string" || !LABEL.test(kinds[k] as string))
      invalid("PLAN_KINDS_INVALID");
  }
  const limits = exactRecord(p.limits, PLAN_LIMIT_KEYS, "PLAN_LIMITS");
  const limitsCopy: Record<string, unknown> = {};
  for (const k of PLAN_LIMIT_KEYS) {
    limitsCopy[k] = asRecord(copyPlain(limits[k], budget, 0), "PLAN_LIMITS_INVALID");
  }
  const labels = asRecord(copyPlain(p.endpointLabels, budget, 0), "PLAN_ENDPOINT_LABELS_INVALID");
  if (Object.keys(labels).length === 0) invalid("PLAN_ENDPOINT_LABELS_INVALID");
  for (const k of Object.keys(labels)) {
    if (typeof labels[k] !== "string" || !LABEL.test(labels[k] as string)) {
      invalid("PLAN_ENDPOINT_LABELS_INVALID");
    }
  }
  return {
    kinds,
    limits: limitsCopy,
    binding: asRecord(copyPlain(p.binding, budget, 0), "PLAN_BINDING_INVALID"),
    epoch: safeInt(p.epoch, "PLAN_EPOCH_INVALID", 1),
    subscribeRequestId: safeInt(p.subscribeRequestId, "PLAN_REQUEST_ID_INVALID"),
    unsubscribeRequestId: safeInt(p.unsubscribeRequestId, "PLAN_REQUEST_ID_INVALID"),
    endpointLabels: labels,
    ...(p.transactionRequest === undefined
      ? {}
      : { transactionRequest: readTransactionRequest(p.transactionRequest) }),
  };
}

/** The only explicit request policy a plan may state: the v1-capable one (cap 1). */
function readTransactionRequest(v: unknown): Record<string, unknown> {
  const r = exactRecord(v, ["maxSupportedTransactionVersion"], "PLAN_TRANSACTION_REQUEST");
  if (r.maxSupportedTransactionVersion !== 1) invalid("PLAN_TRANSACTION_REQUEST_INVALID");
  return { ...CPMM_V1_CAPABLE_TRANSACTION_REQUEST };
}

function readAccount(v: unknown, code: string, sealer: PayloadSealer): Record<string, unknown> {
  const a = exactRecord(v, ["address", "ownerProgramId", "slot", "data"], code);
  if (typeof a.address !== "string" || !BASE58.test(a.address)) invalid(`${code}_ADDRESS_INVALID`);
  if (typeof a.ownerProgramId !== "string" || !BASE58.test(a.ownerProgramId)) {
    invalid(`${code}_OWNER_INVALID`);
  }
  return {
    address: a.address,
    ownerProgramId: a.ownerProgramId,
    slot: safeInt(a.slot, `${code}_SLOT_INVALID`),
    data: sealer.sealBytes(
      copyBytes(a.data, SEAL_LIMITS.maxAccountDataBytes, `${code}_DATA_INVALID`),
      BINARY_SCOPE,
    ),
  };
}

function readPoolContext(
  v: unknown,
  budget: { nodes: number },
  sealer: PayloadSealer,
): Record<string, unknown> {
  const c = exactRecord(
    v,
    ["target", "poolAccount", "vault0Account", "vault1Account", "adaptedPool", "acquisition"],
    "POOL_CONTEXT",
  );
  if (c.acquisition !== "SUPPLIED_UNVERIFIED") invalid("POOL_CONTEXT_ACQUISITION_UNSUPPORTED");
  const t = exactRecord(c.target, ["poolAddress", "candidateMint"], "POOL_CONTEXT_TARGET");
  if (
    typeof t.poolAddress !== "string" ||
    !BASE58.test(t.poolAddress) ||
    typeof t.candidateMint !== "string" ||
    !BASE58.test(t.candidateMint)
  ) {
    invalid("POOL_CONTEXT_TARGET_INVALID");
  }
  return {
    target: { poolAddress: t.poolAddress, candidateMint: t.candidateMint },
    accounts: {
      pool: readAccount(c.poolAccount, "POOL_ACCOUNT", sealer),
      vault0: readAccount(c.vault0Account, "VAULT0_ACCOUNT", sealer),
      vault1: readAccount(c.vault1Account, "VAULT1_ACCOUNT", sealer),
    },
    adaptedPool: asRecord(copyPlain(c.adaptedPool, budget, 0), "POOL_CONTEXT_ADAPTED_POOL_INVALID"),
    acquisition: "SUPPLIED_UNVERIFIED",
  };
}

function readComponentVersions(v: unknown): Record<string, string> {
  const o = exactRecord(v, CPMM_COMPONENT_VERSION_KEYS, "COMPONENT_VERSIONS");
  const out: Record<string, string> = {};
  for (const k of CPMM_COMPONENT_VERSION_KEYS) {
    if (typeof o[k] !== "string" || !COMMIT.test(o[k] as string)) {
      invalid("COMPONENT_VERSIONS_INVALID");
    }
    out[k] = o[k] as string;
  }
  return out;
}

function readSecrets(v: unknown): readonly string[] {
  const c = exactRecord(v, ["urls", "additional"], "CREDENTIALS");
  let secrets: readonly string[];
  try {
    secrets = deriveEvidenceSecrets(c.urls as string[], c.additional as string[]);
  } catch {
    return invalid("CREDENTIALS_INVALID");
  }
  if (secrets.length === 0) invalid("CREDENTIALS_EMPTY");
  return secrets;
}

const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

interface RenderedFile {
  readonly path: string;
  readonly content: string;
}

/** Whole-file residue scan with the accepted sanitizer: anything detectable refuses the seal. */
function scanRendered(file: RenderedFile, secrets: readonly string[]): void {
  const bytes = Buffer.from(file.content, "utf8");
  if (bytes.length > CPMM_EVIDENCE_VERIFIER_LIMITS.maxFileBytes) {
    refused(`RENDERED_FILE_TOO_LARGE:${file.path}`);
  }
  for (const s of secrets) {
    if (file.content.includes(s)) refused(`RESIDUAL_CREDENTIAL:${file.path}`);
  }
  let r: ReturnType<typeof sanitizeEvidenceBytes>;
  try {
    r = sanitizeEvidenceBytes(bytes, secrets, TEXT_SCOPE);
  } catch {
    return refused(`RESIDUAL_CREDENTIAL:${file.path}`);
  }
  if (r.status === "WITHHELD") {
    refused(
      r.reason === "CREDENTIAL_MATERIAL_DETECTED"
        ? `RESIDUAL_CREDENTIAL:${file.path}`
        : `RESIDUE_SCAN_INCONCLUSIVE:${file.path}`,
    );
  }
  if (r.redacted) refused(`RESIDUAL_CREDENTIAL:${file.path}`);
}

const render = (rel: string, value: unknown): RenderedFile => ({
  path: rel,
  content: `${JSON.stringify(value, null, 2)}\n`,
});

/** Validates inputs (including any acquisition dependency) and renders before any writes. */
function prepare(input: unknown): {
  outDir: string;
  files: RenderedFile[];
  manifest: RenderedFile;
  entries: CpmmEvidenceManifestEntry[];
  payloads: CpmmEvidencePayloadSummary;
  writer: NonNullable<SealCpmmObservationInput["writeEvidenceFile"]>;
} {
  const i = exactRecord(
    input,
    [
      "projectRoot",
      "runId",
      "snapshot",
      "plan",
      "componentVersions",
      "poolContext",
      "credentials",
      "lateActivity",
    ],
    "INPUT",
    ["writeEvidenceFile", "acquisitionDir"],
  );
  if (typeof i.projectRoot !== "string" || !path.isAbsolute(i.projectRoot)) {
    invalid("PROJECT_ROOT_INVALID");
  }
  if (typeof i.runId !== "string" || !RUN_ID.test(i.runId) || /^\.+$/.test(i.runId)) {
    invalid("RUN_ID_INVALID");
  }
  const writer =
    i.writeEvidenceFile === undefined
      ? (writeFileSync as NonNullable<SealCpmmObservationInput["writeEvidenceFile"]>)
      : typeof i.writeEvidenceFile === "function"
        ? (i.writeEvidenceFile as NonNullable<SealCpmmObservationInput["writeEvidenceFile"]>)
        : invalid("WRITER_INVALID");
  const secrets = readSecrets(i.credentials);
  const versions = readComponentVersions(i.componentVersions);
  const budget = { nodes: SEAL_LIMITS.maxInputNodes };
  const plan = readPlan(i.plan, budget);
  const sealer = payloadSealer(secrets);
  const poolContext = readPoolContext(i.poolContext, budget, sealer);
  // A v1-capable plan seals schema 3, which exists only with an acquisition dependency.
  const v1Capable = plan.transactionRequest !== undefined;
  if (v1Capable && i.acquisitionDir === undefined) {
    invalid("TRANSACTION_REQUEST_POLICY_REQUIRES_ACQUISITION");
  }
  let acquisitionManifestSha256: string | null = null;
  if (i.acquisitionDir !== undefined) {
    if (typeof i.acquisitionDir !== "string") invalid("ACQUISITION_DIRECTORY_INVALID");
    const binding = checkAcquisitionBinding(poolContext, plan.binding, i.acquisitionDir, null);
    if (binding.status !== "REPRODUCED" || binding.manifestSha256 === null) {
      const cause = binding.findings.find((finding) => finding.startsWith(`${binding.status}:`));
      refused(`ACQUISITION_BINDING:${cause ?? "MISSING_EVIDENCE:MANIFEST_UNAVAILABLE"}`);
    }
    acquisitionManifestSha256 = binding.manifestSha256;
  }
  const schemaVersion: EvidenceSchemaVersion =
    acquisitionManifestSha256 === null
      ? CPMM_EVIDENCE_SCHEMA_VERSION
      : v1Capable
        ? CPMM_V1_CAPABLE_EVIDENCE_SCHEMA_VERSION
        : BOUND_SCHEMA_VERSION;
  const requestPolicy = CPMM_EVIDENCE_SCHEMA_POLICIES[schemaVersion];
  const late =
    i.lateActivity === null
      ? null
      : asRecord(copyPlain(i.lateActivity, budget, 0), "LATE_ACTIVITY_INVALID");
  if (late !== null) {
    for (const k of Object.keys(late)) safeInt(late[k], "LATE_ACTIVITY_INVALID");
  }

  // The snapshot, copied as plain data and checked against the recorder's contract.
  const snap = asRecord(copyPlain(i.snapshot, budget, 0), "SNAPSHOT_INVALID");
  if (
    snap.kind !== "CPMM_POOL_OBSERVATION_RECORDING" ||
    snap.version !== 1 ||
    snap.material !== "UNSANITIZED_MEMORY_ONLY"
  ) {
    invalid("SNAPSHOT_KIND_INVALID");
  }
  if (!deepEqual(snap.limits, (plan.limits as Record<string, unknown>).recorder)) {
    invalid("RECORDER_LIMITS_MISMATCH");
  }
  const components = asRecord(snap.components, "SNAPSHOT_COMPONENTS_INVALID");
  // The same structural rules verification applies, checked before anything is written.
  const structural = structureProblems({
    records: TRANSPORT_CATEGORIES.flatMap((category) =>
      asArray(snap[category], "SNAPSHOT_RECORDS_INVALID").map((record) => ({ category, record })),
    ),
    exchanges: asArray(snap.exchanges, "SNAPSHOT_EXCHANGES_INVALID").map((x) => ({
      method: get(x, "method"),
      requestBody: get(x, "requestBody"),
      bodyState: get(x, "bodyState"),
      body: get(x, "body"),
      bodyComplete: get(x, "entry", "bodyComplete"),
      observedBodyBytes: get(x, "observedBodyBytes"),
      maxResponseBytes: get(x, "maxResponseBytes"),
    })),
    originalBytesOf: (p) => get(p, "byteLength"),
    sections: Object.fromEntries(SECTION_NAMES.map((n) => [n, components[n]])) as Record<
      SectionName,
      unknown
    >,
    recording: snap,
    ledgerCalls: snap.ledgerCalls,
  });
  if (structural.length > 0) invalid(`SNAPSHOT_STRUCTURE_INVALID:${structural[0]!}`);
  const section = (k: string): unknown => {
    const s = asRecord(components[k], "SNAPSHOT_COMPONENTS_INVALID");
    if (s.status !== "READ" && s.status !== "NOT_SUPPLIED" && s.status !== "READ_FAILED") {
      invalid("SNAPSHOT_COMPONENTS_INVALID");
    }
    return s;
  };

  // Transport records in ordinal order, payloads sanitized.
  const records: Record<string, unknown>[] = [];
  const ordinals = new Set<number>();
  for (const category of TRANSPORT_CATEGORIES) {
    for (const r of asArray(snap[category], "SNAPSHOT_RECORDS_INVALID")) {
      const rec = { ...asRecord(r, "SNAPSHOT_RECORDS_INVALID") };
      const ordinal = safeInt(rec.ordinal, "SNAPSHOT_ORDINAL_INVALID", 1);
      if (ordinals.has(ordinal)) invalid("SNAPSHOT_ORDINAL_DUPLICATE");
      ordinals.add(ordinal);
      if ("payload" in rec) {
        const text = rec.kind === "CALL" && rec.method === "send";
        const message = rec.kind === "EVENT" && rec.event === "message";
        rec.payload = sealer.seal(rec.payload, text || message ? TEXT_SCOPE : BINARY_SCOPE);
      }
      records.push({ category, ...rec });
    }
  }
  records.sort((a, b) => (a.ordinal as number) - (b.ordinal as number));

  // Exchanges, by session sequence.
  const exchanges: { seq: number; ordinal: number; file: RenderedFile }[] = [];
  const seqs = new Set<number>();
  const snapExchanges = asArray(snap.exchanges, "SNAPSHOT_EXCHANGES_INVALID");
  if (snapExchanges.length > SEAL_LIMITS.maxExchanges) invalid("SNAPSHOT_EXCHANGES_TOO_MANY");
  for (const x of snapExchanges) {
    const ex = asRecord(x, "SNAPSHOT_EXCHANGES_INVALID");
    const entry = asRecord(ex.entry, "SNAPSHOT_EXCHANGES_INVALID");
    const seq = safeInt(entry.seq, "SNAPSHOT_EXCHANGE_SEQ_INVALID");
    if (seq > 999_999) invalid("SNAPSHOT_EXCHANGE_SEQ_INVALID");
    if (seqs.has(seq)) invalid("SNAPSHOT_EXCHANGE_SEQ_DUPLICATE");
    seqs.add(seq);
    if (ex.endpoint !== CPMM_EXCHANGE_ENDPOINT_LABEL || entry.purpose !== CPMM_TX_PURPOSE) {
      invalid("SNAPSHOT_EXCHANGE_INVALID");
    }
    const ordinal = safeInt(ex.ordinal, "SNAPSHOT_ORDINAL_INVALID", 1);
    const requestBody = sealer.seal(ex.requestBody, TEXT_SCOPE);
    // Schema 3's writer refuses a request that did not carry its policy exactly (schemas 1 and 2
    // keep their historical behaviour: verification reports such a request as a mismatch).
    if (schemaVersion === CPMM_V1_CAPABLE_EVIDENCE_SCHEMA_VERSION) {
      const sig = entry.requestedIdentity;
      const id = entry.jsonRpcId;
      if (ex.method !== "POST" || !isValidSolanaSignature(sig) || !isInt(id) || id < 1) {
        invalid("SNAPSHOT_EXCHANGE_REQUEST_POLICY_MISMATCH");
      }
      const expected = cpmmGetTransactionRequestBody(
        sig as string,
        id as number,
        requestPolicy.maxSupportedTransactionVersion,
      );
      if (
        requestBody === null ||
        requestBody.originalSha256 !== sha256(expected) ||
        requestBody.originalBytes !== Buffer.byteLength(expected)
      ) {
        invalid("SNAPSHOT_EXCHANGE_REQUEST_POLICY_MISMATCH");
      }
    }
    exchanges.push({
      seq,
      ordinal,
      file: render(exchangePath(seq), {
        kind: EXCHANGE_FILE_KIND,
        version: CPMM_EVIDENCE_SCHEMA_VERSION,
        ordinal,
        endpoint: CPMM_EXCHANGE_ENDPOINT_LABEL,
        entry,
        method: ex.method,
        requestBody,
        responseHeaders: ex.responseHeaders,
        responseHeadersTruncated: ex.responseHeadersTruncated,
        bodyState: ex.bodyState,
        body: sealer.seal(ex.body, {
          partial: ex.bodyState === "PARTIAL_OVERFLOW",
          parseJson: true,
        }),
        observedBodyBytes: ex.observedBodyBytes,
        maxResponseBytes: ex.maxResponseBytes,
      }),
    });
  }
  exchanges.sort((a, b) => a.seq - b.seq);

  // The session ledger window, counted by lane, owner and purpose.
  const windowSection = section("sessionLedgerWindow") as Record<string, unknown>;
  const counts: Record<string, number> = {};
  if (windowSection.status === "READ") {
    for (const e of asArray(windowSection.value, "SESSION_WINDOW_INVALID")) {
      const entry = asRecord(e, "SESSION_WINDOW_INVALID");
      const key = `${String(entry.lane)}|${String(entry.owner)}|${String(entry.purpose)}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }

  const reportSection = section("report") as Record<string, unknown>;
  const reportValue = reportSection.status === "READ" ? plainRecord(reportSection.value) : null;
  const pick = (o: Record<string, unknown> | null, k: string): unknown =>
    o !== null && k in o ? o[k] : null;
  const cleanup = plainRecord(pick(reportValue, "cleanup"));

  const files: RenderedFile[] = [
    render(CPMM_EVIDENCE_FILES.plan, {
      kind: FILE_KINDS[CPMM_EVIDENCE_FILES.plan],
      version: CPMM_EVIDENCE_SCHEMA_VERSION,
      runId: i.runId,
      plan,
      componentVersions: versions,
    }),
    render(CPMM_EVIDENCE_FILES.poolContext, {
      kind: FILE_KINDS[CPMM_EVIDENCE_FILES.poolContext],
      version: schemaVersion,
      ...poolContext,
      ...(acquisitionManifestSha256 === null
        ? {}
        : { acquisition: ACQUIRED_BOUND, acquisitionManifestSha256 }),
    }),
    render(CPMM_EVIDENCE_FILES.ownerReport, {
      kind: FILE_KINDS[CPMM_EVIDENCE_FILES.ownerReport],
      version: CPMM_EVIDENCE_SCHEMA_VERSION,
      report: section("report"),
      lateEvents: section("ownerLateEvents"),
    }),
    render(CPMM_EVIDENCE_FILES.transportDiagnostics, {
      kind: FILE_KINDS[CPMM_EVIDENCE_FILES.transportDiagnostics],
      version: CPMM_EVIDENCE_SCHEMA_VERSION,
      diagnostics: section("wrapperDiagnostics"),
    }),
    render(CPMM_EVIDENCE_FILES.transportRecords, {
      kind: FILE_KINDS[CPMM_EVIDENCE_FILES.transportRecords],
      version: CPMM_EVIDENCE_SCHEMA_VERSION,
      observationListeners: snap.observationListeners,
      records,
    }),
    render(CPMM_EVIDENCE_FILES.collector, {
      kind: FILE_KINDS[CPMM_EVIDENCE_FILES.collector],
      version: CPMM_EVIDENCE_SCHEMA_VERSION,
      epochReport: section("collectorEpochReport"),
      frameRecords: section("collectorFrameRecords"),
      notifications: section("collectorNotifications"),
      counters: section("collectorCounters"),
      limits: (plan.limits as Record<string, unknown>).collector,
    }),
    render(CPMM_EVIDENCE_FILES.ledger, {
      kind: FILE_KINDS[CPMM_EVIDENCE_FILES.ledger],
      version: CPMM_EVIDENCE_SCHEMA_VERSION,
      records: section("ledgerRecords"),
      epochs: section("ledgerEpochs"),
      counters: section("ledgerCounters"),
      calls: asArray(snap.ledgerCalls, "SNAPSHOT_LEDGER_CALLS_INVALID"),
      delegatedCalls: snap.delegatedLedgerCalls,
    }),
    render(CPMM_EVIDENCE_FILES.sessionLedger, {
      kind: FILE_KINDS[CPMM_EVIDENCE_FILES.sessionLedger],
      version: CPMM_EVIDENCE_SCHEMA_VERSION,
      start: components.sessionLedgerStart,
      endLength: section("sessionLedgerEndLength"),
      window: windowSection,
      countsByLaneOwnerPurpose: counts,
      otherExchanges: snap.otherExchanges,
    }),
    render(CPMM_EVIDENCE_FILES.exchangeIndex, {
      kind: FILE_KINDS[CPMM_EVIDENCE_FILES.exchangeIndex],
      version: CPMM_EVIDENCE_SCHEMA_VERSION,
      exchanges: exchanges.map((x) => ({ seq: x.seq, path: x.file.path, ordinal: x.ordinal })),
    }),
    ...exchanges.map((x) => x.file),
    render(CPMM_EVIDENCE_FILES.recording, {
      kind: FILE_KINDS[CPMM_EVIDENCE_FILES.recording],
      version: CPMM_EVIDENCE_SCHEMA_VERSION,
      material: "SANITIZED_SEALED_EVIDENCE",
      limits: snap.limits,
      ordinalsAssigned: snap.ordinalsAssigned,
      transportRecorded: snap.transportRecorded,
      ledgerRecorded: snap.ledgerRecorded,
      retention: snap.retention,
      instrumentation: snap.instrumentation,
      pending: snap.pending,
      fanOut: section("fanOutDiagnostics"),
      payloads: { ...sealer.summary },
      lateActivity: late,
    }),
  ];
  for (const f of files) scanRendered(f, secrets);
  const digest = (f: RenderedFile): CpmmEvidenceManifestEntry => ({
    path: f.path,
    bytes: Buffer.byteLength(f.content, "utf8"),
    sha256: sha256(f.content),
  });
  const report = render(CPMM_EVIDENCE_FILES.report, {
    kind: FILE_KINDS[CPMM_EVIDENCE_FILES.report],
    version: schemaVersion,
    runId: i.runId,
    runOutcome: {
      terminal: pick(reportValue, "terminal"),
      cleanupStatus: pick(cleanup, "status"),
      connectionRunClean: pick(reportValue, "connectionRunClean"),
    },
    files: files.map(digest).sort((a, b) => (a.path < b.path ? -1 : 1)),
    payloads: { ...sealer.summary },
    recordedByRecorder: {
      note: "Recorded flags are informational; verification derives retention from the evidence.",
      recorderRetentionComplete: pick(plainRecord(snap.retention), "recorderRetentionComplete"),
      instrumentationComplete: pick(plainRecord(snap.instrumentation), "complete"),
    },
    poolContextProvenance:
      acquisitionManifestSha256 === null ? "SUPPLIED_UNVERIFIED" : ACQUIRED_BOUND,
    acquisitionProvenance: acquisitionManifestSha256 === null ? "OPEN_G3" : ACQUIRED_BOUND,
    ...(v1Capable ? { transactionRequest: { ...CPMM_V1_CAPABLE_TRANSACTION_REQUEST } } : {}),
    rederivation: { status: "NOT_IMPLEMENTED" },
    credentialsRecorded: false,
    endpointUrlsRecorded: false,
    ...CPMM_EVIDENCE_FALSE_FLAGS,
  });
  scanRendered(report, secrets);
  files.push(report);
  const entries = files.map(digest).sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest = render(CPMM_EVIDENCE_FILES.manifest, {
    kind: CPMM_EVIDENCE_MANIFEST_KIND,
    version: CPMM_EVIDENCE_MANIFEST_VERSION,
    evidenceSchemaVersion: schemaVersion,
    componentVersions: versions,
    files: entries,
  });
  scanRendered(manifest, secrets);
  return {
    outDir: path.join(i.projectRoot, ...CPMM_EVIDENCE_ROOT_SEGMENTS, i.runId),
    files,
    manifest,
    entries,
    payloads: { ...sealer.summary },
    writer,
  };
}

/**
 * Seals one recorded run. Every refusal happens before the output directory exists; a write
 * failure afterwards leaves no manifest, reports the files already created, and is never retried.
 */
export function sealCpmmObservationEvidence(
  input: SealCpmmObservationInput,
): SealCpmmObservationResult {
  const failure = (
    status: SealStatus,
    code: string,
    extra: {
      outDir?: string | null;
      failedFile?: string | null;
      filesWritten?: string[];
      directoriesCreated?: string[];
    } = {},
  ): SealCpmmObservationResult =>
    Object.freeze({
      ok: false as const,
      status,
      code,
      outDir: extra.outDir ?? null,
      failedFile: extra.failedFile ?? null,
      filesWritten: Object.freeze([...(extra.filesWritten ?? [])]),
      directoriesCreated: Object.freeze([...(extra.directoriesCreated ?? [])]),
    });
  const errno = (e: unknown): string => {
    const c =
      e !== null && typeof e === "object" && !isProxy(e) ? getOwnDesc(e, "code") : undefined;
    const v = c !== undefined && "value" in c ? (c.value as unknown) : undefined;
    return typeof v === "string" && ERRNO.test(v) ? v : "UNKNOWN";
  };

  // 1. Validate, sanitize, render and scan everything before writes.
  let prepared: ReturnType<typeof prepare>;
  try {
    prepared = prepare(input);
  } catch (e) {
    if (e instanceof SealFailure) return failure(e.status, e.code);
    return failure("SEAL_INPUT_INVALID", "INPUT_UNREADABLE");
  }
  const { outDir, files, manifest, entries, payloads, writer } = prepared;

  // 2. A new directory only: an existing one is refused, never reused.
  try {
    mkdirSync(path.dirname(outDir), { recursive: true });
    mkdirSync(outDir);
  } catch (e) {
    const code = errno(e);
    return failure(
      "OUTPUT_DIRECTORY_UNAVAILABLE",
      code === "EEXIST" ? "OUTPUT_DIRECTORY_EXISTS" : `OUTPUT_DIRECTORY_FAILED:${code}`,
      { outDir },
    );
  }

  // 3. Exclusive writes, the manifest last; the first failure stops everything (no retry).
  const filesWritten: string[] = [];
  const directoriesCreated: string[] = [];
  for (const f of [...files, manifest]) {
    try {
      const dir = path.posix.dirname(f.path);
      if (dir !== "." && !directoriesCreated.includes(dir)) {
        mkdirSync(path.join(outDir, ...dir.split("/")));
        directoriesCreated.push(dir);
      }
      writer(path.join(outDir, ...f.path.split("/")), f.content, { encoding: "utf8", flag: "wx" });
    } catch (e) {
      return failure("ARTIFACT_WRITE_FAILED", `ARTIFACT_WRITE_FAILED:${errno(e)}`, {
        outDir,
        failedFile: f.path,
        filesWritten,
        directoriesCreated,
      });
    }
    filesWritten.push(f.path);
  }
  return Object.freeze({
    ok: true as const,
    status: "SEALED" as const,
    outDir,
    manifestSha256: sha256(manifest.content),
    files: Object.freeze(entries.map((e) => Object.freeze({ ...e }))),
    payloads: Object.freeze({ ...payloads }),
    rederivation: "NOT_IMPLEMENTED" as const,
  });
}

// ---------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------

export interface CpmmEvidenceVerification {
  readonly outDir: string;
  /** SHA-256 of the exact manifest bytes parsed (null when none were read). */
  readonly manifestSha256: string | null;
  readonly integrity: { readonly ok: boolean; readonly problems: readonly string[] };
  /** Derived from the evidence; `NOT_EVALUATED` when integrity failed. */
  readonly retention: {
    readonly status: "COMPLETE" | "INCOMPLETE" | "NOT_EVALUATED";
    readonly reasons: readonly string[];
  };
  /**
   * Item G, computed now by verification (never read from the sealed report): only pool context
   * and collector replay are implemented; the rest is reported as not implemented. Not attempted
   * when integrity failed.
   */
  readonly rederivation: CpmmRederivation;
  /** What the sealed report itself claims, kept apart from the results computed above. */
  readonly sealedClaims: {
    readonly rederivation: unknown;
    readonly poolContextProvenance: unknown;
    readonly acquisitionProvenance: unknown;
    readonly runOutcome: unknown;
  } | null;
  /** Null for an unverified bound claim or an observation integrity failure. */
  readonly poolContextProvenance: "SUPPLIED_UNVERIFIED" | "ACQUIRED_BOUND" | null;
  readonly acquisitionProvenance: "OPEN_G3" | "ACQUIRED_BOUND";
  /**
   * Only for acquisition-bound schemas (2 and 3) after observation integrity passes. Never changes
   * observation integrity.
   */
  readonly acquisitionBinding?: CpmmAcquisitionBinding;
  readonly flags: typeof CPMM_EVIDENCE_FALSE_FLAGS;
}

export type CpmmRederivationStatus =
  | "REPRODUCED"
  | "MISMATCH"
  | "MISSING_EVIDENCE"
  | "LIMITED_BY_REDACTION";

interface CpmmAcquisitionBinding extends CpmmComponentRederivation {
  readonly expectedManifestSha256: string | null;
  readonly manifestSha256: string | null;
  readonly dependency: Pick<
    CpmmPoolAcquisitionVerification,
    "integrity" | "integrityCode" | "computed"
  > | null;
}

export interface CpmmComponentRederivation {
  readonly status: CpmmRederivationStatus;
  /** `<STATUS>:<CODE>` findings, fixed codes only. */
  readonly findings: readonly string[];
}

export interface CpmmCollectorRederivation extends CpmmComponentRederivation {
  /** Owner-received messages the collector saw (by the collector's own frame count). */
  readonly handedOverMessages: number;
  /** Frames fed to a fresh collector with their recorded bytes and receipt times. */
  readonly replayedFrames: number;
  /** Frames associated by order, length and digest only (not replayed). */
  readonly structurallyCheckedFrames: number;
  /** False whenever replay stopped early: those reports were then not compared. */
  readonly epochReportCompared: boolean;
  readonly countersCompared: boolean;
}

/** One sealed CPMM exchange: its decoded outcome, the recorded fact and their comparison, apart. */
export interface CpmmTransactionExchangeResult {
  readonly seq: number;
  readonly signature: string | null;
  /** The accepted analysis of the exact complete response bytes; null when not analysed. */
  readonly decoded: {
    readonly kind: string;
    readonly code: string | null;
    readonly detail: string | null;
    readonly replay: string;
    readonly decoderStatus: string | null;
    readonly bodyState: string;
  } | null;
  /** Why the response was not analysed (a fixed code), or null. */
  readonly notAnalysed: string | null;
  /** The ledger's recorded runtime fact for this signature, or null when not available. */
  readonly recorded: { readonly factKind: string | null; readonly factCode: string | null } | null;
  readonly comparison:
    | "MATCHED"
    | "MISMATCH"
    | "RUNTIME_OUTCOME_NOT_COMPARED"
    | "NOT_COMPARED_ANALYSIS_UNAVAILABLE"
    | "NOT_COMPARED_LIMITED_BY_REDACTION"
    | "NOT_COMPARED_MISSING_EVIDENCE"
    /** The account call, settlement or ledger record binding this exchange is contradicted. */
    | "NOT_COMPARED_BINDING_CONTRADICTED";
}

export interface CpmmTransactionRederivation extends CpmmComponentRederivation {
  /** UNAVAILABLE: no valid analysis credentials, or no reproduced pool context. */
  readonly analysis: "AVAILABLE" | "UNAVAILABLE";
  readonly unavailableReason:
    | "ANALYSIS_CREDENTIALS_NOT_SUPPLIED"
    | "ANALYSIS_CREDENTIALS_INVALID"
    | "POOL_CONTEXT_NOT_REPRODUCED"
    | null;
  readonly exchanges: readonly CpmmTransactionExchangeResult[];
  /** Exchanges whose response-dependent fact was compared (matched or not). */
  readonly comparedExchanges: number;
  /** Exchanges with a runtime-only fact: listed, never counted as reproduced or contradicted. */
  readonly runtimeOutcomesNotCompared: number;
}

/** Explicitly supplied; never read from configuration or the environment, never retained. */
export interface CpmmEvidenceVerificationOptions {
  /** The credential values the run's adapter was given (the adapter's own `secrets` rule). */
  readonly analysisSecrets?: readonly string[];
  /** Absolute path to the acquisition bundle for a version 2 or 3 observation. */
  readonly acquisitionDir?: string;
}

/**
 * Item G (partial): structural cross-checks of the recorded ledger, its epochs, counters, account
 * calls and settlements, over the validated documents. The ledger is never re-executed and
 * ingestion is never repeated: consistency here is structural only, within `scope`.
 */
export interface CpmmLedgerStructuralCheck {
  readonly status: "STRUCTURALLY_CONSISTENT" | "MISSING_EVIDENCE" | "MISMATCH";
  readonly scope: "RECORDED_LEDGER_STRUCTURE_ONLY";
  readonly ledgerReplayed: false;
  readonly ingestionReplayed: false;
  readonly findings: readonly string[];
  readonly checked: {
    readonly records: number;
    readonly epochs: number;
    readonly accountCalls: number;
    readonly settlements: number;
    readonly duplicateDetails: number;
    /**
     * Ingestion totals equal to the event count decoded from the matched response. Corroborates
     * the recorded total only; acceptance by the tracker is the runtime's report, never proven.
     */
    readonly eventTotalsCorroborated: number;
    /**
     * Records whose verified slot and block time the ledger derived from a bound swap's events,
     * equal to the slot and block time of the events decoded from the matched response.
     */
    readonly verifiedMetadataCorroborated: number;
  };
  /** Which exact cross-checks the recorded scope supported (false: a finding says why not). */
  readonly coverage: {
    /** Ledger-wide counters against the per-epoch totals and the records. */
    readonly epochTotals: boolean;
    /** Account calls and settlements against the ledger's counts, exactly. */
    readonly callTotals: boolean;
    /** Every duplicate occurrence's detail retained. */
    readonly duplicateDetails: boolean;
    /** Every event-derived verified slot and block time corroborated by a matched analysis. */
    readonly eventMetadata: boolean;
  };
}

/**
 * Bounded metadata of the events decoded from one matched `RESOLVED_SWAPS` response: their count,
 * and their slot and block time when every event agrees (null otherwise).
 */
interface DecodedSwapEvents {
  readonly count: number;
  readonly slot: number | null;
  readonly blockTimeSec: number | null;
}

/**
 * Item G (partial): structural cross-checks of the owner's report, the wrapper's diagnostics and
 * the decorator's transport records, by phase. Neither the owner nor the wrapper is run again.
 */
export interface CpmmOwnerWrapperStructuralCheck {
  readonly status: "STRUCTURALLY_CONSISTENT" | "MISSING_EVIDENCE" | "MISMATCH";
  readonly scope: "RECORDED_OWNER_WRAPPER_STRUCTURE_ONLY";
  readonly ownerReplayed: false;
  readonly wrapperReplayed: false;
  readonly findings: readonly string[];
  readonly checked: {
    readonly transportRecords: number;
    readonly wrapperObservedEvents: number;
    /** Events at least one owner listener received. */
    readonly ownerReceivedEvents: number;
    /** Events the wrapper dispatched with no owner listener (before registration or after disposal). */
    readonly wrapperOnlyEvents: number;
    readonly outgoingCalls: number;
    /** Completions compared with the owner's attempts (before its settlement). */
    readonly completions: number;
    /** Records after the settlement boundary: late owner events, completions, later activity. */
    readonly afterSettlementRecords: number;
  };
  /**
   * The owner's last recorded transport action: its report is frozen after it, while the
   * wrapper's diagnostics run to finish(). Null when retention loss hides it.
   */
  readonly settlementBoundaryOrdinal: number | null;
  /** Which exact comparisons the recorded scope supported (false: a finding says why not). */
  readonly coverage: {
    /** The wrapper's diagnostics against every record, exactly. */
    readonly wrapper: boolean;
    /** The owner's incoming and late event counts against what its listeners received. */
    readonly ownerIncoming: boolean;
    /** The owner's application, ping and pong attempts against calls and completions. */
    readonly ownerOutgoing: boolean;
    /** The owner's cleanup against its own calls and close observation before settlement. */
    readonly cleanup: boolean;
    /** The report's times and the collector's receipts in order. */
    readonly timing: boolean;
  };
}

export interface CpmmRederivation {
  readonly status: "PARTIAL" | "NOT_ATTEMPTED";
  /**
   * The worst result among the implemented components only; never a whole-run claim. A
   * structurally consistent ledger does not lower it, and is never called reproduced.
   */
  readonly implementedComponents: CpmmRederivationStatus | null;
  readonly components: {
    readonly poolContext: CpmmComponentRederivation;
    readonly collector: CpmmCollectorRederivation;
    readonly transactionAnalysis: CpmmTransactionRederivation;
    readonly ledger: CpmmLedgerStructuralCheck;
    readonly ownerWrapperCrossChecks: CpmmOwnerWrapperStructuralCheck;
    readonly runtimeAccounting: { readonly status: "RUNTIME_ACCOUNTING_NOT_REPRODUCED" };
  } | null;
}

const VL = CPMM_EVIDENCE_VERIFIER_LIMITS;
const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const get = (v: unknown, ...keys: string[]): unknown => {
  let cur = v;
  for (const k of keys) {
    if (!isRec(cur) || !Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
};
const isInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const sameKeys = (o: unknown, keys: readonly string[]): boolean =>
  isRec(o) && Object.keys(o).sort().join(",") === [...keys].sort().join(",");
const safeName = (rel: string): string =>
  /^[A-Za-z0-9._/-]{1,128}$/.test(rel) && !rel.includes("..") ? rel : "<unsafe-name>";

/** Every component of `rel` under `dir` must be a real directory, and the last a regular file. */
function lstatConfined(dir: string, rel: string): { size: number } | string {
  const parts = rel.split("/");
  let cur = dir;
  for (const [i, part] of parts.entries()) {
    cur = path.join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return `MISSING_FILE:${rel}`;
    }
    if (st.isSymbolicLink()) return `LINK_REJECTED:${rel}`;
    if (i < parts.length - 1) {
      if (!st.isDirectory()) return `NOT_A_DIRECTORY:${rel}`;
    } else {
      if (!st.isFile()) return `NOT_REGULAR_FILE:${rel}`;
      if (st.nlink > 1) return `LINK_REJECTED:${rel}`;
      return { size: st.size };
    }
  }
  return `MISSING_FILE:${rel}`;
}

/** Files at any depth, bounded; links, special files and unknown directories are problems. */
function walk(dir: string, problems: string[]): string[] {
  const files: string[] = [];
  let seen = 0;
  const visit = (abs: string, rel: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      problems.push(`DIRECTORY_UNREADABLE:${safeName(rel || ".")}`);
      return;
    }
    for (const name of names) {
      if (++seen > VL.maxEntries + 2) {
        problems.push("TOO_MANY_ENTRIES");
        return;
      }
      const childRel = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = lstatSync(path.join(abs, name));
      } catch {
        problems.push(`UNREADABLE_ENTRY:${safeName(childRel)}`);
        continue;
      }
      if (st.isSymbolicLink()) problems.push(`LINK_REJECTED:${safeName(childRel)}`);
      else if (st.isDirectory()) {
        if (childRel !== "exchanges" || depth + 1 >= VL.maxWalkDepth) {
          problems.push(`UNLISTED_DIRECTORY:${safeName(childRel)}`);
        } else visit(path.join(abs, name), childRel, depth + 1);
      } else if (st.isFile()) files.push(childRel);
      else problems.push(`NOT_REGULAR_FILE:${safeName(childRel)}`);
    }
  };
  visit(dir, "", 0);
  return files;
}

/** Reads a confined regular file only after its size is known to be within `limit`. */
function readBounded(dir: string, rel: string, limit: number): Buffer | string {
  const st = lstatConfined(dir, rel);
  if (typeof st === "string") return st;
  if (st.size > limit) return `FILE_TOO_LARGE:${rel}`;
  let b: Buffer;
  try {
    b = readFileSync(path.join(dir, ...rel.split("/")));
  } catch {
    return `FILE_UNREADABLE:${rel}`;
  }
  return b.length === st.size ? b : `FILE_CHANGED_DURING_READ:${rel}`;
}

function parseStrict(b: Buffer): unknown {
  if (!isValidUtf8(b)) return undefined;
  try {
    return JSON.parse(b.toString("utf8"));
  } catch {
    return undefined;
  }
}

/** One sealed payload: exactly one state, strict decoding and consistent digests. */
function payloadProblem(p: unknown): string | null {
  if (!sameKeys(p, SEALED_PAYLOAD_KEYS)) return "PAYLOAD_MALFORMED";
  const o = p as Record<string, unknown>;
  const nullStored =
    o.storedEncoding === null &&
    o.stored === null &&
    o.storedBytes === null &&
    o.storedSha256 === null &&
    o.payloadRedacted === false &&
    o.redactions === 0 &&
    o.partialFragmentRedacted === false;
  const hexOrNull = (v: unknown) => v === null || (typeof v === "string" && HEX64.test(v));
  if (!hexOrNull(o.originalSha256) || !(o.originalBytes === null || isInt(o.originalBytes))) {
    return "PAYLOAD_MALFORMED";
  }
  if (
    o.jsonInspection !== null &&
    !(typeof o.jsonInspection === "string" && JSON_INSPECTIONS.has(o.jsonInspection))
  ) {
    return "PAYLOAD_MALFORMED";
  }
  if (o.payloadOmitted !== null) {
    if (typeof o.payloadOmitted !== "string" || !OMISSIONS.has(o.payloadOmitted)) {
      return "PAYLOAD_MALFORMED";
    }
    if (!nullStored || o.withheldReason !== null || o.jsonInspection !== null) {
      return "PAYLOAD_STATE_INCONSISTENT";
    }
    const hashed = o.originalSha256 !== null;
    if (o.payloadOmitted === "BYTE_ALLOWANCE" && (!hashed || o.originalBytes === null)) {
      return "PAYLOAD_STATE_INCONSISTENT";
    }
    if (o.payloadOmitted !== "BYTE_ALLOWANCE" && hashed) return "PAYLOAD_STATE_INCONSISTENT";
    if (o.payloadOmitted === "NOT_BYTES" && o.originalBytes !== null) {
      return "PAYLOAD_STATE_INCONSISTENT";
    }
    return null;
  }
  if (o.originalBytes === null || o.originalSha256 === null) return "PAYLOAD_STATE_INCONSISTENT";
  if (o.withheldReason !== null) {
    if (typeof o.withheldReason !== "string" || !WITHHELD_REASONS.has(o.withheldReason)) {
      return "PAYLOAD_MALFORMED";
    }
    return nullStored ? null : "PAYLOAD_STATE_INCONSISTENT";
  }
  if (
    (o.storedEncoding !== "utf8" && o.storedEncoding !== "base64") ||
    typeof o.stored !== "string" ||
    !isInt(o.storedBytes) ||
    !hexOrNull(o.storedSha256) ||
    o.storedSha256 === null ||
    typeof o.payloadRedacted !== "boolean" ||
    !isInt(o.redactions) ||
    typeof o.partialFragmentRedacted !== "boolean"
  ) {
    return "PAYLOAD_MALFORMED";
  }
  let decoded: Buffer | null;
  if (o.storedEncoding === "base64") {
    decoded = strictBase64(o.stored);
    if (decoded === null) return "PAYLOAD_ENCODING_INVALID";
    // Canonical choice: base64 only for bytes that are not valid UTF-8.
    if (isValidUtf8(decoded)) return "PAYLOAD_ENCODING_INVALID";
  } else {
    if (!isWellFormedText(o.stored)) return "PAYLOAD_ENCODING_INVALID";
    decoded = Buffer.from(o.stored, "utf8");
  }
  if (decoded.length !== o.storedBytes) return "PAYLOAD_SIZE_MISMATCH";
  if (sha256(decoded) !== o.storedSha256) return "PAYLOAD_DIGEST_MISMATCH";
  if (o.payloadRedacted) {
    if (o.storedSha256 === o.originalSha256) return "PAYLOAD_REDACTION_INCONSISTENT";
    if (o.redactions === 0 && !o.partialFragmentRedacted) return "PAYLOAD_REDACTION_INCONSISTENT";
  } else if (
    o.storedBytes !== o.originalBytes ||
    o.storedSha256 !== o.originalSha256 ||
    o.redactions !== 0 ||
    o.partialFragmentRedacted
  ) {
    return "PAYLOAD_REDACTION_INCONSISTENT";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Structural rules shared by sealing (on the snapshot copy) and verification (on sealed files)
// ---------------------------------------------------------------------------------------------

/** Component sections, in the recorder snapshot's naming. */
const SECTION_NAMES = [
  "report",
  "ownerLateEvents",
  "wrapperDiagnostics",
  "collectorEpochReport",
  "collectorFrameRecords",
  "collectorNotifications",
  "collectorCounters",
  "ledgerRecords",
  "ledgerEpochs",
  "ledgerCounters",
  "sessionLedgerWindow",
  "sessionLedgerEndLength",
  "fanOutDiagnostics",
] as const;
type SectionName = (typeof SECTION_NAMES)[number];

const RETENTION_COUNTS = [
  "frameRecordsRetained",
  "frameRecordsDropped",
  "notificationRecordsRetained",
  "notificationRecordsDropped",
] as const;
const metadataRetentionOk = (mr: unknown): boolean =>
  isRec(mr) && RETENTION_COUNTS.every((k) => isInt(mr[k])) && typeof mr.complete === "boolean";
const arrayOfRecords = (v: unknown): boolean => Array.isArray(v) && v.every(isRec);

/** The value shape each READ section must have (structure only; no component replay). */
const SECTION_VALUE_OK: Readonly<Record<SectionName, (v: unknown) => boolean>> = {
  report: isRec,
  ownerLateEvents: (v) => isRec(v) && Object.values(v).every(isInt),
  wrapperDiagnostics: isRec,
  collectorEpochReport: (v) => v === null || (isRec(v) && metadataRetentionOk(v.metadataRetention)),
  collectorFrameRecords: arrayOfRecords,
  collectorNotifications: arrayOfRecords,
  collectorCounters: (v) =>
    isRec(v) &&
    isInt(v.frames) &&
    isInt(v.notificationsAccepted) &&
    typeof v.saturated === "boolean" &&
    metadataRetentionOk(v.metadataRetention),
  ledgerRecords: arrayOfRecords,
  ledgerEpochs: arrayOfRecords,
  ledgerCounters: isRec,
  sessionLedgerWindow: (v) =>
    arrayOfRecords(v) && (v as unknown[]).every((e) => isInt(get(e, "seq"))),
  sessionLedgerEndLength: isInt,
  fanOutDiagnostics: (v) =>
    isRec(v) && isInt(v.failures) && typeof v.instrumentationComplete === "boolean",
};

/** `READ` with a well-formed value, `NOT_SUPPLIED`, or `READ_FAILED` with a fixed code. */
function sectionProblem(name: SectionName, s: unknown): string | null {
  const status = get(s, "status");
  const ok =
    status === "READ"
      ? sameKeys(s, ["status", "value"]) && SECTION_VALUE_OK[name](get(s, "value"))
      : status === "NOT_SUPPLIED"
        ? sameKeys(s, ["status"])
        : status === "READ_FAILED" &&
          sameKeys(s, ["status", "code"]) &&
          typeof get(s, "code") === "string" &&
          FIXED_CODE.test(get(s, "code") as string);
  return ok ? null : `COMPONENT_SECTION_MALFORMED:${name}`;
}

const readValue = (s: unknown): unknown =>
  get(s, "status") === "READ" ? get(s, "value") : undefined;

/**
 * Collector retention is consistent: the retained counts equal the arrays actually kept, every
 * frame and accepted notification is either retained or dropped (unless saturated), the per-epoch
 * counts never exceed the collector's, and no `complete` flag contradicts its own drop counts.
 */
function collectorProblems(sections: Readonly<Record<SectionName, unknown>>): string[] {
  const problems: string[] = [];
  const counters = readValue(sections.collectorCounters) as Record<string, unknown> | undefined;
  const epoch = readValue(sections.collectorEpochReport) as
    | Record<string, unknown>
    | null
    | undefined;
  const contradicts = (mr: Record<string, unknown>) =>
    mr.complete !== (mr.frameRecordsDropped === 0 && mr.notificationRecordsDropped === 0);
  if (counters !== undefined) {
    const mr = counters.metadataRetention as Record<string, number>;
    if (contradicts(mr)) problems.push("COLLECTOR_RETENTION_CONTRADICTORY:counters");
    const frames = readValue(sections.collectorFrameRecords) as unknown[] | undefined;
    if (frames !== undefined && frames.length !== mr.frameRecordsRetained) {
      problems.push("COLLECTOR_FRAME_RECORDS_INCONSISTENT");
    }
    const notifications = readValue(sections.collectorNotifications) as unknown[] | undefined;
    if (notifications !== undefined && notifications.length !== mr.notificationRecordsRetained) {
      problems.push("COLLECTOR_NOTIFICATIONS_INCONSISTENT");
    }
    if (counters.saturated === false) {
      if (counters.frames !== mr.frameRecordsRetained! + mr.frameRecordsDropped!) {
        problems.push("COLLECTOR_FRAME_COUNT_INCONSISTENT");
      }
      if (
        counters.notificationsAccepted !==
        mr.notificationRecordsRetained! + mr.notificationRecordsDropped!
      ) {
        problems.push("COLLECTOR_NOTIFICATION_COUNT_INCONSISTENT");
      }
    }
  }
  if (epoch !== undefined && epoch !== null) {
    const emr = epoch.metadataRetention as Record<string, number>;
    if (contradicts(emr)) problems.push("COLLECTOR_RETENTION_CONTRADICTORY:epochReport");
    if (counters !== undefined) {
      const mr = counters.metadataRetention as Record<string, number>;
      if (RETENTION_COUNTS.some((k) => emr[k]! > mr[k]!)) {
        problems.push("COLLECTOR_RETENTION_INCONSISTENT");
      }
    }
  }
  return problems;
}

const EVENTS_WITH_PAYLOAD: ReadonlySet<unknown> = new Set(["message", "ping", "pong"]);
const EVENTS_WITHOUT_PAYLOAD: ReadonlySet<unknown> = new Set(["open", "error", "close"]);
const CALLS_WITH_PAYLOAD: ReadonlySet<unknown> = new Set(["send", "ping", "pong"]);
const CALLS_WITHOUT_PAYLOAD: ReadonlySet<unknown> = new Set([
  "start",
  "close",
  "terminate",
  "dispose",
]);

/** The category a transport record belongs in, or null for an unknown kind. */
function expectedCategory(r: Record<string, unknown>): string | null {
  const control = (v: unknown) => v === "ping" || v === "pong";
  switch (r.kind) {
    case "EVENT":
      if (r.event === "message") return "incoming";
      if (control(r.event)) return "control";
      return EVENTS_WITHOUT_PAYLOAD.has(r.event) ? "lifecycle" : null;
    case "CALL":
      if (r.method === "send") return "outgoing";
      if (control(r.method)) return "control";
      return CALLS_WITHOUT_PAYLOAD.has(r.method) ? "lifecycle" : null;
    case "COMPLETION":
      if (r.method === "send") return "outgoing";
      return control(r.method) ? "control" : null;
    case "READY_STATE":
    case "REGISTER":
    case "UNREGISTER":
      return "lifecycle";
    default:
      return null;
  }
}

/**
 * Payload presence by record kind: message, ping and pong events and send, ping and pong calls
 * carry a payload object; other events and calls carry an explicit null; other kinds carry none.
 */
function recordProblem(category: unknown, r: unknown): string | null {
  if (!isRec(r)) return "TRANSPORT_RECORD_MALFORMED";
  const expected = expectedCategory(r);
  if (expected === null) return "TRANSPORT_RECORD_KIND_INVALID";
  if (category !== expected) return "TRANSPORT_RECORD_CATEGORY_INVALID";
  const hasKey = Object.prototype.hasOwnProperty.call(r, "payload");
  if (r.kind !== "EVENT" && r.kind !== "CALL") {
    return hasKey ? "TRANSPORT_RECORD_PAYLOAD_UNEXPECTED" : null;
  }
  const carries =
    r.kind === "EVENT" ? EVENTS_WITH_PAYLOAD.has(r.event) : CALLS_WITH_PAYLOAD.has(r.method);
  if (!hasKey) return "TRANSPORT_RECORD_PAYLOAD_MISSING";
  if (carries && !isRec(r.payload)) return "TRANSPORT_RECORD_PAYLOAD_MISSING";
  if (!carries && r.payload !== null) return "TRANSPORT_RECORD_PAYLOAD_UNEXPECTED";
  return null;
}

interface ExchangeView {
  readonly method: unknown;
  readonly requestBody: unknown;
  readonly bodyState: unknown;
  readonly body: unknown;
  readonly bodyComplete: unknown;
  readonly observedBodyBytes: unknown;
  readonly maxResponseBytes: unknown;
}

/**
 * The session's body rules (`PaperRequestSession` over the accepted `readBoundedStream`):
 * - a POST carries a request body (a GET none); `bodyComplete` is true exactly for COMPLETE;
 * - the limit is a positive safe integer (the session refuses any other);
 * - COMPLETE: every observed byte was retained, so the observed size equals the original body
 *   length and is within the limit;
 * - PARTIAL_OVERFLOW: reading stops at the first chunk that takes the observed size beyond the
 *   limit, having retained exactly the limit, so the observed size exceeds the limit and a known
 *   original prefix length equals it;
 * - NOT_READ: neither a body nor an observed size.
 * Lengths are the original byte counts, independent of any redaction of the stored bytes.
 */
function exchangeProblem(x: ExchangeView, originalBytesOf: (p: unknown) => unknown): string | null {
  if (x.method !== "GET" && x.method !== "POST") return "EXCHANGE_METHOD_INVALID";
  if (x.requestBody !== null && !isRec(x.requestBody)) return "EXCHANGE_REQUEST_BODY_INCONSISTENT";
  if ((x.method === "POST") !== isRec(x.requestBody)) return "EXCHANGE_REQUEST_BODY_INCONSISTENT";
  if (
    x.bodyState !== "COMPLETE" &&
    x.bodyState !== "PARTIAL_OVERFLOW" &&
    x.bodyState !== "NOT_READ"
  ) {
    return "EXCHANGE_BODY_STATE_INVALID";
  }
  if (x.bodyComplete !== (x.bodyState === "COMPLETE"))
    return "EXCHANGE_BODY_COMPLETENESS_INCONSISTENT";
  if (!isInt(x.maxResponseBytes) || x.maxResponseBytes < 1) return "EXCHANGE_LIMIT_INVALID";
  if (x.bodyState === "NOT_READ") {
    return x.body === null && x.observedBodyBytes === null ? null : "EXCHANGE_BODY_INCONSISTENT";
  }
  if (!isRec(x.body)) return "EXCHANGE_BODY_MISSING";
  if (!isInt(x.observedBodyBytes)) return "EXCHANGE_BODY_INCONSISTENT";
  const limit = x.maxResponseBytes;
  const observed = x.observedBodyBytes;
  const original = originalBytesOf(x.body);
  if (x.bodyState === "COMPLETE") {
    if (observed > limit) return "EXCHANGE_BODY_EXCEEDS_LIMIT";
    if (isInt(original) && observed !== original) return "EXCHANGE_BODY_INCONSISTENT";
  } else {
    if (observed <= limit) return "EXCHANGE_OVERFLOW_WITHIN_LIMIT";
    if (isInt(original) && original !== limit) return "EXCHANGE_PREFIX_LENGTH_INCONSISTENT";
  }
  return null;
}

const RETENTION_CATEGORIES = [
  "incoming",
  "outgoing",
  "control",
  "lifecycle",
  "exchanges",
  "ledgerCalls",
] as const;
const CATEGORY_STAT_KEYS = [
  "observed",
  "retained",
  "dropped",
  "payloadsOmitted",
  "retainedPayloadBytes",
];
const PENDING_KEYS = [
  "ownerRegistrationsLive",
  "dispatchesAwaitingOwnerDelivery",
  "transportCallsInProgress",
  "completionsAwaitingFirstCall",
  "accountCallsInProgress",
  "accountSettlementsPending",
];

/**
 * The recorder's own accounting: exact pending-work counters; per-category counts that add up
 * (`observed = retained + dropped`) and match the records actually present; instrumentation
 * counts that add up; and recorded completeness flags that do not contradict their own counts.
 */
function recordingProblems(
  rec: Record<string, unknown>,
  actual: Readonly<Record<string, number>>,
  ledgerCalls: unknown,
): string[] {
  const problems: string[] = [];
  const pending = rec.pending;
  const awaiting = get(pending, "completionsAwaitingFirstCall");
  if (
    !sameKeys(pending, PENDING_KEYS) ||
    !sameKeys(awaiting, ["send", "ping", "pong"]) ||
    !Object.values(awaiting as object).every(isInt) ||
    !PENDING_KEYS.every((k) => k === "completionsAwaitingFirstCall" || isInt(get(pending, k)))
  ) {
    problems.push("RECORDING_PENDING_MALFORMED");
  }
  const retention = rec.retention;
  if (!sameKeys(retention, [...RETENTION_CATEGORIES, "recorderRetentionComplete"])) {
    problems.push("RECORDING_RETENTION_MALFORMED");
  } else {
    let lossless = true;
    for (const c of RETENTION_CATEGORIES) {
      const stats = get(retention, c);
      if (
        !sameKeys(stats, CATEGORY_STAT_KEYS) ||
        !CATEGORY_STAT_KEYS.every((k) => isInt(get(stats, k)))
      ) {
        problems.push(`RECORDING_RETENTION_MALFORMED:${c}`);
        continue;
      }
      const s = stats as Record<string, number>;
      if (s.observed !== s.retained! + s.dropped! || s.retained !== actual[c]) {
        problems.push(`RECORD_COUNT_INCONSISTENT:${c}`);
      }
      if (s.dropped !== 0 || s.payloadsOmitted !== 0) lossless = false;
    }
    const droppedFailures = get(rec, "instrumentation", "droppedFailureRecords");
    if (droppedFailures !== 0) lossless = false;
    if (get(retention, "recorderRetentionComplete") !== lossless) {
      problems.push("RECORDING_RETENTION_CONTRADICTORY");
    }
  }
  const ins = rec.instrumentation;
  const failures = get(ins, "failures");
  const retained = get(ins, "retainedFailures");
  const dropped = get(ins, "droppedFailureRecords");
  if (
    !sameKeys(ins, ["complete", "failures", "retainedFailures", "droppedFailureRecords"]) ||
    !isInt(failures) ||
    !isInt(dropped) ||
    !arrayOfRecords(retained) ||
    get(ins, "complete") !== (failures === 0) ||
    (retained as unknown[]).length + dropped !== failures
  ) {
    problems.push("RECORDING_INSTRUMENTATION_INCONSISTENT");
  }
  if (typeof rec.transportRecorded !== "boolean" || typeof rec.ledgerRecorded !== "boolean") {
    problems.push("RECORDING_SCOPE_MALFORMED");
  }
  if (!isInt(rec.ordinalsAssigned)) problems.push("RECORDING_ORDINALS_MALFORMED");
  if (
    !arrayOfRecords(ledgerCalls) ||
    !(ledgerCalls as unknown[]).every(
      (c) => get(c, "kind") === "ACCOUNT_CALL" || get(c, "kind") === "ACCOUNT_SETTLEMENT",
    )
  ) {
    problems.push("LEDGER_CALLS_MALFORMED");
  }
  return problems;
}

interface StructureView {
  readonly records: readonly { readonly category: unknown; readonly record: unknown }[];
  readonly exchanges: readonly ExchangeView[];
  readonly originalBytesOf: (p: unknown) => unknown;
  readonly sections: Readonly<Record<SectionName, unknown>>;
  readonly recording: Record<string, unknown>;
  readonly ledgerCalls: unknown;
}

/** Every structural rule; an empty list means the structure is well formed and consistent. */
function structureProblems(v: StructureView): string[] {
  const problems: string[] = [];
  const actual: Record<string, number> = {
    incoming: 0,
    outgoing: 0,
    control: 0,
    lifecycle: 0,
    exchanges: v.exchanges.length,
    ledgerCalls: Array.isArray(v.ledgerCalls) ? v.ledgerCalls.length : -1,
  };
  for (const { category, record } of v.records) {
    const p = recordProblem(category, record);
    if (p !== null) problems.push(p);
    if (typeof category === "string" && category in actual) actual[category]!++;
  }
  for (const x of v.exchanges) {
    const p = exchangeProblem(x, v.originalBytesOf);
    if (p !== null) problems.push(p);
  }
  const sectionIssues = SECTION_NAMES.map((n) => sectionProblem(n, v.sections[n])).filter(
    (p): p is string => p !== null,
  );
  problems.push(...sectionIssues);
  if (sectionIssues.length === 0) problems.push(...collectorProblems(v.sections));
  problems.push(...recordingProblems(v.recording, actual, v.ledgerCalls));
  return [...new Set(problems)];
}

/** Fail-closed, read-only verification of one sealed run directory. */
export function verifyCpmmObservationEvidence(
  outDir: string,
  options?: CpmmEvidenceVerificationOptions,
): CpmmEvidenceVerification {
  const credentials = readAnalysisCredentials(options);
  const problems: string[] = [];
  let manifestSha256: string | null = null;
  const result = (
    retention: CpmmEvidenceVerification["retention"],
    poolContextProvenance: CpmmEvidenceVerification["poolContextProvenance"],
    rederivation: CpmmRederivation = NOT_ATTEMPTED,
    sealedClaims: CpmmEvidenceVerification["sealedClaims"] = null,
    acquisitionBinding?: CpmmAcquisitionBinding,
  ): CpmmEvidenceVerification =>
    deepFreezeOwn({
      outDir,
      manifestSha256,
      integrity: { ok: problems.length === 0, problems: [...problems] },
      retention: { status: retention.status, reasons: [...retention.reasons] },
      rederivation,
      sealedClaims,
      poolContextProvenance,
      acquisitionProvenance: poolContextProvenance === ACQUIRED_BOUND ? ACQUIRED_BOUND : "OPEN_G3",
      ...(acquisitionBinding === undefined ? {} : { acquisitionBinding }),
      flags: CPMM_EVIDENCE_FALSE_FLAGS,
    });
  const integrityFailure = () => result({ status: "NOT_EVALUATED", reasons: [] }, null);

  // 1. The directory and the manifest (size checked before reading).
  if (typeof outDir !== "string" || !path.isAbsolute(outDir)) {
    problems.push("OUTPUT_DIRECTORY_INVALID");
    return integrityFailure();
  }
  try {
    const st = lstatSync(outDir);
    if (st.isSymbolicLink() || !st.isDirectory()) problems.push("OUTPUT_DIRECTORY_INVALID");
  } catch {
    problems.push("OUTPUT_DIRECTORY_MISSING");
  }
  if (problems.length > 0) return integrityFailure();
  const manifestBytes = readBounded(outDir, CPMM_EVIDENCE_FILES.manifest, VL.maxManifestBytes);
  if (typeof manifestBytes === "string") {
    problems.push(
      manifestBytes.startsWith("MISSING_FILE")
        ? "MANIFEST_MISSING"
        : manifestBytes.startsWith("FILE_TOO_LARGE")
          ? "MANIFEST_TOO_LARGE"
          : `MANIFEST_${manifestBytes.split(":")[0]}`,
    );
    return integrityFailure();
  }
  manifestSha256 = sha256(manifestBytes);
  const manifest = parseStrict(manifestBytes);
  if (
    !sameKeys(manifest, ["kind", "version", "evidenceSchemaVersion", "componentVersions", "files"])
  ) {
    problems.push("MANIFEST_SCHEMA_INVALID");
    return integrityFailure();
  }
  const m = manifest as Record<string, unknown>;
  if (m.kind !== CPMM_EVIDENCE_MANIFEST_KIND) problems.push("MANIFEST_KIND_INVALID");
  if (m.version !== CPMM_EVIDENCE_MANIFEST_VERSION) problems.push("MANIFEST_VERSION_UNSUPPORTED");
  const schemaVersion = m.evidenceSchemaVersion;
  // Unknown schemas are refused; a known one fixes the binding and the request policy.
  const policy = schemaPolicy(schemaVersion);
  if (policy === null) problems.push("EVIDENCE_SCHEMA_VERSION_UNSUPPORTED");
  if (
    !sameKeys(m.componentVersions, CPMM_COMPONENT_VERSION_KEYS) ||
    !Object.values(m.componentVersions as object).every(
      (v) => typeof v === "string" && COMMIT.test(v),
    )
  ) {
    problems.push("MANIFEST_COMPONENT_VERSIONS_INVALID");
  }
  if (!Array.isArray(m.files) || m.files.length > VL.maxEntries) {
    problems.push("MANIFEST_FILES_INVALID");
    return integrityFailure();
  }
  if (problems.length > 0 || policy === null) return integrityFailure();
  const evidenceVersion = schemaVersion as EvidenceSchemaVersion;

  // 2. Entries: schema, confined unique sorted paths, bounded sizes, required files.
  const listed = new Map<string, { bytes: number; sha256: string }>();
  let total = 0;
  let previous = "";
  for (const e of m.files as unknown[]) {
    if (
      !sameKeys(e, ["path", "bytes", "sha256"]) ||
      typeof get(e, "path") !== "string" ||
      !isInt(get(e, "bytes")) ||
      typeof get(e, "sha256") !== "string" ||
      !HEX64.test(get(e, "sha256") as string)
    ) {
      problems.push("MANIFEST_ENTRY_MALFORMED");
      continue;
    }
    const p = get(e, "path") as string;
    const bytes = get(e, "bytes") as number;
    const known = CPMM_EVIDENCE_REQUIRED_FILES.includes(p) || EXCHANGE_FILE.test(p);
    if (!known) {
      problems.push(
        path.isAbsolute(p) || p.split(/[\\/]/).includes("..")
          ? "MANIFEST_PATH_NOT_CONFINED"
          : `MANIFEST_PATH_UNKNOWN:${safeName(p)}`,
      );
      continue;
    }
    if (listed.has(p)) {
      problems.push(`MANIFEST_PATH_DUPLICATE:${p}`);
      continue;
    }
    if (p <= previous) problems.push("MANIFEST_NOT_SORTED");
    previous = p;
    if (bytes > VL.maxFileBytes) problems.push(`MANIFEST_FILE_TOO_LARGE:${p}`);
    total += bytes;
    listed.set(p, { bytes, sha256: get(e, "sha256") as string });
  }
  if (total > VL.maxTotalBytes) problems.push("MANIFEST_TOTAL_TOO_LARGE");
  for (const f of CPMM_EVIDENCE_REQUIRED_FILES) {
    if (!listed.has(f)) problems.push(`REQUIRED_FILE_NOT_LISTED:${f}`);
  }
  if (problems.length > 0) return integrityFailure();

  // 3. The directory tree: no link, special file, unknown directory or unlisted file.
  const found = walk(outDir, problems);
  for (const f of found) {
    if (f !== CPMM_EVIDENCE_FILES.manifest && !listed.has(f)) {
      problems.push(`UNLISTED_FILE:${safeName(f)}`);
    }
  }
  if (problems.length > 0) return integrityFailure();

  // 4. Every listed file: confined regular file, size, digest, strict UTF-8 JSON.
  const docs = new Map<string, Record<string, unknown>>();
  for (const [p, entry] of listed) {
    const b = readBounded(outDir, p, Math.min(entry.bytes, VL.maxFileBytes));
    if (typeof b === "string") {
      problems.push(b.startsWith("FILE_TOO_LARGE") ? `SIZE_MISMATCH:${p}` : b);
      continue;
    }
    if (b.length !== entry.bytes) problems.push(`SIZE_MISMATCH:${p}`);
    else if (sha256(b) !== entry.sha256) problems.push(`HASH_MISMATCH:${p}`);
    else {
      const doc = parseStrict(b);
      if (!isRec(doc)) problems.push(`FILE_NOT_JSON:${p}`);
      else if (!depthWithin(doc, VL.maxDocumentDepth)) problems.push(`FILE_TOO_DEEP:${p}`);
      else docs.set(p, doc);
    }
  }
  if (problems.length > 0) return integrityFailure();

  try {
    checkDocuments(docs, listed, problems, evidenceVersion);
  } catch {
    problems.push("EVIDENCE_STRUCTURE_INVALID");
  }
  if (problems.length > 0) return integrityFailure();

  // 5. Retention, derived from the evidence alone.
  let reasons: string[];
  try {
    reasons = deriveRetention(docs);
  } catch {
    reasons = ["RETENTION_UNDETERMINABLE"];
  }
  // 6. Re-derivation (item G, partial), only now that integrity holds, over the same parsed and
  //    bounded documents; nothing is read again. The claims copied below were validated, and every
  //    document's depth bounded, by the integrity checks; nothing may escape as an exception.
  try {
    const report = docs.get(CPMM_EVIDENCE_FILES.report)!;
    const claims = {
      rederivation: copyJson(report.rederivation),
      poolContextProvenance: report.poolContextProvenance,
      acquisitionProvenance: report.acquisitionProvenance,
      runOutcome: copyJson(report.runOutcome),
    };
    const ctx = docs.get(CPMM_EVIDENCE_FILES.poolContext)!;
    // Every acquisition-bound schema (2 and 3) verifies its dependency; none falls through to
    // the supplied/unverified handling of schema 1.
    const acquisitionBinding = policy.acquisitionBound
      ? checkAcquisitionBinding(
          ctx,
          get(docs.get(CPMM_EVIDENCE_FILES.plan), "plan", "binding"),
          acquisitionDirectory(options),
          ctx.acquisitionManifestSha256 as string,
        )
      : undefined;
    return result(
      { status: reasons.length === 0 ? "COMPLETE" : "INCOMPLETE", reasons },
      acquisitionBinding === undefined
        ? "SUPPLIED_UNVERIFIED"
        : acquisitionBinding.status === "REPRODUCED"
          ? ACQUIRED_BOUND
          : null,
      rederive(docs, credentials, policy.maxSupportedTransactionVersion),
      claims,
      acquisitionBinding,
    );
  } catch {
    problems.push("EVIDENCE_STRUCTURE_INVALID");
    return integrityFailure();
  }
}

/** Iterative (no recursion): true when no array or object nests deeper than `max`. */
function depthWithin(root: unknown, max: number): boolean {
  const work: { v: unknown; d: number }[] = [{ v: root, d: 0 }];
  while (work.length > 0) {
    const { v, d } = work.pop()!;
    if (typeof v !== "object" || v === null) continue;
    if (d >= max) return false;
    for (const x of Array.isArray(v) ? v : Object.values(v)) work.push({ v: x, d: d + 1 });
  }
  return true;
}

/** The sealer's run outcome: a flat terminal record, a cleanup status and the clean flag. */
function runOutcomeOk(o: unknown): boolean {
  if (!sameKeys(o, ["terminal", "cleanupStatus", "connectionRunClean"])) return false;
  const t = get(o, "terminal");
  const flat =
    t === null ||
    (isRec(t) &&
      Object.keys(t).length <= 16 &&
      Object.values(t).every(
        (x) => x === null || ["string", "number", "boolean"].includes(typeof x),
      ));
  const cleanup = get(o, "cleanupStatus");
  const clean = get(o, "connectionRunClean");
  return (
    flat &&
    (cleanup === null || typeof cleanup === "string") &&
    (clean === null || typeof clean === "boolean")
  );
}

/** Schema, report references, payloads and the exchange index against the session ledger. */
function checkDocuments(
  docs: Map<string, Record<string, unknown>>,
  listed: Map<string, { bytes: number; sha256: string }>,
  problems: string[],
  schemaVersion: EvidenceSchemaVersion,
): void {
  const policy = CPMM_EVIDENCE_SCHEMA_POLICIES[schemaVersion];
  // Kinds and versions.
  for (const [p, doc] of docs) {
    const kind = EXCHANGE_FILE.test(p) ? EXCHANGE_FILE_KIND : FILE_KINDS[p];
    if (doc.kind !== kind) problems.push(`FILE_KIND_INVALID:${p}`);
    const version =
      p === CPMM_EVIDENCE_FILES.poolContext || p === CPMM_EVIDENCE_FILES.report
        ? schemaVersion
        : CPMM_EVIDENCE_SCHEMA_VERSION;
    if (doc.version !== version) problems.push(`FILE_VERSION_UNSUPPORTED:${p}`);
  }
  if (problems.length > 0) return;

  // The report: every other file by path and digest, fixed claims.
  const report = docs.get(CPMM_EVIDENCE_FILES.report)!;
  const refs = report.files;
  const expected = [...listed.entries()]
    .filter(([p]) => p !== CPMM_EVIDENCE_FILES.report)
    .map(([p, e]) => ({ path: p, bytes: e.bytes, sha256: e.sha256 }));
  if (!Array.isArray(refs) || !deepEqual(refs, expected))
    problems.push("REPORT_REFERENCES_MISMATCH");
  for (const [k, v] of Object.entries(CPMM_EVIDENCE_FALSE_FLAGS)) {
    if (report[k] !== v) problems.push(`REPORT_FLAG_INVALID:${k}`);
  }
  if (get(report, "rederivation", "status") !== "NOT_IMPLEMENTED") {
    problems.push("REPORT_REDERIVATION_CLAIM_INVALID");
  }
  if (!sameKeys(report.rederivation, ["status"]))
    problems.push("REPORT_REDERIVATION_CLAIM_INVALID");
  const bound = policy.acquisitionBound;
  const provenance = bound ? ACQUIRED_BOUND : "SUPPLIED_UNVERIFIED";
  if (report.acquisitionProvenance !== (bound ? ACQUIRED_BOUND : "OPEN_G3"))
    problems.push("REPORT_ACQUISITION_PROVENANCE_INVALID");
  if (!runOutcomeOk(report.runOutcome)) problems.push("REPORT_RUN_OUTCOME_MALFORMED");
  if (report.poolContextProvenance !== provenance) {
    problems.push("REPORT_POOL_PROVENANCE_INVALID");
  }
  const ctx = docs.get(CPMM_EVIDENCE_FILES.poolContext)!;
  if (ctx.acquisition !== provenance) {
    problems.push("POOL_CONTEXT_PROVENANCE_INVALID");
  }
  if (
    bound
      ? !sameKeys(ctx, [
          "kind",
          "version",
          "target",
          "accounts",
          "adaptedPool",
          "acquisition",
          "acquisitionManifestSha256",
        ]) ||
        !sameKeys(
          ctx.accounts,
          BINDING_POSITIONS.map(([name]) => name),
        ) ||
        typeof ctx.acquisitionManifestSha256 !== "string" ||
        !HEX64.test(ctx.acquisitionManifestSha256)
      : Object.hasOwn(ctx, "acquisitionManifestSha256")
  ) {
    problems.push("POOL_CONTEXT_ACQUISITION_REFERENCE_INVALID");
  }
  // The request policy: schema 3's plan and report state the v1-capable policy exactly; schemas
  // 1 and 2 state none (their cap of 0 is implied by the schema). The manifest's schema decides;
  // a disagreeing record is a contradiction, never a reason to switch policy.
  const planBody = get(docs.get(CPMM_EVIDENCE_FILES.plan), "plan");
  const policyRecordOk = (owner: unknown): boolean => {
    if (!isRec(owner)) return false;
    const has = Object.prototype.hasOwnProperty.call(owner, "transactionRequest");
    if (policy.maxSupportedTransactionVersion === 0) return !has;
    const r = owner.transactionRequest;
    return (
      has &&
      sameKeys(r, Object.keys(CPMM_V1_CAPABLE_TRANSACTION_REQUEST)) &&
      get(r, "maxSupportedTransactionVersion") === policy.maxSupportedTransactionVersion
    );
  };
  if (!policyRecordOk(planBody)) problems.push("PLAN_TRANSACTION_REQUEST_POLICY_INVALID");
  if (!policyRecordOk(report)) problems.push("REPORT_TRANSACTION_REQUEST_POLICY_INVALID");

  // Structure: payload presence, component sections, recorder and collector accounting.
  const recordsValue = get(docs.get(CPMM_EVIDENCE_FILES.transportRecords), "records");
  const exchangeDocs = [...listed.keys()]
    .filter((p) => EXCHANGE_FILE.test(p))
    .map((p) => docs.get(p)!);
  const doc = (f: string, ...keys: string[]) => get(docs.get(f), ...keys);
  problems.push(
    ...structureProblems({
      records: Array.isArray(recordsValue)
        ? recordsValue.map((record) => ({ category: get(record, "category"), record }))
        : [{ category: null, record: null }],
      exchanges: exchangeDocs.map((x) => ({
        method: x.method,
        requestBody: x.requestBody,
        bodyState: x.bodyState,
        body: x.body,
        bodyComplete: get(x, "entry", "bodyComplete"),
        observedBodyBytes: x.observedBodyBytes,
        maxResponseBytes: x.maxResponseBytes,
      })),
      originalBytesOf: (p) => get(p, "originalBytes"),
      sections: {
        report: doc(CPMM_EVIDENCE_FILES.ownerReport, "report"),
        ownerLateEvents: doc(CPMM_EVIDENCE_FILES.ownerReport, "lateEvents"),
        wrapperDiagnostics: doc(CPMM_EVIDENCE_FILES.transportDiagnostics, "diagnostics"),
        collectorEpochReport: doc(CPMM_EVIDENCE_FILES.collector, "epochReport"),
        collectorFrameRecords: doc(CPMM_EVIDENCE_FILES.collector, "frameRecords"),
        collectorNotifications: doc(CPMM_EVIDENCE_FILES.collector, "notifications"),
        collectorCounters: doc(CPMM_EVIDENCE_FILES.collector, "counters"),
        ledgerRecords: doc(CPMM_EVIDENCE_FILES.ledger, "records"),
        ledgerEpochs: doc(CPMM_EVIDENCE_FILES.ledger, "epochs"),
        ledgerCounters: doc(CPMM_EVIDENCE_FILES.ledger, "counters"),
        sessionLedgerWindow: doc(CPMM_EVIDENCE_FILES.sessionLedger, "window"),
        sessionLedgerEndLength: doc(CPMM_EVIDENCE_FILES.sessionLedger, "endLength"),
        fanOutDiagnostics: doc(CPMM_EVIDENCE_FILES.recording, "fanOut"),
      },
      recording: docs.get(CPMM_EVIDENCE_FILES.recording)!,
      ledgerCalls: doc(CPMM_EVIDENCE_FILES.ledger, "calls"),
    }),
  );
  const start = doc(CPMM_EVIDENCE_FILES.sessionLedger, "start");
  if (start !== null && !isInt(start)) problems.push("SESSION_LEDGER_START_MALFORMED");
  if (problems.length > 0) return;

  // Payloads: transport records (in ordinal order), pool accounts, exchanges.
  const check = (p: unknown, where: string) => {
    if (p === null) return;
    const problem = payloadProblem(p);
    if (problem !== null) problems.push(`${problem}:${where}`);
  };
  const records = get(docs.get(CPMM_EVIDENCE_FILES.transportRecords), "records");
  if (!Array.isArray(records)) problems.push("TRANSPORT_RECORDS_INVALID");
  else {
    let last = 0;
    for (const r of records) {
      const ordinal = get(r, "ordinal");
      if (!isInt(ordinal) || ordinal <= last) {
        problems.push("TRANSPORT_RECORDS_NOT_IN_ORDINAL_ORDER");
        break;
      }
      last = ordinal;
      if (isRec(r) && "payload" in r)
        check(r.payload, `${CPMM_EVIDENCE_FILES.transportRecords}#${ordinal}`);
    }
  }
  for (const a of ["pool", "vault0", "vault1"]) {
    const data = get(docs.get(CPMM_EVIDENCE_FILES.poolContext), "accounts", a, "data");
    if (data === null || data === undefined) problems.push(`POOL_ACCOUNT_DATA_MISSING:${a}`);
    else check(data, `${CPMM_EVIDENCE_FILES.poolContext}#${a}`);
  }

  // The exchange index, the exchange files and the session-ledger window.
  const index = get(docs.get(CPMM_EVIDENCE_FILES.exchangeIndex), "exchanges");
  const exchangeFiles = [...listed.keys()].filter((p) => EXCHANGE_FILE.test(p));
  if (!Array.isArray(index)) {
    problems.push("EXCHANGE_INDEX_INVALID");
    return;
  }
  const indexed = new Set<string>();
  let lastSeq = -1;
  for (const x of index) {
    const seq = get(x, "seq");
    const p = get(x, "path");
    if (
      !sameKeys(x, ["seq", "path", "ordinal"]) ||
      !isInt(seq) ||
      seq <= lastSeq ||
      p !== exchangePath(seq)
    ) {
      problems.push("EXCHANGE_INDEX_INVALID");
      return;
    }
    lastSeq = seq;
    indexed.add(p as string);
    const ex = docs.get(p as string);
    if (ex === undefined) {
      problems.push(`EXCHANGE_FILE_NOT_LISTED:${p as string}`);
      continue;
    }
    if (get(ex, "entry", "seq") !== seq || get(ex, "ordinal") !== get(x, "ordinal")) {
      problems.push(`EXCHANGE_INDEX_MISMATCH:${p as string}`);
    }
    if (ex.endpoint !== CPMM_EXCHANGE_ENDPOINT_LABEL)
      problems.push(`EXCHANGE_ENDPOINT_INVALID:${p as string}`);
    check(ex.requestBody, `${p as string}#requestBody`);
    check(ex.body, `${p as string}#body`);
  }
  for (const p of exchangeFiles) {
    if (!indexed.has(p)) problems.push(`EXCHANGE_FILE_NOT_INDEXED:${p}`);
  }
  const session = docs.get(CPMM_EVIDENCE_FILES.sessionLedger)!;
  const windowEntries =
    get(session, "window", "status") === "READ" ? get(session, "window", "value") : undefined;
  const bySeq = new Map<number, unknown>();
  if (Array.isArray(windowEntries)) {
    for (const e of windowEntries) {
      const seq = get(e, "seq");
      if (!isInt(seq) || bySeq.has(seq)) {
        problems.push("SESSION_LEDGER_WINDOW_INVALID");
        return;
      }
      bySeq.set(seq, e);
    }
  }
  const fields = [
    "lane",
    "owner",
    "purpose",
    "requestedIdentity",
    "jsonRpcId",
    "dispatchedAtMs",
    "completedAtMs",
    "httpStatus",
    "bodyComplete",
  ];
  for (const x of index) {
    const seq = get(x, "seq") as number;
    const p = exchangePath(seq);
    const entry = get(docs.get(p), "entry");
    const w = bySeq.get(seq);
    if (w === undefined) {
      problems.push(`EXCHANGE_NOT_IN_SESSION_LEDGER:${p}`);
      continue;
    }
    const werror = get(w, "error");
    const normalized =
      werror === null
        ? null
        : typeof werror === "string" && FIXED_CODE.test(werror)
          ? werror
          : "UNRECOGNIZED";
    if (
      get(entry, "purpose") !== CPMM_TX_PURPOSE ||
      fields.some((f) => !deepEqual(get(entry, f), get(w, f))) ||
      get(entry, "error") !== normalized
    ) {
      problems.push(`EXCHANGE_SESSION_LEDGER_MISMATCH:${p}`);
    }
  }
}

/** Conservative retention reasons from the sealed evidence (recorded flags are not trusted). */
function deriveRetention(docs: Map<string, Record<string, unknown>>): string[] {
  const reasons = new Set<string>();
  const payload = (p: unknown, file: string) => {
    if (!isRec(p)) return;
    if (p.payloadOmitted !== null) reasons.add(`PAYLOAD_OMITTED:${file}`);
    if (p.withheldReason !== null) reasons.add(`PAYLOAD_WITHHELD:${file}`);
  };
  const recordsDoc = docs.get(CPMM_EVIDENCE_FILES.transportRecords)!;
  const records = recordsDoc.records as unknown[];
  for (const r of records)
    if (isRec(r) && "payload" in r) payload(r.payload, CPMM_EVIDENCE_FILES.transportRecords);
  for (const a of ["pool", "vault0", "vault1"]) {
    payload(
      get(docs.get(CPMM_EVIDENCE_FILES.poolContext), "accounts", a, "data"),
      CPMM_EVIDENCE_FILES.poolContext,
    );
  }
  const index = get(docs.get(CPMM_EVIDENCE_FILES.exchangeIndex), "exchanges") as unknown[];
  for (const x of index) {
    const p = get(x, "path") as string;
    payload(get(docs.get(p), "requestBody"), "exchanges");
    payload(get(docs.get(p), "body"), "exchanges");
  }

  // Exchange bodies the session did not read completely (faithfully recorded, still missing).
  for (const x of index) {
    const state = get(docs.get(get(x, "path") as string), "bodyState");
    if (state === "PARTIAL_OVERFLOW") reasons.add("EXCHANGE_BODY_PARTIAL");
    if (state === "NOT_READ") reasons.add("EXCHANGE_BODY_NOT_READ");
  }

  // Records the recorder dropped (its counts were checked against the records present).
  const recording = docs.get(CPMM_EVIDENCE_FILES.recording)!;
  for (const c of RETENTION_CATEGORIES) {
    if (get(recording, "retention", c, "dropped") !== 0) reasons.add(`RECORDS_DROPPED:${c}`);
  }

  // Instrumentation, recording scope and pending work.
  if (get(recording, "instrumentation", "failures") !== 0) reasons.add("INSTRUMENTATION_FAILURES");
  if (recording.transportRecorded !== true) reasons.add("TRANSPORT_NOT_RECORDED");
  if (recording.ledgerRecorded !== true) reasons.add("LEDGER_NOT_RECORDED");
  const pendingWork = (v: unknown, key: string): void => {
    if (isRec(v)) for (const [k, x] of Object.entries(v)) pendingWork(x, key ? `${key}.${k}` : k);
    else if (v !== 0) reasons.add(`PENDING_WORK:${key}`);
  };
  pendingWork(recording.pending, "");
  const fanOut = recording.fanOut;
  if (get(fanOut, "status") !== "READ") reasons.add("COMPONENT_UNAVAILABLE:fanOutDiagnostics");
  else if (get(fanOut, "value", "failures") !== 0) reasons.add("FAN_OUT_FAILURES");

  // Component reads.
  const sections: [string, unknown][] = [
    ["report", get(docs.get(CPMM_EVIDENCE_FILES.ownerReport), "report")],
    ["ownerLateEvents", get(docs.get(CPMM_EVIDENCE_FILES.ownerReport), "lateEvents")],
    ["wrapperDiagnostics", get(docs.get(CPMM_EVIDENCE_FILES.transportDiagnostics), "diagnostics")],
    ["collectorEpochReport", get(docs.get(CPMM_EVIDENCE_FILES.collector), "epochReport")],
    ["collectorFrameRecords", get(docs.get(CPMM_EVIDENCE_FILES.collector), "frameRecords")],
    ["collectorNotifications", get(docs.get(CPMM_EVIDENCE_FILES.collector), "notifications")],
    ["collectorCounters", get(docs.get(CPMM_EVIDENCE_FILES.collector), "counters")],
    ["ledgerRecords", get(docs.get(CPMM_EVIDENCE_FILES.ledger), "records")],
    ["ledgerEpochs", get(docs.get(CPMM_EVIDENCE_FILES.ledger), "epochs")],
    ["ledgerCounters", get(docs.get(CPMM_EVIDENCE_FILES.ledger), "counters")],
    ["sessionLedgerWindow", get(docs.get(CPMM_EVIDENCE_FILES.sessionLedger), "window")],
    ["sessionLedgerEndLength", get(docs.get(CPMM_EVIDENCE_FILES.sessionLedger), "endLength")],
  ];
  for (const [name, s] of sections) {
    if (get(s, "status") !== "READ") reasons.add(`COMPONENT_UNAVAILABLE:${name}`);
  }
  // Collector retention from its counts (checked against its arrays); never from `complete`.
  const collector = docs.get(CPMM_EVIDENCE_FILES.collector);
  for (const section of ["counters", "epochReport"]) {
    const mr = get(collector, section, "value", "metadataRetention");
    if (!isRec(mr)) continue;
    if (mr.frameRecordsDropped !== 0) reasons.add("COLLECTOR_FRAME_RECORDS_DROPPED");
    if (mr.notificationRecordsDropped !== 0) reasons.add("COLLECTOR_NOTIFICATION_RECORDS_DROPPED");
  }
  if (get(collector, "counters", "value", "saturated") === true) {
    reasons.add("COLLECTOR_COUNTERS_SATURATED");
  }
  if (
    get(collector, "epochReport", "status") === "READ" &&
    get(collector, "epochReport", "value") === null
  ) {
    reasons.add("COLLECTOR_EPOCH_REPORT_MISSING");
  }
  const ledgerRecords = get(docs.get(CPMM_EVIDENCE_FILES.ledger), "records", "value");
  if (
    Array.isArray(ledgerRecords) &&
    ledgerRecords.some((r) => get(r, "duplicateDetailsDropped") !== 0)
  ) {
    reasons.add("LEDGER_DUPLICATE_DETAILS_TRUNCATED");
  }

  // Every CPMM request in the session window has a sealed exchange.
  const windowEntries = get(docs.get(CPMM_EVIDENCE_FILES.sessionLedger), "window", "value");
  if (Array.isArray(windowEntries)) {
    const indexed = new Set(index.map((x) => get(x, "seq")));
    for (const e of windowEntries) {
      if (get(e, "purpose") === CPMM_TX_PURPOSE && !indexed.has(get(e, "seq"))) {
        reasons.add("EXCHANGE_MISSING");
      }
    }
  }
  return [...reasons].sort();
}

// ---------------------------------------------------------------------------------------------
// Re-derivation (item G, partial): pool context and collector replay
// ---------------------------------------------------------------------------------------------

const NOT_ATTEMPTED: CpmmRederivation = Object.freeze({
  status: "NOT_ATTEMPTED" as const,
  implementedComponents: null,
  components: null,
});

/** Best to worst; a component's result is its worst finding. */
const STATUS_RANK: Readonly<Record<CpmmRederivationStatus, number>> = {
  REPRODUCED: 0,
  LIMITED_BY_REDACTION: 1,
  MISSING_EVIDENCE: 2,
  MISMATCH: 3,
};
const worstOf = (a: CpmmRederivationStatus, b: CpmmRederivationStatus): CpmmRederivationStatus =>
  STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;

class Findings {
  public status: CpmmRederivationStatus = "REPRODUCED";
  public readonly list: string[] = [];
  public add(status: Exclude<CpmmRederivationStatus, "REPRODUCED">, code: string): void {
    const finding = `${status}:${code}`;
    if (!this.list.includes(finding)) this.list.push(finding);
    this.status = worstOf(this.status, status);
  }
}

function deepFreezeOwn<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreezeOwn((v as Record<string, unknown>)[k]);
  }
  return v;
}

/** A JSON copy (what the sealed files hold): `undefined` properties disappear. */
const copyJson = (v: unknown): unknown => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

/** Canonical JSON with sorted keys, for comparisons. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isRec(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * The exact original bytes of a sealed payload. A redacted payload's stored bytes are not the
 * original (`REDACTED`); a withheld or omitted payload has none (`UNAVAILABLE`).
 */
function exactBytes(p: unknown): { bytes: Buffer } | { missing: "REDACTED" | "UNAVAILABLE" } {
  if (!isRec(p) || p.payloadOmitted !== null || p.withheldReason !== null) {
    return { missing: "UNAVAILABLE" };
  }
  if (p.payloadRedacted !== false) return { missing: "REDACTED" };
  if (typeof p.stored !== "string") return { missing: "UNAVAILABLE" };
  const b = p.storedEncoding === "base64" ? strictBase64(p.stored) : Buffer.from(p.stored, "utf8");
  return b === null ? { missing: "UNAVAILABLE" } : { bytes: b };
}

const sameBinding = (a: unknown, b: unknown): boolean =>
  typeof get(a, "poolAddress") === "string" &&
  get(a, "poolAddress") === get(b, "poolAddress") &&
  get(a, "candidateMint") === get(b, "candidateMint");

function acquisitionDirectory(options: unknown): unknown {
  if (options === undefined) return undefined;
  const record = plainRecord(options);
  if (record === null) return null;
  const descriptor = getOwnDesc(record, "acquisitionDir");
  return descriptor === undefined ? undefined : "value" in descriptor ? descriptor.value : null;
}

/** Compare the observation to the same bounded read used to verify the dependency. */
function checkAcquisitionBinding(
  ctx: Record<string, unknown>,
  planBinding: unknown,
  directory: unknown,
  expectedManifestSha256: string | null,
): CpmmAcquisitionBinding {
  const f = new Findings();
  const acquired =
    typeof directory === "string" ? verifyCpmmPoolAcquisitionForBinding(directory) : null;
  const manifestSha256 = acquired?.manifestSha256 ?? null;
  const verification = acquired?.verification;
  if (directory === undefined) f.add("MISSING_EVIDENCE", "ACQUISITION_DIRECTORY_NOT_SUPPLIED");
  else if (acquired === null) f.add("MISMATCH", "ACQUISITION_DIRECTORY_INVALID");
  if (
    expectedManifestSha256 !== null &&
    manifestSha256 !== null &&
    manifestSha256 !== expectedManifestSha256
  )
    f.add("MISMATCH", "ACQUISITION_MANIFEST_DIGEST");
  if (verification !== undefined) {
    for (const { status, link } of verification.issues) f.add(status, `ACQUISITION:${link}`);
    if (verification.integrity === "FAILED" && verification.integrityCode !== "FILE_MISSING") {
      f.add("MISMATCH", `ACQUISITION_INTEGRITY:${verification.integrityCode}`);
    } else if (verification.computed === "ACQUIRED_LIMITED") {
      if (verification.issues.length === 0) f.add("MISSING_EVIDENCE", "ACQUIRED_LIMITED");
    } else if (
      verification.computed === "ACQUISITION_FAILED" ||
      verification.computed === "ACQUIRED_CONTEXT_REFUSED"
    ) {
      f.add("MISMATCH", verification.computed);
    } else if (verification.computed === "ACQUIRED_REPRODUCED" && !acquired?.context) {
      f.add("MISSING_EVIDENCE", "ACQUISITION_VERIFIED_CONTEXT_UNAVAILABLE");
    }
  }

  if (!sameBinding(ctx.target, planBinding)) f.add("MISMATCH", "OBSERVATION_TARGET_BINDING");
  if (!sameBinding(ctx.adaptedPool, planBinding))
    f.add("MISMATCH", "OBSERVATION_ADAPTED_POOL_BINDING");
  const context = acquired?.context;
  if (context) {
    if (canonical(ctx.target) !== canonical(context.target))
      f.add("MISMATCH", "ACQUISITION_TARGET");
    if (canonical(ctx.adaptedPool) !== canonical(context.adaptedPool))
      f.add("MISMATCH", "ACQUISITION_ADAPTED_POOL");
  }
  for (const [i, [name, position]] of BINDING_POSITIONS.entries()) {
    const account = get(ctx, "accounts", name);
    const payload = get(account, "data");
    const bytes = exactBytes(payload);
    if ("missing" in bytes) {
      f.add(
        bytes.missing === "REDACTED" ? "LIMITED_BY_REDACTION" : "MISSING_EVIDENCE",
        `OBSERVATION_ACCOUNT_DATA_${bytes.missing}:${position}`,
      );
    }
    if (!context) continue;
    const expected = context.accounts[i]!;
    if (expected.position !== position || get(account, "address") !== expected.address)
      f.add("MISMATCH", `ACQUISITION_ACCOUNT_POSITION_ADDRESS:${position}`);
    if (get(account, "ownerProgramId") !== expected.ownerProgramId)
      f.add("MISMATCH", `ACQUISITION_ACCOUNT_OWNER:${position}`);
    if (get(account, "slot") !== expected.slot)
      f.add("MISMATCH", `ACQUISITION_ACCOUNT_SLOT:${position}`);
    const digest = "bytes" in bytes ? sha256(bytes.bytes) : get(payload, "originalSha256");
    if (typeof digest === "string" && digest !== expected.originalSha256)
      f.add("MISMATCH", `ACQUISITION_ACCOUNT_BYTES:${position}`);
  }
  return {
    status: f.status,
    findings: f.list,
    expectedManifestSha256,
    manifestSha256,
    dependency: verification
      ? {
          integrity: verification.integrity,
          computed: verification.computed,
          ...(verification.integrityCode === undefined
            ? {}
            : { integrityCode: verification.integrityCode }),
        }
      : null,
  };
}

/**
 * Pool context: the accepted adapter over the stored raw accounts and their recorded identities,
 * owners and slots, compared canonically (bigints tagged as sealed) with the recorded adapted pool
 * and with every recorded binding. Acquisition provenance is computed separately.
 */
function rederivePoolContext(docs: Map<string, Record<string, unknown>>): {
  readonly result: CpmmComponentRederivation;
  /** The freshly adapted pool, only when it matched the recorded one with no contradiction. */
  readonly pool: unknown;
} {
  const f = new Findings();
  let adapted: unknown = null;
  const ctx = docs.get(CPMM_EVIDENCE_FILES.poolContext)!;
  const binding = get(docs.get(CPMM_EVIDENCE_FILES.plan), "plan", "binding");
  const target = get(ctx, "target");
  const recorded = get(ctx, "adaptedPool");
  if (!sameBinding(target, binding)) f.add("MISMATCH", "TARGET_BINDING");
  if (!sameBinding(recorded, binding)) f.add("MISMATCH", "ADAPTED_POOL_BINDING");
  // Every component binding that was read must agree; one that was not is reported, never assumed.
  const componentBinding = (file: string, section: string, label: string): void => {
    const doc = docs.get(file);
    const b =
      get(doc, section, "status") === "READ" ? get(doc, section, "value", "binding") : undefined;
    if (!isRec(b)) f.add("MISSING_EVIDENCE", `${label}_BINDING_UNAVAILABLE`);
    else if (!sameBinding(b, binding)) f.add("MISMATCH", `${label}_BINDING`);
  };
  componentBinding(CPMM_EVIDENCE_FILES.collector, "epochReport", "COLLECTOR");
  componentBinding(CPMM_EVIDENCE_FILES.ownerReport, "report", "OWNER");
  const accounts: Record<string, unknown> = {};
  for (const [name, key] of [
    ["pool", "poolAccount"],
    ["vault0", "vault0Account"],
    ["vault1", "vault1Account"],
  ] as const) {
    const a = get(ctx, "accounts", name);
    const b = exactBytes(get(a, "data"));
    if ("missing" in b) {
      // Only these bytes can limit the adapter's result, so the limitation is attributed here.
      f.add(
        b.missing === "REDACTED" ? "LIMITED_BY_REDACTION" : "MISSING_EVIDENCE",
        `ACCOUNT_DATA_${b.missing}:${name}`,
      );
      continue;
    }
    accounts[key] = {
      address: get(a, "address"),
      data: b.bytes,
      ownerProgramId: get(a, "ownerProgramId"),
      slot: get(a, "slot"),
    };
  }
  if (Object.keys(accounts).length === 3) {
    const r = adaptRaydiumCpmmPoolState({
      target: {
        poolAddress: get(target, "poolAddress"),
        candidateMint: get(target, "candidateMint"),
      },
      ...accounts,
    } as never) as unknown;
    if (!isRec(r) || r.ok !== true) f.add("MISMATCH", "ADAPTER_REFUSED");
    else {
      const derived = copyPlain(r, { nodes: SEAL_LIMITS.maxInputNodes }, 0);
      if (canonical(derived) !== canonical(recorded)) f.add("MISMATCH", "ADAPTED_POOL");
      else adapted = r;
    }
  }
  const contradicted = f.list.some((x) => x.startsWith("MISMATCH:"));
  return { result: { status: f.status, findings: f.list }, pool: contradicted ? null : adapted };
}

/** Collector refusals decided before the receipt is read or the bytes hashed (item G). */
const UNHASHED_REFUSALS: ReadonlySet<unknown> = new Set([
  "FRAME_INVALID",
  "EPOCH_NOT_OPEN",
  "STALE_EPOCH",
  "EPOCH_LIMIT_EXCEEDED",
  "OVERSIZE_FRAME",
  "RECEIPT_INVALID",
]);

/**
 * Collector replay through a fresh accepted collector, in the run's recorded order:
 * - owner-received messages (owner deliveries > 0) before the start call are before-start; the
 *   next `counters.frames` were handed over and match the frame records by order, with length and
 *   (where both exist) digest checked on original bytes; the rest came after intake or settlement.
 *   The owner's own counts cross-check this split. Wrapper-only messages are never considered.
 * - the epoch opens with its recorded start and request id, and its subscribe bytes must equal the
 *   first send's original digest; the unsubscribe frame is built where the owner built it (just
 *   before the second send, so before any later handed-over message) and must equal that send's
 *   original digest; the recorded close applies after the last handed-over frame. A lone send
 *   whose identity evidence is absent (and no owner report) is not attributed: replay stops at it.
 * - a frame is replayed only with its exact original bytes and the collector's own recorded
 *   receipt time. Replay stops at the first frame it cannot reproduce: an unhashed refusal (no
 *   receipt time; it must be the run's last handed-over frame and is checked structurally),
 *   redacted bytes, missing bytes or a dropped frame record. Later frames are associated
 *   structurally only, and the epoch report and counters are then not compared.
 */
function replayCollector(docs: Map<string, Record<string, unknown>>): CpmmCollectorRederivation {
  const f = new Findings();
  const out = {
    handedOverMessages: 0,
    replayedFrames: 0,
    structurallyCheckedFrames: 0,
    epochReportCompared: false,
    countersCompared: false,
  };
  const done = (): CpmmCollectorRederivation => ({ status: f.status, findings: f.list, ...out });
  const col = docs.get(CPMM_EVIDENCE_FILES.collector)!;
  const plan = get(docs.get(CPMM_EVIDENCE_FILES.plan), "plan");
  const readSection = (k: string) =>
    get(col, k, "status") === "READ" ? get(col, k, "value") : undefined;
  const epochReport = readSection("epochReport");
  const frames = readSection("frameRecords");
  const notes = readSection("notifications");
  const counters = readSection("counters");
  if (!isRec(epochReport) || !Array.isArray(frames) || !Array.isArray(notes) || !isRec(counters)) {
    f.add("MISSING_EVIDENCE", "COLLECTOR_COMPONENT_UNAVAILABLE");
    return done();
  }
  const recording = docs.get(CPMM_EVIDENCE_FILES.recording)!;
  if (recording.transportRecorded !== true) {
    f.add("MISSING_EVIDENCE", "TRANSPORT_NOT_RECORDED");
    return done();
  }
  for (const c of ["incoming", "outgoing", "lifecycle"]) {
    if (get(recording, "retention", c, "dropped") !== 0) {
      f.add("MISSING_EVIDENCE", `TRANSPORT_RECORDS_DROPPED:${c}`);
    }
  }
  if (f.list.length > 0) return done();

  // The owner-received messages, split as the owner split them.
  const records = get(docs.get(CPMM_EVIDENCE_FILES.transportRecords), "records") as Record<
    string,
    unknown
  >[];
  const start = records.find((r) => r.kind === "CALL" && r.method === "start");
  const owned = records.filter(
    (r) =>
      r.kind === "EVENT" &&
      r.event === "message" &&
      isInt(r.ownerDeliveries) &&
      r.ownerDeliveries > 0,
  );
  const beforeStart = owned.filter(
    (r) => start === undefined || (r.ordinal as number) < (start.ordinal as number),
  ).length;
  const afterStart = owned.slice(beforeStart);
  const handed = counters.frames as number;
  out.handedOverMessages = handed;
  const ownerDoc = docs.get(CPMM_EVIDENCE_FILES.ownerReport);
  const report =
    get(ownerDoc, "report", "status") === "READ" ? get(ownerDoc, "report", "value") : undefined;
  const late =
    get(ownerDoc, "lateEvents", "status") === "READ"
      ? get(ownerDoc, "lateEvents", "value", "message")
      : undefined;
  if (report === undefined || !isInt(late)) {
    f.add("MISSING_EVIDENCE", "OWNER_COUNTS_UNAVAILABLE");
  } else {
    if (get(report, "incoming", "messagesBeforeStart") !== beforeStart) {
      f.add("MISMATCH", "BEFORE_START_COUNT");
    }
    if (get(report, "incoming", "passedToCollector") !== handed)
      f.add("MISMATCH", "HANDED_OVER_COUNT");
    if (get(report, "intake", "framesAfterIntake") !== afterStart.length - handed - late) {
      f.add("MISMATCH", "AFTER_INTAKE_COUNT");
    }
    if (get(report, "incoming", "messageEvents") !== owned.length - late) {
      f.add("MISMATCH", "OWNER_MESSAGE_COUNT");
    }
  }
  if (afterStart.length < handed) {
    f.add("MISMATCH", "FEWER_MESSAGES_THAN_FRAMES");
    return done();
  }
  const handedOver = afterStart.slice(0, handed);

  // A fresh accepted collector with the recorded configuration and epoch.
  const epoch = get(plan, "epoch") as number;
  let c: CpmmPoolNotificationCollector;
  try {
    c = new CpmmPoolNotificationCollector({
      binding: copyJson(get(plan, "binding")) as never,
      limits: copyJson(get(plan, "limits", "collector")) as never,
      commitment: "confirmed",
    });
  } catch {
    f.add("MISMATCH", "COLLECTOR_REFUSED_RECORDED_CONFIGURATION");
    return done();
  }
  if (canonical(epochReport.binding) !== canonical(get(plan, "binding"))) {
    f.add("MISMATCH", "EPOCH_BINDING");
  }
  if (
    epochReport.epoch !== epoch ||
    epochReport.subscribeRequestId !== get(plan, "subscribeRequestId")
  ) {
    f.add("MISMATCH", "EPOCH_IDENTITY");
  }
  const opened = c.openEpoch({
    epoch,
    observationStartMs: epochReport.observationStartMs as number,
    subscribeRequestId: get(plan, "subscribeRequestId") as number,
  });
  if (opened.status !== "OPENED") {
    f.add("MISMATCH", "EPOCH_OPEN_REFUSED");
    return done();
  }
  const sends = records.filter((r) => r.kind === "CALL" && r.method === "send");
  /** Generated bytes against what was sent, by the original digest (redaction-independent). */
  const sameAsSent = (bytes: Uint8Array, sent: unknown, code: string): void => {
    const p = get(sent, "payload");
    const digest = get(p, "originalSha256");
    if (typeof digest !== "string") f.add("MISSING_EVIDENCE", `${code}_UNVERIFIABLE`);
    else if (get(p, "originalBytes") !== bytes.length || sha256(bytes) !== digest) {
      f.add("MISMATCH", code);
    }
  };
  // The owner's own attempts place its sends: the subscribe first when it was attempted, then
  // the unsubscribe. A peer can answer the subscribe id before the socket opens, and the owner then
  // sends no subscribe, so the only send is the unsubscribe. Without a readable report, a lone send
  // is the subscribe when its length and digest are the subscribe frame's, the unsubscribe when
  // either proves it different, and otherwise unattributed: an absent length or digest proves
  // neither. Each attributed send is compared with the frame the collector builds.
  const loneIdentity = (sent: unknown): "SUBSCRIBE" | "OTHER" | "UNKNOWN" => {
    const p = get(sent, "payload");
    const length = get(p, "originalBytes");
    const digest = get(p, "originalSha256");
    if (isInt(length) && length !== opened.subscribeFrame.length) return "OTHER";
    if (typeof digest === "string" && digest !== sha256(opened.subscribeFrame)) return "OTHER";
    return isInt(length) && typeof digest === "string" ? "SUBSCRIBE" : "UNKNOWN";
  };
  const identity = !isRec(report) && sends.length === 1 ? loneIdentity(sends[0]) : undefined;
  // Whether the unsubscribe was built at the unattributed send changes the collector's state, so
  // nothing after it is replayed and the epoch report and counters are not compared.
  const unattributed = identity === "UNKNOWN" ? sends[0] : undefined;
  if (unattributed !== undefined) f.add("MISSING_EVIDENCE", "SEND_ATTRIBUTION_UNAVAILABLE");
  const sendFor = isRec(report)
    ? applicationSends(report, sends as TransportRecord[])
    : identity === "UNKNOWN"
      ? { subscribe: undefined, unsubscribe: undefined }
      : identity === "OTHER"
        ? { subscribe: undefined, unsubscribe: sends[0] }
        : { subscribe: sends[0], unsubscribe: sends[1] };
  if (sendFor.subscribe !== undefined) {
    sameAsSent(opened.subscribeFrame, sendFor.subscribe, "SUBSCRIBE_FRAME");
  }
  const unsubscribeSend = sendFor.unsubscribe;
  let unsubscribeBuilt = false;
  const buildUnsubscribe = (): void => {
    unsubscribeBuilt = true;
    const b = c.unsubscribeFrame(epoch, get(plan, "unsubscribeRequestId") as number);
    if (b === null) f.add("MISMATCH", "UNSUBSCRIBE_NOT_BUILDABLE");
    else sameAsSent(b, unsubscribeSend, "UNSUBSCRIBE_FRAME");
  };

  let stopped = false;
  handedOver.forEach((msg, i) => {
    if (unattributed !== undefined && (unattributed.ordinal as number) < (msg.ordinal as number)) {
      stopped = true;
    }
    if (
      !stopped &&
      !unsubscribeBuilt &&
      unsubscribeSend !== undefined &&
      (unsubscribeSend.ordinal as number) < (msg.ordinal as number)
    ) {
      buildUnsubscribe();
    }
    const fr = frames[i] as unknown;
    if (!isRec(fr)) {
      if (!stopped) f.add("MISSING_EVIDENCE", "FRAME_RECORDS_DROPPED");
      stopped = true;
      return;
    }
    // Association by order, original length and (where both exist) original digest.
    const p = msg.payload;
    if (fr.sequence !== i + 1 || fr.epoch !== epoch) f.add("MISMATCH", "FRAME_ORDER");
    if (isInt(get(p, "originalBytes")) && fr.byteLength !== get(p, "originalBytes")) {
      f.add("MISMATCH", "FRAME_ASSOCIATION");
    }
    const digest = get(p, "originalSha256");
    if (fr.sha256 !== null && typeof digest === "string" && fr.sha256 !== digest) {
      f.add("MISMATCH", "FRAME_ASSOCIATION");
    }
    if (stopped) {
      out.structurallyCheckedFrames++;
      return;
    }
    if (fr.receivedAtMs === null) {
      // No receipt time was recorded, so the frame is never replayed (none is invented); its shape
      // and position are checked by the structural pass below.
      out.structurallyCheckedFrames++;
      stopped = true;
      f.add("MISSING_EVIDENCE", "UNHASHED_TERMINAL_REFUSAL_NOT_REPLAYED");
      return;
    }
    const b = exactBytes(p);
    if ("missing" in b) {
      out.structurallyCheckedFrames++;
      stopped = true;
      f.add(
        b.missing === "REDACTED" ? "LIMITED_BY_REDACTION" : "MISSING_EVIDENCE",
        `FRAME_PAYLOAD_${b.missing}`,
      );
      return;
    }
    c.acceptFrame({ epoch, bytes: b.bytes, receivedAtMs: fr.receivedAtMs as number });
    out.replayedFrames++;
  });

  // Independently of replay (and so also beyond where it stopped): every handed-over frame and
  // retained notification must obey the accepted collector's receipt and refusal rules.
  const structure = frameStructureProblems({
    frames: frames.slice(0, handed),
    handed,
    notes,
    epoch,
    observationStartMs: epochReport.observationStartMs,
    subscriptionId: epochReport.subscriptionId,
    epochNotificationsAccepted: epochReport.notificationsAccepted,
    notificationsAccepted: counters.notificationsAccepted,
    maxFrameBytes: get(plan, "limits", "collector", "maxFrameBytes"),
  });
  for (const code of structure.mismatch) f.add("MISMATCH", code);
  for (const code of structure.missing) f.add("MISSING_EVIDENCE", code);

  const compare = (replayed: unknown, recorded: unknown, code: string): void => {
    if (canonical(copyJson(replayed)) !== canonical(recorded)) f.add("MISMATCH", code);
  };
  if (stopped || unattributed !== undefined) {
    // Only what was replayed is compared: the frame and notification prefixes it produced.
    const rf = c.frameRecords();
    const rn = c.notifications();
    compare(rf, frames.slice(0, rf.length), "FRAME_RECORDS");
    compare(rn, notes.slice(0, rn.length), "NOTIFICATIONS");
    return done();
  }
  if (unsubscribeSend !== undefined && !unsubscribeBuilt) buildUnsubscribe();
  if (epochReport.state === "CLOSED") {
    if (typeof epochReport.closeReason !== "string" || !isInt(epochReport.closedAtMs)) {
      f.add("MISSING_EVIDENCE", "CLOSE_UNRECORDED");
    } else if (!c.closeEpoch(epoch, epochReport.closeReason as never, epochReport.closedAtMs)) {
      f.add("MISMATCH", "CLOSE_REFUSED");
    }
  }
  compare(c.frameRecords(), frames, "FRAME_RECORDS");
  compare(c.notifications(), notes, "NOTIFICATIONS");
  compare(c.epochReport(epoch), epochReport, "EPOCH_REPORT");
  compare(c.counters(), counters, "COUNTERS");
  out.epochReportCompared = true;
  out.countersCompared = true;
  return done();
}

const DISPOSITIONS: ReadonlySet<unknown> = new Set(CPMM_FRAME_DISPOSITIONS);

/**
 * The accepted collector's rules, checked on the recorded frames without replay:
 * - a frame has a receipt time exactly when it has a digest (refusals before the receipt step
 *   record neither); the disposition is a known one;
 * - an unhashed frame is a pre-receipt refusal and the last frame the owner handed over (every such
 *   refusal ends the run);
 * - a hashed frame was not refused before its receipt, its receipt time is a positive safe integer,
 *   not before the epoch's start nor an earlier receipt, and its length is within `maxFrameBytes`;
 *   an OVERSIZE_FRAME refusal is beyond it;
 * - every retained notification has the collector's exact schema and numeric domains (checked
 *   before any frame lookup); its sequence is its collector-wide acceptance order (retained
 *   notifications are the first ones, so the i-th has sequence i + 1) within the recorded counts;
 *   its frame reference is an integer within the handed-over range, strictly increasing; its epoch
 *   is the run's and its subscription id the acknowledged one;
 * - a notification's frame, when retained, is in the same epoch and was accepted as a notification
 *   (the k-th accepted frame being the k-th notification) at the same receipt time and digest. A
 *   valid reference to a frame record that was genuinely not retained is missing evidence, never a
 *   mismatch; an invalid reference is a mismatch, never "not retained".
 * Payload-derived values (signature, slot, error flag) are checked for their domains only: without
 * the bytes they cannot be checked further, and that stays the replay's limitation.
 */
function frameStructureProblems(x: {
  frames: readonly unknown[];
  handed: number;
  notes: readonly unknown[];
  epoch: unknown;
  observationStartMs: unknown;
  subscriptionId: unknown;
  epochNotificationsAccepted: unknown;
  notificationsAccepted: unknown;
  maxFrameBytes: unknown;
}): { mismatch: string[]; missing: string[] } {
  const { frames, handed, notes, observationStartMs, maxFrameBytes } = x;
  const problems = new Set<string>();
  const missing = new Set<string>();
  let lastReceipt: number | null = null;
  frames.forEach((fr, i) => {
    if (!isRec(fr)) return;
    const at = fr.receivedAtMs;
    const digest = fr.sha256;
    if (!DISPOSITIONS.has(fr.disposition)) problems.add("FRAME_DISPOSITION_UNKNOWN");
    if ((at === null) !== (digest === null)) problems.add("FRAME_RECEIPT_DIGEST_INCONSISTENT");
    if (!isInt(fr.byteLength)) problems.add("FRAME_LENGTH_INCONSISTENT");
    const beyondLimit =
      isInt(maxFrameBytes) && isInt(fr.byteLength) && fr.byteLength > maxFrameBytes;
    if (fr.disposition === "OVERSIZE_FRAME" && !beyondLimit)
      problems.add("FRAME_LENGTH_INCONSISTENT");
    if (at === null) {
      if (!UNHASHED_REFUSALS.has(fr.disposition)) problems.add("UNHASHED_REFUSAL_SHAPE");
      if (i !== handed - 1) problems.add("UNHASHED_REFUSAL_NOT_TERMINAL");
      return;
    }
    if (UNHASHED_REFUSALS.has(fr.disposition)) problems.add("FRAME_DISPOSITION_INCONSISTENT");
    if (digest !== null && !(typeof digest === "string" && HEX64.test(digest))) {
      problems.add("FRAME_RECEIPT_DIGEST_INCONSISTENT");
    }
    if (beyondLimit) problems.add("FRAME_LENGTH_INCONSISTENT");
    if (
      !isInt(at) ||
      at < 1 ||
      (isInt(observationStartMs) && at < observationStartMs) ||
      (lastReceipt !== null && at < lastReceipt)
    ) {
      problems.add("FRAME_RECEIPT_INVALID");
    } else {
      lastReceipt = at;
    }
  });
  // The k-th frame accepted as a notification is the k-th notification (retained frame records
  // are the collector's first ones, so counting from the start is exact).
  const acceptedOrder = new Map<number, number>();
  frames.forEach((fr, i) => {
    if (isRec(fr) && fr.disposition === "NOTIFICATION_ACCEPTED") {
      acceptedOrder.set(i + 1, acceptedOrder.size + 1);
    }
  });
  const accepted = x.notificationsAccepted;
  if (
    (isInt(accepted) && (notes.length > accepted || acceptedOrder.size > accepted)) ||
    (isInt(x.epochNotificationsAccepted) && notes.length > x.epochNotificationsAccepted)
  ) {
    problems.add("NOTIFICATION_COUNT_INCONSISTENT");
  }
  let lastReference = 0;
  notes.forEach((n, i) => {
    if (!sameKeys(n, NOTIFICATION_KEYS)) {
      problems.add("NOTIFICATION_MALFORMED");
      return;
    }
    const o = n as Record<string, unknown>;
    // The reference first: an integer frame sequence within the handed-over range, increasing.
    const ref = o.frameSequence;
    if (!isInt(ref) || ref < 1 || ref > handed || ref <= lastReference) {
      problems.add("NOTIFICATION_FRAME_REFERENCE_INVALID");
      return;
    }
    lastReference = ref;
    if (
      !isInt(o.sequence) ||
      !isInt(o.epoch) ||
      !isInt(o.subscriptionId) ||
      !isValidSolanaSignature(o.signature) ||
      !isInt(o.slot) ||
      !isInt(o.receivedAtMs) ||
      o.receivedAtMs < 1 ||
      (o.notifiedTransactionError !== "NULL" && o.notifiedTransactionError !== "PRESENT") ||
      typeof o.frameSha256 !== "string" ||
      !HEX64.test(o.frameSha256)
    ) {
      problems.add("NOTIFICATION_MALFORMED");
      return;
    }
    if (o.sequence !== i + 1 || (isInt(accepted) && o.sequence > accepted)) {
      problems.add("NOTIFICATION_SEQUENCE_INCONSISTENT");
    }
    if (o.epoch !== x.epoch) problems.add("NOTIFICATION_EPOCH_INCONSISTENT");
    if (o.subscriptionId !== x.subscriptionId)
      problems.add("NOTIFICATION_SUBSCRIPTION_INCONSISTENT");
    const fr = frames[ref - 1];
    if (!isRec(fr)) {
      // A valid reference, but that frame record was not retained: missing, not contradicted.
      missing.add("NOTIFICATION_FRAME_NOT_RETAINED");
      return;
    }
    if (fr.epoch !== o.epoch) problems.add("NOTIFICATION_EPOCH_INCONSISTENT");
    if (
      fr.disposition !== "NOTIFICATION_ACCEPTED" ||
      fr.receivedAtMs !== o.receivedAtMs ||
      fr.sha256 !== o.frameSha256
    ) {
      problems.add("NOTIFICATION_FRAME_INCONSISTENT");
    } else if (acceptedOrder.get(ref) !== o.sequence) {
      problems.add("NOTIFICATION_SEQUENCE_INCONSISTENT");
    }
  });
  return { mismatch: [...problems], missing: [...missing] };
}

/** The accepted collector's notification record (`CpmmCollectedNotification`), exactly. */
const NOTIFICATION_KEYS = [
  "sequence",
  "frameSequence",
  "epoch",
  "subscriptionId",
  "signature",
  "slot",
  "receivedAtMs",
  "notifiedTransactionError",
  "frameSha256",
];

/** Each implemented component in its own guard: an internal failure is never a success. */
function rederive(
  docs: Map<string, Record<string, unknown>>,
  credentials: AnalysisCredentials,
  maxSupportedTransactionVersion: CpmmMaxSupportedTransactionVersion,
): CpmmRederivation {
  const failed = (): Findings => {
    const f = new Findings();
    f.add("MISMATCH", "REDERIVATION_FAILED");
    return f;
  };
  let poolContext: CpmmComponentRederivation;
  let pool: unknown = null;
  try {
    const derived = rederivePoolContext(docs);
    poolContext = derived.result;
    pool = derived.pool;
  } catch {
    const f = failed();
    poolContext = { status: f.status, findings: f.list };
  }
  let collector: CpmmCollectorRederivation;
  try {
    collector = replayCollector(docs);
  } catch {
    const f = failed();
    collector = {
      status: f.status,
      findings: f.list,
      handedOverMessages: 0,
      replayedFrames: 0,
      structurallyCheckedFrames: 0,
      epochReportCompared: false,
      countersCompared: false,
    };
  }
  let transactionAnalysis: CpmmTransactionRederivation;
  // Event counts decoded from matched swap responses, by signature (for the ledger's totals).
  const decodedEvents = new Map<string, DecodedSwapEvents>();
  try {
    transactionAnalysis = analyzeTransactions(
      docs,
      pool,
      credentials,
      decodedEvents,
      maxSupportedTransactionVersion,
    );
  } catch {
    decodedEvents.clear();
    const f = failed();
    transactionAnalysis = {
      status: f.status,
      findings: f.list,
      analysis: "UNAVAILABLE",
      unavailableReason: null,
      exchanges: [],
      comparedExchanges: 0,
      runtimeOutcomesNotCompared: 0,
    };
  }
  let ledger: CpmmLedgerStructuralCheck;
  try {
    ledger = checkLedgerStructure(docs, decodedEvents);
  } catch {
    ledger = ledgerResult(failed(), EMPTY_LEDGER_CHECKED, NO_LEDGER_COVERAGE);
  }
  let ownerWrapperCrossChecks: CpmmOwnerWrapperStructuralCheck;
  try {
    ownerWrapperCrossChecks = checkOwnerWrapperStructure(docs);
  } catch {
    ownerWrapperCrossChecks = ownerWrapperResult(
      failed(),
      EMPTY_OWNER_WRAPPER_CHECKED,
      null,
      NO_OWNER_WRAPPER_COVERAGE,
    );
  }
  const rank = (s: CpmmLedgerStructuralCheck["status"]): CpmmRederivationStatus =>
    s === "STRUCTURALLY_CONSISTENT" ? "REPRODUCED" : s;
  return {
    status: "PARTIAL",
    implementedComponents: worstOf(
      worstOf(
        worstOf(worstOf(poolContext.status, collector.status), transactionAnalysis.status),
        rank(ledger.status),
      ),
      rank(ownerWrapperCrossChecks.status),
    ),
    components: {
      poolContext,
      collector,
      transactionAnalysis,
      ledger,
      ownerWrapperCrossChecks,
      runtimeAccounting: { status: "RUNTIME_ACCOUNTING_NOT_REPRODUCED" },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Transaction analysis and its binding (items C and G, partial)
// ---------------------------------------------------------------------------------------------

type AnalysisCredentials =
  | { readonly status: "SUPPLIED"; readonly secrets: readonly string[] }
  | { readonly status: "NOT_SUPPLIED" }
  | { readonly status: "INVALID" };

/**
 * The supplied analysis credentials, copied through own data properties (no getter or proxy
 * trap). The adapter's own `secrets` rule is mirrored here (1..64 printable-ASCII strings of at
 * least `CPMM_MIN_SECRET_CHARS`); the export's own refusal remains authoritative. Never throws.
 */
function readAnalysisCredentials(options: unknown): AnalysisCredentials {
  if (options === undefined) return { status: "NOT_SUPPLIED" };
  try {
    const o = plainRecord(options);
    if (o === null) return { status: "INVALID" };
    const keys = reflectOwnKeys(o);
    if (keys.some((k) => k !== "analysisSecrets" && k !== "acquisitionDir"))
      return { status: "INVALID" };
    const d = getOwnDesc(o, "analysisSecrets");
    if (d === undefined) return { status: "NOT_SUPPLIED" };
    if (!("value" in d)) return { status: "INVALID" };
    const list = d.value as unknown;
    if (list === undefined) return { status: "NOT_SUPPLIED" };
    if (typeof list !== "object" || list === null || isProxy(list) || !Array.isArray(list)) {
      return { status: "INVALID" };
    }
    const length = getOwnDesc(list, "length")!.value as number;
    if (length < 1 || length > 64) return { status: "INVALID" };
    const secrets: string[] = [];
    for (let i = 0; i < length; i++) {
      const e = getOwnDesc(list, String(i));
      const v = e !== undefined && "value" in e ? (e.value as unknown) : undefined;
      if (
        typeof v !== "string" ||
        v.length < CPMM_MIN_SECRET_CHARS ||
        v.length > 4096 ||
        !/^[\x21-\x7e]+$/.test(v)
      ) {
        return { status: "INVALID" };
      }
      secrets.push(v);
    }
    return { status: "SUPPLIED", secrets: Object.freeze(secrets) };
  } catch {
    return { status: "INVALID" };
  }
}

/** Item G: facts whose kind depends on the response alone, and so are compared with the analysis. */
const RESPONSE_DEPENDENT_KINDS: ReadonlySet<unknown> = new Set([
  "MALFORMED_RESPONSE",
  "EVIDENCE_NOT_REPLAYABLE",
  "RPC_ERROR",
  "TRANSACTION_NOT_FOUND",
  "SIGNATURE_MISMATCH",
  "METADATA_CONTRADICTION",
  "RESOLVED_SWAPS",
  "RESOLVED_NO_TARGET_SWAP",
  "RECORDED_FAILED_TRANSACTION",
  "UNRESOLVED",
]);
/** Item G: runtime-only facts (lifecycle, transport, evidence, admission): never compared. */
const RUNTIME_ONLY_KINDS: ReadonlySet<unknown> = new Set([
  "LATE_RESPONSE",
  "CANCELLED_IN_FLIGHT",
  "SESSION_STOPPED_IN_FLIGHT",
  "TRANSPORT_FAILED",
  "HTTP_ERROR",
  "EVIDENCE_MISSING",
  "EVIDENCE_MISMATCH",
  "REQUEST_REFUSED",
  "INVALID_NOTIFICATION",
  "INVALID_GATE",
  "DUPLICATE_NOTIFICATION",
  "TRACKING_CAPACITY_REACHED",
]);
/** Facts the adapter records without dispatching a request. */
const NO_DISPATCH_KINDS: ReadonlySet<unknown> = new Set([
  "REQUEST_REFUSED",
  "INVALID_NOTIFICATION",
  "INVALID_GATE",
  "DUPLICATE_NOTIFICATION",
  "TRACKING_CAPACITY_REACHED",
]);
const requiresDispatch = (kind: unknown, code: unknown): boolean =>
  !NO_DISPATCH_KINDS.has(kind) && !(kind === "TRANSPORT_FAILED" && code === "DISPATCH_EXCEPTION");

const codeOrNull = (v: unknown): boolean =>
  v === null || (typeof v === "string" && FIXED_CODE.test(v));
const positiveInt = (v: unknown): v is number => isInt(v) && v >= 1;

/** A ledger record's fields used by the binding: required, in their domains. */
const ledgerRecordValid = (r: Record<string, unknown>): boolean =>
  positiveInt(r.sequence) &&
  isValidSolanaSignature(r.signature) &&
  isInt(r.epoch) &&
  positiveInt(r.hostReceivedAtMs) &&
  isInt(r.notifiedSlot) &&
  (r.notifiedBlockTimeSec === null || isInt(r.notifiedBlockTimeSec)) &&
  codeOrNull(r.factKind) &&
  codeOrNull(r.factCode) &&
  typeof r.disposition === "string" &&
  FIXED_CODE.test(r.disposition);

/** A recorded `account()` call: required fields in their domains. */
const accountCallValid = (c: Record<string, unknown>): boolean =>
  positiveInt(c.call) &&
  isInt(c.epoch) &&
  positiveInt(c.hostReceivedAtMs) &&
  (c.outcome === "RETURNED" || c.outcome === "THREW" || c.outcome === "IN_PROGRESS");

/**
 * A `RECORDED` first-occurrence settlement: every record field in its domain, and no
 * duplicate or refusal field.
 */
const recordedSettlementValid = (c: Record<string, unknown>): boolean =>
  positiveInt(c.occurrence) &&
  positiveInt(c.recordSequence) &&
  isValidSolanaSignature(c.signature) &&
  typeof c.disposition === "string" &&
  FIXED_CODE.test(c.disposition) &&
  codeOrNull(c.factKind) &&
  codeOrNull(c.factCode) &&
  c.firstSequence === null &&
  c.code === null;

/**
 * The request body the accepted adapter sends for one signature, id and the schema's request
 * policy (exact bytes): `CPMM_GET_TRANSACTION_CONFIG` (cap 0) for schemas 1 and 2,
 * `CPMM_GET_TRANSACTION_V1_CONFIG` (cap 1) for schema 3.
 */
const expectedRequestBody = (
  signature: string,
  id: number,
  maxSupportedTransactionVersion: CpmmMaxSupportedTransactionVersion,
): string => cpmmGetTransactionRequestBody(signature, id, maxSupportedTransactionVersion);

/**
 * Transaction-response analysis and its binding (items C and G), over the validated documents:
 * - binding, independent of analysis and of redaction: one sealed exchange per signature (its
 *   CPMM purpose is bound by integrity to the session ledger); a POST whose original digest
 *   equals the accepted adapter's exact `getTransaction` body for that signature, the sealed
 *   JSON-RPC id and the schema's request policy (cap 0 for schemas 1 and 2, cap 1 for schema 3;
 *   from the manifest, never from a response); the first retained
 *   collector notification of that signature; the first `account()` call (receipt and epoch); its
 *   settlement and the ledger record (sequence, fact, slot, receipt, epoch); dispatch not before
 *   the notification's receipt; every recorded fact that implies a dispatch has a request, and
 *   none that does not has one;
 * - analysis: the accepted `analyzeCpmmTransactionResponse` over exact, complete, unredacted
 *   response bytes, with the freshly re-adapted pool, the bound notification identity, the sealed
 *   request id and its body limit, and the supplied credentials;
 * - comparison: kind and code only for item G's response-dependent facts; runtime-only facts are
 *   RUNTIME_OUTCOME_NOT_COMPARED whatever the decoded body says.
 * Decoded outcomes, recorded facts and comparison results are kept apart.
 */
function analyzeTransactions(
  docs: Map<string, Record<string, unknown>>,
  pool: unknown,
  credentials: AnalysisCredentials,
  decodedEvents: Map<string, DecodedSwapEvents>,
  maxSupportedTransactionVersion: CpmmMaxSupportedTransactionVersion,
): CpmmTransactionRederivation {
  const f = new Findings();
  const plan = get(docs.get(CPMM_EVIDENCE_FILES.plan), "plan");
  const epoch = get(plan, "epoch");
  const read = (file: string, section: string): unknown =>
    get(docs.get(file), section, "status") === "READ"
      ? get(docs.get(file), section, "value")
      : undefined;
  const records = read(CPMM_EVIDENCE_FILES.ledger, "records") as
    | Record<string, unknown>[]
    | undefined;
  const calls = (get(docs.get(CPMM_EVIDENCE_FILES.ledger), "calls") ?? []) as Record<
    string,
    unknown
  >[];
  const recording = docs.get(CPMM_EVIDENCE_FILES.recording);
  // Calls not recorded, or some dropped: an absent call is missing, never a contradiction.
  const callsDropped =
    get(recording, "ledgerRecorded") !== true ||
    get(recording, "retention", "ledgerCalls", "dropped") !== 0;
  const notes = read(CPMM_EVIDENCE_FILES.collector, "notifications") as
    | Record<string, unknown>[]
    | undefined;
  const notesDropped =
    get(
      read(CPMM_EVIDENCE_FILES.collector, "counters"),
      "metadataRetention",
      "notificationRecordsDropped",
    ) !== 0;
  const window = read(CPMM_EVIDENCE_FILES.sessionLedger, "window") as
    | Record<string, unknown>[]
    | undefined;
  const index = get(docs.get(CPMM_EVIDENCE_FILES.exchangeIndex), "exchanges") as unknown[];
  const sealed = index.map((x) => docs.get(get(x, "path") as string)!);

  let unavailable: CpmmTransactionRederivation["unavailableReason"] =
    credentials.status === "NOT_SUPPLIED"
      ? "ANALYSIS_CREDENTIALS_NOT_SUPPLIED"
      : credentials.status === "INVALID"
        ? "ANALYSIS_CREDENTIALS_INVALID"
        : pool === null
          ? "POOL_CONTEXT_NOT_REPRODUCED"
          : null;

  // One exchange per signature; every fact that implies a dispatch has one, and none other does.
  const perSignature = new Map<unknown, number>();
  for (const ex of sealed) {
    const sig = get(ex, "entry", "requestedIdentity");
    perSignature.set(sig, (perSignature.get(sig) ?? 0) + 1);
  }
  if ([...perSignature.values()].some((n) => n > 1)) f.add("MISMATCH", "DUPLICATE_EXCHANGE");
  // The ledger records used by the binding: valid, and one per signature and per sequence. A
  // malformed record whose signature cannot be read could belong to any exchange.
  const validRecords: Record<string, unknown>[] = [];
  const malformedSignatures = new Set<unknown>();
  let unattributableMalformed = false;
  for (const r of records ?? []) {
    if (isRec(r) && ledgerRecordValid(r)) validRecords.push(r);
    else {
      f.add("MISMATCH", "LEDGER_RECORD_MALFORMED");
      if (isRec(r) && isValidSolanaSignature(r.signature)) malformedSignatures.add(r.signature);
      else unattributableMalformed = true;
    }
  }
  const countBy = (key: string): Map<unknown, number> => {
    const m = new Map<unknown, number>();
    for (const r of validRecords) m.set(r[key], (m.get(r[key]) ?? 0) + 1);
    return m;
  };
  const recordsPerSignature = countBy("signature");
  const recordsPerSequence = countBy("sequence");
  const ambiguous = (r: Record<string, unknown>): boolean =>
    recordsPerSignature.get(r.signature)! > 1 || recordsPerSequence.get(r.sequence)! > 1;
  if (validRecords.some(ambiguous)) f.add("MISMATCH", "LEDGER_RECORD_AMBIGUOUS");
  if (records === undefined) f.add("MISSING_EVIDENCE", "LEDGER_RECORDS_UNAVAILABLE");
  else {
    for (const r of validRecords) {
      const kind = r.factKind;
      if (kind === null) {
        f.add("MISSING_EVIDENCE", "LEDGER_FACT_PENDING");
        continue;
      }
      if (!RESPONSE_DEPENDENT_KINDS.has(kind) && !RUNTIME_ONLY_KINDS.has(kind)) {
        f.add("MISMATCH", "FACT_KIND_UNKNOWN");
        continue;
      }
      const has = perSignature.has(r.signature);
      if (requiresDispatch(kind, r.factCode) && !has) {
        const requested =
          window === undefined ||
          window.some((e) => e.purpose === CPMM_TX_PURPOSE && e.requestedIdentity === r.signature);
        // A request the authoritative session ledger shows but the evidence lacks is missing;
        // a fact that needed a request the session never made is a contradiction.
        f.add(
          requested ? "MISSING_EVIDENCE" : "MISMATCH",
          requested ? "EXCHANGE_NOT_SEALED" : "REQUEST_MISSING_FOR_FACT",
        );
      }
      if (!requiresDispatch(kind, r.factCode) && has)
        f.add("MISMATCH", "EXCHANGE_WITHOUT_DISPATCH_FACT");
    }
  }

  const exchanges: CpmmTransactionExchangeResult[] = [];
  let compared = 0;
  let runtimeOnly = 0;
  for (const ex of sealed) {
    const entry = get(ex, "entry");
    const seq = get(entry, "seq") as number;
    const sig = get(entry, "requestedIdentity");
    const id = get(entry, "jsonRpcId");
    const signature = isValidSolanaSignature(sig) ? sig : null;
    if (signature === null || !isInt(id) || id < 1) f.add("MISMATCH", "EXCHANGE_IDENTITY_INVALID");

    // The request: the original digest against the adapter's exact body (redaction-independent).
    const rb = get(ex, "requestBody");
    if (get(ex, "method") !== "POST") f.add("MISMATCH", "REQUEST_METHOD");
    else if (signature !== null && isInt(id)) {
      const expected = expectedRequestBody(signature, id, maxSupportedTransactionVersion);
      const digest = get(rb, "originalSha256");
      if (typeof digest !== "string") f.add("MISSING_EVIDENCE", "REQUEST_BODY_UNVERIFIABLE");
      else if (
        digest !== sha256(expected) ||
        get(rb, "originalBytes") !== Buffer.byteLength(expected)
      ) {
        f.add("MISMATCH", "REQUEST_BODY");
      }
    }

    // The notification, the first account() occurrence, its settlement and the ledger record.
    const note = notes?.find((n) => n.signature === signature);
    if (notes === undefined) f.add("MISSING_EVIDENCE", "NOTIFICATIONS_UNAVAILABLE");
    else if (note === undefined) {
      f.add(
        notesDropped ? "MISSING_EVIDENCE" : "MISMATCH",
        notesDropped ? "NOTIFICATION_NOT_RETAINED" : "NOTIFICATION_MISSING",
      );
    } else {
      if (note.epoch !== epoch) f.add("MISMATCH", "NOTIFICATION_IDENTITY");
      const dispatched = get(entry, "dispatchedAtMs");
      if (isInt(dispatched) && isInt(note.receivedAtMs) && dispatched < note.receivedAtMs) {
        f.add("MISMATCH", "DISPATCH_BEFORE_RECEIPT");
      }
    }
    // The ledger link: the first account() call, its single settlement and the single ledger
    // record, each structurally valid. Any contradiction here stops the fact's comparison.
    let linkContradicted = false;
    const contradict = (code: string): void => {
      f.add("MISMATCH", code);
      linkContradicted = true;
    };
    const candidates = calls.filter((c) => c.kind === "ACCOUNT_CALL" && c.signature === signature);
    let firstCall: Record<string, unknown> | undefined;
    if (candidates.some((c) => !accountCallValid(c))) contradict("ACCOUNT_CALL_MALFORMED");
    else {
      for (const c of candidates) {
        if (firstCall === undefined || (c.call as number) < (firstCall.call as number))
          firstCall = c;
      }
    }
    let callReturned = false;
    if (firstCall === undefined) {
      if (candidates.length === 0) {
        if (callsDropped) f.add("MISSING_EVIDENCE", "ACCOUNT_CALL_NOT_RETAINED");
        else contradict("ACCOUNT_CALL_MISSING");
      }
    } else if (
      calls.filter((c) => c.kind === "ACCOUNT_CALL" && c.call === firstCall.call).length > 1
    ) {
      contradict("ACCOUNT_CALL_AMBIGUOUS");
    } else if (firstCall.outcome === "THREW") {
      // A first occurrence that threw cannot have produced the record the ledger holds.
      contradict("ACCOUNT_CALL_MALFORMED");
    } else {
      if (
        firstCall.epoch !== epoch ||
        (note !== undefined && firstCall.hostReceivedAtMs !== note.receivedAtMs)
      ) {
        contradict("ACCOUNT_CALL_IDENTITY");
      }
      if (firstCall.outcome === "IN_PROGRESS") {
        f.add("MISSING_EVIDENCE", "ACCOUNT_CALL_IN_PROGRESS");
      } else callReturned = true;
    }

    const own = validRecords.filter((r) => r.signature === signature);
    const recordMalformed = unattributableMalformed || malformedSignatures.has(signature);
    if (recordMalformed) linkContradicted = true;
    let record: Record<string, unknown> | undefined;
    if (own.length > 1 || own.some(ambiguous)) linkContradicted = true;
    else if (own.length === 1) record = own[0];
    else if (records !== undefined && !recordMalformed) contradict("LEDGER_RECORD_MISSING");
    if (
      record !== undefined &&
      (record.epoch !== epoch ||
        // The collector's envelope never carries a block time.
        record.notifiedBlockTimeSec !== null ||
        (note !== undefined &&
          (record.notifiedSlot !== note.slot || record.hostReceivedAtMs !== note.receivedAtMs)))
    ) {
      contradict("LEDGER_RECORD_IDENTITY");
    }

    if (firstCall === undefined) {
      // No call to settle: the settlement cannot be located.
      if (candidates.length === 0 && record !== undefined) {
        f.add("MISSING_EVIDENCE", "ACCOUNT_SETTLEMENT_UNAVAILABLE");
      }
    } else if (callReturned) {
      const settlements = calls.filter(
        (c) => c.kind === "ACCOUNT_SETTLEMENT" && c.call === firstCall.call,
      );
      const settled = settlements[0];
      if (settlements.length > 1) contradict("ACCOUNT_SETTLEMENT_AMBIGUOUS");
      else if (settled === undefined) {
        // Missing only when the recorder dropped calls or settlements were still pending.
        if (callsDropped || get(recording, "pending", "accountSettlementsPending") !== 0) {
          f.add("MISSING_EVIDENCE", "ACCOUNT_SETTLEMENT_UNAVAILABLE");
        } else contradict("ACCOUNT_SETTLEMENT_MISSING");
      } else if (
        settled.outcome !== "FULFILLED" ||
        !codeOrNull(settled.status) ||
        settled.status === null
      ) {
        // A rejection carries no status; a fulfilment always has one.
        contradict("ACCOUNT_SETTLEMENT_MALFORMED");
      } else if (settled.status !== "RECORDED") {
        contradict("LEDGER_SETTLEMENT");
      } else if (!recordedSettlementValid(settled)) {
        contradict("ACCOUNT_SETTLEMENT_MALFORMED");
      } else if (
        settled.signature !== signature ||
        (record !== undefined &&
          (settled.recordSequence !== record.sequence ||
            settled.factKind !== record.factKind ||
            settled.factCode !== record.factCode))
      ) {
        contradict("LEDGER_SETTLEMENT");
      }
    }
    const recorded =
      record === undefined
        ? null
        : {
            factKind: record.factKind as string | null,
            factCode: record.factCode as string | null,
          };

    // The response material, assessed for every exchange whatever its recorded fact: only
    // exact, complete, unredacted bytes are available.
    const state = get(ex, "bodyState");
    const body = exactBytes(get(ex, "body"));
    const material: string | null =
      state !== "COMPLETE"
        ? `BODY_${String(state)}`
        : "missing" in body
          ? `BODY_${body.missing}`
          : null;
    if (material === "BODY_REDACTED") f.add("LIMITED_BY_REDACTION", "RESPONSE_BODY_REDACTED");
    else if (material !== null) f.add("MISSING_EVIDENCE", `RESPONSE_${material}`);

    // The analysis of those bytes.
    let notAnalysed: string | null = material ?? unavailable;
    let decoded: CpmmTransactionExchangeResult["decoded"] = null;
    let decodedSwapEvents: DecodedSwapEvents | null = null;
    if (notAnalysed !== null || "missing" in body) {
      // Not analysable: the material or the analysis is unavailable (above).
    } else if (note === undefined || signature === null || !isInt(id)) {
      notAnalysed = "BINDING_UNAVAILABLE";
    } else {
      const a = analyzeCpmmTransactionResponse({
        notification: { signature, slot: note.slot, receivedAtMs: note.receivedAtMs },
        jsonRpcId: id,
        pool,
        responseBytes: body.bytes,
        maxResponseBytes: get(ex, "maxResponseBytes"),
        secrets: credentials.status === "SUPPLIED" ? credentials.secrets : [],
        maxSupportedTransactionVersion,
      }) as unknown as Record<string, unknown>;
      if (a.status !== "ANALYZED") {
        if (a.code === "SECRETS_INVALID") {
          unavailable = "ANALYSIS_CREDENTIALS_INVALID";
          notAnalysed = unavailable;
        } else {
          notAnalysed = "ANALYSIS_INPUT_INVALID";
          f.add("MISMATCH", "ANALYSIS_INPUT_INVALID");
        }
      } else {
        decoded = {
          kind: a.kind as string,
          code: (a.code as string | null) ?? null,
          detail: (a.detail as string | null) ?? null,
          replay: a.replay as string,
          decoderStatus: (get(a, "decoder", "status") as string | undefined) ?? null,
          bodyState: get(a, "body", "state") as string,
        };
        const events = get(a, "events");
        const list = Array.isArray(events) ? (events as unknown[]) : [];
        const single = (key: string, valid: (v: unknown) => boolean): number | null => {
          const values = new Set(list.map((e) => get(e, key)));
          const [only] = values;
          return values.size === 1 && valid(only) ? (only as number) : null;
        };
        decodedSwapEvents = {
          count: list.length,
          slot: single("slot", isInt),
          blockTimeSec: single("blockTimeSec", positiveInt),
        };
      }
    }

    // The comparison: response-dependent facts only, over an intact ledger link.
    let comparison: CpmmTransactionExchangeResult["comparison"];
    if (linkContradicted) {
      comparison = "NOT_COMPARED_BINDING_CONTRADICTED";
    } else if (recorded === null || recorded.factKind === null) {
      comparison = "NOT_COMPARED_MISSING_EVIDENCE";
    } else if (RUNTIME_ONLY_KINDS.has(recorded.factKind)) {
      comparison = "RUNTIME_OUTCOME_NOT_COMPARED";
      runtimeOnly++;
    } else if (decoded !== null) {
      compared++;
      const same = decoded.kind === recorded.factKind && decoded.code === recorded.factCode;
      comparison = same ? "MATCHED" : "MISMATCH";
      if (!same) f.add("MISMATCH", "FACT_MISMATCH");
      else if (decoded.kind === "RESOLVED_SWAPS" && signature !== null) {
        decodedEvents.set(signature, decodedSwapEvents!);
      }
    } else if (material === "BODY_REDACTED") {
      comparison = "NOT_COMPARED_LIMITED_BY_REDACTION";
    } else if (material !== null) {
      comparison = "NOT_COMPARED_MISSING_EVIDENCE";
    } else if (notAnalysed === unavailable && unavailable !== null) {
      comparison = "NOT_COMPARED_ANALYSIS_UNAVAILABLE";
      f.add("MISSING_EVIDENCE", unavailable);
    } else {
      comparison = "NOT_COMPARED_MISSING_EVIDENCE";
      // A refused analysis input is already a contradiction.
      if (notAnalysed === "BINDING_UNAVAILABLE") {
        f.add("MISSING_EVIDENCE", "RESPONSE_BINDING_UNAVAILABLE");
      }
    }
    exchanges.push({ seq, signature, decoded, notAnalysed, recorded, comparison });
  }
  // No analysis at all is missing evidence whenever there is a response to analyse.
  if (unavailable !== null && sealed.length > 0) f.add("MISSING_EVIDENCE", unavailable);
  return {
    status: f.status,
    findings: f.list,
    analysis: unavailable === null ? "AVAILABLE" : "UNAVAILABLE",
    unavailableReason: unavailable,
    exchanges,
    comparedExchanges: compared,
    runtimeOutcomesNotCompared: runtimeOnly,
  };
}

// ---------------------------------------------------------------------------------------------
// Ledger structure (item G, partial): records, epochs, counters, account calls and settlements
// ---------------------------------------------------------------------------------------------

/** The keys of `K` exactly (the compiler refuses a missing or extra key). */
const keysOf = <K extends string>(o: Readonly<Record<K, true>>): readonly K[] =>
  Object.freeze(Object.keys(o) as K[]);

const LEDGER_LIMIT_KEYS = keysOf<keyof CpmmLedgerLimits>({
  maxSignatureRecords: true,
  maxDuplicateDetailsPerRecord: true,
  maxEpochs: true,
});
const LEDGER_RECORD_KEYS = keysOf<keyof CpmmSignatureAccountingRecord>({
  sequence: true,
  signature: true,
  epoch: true,
  hostReceivedAtMs: true,
  notifiedSlot: true,
  notifiedBlockTimeSec: true,
  verifiedSlot: true,
  verifiedBlockTimeSec: true,
  disposition: true,
  blockingClass: true,
  policyPending: true,
  factKind: true,
  factCode: true,
  ingestion: true,
  metadataConflict: true,
  duplicateOccurrences: true,
  duplicateDetails: true,
  duplicateDetailsDropped: true,
});
const LEDGER_INGESTION_KEYS = keysOf<keyof CpmmIngestionAccounting>({
  status: true,
  total: true,
  accepted: true,
  rejected: true,
  unattempted: true,
  indeterminate: true,
});
const LEDGER_DETAIL_KEYS = keysOf<keyof CpmmDuplicateOccurrence>({
  occurrence: true,
  epoch: true,
  hostReceivedAtMs: true,
  notifiedSlot: true,
  notifiedBlockTimeSec: true,
  agreement: true,
  firstDispositionAtReceipt: true,
});
const LEDGER_EPOCH_KEYS = keysOf<keyof CpmmEpochAccounting>({
  epoch: true,
  observationStartMs: true,
  state: true,
  occurrences: true,
  firstOccurrences: true,
  duplicates: true,
  invalid: true,
  capacityRefused: true,
});
const LEDGER_COUNTER_KEYS = keysOf<keyof CpmmLedgerCounters>({
  occurrences: true,
  unattributedOccurrences: true,
  recordCapacityRefused: true,
  epochCapacityRefused: true,
  openEpochRefused: true,
  saturated: true,
});
const LEDGER_DISPOSITIONS: ReadonlySet<unknown> = new Set(
  keysOf<CpmmAccountingDisposition>({
    PENDING: true,
    INGESTED: true,
    INGESTION_INCOMPLETE: true,
    POLICY_PENDING: true,
    UNRESOLVED: true,
  }),
);
const AGREEMENTS: ReadonlySet<unknown> = new Set(
  keysOf<CpmmDuplicateOccurrence["agreement"]>({
    AGREES: true,
    SLOT_CONFLICT: true,
    BLOCK_TIME_CONFLICT: true,
  }),
);
const EPOCH_STATES: ReadonlySet<unknown> = new Set(
  keysOf<CpmmEpochAccounting["state"]>({ OPEN: true, CLOSED: true }),
);
const INGESTION_STATUSES: ReadonlySet<unknown> = new Set(
  keysOf<CpmmIngestionAccounting["status"]>({
    NOT_CALLED: true,
    EXCEPTION: true,
    COMPLETE: true,
    PARTIAL: true,
    NONE_ACCEPTED: true,
    REFUSED_BEFORE_START: true,
    NOT_INGESTIBLE: true,
  }),
);
/** Statuses the adapter's `ingest()` itself returns (the ledger adds NOT_CALLED and EXCEPTION). */
const INGEST_RESULT_STATUSES: ReadonlySet<unknown> = new Set([
  "COMPLETE",
  "PARTIAL",
  "NONE_ACCEPTED",
  "REFUSED_BEFORE_START",
  "NOT_INGESTIBLE",
]);
const ACCOUNT_RESULT_STATUSES: ReadonlySet<unknown> = new Set(
  keysOf<CpmmAccountResult["status"]>({
    RECORDED: true,
    DUPLICATE: true,
    INVALID: true,
    CAPACITY_REFUSED: true,
  }),
);
const CAPACITY_CODES: ReadonlySet<unknown> = new Set(
  keysOf<Extract<CpmmAccountResult, { status: "CAPACITY_REFUSED" }>["code"]>({
    RECORD_CAPACITY: true,
    EPOCH_CAPACITY: true,
  }),
);
const INVALID_CODES: ReadonlySet<unknown> = new Set(CPMM_INVALID_CODES);
/** INVALID codes the ledger can return without an epoch (counted as unattributed). */
const UNATTRIBUTABLE_INVALID_CODES: ReadonlySet<unknown> = new Set([
  "ENVELOPE_INVALID",
  "STALE_EPOCH",
  "EPOCH_NOT_OPEN",
]);
/** INVALID codes the ledger never attributes to an epoch (no retained epoch is known then). */
const NEVER_ATTRIBUTED_INVALID_CODES = ["ENVELOPE_INVALID", "EPOCH_NOT_OPEN"] as const;
/** The accepted ledger's partition of blocking classes by terminal disposition. */
const BLOCKING_CLASS_SCOPE: Readonly<
  Record<CpmmBlockingClass, "UNRESOLVED" | "INGESTION_INCOMPLETE" | "EITHER">
> = {
  TRANSACTION_UNAVAILABLE: "UNRESOLVED",
  RESPONSE_CONTRADICTED: "UNRESOLVED",
  DECODER_UNRESOLVED: "UNRESOLVED",
  EVIDENCE_UNVERIFIED: "UNRESOLVED",
  EVIDENCE_WITHHELD: "UNRESOLVED",
  CANCELLED: "UNRESOLVED",
  SESSION_ENDED: "UNRESOLVED",
  REQUEST_REFUSED: "UNRESOLVED",
  ADAPTER_CAPACITY_REFUSED: "UNRESOLVED",
  DUPLICATE_WITHOUT_ORIGINAL: "UNRESOLVED",
  VALIDATION_DISAGREEMENT: "UNRESOLVED",
  INGEST_STOPPED: "INGESTION_INCOMPLETE",
  INGEST_REJECTED: "INGESTION_INCOMPLETE",
  NOT_INGESTIBLE: "INGESTION_INCOMPLETE",
  EPOCH_CLOSED: "EITHER",
  BINDING_CONFLICT: "EITHER",
  ACCOUNTING_EXCEPTION: "EITHER",
  UNRECOGNIZED_OUTCOME: "EITHER",
};
const BLOCKING_CLASSES: ReadonlySet<unknown> = new Set(Object.keys(BLOCKING_CLASS_SCOPE));
/** Policy-pending outcomes and the only fact kind each follows from (no new policy). */
const POLICY_FACT_KIND: Readonly<Record<CpmmPolicyPending, string>> = {
  NO_TARGET_SWAP_POLICY_UNREVIEWED: "RESOLVED_NO_TARGET_SWAP",
  FAILED_TRANSACTION_POLICY_UNREVIEWED: "RECORDED_FAILED_TRANSACTION",
};
const POLICY_PENDING_VALUES: ReadonlySet<unknown> = new Set(Object.keys(POLICY_FACT_KIND));
/** The accepted ledger's UNRESOLVED class for each fact kind it maps directly. */
const UNRESOLVED_CLASS_BY_KIND: ReadonlyMap<unknown, CpmmBlockingClass> = new Map<
  string,
  CpmmBlockingClass
>([
  ["INVALID_NOTIFICATION", "VALIDATION_DISAGREEMENT"],
  ["INVALID_GATE", "VALIDATION_DISAGREEMENT"],
  ["UNRESOLVED", "DECODER_UNRESOLVED"],
  ["TRANSACTION_NOT_FOUND", "TRANSACTION_UNAVAILABLE"],
  ["RPC_ERROR", "TRANSACTION_UNAVAILABLE"],
  ["HTTP_ERROR", "TRANSACTION_UNAVAILABLE"],
  ["TRANSPORT_FAILED", "TRANSACTION_UNAVAILABLE"],
  ["MALFORMED_RESPONSE", "RESPONSE_CONTRADICTED"],
  ["SIGNATURE_MISMATCH", "RESPONSE_CONTRADICTED"],
  ["METADATA_CONTRADICTION", "RESPONSE_CONTRADICTED"],
  ["EVIDENCE_MISSING", "EVIDENCE_UNVERIFIED"],
  ["EVIDENCE_MISMATCH", "EVIDENCE_UNVERIFIED"],
  ["EVIDENCE_NOT_REPLAYABLE", "EVIDENCE_WITHHELD"],
  ["CANCELLED_IN_FLIGHT", "CANCELLED"],
  ["SESSION_STOPPED_IN_FLIGHT", "SESSION_ENDED"],
  ["TRACKING_CAPACITY_REACHED", "ADAPTER_CAPACITY_REFUSED"],
  ["DUPLICATE_NOTIFICATION", "DUPLICATE_WITHOUT_ORIGINAL"],
]);
/** REQUEST_REFUSED and LATE_RESPONSE by code; a lifecycle refusal may be the epoch's closing. */
const UNRESOLVED_CLASS_BY_CODE: Readonly<
  Record<"REQUEST_REFUSED" | "LATE_RESPONSE", ReadonlyMap<unknown, readonly CpmmBlockingClass[]>>
> = {
  REQUEST_REFUSED: new Map<string, readonly CpmmBlockingClass[]>([
    ["CALLER_REFUSAL", ["CANCELLED", "EPOCH_CLOSED"]],
    ["CALLER_CANCELLED", ["CANCELLED"]],
    ["LIFETIME_EXPIRED", ["SESSION_ENDED"]],
    ["REQUEST_SESSION_STOPPED", ["SESSION_ENDED"]],
    ["HTTP_ATTEMPT_CEILING_REACHED", ["REQUEST_REFUSED"]],
    ["SOLANA_RPC_ATTEMPT_CEILING_REACHED", ["REQUEST_REFUSED"]],
    ["BUDGET_MANAGER_DENIED", ["REQUEST_REFUSED"]],
    ["REQUEST_SESSION_NOT_OPEN", ["REQUEST_REFUSED"]],
    ["UNRECOGNIZED_SESSION_CODE", ["REQUEST_REFUSED"]],
  ]),
  LATE_RESPONSE: new Map<string, readonly CpmmBlockingClass[]>([
    ["LIFECYCLE_REFUSED", ["CANCELLED", "EPOCH_CLOSED"]],
    ["CALLER_CANCELLED", ["CANCELLED"]],
    ["SESSION_STOPPED", ["SESSION_ENDED"]],
    ["ABSOLUTE_DEADLINE", ["SESSION_ENDED"]],
    ["SESSION_NOT_OPEN", ["SESSION_ENDED"]],
    ["LIFECYCLE_CHECK_FAILED", ["SESSION_ENDED"]],
  ]),
};
/** INGESTION_INCOMPLETE classes a bound swap fact can take. */
const SWAP_INCOMPLETE_CLASSES: ReadonlySet<unknown> = new Set([
  "NOT_INGESTIBLE",
  "UNRECOGNIZED_OUTCOME",
  "INGEST_STOPPED",
  "EPOCH_CLOSED",
  "INGEST_REJECTED",
  "ACCOUNTING_EXCEPTION",
]);

type LedgerRecord = CpmmSignatureAccountingRecord;

const nullOrInt = (v: unknown): boolean => v === null || isInt(v);
const nullOrPositive = (v: unknown): boolean => v === null || positiveInt(v);

function duplicateDetailValid(d: unknown): d is CpmmDuplicateOccurrence {
  return (
    isRec(d) &&
    sameKeys(d, LEDGER_DETAIL_KEYS) &&
    positiveInt(d.occurrence) &&
    isInt(d.epoch) &&
    positiveInt(d.hostReceivedAtMs) &&
    isInt(d.notifiedSlot) &&
    nullOrPositive(d.notifiedBlockTimeSec) &&
    AGREEMENTS.has(d.agreement) &&
    LEDGER_DISPOSITIONS.has(d.firstDispositionAtReceipt)
  );
}

/** Every field of a record in the accepted ledger's domains (details apart). */
function ledgerRecordSchemaValid(r: unknown): r is LedgerRecord {
  if (!isRec(r) || !sameKeys(r, LEDGER_RECORD_KEYS)) return false;
  const g = r.ingestion;
  return (
    positiveInt(r.sequence) &&
    isValidSolanaSignature(r.signature) &&
    isInt(r.epoch) &&
    positiveInt(r.hostReceivedAtMs) &&
    isInt(r.notifiedSlot) &&
    nullOrPositive(r.notifiedBlockTimeSec) &&
    nullOrInt(r.verifiedSlot) &&
    nullOrPositive(r.verifiedBlockTimeSec) &&
    LEDGER_DISPOSITIONS.has(r.disposition) &&
    (r.blockingClass === null || BLOCKING_CLASSES.has(r.blockingClass)) &&
    (r.policyPending === null || POLICY_PENDING_VALUES.has(r.policyPending)) &&
    codeOrNull(r.factKind) &&
    codeOrNull(r.factCode) &&
    isRec(g) &&
    sameKeys(g, LEDGER_INGESTION_KEYS) &&
    INGESTION_STATUSES.has(g.status) &&
    LEDGER_INGESTION_KEYS.every((k) => k === "status" || isInt(g[k])) &&
    typeof r.metadataConflict === "boolean" &&
    isInt(r.duplicateOccurrences) &&
    Array.isArray(r.duplicateDetails) &&
    isInt(r.duplicateDetailsDropped)
  );
}

/** Disposition, blocking class and policy against the recorded fact, as the ledger maps them. */
function classificationValid(r: LedgerRecord): boolean {
  const d = r.disposition;
  const bc = r.blockingClass;
  const kind = r.factKind;
  if (d === "PENDING") {
    return bc === null && r.policyPending === null && kind === null && r.factCode === null;
  }
  if ((d === "POLICY_PENDING") !== (r.policyPending !== null)) return false;
  if ((bc === null) !== (d === "INGESTED" || d === "POLICY_PENDING")) return false;
  if (bc !== null) {
    const scope = BLOCKING_CLASS_SCOPE[bc];
    if (scope !== "EITHER" && scope !== d) return false;
  }
  // Outcomes of the ledger itself, whatever the fact.
  if (d === "UNRESOLVED" && bc === "ACCOUNTING_EXCEPTION") return true;
  if (kind === null) return d === "UNRESOLVED" && bc === "UNRECOGNIZED_OUTCOME";
  if (kind === "RESOLVED_SWAPS") {
    if (d === "INGESTED") return true;
    if (d === "INGESTION_INCOMPLETE") return SWAP_INCOMPLETE_CLASSES.has(bc);
    return d === "UNRESOLVED" && bc === "BINDING_CONFLICT";
  }
  if (d === "POLICY_PENDING") return POLICY_FACT_KIND[r.policyPending!] === kind;
  if (d !== "UNRESOLVED") return false;
  // A fact naming another notification is a binding conflict (validation kinds return first).
  if (bc === "BINDING_CONFLICT") return kind !== "INVALID_NOTIFICATION" && kind !== "INVALID_GATE";
  const direct = UNRESOLVED_CLASS_BY_KIND.get(kind);
  if (direct !== undefined) return bc === direct;
  if (kind === "REQUEST_REFUSED" || kind === "LATE_RESPONSE") {
    const byCode = UNRESOLVED_CLASS_BY_CODE[kind].get(r.factCode);
    return byCode === undefined ? bc === "UNRECOGNIZED_OUTCOME" : byCode.includes(bc!);
  }
  return bc === "UNRECOGNIZED_OUTCOME";
}

/** Verified slot and block time: written once, at the terminal transition, as the ledger does. */
function verifiedMetadataValid(r: LedgerRecord): boolean {
  const vs = r.verifiedSlot;
  const vb = r.verifiedBlockTimeSec;
  if (vs !== null && vs !== r.notifiedSlot) return false;
  if (vb !== null && vs === null) return false;
  if (vb !== null && r.notifiedBlockTimeSec !== null && vb !== r.notifiedBlockTimeSec) return false;
  const d = r.disposition;
  const bc = r.blockingClass;
  // A bound swap fact: slot and on-chain time from its events.
  if (d === "INGESTED" || (d === "INGESTION_INCOMPLETE" && bc !== "ACCOUNTING_EXCEPTION")) {
    return vs !== null && vb !== null;
  }
  // Positioned outcomes: verified only past the decoding preconditions, from the notification.
  if (d === "POLICY_PENDING" || (d === "UNRESOLVED" && bc === "DECODER_UNRESOLVED")) {
    return vb === (vs === null ? null : r.notifiedBlockTimeSec);
  }
  return vs === null && vb === null;
}

/** The ingestion accounting by the ledger's rules, indeterminate counts included. */
function ingestionValid(r: LedgerRecord): boolean {
  const { status, total, accepted, rejected, unattempted, indeterminate } = r.ingestion;
  if (accepted + rejected + unattempted + indeterminate !== total) return false;
  if (status === "EXCEPTION") {
    if (total < 1 || indeterminate !== total) return false;
  } else if (indeterminate !== 0) return false;
  if ((status === "NOT_CALLED" || status === "NOT_INGESTIBLE") && unattempted !== total) {
    return false;
  }
  const zero = status === "NOT_CALLED" && total === 0;
  const d = r.disposition;
  const bc = r.blockingClass;
  if (d === "PENDING" || d === "POLICY_PENDING" || r.factKind !== "RESOLVED_SWAPS") return zero;
  if (d === "INGESTED") return status === "COMPLETE" && total >= 1 && accepted === total;
  if (d === "UNRESOLVED") {
    // Before any ingest, or a foreign fact or tracker identity refused by the ingest itself.
    return zero || (bc === "BINDING_CONFLICT" && total >= 1 && INGEST_RESULT_STATUSES.has(status));
  }
  // INGESTION_INCOMPLETE: a bound, non-empty swap fact.
  if (total < 1) return false;
  switch (bc) {
    case "NOT_INGESTIBLE":
      return status === "NOT_CALLED" || status === "NOT_INGESTIBLE";
    case "ACCOUNTING_EXCEPTION":
      return status === "EXCEPTION";
    case "UNRECOGNIZED_OUTCOME":
      return status !== "NOT_CALLED";
    case "INGEST_REJECTED":
      return status === "PARTIAL" || status === "NONE_ACCEPTED";
    default:
      return INGEST_RESULT_STATUSES.has(status) && status !== "NOT_INGESTIBLE";
  }
}

/** The receipt-time agreement, against the reference values the first record had then. */
function expectedAgreement(r: LedgerRecord, d: CpmmDuplicateOccurrence): string {
  // While PENDING nothing is verified yet; after the transition the verified values are final.
  const pending = d.firstDispositionAtReceipt === "PENDING";
  const refSlot = pending ? r.notifiedSlot : (r.verifiedSlot ?? r.notifiedSlot);
  const refBt = pending
    ? r.notifiedBlockTimeSec
    : (r.verifiedBlockTimeSec ?? r.notifiedBlockTimeSec);
  if (d.notifiedSlot !== refSlot) return "SLOT_CONFLICT";
  if (d.notifiedBlockTimeSec !== null && refBt !== null && d.notifiedBlockTimeSec !== refBt) {
    return "BLOCK_TIME_CONFLICT";
  }
  return "AGREES";
}

/** The ledger's per-receiving-epoch aggregate conflict, over the given details. */
function detailsConflict(r: LedgerRecord, details: readonly CpmmDuplicateOccurrence[]): boolean {
  const refSlot = r.verifiedSlot ?? r.notifiedSlot;
  const refBt = r.verifiedBlockTimeSec ?? r.notifiedBlockTimeSec;
  const byEpoch = new Map<number, CpmmDuplicateOccurrence[]>();
  for (const d of details) byEpoch.set(d.epoch, [...(byEpoch.get(d.epoch) ?? []), d]);
  for (const group of byEpoch.values()) {
    if (group.some((d) => d.notifiedSlot !== refSlot)) return true;
    const bts = group.map((d) => d.notifiedBlockTimeSec).filter((b): b is number => b !== null);
    if (bts.length === 0) continue;
    if (bts.some((b) => b !== bts[0])) return true;
    if (refBt !== null && bts[0] !== refBt) return true;
  }
  return false;
}

/** A settlement in its status-specific shape (the recorder's fields; absent ones null). */
function settlementShapeValid(s: Record<string, unknown>): boolean {
  if (!positiveInt(s.call)) return false;
  const nulls = (...keys: string[]) => keys.every((k) => s[k] === null);
  if (s.outcome === "REJECTED") {
    return nulls(
      "status",
      "occurrence",
      "recordSequence",
      "signature",
      "disposition",
      "factKind",
      "factCode",
      "firstSequence",
      "code",
    );
  }
  if (s.outcome !== "FULFILLED" || !ACCOUNT_RESULT_STATUSES.has(s.status)) return false;
  if (!positiveInt(s.occurrence)) return false;
  switch (s.status) {
    case "RECORDED":
      return (
        positiveInt(s.recordSequence) &&
        isValidSolanaSignature(s.signature) &&
        LEDGER_DISPOSITIONS.has(s.disposition) &&
        s.disposition !== "PENDING" &&
        codeOrNull(s.factKind) &&
        codeOrNull(s.factCode) &&
        nulls("firstSequence", "code")
      );
    case "DUPLICATE":
      return (
        positiveInt(s.firstSequence) &&
        nulls("recordSequence", "signature", "disposition", "factKind", "factCode", "code")
      );
    default:
      return (
        (s.status === "INVALID" ? INVALID_CODES : CAPACITY_CODES).has(s.code) &&
        nulls("recordSequence", "signature", "disposition", "factKind", "factCode", "firstSequence")
      );
  }
}

/** A recorded account() call: fields in the recorder's domains (envelope fields may be null). */
const ledgerCallShapeValid = (c: Record<string, unknown>): boolean =>
  positiveInt(c.call) &&
  (c.signature === null || typeof c.signature === "string") &&
  nullOrInt(c.epoch) &&
  (c.hostReceivedAtMs === null ||
    (typeof c.hostReceivedAtMs === "number" && Number.isFinite(c.hostReceivedAtMs))) &&
  (c.outcome === "RETURNED" || c.outcome === "THREW" || c.outcome === "IN_PROGRESS") &&
  (c.outcome === "IN_PROGRESS" ? c.endOrdinal === null : isInt(c.endOrdinal));

const EMPTY_LEDGER_CHECKED: CpmmLedgerStructuralCheck["checked"] = Object.freeze({
  records: 0,
  epochs: 0,
  accountCalls: 0,
  settlements: 0,
  duplicateDetails: 0,
  eventTotalsCorroborated: 0,
  verifiedMetadataCorroborated: 0,
});
const NO_LEDGER_COVERAGE: CpmmLedgerStructuralCheck["coverage"] = Object.freeze({
  epochTotals: false,
  callTotals: false,
  duplicateDetails: false,
  eventMetadata: false,
});

function ledgerResult(
  f: Findings,
  checked: CpmmLedgerStructuralCheck["checked"],
  coverage: CpmmLedgerStructuralCheck["coverage"],
): CpmmLedgerStructuralCheck {
  return {
    status:
      f.status === "REPRODUCED"
        ? "STRUCTURALLY_CONSISTENT"
        : f.status === "MISMATCH"
          ? "MISMATCH"
          : "MISSING_EVIDENCE",
    scope: "RECORDED_LEDGER_STRUCTURE_ONLY",
    ledgerReplayed: false,
    ingestionReplayed: false,
    findings: f.list,
    checked: { ...checked },
    coverage: { ...coverage },
  };
}

/**
 * Structural cross-checks of the recorded ledger (item G, partial), over the validated documents
 * only: no ledger, session, adapter or tracker is constructed, and nothing is ingested.
 * - records, epochs and counters in the accepted ledger's schemas, domains and enums; dense
 *   sequences, unique signatures and epochs; the classification each fact maps to; verified
 *   metadata; ingestion accounting (indeterminate counts included); per-epoch identities and the
 *   ledger-wide counters against them and the records;
 * - account calls and settlements in their status-specific shapes (RECORDED, DUPLICATE, INVALID,
 *   CAPACITY_REFUSED), each referencing the occurrence, record and duplicate detail it names, with
 *   settlement and record agreeing on the terminal state they both describe;
 * - duplicate details against the state at their receipt (a first occurrence then PENDING may be
 *   final now), never blindly against the final state; truncated details never prove an absence;
 * - ingestion totals against independently decoded event counts where a matched analysis exists
 *   (corroboration of the recorded total only, never of tracker acceptance).
 * Pending work, dropped or unrecorded calls, saturation and unavailable sections are missing
 * evidence and narrow the exact checks (`coverage`); what is still known is still checked.
 */
function checkLedgerStructure(
  docs: Map<string, Record<string, unknown>>,
  decodedEvents: ReadonlyMap<string, DecodedSwapEvents>,
): CpmmLedgerStructuralCheck {
  const f = new Findings();
  const doc = docs.get(CPMM_EVIDENCE_FILES.ledger);
  const section = (name: string): unknown =>
    get(doc, name, "status") === "READ" ? get(doc, name, "value") : undefined;
  const recordsIn = section("records") as unknown[] | undefined;
  const epochsIn = section("epochs") as unknown[] | undefined;
  const countersIn = section("counters");
  if (recordsIn === undefined) f.add("MISSING_EVIDENCE", "LEDGER_RECORDS_UNAVAILABLE");
  if (epochsIn === undefined) f.add("MISSING_EVIDENCE", "LEDGER_EPOCHS_UNAVAILABLE");
  if (countersIn === undefined) f.add("MISSING_EVIDENCE", "LEDGER_COUNTERS_UNAVAILABLE");
  const calls = (get(doc, "calls") ?? []) as Record<string, unknown>[];
  const recording = docs.get(CPMM_EVIDENCE_FILES.recording);
  const plan = get(docs.get(CPMM_EVIDENCE_FILES.plan), "plan");
  const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

  // The plan's ledger limits (asserted by the plan; a ledger exceeding them contradicts it).
  const limitsIn = get(plan, "limits", "ledger");
  const limits =
    isRec(limitsIn) &&
    sameKeys(limitsIn, LEDGER_LIMIT_KEYS) &&
    LEDGER_LIMIT_KEYS.every((k) => positiveInt(limitsIn[k]))
      ? (limitsIn as unknown as CpmmLedgerLimits)
      : null;
  if (limits === null) f.add("MISSING_EVIDENCE", "LEDGER_LIMITS_UNAVAILABLE");

  // Counters. Saturated counts are no longer exact: equalities are then not checked.
  let counters: CpmmLedgerCounters | null = null;
  if (countersIn !== undefined) {
    if (
      isRec(countersIn) &&
      sameKeys(countersIn, LEDGER_COUNTER_KEYS) &&
      LEDGER_COUNTER_KEYS.every((k) =>
        k === "saturated" ? typeof countersIn[k] === "boolean" : isInt(countersIn[k]),
      )
    ) {
      counters = countersIn as unknown as CpmmLedgerCounters;
    } else f.add("MISMATCH", "LEDGER_COUNTERS_MALFORMED");
  }
  if (counters?.saturated === true) f.add("MISSING_EVIDENCE", "LEDGER_COUNTERS_SATURATED");
  const exact = counters !== null && !counters.saturated;
  if (
    counters !== null &&
    (counters.epochCapacityRefused > counters.unattributedOccurrences ||
      (counters.epochCapacityRefused > 0 && counters.openEpochRefused === 0))
  ) {
    f.add("MISMATCH", "LEDGER_COUNTER_TOTALS");
  }

  // Epochs: opened in strictly increasing order; only the newest can still be open.
  const epochs: CpmmEpochAccounting[] = [];
  let epochsUsable = epochsIn !== undefined;
  for (const e of epochsIn ?? []) {
    const dup = get(e, "duplicates");
    const inv = get(e, "invalid");
    if (
      isRec(e) &&
      sameKeys(e, LEDGER_EPOCH_KEYS) &&
      isInt(e.epoch) &&
      positiveInt(e.observationStartMs) &&
      EPOCH_STATES.has(e.state) &&
      isInt(e.occurrences) &&
      isInt(e.firstOccurrences) &&
      isInt(e.capacityRefused) &&
      isRec(dup) &&
      sameKeys(dup, ["sameEpoch", "crossEpoch"]) &&
      isInt(dup.sameEpoch) &&
      isInt(dup.crossEpoch) &&
      isRec(inv) &&
      sameKeys(inv, CPMM_INVALID_CODES) &&
      CPMM_INVALID_CODES.every((c) => isInt(inv[c]))
    ) {
      epochs.push(e as unknown as CpmmEpochAccounting);
    } else {
      f.add("MISMATCH", "LEDGER_EPOCH_MALFORMED");
      epochsUsable = false;
    }
  }
  if (epochs.some((e, i) => i > 0 && e.epoch <= epochs[i - 1]!.epoch)) {
    f.add("MISMATCH", "LEDGER_EPOCH_ORDER");
    epochsUsable = false;
  }
  if (epochs.some((e, i) => i < epochs.length - 1 && e.state === "OPEN")) {
    f.add("MISMATCH", "LEDGER_EPOCH_STATE");
  }
  if (limits !== null && (epochsIn?.length ?? 0) > limits.maxEpochs) {
    f.add("MISMATCH", "LEDGER_LIMIT_EXCEEDED");
  }
  const invalidOf = (e: CpmmEpochAccounting, codes: readonly string[]): number =>
    sum(codes.map((c) => e.invalid[c as keyof CpmmEpochAccounting["invalid"]]));
  if (exact) {
    for (const e of epochs) {
      const parts =
        e.firstOccurrences +
        e.duplicates.sameEpoch +
        e.duplicates.crossEpoch +
        invalidOf(e, CPMM_INVALID_CODES) +
        e.capacityRefused;
      if (e.occurrences !== parts) f.add("MISMATCH", "LEDGER_EPOCH_TOTALS");
    }
  }
  if (epochs.some((e) => invalidOf(e, NEVER_ATTRIBUTED_INVALID_CODES) !== 0)) {
    f.add("MISMATCH", "LEDGER_EPOCH_TOTALS");
  }
  const epochByNumber = new Map(epochs.map((e) => [e.epoch, e]));

  // Records: dense sequences in creation order, unique signatures, known epochs.
  const records: LedgerRecord[] = [];
  let recordsUsable = recordsIn !== undefined;
  for (const [i, r] of (recordsIn ?? []).entries()) {
    if (!ledgerRecordSchemaValid(r)) {
      f.add("MISMATCH", "LEDGER_RECORD_MALFORMED");
      recordsUsable = false;
      continue;
    }
    if (!r.duplicateDetails.every(duplicateDetailValid)) {
      f.add("MISMATCH", "LEDGER_DUPLICATE_DETAIL_MALFORMED");
      recordsUsable = false;
      continue;
    }
    if (r.sequence !== i + 1) f.add("MISMATCH", "LEDGER_RECORD_SEQUENCE");
    records.push(r);
  }
  const perSignature = new Map<string, number>();
  for (const r of records) perSignature.set(r.signature, (perSignature.get(r.signature) ?? 0) + 1);
  if ([...perSignature.values()].some((n) => n > 1)) f.add("MISMATCH", "LEDGER_RECORD_AMBIGUOUS");
  const perSequence = new Map<number, LedgerRecord[]>();
  for (const r of records) perSequence.set(r.sequence, [...(perSequence.get(r.sequence) ?? []), r]);
  /** The single record of a sequence, or undefined (absent or ambiguous). */
  const recordAt = (seq: unknown): LedgerRecord | undefined => {
    const list = perSequence.get(seq as number);
    return list?.length === 1 ? list[0] : undefined;
  };
  // An unresolvable reference is a contradiction only when every record is present and valid.
  const recordsComplete = recordsIn !== undefined && recordsUsable;
  if (limits !== null && (recordsIn?.length ?? 0) > limits.maxSignatureRecords) {
    f.add("MISMATCH", "LEDGER_LIMIT_EXCEEDED");
  }

  let detailsSeen = 0;
  let corroborated = 0;
  let metadataCorroborated = 0;
  let metadataUncorroborated = false;
  let anyTruncated = false;
  const detailOwner = new Map<number, LedgerRecord>();
  const retainedSame = new Map<number, number>();
  const retainedCross = new Map<number, number>();
  let previousEpoch = -1;
  for (const r of records) {
    if (epochsUsable) {
      const ep = epochByNumber.get(r.epoch);
      if (ep === undefined || r.hostReceivedAtMs < ep.observationStartMs) {
        f.add("MISMATCH", "LEDGER_RECORD_EPOCH");
      }
    }
    // A record is created only in the open epoch, and epochs only increase.
    if (r.epoch < previousEpoch) f.add("MISMATCH", "LEDGER_RECORD_EPOCH");
    previousEpoch = Math.max(previousEpoch, r.epoch);
    if (!classificationValid(r)) f.add("MISMATCH", "LEDGER_CLASSIFICATION");
    if (!verifiedMetadataValid(r)) f.add("MISMATCH", "LEDGER_VERIFIED_METADATA");
    if (!ingestionValid(r)) f.add("MISMATCH", "LEDGER_INGESTION_ACCOUNTING");
    if (r.disposition === "PENDING") f.add("MISSING_EVIDENCE", "LEDGER_RECORD_PENDING");
    // Decoded event counts: the recorded total only (acceptance is never proven here).
    const decoded = r.factKind === "RESOLVED_SWAPS" ? decodedEvents.get(r.signature) : undefined;
    if (
      decoded !== undefined &&
      (r.ingestion.total !== 0 ||
        r.disposition === "INGESTED" ||
        r.disposition === "INGESTION_INCOMPLETE")
    ) {
      if (r.ingestion.total === decoded.count) corroborated++;
      else f.add("MISMATCH", "LEDGER_EVENT_TOTAL");
    }
    // Verified metadata the ledger took from a bound swap's events (positioned outcomes use the
    // notification, exceptions and other outcomes null): it must be the decoded events' own.
    if (
      r.factKind === "RESOLVED_SWAPS" &&
      (r.disposition === "INGESTED" ||
        (r.disposition === "INGESTION_INCOMPLETE" && r.blockingClass !== "ACCOUNTING_EXCEPTION"))
    ) {
      if (decoded === undefined) {
        metadataUncorroborated = true;
        f.add("MISSING_EVIDENCE", "LEDGER_EVENT_METADATA_UNCORROBORATED");
      } else if (
        (r.verifiedSlot !== null && r.verifiedSlot !== decoded.slot) ||
        (r.verifiedBlockTimeSec !== null && r.verifiedBlockTimeSec !== decoded.blockTimeSec)
      ) {
        f.add("MISMATCH", "LEDGER_EVENT_METADATA");
      } else if (r.verifiedSlot !== null && r.verifiedBlockTimeSec !== null) {
        metadataCorroborated++;
      }
    }

    // Duplicates: exact counts, the first details only, and their receipt-time view.
    const details = r.duplicateDetails;
    detailsSeen += details.length;
    if (
      details.length > r.duplicateOccurrences ||
      r.duplicateDetailsDropped !== r.duplicateOccurrences - details.length ||
      (limits !== null &&
        (details.length > limits.maxDuplicateDetailsPerRecord ||
          (r.duplicateDetailsDropped > 0 &&
            details.length !== limits.maxDuplicateDetailsPerRecord)))
    ) {
      f.add("MISMATCH", "LEDGER_DUPLICATE_RETENTION");
    }
    const truncated = r.duplicateDetailsDropped > 0;
    if (truncated) {
      anyTruncated = true;
      f.add("MISSING_EVIDENCE", "LEDGER_DUPLICATE_DETAILS_TRUNCATED");
    }
    let terminalSeen = false;
    let previousOccurrence = 0;
    for (const d of details) {
      if (detailOwner.has(d.occurrence)) f.add("MISMATCH", "LEDGER_OCCURRENCE_REFERENCE");
      detailOwner.set(d.occurrence, r);
      const ep = epochsUsable ? epochByNumber.get(d.epoch) : undefined;
      if (
        d.occurrence <= previousOccurrence ||
        d.epoch < r.epoch ||
        (epochsUsable && (ep === undefined || d.hostReceivedAtMs < ep.observationStartMs))
      ) {
        f.add("MISMATCH", "LEDGER_DUPLICATE_DETAIL");
      }
      previousOccurrence = d.occurrence;
      // The single PENDING-to-terminal transition: PENDING, then only the final disposition.
      const atReceipt = d.firstDispositionAtReceipt;
      if (
        (atReceipt !== "PENDING" && atReceipt !== r.disposition) ||
        (atReceipt === "PENDING" && terminalSeen)
      ) {
        f.add("MISMATCH", "LEDGER_DUPLICATE_TIMING");
      }
      if (atReceipt !== "PENDING") terminalSeen = true;
      if (d.agreement !== expectedAgreement(r, d)) f.add("MISMATCH", "LEDGER_DUPLICATE_AGREEMENT");
      const tally = d.epoch === r.epoch ? retainedSame : retainedCross;
      tally.set(d.epoch, (tally.get(d.epoch) ?? 0) + 1);
    }
    // The conflict flag comes from exact aggregates: retained details can prove a conflict, and
    // complete details decide it; truncated details never prove its absence.
    const visible = detailsConflict(r, details);
    if (truncated ? visible && !r.metadataConflict : visible !== r.metadataConflict) {
      f.add("MISMATCH", "LEDGER_METADATA_CONFLICT");
    }
  }

  // Ledger-wide and per-epoch totals, exact where nothing is saturated.
  const epochTotals = exact && epochsUsable && recordsComplete;
  if (exact && epochsUsable) {
    const c = counters!;
    if (
      c.occurrences !== sum(epochs.map((e) => e.occurrences)) + c.unattributedOccurrences ||
      c.recordCapacityRefused !== sum(epochs.map((e) => e.capacityRefused))
    ) {
      f.add("MISMATCH", "LEDGER_COUNTER_TOTALS");
    }
  }
  if (epochTotals) {
    const duplicatesTotal = sum(records.map((r) => r.duplicateOccurrences));
    if (
      sum(epochs.map((e) => e.firstOccurrences)) !== records.length ||
      sum(epochs.map((e) => e.duplicates.sameEpoch + e.duplicates.crossEpoch)) !== duplicatesTotal
    ) {
      f.add("MISMATCH", "LEDGER_EPOCH_TOTALS");
    }
    const fitsRetained = (retained: number, total: number) =>
      anyTruncated ? retained <= total : retained === total;
    for (const e of epochs) {
      if (
        e.firstOccurrences !== records.filter((r) => r.epoch === e.epoch).length ||
        !fitsRetained(retainedSame.get(e.epoch) ?? 0, e.duplicates.sameEpoch) ||
        !fitsRetained(retainedCross.get(e.epoch) ?? 0, e.duplicates.crossEpoch) ||
        (e.duplicates.crossEpoch > 0 && !records.some((r) => r.epoch < e.epoch))
      ) {
        f.add("MISMATCH", "LEDGER_EPOCH_TOTALS");
      }
    }
  }

  // Account calls and settlements. Absent or incomplete recording narrows the exact checks.
  const ledgerRecorded = get(recording, "ledgerRecorded") === true;
  const dropped = get(recording, "retention", "ledgerCalls", "dropped") !== 0;
  const failures = get(recording, "instrumentation", "retainedFailures");
  const instrumentationGap =
    get(recording, "instrumentation", "droppedFailureRecords") !== 0 ||
    !Array.isArray(failures) ||
    failures.some((x) => get(x, "layer") === "LEDGER");
  const inProgress = get(recording, "pending", "accountCallsInProgress") !== 0;
  const settlementsPending = get(recording, "pending", "accountSettlementsPending") !== 0;
  if (!ledgerRecorded) f.add("MISSING_EVIDENCE", "LEDGER_CALLS_NOT_RECORDED");
  else {
    if (dropped) f.add("MISSING_EVIDENCE", "LEDGER_CALLS_DROPPED");
    if (instrumentationGap) f.add("MISSING_EVIDENCE", "LEDGER_INSTRUMENTATION_INCOMPLETE");
    if (inProgress) f.add("MISSING_EVIDENCE", "ACCOUNT_CALL_IN_PROGRESS");
    if (settlementsPending) f.add("MISSING_EVIDENCE", "LEDGER_SETTLEMENTS_PENDING");
  }
  const callsComplete = ledgerRecorded && !dropped && !instrumentationGap;
  const settlementsComplete = callsComplete && !inProgress && !settlementsPending;

  const callRecords = calls.filter((c) => c.kind === "ACCOUNT_CALL");
  const settlementRecords = calls.filter((c) => c.kind === "ACCOUNT_SETTLEMENT");
  const callByNumber = new Map<unknown, Record<string, unknown>>();
  const ambiguousCalls = new Set<unknown>();
  for (const c of callRecords) {
    if (!ledgerCallShapeValid(c)) f.add("MISMATCH", "ACCOUNT_CALL_MALFORMED");
    if (callByNumber.has(c.call)) {
      f.add("MISMATCH", "ACCOUNT_CALL_AMBIGUOUS");
      ambiguousCalls.add(c.call);
    }
    callByNumber.set(c.call, c);
  }
  const settled = new Set<unknown>();
  /** Each record's RECORDED settlement ordinal (the recorder's single, global order). */
  const recordedOrdinal = new Map<number, unknown>();
  const statusCount = new Map<unknown, number>();
  const codeCount = new Map<unknown, number>();
  const recordedFor = new Map<number, number>();
  const duplicateFor = new Map<number, number>();
  const matchedDetails = new Set<number>();
  for (const s of settlementRecords) {
    if (!settlementShapeValid(s)) {
      f.add("MISMATCH", "ACCOUNT_SETTLEMENT_MALFORMED");
      continue;
    }
    // The accepted ledger's account() never rejects.
    if (s.outcome === "REJECTED") {
      f.add("MISMATCH", "ACCOUNT_SETTLEMENT_REJECTED");
      continue;
    }
    if (settled.has(s.call)) {
      f.add("MISMATCH", "ACCOUNT_SETTLEMENT_AMBIGUOUS");
      continue;
    }
    settled.add(s.call);
    statusCount.set(s.status, (statusCount.get(s.status) ?? 0) + 1);
    if (s.code !== null) codeCount.set(s.code, (codeCount.get(s.code) ?? 0) + 1);
    // A settlement belongs to a single call that returned its promise.
    const ambiguousCall = ambiguousCalls.has(s.call);
    const call = ambiguousCall ? undefined : callByNumber.get(s.call);
    if (call === undefined ? callsComplete && !ambiguousCall : call.outcome !== "RETURNED") {
      f.add("MISMATCH", "ACCOUNT_SETTLEMENT_ORPHANED");
    }
    // Every account() call is one ledger occurrence, numbered alike.
    if (ledgerRecorded && s.occurrence !== s.call) f.add("MISMATCH", "LEDGER_OCCURRENCE_REFERENCE");
    if (s.status === "RECORDED") {
      const r = recordAt(s.recordSequence);
      if (r === undefined) {
        if (recordsComplete) f.add("MISMATCH", "LEDGER_RECORD_REFERENCE");
        continue;
      }
      recordedFor.set(r.sequence, (recordedFor.get(r.sequence) ?? 0) + 1);
      recordedOrdinal.set(r.sequence, s.ordinal);
      if (
        s.signature !== r.signature ||
        (call !== undefined &&
          (call.signature !== r.signature ||
            call.epoch !== r.epoch ||
            call.hostReceivedAtMs !== r.hostReceivedAtMs))
      ) {
        f.add("MISMATCH", "LEDGER_RECORD_REFERENCE");
      }
      // Both describe the terminal state, which never changes after the transition.
      if (
        s.disposition !== r.disposition ||
        s.factKind !== r.factKind ||
        s.factCode !== r.factCode
      ) {
        f.add("MISMATCH", "LEDGER_SETTLEMENT_STATE");
      }
      if (r.duplicateDetails.some((d) => d.occurrence <= (s.occurrence as number))) {
        f.add("MISMATCH", "LEDGER_DUPLICATE_DETAIL");
      }
    } else if (s.status === "DUPLICATE") {
      const r = recordAt(s.firstSequence);
      if (r === undefined) {
        if (recordsComplete) f.add("MISMATCH", "LEDGER_RECORD_REFERENCE");
        continue;
      }
      duplicateFor.set(r.sequence, (duplicateFor.get(r.sequence) ?? 0) + 1);
      if (
        call !== undefined &&
        (call.signature !== r.signature || (isInt(call.epoch) && call.epoch < r.epoch))
      ) {
        f.add("MISMATCH", "LEDGER_RECORD_REFERENCE");
      }
      const detail = r.duplicateDetails.find((d) => d.occurrence === s.occurrence);
      if (detail !== undefined) {
        matchedDetails.add(detail.occurrence);
        if (
          call !== undefined &&
          (detail.epoch !== call.epoch || detail.hostReceivedAtMs !== call.hostReceivedAtMs)
        ) {
          f.add("MISMATCH", "LEDGER_DUPLICATE_DETAIL");
        }
      } else {
        // The first details are retained: an earlier occurrence missing from them is not dropped.
        const last = r.duplicateDetails[r.duplicateDetails.length - 1]?.occurrence ?? 0;
        if (r.duplicateDetailsDropped === 0 || (s.occurrence as number) < last) {
          f.add("MISMATCH", "LEDGER_DUPLICATE_DETAIL");
        }
      }
    } else if (s.status === "CAPACITY_REFUSED") {
      // Record capacity refuses a new signature only, once the record list is full; epoch
      // capacity follows a refused openEpoch() with every retained epoch in use.
      const contradicted =
        s.code === "RECORD_CAPACITY"
          ? (call !== undefined && perSignature.has(call.signature as string)) ||
            (limits !== null && recordsComplete && records.length !== limits.maxSignatureRecords)
          : (limits !== null && epochsUsable && epochs.length !== limits.maxEpochs) ||
            (counters !== null && counters.openEpochRefused === 0);
      if (contradicted) f.add("MISMATCH", "LEDGER_CAPACITY");
    }
  }
  if (records.some((r) => (duplicateFor.get(r.sequence) ?? 0) > r.duplicateOccurrences)) {
    f.add("MISMATCH", "LEDGER_CALL_TOTALS");
  }
  if ([...recordedFor.values()].some((n) => n > 1)) f.add("MISMATCH", "LEDGER_RECORD_REFERENCE");
  // Receipt-state causality, in the recorder's order: the terminal state is written before the
  // RECORDED settlement is observed, and a duplicate's detail during its own account() call. So a
  // duplicate call recorded after that settlement saw the final state, never PENDING. The
  // converse is not inferred: a call before the settlement may still have seen either.
  if (ledgerRecorded) {
    for (const r of records) {
      const settledAt = recordedFor.get(r.sequence) === 1 ? recordedOrdinal.get(r.sequence) : null;
      if (!isInt(settledAt)) continue;
      for (const d of r.duplicateDetails) {
        const call = ambiguousCalls.has(d.occurrence) ? undefined : callByNumber.get(d.occurrence);
        if (
          d.firstDispositionAtReceipt === "PENDING" &&
          call !== undefined &&
          call.signature === r.signature &&
          isInt(call.ordinal) &&
          call.ordinal > settledAt
        ) {
          f.add("MISMATCH", "LEDGER_DUPLICATE_CAUSALITY");
        }
      }
    }
  }
  if (settlementsComplete && recordsComplete) {
    // Each record settled once as RECORDED; each retained duplicate detail as a DUPLICATE.
    if (
      records.some((r) => !recordedFor.has(r.sequence)) ||
      [...detailOwner.keys()].some((o) => !matchedDetails.has(o))
    ) {
      f.add("MISMATCH", "LEDGER_RECORD_REFERENCE");
    }
  }

  // Calls and settlements against the ledger's counts: never more than counted, and exactly as
  // many when nothing was dropped, pending, in progress or unrecorded.
  const callTotals = settlementsComplete && exact && epochsUsable && recordsComplete;
  if (exact && epochsUsable && ledgerRecorded) {
    const c = counters!;
    const fits = (n: number, total: number, complete: boolean) =>
      complete ? n === total : n <= total;
    const n = (key: string, from: Map<unknown, number>) => from.get(key) ?? 0;
    const attributedOnly = CPMM_INVALID_CODES.filter((k) => !UNATTRIBUTABLE_INVALID_CODES.has(k));
    const attributable = CPMM_INVALID_CODES.filter((k) => UNATTRIBUTABLE_INVALID_CODES.has(k));
    const epochInvalid = (codes: readonly string[]) => sum(epochs.map((e) => invalidOf(e, codes)));
    const ok =
      fits(callRecords.length, c.occurrences, callsComplete) &&
      // Every record present counts, a malformed one too; unread records bound nothing.
      (recordsIn === undefined ||
        fits(
          n("RECORDED", statusCount),
          recordsIn.length,
          settlementsComplete && recordsComplete,
        )) &&
      fits(
        n("DUPLICATE", statusCount),
        sum(epochs.map((e) => e.duplicates.sameEpoch + e.duplicates.crossEpoch)),
        settlementsComplete,
      ) &&
      attributedOnly.every((k) => fits(n(k, codeCount), epochInvalid([k]), settlementsComplete)) &&
      fits(
        sum(attributable.map((k) => n(k, codeCount))),
        epochInvalid(attributable) + c.unattributedOccurrences - c.epochCapacityRefused,
        settlementsComplete,
      ) &&
      fits(n("RECORD_CAPACITY", codeCount), c.recordCapacityRefused, settlementsComplete) &&
      fits(n("EPOCH_CAPACITY", codeCount), c.epochCapacityRefused, settlementsComplete);
    if (!ok) f.add("MISMATCH", "LEDGER_CALL_TOTALS");
  }

  return ledgerResult(
    f,
    {
      records: records.length,
      epochs: epochs.length,
      accountCalls: callRecords.length,
      settlements: settlementRecords.length,
      duplicateDetails: detailsSeen,
      eventTotalsCorroborated: corroborated,
      verifiedMetadataCorroborated: metadataCorroborated,
    },
    {
      epochTotals,
      callTotals,
      duplicateDetails: recordsComplete && !anyTruncated,
      eventMetadata: recordsComplete && !metadataUncorroborated,
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Owner and wrapper structure (item G, partial): the report, the wrapper's diagnostics and the
// decorator's records, by phase
// ---------------------------------------------------------------------------------------------

type TransportRecord = Record<string, unknown> & { readonly ordinal: number };

const OWNER_LATE_KEYS = [
  "open",
  "message",
  "error",
  "close",
  "ping",
  "pong",
  "localCompletion",
  "accountSettlement",
  "timer",
  "abort",
  "sessionStop",
] as const;
const OWNER_EVENTS = ["open", "message", "error", "close", "ping", "pong"] as const;
const LOCAL_OUTCOMES: ReadonlySet<unknown> = new Set([
  "NOT_ATTEMPTED",
  "THREW",
  "COMPLETED",
  "FAILED",
  "UNRESOLVED",
]);
const OBSERVED_OUTCOMES: ReadonlySet<unknown> = new Set([
  "NOT_OBSERVED",
  "ACKNOWLEDGED",
  "REJECTED",
  "MALFORMED",
]);
const CLEANUP_STATUSES: ReadonlySet<unknown> = new Set([
  "NOT_NEEDED",
  "DISPOSED_UNSTARTED",
  "DISPOSE_FAILED",
  "SETTLED",
  "SETTLED_AFTER_TERMINATE",
  "FAILED_STILL_OPEN",
]);
const CONTROL_ATTEMPT_KEYS = ["reserved", "threw", "completed", "failed", "unresolved"] as const;
const DEADLINE_KEYS = [
  "startedAtMs",
  "ackDeadlineMs",
  "nominalEndMs",
  "intakeEndMs",
  "drainDeadlineMs",
  "runCeilingMs",
  "sessionDeadlineMs",
] as const;

/**
 * The owner's `observed` value for each response frame the accepted collector classifies, and the
 * collector states consistent with each value.
 */
const RESPONSE_OBSERVATIONS: readonly [
  "subscribe" | "unsubscribe",
  "SUBSCRIBE" | "UNSUBSCRIBE",
  Readonly<Record<string, readonly string[]>>,
][] = [
  [
    "subscribe",
    "SUBSCRIBE",
    {
      ACKNOWLEDGED: ["ACKNOWLEDGED"],
      REJECTED: ["REJECTED"],
      MALFORMED: ["MALFORMED_RESPONSE"],
      NOT_OBSERVED: ["AWAITING_ACK"],
    },
  ],
  [
    "unsubscribe",
    "UNSUBSCRIBE",
    {
      ACKNOWLEDGED: ["ACKNOWLEDGED"],
      REJECTED: ["REJECTED"],
      MALFORMED: ["BUILT_UNOBSERVED"],
      NOT_OBSERVED: ["NOT_BUILT", "BUILT_UNOBSERVED"],
    },
  ],
];

/**
 * The owner's application sends in order: the subscribe first when it was attempted, then the
 * unsubscribe. A subscribe never attempted (answered before the socket opened) has no send.
 */
function applicationSends(
  report: Record<string, unknown>,
  sends: readonly TransportRecord[],
): { subscribe: TransportRecord | undefined; unsubscribe: TransportRecord | undefined } {
  const subscribed = get(report, "outgoing", "subscribe", "local") !== "NOT_ATTEMPTED";
  return {
    subscribe: subscribed ? sends[0] : undefined,
    unsubscribe: sends[subscribed ? 1 : 0],
  };
}

/** The observation a collector frame establishes for one request, or null. */
function observationOf(prefix: "SUBSCRIBE" | "UNSUBSCRIBE", fr: unknown): string | null {
  const disposition = get(fr, "disposition");
  if (disposition === `${prefix}_ACKNOWLEDGED`) return "ACKNOWLEDGED";
  if (disposition === `${prefix}_REJECTED`) return "REJECTED";
  if (disposition === "MALFORMED_MESSAGE" && get(fr, "code") === `${prefix}_RESPONSE_SHAPE`) {
    return "MALFORMED";
  }
  return null;
}

const intOrNull = (v: unknown): boolean => v === null || isInt(v);
const allInts = (o: unknown, keys: readonly string[]): boolean =>
  isRec(o) && keys.every((k) => isInt(o[k]));

/** The owner report's fields used here, in their domains (structure only). */
function ownerReportValid(r: unknown): boolean {
  if (!isRec(r)) return false;
  const attempt = (a: unknown) =>
    isRec(a) &&
    typeof a.prepared === "boolean" &&
    intOrNull(a.reservedAtMs) &&
    LOCAL_OUTCOMES.has(a.local) &&
    intOrNull(a.localAtMs) &&
    OBSERVED_OUTCOMES.has(a.observed);
  const o = r.outgoing;
  const t = r.transport;
  const c = r.cleanup;
  const d = r.deadlines;
  return (
    isInt(r.settledAtMs) &&
    isInt(get(r, "terminal", "atMs")) &&
    Array.isArray(r.uncertainties) &&
    (d === null || allInts(d, DEADLINE_KEYS)) &&
    allInts(r.incoming, [
      "messageEvents",
      "passedToCollector",
      "messagesBeforeStart",
      "pingsReceived",
      "pongsReceived",
      "controlFrames",
    ]) &&
    isRec(r.intake) &&
    intOrNull(r.intake.stoppedAtMs) &&
    allInts(r.intake, ["framesAfterIntake", "controlFramesAfterIntake"]) &&
    isRec(t) &&
    typeof t.constructed === "boolean" &&
    typeof t.started === "boolean" &&
    intOrNull(t.openedAtMs) &&
    allInts(t, ["eventsBeforeStart", "disposeFailures"]) &&
    isRec(o) &&
    attempt(o.subscribe) &&
    attempt(o.unsubscribe) &&
    allInts(o, [
      "applicationFramesReserved",
      "pongsMatched",
      "pongsUnmatched",
      "duplicateCompletions",
    ]) &&
    allInts(o.pings, CONTROL_ATTEMPT_KEYS) &&
    allInts(o.pongReplies, CONTROL_ATTEMPT_KEYS) &&
    isRec(c) &&
    CLEANUP_STATUSES.has(c.status) &&
    intOrNull(c.startedAtMs) &&
    intOrNull(c.endedAtMs) &&
    typeof c.closeThrew === "boolean" &&
    typeof c.terminateAttempted === "boolean" &&
    typeof c.terminateThrew === "boolean" &&
    intOrNull(c.closeCode) &&
    intOrNull(c.closeObservedAtMs) &&
    intOrNull(get(r, "cancellation", "requestedAtMs"))
  );
}

/** The wrapper diagnostics' fields used here, in their domains. */
function wrapperDiagnosticsValid(w: unknown): boolean {
  return (
    isRec(w) &&
    isInt(get(w, "messages", "delivered")) &&
    allInts(w.control, ["pingsDelivered", "pongsDelivered"]) &&
    isRec(w.close) &&
    typeof w.close.observed === "boolean" &&
    intOrNull(w.close.rawCode) &&
    intOrNull(w.close.deliveredCode) &&
    allInts(w.completions, ["completed", "failed", "duplicate", "doneThrew"]) &&
    allInts(w.callsThrew, ["send", "ping", "pong", "close", "terminate"]) &&
    isInt(w.ownerListenerThrew)
  );
}

const EMPTY_OWNER_WRAPPER_CHECKED: CpmmOwnerWrapperStructuralCheck["checked"] = Object.freeze({
  transportRecords: 0,
  wrapperObservedEvents: 0,
  ownerReceivedEvents: 0,
  wrapperOnlyEvents: 0,
  outgoingCalls: 0,
  completions: 0,
  afterSettlementRecords: 0,
});
const NO_OWNER_WRAPPER_COVERAGE: CpmmOwnerWrapperStructuralCheck["coverage"] = Object.freeze({
  wrapper: false,
  ownerIncoming: false,
  ownerOutgoing: false,
  cleanup: false,
  timing: false,
});

function ownerWrapperResult(
  f: Findings,
  checked: CpmmOwnerWrapperStructuralCheck["checked"],
  boundary: number | null,
  coverage: CpmmOwnerWrapperStructuralCheck["coverage"],
): CpmmOwnerWrapperStructuralCheck {
  return {
    status:
      f.status === "REPRODUCED"
        ? "STRUCTURALLY_CONSISTENT"
        : f.status === "MISMATCH"
          ? "MISMATCH"
          : "MISSING_EVIDENCE",
    scope: "RECORDED_OWNER_WRAPPER_STRUCTURE_ONLY",
    ownerReplayed: false,
    wrapperReplayed: false,
    findings: f.list,
    checked: { ...checked },
    settlementBoundaryOrdinal: boundary,
    coverage: { ...coverage },
  };
}

/**
 * Owner and wrapper structural cross-checks (item G, partial), over the validated documents only:
 * no owner, wrapper, socket or timer is constructed, and nothing is replayed.
 * - the decorator's records against themselves: delivery labels and owner deliveries against the
 *   registrations live at dispatch, event indices, completions against their calls;
 * - the wrapper's diagnostics (read at finish, so including later activity) against every record:
 *   delivered messages, pings and pongs, the actual close, completions, throws;
 * - the owner's report (frozen at settlement) against the records before its settlement boundary
 *   (its last recorded transport action): owner-received events, application, ping and pong
 *   attempts with their local outcomes and duplicates, pong matches, cleanup; the late counts
 *   against what the owner received or completed after it. Remote acknowledgement is the
 *   collector's alone: a local completion never establishes it;
 * - the report's own times in order, and the collector's receipts, account calls and exchanges
 *   placed in the recorder's order after the messages that caused them.
 * Wrapper-observed and owner-received events stay apart: wrapper-only events after the owner's
 * disposal and later activity are counted and labelled, never folded into the owner's counts.
 */
function checkOwnerWrapperStructure(
  docs: Map<string, Record<string, unknown>>,
): CpmmOwnerWrapperStructuralCheck {
  const f = new Findings();
  const ownerDoc = docs.get(CPMM_EVIDENCE_FILES.ownerReport);
  const read = (doc: unknown, key: string): unknown =>
    get(doc, key, "status") === "READ" ? get(doc, key, "value") : undefined;
  let report = read(ownerDoc, "report") as Record<string, unknown> | undefined;
  let late = read(ownerDoc, "lateEvents") as Record<string, number> | undefined;
  let wrapper = read(docs.get(CPMM_EVIDENCE_FILES.transportDiagnostics), "diagnostics") as
    | Record<string, unknown>
    | undefined;
  if (report === undefined) f.add("MISSING_EVIDENCE", "OWNER_REPORT_UNAVAILABLE");
  else if (!ownerReportValid(report)) {
    f.add("MISMATCH", "OWNER_REPORT_MALFORMED");
    report = undefined;
  }
  if (late === undefined) f.add("MISSING_EVIDENCE", "OWNER_LATE_EVENTS_UNAVAILABLE");
  else if (!allInts(late, OWNER_LATE_KEYS)) {
    f.add("MISMATCH", "OWNER_LATE_EVENTS_MALFORMED");
    late = undefined;
  }
  if (wrapper === undefined) f.add("MISSING_EVIDENCE", "WRAPPER_DIAGNOSTICS_UNAVAILABLE");
  else if (!wrapperDiagnosticsValid(wrapper)) {
    f.add("MISMATCH", "WRAPPER_DIAGNOSTICS_MALFORMED");
    wrapper = undefined;
  }
  const recording = docs.get(CPMM_EVIDENCE_FILES.recording);
  if (get(recording, "transportRecorded") !== true) {
    f.add("MISSING_EVIDENCE", "TRANSPORT_NOT_RECORDED");
    return ownerWrapperResult(f, EMPTY_OWNER_WRAPPER_CHECKED, null, NO_OWNER_WRAPPER_COVERAGE);
  }

  // Retention, pending work and instrumentation: what limits exact comparisons.
  const complete: Record<string, boolean> = {};
  for (const c of TRANSPORT_CATEGORIES) {
    complete[c] = get(recording, "retention", c, "dropped") === 0;
    if (!complete[c]) f.add("MISSING_EVIDENCE", `TRANSPORT_RECORDS_DROPPED:${c}`);
  }
  const failures = get(recording, "instrumentation", "retainedFailures");
  const correlationGap =
    get(recording, "instrumentation", "droppedFailureRecords") !== 0 ||
    !Array.isArray(failures) ||
    failures.some((x) => get(x, "layer") === "TRANSPORT");
  if (correlationGap) f.add("MISSING_EVIDENCE", "TRANSPORT_INSTRUMENTATION_INCOMPLETE");
  const pending = get(recording, "pending");
  const deliveriesPending = get(pending, "dispatchesAwaitingOwnerDelivery") !== 0;
  const callsPending =
    get(pending, "transportCallsInProgress") !== 0 ||
    ["send", "ping", "pong"].some((m) => get(pending, "completionsAwaitingFirstCall", m) !== 0);
  if (deliveriesPending) f.add("MISSING_EVIDENCE", "OWNER_DELIVERIES_PENDING_AT_FINISH");
  if (callsPending) f.add("MISSING_EVIDENCE", "TRANSPORT_CALLS_PENDING_AT_FINISH");

  const records = (
    get(docs.get(CPMM_EVIDENCE_FILES.transportRecords), "records") as TransportRecord[]
  )
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal);
  const events = records.filter((r) => r.kind === "EVENT");
  const calls = records.filter((r) => r.kind === "CALL");
  const completions = records.filter((r) => r.kind === "COMPLETION");
  const registrations = records.filter((r) => r.kind === "REGISTER" || r.kind === "UNREGISTER");
  const eventsComplete =
    complete.incoming! &&
    complete.control! &&
    complete.lifecycle! &&
    !correlationGap &&
    !deliveriesPending;
  const outgoingComplete =
    complete.outgoing! && complete.control! && complete.lifecycle! && !callsPending;

  // The decorator's records against themselves.
  const live = new Map<unknown, Set<unknown>>();
  const disposedBefore = new Set<unknown>();
  const lastIndex = new Map<unknown, number>();
  const callByOrdinal = new Map(calls.map((c) => [c.ordinal, c]));
  for (const r of records) {
    if (r.kind === "REGISTER" && r.outcome === "RETURNED" && r.registration !== null) {
      if (!live.has(r.event)) live.set(r.event, new Set());
      live.get(r.event)!.add(r.registration);
    } else if (r.kind === "UNREGISTER" && r.outcome === "RETURNED") {
      live.get(r.event)?.delete(r.registration);
      disposedBefore.add(r.event);
    } else if (r.kind === "EVENT") {
      const registered = r.ownerRegistrationsAtDispatch as number;
      const expectedLabel =
        registered > 0
          ? "OWNER_LISTENERS_REGISTERED"
          : disposedBefore.has(r.event)
            ? "WRAPPER_ONLY_AFTER_OWNER_DISPOSAL"
            : "WRAPPER_ONLY_NO_OWNER_LISTENER";
      const index = r.eventIndex as number;
      if (
        !isInt(registered) ||
        !isInt(r.ownerDeliveries) ||
        !isInt(r.ownerListenerThrew) ||
        !isInt(index) ||
        r.ownerDeliveries > registered ||
        r.ownerListenerThrew > r.ownerDeliveries ||
        index <= (lastIndex.get(r.event) ?? 0) ||
        (complete.lifecycle &&
          (r.delivery !== expectedLabel || registered !== (live.get(r.event)?.size ?? 0))) ||
        (!complete.lifecycle && registered > 0 !== (r.delivery === "OWNER_LISTENERS_REGISTERED")) ||
        (eventsComplete && index !== (lastIndex.get(r.event) ?? 0) + 1)
      ) {
        f.add("MISMATCH", "TRANSPORT_EVENT_RECORD");
      }
      lastIndex.set(r.event, isInt(index) ? index : (lastIndex.get(r.event) ?? 0));
    } else if (r.kind === "CALL") {
      if (
        (r.outcome === "IN_PROGRESS") !== (r.endOrdinal === null) ||
        (r.endOrdinal !== null && !(isInt(r.endOrdinal) && r.endOrdinal > r.ordinal))
      ) {
        f.add("MISMATCH", "TRANSPORT_CALL_RECORD");
      }
    }
  }
  const invocations = new Map<unknown, number>();
  for (const c of completions) {
    const call = callByOrdinal.get(c.callOrdinal as number);
    const n = (invocations.get(c.callOrdinal) ?? 0) + 1;
    invocations.set(c.callOrdinal, n);
    if (
      call === undefined
        ? outgoingComplete
        : call.method !== c.method ||
          call.completionObserved !== true ||
          c.ordinal <= call.ordinal ||
          c.afterCallEnded !==
            (call.endOrdinal !== null && c.ordinal > (call.endOrdinal as number)) ||
          (outgoingComplete && c.invocation !== n)
    ) {
      f.add("MISMATCH", "TRANSPORT_COMPLETION_RECORD");
    }
  }

  // The wrapper's diagnostics, read at finish(): every record, later activity included.
  const count = (event: string) => events.filter((e) => e.event === event).length;
  const sum = (xs: TransportRecord[], key: string) =>
    xs.reduce((s, r) => s + (isInt(r[key]) ? (r[key] as number) : 0), 0);
  const fits = (n: number, total: number, exact: boolean) => (exact ? n === total : n <= total);
  const wrapperComplete = wrapper !== undefined && eventsComplete && outgoingComplete;
  if (wrapper !== undefined) {
    const w = wrapper;
    if (
      !fits(lastIndex.get("message") ?? 0, get(w, "messages", "delivered") as number, false) ||
      !fits(count("message"), get(w, "messages", "delivered") as number, complete.incoming!) ||
      !fits(count("ping"), get(w, "control", "pingsDelivered") as number, complete.control!) ||
      !fits(count("pong"), get(w, "control", "pongsDelivered") as number, complete.control!)
    ) {
      f.add("MISMATCH", "WRAPPER_DELIVERY_COUNTS");
    }
    const closes = events.filter((e) => e.event === "close");
    if (
      closes.length > 1 ||
      (closes.length === 1 &&
        (get(w, "close", "observed") !== true ||
          closes[0]!.closeCode !== get(w, "close", "deliveredCode"))) ||
      (closes.length === 0 && complete.lifecycle && get(w, "close", "observed") === true)
    ) {
      f.add("MISMATCH", "WRAPPER_CLOSE");
    }
    const first = completions.filter((c) => c.invocation === 1);
    const exact = outgoingComplete;
    if (
      !fits(
        first.filter((c) => c.failedArgument === false).length,
        get(w, "completions", "completed") as number,
        exact,
      ) ||
      !fits(
        first.filter((c) => c.failedArgument !== false).length,
        get(w, "completions", "failed") as number,
        exact,
      ) ||
      !fits(
        completions.filter((c) => (c.invocation as number) > 1).length,
        get(w, "completions", "duplicate") as number,
        exact,
      ) ||
      !fits(
        completions.filter((c) => c.doneThrew === true).length,
        get(w, "completions", "doneThrew") as number,
        exact,
      )
    ) {
      f.add("MISMATCH", "WRAPPER_COMPLETIONS");
    }
    // The wrapper counts only the client's own throws; the decorator records every throw.
    if (
      outgoingComplete &&
      (["send", "ping", "pong", "close", "terminate"] as const).some(
        (m) =>
          (get(w, "callsThrew", m) as number) >
          calls.filter((c) => c.method === m && c.outcome === "THREW").length,
      )
    ) {
      f.add("MISMATCH", "WRAPPER_CALLS_THREW");
    }
    if (!fits(sum(events, "ownerListenerThrew"), w.ownerListenerThrew as number, eventsComplete)) {
      f.add("MISMATCH", "WRAPPER_LISTENER_THROWS");
    }
  }

  // The settlement boundary: the owner's last recorded transport action. The owner makes no
  // transport call after settlement, and its final listener disposal immediately precedes it.
  const ownerActions = records.filter(
    (r) =>
      r.kind === "CALL" ||
      r.kind === "READY_STATE" ||
      r.kind === "REGISTER" ||
      r.kind === "UNREGISTER",
  );
  const boundaryKnown = complete.lifecycle! && complete.outgoing! && complete.control!;
  let boundary: number | null = null;
  for (const r of ownerActions) {
    const end = r.kind === "CALL" && isInt(r.endOrdinal) ? r.endOrdinal : r.ordinal;
    boundary = boundary === null ? end : Math.max(boundary, end);
  }
  if (!boundaryKnown) boundary = null;
  const before = (r: TransportRecord) => boundary !== null && r.ordinal < boundary;
  const after = (r: TransportRecord) => boundary !== null && r.ordinal > boundary;
  const owned = events.filter((e) => isInt(e.ownerDeliveries) && e.ownerDeliveries > 0);
  const startCall = calls.find((c) => c.method === "start");

  const ownerIncoming =
    report !== undefined && late !== undefined && eventsComplete && boundary !== null;
  const ownerOutgoing =
    report !== undefined && late !== undefined && outgoingComplete && boundary !== null;
  if (report !== undefined) {
    const r = report;
    const t = r.transport as Record<string, unknown>;
    // Construction and start.
    if (
      (startCall !== undefined && t.started !== true) ||
      (complete.lifecycle && startCall === undefined && t.started === true) ||
      (registrations.length > 0 && t.constructed !== true) ||
      (complete.lifecycle &&
        t.disposeFailures !==
          registrations.filter((x) => x.kind === "UNREGISTER" && x.outcome === "THREW").length)
    ) {
      f.add("MISMATCH", "OWNER_TRANSPORT");
    }
    if (t.openedAtMs !== null && !owned.some((e) => e.event === "open")) {
      f.add("MISMATCH", "OWNER_TRANSPORT");
    }
    // The report's own message accounting: every owner-received message is before start,
    // after intake, or handed to the collector.
    const inc = r.incoming as Record<string, number>;
    const intake = r.intake as Record<string, number>;
    if (
      inc.messageEvents !==
        inc.messagesBeforeStart! + intake.framesAfterIntake! + inc.passedToCollector! ||
      inc.controlFrames !== inc.pingsReceived! + inc.pongsReceived!
    ) {
      f.add("MISMATCH", "OWNER_INCOMING_ACCOUNTING");
    }
    // Every received pong is classified as matched or unmatched, except where the owner returned
    // at the control-frame limit (counted, never classified): at most controlFrames - limit.
    const out = r.outgoing as Record<string, number>;
    const classified = out.pongsMatched! + out.pongsUnmatched!;
    const limit = get(
      docs.get(CPMM_EVIDENCE_FILES.plan),
      "plan",
      "limits",
      "owner",
      "maxControlFrames",
    );
    const overLimit = isInt(limit) && limit >= 1 ? Math.max(0, inc.controlFrames! - limit) : null;
    if (
      classified > inc.pongsReceived! ||
      (overLimit !== null && classified < inc.pongsReceived! - overLimit)
    ) {
      f.add("MISMATCH", "OWNER_PONG_ACCOUNTING");
    } else if (overLimit === null && classified < inc.pongsReceived!) {
      f.add("MISSING_EVIDENCE", "OWNER_CONTROL_LIMIT_UNAVAILABLE");
    }
  }
  if (ownerIncoming) {
    const r = report!;
    const inc = r.incoming as Record<string, number>;
    const intake = r.intake as Record<string, number>;
    const t = r.transport as Record<string, number>;
    const deliveries = (xs: TransportRecord[], event?: string) =>
      sum(event === undefined ? xs : xs.filter((e) => e.event === event), "ownerDeliveries");
    const pre = owned.filter(before);
    const afterStart = pre.filter((e) => startCall !== undefined && e.ordinal > startCall.ordinal);
    const beforeStart = pre.filter((e) => startCall === undefined || e.ordinal < startCall.ordinal);
    if (
      deliveries(pre, "message") !== inc.messageEvents ||
      deliveries(beforeStart) !== t.eventsBeforeStart ||
      deliveries(beforeStart, "message") !== inc.messagesBeforeStart
    ) {
      f.add("MISMATCH", "OWNER_MESSAGE_COUNTS");
    }
    const controlAfterStart = afterStart.filter((e) => e.event === "ping" || e.event === "pong");
    if (
      deliveries(controlAfterStart) !== inc.controlFrames! + intake.controlFramesAfterIntake! ||
      deliveries(controlAfterStart, "ping") < inc.pingsReceived! ||
      deliveries(controlAfterStart, "pong") < inc.pongsReceived!
    ) {
      f.add("MISMATCH", "OWNER_CONTROL_COUNTS");
    }
    if (
      wrapper !== undefined &&
      (get(wrapper, "messages", "delivered") as number) < deliveries(owned, "message")
    ) {
      f.add("MISMATCH", "OWNER_EXCEEDS_WRAPPER");
    }
    // Late events: owner listeners still invoked after the boundary (a failed disposal).
    const lateOwned = owned.filter(after);
    if (OWNER_EVENTS.some((e) => deliveries(lateOwned, e) !== late![e])) {
      f.add("MISMATCH", "OWNER_LATE_EVENTS");
    }
  }

  // Outgoing attempts, replayed from the records as the owner counts them (no transport replay).
  let completionsChecked = 0;
  if (ownerOutgoing) {
    const r = report!;
    const out = r.outgoing as Record<string, unknown>;
    let duplicates = 0;
    /** One attempt's local outcome: the first completion before any throw, else the throw. */
    const outcome = (call: TransportRecord) => {
      const mine = completions.filter((c) => c.callOrdinal === call.ordinal && before(c));
      completionsChecked += mine.length;
      let state: "PENDING" | "COMPLETED" | "FAILED" | "THREW" = "PENDING";
      let n = 0;
      const steps = [
        ...mine.map((c) => ({ at: c.ordinal, c })),
        ...(call.outcome === "THREW" ? [{ at: call.endOrdinal as number, c: null }] : []),
      ].sort((a, b) => a.at - b.at);
      for (const s of steps) {
        if (s.c === null) {
          if (state === "PENDING") state = "THREW";
          continue;
        }
        n++;
        if (n > 1 || state !== "PENDING") duplicates++;
        else state = s.c.failedArgument === false ? "COMPLETED" : "FAILED";
      }
      return state === "PENDING" ? "UNRESOLVED" : state;
    };
    const sends = calls.filter((c) => c.method === "send" && before(c));
    // Each attempt reserves one frame and makes one send.
    const attempted = (["subscribe", "unsubscribe"] as const).filter(
      (w) => get(out, w, "local") !== "NOT_ATTEMPTED",
    ).length;
    if (sends.length !== out.applicationFramesReserved || sends.length !== attempted) {
      f.add("MISMATCH", "OWNER_APPLICATION_FRAMES");
    }
    const sendFor = applicationSends(r, sends);
    (["subscribe", "unsubscribe"] as const).forEach((which) => {
      const a = out[which] as Record<string, unknown>;
      const call = sendFor[which];
      const local = call === undefined ? "NOT_ATTEMPTED" : outcome(call);
      if (
        a.local !== local ||
        (a.reservedAtMs === null) !== (local === "NOT_ATTEMPTED") ||
        (a.localAtMs === null) !== (local === "NOT_ATTEMPTED" || local === "UNRESOLVED")
      ) {
        f.add("MISMATCH", "OWNER_APPLICATION_ATTEMPT");
      }
    });
    for (const [method, key] of [
      ["ping", "pings"],
      ["pong", "pongReplies"],
    ] as const) {
      const tally = { reserved: 0, threw: 0, completed: 0, failed: 0, unresolved: 0 };
      for (const call of calls.filter((c) => c.method === method && before(c))) {
        tally.reserved++;
        const o = outcome(call);
        if (o === "THREW") tally.threw++;
        else if (o === "COMPLETED") tally.completed++;
        else if (o === "FAILED") tally.failed++;
        else tally.unresolved++;
      }
      if (CONTROL_ATTEMPT_KEYS.some((k) => get(out, key, k) !== tally[k])) {
        f.add("MISMATCH", "OWNER_CONTROL_ATTEMPTS");
      }
    }
    if (duplicates !== out.duplicateCompletions) f.add("MISMATCH", "OWNER_DUPLICATE_COMPLETIONS");
    if (completions.filter(after).length !== late!.localCompletion) {
      f.add("MISMATCH", "OWNER_LATE_EVENTS");
    }
    // A pong matches only an earlier ping's exact payload (original digests survive redaction).
    const pingDigests = calls
      .filter((c) => c.method === "ping" && before(c))
      .map((c) => ({ at: c.ordinal, digest: get(c, "payload", "originalSha256") }));
    const matchable = owned.filter(
      (e) =>
        e.event === "pong" &&
        before(e) &&
        pingDigests.some(
          (p) =>
            p.at < e.ordinal &&
            typeof p.digest === "string" &&
            p.digest === get(e, "payload", "originalSha256"),
        ),
    ).length;
    if (
      (out.pongsMatched as number) > matchable ||
      (out.pongsMatched as number) > (get(out, "pings", "reserved") as number)
    ) {
      f.add("MISMATCH", "OWNER_PONG_MATCHES");
    }
  }

  // Remote observation is the collector's alone. The accepted collector classifies each subscribe
  // and unsubscribe response once, and the owner records `observed` from that frame:
  // acknowledged, rejected, or malformed (MALFORMED_MESSAGE with the response-shape code). So a
  // retained response frame proves what the owner recorded, and a recorded observation needs its
  // frame; the collector's own state agrees either way. A local completion establishes nothing.
  const collector = docs.get(CPMM_EVIDENCE_FILES.collector);
  const frames = read(collector, "frameRecords") as Record<string, unknown>[] | undefined;
  const epochReportValue = read(collector, "epochReport");
  const epochReport = isRec(epochReportValue) ? epochReportValue : undefined;
  if (report !== undefined) {
    const out = report.outgoing as Record<string, Record<string, unknown>>;
    const sendFor = applicationSends(
      report,
      calls.filter((c) => c.method === "send"),
    );
    const handed =
      startCall === undefined
        ? []
        : owned.filter(
            (e) =>
              e.event === "message" &&
              e.ordinal > startCall.ordinal &&
              (boundary === null || e.ordinal < boundary),
          );
    const framesDropped =
      get(read(collector, "counters"), "metadataRetention", "frameRecordsDropped") !== 0;
    for (const [which, prefix, states] of RESPONSE_OBSERVATIONS) {
      const observed = out[which]!.observed as string;
      const responses = (frames ?? []).filter((fr) => observationOf(prefix, fr) !== null);
      const fromFrame = responses.length === 1 ? observationOf(prefix, responses[0]!) : null;
      const collectorState = get(
        epochReport,
        ...(which === "subscribe" ? ["subscription"] : ["unsubscribe", "status"]),
      );
      if (
        responses.length > 1 ||
        (fromFrame !== null && observed !== fromFrame) ||
        (fromFrame === null &&
          frames !== undefined &&
          !framesDropped &&
          observed !== "NOT_OBSERVED") ||
        (epochReport !== undefined && !states[observed]!.includes(collectorState as string))
      ) {
        f.add("MISMATCH", "OWNER_OBSERVATION");
      } else if (fromFrame === null && observed !== "NOT_OBSERVED") {
        f.add("MISSING_EVIDENCE", "RESPONSE_FRAME_UNAVAILABLE");
      }
      // The unsubscribe request id exists only once the owner built that frame, and the send
      // follows the build synchronously: its response is classified after the send. (A peer can
      // answer the subscribe id before any send, so no such order holds for subscribe.)
      if (which === "unsubscribe" && responses.length === 1) {
        const seq = get(responses[0], "sequence");
        const msg = isInt(seq) && seq >= 1 ? handed[seq - 1] : undefined;
        if (out[which]!.local === "NOT_ATTEMPTED") f.add("MISMATCH", "OWNER_OBSERVATION");
        else if (!complete.incoming || msg === undefined || sendFor.unsubscribe === undefined) {
          f.add("MISSING_EVIDENCE", "RESPONSE_ORDER_UNVERIFIABLE");
        } else if (msg.ordinal < sendFor.unsubscribe.ordinal)
          f.add("MISMATCH", "OWNER_OBSERVATION");
      }
    }
  }

  // Cleanup, phase-aware: only what the owner itself did and observed before its freeze. A later
  // close (wrapper-only, after the boundary) never changes or upgrades the owner's outcome.
  const cleanupChecked = report !== undefined && boundary !== null;
  if (cleanupChecked) {
    const c = report!.cleanup as Record<string, unknown>;
    const pre = (m: string) => calls.filter((x) => x.method === m && before(x));
    const closeCalls = pre("close");
    const terminate = pre("terminate");
    const dispose = pre("dispose");
    const ready = records.filter((x) => x.kind === "READY_STATE" && before(x));
    const ownerClose = owned.find((e) => e.event === "close" && before(e));
    const ownerCode =
      ownerClose === undefined ? null : isInt(ownerClose.closeCode) ? ownerClose.closeCode : null;
    if (
      c.closeThrew !== closeCalls.some((x) => x.outcome === "THREW") ||
      c.terminateAttempted !== terminate.length > 0 ||
      c.terminateThrew !== terminate.some((x) => x.outcome === "THREW") ||
      c.closeCode !== ownerCode ||
      (c.closeObservedAtMs === null) !== (ownerClose === undefined)
    ) {
      f.add("MISMATCH", "OWNER_CLEANUP");
    }
    const started = get(report, "transport", "started") === true;
    const statusHolds = ((): boolean => {
      switch (c.status) {
        case "SETTLED":
          return ownerClose !== undefined;
        case "SETTLED_AFTER_TERMINATE":
          return (
            terminate.length > 0 &&
            (ownerClose !== undefined ||
              ready.some((x) => x.outcome === "RETURNED" && x.value === 3))
          );
        case "FAILED_STILL_OPEN":
          return terminate.length > 0 && ready.some((x) => x.outcome === "THREW" || x.value !== 3);
        case "DISPOSED_UNSTARTED":
          return !started && dispose.some((x) => x.outcome === "RETURNED");
        case "DISPOSE_FAILED":
          return !started && dispose.some((x) => x.outcome === "THREW");
        default:
          return closeCalls.length === 0 && terminate.length === 0;
      }
    })();
    if (!statusHolds) f.add("MISMATCH", "OWNER_CLEANUP_STATUS");
  }

  // Times: the report's own fixed order, and the collector's receipts within observation.
  const uncertainties = report === undefined ? [] : (report.uncertainties as unknown[]);
  const clockUncertain =
    uncertainties.includes("CLOCK_INVALID") || uncertainties.includes("CLOCK_REGRESSED");
  if (clockUncertain) f.add("MISSING_EVIDENCE", "OWNER_CLOCK_UNCERTAIN");
  const timing = report !== undefined && report.deadlines !== null && !clockUncertain;
  if (timing) {
    const r = report!;
    const d = r.deadlines as Record<string, number>;
    const settled = r.settledAtMs as number;
    const notAfter = (a: unknown, b: unknown) =>
      a === null || b === null || (a as number) <= (b as number);
    const sub = get(r, "outgoing", "subscribe") as Record<string, unknown>;
    const unsub = get(r, "outgoing", "unsubscribe") as Record<string, unknown>;
    const ordered =
      d.startedAtMs! <= d.ackDeadlineMs! &&
      d.ackDeadlineMs! <= d.nominalEndMs! &&
      d.nominalEndMs! <= d.intakeEndMs! &&
      d.intakeEndMs! <= d.drainDeadlineMs! &&
      notAfter(d.startedAtMs, get(r, "transport", "openedAtMs")) &&
      notAfter(get(r, "transport", "openedAtMs"), sub.reservedAtMs) &&
      notAfter(sub.reservedAtMs, sub.localAtMs) &&
      notAfter(unsub.reservedAtMs, unsub.localAtMs) &&
      notAfter(d.startedAtMs, get(r, "intake", "stoppedAtMs")) &&
      notAfter(get(r, "intake", "stoppedAtMs"), settled) &&
      notAfter(get(r, "terminal", "atMs"), settled) &&
      notAfter(get(r, "cleanup", "startedAtMs"), get(r, "cleanup", "endedAtMs")) &&
      notAfter(get(r, "cleanup", "endedAtMs"), settled) &&
      notAfter(get(r, "cleanup", "closeObservedAtMs"), settled) &&
      notAfter(get(r, "cancellation", "requestedAtMs"), settled) &&
      notAfter(d.startedAtMs, settled);
    if (!ordered) f.add("MISMATCH", "OWNER_TIMING");
    // Every recorded collector receipt lies in the observation: [start, intake end), and not
    // after the intake stop.
    const stopped = get(r, "intake", "stoppedAtMs");
    if (
      (frames ?? []).some((fr) => {
        const at = get(fr, "receivedAtMs");
        return (
          isInt(at) &&
          (at < d.startedAtMs! || at >= d.intakeEndMs! || (isInt(stopped) && at > stopped))
        );
      })
    ) {
      f.add("MISMATCH", "OBSERVATION_TIMING");
    }
  }

  // The recorder's order: an account() call and its exchange follow the message whose
  // notification caused them; the owner calls account() only before its settlement.
  const ledgerCalls = (get(docs.get(CPMM_EVIDENCE_FILES.ledger), "calls") ?? []) as Record<
    string,
    unknown
  >[];
  const notes = read(collector, "notifications") as Record<string, unknown>[] | undefined;
  if (notes !== undefined && startCall !== undefined && complete.incoming && !correlationGap) {
    const handed = owned.filter((e) => e.event === "message" && e.ordinal > startCall.ordinal);
    const exchanges = (
      get(docs.get(CPMM_EVIDENCE_FILES.exchangeIndex), "exchanges") as unknown[]
    ).map((x) => docs.get(get(x, "path") as string));
    const seen = new Set<unknown>();
    for (const n of notes) {
      // A signature's first notification caused its first call and its one exchange.
      if (seen.has(n.signature)) continue;
      seen.add(n.signature);
      const msg = isInt(n.frameSequence) ? handed[n.frameSequence - 1] : undefined;
      if (msg === undefined) continue;
      const firstCall = ledgerCalls.find(
        (c) => c.kind === "ACCOUNT_CALL" && c.signature === n.signature,
      );
      const exchange = exchanges.find((x) => get(x, "entry", "requestedIdentity") === n.signature);
      if (
        (firstCall !== undefined && isInt(firstCall.ordinal) && firstCall.ordinal < msg.ordinal) ||
        (exchange !== undefined &&
          isInt(get(exchange, "ordinal")) &&
          (get(exchange, "ordinal") as number) < msg.ordinal)
      ) {
        f.add("MISMATCH", "DISPATCH_ORDER");
      }
    }
  }
  if (
    boundary !== null &&
    ledgerCalls.some((c) => c.kind === "ACCOUNT_CALL" && isInt(c.ordinal) && c.ordinal > boundary!)
  ) {
    f.add("MISMATCH", "ACCOUNT_CALL_AFTER_SETTLEMENT");
  }

  const coverage = {
    wrapper: wrapperComplete,
    ownerIncoming,
    ownerOutgoing,
    cleanup: cleanupChecked && complete.lifecycle!,
    timing,
  };
  if (boundary === null && boundaryKnown === false) {
    f.add("MISSING_EVIDENCE", "SETTLEMENT_BOUNDARY_UNKNOWN");
  }
  return ownerWrapperResult(
    f,
    {
      transportRecords: records.length,
      wrapperObservedEvents: events.length,
      ownerReceivedEvents: owned.length,
      wrapperOnlyEvents: events.length - owned.length,
      outgoingCalls: calls.filter((c) => CALLS_WITH_PAYLOAD.has(c.method)).length,
      completions: completionsChecked,
      afterSettlementRecords: boundary === null ? 0 : records.filter(after).length,
    },
    boundary,
    coverage,
  );
}
