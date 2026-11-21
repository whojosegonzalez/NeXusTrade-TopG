/**
 * CPMM pool observation evidence: offline sealing and integrity verification (assessment §8.38.17
 * item 17 D–F). Component re-derivation (item G) is not implemented here and is reported as such.
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
import { CPMM_TX_PURPOSE } from "../candidate-scanner/RaydiumCpmmTransactionSourceAdapter.js";
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
  /** No CPMM account acquisition exists yet (gap G3): supplied context is never verified here. */
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
  };
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

/** Validates every input and renders every file in memory (no file system access). */
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
    ["writeEvidenceFile"],
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
        requestBody: sealer.seal(ex.requestBody, TEXT_SCOPE),
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
      version: CPMM_EVIDENCE_SCHEMA_VERSION,
      ...poolContext,
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
    version: CPMM_EVIDENCE_SCHEMA_VERSION,
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
    poolContextProvenance: "SUPPLIED_UNVERIFIED",
    acquisitionProvenance: "OPEN_G3",
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
    evidenceSchemaVersion: CPMM_EVIDENCE_SCHEMA_VERSION,
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

  // 1. Validate, sanitize, render and scan everything in memory.
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
  /** Item G is not implemented: never a success. */
  readonly rederivation: { readonly status: "NOT_IMPLEMENTED" | "NOT_ATTEMPTED" };
  readonly poolContextProvenance: "SUPPLIED_UNVERIFIED" | null;
  readonly acquisitionProvenance: "OPEN_G3";
  readonly flags: typeof CPMM_EVIDENCE_FALSE_FLAGS;
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

/** Fail-closed, read-only verification of one sealed run directory. */
export function verifyCpmmObservationEvidence(outDir: string): CpmmEvidenceVerification {
  const problems: string[] = [];
  let manifestSha256: string | null = null;
  const result = (
    retention: CpmmEvidenceVerification["retention"],
    poolContextProvenance: "SUPPLIED_UNVERIFIED" | null,
  ): CpmmEvidenceVerification =>
    Object.freeze({
      outDir,
      manifestSha256,
      integrity: Object.freeze({
        ok: problems.length === 0,
        problems: Object.freeze([...problems]),
      }),
      retention: Object.freeze({
        status: retention.status,
        reasons: Object.freeze([...retention.reasons]),
      }),
      rederivation: Object.freeze({
        status: problems.length === 0 ? ("NOT_IMPLEMENTED" as const) : ("NOT_ATTEMPTED" as const),
      }),
      poolContextProvenance,
      acquisitionProvenance: "OPEN_G3" as const,
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
  if (m.evidenceSchemaVersion !== CPMM_EVIDENCE_SCHEMA_VERSION) {
    problems.push("EVIDENCE_SCHEMA_VERSION_UNSUPPORTED");
  }
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
  if (problems.length > 0) return integrityFailure();

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
      else docs.set(p, doc);
    }
  }
  if (problems.length > 0) return integrityFailure();

  try {
    checkDocuments(docs, listed, problems);
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
  return result(
    { status: reasons.length === 0 ? "COMPLETE" : "INCOMPLETE", reasons },
    "SUPPLIED_UNVERIFIED",
  );
}

/** Schema, report references, payloads and the exchange index against the session ledger. */
function checkDocuments(
  docs: Map<string, Record<string, unknown>>,
  listed: Map<string, { bytes: number; sha256: string }>,
  problems: string[],
): void {
  // Kinds and versions.
  for (const [p, doc] of docs) {
    const kind = EXCHANGE_FILE.test(p) ? EXCHANGE_FILE_KIND : FILE_KINDS[p];
    if (doc.kind !== kind) problems.push(`FILE_KIND_INVALID:${p}`);
    if (doc.version !== CPMM_EVIDENCE_SCHEMA_VERSION)
      problems.push(`FILE_VERSION_UNSUPPORTED:${p}`);
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
  if (report.poolContextProvenance !== "SUPPLIED_UNVERIFIED") {
    problems.push("REPORT_POOL_PROVENANCE_INVALID");
  }
  if (docs.get(CPMM_EVIDENCE_FILES.poolContext)!.acquisition !== "SUPPLIED_UNVERIFIED") {
    problems.push("POOL_CONTEXT_PROVENANCE_INVALID");
  }

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
      if (!TRANSPORT_CATEGORIES.includes(get(r, "category") as never)) {
        problems.push("TRANSPORT_RECORD_CATEGORY_INVALID");
      }
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

  // Record counts: the files must hold every observed occurrence.
  const recording = docs.get(CPMM_EVIDENCE_FILES.recording)!;
  const actual: Record<string, number> = {
    incoming: 0,
    outgoing: 0,
    control: 0,
    lifecycle: 0,
    exchanges: index.length,
    ledgerCalls:
      (get(docs.get(CPMM_EVIDENCE_FILES.ledger), "calls") as unknown[] | undefined)?.length ?? -1,
  };
  for (const r of records) {
    const c = get(r, "category") as string;
    actual[c] = (actual[c] ?? 0) + 1;
  }
  for (const c of Object.keys(actual)) {
    const observed = get(recording, "retention", c, "observed");
    if (!isInt(observed) || observed !== actual[c]) reasons.add(`RECORDS_MISSING:${c}`);
  }

  // Instrumentation, recording scope and pending work.
  const failures = get(recording, "instrumentation", "failures");
  const retainedFailures = get(recording, "instrumentation", "retainedFailures");
  if (
    failures !== 0 ||
    !Array.isArray(retainedFailures) ||
    retainedFailures.length > 0 ||
    get(recording, "instrumentation", "droppedFailureRecords") !== 0
  ) {
    reasons.add("INSTRUMENTATION_FAILURES");
  }
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
  if (
    get(
      docs.get(CPMM_EVIDENCE_FILES.collector),
      "epochReport",
      "value",
      "metadataRetention",
      "complete",
    ) !== true
  ) {
    reasons.add("COLLECTOR_RETENTION_INCOMPLETE");
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
