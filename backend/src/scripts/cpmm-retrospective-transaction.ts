#!/usr/bin/env node
/**
 * Bounded retrospective CPMM transaction retrieval (assessment sections 8.38.26-8.38.27).
 *
 * One cap-1 `getTransaction` for one fixed `cpmm-observation-03` signature whose sealed exchange
 * holds only a cap-0 request and a JSON-RPC -32015 error. The result is SEPARATE supplemental
 * evidence: it never counts as fresh flow, is never ingested, and never modifies either capture.
 *
 * Scope and invariants:
 * - The signature, the source capture and every source digest are fixed (`RETRO_SOURCE`); there is
 *   no discovery, selection or substitution.
 * - Preflight (before any configuration is read, and again in every verification) binds the source
 *   capture read-only: both sealed bundles verify with their pinned manifest digests, and the
 *   pinned exchange, notification, ledger record and pool accounts agree. A refusal permits ZERO
 *   requests and writes nothing.
 * - At most ONE request, through the accepted `PaperRequestSession` (lane SOLANA_RPC, owner
 *   SECURITY, purpose CPMM_RETROSPECTIVE_GET_TRANSACTION): the exact cap-1 body
 *   (`cpmmGetTransactionRequestBody`), a 262,144-byte cap, no retry, redirect, fallback or
 *   follow-up. One absolute 15,000 ms acquisition deadline starts before the session is
 *   constructed; the 10,000 ms request timeout is capped by the remaining time; at most 5,000 ms of
 *   settled cleanup follows a stop. Source verification, sealing and offline verification are
 *   local overhead outside that deadline.
 * - No tracker, ledger, collector or connection owner is instantiated; decoded events are data.
 * - Live analysis uses the accepted credential-aware `analyzeCpmmTransactionResponse` (cap 1).
 *   Credential-free verification (design option b) replays the accepted pure decoder plus strict
 *   JSON-RPC envelope, id, signature, slot and request-evidence checks; the credential-aware scan
 *   is NOT repeated, and redacted, withheld or incomplete bytes cannot establish exact replay.
 * - Cancellation and invalid, regressing or throwing clocks prevent success through the final
 *   decision boundary; the earliest failure is preserved.
 * - Imports, `--help` and the dry run load no configuration or credential, open no transport,
 *   send nothing and write nothing (the dry run reads the sealed source capture only).
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isValidSolanaSignature } from "../candidate-scanner/ExactPoolHistoryEnumerator.js";
import {
  PaperRequestSession,
  type PaperRequestExchangeEvidence,
  type PaperRequestSessionLimits,
  type PaperRequestSessionTimers,
} from "../candidate-scanner/PaperRequestSession.js";
import {
  adaptRaydiumCpmmPoolState,
  type RaydiumCpmmPoolStateSuccess,
} from "../candidate-scanner/RaydiumCpmmPoolStateAdapter.js";
import { decodeRaydiumCpmmTransactionSwaps } from "../candidate-scanner/RaydiumCpmmSwapDecoder.js";
import {
  CPMM_GET_TRANSACTION_V1_CONFIG,
  analyzeCpmmTransactionResponse,
  cpmmGetTransactionRequestBody,
} from "../candidate-scanner/RaydiumCpmmTransactionSourceAdapter.js";
import { findWorkspaceRoot } from "../paper/CanonicalPaths.js";
import { verifyCpmmPoolAcquisitionEvidence } from "./cpmm-pool-acquisition-evidence.js";
import { verifyCpmmObservationEvidence } from "./cpmm-pool-observation-evidence.js";
import {
  EVIDENCE_SANITIZER_LIMITS,
  deriveEvidenceSecrets,
  sanitizeEvidenceBytes,
} from "./evidence-credential-sanitizer.js";

// ---------------------------------------------------------------------------------------------
// Fixed constants
// ---------------------------------------------------------------------------------------------

export const RETRO_ROOT_SEGMENTS = ["data", "research", "cpmm-retrospective-transactions"] as const;
export const RETRO_KIND = "CPMM_RETROSPECTIVE_TRANSACTION_EVIDENCE" as const;
export const RETRO_MANIFEST_KIND = "CPMM_RETROSPECTIVE_TRANSACTION_MANIFEST" as const;
export const RETRO_PLAN_KIND = "CPMM_RETROSPECTIVE_TRANSACTION_PLAN" as const;
export const RETRO_SOURCE_BINDING_KIND = "CPMM_RETROSPECTIVE_SOURCE_BINDING" as const;
export const RETRO_VERSION = 1 as const;
export const RETRO_CLASSIFICATION = "RETROSPECTIVE_SUPPLEMENTAL" as const;
export const RETRO_LANE = "SOLANA_RPC" as const;
export const RETRO_OWNER = "SECURITY" as const;
export const RETRO_PURPOSE = "CPMM_RETROSPECTIVE_GET_TRANSACTION" as const;
export const RETRO_RPC_METHOD = "getTransaction" as const;
export const RETRO_RPC_URL_PLACEHOLDER = "SOLANA_RPC_URL (redacted)" as const;
export const RETRO_APPROVAL_STATUS = "PROPOSED_FOR_REVIEW_LIVE_EXECUTION_NOT_APPROVED" as const;
export const RETRO_LIVE_STATUS =
  "NOT_APPROVED: the retrospective retrieval awaits independent review and separate operator approval" as const;
export const RETRO_LIVE_FLAG_MEANING =
  "--live only selects the acquiring mode; it is not, and does not record, operator approval" as const;

export const RETRO_LIMITS = Object.freeze({
  httpRequests: 1,
  getTransactionCalls: 1,
  requestsAfterPreflightRefusal: 0,
  webSockets: 0,
  otherLaneAttempts: 0,
  retries: 0,
  redirects: 0,
  pagination: 0,
  fallback: "NONE",
  automaticFollowUp: false,
  acquisitionDeadlineMs: 15_000,
  requestTimeoutMs: 10_000,
  cleanupGraceMs: 5_000,
  maxResponseBytes: 262_144,
  solanaRpcPacingMs: 2_500,
  encoding: "json",
  commitment: "confirmed",
  maxSupportedTransactionVersion: 1,
});

/**
 * The fixed source record (`cpmm-observation-03`, evidence schema 2). Every value was read from the
 * sealed capture and is re-checked against it before any request and in every verification.
 */
export interface RetrospectiveSourceSpec {
  readonly runId: string;
  readonly observationDir: string;
  readonly acquisitionDir: string;
  readonly evidenceSchemaVersion: number;
  readonly observationManifestSha256: string;
  readonly acquisitionManifestSha256: string;
  readonly poolAddress: string;
  readonly candidateMint: string;
  readonly signature: string;
  readonly slot: number;
  readonly notificationSequence: number;
  readonly notificationReceivedAtMs: number;
  readonly notificationFrameSha256: string;
  readonly ledgerSequence: number;
  readonly exchangePath: string;
  readonly exchangeSha256: string;
  readonly exchangeSeq: number;
  readonly exchangeJsonRpcId: number;
  readonly requestOriginalSha256: string;
  readonly responseOriginalSha256: string;
  readonly rpcErrorCode: number;
  /** The version the source -32015 error message names (a provider statement, not content). */
  readonly versionClaim: number;
}

export const RETRO_SOURCE: RetrospectiveSourceSpec = Object.freeze({
  runId: "cpmm-observation-03",
  observationDir: "data/research/cpmm-observations/cpmm-observation-03",
  acquisitionDir: "data/research/cpmm-acquisitions/cpmm-observation-03",
  evidenceSchemaVersion: 2,
  observationManifestSha256: "12f5fac06c54ba51d17e845a2e607ca8cfa72bf1566440851946a73cf8757f0e",
  acquisitionManifestSha256: "57f6f2329ca20d8e5df72ef167f609e58ddb13e0072b0bc9abdbf7d8390a84eb",
  poolAddress: "G8kgi7aUpeX8EVR8VMkrth9SKEv5BietWC33UjAiiMGh",
  candidateMint: "ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg",
  signature:
    "4XcLrDWBcAHkgmK8oF9PqeKitaJy1sNZG2xetTuL8EbazpGjexiCBo2BUGThoV2FgdG8h7AF58imedW2sjtBMimm",
  slot: 473_543_189,
  notificationSequence: 2,
  notificationReceivedAtMs: 1_795_566_034_813,
  notificationFrameSha256: "ab1139ded029ac5a5124f6daf2f8267a9d9804c3512132df4124968dcd30b505",
  ledgerSequence: 2,
  exchangePath: "exchanges/000004.json",
  exchangeSha256: "b3fbf21e56e46ada70366537298cdfe25cf5c01c00d3d3550bbe2ffa961ce827",
  exchangeSeq: 4,
  exchangeJsonRpcId: 4,
  requestOriginalSha256: "58f03595f81687ed8120ba7e4292199e120b0955046b3a672a54b0deb07cfd2e",
  responseOriginalSha256: "06009d74502daefb3a420a961c5fec52d365e177e686ba540a13ba5a9ca04780",
  rpcErrorCode: -32015,
  versionClaim: 1,
});

/** What this evidence never establishes (fixed; every flag false). */
export const RETRO_NON_CERTIFICATIONS = Object.freeze({
  freshFlowEstablished: false,
  eventsIngested: false,
  sourceCaptureModified: false,
  sourceOutcomeRevised: false,
  decoderDefectEstablished: false,
  currentPoolStateVerified: false,
  notificationCompletenessEstablished: false,
  quietWindowEstablished: false,
  qualificationEligible: false,
  replayableCaptureEstablished: false,
  admissionEligible: false,
});

export const RETRO_LIMITATIONS = Object.freeze([
  "Historical retrieval of one fixed signature: never fresh flow, never ingested, never an activity rate or admission input.",
  "The source capture and its recorded runtime outcome (RPC_ERROR / JSON_RPC_ERROR) are unchanged; this is a separate supplemental annotation.",
  "The source -32015 message is a provider statement about the version, not content; the claim is compared only after response identity and slot binding.",
  "The pool context is the source capture's sealed account snapshot, not current on-chain state.",
  "A version-1 payload refused by the decoder stays UNRESOLVED; it does not by itself establish a decoder defect.",
  "Credential-free verification replays the pure decoder and strict envelope checks; the credential-aware scan is not repeated, and redacted, withheld or incomplete bytes cannot establish exact replay.",
]);

export const RETRO_EXIT_CODES = Object.freeze({
  OK: 0,
  INVALID: 1,
  EVIDENCE_LIMITED: 2,
  NO_TRANSACTION_PAYLOAD: 3,
  INTEGRITY_FAILED: 4,
  SEAL_FAILED: 5,
  CANCELLED: 6,
  CLEANUP_FAILED: 7,
});

export const RETRO_FILES = Object.freeze({
  plan: "plan.json",
  sourceBinding: "source-binding.json",
  retrieval: "retrieval.json",
  manifest: "evidence-manifest.json",
});

export const RETRO_VERIFIER_LIMITS = Object.freeze({
  maxManifestBytes: 65_536,
  maxFileBytes: 1_048_576,
  maxEntries: 8,
  /** Source capture files (the observation verifier's own per-file bound). */
  maxSourceFileBytes: 8 * 1024 * 1024,
});

export const RETRO_SIGNALS = ["SIGINT", "SIGTERM"] as const;
export type RetroSignal = (typeof RETRO_SIGNALS)[number];
export const RETRO_SHUTDOWN_GRACE_MS = 5_000;
export const RETRO_SHUTDOWN_FORCED_NOTICE =
  "[CPMM_RETROSPECTIVE_TRANSACTION_SHUTDOWN_FORCED]" as const;

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const sha256 = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isPlainRecord = (v: unknown): v is Record<string, unknown> => {
  if (!isRecord(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isSafeCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const HEX64 = /^[0-9a-f]{64}$/;
const FIXED_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function decodeStrictUtf8(bytes: Uint8Array): string | null {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}

/** Key-sorted JSON with bigints tagged as the observation sealer tags them (`{ $bigint }`). */
function canonical(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (typeof x === "bigint") return { $bigint: x.toString() };
    if (typeof x === "number") {
      if (!Number.isFinite(x)) return { $number: String(x) };
      return Object.is(x, -0) ? 0 : x;
    }
    if (Array.isArray(x)) return x.map(norm);
    if (isRecord(x)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x).sort()) {
        if (x[k] !== undefined) out[k] = norm(x[k]);
      }
      return out;
    }
    return x;
  };
  return JSON.stringify(norm(v));
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

function redactText(text: string, secrets: readonly string[]): string {
  if (secrets.length === 0 || text === "") return text;
  try {
    const r = sanitizeEvidenceBytes(Buffer.from(text, "utf8"), secrets, {
      partial: false,
      parseJson: false,
    });
    return r.status === "WITHHELD" ? "[WITHHELD_CREDENTIAL_TEXT]" : r.stored;
  } catch {
    return "[WITHHELD_CREDENTIAL_TEXT]";
  }
}

/** A bounded, non-link regular file read; a fixed problem code otherwise. */
function readBounded(fullPath: string, maxBytes: number, label: string): Buffer | string {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(fullPath);
  } catch {
    return `MISSING:${label}`;
  }
  if (st.isSymbolicLink() || st.nlink > 1) return `LINK_REJECTED:${label}`;
  if (!st.isFile()) return `NOT_REGULAR_FILE:${label}`;
  if (!isSafeCount(st.size) || st.size > maxBytes) return `FILE_TOO_LARGE:${label}`;
  let bytes: Buffer;
  try {
    bytes = readFileSync(fullPath);
  } catch {
    return `FILE_UNREADABLE:${label}`;
  }
  return bytes.length === st.size ? bytes : `FILE_CHANGED_DURING_READ:${label}`;
}

const parseJson = (b: Buffer): unknown => {
  const text = decodeStrictUtf8(b);
  if (text === null) throw new Error("NOT_UTF8");
  return JSON.parse(text);
};
const get = (v: unknown, ...keys: string[]): unknown => {
  let cur = v;
  for (const k of keys) {
    if (!isRecord(cur) || !hasOwn(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
};

/** Exact bytes of a sealed observation payload; null when redacted, withheld or inconsistent. */
function exactPayloadBytes(p: unknown): Buffer | null {
  if (!isRecord(p) || p.payloadRedacted !== false || typeof p.stored !== "string") return null;
  const b =
    p.storedEncoding === "base64"
      ? Buffer.from(p.stored, "base64")
      : p.storedEncoding === "utf8"
        ? Buffer.from(p.stored, "utf8")
        : null;
  if (b === null) return null;
  const digest = sha256(b);
  return digest === p.originalSha256 && digest === p.storedSha256 && b.length === p.originalBytes
    ? b
    : null;
}

// ---------------------------------------------------------------------------------------------
// Source-capture binding (read-only; preflight and every verification)
// ---------------------------------------------------------------------------------------------

export interface RetrospectiveSourceDeps {
  readonly verifyObservation?:
    | ((dir: string, options: { acquisitionDir: string }) => unknown)
    | undefined;
  readonly verifyAcquisition?: ((dir: string) => unknown) | undefined;
}

export type RetrospectiveSourceBinding =
  | {
      readonly ok: true;
      readonly pool: RaydiumCpmmPoolStateSuccess;
      readonly record: Readonly<Record<string, unknown>>;
    }
  | { readonly ok: false; readonly problems: readonly string[] };

/** The binding record a bound source yields (static for a spec; sealed and re-checked). */
export function expectedSourceBindingRecord(spec: RetrospectiveSourceSpec) {
  return {
    runId: spec.runId,
    observationDir: spec.observationDir,
    acquisitionDir: spec.acquisitionDir,
    evidenceSchemaVersion: spec.evidenceSchemaVersion,
    observationManifestSha256: spec.observationManifestSha256,
    acquisitionManifestSha256: spec.acquisitionManifestSha256,
    target: { poolAddress: spec.poolAddress, candidateMint: spec.candidateMint },
    signature: spec.signature,
    notification: {
      sequence: spec.notificationSequence,
      slot: spec.slot,
      receivedAtMs: spec.notificationReceivedAtMs,
      frameSha256: spec.notificationFrameSha256,
    },
    ledger: {
      sequence: spec.ledgerSequence,
      disposition: "UNRESOLVED",
      blockingClass: "TRANSACTION_UNAVAILABLE",
      factKind: "RPC_ERROR",
      factCode: "JSON_RPC_ERROR",
    },
    exchange: {
      path: spec.exchangePath,
      sha256: spec.exchangeSha256,
      seq: spec.exchangeSeq,
      jsonRpcId: spec.exchangeJsonRpcId,
      requestMaxSupportedTransactionVersion: 0,
      requestOriginalSha256: spec.requestOriginalSha256,
      responseOriginalSha256: spec.responseOriginalSha256,
      rpcErrorCode: spec.rpcErrorCode,
      transactionPayload: false,
    },
    versionClaim: spec.versionClaim,
    versionClaimSource: "SOURCE_JSON_RPC_ERROR_MESSAGE",
    poolContext: "SOURCE_SEALED_ACCOUNTS_READAPTED",
    sourceModified: false,
  };
}

/**
 * Binds the source capture read-only. Every check must pass; nothing is written, and no payload is
 * copied. Problems are fixed codes. Never throws.
 */
export function bindRetrospectiveSource(
  projectRoot: string,
  spec: RetrospectiveSourceSpec,
  deps: RetrospectiveSourceDeps = {},
): RetrospectiveSourceBinding {
  const problems: string[] = [];
  const refuse = (code: string): RetrospectiveSourceBinding => {
    problems.push(code);
    return { ok: false, problems: [...problems] };
  };
  try {
    if (!isValidSolanaSignature(spec.signature) || !isSafeCount(spec.slot)) {
      return refuse("SOURCE_SPEC_INVALID");
    }
    const obsDir = path.join(projectRoot, ...spec.observationDir.split("/"));
    const acqDir = path.join(projectRoot, ...spec.acquisitionDir.split("/"));
    // 1. Both sealed bundles verify (read-only), with their pinned manifest digests.
    const acq = (deps.verifyAcquisition ?? verifyCpmmPoolAcquisitionEvidence)(acqDir);
    if (
      get(acq, "integrity") !== "VERIFIED" ||
      get(acq, "computed") !== "ACQUIRED_REPRODUCED" ||
      get(acq, "manifestSha256") !== spec.acquisitionManifestSha256
    ) {
      return refuse("SOURCE_ACQUISITION_NOT_VERIFIED");
    }
    const obs = (deps.verifyObservation ?? verifyCpmmObservationEvidence)(obsDir, {
      acquisitionDir: acqDir,
    });
    if (
      get(obs, "integrity", "ok") !== true ||
      get(obs, "manifestSha256") !== spec.observationManifestSha256 ||
      get(obs, "acquisitionBinding", "status") !== "REPRODUCED" ||
      get(obs, "poolContextProvenance") !== "ACQUIRED_BOUND" ||
      get(obs, "rederivation", "components", "poolContext", "status") !== "REPRODUCED"
    ) {
      return refuse("SOURCE_OBSERVATION_NOT_VERIFIED");
    }
    // 2. The manifest bytes themselves, then each needed file against its manifest entry.
    const L = RETRO_VERIFIER_LIMITS.maxSourceFileBytes;
    const manifestBytes = readBounded(
      path.join(obsDir, "cpmm-observation-manifest.json"),
      L,
      "manifest",
    );
    if (typeof manifestBytes === "string") return refuse(`SOURCE_${manifestBytes}`);
    if (sha256(manifestBytes) !== spec.observationManifestSha256) {
      return refuse("SOURCE_MANIFEST_DIGEST");
    }
    const manifest = parseJson(manifestBytes);
    if (get(manifest, "evidenceSchemaVersion") !== spec.evidenceSchemaVersion) {
      return refuse("SOURCE_SCHEMA_VERSION");
    }
    const entries = get(manifest, "files");
    if (!Array.isArray(entries)) return refuse("SOURCE_MANIFEST_FILES");
    const listed = (rel: string): unknown => {
      const e = entries.filter((x) => get(x, "path") === rel);
      if (e.length !== 1) throw new SourceRefusal(`SOURCE_NOT_LISTED:${rel}`);
      const b = readBounded(path.join(obsDir, ...rel.split("/")), L, rel);
      if (typeof b === "string") throw new SourceRefusal(`SOURCE_${b}`);
      if (b.length !== get(e[0], "bytes") || sha256(b) !== get(e[0], "sha256")) {
        throw new SourceRefusal(`SOURCE_FILE_DIGEST:${rel}`);
      }
      if (rel === spec.exchangePath && sha256(b) !== spec.exchangeSha256) {
        throw new SourceRefusal("SOURCE_EXCHANGE_DIGEST");
      }
      return parseJson(b);
    };
    // 3. The exchange: the cap-0 request and the -32015 error, no transaction payload.
    const ex = listed(spec.exchangePath);
    const entry = get(ex, "entry");
    if (
      get(entry, "seq") !== spec.exchangeSeq ||
      get(entry, "lane") !== "SOLANA_RPC" ||
      get(entry, "owner") !== "FLOW" ||
      get(entry, "purpose") !== "CPMM_GET_TRANSACTION" ||
      get(entry, "requestedIdentity") !== spec.signature ||
      get(entry, "jsonRpcId") !== spec.exchangeJsonRpcId ||
      get(entry, "httpStatus") !== 200 ||
      get(entry, "bodyComplete") !== true ||
      get(entry, "error") !== null ||
      get(ex, "method") !== "POST" ||
      get(ex, "bodyState") !== "COMPLETE"
    ) {
      return refuse("SOURCE_EXCHANGE_ENTRY");
    }
    const req = exactPayloadBytes(get(ex, "requestBody"));
    if (
      req === null ||
      sha256(req) !== spec.requestOriginalSha256 ||
      req.toString("utf8") !==
        cpmmGetTransactionRequestBody(spec.signature, spec.exchangeJsonRpcId, 0)
    ) {
      return refuse("SOURCE_EXCHANGE_REQUEST");
    }
    const res = exactPayloadBytes(get(ex, "body"));
    if (res === null || sha256(res) !== spec.responseOriginalSha256) {
      return refuse("SOURCE_EXCHANGE_RESPONSE");
    }
    const body = parseJson(res);
    const message = get(body, "error", "message");
    if (
      !isRecord(body) ||
      hasOwn(body, "result") ||
      get(body, "id") !== spec.exchangeJsonRpcId ||
      get(body, "error", "code") !== spec.rpcErrorCode ||
      typeof message !== "string" ||
      !message.startsWith(`Transaction version (${spec.versionClaim}) is not supported`)
    ) {
      return refuse("SOURCE_EXCHANGE_ERROR");
    }
    // 4. The notification and the ledger record naming the signature.
    const notes = get(listed("collector.json"), "notifications");
    const notesValue = get(notes, "status") === "READ" ? get(notes, "value") : undefined;
    const mine = Array.isArray(notesValue)
      ? notesValue.filter((n) => get(n, "signature") === spec.signature)
      : [];
    if (
      mine.length !== 1 ||
      get(mine[0], "sequence") !== spec.notificationSequence ||
      get(mine[0], "slot") !== spec.slot ||
      get(mine[0], "receivedAtMs") !== spec.notificationReceivedAtMs ||
      get(mine[0], "frameSha256") !== spec.notificationFrameSha256
    ) {
      return refuse("SOURCE_NOTIFICATION");
    }
    const records = get(listed("ledger.json"), "records");
    const recValue = get(records, "status") === "READ" ? get(records, "value") : undefined;
    const rec = Array.isArray(recValue)
      ? recValue.filter((r) => get(r, "signature") === spec.signature)
      : [];
    if (
      rec.length !== 1 ||
      get(rec[0], "sequence") !== spec.ledgerSequence ||
      get(rec[0], "notifiedSlot") !== spec.slot ||
      get(rec[0], "disposition") !== "UNRESOLVED" ||
      get(rec[0], "blockingClass") !== "TRANSACTION_UNAVAILABLE" ||
      get(rec[0], "factKind") !== "RPC_ERROR" ||
      get(rec[0], "factCode") !== "JSON_RPC_ERROR"
    ) {
      return refuse("SOURCE_LEDGER_RECORD");
    }
    // 5. The pool, re-adapted from the sealed accounts and equal to the recorded adapted pool.
    const ctx = listed("pool-context.json");
    if (
      get(ctx, "target", "poolAddress") !== spec.poolAddress ||
      get(ctx, "target", "candidateMint") !== spec.candidateMint
    ) {
      return refuse("SOURCE_POOL_TARGET");
    }
    const account = (name: string) => {
      const a = get(ctx, "accounts", name);
      const data = exactPayloadBytes(get(a, "data"));
      if (data === null) throw new SourceRefusal(`SOURCE_POOL_ACCOUNT_BYTES:${name}`);
      return {
        address: get(a, "address"),
        ownerProgramId: get(a, "ownerProgramId"),
        slot: get(a, "slot"),
        data,
      };
    };
    const adapted = adaptRaydiumCpmmPoolState({
      target: { poolAddress: spec.poolAddress, candidateMint: spec.candidateMint },
      poolAccount: account("pool"),
      vault0Account: account("vault0"),
      vault1Account: account("vault1"),
    } as never);
    if (!adapted.ok) return refuse("SOURCE_POOL_NOT_ADAPTED");
    if (!same(adapted, get(ctx, "adaptedPool"))) return refuse("SOURCE_POOL_DIFFERS");
    if (adapted.poolAddress !== spec.poolAddress || adapted.candidateMint !== spec.candidateMint) {
      return refuse("SOURCE_POOL_IDENTITY");
    }
    return { ok: true, pool: adapted, record: expectedSourceBindingRecord(spec) };
  } catch (err) {
    return refuse(err instanceof SourceRefusal ? err.code : "SOURCE_UNREADABLE");
  }
}

class SourceRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

// ---------------------------------------------------------------------------------------------
// Clock guard and run failures (earliest failure preserved)
// ---------------------------------------------------------------------------------------------

export interface RetrospectiveRunFailures {
  readonly list: readonly string[];
  add(code: string): void;
}
export function createRetrospectiveRunFailures(): RetrospectiveRunFailures {
  const list: string[] = [];
  return {
    get list() {
      return [...list];
    },
    add(code: string) {
      if (!list.includes(code)) list.push(code);
    },
  };
}

export interface RetrospectiveClock {
  /** Never throws: on failure it records the failure once and returns the last good reading. */
  now(): number;
  readonly failure: string | null;
}

/**
 * Wraps the injected clock. A throwing, non-integer, negative or regressing reading is a failure:
 * recorded once (`CLOCK_FAILURE:<code>`), and the caller's `onFailure` is told asynchronously.
 */
export function createRetrospectiveClock(
  clock: () => number,
  failures: RetrospectiveRunFailures,
  onFailure: () => void = () => {},
): RetrospectiveClock {
  let last: number | null = null;
  let failure: string | null = null;
  const fail = (code: string) => {
    if (failure !== null) return;
    failure = code;
    failures.add(`CLOCK_FAILURE:${code}`);
    queueMicrotask(onFailure);
  };
  return {
    now() {
      if (failure !== null) return last ?? 0;
      let v: unknown;
      try {
        v = clock();
      } catch {
        fail("CLOCK_THREW");
        return last ?? 0;
      }
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
        fail("CLOCK_INVALID");
        return last ?? 0;
      }
      if (last !== null && v < last) {
        fail("CLOCK_REGRESSED");
        return last;
      }
      last = v;
      return v;
    },
    get failure() {
      return failure;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Acquisition: at most one request
// ---------------------------------------------------------------------------------------------

export type RetroTransportOutcome =
  | "RESPONSE_RECEIVED"
  | "HTTP_ERROR"
  | "RESPONSE_LIMIT_EXCEEDED"
  | "DEADLINE_EXPIRED"
  | "TRANSPORT_ERROR"
  | "SESSION_STOPPED"
  | "NOT_DISPATCHED"
  | "OPERATOR_CANCELLED"
  | "CLOCK_FAILURE"
  | "CLEANUP_UNSETTLED";
const TRANSPORT_OUTCOMES: readonly string[] = [
  "RESPONSE_RECEIVED",
  "HTTP_ERROR",
  "RESPONSE_LIMIT_EXCEEDED",
  "DEADLINE_EXPIRED",
  "TRANSPORT_ERROR",
  "SESSION_STOPPED",
  "NOT_DISPATCHED",
  "OPERATOR_CANCELLED",
  "CLOCK_FAILURE",
  "CLEANUP_UNSETTLED",
];

/** How the source's version claim compares with a response bound to the signature and slot. */
export type RetroVersionComparison =
  | "NOT_COMPARED"
  | "MATCHES_SOURCE_CLAIM"
  | "DIFFERS_FROM_SOURCE_CLAIM"
  | "UNRESOLVED_VERSION_FIELD";

/** The classification fields recorded (live analyzer) and computed (credential-free replay). */
export interface RetroClassification {
  readonly kind: string;
  readonly code: string | null;
  readonly detail: string | null;
  readonly rpcErrorCode: number | null;
  readonly decoderStatus: string | null;
  readonly decoderReason: string | null;
  /** The decoder ran: the response was bound to the request id, the signature and the slot. */
  readonly payloadBound: boolean;
  readonly events: readonly Record<string, unknown>[];
  readonly versionComparison: RetroVersionComparison;
  /** A bound payload whose version field is exactly 1 (genuine v1 content, decoded or not). */
  readonly v1PayloadBound: boolean;
}

export interface RetrospectiveAcquisition {
  readonly outcome: RetroTransportOutcome;
  readonly detail: string | null;
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
  readonly endedAtMs: number;
  readonly requestId: number | null;
  readonly requestBody: string | null;
  readonly httpAttempts: number;
  readonly exchange: PaperRequestExchangeEvidence | null;
  readonly sessionStopReason: string | null;
  readonly analysis: RetroClassification | null;
  readonly analyzerBodyState: string | null;
  readonly cancelled: boolean;
}

const eventData = (events: readonly unknown[]): Record<string, unknown>[] =>
  events.map((e) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e as Record<string, unknown>)) {
      out[k] = typeof v === "bigint" ? v.toString() : v;
    }
    return out;
  });

function versionComparison(responseText: string | null, claim: number): RetroVersionComparison {
  if (responseText === null) return "UNRESOLVED_VERSION_FIELD";
  let version: unknown;
  try {
    const r = JSON.parse(responseText) as unknown;
    if (!isRecord(r) || !isRecord(r.result) || !hasOwn(r.result, "version")) {
      return "UNRESOLVED_VERSION_FIELD";
    }
    version = r.result.version;
  } catch {
    return "UNRESOLVED_VERSION_FIELD";
  }
  if (version === claim) return "MATCHES_SOURCE_CLAIM";
  if (version === "legacy" || version === 0 || version === 1) return "DIFFERS_FROM_SOURCE_CLAIM";
  return "UNRESOLVED_VERSION_FIELD";
}

function fromAnalysis(
  a: Record<string, unknown>,
  text: string | null,
  claim: number,
): RetroClassification {
  const decoder = isRecord(a.decoder) ? a.decoder : null;
  const bound = decoder !== null;
  const comparison = bound ? versionComparison(text, claim) : "NOT_COMPARED";
  return {
    kind: String(a.kind),
    code: (a.code as string | null) ?? null,
    detail: (a.detail as string | null) ?? null,
    rpcErrorCode: (a.rpcErrorCode as number | null) ?? null,
    decoderStatus: decoder ? (decoder.status as string) : null,
    decoderReason: decoder ? ((decoder.reason as string | null) ?? null) : null,
    payloadBound: bound,
    events: eventData(Array.isArray(a.events) ? a.events : []),
    versionComparison: comparison,
    v1PayloadBound: comparison === "MATCHES_SOURCE_CLAIM" && claim === 1,
  };
}

function transportOutcome(
  error: string | null,
  httpStatus: number | null,
  bodyState: string,
  stopReason: string | null,
  completedAfterDeadline: boolean,
): RetroTransportOutcome {
  if (error === "RESPONSE_TOO_LARGE") return "RESPONSE_LIMIT_EXCEEDED";
  if (error === "REQUEST_TIMED_OUT" || (error !== null && stopReason === "LIFETIME_EXPIRED")) {
    return "DEADLINE_EXPIRED";
  }
  if (error !== null) return error === "NETWORK_ERROR" ? "TRANSPORT_ERROR" : "SESSION_STOPPED";
  if (completedAfterDeadline) return "DEADLINE_EXPIRED";
  if (httpStatus !== 200) return "HTTP_ERROR";
  return bodyState === "COMPLETE" ? "RESPONSE_RECEIVED" : "HTTP_ERROR";
}

/**
 * At most one request. The 15,000 ms deadline starts before the session is constructed; the
 * request timeout is the smaller of 10,000 ms and the remaining time; after the session stops, the
 * request has at most 5,000 ms to settle, else the outcome is CLEANUP_UNSETTLED.
 */
export async function runRetrospectiveRequest(o: {
  readonly spec: RetrospectiveSourceSpec;
  readonly pool: RaydiumCpmmPoolStateSuccess;
  readonly rpcUrl: string;
  /** The adapter's credential rule (the endpoint URL and any further secrets). */
  readonly analysisSecrets: readonly string[];
  readonly fetchFn: typeof fetch;
  readonly clock: RetrospectiveClock;
  readonly failures: RetrospectiveRunFailures;
  readonly timers?: PaperRequestSessionTimers | undefined;
  readonly abortSignal?: AbortSignal | undefined;
  /** Aborted when the clock fails (the caller wires the clock's `onFailure` to it). */
  readonly clockFailureSignal?: AbortSignal | undefined;
}): Promise<RetrospectiveAcquisition> {
  const L = RETRO_LIMITS;
  const clock = o.clock;
  const startedAtMs = clock.now();
  const deadlineAtMs = startedAtMs + L.acquisitionDeadlineMs;
  const base = {
    startedAtMs,
    deadlineAtMs,
    requestBody: null,
    httpAttempts: 0,
    exchange: null,
    analysis: null,
    analyzerBodyState: null,
  };
  const early = (
    outcome: RetroTransportOutcome,
    detail: string | null,
    stop: string | null = null,
  ): RetrospectiveAcquisition => ({
    ...base,
    outcome,
    detail,
    endedAtMs: Math.max(startedAtMs, clock.now()),
    requestId: null,
    sessionStopReason: stop,
    cancelled: o.abortSignal?.aborted === true,
  });
  if (clock.failure !== null) return early("CLOCK_FAILURE", clock.failure);
  if (o.abortSignal?.aborted) {
    o.failures.add("OPERATOR_CANCELLED");
    return early("OPERATOR_CANCELLED", "CANCELLED_BEFORE_DISPATCH");
  }
  const remainingMs = deadlineAtMs - clock.now();
  if (clock.failure !== null) return early("CLOCK_FAILURE", clock.failure);
  if (remainingMs <= 0) return early("DEADLINE_EXPIRED", "LIFETIME_EXPIRED", "LIFETIME_EXPIRED");

  const limits: PaperRequestSessionLimits = {
    lifetimeMs: remainingMs,
    maxHttpAttempts: L.httpRequests,
    requestTimeoutMs: Math.max(1, Math.min(L.requestTimeoutMs, remainingMs)),
    lanes: {
      SOLANA_RPC: {
        maxAttempts: 1,
        pacingMs: L.solanaRpcPacingMs,
        maxResponseBytes: L.maxResponseBytes,
      },
      DEXSCREENER: { maxAttempts: 0, pacingMs: 1_000, maxResponseBytes: 1 },
      RUGCHECK: { maxAttempts: 0, pacingMs: 5_000, maxResponseBytes: 1 },
      SOLANA_TRACKER: { maxAttempts: 0, pacingMs: 5_000, maxResponseBytes: 1 },
    },
  };
  const rawTimers: PaperRequestSessionTimers = o.timers ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
  };
  const boundedTimers: PaperRequestSessionTimers = {
    setTimeout: (fn, ms) =>
      rawTimers.setTimeout(fn, Math.min(Math.max(0, ms), Math.max(0, deadlineAtMs - clock.now()))),
    clearTimeout: (h) => rawTimers.clearTimeout(h),
  };

  let exchange: PaperRequestExchangeEvidence | null = null;
  let decided = false;
  const session = new PaperRequestSession({
    executionContext: "PAPER_SIMULATION",
    fetchFn: o.fetchFn,
    limits,
    clock: () => clock.now(),
    timers: boundedTimers,
    onExchangeComplete: (e) => {
      // Only the evidence present at the decision boundary counts.
      if (!decided && exchange === null) exchange = e;
    },
  });

  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
    o.failures.add("OPERATOR_CANCELLED");
    session.stop("CALLER_CANCELLED");
  };
  const onClockFailure = () => session.stop("CLOCK_FAILURE");
  o.abortSignal?.addEventListener("abort", onAbort, { once: true });
  o.clockFailureSignal?.addEventListener("abort", onClockFailure, { once: true });
  if (o.clockFailureSignal?.aborted) onClockFailure();

  // Settled cleanup: once the session stops, the request has at most 5,000 ms to settle; and,
  // whatever the session's own timers do, nothing outlives the deadline by more than 5,000 ms.
  let cleanupHandle: unknown = null;
  let resolveUnsettled!: (v: { readonly kind: "UNSETTLED" }) => void;
  const unsettled = new Promise<{ readonly kind: "UNSETTLED" }>((r) => {
    resolveUnsettled = r;
  });
  const hardBoundHandle = rawTimers.setTimeout(
    () => resolveUnsettled({ kind: "UNSETTLED" }),
    Math.max(0, deadlineAtMs - clock.now()) + L.cleanupGraceMs,
  );
  session.onStop(() => {
    if (cleanupHandle === null) {
      cleanupHandle = rawTimers.setTimeout(
        () => resolveUnsettled({ kind: "UNSETTLED" }),
        L.cleanupGraceMs,
      );
    }
  });

  const signals = [o.abortSignal, o.clockFailureSignal].filter(
    (s): s is AbortSignal => s !== undefined,
  );
  session.open();
  const requestId = session.nextJsonRpcId();
  const requestBody = cpmmGetTransactionRequestBody(
    o.spec.signature,
    requestId,
    L.maxSupportedTransactionVersion,
  );
  let settledKind: "SETTLED" | "UNSETTLED" = "SETTLED";
  try {
    const dispatched = session
      .dispatch({
        lane: RETRO_LANE,
        owner: RETRO_OWNER,
        purpose: RETRO_PURPOSE,
        requestedIdentity: o.spec.signature,
        url: o.rpcUrl,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
        jsonRpcId: requestId,
        timeoutMs: Math.max(1, Math.min(L.requestTimeoutMs, deadlineAtMs - clock.now())),
        maxResponseBytes: L.maxResponseBytes,
        refusal: () =>
          clock.failure !== null
            ? "CLOCK_FAILURE"
            : clock.now() >= deadlineAtMs
              ? "LIFETIME_EXPIRED"
              : null,
        waitSignals: signals,
        linkSignals: () => signals,
      })
      .then(
        () => ({ kind: "SETTLED" as const }),
        () => ({ kind: "SETTLED" as const }),
      );
    settledKind = (await Promise.race([dispatched, unsettled])).kind;
  } finally {
    session.stop("RETROSPECTIVE_FINISHED");
    if (settledKind === "SETTLED") {
      if (cleanupHandle !== null) rawTimers.clearTimeout(cleanupHandle);
      rawTimers.clearTimeout(hardBoundHandle);
    }
    decided = true;
    o.abortSignal?.removeEventListener("abort", onAbort);
    o.clockFailureSignal?.removeEventListener("abort", onClockFailure);
  }

  const status = session.getStatus();
  const httpAttempts = status.httpAttempts;
  const stopReason = status.stopReason === "RETROSPECTIVE_FINISHED" ? null : status.stopReason;
  const endedAtMs = Math.max(startedAtMs, clock.now());
  const common = {
    startedAtMs,
    deadlineAtMs,
    endedAtMs,
    requestId,
    requestBody,
    httpAttempts,
    sessionStopReason: stopReason,
    cancelled,
  };
  if (settledKind === "UNSETTLED") {
    o.failures.add("CLEANUP_UNSETTLED");
    return {
      ...common,
      outcome: "CLEANUP_UNSETTLED",
      detail: "REQUEST_NOT_SETTLED_WITHIN_CLEANUP_GRACE",
      exchange: null,
      analysis: null,
      analyzerBodyState: null,
    };
  }
  const e = exchange as PaperRequestExchangeEvidence | null;
  if (e === null) {
    const outcome: RetroTransportOutcome = cancelled
      ? "OPERATOR_CANCELLED"
      : clock.failure !== null
        ? "CLOCK_FAILURE"
        : stopReason === "LIFETIME_EXPIRED" || clock.now() >= deadlineAtMs
          ? "DEADLINE_EXPIRED"
          : "NOT_DISPATCHED";
    return {
      ...common,
      outcome,
      detail: outcome === "CLOCK_FAILURE" ? clock.failure : stopReason,
      exchange: null,
      analysis: null,
      analyzerBodyState: null,
    };
  }
  const completedAfterDeadline =
    e.entry.error === null && (e.entry.completedAtMs ?? Infinity) > deadlineAtMs;
  let outcome = transportOutcome(
    e.entry.error,
    e.entry.httpStatus,
    e.bodyState,
    stopReason,
    completedAfterDeadline,
  );
  if (e.entry.error !== null && cancelled) outcome = "OPERATOR_CANCELLED";
  else if (e.entry.error !== null && clock.failure !== null) outcome = "CLOCK_FAILURE";
  let analysis: RetroClassification | null = null;
  let analyzerBodyState: string | null = null;
  if (outcome === "RESPONSE_RECEIVED" && e.body !== null) {
    // The accepted credential-aware analyzer, unchanged, with the request's own cap.
    const a = analyzeCpmmTransactionResponse({
      notification: {
        signature: o.spec.signature,
        slot: o.spec.slot,
        receivedAtMs: o.spec.notificationReceivedAtMs,
      },
      jsonRpcId: requestId,
      pool: o.pool,
      responseBytes: e.body,
      maxResponseBytes: L.maxResponseBytes,
      secrets: [...o.analysisSecrets],
      maxSupportedTransactionVersion: L.maxSupportedTransactionVersion,
    }) as unknown as Record<string, unknown>;
    if (a.status === "ANALYZED") {
      analyzerBodyState = String(get(a, "body", "state"));
      analysis = fromAnalysis(a, decodeStrictUtf8(e.body), o.spec.versionClaim);
    } else {
      analysis = {
        kind: "ANALYSIS_INPUT_INVALID",
        code: FIXED_CODE.test(String(a.code)) ? String(a.code) : "ANALYSIS_INPUT_INVALID",
        detail: null,
        rpcErrorCode: null,
        decoderStatus: null,
        decoderReason: null,
        payloadBound: false,
        events: [],
        versionComparison: "NOT_COMPARED",
        v1PayloadBound: false,
      };
    }
  }
  return {
    ...common,
    outcome,
    detail: completedAfterDeadline ? "COMPLETED_AFTER_DEADLINE" : e.entry.error,
    exchange: e,
    analysis,
    analyzerBodyState,
  };
}

// ---------------------------------------------------------------------------------------------
// Record and sealing (exclusive create; the accepted sanitizer)
// ---------------------------------------------------------------------------------------------

function scrubBody(original: Buffer | null, bodyState: string, secrets: readonly string[]) {
  if (original === null) {
    return {
      state: "NOT_CAPTURED",
      withheldReason: null,
      originalBytes: null,
      originalSha256: null,
      storedEncoding: null,
      storedBytes: null,
      storedSha256: null,
      payload: null,
      payloadRedacted: false,
    };
  }
  const withheld = (reason: string, bytes: number, digest: string) => ({
    state: "WITHHELD",
    withheldReason: reason,
    originalBytes: bytes,
    originalSha256: digest,
    storedEncoding: null,
    storedBytes: null,
    storedSha256: null,
    payload: null,
    payloadRedacted: true,
  });
  let s: ReturnType<typeof sanitizeEvidenceBytes>;
  try {
    s = sanitizeEvidenceBytes(original, secrets, {
      partial: bodyState === "PARTIAL_OVERFLOW",
      parseJson: bodyState === "COMPLETE",
    });
  } catch {
    return withheld("CREDENTIAL_MATERIAL_DETECTED", original.length, sha256(original));
  }
  if (s.status === "WITHHELD") return withheld(s.reason, s.originalBytes, s.originalSha256);
  return {
    state: s.redacted ? "REDACTED" : "ORIGINAL",
    withheldReason: null,
    originalBytes: s.originalBytes,
    originalSha256: s.originalSha256,
    storedEncoding: s.encoding,
    storedBytes: s.storedBytes,
    storedSha256: s.storedSha256,
    payload: s.stored,
    payloadRedacted: s.redacted,
  };
}

export function retrospectiveRecord(
  a: RetrospectiveAcquisition,
  spec: RetrospectiveSourceSpec,
  runFailures: readonly string[],
  cancellationPhase: "DURING_REQUEST" | "BEFORE_SEALING" | null,
  secrets: readonly string[],
): Record<string, unknown> {
  const e = a.exchange;
  const redact = (t: string) => redactText(t, secrets);
  let response: Record<string, unknown> | null = null;
  if (e !== null) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(e.responseHeaders)) headers[k] = redact(v);
    response = {
      httpStatus: e.entry.httpStatus,
      headers,
      bodyState: e.bodyState,
      observedBytes: e.observedBodyBytes,
      maxResponseBytes: e.maxResponseBytes,
      ...scrubBody(e.body, e.bodyState, secrets),
    };
  }
  return {
    kind: RETRO_KIND,
    version: RETRO_VERSION,
    classification: RETRO_CLASSIFICATION,
    freshFlow: false,
    ingested: false,
    signature: spec.signature,
    limits: RETRO_LIMITS,
    limitations: RETRO_LIMITATIONS,
    nonCertifications: RETRO_NON_CERTIFICATIONS,
    request: {
      method: "POST",
      url: RETRO_RPC_URL_PLACEHOLDER,
      lane: RETRO_LANE,
      owner: RETRO_OWNER,
      purpose: RETRO_PURPOSE,
      requestedIdentity: spec.signature,
      rpcMethod: RETRO_RPC_METHOD,
      jsonRpcId: e === null && a.httpAttempts === 0 ? null : a.requestId,
      body: e === null && a.httpAttempts === 0 ? null : a.requestBody,
      dispatchedAtMs: e?.entry.dispatchedAtMs ?? null,
      completedAtMs: e?.entry.completedAtMs ?? null,
      error: e?.entry.error ? redact(e.entry.error) : null,
      entry:
        e === null
          ? null
          : {
              seq: e.entry.seq,
              lane: e.entry.lane,
              owner: e.entry.owner,
              purpose: e.entry.purpose,
              requestedIdentity: e.entry.requestedIdentity,
              jsonRpcId: e.entry.jsonRpcId,
              bodyComplete: e.entry.bodyComplete,
            },
    },
    response,
    recorded: {
      outcome: a.outcome,
      detail: a.detail === null ? null : redact(a.detail),
      sessionStopReason: a.sessionStopReason,
      httpAttempts: a.httpAttempts,
      cancelled: cancellationPhase !== null,
      cancellationPhase,
      runFailures: [...runFailures],
      analyzerBodyState: a.analyzerBodyState,
      analysis: a.analysis,
    },
    timing: {
      startedAtMs: a.startedAtMs,
      deadlineAtMs: a.deadlineAtMs,
      endedAtMs: a.endedAtMs,
      cleanupGraceMs: RETRO_LIMITS.cleanupGraceMs,
    },
  };
}

export type SealRetrospectiveResult =
  | { readonly ok: true; readonly manifestSha256: string }
  | {
      readonly ok: false;
      readonly status: "OUTPUT_DIRECTORY_UNAVAILABLE" | "SEAL_REFUSED" | "ARTIFACT_WRITE_FAILED";
      readonly reason: string;
    };
export type RetroFileWriter = (
  file: string,
  content: string,
  options: { readonly encoding: "utf8"; readonly flag: "wx" },
) => void;

function containsDetectableSecret(text: string, secrets: readonly string[]): boolean {
  if (secrets.length === 0) return false;
  for (const s of secrets) {
    if (s.length >= EVIDENCE_SANITIZER_LIMITS.minSuppliedSecretChars && text.includes(s)) {
      return true;
    }
  }
  try {
    const r = sanitizeEvidenceBytes(Buffer.from(text, "utf8"), secrets, {
      partial: false,
      parseJson: false,
    });
    return r.status === "WITHHELD" || r.redacted;
  } catch {
    return true;
  }
}

/** Every file is rendered and scanned first; the directory is created exclusively; manifest last. */
export function sealRetrospectiveEvidence(input: {
  readonly outDir: string;
  readonly plan: Readonly<Record<string, unknown>>;
  readonly sourceBinding: Readonly<Record<string, unknown>>;
  readonly record: Readonly<Record<string, unknown>>;
  readonly secrets: readonly string[];
  readonly writeFile?: RetroFileWriter | undefined;
}): SealRetrospectiveResult {
  const redact = (t: string) => redactText(t, input.secrets);
  const contents: [string, string][] = [
    [RETRO_FILES.plan, `${JSON.stringify(input.plan, null, 2)}\n`],
    [
      RETRO_FILES.sourceBinding,
      `${JSON.stringify(
        { kind: RETRO_SOURCE_BINDING_KIND, version: RETRO_VERSION, binding: input.sourceBinding },
        null,
        2,
      )}\n`,
    ],
    [RETRO_FILES.retrieval, `${JSON.stringify(input.record, null, 2)}\n`],
  ];
  for (const [name, text] of contents) {
    if (containsDetectableSecret(text, input.secrets)) {
      return {
        ok: false,
        status: "SEAL_REFUSED",
        reason: `a credential would be persisted in ${name}`,
      };
    }
  }
  const response = input.record.response;
  if (
    isRecord(response) &&
    response.storedEncoding === "base64" &&
    typeof response.payload === "string"
  ) {
    if (
      containsDetectableSecret(
        Buffer.from(response.payload, "base64").toString("latin1"),
        input.secrets,
      )
    ) {
      return {
        ok: false,
        status: "SEAL_REFUSED",
        reason: "a credential would be persisted in the stored response",
      };
    }
  }
  try {
    mkdirSync(path.dirname(input.outDir), { recursive: true });
    mkdirSync(input.outDir);
  } catch (err) {
    return {
      ok: false,
      status: "OUTPUT_DIRECTORY_UNAVAILABLE",
      reason: redact(err instanceof Error ? err.message : String(err)),
    };
  }
  const write = input.writeFile ?? ((f, c, opts) => writeFileSync(f, c, opts));
  const recorded = input.record.recorded as Record<string, unknown>;
  try {
    const files = contents.map(([name, text]) => {
      write(path.join(input.outDir, name), text, { encoding: "utf8", flag: "wx" });
      return { path: name, sha256: sha256(text), bytes: Buffer.byteLength(text, "utf8") };
    });
    const manifest = `${JSON.stringify(
      {
        kind: RETRO_MANIFEST_KIND,
        version: RETRO_VERSION,
        classification: RETRO_CLASSIFICATION,
        recordedOutcome: recorded.outcome,
        files,
      },
      null,
      2,
    )}\n`;
    write(path.join(input.outDir, RETRO_FILES.manifest), manifest, {
      encoding: "utf8",
      flag: "wx",
    });
    return { ok: true, manifestSha256: sha256(manifest) };
  } catch (err) {
    return {
      ok: false,
      status: "ARTIFACT_WRITE_FAILED",
      reason: redact(err instanceof Error ? err.message : String(err)),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Credential-free replay (design option b): pure decoder plus strict envelope checks
// ---------------------------------------------------------------------------------------------

/**
 * The analyzer's envelope, id, signature, slot and decoder steps over exact stored bytes, in the
 * same order and with the same fixed codes. The credential-aware scan is NOT repeated.
 */
export function replayRetrospectiveClassification(
  bytes: Buffer,
  jsonRpcId: number,
  spec: RetrospectiveSourceSpec,
  pool: RaydiumCpmmPoolStateSuccess,
): RetroClassification {
  const plain = (
    kind: string,
    code: string | null,
    rpcErrorCode: number | null = null,
  ): RetroClassification => ({
    kind,
    code,
    detail: null,
    rpcErrorCode,
    decoderStatus: null,
    decoderReason: null,
    payloadBound: false,
    events: [],
    versionComparison: "NOT_COMPARED",
    v1PayloadBound: false,
  });
  const text = decodeStrictUtf8(bytes);
  if (text === null || !Buffer.from(text, "utf8").equals(bytes)) {
    return plain("MALFORMED_RESPONSE", "INVALID_UTF8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return plain("MALFORMED_RESPONSE", "UNPARSABLE_JSON");
  }
  if (!isPlainRecord(parsed)) return plain("MALFORMED_RESPONSE", "ENVELOPE_NOT_OBJECT");
  for (const k of Object.keys(parsed)) {
    if (k !== "jsonrpc" && k !== "id" && k !== "result" && k !== "error") {
      return plain("MALFORMED_RESPONSE", "ENVELOPE_EXTRA_KEY");
    }
  }
  if (parsed.jsonrpc !== "2.0") return plain("MALFORMED_RESPONSE", "JSONRPC_VERSION");
  if (!hasOwn(parsed, "id")) return plain("MALFORMED_RESPONSE", "ID_MISSING");
  if (parsed.id !== jsonRpcId) return plain("MALFORMED_RESPONSE", "ID_MISMATCH");
  const hasResult = hasOwn(parsed, "result");
  const hasError = hasOwn(parsed, "error");
  if (hasResult && hasError) return plain("MALFORMED_RESPONSE", "RESULT_AND_ERROR");
  if (!hasResult && !hasError) return plain("MALFORMED_RESPONSE", "NO_RESULT_OR_ERROR");
  if (hasError) {
    const e = parsed.error;
    if (
      !isPlainRecord(e) ||
      Object.keys(e).some((k) => k !== "code" && k !== "message" && k !== "data") ||
      typeof e.code !== "number" ||
      !Number.isSafeInteger(e.code) ||
      typeof e.message !== "string"
    ) {
      return plain("MALFORMED_RESPONSE", "ERROR_OBJECT_INVALID");
    }
    // Preserved as an RPC error with its code; no contradiction is inferred from the code alone.
    return plain("RPC_ERROR", "JSON_RPC_ERROR", e.code);
  }
  const result = parsed.result;
  if (result === null) return plain("TRANSACTION_NOT_FOUND", "RESULT_NULL");
  if (!isPlainRecord(result)) return plain("MALFORMED_RESPONSE", "RESULT_NOT_OBJECT");
  const tx = result.transaction;
  const sig0 =
    isPlainRecord(tx) && Array.isArray(tx.signatures) ? (tx.signatures[0] as unknown) : undefined;
  if (typeof sig0 !== "string") return plain("SIGNATURE_MISMATCH", "SIGNATURE_MISSING");
  if (sig0 !== spec.signature) return plain("SIGNATURE_MISMATCH", "SIGNATURE_DIFFERENT");
  if (!isSafeCount(result.slot)) return plain("METADATA_CONTRADICTION", "SLOT_INVALID");
  if (result.slot !== spec.slot) return plain("METADATA_CONTRADICTION", "SLOT_MISMATCH");
  const d = decodeRaydiumCpmmTransactionSwaps(result, pool, {
    receiptTimestampMs: spec.notificationReceivedAtMs,
    maxSupportedTransactionVersion: RETRO_LIMITS.maxSupportedTransactionVersion,
  });
  const comparison = versionComparison(text, spec.versionClaim);
  const bound = {
    rpcErrorCode: null,
    decoderStatus: d.status,
    payloadBound: true,
    versionComparison: comparison,
    v1PayloadBound: comparison === "MATCHES_SOURCE_CLAIM" && spec.versionClaim === 1,
  };
  switch (d.status) {
    case "SWAP_DECODED":
      return {
        ...bound,
        kind: "RESOLVED_SWAPS",
        code: null,
        detail: null,
        decoderReason: null,
        events: eventData(d.events),
      };
    case "NO_MATCHING_SWAPS":
      return {
        ...bound,
        kind: "RESOLVED_NO_TARGET_SWAP",
        code: null,
        detail: null,
        decoderReason: null,
        events: [],
      };
    case "TRANSACTION_FAILED":
      return {
        ...bound,
        kind: "RECORDED_FAILED_TRANSACTION",
        code: null,
        detail: null,
        decoderReason: null,
        events: [],
      };
    default:
      return {
        ...bound,
        kind: "UNRESOLVED",
        code: FIXED_CODE.test(d.reason) ? d.reason : "UNRECOGNIZED_DECODER_REASON",
        detail: d.detail,
        decoderReason: d.reason,
        events: [],
      };
  }
}

/** Recorded (live analyzer) and computed (replay) agree; a filtered detail is not a mismatch. */
function classificationsAgree(
  recorded: RetroClassification,
  computed: RetroClassification,
): boolean {
  const detailOk =
    recorded.detail === computed.detail || recorded.detail === "UNRECOGNIZED_DECODER_DETAIL";
  return detailOk && same({ ...recorded, detail: null }, { ...computed, detail: null });
}

// ---------------------------------------------------------------------------------------------
// Offline verification (integrity, source binding, recorded and computed kept apart)
// ---------------------------------------------------------------------------------------------

export type RetroReplayStatus =
  | "REPRODUCED"
  | "MISMATCH"
  | "NOT_APPLICABLE"
  | "UNAVAILABLE_REDACTED"
  | "UNAVAILABLE_WITHHELD"
  | "UNAVAILABLE_INCOMPLETE"
  | "UNAVAILABLE_CREDENTIAL_SCAN_NOT_REPEATED"
  | "UNAVAILABLE_SOURCE_NOT_BOUND";

export interface RetrospectiveVerification {
  readonly integrity: { readonly ok: boolean; readonly problems: readonly string[] };
  readonly manifestSha256: string | null;
  readonly sourceBinding: {
    readonly status: "VERIFIED" | "FAILED";
    readonly problems: readonly string[];
  } | null;
  readonly recorded: {
    readonly outcome: string;
    readonly runFailures: readonly string[];
    readonly cancelled: boolean;
    readonly analysis: RetroClassification | null;
  } | null;
  readonly computed: {
    readonly replayStatus: RetroReplayStatus;
    readonly transportOutcome: string | null;
    readonly classification: RetroClassification | null;
    /** Always false: credential-free verification never repeats the credential-aware scan. */
    readonly credentialScanRepeated: false;
  } | null;
}

const NO_EXCHANGE_OUTCOMES: readonly string[] = [
  "NOT_DISPATCHED",
  "DEADLINE_EXPIRED",
  "OPERATOR_CANCELLED",
  "CLOCK_FAILURE",
  "CLEANUP_UNSETTLED",
];
const RETRO_RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PLAN_OUT_DIR = new RegExp(
  `^${RETRO_ROOT_SEGMENTS.join("/")}/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`,
);

/**
 * The sealed response against the accepted bounded reader (`PaperRequestSession`):
 * - COMPLETE: no session error, the entry's `bodyComplete`, an HTTP status, and the whole body
 *   within the cap (`observedBytes === originalBytes <= 262,144`).
 * - PARTIAL_OVERFLOW: `RESPONSE_TOO_LARGE`, not complete, a retained prefix of exactly the cap
 *   (`originalBytes === 262,144`; the reader fills to the cap before it reports overflow), and more
 *   bytes observed than the cap.
 * - NOT_READ: a session error, not complete, nothing observed and nothing captured.
 * Stored bytes must match their own digest and size; ORIGINAL bytes equal the original exactly,
 * REDACTED bytes differ from it, WITHHELD bytes are absent. Returns the stored bytes, or null when
 * any of this is incoherent.
 */
function responseAccounting(
  resp: unknown,
  error: unknown,
  entry: unknown,
): { readonly stored: Buffer | null } | null {
  const max = RETRO_LIMITS.maxResponseBytes;
  const state = get(resp, "state");
  const bodyState = get(resp, "bodyState");
  const observed = get(resp, "observedBytes");
  const original = get(resp, "originalBytes");
  const http = get(resp, "httpStatus");
  if (!isRecord(resp) || entry === null || !isRecord(entry)) return null;
  if (get(resp, "maxResponseBytes") !== max) return null;
  if (!(http === null || (isSafeCount(http) && http >= 100 && http <= 599))) return null;
  if (get(entry, "bodyComplete") !== (bodyState === "COMPLETE")) return null;
  if (!(error === null || (typeof error === "string" && FIXED_CODE.test(error)))) return null;
  const noStored =
    resp.payload === null &&
    resp.storedEncoding === null &&
    resp.storedBytes === null &&
    resp.storedSha256 === null;
  const originalDigestOk =
    typeof resp.originalSha256 === "string" && HEX64.test(resp.originalSha256);
  let stored: Buffer | null = null;
  switch (state) {
    case "NOT_CAPTURED":
      if (
        !noStored ||
        original !== null ||
        resp.originalSha256 !== null ||
        resp.payloadRedacted !== false ||
        resp.withheldReason !== null
      ) {
        return null;
      }
      break;
    case "WITHHELD":
      if (
        !noStored ||
        !isSafeCount(original) ||
        !originalDigestOk ||
        resp.payloadRedacted !== true ||
        typeof resp.withheldReason !== "string"
      ) {
        return null;
      }
      break;
    case "ORIGINAL":
    case "REDACTED": {
      const payload = resp.payload;
      const enc = resp.storedEncoding;
      stored =
        typeof payload !== "string"
          ? null
          : enc === "utf8"
            ? Buffer.from(payload, "utf8")
            : enc === "base64"
              ? Buffer.from(payload, "base64")
              : null;
      if (
        stored === null ||
        (enc === "base64" && stored.toString("base64") !== payload) ||
        resp.storedBytes !== stored.length ||
        resp.storedSha256 !== sha256(stored) ||
        resp.payloadRedacted !== (state === "REDACTED") ||
        resp.withheldReason !== null ||
        !isSafeCount(original) ||
        !originalDigestOk
      ) {
        return null;
      }
      if (
        state === "ORIGINAL"
          ? stored.length !== original || resp.originalSha256 !== resp.storedSha256
          : resp.originalSha256 === resp.storedSha256
      ) {
        return null;
      }
      break;
    }
    default:
      return null;
  }
  switch (bodyState) {
    case "COMPLETE":
      return error === null &&
        http !== null &&
        state !== "NOT_CAPTURED" &&
        (original as number) <= max &&
        observed === original
        ? { stored }
        : null;
    case "PARTIAL_OVERFLOW":
      // The bounded reader retains exactly the cap on overflow (original counts, not the
      // redacted stored length).
      return error === "RESPONSE_TOO_LARGE" &&
        http !== null &&
        state !== "NOT_CAPTURED" &&
        original === max &&
        isSafeCount(observed) &&
        observed > max
        ? { stored }
        : null;
    case "NOT_READ":
      return error !== null && state === "NOT_CAPTURED" && observed === null ? { stored } : null;
    default:
      return null;
  }
}

export function verifyRetrospectiveEvidence(
  dir: string,
  options: {
    readonly projectRoot: string;
    readonly spec?: RetrospectiveSourceSpec | undefined;
    readonly sourceDeps?: RetrospectiveSourceDeps | undefined;
  },
): RetrospectiveVerification {
  const spec = options.spec ?? RETRO_SOURCE;
  const problems: string[] = [];
  let manifestSha256: string | null = null;
  let recorded: RetrospectiveVerification["recorded"] = null;
  let sourceBinding: RetrospectiveVerification["sourceBinding"] = null;
  const fail = (): RetrospectiveVerification => ({
    integrity: { ok: false, problems: [...problems] },
    manifestSha256,
    sourceBinding,
    recorded,
    computed: null,
  });
  try {
    try {
      const st = lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) problems.push("OUTPUT_DIRECTORY_INVALID");
    } catch {
      problems.push("OUTPUT_DIRECTORY_MISSING");
    }
    if (problems.length > 0) return fail();
    const expected: readonly string[] = [
      RETRO_FILES.plan,
      RETRO_FILES.sourceBinding,
      RETRO_FILES.retrieval,
    ];
    const names = readdirSync(dir);
    if (names.length > RETRO_VERIFIER_LIMITS.maxEntries) {
      problems.push("TOO_MANY_ENTRIES");
      return fail();
    }
    for (const n of names) {
      if (n !== RETRO_FILES.manifest && !expected.includes(n)) problems.push(`UNLISTED:${n}`);
    }
    if (problems.length > 0) return fail();
    const mb = readBounded(
      path.join(dir, RETRO_FILES.manifest),
      RETRO_VERIFIER_LIMITS.maxManifestBytes,
      RETRO_FILES.manifest,
    );
    if (typeof mb === "string") {
      problems.push(mb, "MANIFEST_MISSING_OR_INVALID");
      return fail();
    }
    manifestSha256 = sha256(mb);
    const manifest = parseJson(mb);
    if (
      !isRecord(manifest) ||
      manifest.kind !== RETRO_MANIFEST_KIND ||
      manifest.version !== RETRO_VERSION ||
      manifest.classification !== RETRO_CLASSIFICATION ||
      !Array.isArray(manifest.files) ||
      manifest.files.length !== expected.length ||
      manifest.files.some(
        (f, i) =>
          !isRecord(f) ||
          f.path !== expected[i] ||
          typeof f.sha256 !== "string" ||
          !HEX64.test(f.sha256) ||
          !isSafeCount(f.bytes),
      )
    ) {
      problems.push("MANIFEST_INVALID");
      return fail();
    }
    const docs = new Map<string, unknown>();
    for (const f of manifest.files as Record<string, unknown>[]) {
      const name = String(f.path);
      const b = readBounded(path.join(dir, name), RETRO_VERIFIER_LIMITS.maxFileBytes, name);
      if (typeof b === "string") problems.push(b);
      else if (b.length !== f.bytes || sha256(b) !== f.sha256) problems.push(`MODIFIED:${name}`);
      else docs.set(name, parseJson(b));
    }
    if (problems.length > 0) return fail();

    const plan = docs.get(RETRO_FILES.plan);
    const outDir = get(plan, "outDir");
    if (
      typeof outDir !== "string" ||
      !PLAN_OUT_DIR.test(outDir) ||
      !same(plan, buildRetrospectivePlan(spec, { outDir, mode: "LIVE" }))
    ) {
      problems.push("PLAN_INVALID");
    }
    if (
      !same(docs.get(RETRO_FILES.sourceBinding), {
        kind: RETRO_SOURCE_BINDING_KIND,
        version: RETRO_VERSION,
        binding: expectedSourceBindingRecord(spec),
      })
    ) {
      problems.push("SOURCE_BINDING_RECORD_INVALID");
    }
    const r = docs.get(RETRO_FILES.retrieval);
    if (
      !isRecord(r) ||
      r.kind !== RETRO_KIND ||
      r.version !== RETRO_VERSION ||
      r.classification !== RETRO_CLASSIFICATION ||
      r.freshFlow !== false ||
      r.ingested !== false ||
      r.signature !== spec.signature ||
      !same(r.limits, RETRO_LIMITS) ||
      !same(r.limitations, RETRO_LIMITATIONS) ||
      !same(r.nonCertifications, RETRO_NON_CERTIFICATIONS)
    ) {
      problems.push("RECORD_INVALID");
      return fail();
    }
    const rec = r.recorded;
    const outcome = get(rec, "outcome");
    const runFailures = get(rec, "runFailures");
    if (
      typeof outcome !== "string" ||
      !TRANSPORT_OUTCOMES.includes(outcome) ||
      !Array.isArray(runFailures) ||
      !runFailures.every((x) => typeof x === "string") ||
      typeof get(rec, "cancelled") !== "boolean" ||
      get(manifest, "recordedOutcome") !== outcome
    ) {
      problems.push("RECORDED_OUTCOME_INVALID");
      return fail();
    }
    const recordedAnalysis = (get(rec, "analysis") ?? null) as RetroClassification | null;
    recorded = {
      outcome,
      runFailures: runFailures as string[],
      cancelled: get(rec, "cancelled") as boolean,
      analysis: recordedAnalysis,
    };
    // Request evidence: the exact cap-1 body, the distinct purpose and owner, at most one attempt.
    const req = r.request;
    const id = get(req, "jsonRpcId");
    const attempts = get(rec, "httpAttempts");
    if (
      get(req, "method") !== "POST" ||
      get(req, "url") !== RETRO_RPC_URL_PLACEHOLDER ||
      get(req, "lane") !== RETRO_LANE ||
      get(req, "owner") !== RETRO_OWNER ||
      get(req, "purpose") !== RETRO_PURPOSE ||
      get(req, "requestedIdentity") !== spec.signature ||
      get(req, "rpcMethod") !== RETRO_RPC_METHOD ||
      !(attempts === 0 || attempts === 1) ||
      (id === null
        ? get(req, "body") !== null
        : !isSafeCount(id) ||
          id < 1 ||
          get(req, "body") !== cpmmGetTransactionRequestBody(spec.signature, id, 1))
    ) {
      problems.push("REQUEST_EVIDENCE_INVALID");
      return fail();
    }
    const entry = get(req, "entry");
    if (
      entry !== null &&
      (get(entry, "lane") !== RETRO_LANE ||
        get(entry, "owner") !== RETRO_OWNER ||
        get(entry, "purpose") !== RETRO_PURPOSE ||
        get(entry, "requestedIdentity") !== spec.signature ||
        get(entry, "jsonRpcId") !== id)
    ) {
      problems.push("REQUEST_ENTRY_INVALID");
    }
    const t = r.timing;
    const started = get(t, "startedAtMs");
    if (
      !isSafeCount(started) ||
      get(t, "deadlineAtMs") !== started + RETRO_LIMITS.acquisitionDeadlineMs ||
      !isSafeCount(get(t, "endedAtMs")) ||
      (get(t, "endedAtMs") as number) < started ||
      get(t, "cleanupGraceMs") !== RETRO_LIMITS.cleanupGraceMs
    ) {
      problems.push("TIMING_INVALID");
    }
    if (problems.length > 0) return fail();
    // Attempts, entry and response presence, and the start/dispatch/completion/end ordering.
    const deadline = get(t, "deadlineAtMs") as number;
    const ended = get(t, "endedAtMs") as number;
    const dispatched = get(req, "dispatchedAtMs");
    const completed = get(req, "completedAtMs");
    if (entry === null) {
      // No exchange: never dispatched (zero attempts, no id), or dispatched and never settled.
      const unsettledDispatch = outcome === "CLEANUP_UNSETTLED" && attempts === 1 && id !== null;
      if (!unsettledDispatch && !(attempts === 0 && id === null)) {
        problems.push("ATTEMPTS_INCONSISTENT");
      }
      if (dispatched !== null || completed !== null) problems.push("TIMING_ORDER_INVALID");
    } else {
      if (attempts !== 1 || id === null || r.response === null) {
        problems.push(
          attempts !== 1 || id === null ? "ATTEMPTS_INCONSISTENT" : "RESPONSE_ACCOUNTING_INVALID",
        );
      }
      if (!isSafeCount(dispatched) || !isSafeCount(completed)) {
        problems.push("TIMING_ORDER_INVALID");
      } else {
        // The session refuses any dispatch at or after the deadline.
        if (dispatched >= deadline) problems.push("DISPATCH_AT_OR_AFTER_DEADLINE");
        if (!((started as number) <= dispatched && dispatched <= completed && completed <= ended)) {
          problems.push("TIMING_ORDER_INVALID");
        }
      }
    }
    if (ended > deadline + RETRO_LIMITS.cleanupGraceMs) problems.push("TIMING_ORDER_INVALID");
    if (problems.length > 0) return fail();

    // The source capture, bound again read-only.
    const bound = bindRetrospectiveSource(options.projectRoot, spec, options.sourceDeps);
    sourceBinding = bound.ok
      ? { status: "VERIFIED", problems: [] }
      : { status: "FAILED", problems: bound.problems };

    // Response accounting, then the credential-free replay.
    const resp = r.response;
    let replayStatus: RetroReplayStatus = "NOT_APPLICABLE";
    let computedOutcome: string | null = outcome;
    let computedClassification: RetroClassification | null = null;
    if (resp === null) {
      // Only outcomes without any exchange can lack a response record.
      if (!NO_EXCHANGE_OUTCOMES.includes(outcome) || recordedAnalysis !== null || entry !== null) {
        problems.push("RESPONSE_ACCOUNTING_INVALID");
      }
    } else {
      const state = get(resp, "state");
      const bodyState = get(resp, "bodyState");
      const httpStatus = get(resp, "httpStatus");
      const error = get(req, "error");
      const accounting = responseAccounting(resp, error, entry);
      if (accounting === null) {
        problems.push("RESPONSE_ACCOUNTING_INVALID");
        return fail();
      }
      const stored = accounting.stored;
      const completedAt = get(req, "completedAtMs");
      const late =
        error === null &&
        (!isSafeCount(completedAt) || completedAt > (get(t, "deadlineAtMs") as number));
      const derived = transportOutcome(
        (error as string | null) ?? null,
        (httpStatus as number | null) ?? null,
        String(bodyState),
        (get(rec, "sessionStopReason") as string | null) ?? null,
        late,
      );
      const recordedCancelOrClock =
        outcome === "OPERATOR_CANCELLED" ||
        outcome === "CLOCK_FAILURE" ||
        outcome === "CLEANUP_UNSETTLED";
      computedOutcome =
        recordedCancelOrClock && derived !== "RESPONSE_RECEIVED" ? outcome : derived;
      if (computedOutcome !== outcome) replayStatus = "MISMATCH";
      else if (outcome === "RESPONSE_RECEIVED") {
        if (recordedAnalysis?.kind === "EVIDENCE_NOT_REPLAYABLE") {
          replayStatus = "UNAVAILABLE_CREDENTIAL_SCAN_NOT_REPEATED";
        } else if (state === "WITHHELD") replayStatus = "UNAVAILABLE_WITHHELD";
        else if (state === "REDACTED") replayStatus = "UNAVAILABLE_REDACTED";
        else if (bodyState !== "COMPLETE" || stored === null)
          replayStatus = "UNAVAILABLE_INCOMPLETE";
        else if (!bound.ok) replayStatus = "UNAVAILABLE_SOURCE_NOT_BOUND";
        else if (recordedAnalysis === null || !isSafeCount(id)) replayStatus = "MISMATCH";
        else {
          computedClassification = replayRetrospectiveClassification(stored, id, spec, bound.pool);
          replayStatus = classificationsAgree(recordedAnalysis, computedClassification)
            ? "REPRODUCED"
            : "MISMATCH";
        }
      } else if (recordedAnalysis !== null) {
        replayStatus = "MISMATCH";
      } else {
        replayStatus = "REPRODUCED";
      }
    }
    if (resp === null) replayStatus = recordedAnalysis === null ? "REPRODUCED" : "MISMATCH";
    if (problems.length > 0) return fail();
    return {
      integrity: { ok: true, problems: [] },
      manifestSha256,
      sourceBinding,
      recorded,
      computed: {
        replayStatus,
        transportOutcome: computedOutcome,
        classification: computedClassification,
        credentialScanRepeated: false,
      },
    };
  } catch {
    problems.push("EVIDENCE_RECORD_MALFORMED");
    return fail();
  }
}

// ---------------------------------------------------------------------------------------------
// Plan, exit codes and CLI
// ---------------------------------------------------------------------------------------------

export function buildRetrospectivePlan(
  spec: RetrospectiveSourceSpec,
  input: { readonly outDir: string; readonly mode: "DRY_RUN" | "LIVE" },
) {
  return {
    kind: RETRO_PLAN_KIND,
    version: RETRO_VERSION,
    executionContext: "PAPER_RESEARCH_RETROSPECTIVE_TRANSACTION_ONLY",
    classification: RETRO_CLASSIFICATION,
    mode: input.mode,
    approval: RETRO_APPROVAL_STATUS,
    liveExecution: RETRO_LIVE_STATUS,
    liveFlag: RETRO_LIVE_FLAG_MEANING,
    signature: spec.signature,
    outDir: input.outDir,
    endpoint: "SOLANA_RPC_URL: required, https, no fragment (configuration; never printed)",
    source: expectedSourceBindingRecord(spec),
    request: {
      method: "POST",
      lane: RETRO_LANE,
      owner: RETRO_OWNER,
      purpose: RETRO_PURPOSE,
      rpcMethod: RETRO_RPC_METHOD,
      params: [spec.signature, CPMM_GET_TRANSACTION_V1_CONFIG],
    },
    limits: RETRO_LIMITS,
    outcomes: {
      transport: TRANSPORT_OUTCOMES,
      responseKinds: [
        "RESOLVED_SWAPS",
        "RESOLVED_NO_TARGET_SWAP",
        "RECORDED_FAILED_TRANSACTION",
        "UNRESOLVED",
        "RPC_ERROR",
        "TRANSACTION_NOT_FOUND",
        "SIGNATURE_MISMATCH",
        "METADATA_CONTRADICTION",
        "MALFORMED_RESPONSE",
        "EVIDENCE_NOT_REPLAYABLE",
      ],
      versionComparison: [
        "NOT_COMPARED",
        "MATCHES_SOURCE_CLAIM",
        "DIFFERS_FROM_SOURCE_CLAIM",
        "UNRESOLVED_VERSION_FIELD",
      ],
    },
    limitations: RETRO_LIMITATIONS,
    nonCertifications: RETRO_NON_CERTIFICATIONS,
    sequence: [
      "Validate flags and the new output directory; bind the source capture read-only (refusal: zero requests, nothing written)",
      "Load configuration only in --live; resolve an https SOLANA_RPC_URL (no WebSocket)",
      "At most one cap-1 getTransaction within one absolute 15,000 ms deadline (10,000 ms request timeout, 5,000 ms settled cleanup)",
      "Analyze with the accepted credential-aware analyzer; never ingest; seal exclusively as supplemental evidence; verify offline",
    ],
  };
}

export function retrospectiveVerifyExitCode(v: RetrospectiveVerification): number {
  const X = RETRO_EXIT_CODES;
  if (!v.integrity.ok || v.recorded === null || v.computed === null) return X.INTEGRITY_FAILED;
  if (v.sourceBinding?.status !== "VERIFIED") return X.INTEGRITY_FAILED;
  if (v.computed.replayStatus === "MISMATCH") return X.INTEGRITY_FAILED;
  const first = v.recorded.runFailures[0];
  if (first === "OPERATOR_CANCELLED") return X.CANCELLED;
  if (first !== undefined) return X.NO_TRANSACTION_PAYLOAD;
  if (v.computed.replayStatus.startsWith("UNAVAILABLE_")) return X.EVIDENCE_LIMITED;
  return v.recorded.analysis?.payloadBound === true && v.computed.replayStatus === "REPRODUCED"
    ? X.OK
    : X.NO_TRANSACTION_PAYLOAD;
}

export const RETRO_USAGE = [
  "Usage: cpmm-retrospective-transaction [--help] | --out-dir <dir> [--live] | --verify <dir>",
  "  --help           Print this usage and the plan (nothing loaded, read, opened, sent or written).",
  "  --out-dir <dir>  New directory directly inside data/research/cpmm-retrospective-transactions/ (default: dry run).",
  "  --live           At most one cap-1 getTransaction for the fixed source signature (separate approval required).",
  "  --verify <dir>   Read-only offline verification (no configuration or credentials; source capture re-bound).",
  "Exit codes: 0 transaction payload bound and reproduced, 1 invalid input/config/source refusal, 2 limited (exact replay impossible),",
  "            3 no transaction payload or run failure, 4 integrity/binding failure, 5 seal failure, 6 cancelled, 7 listener cleanup failure.",
].join("\n");

const trustedRefusals = new WeakSet<Error>();
function refusal(message: string): Error {
  const err = new Error(message);
  trustedRefusals.add(err);
  return Object.freeze(err);
}
const cliError = (m: string) => refusal(`[CLI_INVALID_ARG] ${m}`);
export const printableRetrospectiveError = (err: unknown): string =>
  err instanceof Error && trustedRefusals.has(err) ? err.message : "[UNEXPECTED_ERROR]";

export const RETRO_CONFIG_ERRORS = Object.freeze({
  configurationLoad:
    "[CONFIGURATION_LOAD_FAILED] the configuration loader failed; its error text is withheld",
  rpcMissing: "[MISSING_CONFIGURATION] SOLANA_RPC_URL is required for --live",
  rpcHttps: "[INVALID_CONFIGURATION] SOLANA_RPC_URL must use https without a fragment for --live",
  secretsInvalid: "[INVALID_CONFIGURATION] endpoint credentials are unsupported or malformed",
  signalInstall:
    "[SIGNAL_INSTALL_FAILED] a signal listener could not be installed; the run did not start",
});

export interface RetroSignalSource {
  on(signal: RetroSignal, listener: () => void): unknown;
  removeListener(signal: RetroSignal, listener: () => void): unknown;
}

export interface RetroCliDeps {
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly loadEnvironment?: (() => void | Promise<void>) | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly clock?: (() => number) | undefined;
  readonly timers?: PaperRequestSessionTimers | undefined;
  readonly projectRoot?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly signals?: RetroSignalSource | undefined;
  readonly log?: ((line: string) => void) | undefined;
  readonly writeFile?: RetroFileWriter | undefined;
  /** Tests only: a synthetic source spec and source verifiers (the CLI default is RETRO_SOURCE). */
  readonly spec?: RetrospectiveSourceSpec | undefined;
  readonly sourceDeps?: RetrospectiveSourceDeps | undefined;
}

export interface RetroRunResult {
  readonly mode: "HELP" | "DRY_RUN" | "LIVE" | "VERIFY";
  readonly exitCode: number;
  readonly planDigestSha256?: string | undefined;
  readonly outDir?: string | undefined;
  readonly acquisition?: RetrospectiveAcquisition | undefined;
  readonly record?: Readonly<Record<string, unknown>> | undefined;
  readonly seal?: SealRetrospectiveResult | undefined;
  readonly verification?: RetrospectiveVerification | undefined;
  /** Run failures through the final decision boundary (earliest first). */
  readonly runFailures?: readonly string[] | undefined;
  readonly signalCleanupFailures?: readonly string[] | undefined;
}

type ParsedCli =
  | { readonly mode: "HELP" }
  | { readonly mode: "VERIFY"; readonly verifyDir: string }
  | { readonly mode: "DRY_RUN" | "LIVE"; readonly outDir: string };

function parseCli(rawArgs: readonly string[]): ParsedCli {
  let values: Record<string, string | boolean | undefined>;
  let tokens: readonly { kind: string; name?: string }[] = [];
  try {
    ({ values, tokens = [] } = parseArgs({
      args: [...rawArgs],
      options: {
        help: { type: "boolean" },
        live: { type: "boolean" },
        "out-dir": { type: "string" },
        verify: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
      tokens: true,
    }));
  } catch {
    throw cliError("unknown, malformed or positional argument");
  }
  const seen = new Set<string>();
  for (const t of tokens) {
    if (t.kind !== "option" || t.name === undefined) continue;
    if (seen.has(t.name)) throw cliError(`--${t.name} may be given only once`);
    seen.add(t.name);
  }
  if (values.help === true) {
    if (seen.size > 1) throw cliError("--help cannot be combined with other options");
    return { mode: "HELP" };
  }
  if (values.verify !== undefined) {
    if (seen.size > 1) throw cliError("--verify cannot be combined with --live or --out-dir");
    const verifyDir = String(values.verify);
    if (verifyDir === "") throw cliError("--verify requires a directory path");
    return { mode: "VERIFY", verifyDir };
  }
  const outDir = values["out-dir"];
  if (typeof outDir !== "string" || outDir === "") {
    throw cliError(
      "--out-dir is required (a new directory inside data/research/cpmm-retrospective-transactions/)",
    );
  }
  return { mode: values.live === true ? "LIVE" : "DRY_RUN", outDir };
}

const rel = (projectRoot: string, p: string): string => {
  const r = path.relative(projectRoot, p);
  return (r === "" || r.startsWith("..") || path.isAbsolute(r) ? p : r).replace(/\\/g, "/");
};

async function loadConfiguredEnvironment(): Promise<void> {
  (await import("./paper-trading-daemon.js")).loadDaemonEnvironment();
}

export async function runCpmmRetrospectiveTransactionCli(
  rawArgs: readonly string[],
  deps: RetroCliDeps = {},
): Promise<RetroRunResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const parsed = parseCli(rawArgs);
  const X = RETRO_EXIT_CODES;
  const spec = deps.spec ?? RETRO_SOURCE;

  if (parsed.mode === "HELP") {
    const planJson = JSON.stringify(
      buildRetrospectivePlan(spec, {
        outDir: `${RETRO_ROOT_SEGMENTS.join("/")}/<run name>`,
        mode: "DRY_RUN",
      }),
    );
    log(RETRO_USAGE);
    log(
      "[HELP] No configuration loaded, nothing read, no transport opened, nothing sent or written.",
    );
    log(planJson);
    return { mode: "HELP", exitCode: X.OK, planDigestSha256: sha256(planJson) };
  }

  const projectRoot = path.resolve(deps.projectRoot ?? findWorkspaceRoot());
  const root = path.join(projectRoot, ...RETRO_ROOT_SEGMENTS);

  if (parsed.mode === "VERIFY") {
    const v = verifyRetrospectiveEvidence(path.resolve(projectRoot, parsed.verifyDir), {
      projectRoot,
      spec,
      sourceDeps: deps.sourceDeps,
    });
    log("[VERIFY] Offline and read-only: no configuration or credential loaded, nothing written.");
    log(
      `[VERIFY] Integrity: ${v.integrity.ok ? "OK" : `FAILED (${v.integrity.problems.join(", ")})`}`,
    );
    log(
      `[VERIFY] Source binding: ${v.sourceBinding?.status ?? "NOT_EVALUATED"}${v.sourceBinding && v.sourceBinding.problems.length > 0 ? ` (${v.sourceBinding.problems.join(", ")})` : ""}`,
    );
    log(
      `[VERIFY] Recorded: ${v.recorded?.outcome ?? "UNKNOWN"}; ${v.recorded?.analysis?.kind ?? "no response classification"}`,
    );
    log(
      `[VERIFY] Computed replay: ${v.computed?.replayStatus ?? "UNKNOWN"}; credential-aware scan repeated: no`,
    );
    log(
      `[VERIFY] Non-certifications (all false): ${Object.keys(RETRO_NON_CERTIFICATIONS).join(", ")}`,
    );
    return { mode: "VERIFY", exitCode: retrospectiveVerifyExitCode(v), verification: v };
  }

  const outDir = path.resolve(projectRoot, parsed.outDir);
  if (path.dirname(outDir) !== root || !RETRO_RUN_NAME.test(path.basename(outDir))) {
    throw cliError(
      `--out-dir must name a new run directory directly inside ${RETRO_ROOT_SEGMENTS.join("/")}/`,
    );
  }
  const outRel = rel(projectRoot, outDir);
  if (existsSync(outDir)) {
    throw refusal(`[OUTPUT_EXISTS] ${outRel} already exists; refusing to overwrite`);
  }
  const plan = buildRetrospectivePlan(spec, { outDir: outRel, mode: parsed.mode });
  const planJson = JSON.stringify(plan);
  const planDigestSha256 = sha256(planJson);

  // Preflight: the source capture, read-only, before any configuration. A refusal sends nothing.
  const source = bindRetrospectiveSource(projectRoot, spec, deps.sourceDeps);
  if (!source.ok) {
    throw refusal(
      `[SOURCE_BINDING_REFUSED] ${source.problems.join(", ")}; nothing sent or written`,
    );
  }

  if (parsed.mode === "DRY_RUN") {
    log("[DRY_RUN] No configuration loaded, no transport opened, nothing sent, nothing written.");
    log(`[DRY_RUN] Source binding: VERIFIED (${spec.runId}, read-only)`);
    log(`[DRY_RUN] Approval status: ${RETRO_APPROVAL_STATUS}`);
    log(`[DRY_RUN] Live execution: ${RETRO_LIVE_STATUS}`);
    log(`[DRY_RUN] Plan digest (sha256): ${planDigestSha256}`);
    log(planJson);
    return { mode: "DRY_RUN", exitCode: X.OK, planDigestSha256, outDir: outRel };
  }

  const C = RETRO_CONFIG_ERRORS;
  try {
    await (deps.loadEnvironment ?? loadConfiguredEnvironment)();
  } catch {
    throw refusal(C.configurationLoad);
  }
  const env = deps.env ?? process.env;
  const rpcUrl = env.SOLANA_RPC_URL ?? "";
  if (rpcUrl === "") throw refusal(C.rpcMissing);
  let parsedRpc: URL;
  try {
    parsedRpc = new URL(rpcUrl);
  } catch {
    throw refusal(C.rpcHttps);
  }
  if (parsedRpc.protocol !== "https:" || rpcUrl.includes("#")) throw refusal(C.rpcHttps);
  if (rpcUrl.length < 6 || rpcUrl.length > 4096 || !/^[\x21-\x7e]+$/.test(rpcUrl)) {
    throw refusal(C.secretsInvalid);
  }
  let secrets: readonly string[];
  try {
    secrets = deriveEvidenceSecrets([rpcUrl], []);
  } catch {
    throw refusal(C.secretsInvalid);
  }

  log(`[LIVE] ${RETRO_LIVE_FLAG_MEANING}`);
  log(`[LIVE] Plan digest (sha256): ${planDigestSha256}`);
  const failures = createRetrospectiveRunFailures();
  const clockFailure = new AbortController();
  const clock = createRetrospectiveClock(deps.clock ?? (() => Date.now()), failures, () =>
    clockFailure.abort(),
  );
  const signals = deps.signals ?? process;
  const controller = new AbortController();
  const external = deps.signal;
  const onExternal = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onExternal, { once: true });
  }
  let listening = true;
  const listeners = new Map(
    RETRO_SIGNALS.map((s) => [
      s,
      () => {
        if (!listening || controller.signal.aborted) return;
        log(`[LIVE] ${s} received: cancelling; the partial record is still sealed`);
        controller.abort();
      },
    ]),
  );
  const attempted: RetroSignal[] = [];
  const signalCleanupFailures: string[] = [];
  let acquisition: RetrospectiveAcquisition | null = null;
  let record: Record<string, unknown> | null = null;
  let seal: SealRetrospectiveResult | null = null;
  let verification: RetrospectiveVerification | undefined;
  let code: number = X.INVALID;
  // Listeners stay attached through the final decision boundary, then are removed exactly once.
  const removeListeners = () => {
    if (!listening) return;
    listening = false;
    external?.removeEventListener("abort", onExternal);
    for (const s of attempted) {
      try {
        signals.removeListener(s, listeners.get(s)!);
      } catch {
        signalCleanupFailures.push(`SIGNAL_REMOVE_FAILED:${s}`);
      }
    }
  };
  try {
    let installFailed = false;
    try {
      for (const s of RETRO_SIGNALS) {
        attempted.push(s);
        signals.on(s, listeners.get(s)!);
      }
    } catch {
      installFailed = true;
    }
    if (installFailed) {
      removeListeners();
      throw refusal(
        signalCleanupFailures.length === 0
          ? C.signalInstall
          : `${C.signalInstall}; listener cleanup failed: ${signalCleanupFailures.join(", ")}`,
      );
    }
    acquisition = await runRetrospectiveRequest({
      spec,
      pool: source.pool,
      rpcUrl,
      analysisSecrets: [rpcUrl],
      fetchFn: deps.fetchFn ?? globalThis.fetch,
      clock,
      failures,
      timers: deps.timers,
      abortSignal: controller.signal,
      clockFailureSignal: clockFailure.signal,
    });
    const abortedDuringRequest = controller.signal.aborted;
    log(
      `[LIVE] Outcome: ${acquisition.outcome}; response: ${acquisition.analysis?.kind ?? "none"}`,
    );
    // Cancellation after the request and before sealing is still a cancellation (checked last).
    if (controller.signal.aborted) failures.add("OPERATOR_CANCELLED");
    clock.now();
    const cancellationPhase = abortedDuringRequest
      ? "DURING_REQUEST"
      : controller.signal.aborted
        ? "BEFORE_SEALING"
        : null;
    record = retrospectiveRecord(acquisition, spec, failures.list, cancellationPhase, secrets);
    seal = sealRetrospectiveEvidence({
      outDir,
      plan: buildRetrospectivePlan(spec, { outDir: outRel, mode: "LIVE" }),
      sourceBinding: source.record,
      record,
      secrets,
      writeFile: deps.writeFile,
    });
    if (!seal.ok) {
      log(`[LIVE] Sealing FAILED: ${seal.status} (${redactText(seal.reason, secrets)})`);
      code = X.SEAL_FAILED;
    } else {
      verification = verifyRetrospectiveEvidence(outDir, {
        projectRoot,
        spec,
        sourceDeps: deps.sourceDeps,
      });
      code = retrospectiveVerifyExitCode(verification);
      log(`[LIVE] Evidence sealed: ${outRel} (manifest sha256 ${seal.manifestSha256})`);
      log(
        `[LIVE] Offline verification: ${verification.integrity.ok ? "OK" : `FAILED (${verification.integrity.problems.join(", ")})`}; source ${verification.sourceBinding?.status ?? "NOT_EVALUATED"}; replay ${verification.computed?.replayStatus ?? "UNKNOWN"}`,
      );
    }
  } finally {
    removeListeners();
  }
  // Terminal decision, after listener cleanup. The guarded clock is read first, so anything that
  // read triggers (including a cancellation) is observed by the cancellation sampling that
  // follows: the internal controller and the external signal's actual state. Either can still
  // refuse success. Earlier failures keep their place (the list only appends).
  clock.now();
  if (controller.signal.aborted || external?.aborted === true) failures.add("OPERATOR_CANCELLED");
  const finalFailures = failures.list;
  if (code !== X.SEAL_FAILED && code !== X.INTEGRITY_FAILED && finalFailures.length > 0) {
    code = finalFailures[0] === "OPERATOR_CANCELLED" ? X.CANCELLED : X.NO_TRANSACTION_PAYLOAD;
  }
  if (signalCleanupFailures.length > 0 && (code === X.OK || code === X.EVIDENCE_LIMITED)) {
    code = X.CLEANUP_FAILED;
  }
  if (finalFailures.length > 0) log(`[LIVE] Run failures: ${finalFailures.join(", ")}`);
  log(
    `[LIVE] Exit code ${code}. Supplemental evidence only: never fresh flow, never ingested; no retry or follow-up.`,
  );
  return {
    mode: "LIVE",
    exitCode: code,
    planDigestSha256,
    outDir: outRel,
    acquisition: acquisition ?? undefined,
    record: record ?? undefined,
    seal: seal ?? undefined,
    verification,
    runFailures: finalFailures,
    signalCleanupFailures,
  };
}

export function settleCpmmRetrospectiveProcess(
  exitCode: number,
  graceMs = RETRO_SHUTDOWN_GRACE_MS,
): void {
  process.exitCode = exitCode;
  const backstop = setTimeout(() => {
    console.error(RETRO_SHUTDOWN_FORCED_NOTICE, `after ${graceMs} ms`);
    process.exit(exitCode);
  }, graceMs);
  backstop.unref();
}

function fileIdentity(file: string): string | null {
  try {
    return realpathSync.native(path.resolve(file));
  } catch {
    return null;
  }
}

export function isCpmmRetrospectiveMainModule(
  entryArg: string | undefined,
  moduleUrl: string,
): boolean {
  if (entryArg === undefined || entryArg === "") return false;
  const entry = fileIdentity(entryArg);
  return entry !== null && entry === fileIdentity(fileURLToPath(moduleUrl));
}

if (isCpmmRetrospectiveMainModule(process.argv[1], import.meta.url)) {
  runCpmmRetrospectiveTransactionCli(process.argv.slice(2))
    .then((r) => settleCpmmRetrospectiveProcess(r.exitCode))
    .catch((err: unknown) => {
      console.error("[CPMM_RETROSPECTIVE_TRANSACTION_ERROR]", printableRetrospectiveError(err));
      settleCpmmRetrospectiveProcess(RETRO_EXIT_CODES.INVALID);
    });
}
