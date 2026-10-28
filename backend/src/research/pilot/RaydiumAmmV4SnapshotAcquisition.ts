/**
 * Phase 12.94-D Milestone D.3.3: Bounded Raydium AMM v4 LP-Accounting Snapshot Acquisition
 *
 * Implements the minimal, read-only acquisition sequence for legacy Raydium AMM v4 pools:
 * 1. Request 1: getAccountInfo(poolId) -> validate bootstrap account, orientation, extract references.
 * 2. Host pacing: enforce >= 2,500 ms wait between calls.
 * 3. Request 2: getMultipleAccounts([poolId, lpMint, baseVault, quoteVault]) -> minContextSlot enforcement.
 * 4. Snapshot validation: validate batch with validateRaydiumAmmV4Snapshot.
 * 5. LP-Accounting calculation: derived strictly from the final batch.
 *
 * Operational & Safety Constraints:
 * - At most 2 outbound HTTP attempts; strictly counted on actual dispatch.
 * - Single deadline across pacing, requests, and body reads; overall ceiling <= 60,000 ms.
 * - Zero retries, zero redirects, zero fallback providers, zero auto-discovery.
 * - Terminate immediately after attempt 1 if bootstrap validation fails.
 * - Credential hygiene: transport credentials kept private in memory; public projection only.
 * - Credential redaction in error messages and reflected responses; original wire digests preserved.
 * - Evidence sealing: evidence written to disk, and exact file SHA-256 + byte size recorded in a separate manifest.
 * - Anti-overwrite protection: existing sealed artifacts are never overwritten.
 * - Mandatory storage success: write failures cause the operation to fail closed.
 * - Dry-run mode represents a plan with no captured RPC evidence.
 * - BigInts serialized as exact decimal strings in JSON.
 * - Explicit evidence boundaries statically false (zero candidate admission / zero token safety claims).
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  RAYDIUM_AMM_V4_LAYOUT_LENGTH,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  WSOL_MINT,
  isCanonicalSolanaBase58,
  parseRaydiumAmmV4Account,
} from "./RaydiumAmmParser.js";
import {
  deriveRaydiumAmmAuthority,
  isValidStrictBase64,
  validateRaydiumAmmV4Snapshot,
  type DerivedAmmAuthority,
  type EvidenceOrigin,
  type RaydiumAmmV4SnapshotIdentities,
  type RaydiumAmmV4SnapshotValidationResult,
} from "./RaydiumAmmV4SnapshotValidator.js";
import type { AmmV4LpAccountingSuccess } from "./RaydiumAmmLpAccounting.js";
import {
  sanitizeSolanaRpcUrl,
  type SanitizedRpcEndpointInfo,
} from "./SolanaRpcLiveObservationClient.js";

export const REFERENCE_RAY_WSOL_POOL_ID = "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA";
export const REFERENCE_RAY_TOKEN_MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
export const MIN_HOST_PACING_MS = 2500;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
export const DEFAULT_OVERALL_TIMEOUT_MS = 60000;
export const MAX_OVERALL_TIMEOUT_MS = 60000;
export const MAX_HTTP_ATTEMPTS_ALLOWED = 2;

/**
 * Error indicating that a request attempt was cancelled or failed pre-flight
 * before any outbound HTTP transport dispatch occurred.
 */
export class PreDispatchError extends Error {
  readonly isPreDispatch = true;
  constructor(message: string) {
    super(message);
    this.name = "PreDispatchError";
  }
}

/**
 * Error indicating that a request attempt was denied by resource budget constraints
 * before any outbound HTTP transport dispatch occurred.
 */
export class BudgetDeniedError extends PreDispatchError {
  constructor(message: string) {
    super(message);
    this.name = "BudgetDeniedError";
  }
}

/**
 * Trusted contract interface for tracking whether underlying transport dispatch
 * has officially commenced.
 */
export interface TransportDispatchTracker {
  /** Returns whether underlying transport invocation has commenced for the current attempt. */
  isDispatched(): boolean;
  /** Marks that underlying transport invocation has officially commenced. */
  markDispatched(): void;
  /** Resets dispatch state before initiating a new attempt. */
  reset(): void;
}

/**
 * Creates a standard trusted TransportDispatchTracker instance.
 */
export function createTransportDispatchTracker(): TransportDispatchTracker {
  let dispatched = false;
  return {
    isDispatched: () => dispatched,
    markDispatched: () => {
      dispatched = true;
    },
    reset: () => {
      dispatched = false;
    },
  };
}

/**
 * Checks whether an error is an instance of PreDispatchError.
 * Note: Dispatch status is determined by explicit execution state (e.g. TransportDispatchTracker),
 * not error message text.
 */
export function isPreDispatchError(err: unknown): err is PreDispatchError {
  if (!err || typeof err !== "object") return false;
  return err instanceof PreDispatchError;
}

/**
 * Public endpoint projection containing only sanitized URL, host, and fingerprint.
 * Transport credentials, raw URLs, and sensitive tokens are strictly excluded.
 */
export interface PublicRpcEndpointInfo {
  readonly sanitizedUrl: string;
  readonly host: string;
  readonly endpointFingerprint: string;
}

export interface SnapshotAcquisitionConfig {
  readonly rpcUrl?: string | undefined;
  readonly poolId?: string | undefined;
  readonly expectedTokenMint?: string | undefined;
  readonly pacingMs?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly overallTimeoutMs?: number | undefined;
  readonly outDir?: string | undefined;
  readonly dryRun?: boolean | undefined;
  readonly evidenceOrigin?: EvidenceOrigin | undefined;
  readonly isSyntheticFixture?: boolean | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly dispatchTracker?: TransportDispatchTracker | undefined;
  readonly clock?: (() => Date) | undefined;
  readonly sleeper?: ((ms: number) => Promise<void>) | undefined;
}

export interface BoundedRpcRequestRecord {
  readonly attempt: number;
  readonly method: "getAccountInfo" | "getMultipleAccounts";
  readonly params: readonly unknown[];
  readonly requestTimestampIso: string;
  readonly responseTimestampIso: string | null;
  readonly elapsedMs: number;
  readonly httpStatus: number | null;
  readonly rawResponseBody: string | null;
  readonly wireResponseSha256: string | null;
  readonly storedResponseSha256: string | null;
  readonly wasRedacted: boolean;
  readonly parsedJson: Record<string, unknown> | null;
  readonly error: string | null;
}

export interface SnapshotFileArtifacts {
  readonly evidenceFileName: string;
  readonly evidenceFilePath: string;
  readonly evidenceFileSha256: string;
  readonly evidenceByteSize: number;
  readonly manifestFileName: string;
  readonly manifestFilePath: string;
  readonly manifestFileSha256: string;
  readonly manifestByteSize: number;
}

export interface SnapshotAcquisitionEvidence {
  readonly schemaVersion: "1.0";
  readonly command: "RaydiumAmmV4SnapshotAcquisition";
  readonly executionMode: "LIVE_ACQUISITION" | "DRY_RUN";
  readonly evidenceOrigin: EvidenceOrigin | null;
  readonly isSyntheticFixture: boolean | null;
  readonly retrievedAtIso: string | null;
  readonly startedAtIso: string;
  readonly completedAtIso: string;
  readonly endpoint: PublicRpcEndpointInfo;
  readonly config: {
    readonly poolId: string;
    readonly expectedTokenMint: string | null;
    readonly pacingMs: number;
    readonly timeoutMs: number;
    readonly overallTimeoutMs: number;
  };
  readonly httpAttempts: number;
  readonly maxHttpAttemptsAllowed: 2;
  readonly pacingEnforcedMs: number | null;
  readonly contextSlots: {
    readonly bootstrapSlot: number | null;
    readonly batchSlot: number | null;
    readonly minContextSlotEnforced: boolean;
    readonly staleSlotDetected: boolean;
  };
  readonly requests: readonly BoundedRpcRequestRecord[];
  readonly discoveredIdentities: RaydiumAmmV4SnapshotIdentities | null;
  readonly canonicalAmmAuthority: DerivedAmmAuthority;
  readonly outcomes: {
    readonly retrievalOk: boolean;
    readonly structuralValidationOk: boolean;
    readonly meetsNinetyPercentThreshold: boolean;
  };
  readonly validationResult: RaydiumAmmV4SnapshotValidationResult | null;
  readonly accounting: AmmV4LpAccountingSuccess | null;
  failureReason: string | null;
  readonly evidenceBoundary: {
    readonly bytecodeEquivalenceVerified: false;
    readonly completeExecutableReservesVerified: false;
    readonly generalTokenSafetyVerified: false;
    readonly strategyGateAdmitted: false;
  };
  payloadDigestSha256?: string | undefined;
  artifacts?: SnapshotFileArtifacts | undefined;
}

export interface SnapshotAcquisitionManifest {
  readonly manifestVersion: "1.0";
  readonly manifestType: "RAYDIUM_AMM_V4_SNAPSHOT_MANIFEST";
  readonly createdAtIso: string;
  readonly poolId: string;
  readonly status:
    | "SUCCESS"
    | "STRUCTURAL_VALIDATION_FAILED"
    | "RETRIEVAL_FAILED"
    | "INTERRUPTED"
    | "DRY_RUN";
  readonly httpAttempts: number;
  readonly evidenceFileName: string;
  readonly evidenceFilePath: string;
  readonly evidenceFileSha256: string;
  readonly evidenceByteSize: number;
  readonly payloadDigestSha256: string;
  readonly contextSlots: {
    readonly bootstrapSlot: number | null;
    readonly batchSlot: number | null;
  };
  readonly outcomes: {
    readonly retrievalOk: boolean;
    readonly structuralValidationOk: boolean;
    readonly meetsNinetyPercentThreshold: boolean;
  };
  readonly failureReason: string | null;
}

export interface SnapshotAcquisitionResult {
  readonly ok: boolean;
  readonly dryRun: boolean;
  readonly httpAttempts: number;
  readonly evidence: SnapshotAcquisitionEvidence;
  readonly manifest?: SnapshotAcquisitionManifest | undefined;
}

/**
 * Validates numeric acquisition configuration strictly.
 * Rejects NaN, Infinity, negative numbers, non-integers, and out-of-range bounds.
 */
export function validateNumericConfig(config: {
  pacingMs?: unknown;
  timeoutMs?: unknown;
  overallTimeoutMs?: unknown;
}): {
  pacingMs: number;
  timeoutMs: number;
  overallTimeoutMs: number;
} {
  const rawPacing = config.pacingMs !== undefined ? config.pacingMs : MIN_HOST_PACING_MS;
  const rawTimeout = config.timeoutMs !== undefined ? config.timeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
  const rawOverall =
    config.overallTimeoutMs !== undefined ? config.overallTimeoutMs : DEFAULT_OVERALL_TIMEOUT_MS;

  const parseAndValidate = (val: unknown, name: string, min: number, max: number): number => {
    let num: number;
    if (typeof val === "number") {
      num = val;
    } else if (typeof val === "string") {
      const trimmed = val.trim();
      if (!/^\d+$/.test(trimmed)) {
        throw new Error(`Invalid ${name}: '${val}' must be a positive integer`);
      }
      num = Number(trimmed);
    } else {
      throw new Error(`Invalid ${name}: expected number, received ${typeof val}`);
    }

    if (!Number.isFinite(num) || !Number.isSafeInteger(num) || Number.isNaN(num)) {
      throw new Error(`Invalid ${name}: value must be a safe finite integer`);
    }
    if (num < min || num > max) {
      throw new Error(`Invalid ${name}: ${num} is out of allowed range [${min}, ${max}]`);
    }
    return num;
  };

  const pacingMs = parseAndValidate(
    rawPacing,
    "pacingMs",
    MIN_HOST_PACING_MS,
    MAX_OVERALL_TIMEOUT_MS,
  );
  const timeoutMs = parseAndValidate(rawTimeout, "timeoutMs", 100, MAX_OVERALL_TIMEOUT_MS);
  const overallTimeoutMs = parseAndValidate(
    rawOverall,
    "overallTimeoutMs",
    MIN_HOST_PACING_MS,
    MAX_OVERALL_TIMEOUT_MS,
  );

  if (overallTimeoutMs < pacingMs) {
    throw new Error(
      `Invalid timeout configuration: overallTimeoutMs (${overallTimeoutMs}) cannot be less than pacingMs (${pacingMs})`,
    );
  }

  return { pacingMs, timeoutMs, overallTimeoutMs };
}

/**
 * Serializes arbitrary JavaScript data structures to JSON while converting BigInt values
 * into explicit decimal strings, preventing JSON.stringify TypeError and precision loss.
 */
export function serializeJsonPreservingBigInts(value: unknown, indent: number = 2): string {
  return JSON.stringify(
    value,
    (_key, val) => {
      if (typeof val === "bigint") {
        return val.toString();
      }
      return val;
    },
    indent,
  );
}

/**
 * Redacts credential tokens from a string. Handles plain text tokens, raw URLs,
 * and JSON-encoded Unicode escape variants (such as \u0041 for A).
 */
export function redactString(
  text: string,
  sensitiveTokens: readonly string[],
  rawUrl?: string,
): string {
  let result = text;
  if (rawUrl && rawUrl.length > 0) {
    result = result.split(rawUrl).join("[REDACTED]");
  }
  for (const token of sensitiveTokens) {
    if (token && token.length > 0) {
      result = result.split(token).join("[REDACTED]");
    }
  }
  if (result.includes("\\u")) {
    for (const token of sensitiveTokens) {
      if (!token || token.length === 0) continue;
      const escapedPattern = Array.from(token)
        .map((c) => {
          const hex4 = c.charCodeAt(0).toString(16).padStart(4, "0");
          const regexChar = c.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
          return `(?:${regexChar}|\\\\u${hex4})`;
        })
        .join("");
      const re = new RegExp(escapedPattern, "gi");
      result = result.replace(re, "[REDACTED]");
    }
  }
  return result;
}

/**
 * Recursively sanitizes any decoded JSON value (string, array, or object) by redacting
 * sensitive tokens and raw URLs from both string values and object keys.
 */
export function sanitizeJsonValue(
  value: unknown,
  sensitiveTokens: readonly string[],
  rawUrl?: string,
): { sanitized: unknown; changed: boolean } {
  if (typeof value === "string") {
    const redacted = redactString(value, sensitiveTokens, rawUrl);
    return { sanitized: redacted, changed: redacted !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const sanitizedArr = value.map((item) => {
      const res = sanitizeJsonValue(item, sensitiveTokens, rawUrl);
      if (res.changed) changed = true;
      return res.sanitized;
    });
    return { sanitized: sanitizedArr, changed };
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const sanitizedObj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const keyRes = sanitizeJsonValue(k, sensitiveTokens, rawUrl);
      const valRes = sanitizeJsonValue(v, sensitiveTokens, rawUrl);
      if (keyRes.changed || valRes.changed) changed = true;
      sanitizedObj[keyRes.sanitized as string] = valRes.sanitized;
    }
    return { sanitized: sanitizedObj, changed };
  }
  return { sanitized: value, changed: false };
}

export const ALLOWED_EVIDENCE_ORIGINS = Object.freeze([
  "SYNTHETIC_FIXTURE",
  "CAPTURED_RPC",
  "UNKNOWN",
] as const);

/**
 * Validates and resolves provenance metadata upfront before any request dispatch.
 * Enforces origin membership, type consistency, and contradiction rules.
 * Defaults injected transports (config.fetch !== undefined) to UNKNOWN unless explicitly declared.
 */
export function resolveAcquisitionProvenance(config: {
  readonly dryRun?: boolean | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly evidenceOrigin?: EvidenceOrigin | undefined;
  readonly isSyntheticFixture?: boolean | undefined;
}): {
  effectiveEvidenceOrigin: EvidenceOrigin | null;
  effectiveIsSyntheticFixture: boolean | null;
} {
  if (config.dryRun) {
    return {
      effectiveEvidenceOrigin: null,
      effectiveIsSyntheticFixture: null,
    };
  }

  // 1. Origin membership validation
  if (config.evidenceOrigin !== undefined) {
    if (
      !ALLOWED_EVIDENCE_ORIGINS.includes(
        config.evidenceOrigin as (typeof ALLOWED_EVIDENCE_ORIGINS)[number],
      )
    ) {
      throw new Error(
        `INVALID_PROVENANCE_METADATA: Invalid evidenceOrigin: '${config.evidenceOrigin}' is not a supported provenance origin`,
      );
    }
  }

  // 2. isSyntheticFixture type validation
  if (config.isSyntheticFixture !== undefined && typeof config.isSyntheticFixture !== "boolean") {
    throw new Error(
      `INVALID_PROVENANCE_METADATA: Invalid isSyntheticFixture: expected boolean, received ${typeof config.isSyntheticFixture}`,
    );
  }

  // 3. Contradictory provenance options validation
  if (config.evidenceOrigin !== undefined && config.isSyntheticFixture !== undefined) {
    if (
      (config.evidenceOrigin === "SYNTHETIC_FIXTURE" && config.isSyntheticFixture !== true) ||
      (config.evidenceOrigin === "CAPTURED_RPC" && config.isSyntheticFixture !== false) ||
      (config.evidenceOrigin === "UNKNOWN" &&
        config.isSyntheticFixture !== null &&
        config.isSyntheticFixture !== undefined)
    ) {
      throw new Error(
        `INVALID_PROVENANCE_METADATA: Contradictory provenance options: evidenceOrigin is '${config.evidenceOrigin}' but isSyntheticFixture is ${config.isSyntheticFixture}`,
      );
    }
  }

  // 4. Resolved provenance determination
  if (config.evidenceOrigin !== undefined) {
    const origin = config.evidenceOrigin;
    const isSynthetic =
      origin === "SYNTHETIC_FIXTURE" ? true : origin === "CAPTURED_RPC" ? false : null;
    return {
      effectiveEvidenceOrigin: origin,
      effectiveIsSyntheticFixture: isSynthetic,
    };
  }

  if (config.isSyntheticFixture !== undefined) {
    return {
      effectiveEvidenceOrigin: config.isSyntheticFixture ? "SYNTHETIC_FIXTURE" : "CAPTURED_RPC",
      effectiveIsSyntheticFixture: config.isSyntheticFixture,
    };
  }

  // Injected transport without explicit provenance declaration -> defaults to UNKNOWN!
  if (config.fetch !== undefined) {
    return {
      effectiveEvidenceOrigin: "UNKNOWN",
      effectiveIsSyntheticFixture: null,
    };
  }

  // Default live runtime transport (globalThis.fetch)
  return {
    effectiveEvidenceOrigin: "CAPTURED_RPC",
    effectiveIsSyntheticFixture: false,
  };
}

/**
 * Executes bounded Raydium AMM v4 LP-accounting snapshot acquisition.
 */
export async function acquireRaydiumAmmV4Snapshot(
  config: SnapshotAcquisitionConfig,
): Promise<SnapshotAcquisitionResult> {
  const clock = config.clock ?? (() => new Date());
  const sleeper =
    config.sleeper ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const startedAt = clock();
  const startEpoch = startedAt.getTime();

  // Validate numeric parameters strictly
  const { pacingMs, timeoutMs, overallTimeoutMs } = validateNumericConfig(config);
  const deadlineEpoch = startEpoch + overallTimeoutMs;

  function getRemainingBudgetMs(): number {
    return deadlineEpoch - clock().getTime();
  }

  const poolId = config.poolId ?? REFERENCE_RAY_WSOL_POOL_ID;
  const expectedTokenMint =
    config.expectedTokenMint !== undefined
      ? config.expectedTokenMint
      : config.poolId === undefined || config.poolId === REFERENCE_RAY_WSOL_POOL_ID
        ? REFERENCE_RAY_TOKEN_MINT
        : null;

  const dryRun = Boolean(config.dryRun);

  // Validate identity syntax upfront
  if (!isCanonicalSolanaBase58(poolId)) {
    throw new Error(`Invalid poolId: '${poolId}' is not a valid 32-byte Solana base58 public key`);
  }
  if (expectedTokenMint !== null && !isCanonicalSolanaBase58(expectedTokenMint)) {
    throw new Error(
      `Invalid expectedTokenMint: '${expectedTokenMint}' is not a valid 32-byte Solana base58 public key`,
    );
  }

  // Derive canonical AMM authority
  const derivedAuthority = await deriveRaydiumAmmAuthority(RAYDIUM_AMM_V4_PROGRAM_ID);

  // Endpoint sanitization
  const rawRpcUrl = config.rpcUrl ?? "";
  let privateSanitizerInfo: SanitizedRpcEndpointInfo;

  if (rawRpcUrl.length > 0) {
    privateSanitizerInfo = sanitizeSolanaRpcUrl(rawRpcUrl);
  } else {
    privateSanitizerInfo = {
      rawUrl: "",
      sanitizedUrl: "[DRY_RUN_ENDPOINT_UNSPECIFIED]",
      host: "dry-run",
      endpointFingerprint: "sha256:0000000000000000",
      sensitiveTokens: [],
    };
  }

  // Keep transport credentials strictly private in memory; expose only public projection
  const publicEndpoint: PublicRpcEndpointInfo = Object.freeze({
    sanitizedUrl: privateSanitizerInfo.sanitizedUrl,
    host: privateSanitizerInfo.host,
    endpointFingerprint: privateSanitizerInfo.endpointFingerprint,
  });

  const sensitiveTokens = privateSanitizerInfo.sensitiveTokens;

  // Validate and resolve provenance options upfront before any request dispatch
  const { effectiveEvidenceOrigin, effectiveIsSyntheticFixture } = resolveAcquisitionProvenance({
    dryRun,
    fetch: config.fetch,
    evidenceOrigin: config.evidenceOrigin,
    isSyntheticFixture: config.isSyntheticFixture,
  });

  // DRY-RUN MODE: Zero network calls, return planned sequence
  if (dryRun) {
    const completedAt = clock();
    const dryRunEvidence: SnapshotAcquisitionEvidence = {
      schemaVersion: "1.0",
      command: "RaydiumAmmV4SnapshotAcquisition",
      executionMode: "DRY_RUN",
      evidenceOrigin: null,
      isSyntheticFixture: null,
      retrievedAtIso: null,
      startedAtIso: startedAt.toISOString(),
      completedAtIso: completedAt.toISOString(),
      endpoint: publicEndpoint,
      config: {
        poolId,
        expectedTokenMint,
        pacingMs,
        timeoutMs,
        overallTimeoutMs,
      },
      httpAttempts: 0,
      maxHttpAttemptsAllowed: MAX_HTTP_ATTEMPTS_ALLOWED,
      pacingEnforcedMs: null,
      contextSlots: {
        bootstrapSlot: null,
        batchSlot: null,
        minContextSlotEnforced: true,
        staleSlotDetected: false,
      },
      requests: [],
      discoveredIdentities: null,
      canonicalAmmAuthority: derivedAuthority,
      outcomes: {
        retrievalOk: false,
        structuralValidationOk: false,
        meetsNinetyPercentThreshold: false,
      },
      validationResult: null,
      accounting: null,
      failureReason: "DRY_RUN_MODE: Zero network calls executed",
      evidenceBoundary: {
        bytecodeEquivalenceVerified: false,
        completeExecutableReservesVerified: false,
        generalTokenSafetyVerified: false,
        strategyGateAdmitted: false,
      },
    };

    const preDigestJson = serializeJsonPreservingBigInts(dryRunEvidence);
    dryRunEvidence.payloadDigestSha256 = crypto
      .createHash("sha256")
      .update(preDigestJson)
      .digest("hex");

    return {
      ok: true,
      dryRun: true,
      httpAttempts: 0,
      evidence: dryRunEvidence,
    };
  }

  // LIVE ACQUISITION CHECKS: RPC URL is strictly mandatory
  if (!rawRpcUrl || rawRpcUrl.trim() === "") {
    throw new Error(
      "Missing RPC endpoint: config.rpcUrl is required for live snapshot acquisition",
    );
  }

  let httpAttempts = 0;
  const requests: BoundedRpcRequestRecord[] = [];
  let bootstrapSlot: number | null = null;
  let batchSlot: number | null = null;
  let staleSlotDetected = false;
  let pacingEnforcedMs: number | null = null;
  let discoveredIdentities: RaydiumAmmV4SnapshotIdentities | null = null;
  let validationResult: RaydiumAmmV4SnapshotValidationResult | null = null;
  let accounting: AmmV4LpAccountingSuccess | null = null;
  let failureReason: string | null = null;
  let retrievalOk = false;
  let structuralValidationOk = false;
  let meetsNinetyPercentThreshold = false;

  /**
   * Helper to execute a strictly counted, timeout-bounded outbound JSON-RPC POST request.
   * Checks deadline BEFORE incrementing the attempt counter and dispatching.
   */
  async function executeRpcCall(
    method: "getAccountInfo" | "getMultipleAccounts",
    params: readonly unknown[],
  ): Promise<{
    record: BoundedRpcRequestRecord;
    json: Record<string, unknown> | null;
  }> {
    const remainingMs = getRemainingBudgetMs();
    if (remainingMs <= 0) {
      const rec: BoundedRpcRequestRecord = {
        attempt: httpAttempts + 1,
        method,
        params,
        requestTimestampIso: clock().toISOString(),
        responseTimestampIso: null,
        elapsedMs: 0,
        httpStatus: null,
        rawResponseBody: null,
        wireResponseSha256: null,
        storedResponseSha256: null,
        wasRedacted: false,
        parsedJson: null,
        error: `Acquisition deadline reached before ${method} dispatch (${overallTimeoutMs}ms ceiling exceeded)`,
      };
      // Do NOT increment httpAttempts because no fetch was dispatched!
      return { record: rec, json: null };
    }

    if (httpAttempts >= MAX_HTTP_ATTEMPTS_ALLOWED) {
      const rec: BoundedRpcRequestRecord = {
        attempt: httpAttempts + 1,
        method,
        params,
        requestTimestampIso: clock().toISOString(),
        responseTimestampIso: null,
        elapsedMs: 0,
        httpStatus: null,
        rawResponseBody: null,
        wireResponseSha256: null,
        storedResponseSha256: null,
        wasRedacted: false,
        parsedJson: null,
        error: `Maximum allowed HTTP attempts (${MAX_HTTP_ATTEMPTS_ALLOWED}) reached`,
      };
      return { record: rec, json: null };
    }

    const effectiveTimeout = Math.min(timeoutMs, remainingMs);
    if (effectiveTimeout <= 0) {
      const rec: BoundedRpcRequestRecord = {
        attempt: httpAttempts + 1,
        method,
        params,
        requestTimestampIso: clock().toISOString(),
        responseTimestampIso: null,
        elapsedMs: 0,
        httpStatus: null,
        rawResponseBody: null,
        wireResponseSha256: null,
        storedResponseSha256: null,
        wasRedacted: false,
        parsedJson: null,
        error: `Insufficient remaining timeout budget (${remainingMs}ms) for ${method} dispatch`,
      };
      return { record: rec, json: null };
    }

    // Reset dispatch tracker state before attempting this RPC call
    config.dispatchTracker?.reset();

    // Increment httpAttempts when fetchImpl is about to be called
    httpAttempts++;
    const currentAttempt = httpAttempts;
    const reqTimestamp = clock();
    const requestTimestampIso = reqTimestamp.toISOString();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);

    const rpcPayload = {
      jsonrpc: "2.0",
      id: currentAttempt,
      method,
      params,
    };

    let httpStatus: number | null = null;
    let rawResponseBody: string | null = null;
    let wireResponseSha256: string | null = null;
    let storedResponseSha256: string | null = null;
    let wasRedacted = false;
    let parsedJson: Record<string, unknown> | null = null;
    let errMessage: string | null = null;

    let response: Response | null = null;
    try {
      response = await fetchImpl(rawRpcUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(rpcPayload),
        signal: controller.signal,
        redirect: "error",
      });
    } catch (fetchErr) {
      const isDispatched = config.dispatchTracker ? config.dispatchTracker.isDispatched() : true;

      if (!isDispatched) {
        // Genuine pre-dispatch failure: The underlying transport was never called.
        // Roll back httpAttempts because no transport dispatch occurred!
        httpAttempts--;
        const rawMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        if (fetchErr instanceof BudgetDeniedError || rawMsg.startsWith("BUDGET_DENIED")) {
          errMessage = `PRE_DISPATCH_BUDGET_DENIED: ${rawMsg}`;
        } else {
          errMessage = `PRE_DISPATCH_DENIED: ${rawMsg}`;
        }
      } else if (controller.signal.aborted) {
        errMessage = `Request timed out after ${effectiveTimeout}ms`;
      } else {
        errMessage = `Network error: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`;
      }
    } finally {
      clearTimeout(timer);
    }

    if (response !== null) {
      httpStatus = response.status;
      let wireResponseBody: string | null = null;
      try {
        wireResponseBody = await response.text();
      } catch (readErr) {
        // Once the transport has been invoked, its attempt must remain counted,
        // including response body read failure.
        const rawMsg = readErr instanceof Error ? readErr.message : String(readErr);
        errMessage = `Network error: Response body read failure: ${rawMsg}`;
      }

      if (wireResponseBody !== null) {
        wireResponseSha256 = crypto.createHash("sha256").update(wireResponseBody).digest("hex");

        // Parse JSON from wire response (unsanitized payload kept private in memory)
        let rawParsedJson: unknown = null;
        let jsonParseError: string | null = null;
        try {
          rawParsedJson = JSON.parse(wireResponseBody);
        } catch (err) {
          jsonParseError = err instanceof Error ? err.message : String(err);
        }

        // Sanitize decoded parsed JSON structure if present
        let sanitizedJson: Record<string, unknown> | null = null;
        let jsonWasRedacted = false;
        if (rawParsedJson !== null && typeof rawParsedJson === "object") {
          const res = sanitizeJsonValue(rawParsedJson, sensitiveTokens, rawRpcUrl);
          sanitizedJson = res.sanitized as Record<string, unknown>;
          jsonWasRedacted = res.changed;
        }

        // Sanitize wire text representation
        const textRedacted = redactString(wireResponseBody, sensitiveTokens, rawRpcUrl);
        const textWasRedacted = textRedacted !== wireResponseBody;

        wasRedacted = jsonWasRedacted || textWasRedacted;

        if (wasRedacted) {
          if (sanitizedJson !== null) {
            rawResponseBody = JSON.stringify(sanitizedJson);
          } else {
            rawResponseBody = textRedacted;
          }
          storedResponseSha256 = crypto.createHash("sha256").update(rawResponseBody).digest("hex");
        } else {
          rawResponseBody = wireResponseBody;
          storedResponseSha256 = wireResponseSha256;
        }

        if (response.status !== 200) {
          errMessage = `HTTP error ${response.status}: ${response.statusText || "Non-200 response"}`;
          parsedJson = sanitizedJson;
        } else {
          if (jsonParseError) {
            errMessage = `Malformed JSON response: ${jsonParseError}`;
            parsedJson = null;
          } else {
            parsedJson = sanitizedJson;
          }
        }
      }
    }

    if (errMessage) {
      errMessage = redactString(errMessage, sensitiveTokens, rawRpcUrl);
    }

    const respTimestamp = clock();
    const elapsedMs = respTimestamp.getTime() - reqTimestamp.getTime();

    const record: BoundedRpcRequestRecord = {
      attempt: currentAttempt,
      method,
      params,
      requestTimestampIso,
      responseTimestampIso:
        rawResponseBody !== null || httpStatus !== null ? respTimestamp.toISOString() : null,
      elapsedMs,
      httpStatus,
      rawResponseBody,
      wireResponseSha256,
      storedResponseSha256,
      wasRedacted,
      parsedJson,
      error: errMessage,
    };

    requests.push(record);
    return { record, json: parsedJson };
  }

  // =========================================================================
  // REQUEST 1: getAccountInfo(poolId) - Bootstrap Account & Reference Discovery
  // =========================================================================
  const bootstrapParams = [
    poolId,
    {
      encoding: "base64",
      commitment: "confirmed",
    },
  ] as const;

  const { record: req1Record, json: req1Json } = await executeRpcCall(
    "getAccountInfo",
    bootstrapParams,
  );

  if (req1Record.error !== null || !req1Json) {
    if (req1Record.error?.startsWith("PRE_DISPATCH_BUDGET_DENIED")) {
      failureReason = `Bootstrap Request 1 pre-dispatch budget denial: ${req1Record.error}`;
    } else if (req1Record.error?.startsWith("PRE_DISPATCH_DENIED")) {
      failureReason = `Bootstrap Request 1 pre-dispatch denial: ${req1Record.error}`;
    } else {
      failureReason = `Bootstrap Request 1 failed: ${req1Record.error ?? "Empty response"}`;
    }
  } else if (req1Json.error) {
    const errorStr =
      typeof req1Json.error === "object" ? JSON.stringify(req1Json.error) : String(req1Json.error);
    failureReason = `Bootstrap Request 1 RPC error: ${redactString(errorStr, sensitiveTokens, rawRpcUrl)}`;
  } else {
    // Validate bootstrap context slot
    const resultRecord = req1Json.result as Record<string, unknown> | undefined;
    const context = resultRecord?.context as Record<string, unknown> | undefined;
    const slot = context?.slot;

    if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot <= 0) {
      failureReason = `Bootstrap Request 1 returned invalid context slot: ${slot ?? "null"}`;
    } else {
      bootstrapSlot = slot;
      const accountVal = resultRecord?.value as Record<string, unknown> | null | undefined;

      if (!accountVal) {
        failureReason = `Bootstrap pool account '${poolId}' was not found on-chain (null account value)`;
      } else if (accountVal.owner !== RAYDIUM_AMM_V4_PROGRAM_ID) {
        failureReason = `Bootstrap pool account owner mismatch: expected '${RAYDIUM_AMM_V4_PROGRAM_ID}', received '${accountVal.owner}'`;
      } else {
        const dataArr = accountVal.data;
        if (!Array.isArray(dataArr) || dataArr.length < 2 || dataArr[1] !== "base64") {
          failureReason = "Bootstrap pool account data is not in base64 format";
        } else if (!isValidStrictBase64(dataArr[0])) {
          failureReason =
            "Bootstrap pool account data contains invalid or non-canonical Base64 encoding";
        } else {
          const poolBuffer = Buffer.from(dataArr[0] as string, "base64");
          if (poolBuffer.length !== RAYDIUM_AMM_V4_LAYOUT_LENGTH) {
            failureReason = `Bootstrap pool layout length mismatch: expected ${RAYDIUM_AMM_V4_LAYOUT_LENGTH} bytes, received ${poolBuffer.length}`;
          } else {
            const parsedPool = parseRaydiumAmmV4Account(
              poolBuffer,
              poolId,
              RAYDIUM_AMM_V4_PROGRAM_ID,
              slot,
            );
            if (!parsedPool.ok) {
              failureReason = `Bootstrap pool layout parsing failed [${parsedPool.category}]: ${parsedPool.message}`;
            } else {
              const poolState = parsedPool.state;
              if (poolState.status <= 0n) {
                failureReason = `Bootstrap pool status is invalid or uninitialized (status: ${poolState.status})`;
              } else {
                const isBaseSol = poolState.baseMint === WSOL_MINT;
                const isQuoteSol = poolState.quoteMint === WSOL_MINT;

                if (!isBaseSol && !isQuoteSol) {
                  failureReason = `Bootstrap pool is not paired with WSOL (${WSOL_MINT}): base=${poolState.baseMint}, quote=${poolState.quoteMint}`;
                } else {
                  const detectedTokenMint = isBaseSol ? poolState.quoteMint : poolState.baseMint;
                  if (expectedTokenMint !== null && detectedTokenMint !== expectedTokenMint) {
                    failureReason = `Bootstrap token mint mismatch: expected '${expectedTokenMint}', received '${detectedTokenMint}'`;
                  } else if (!poolState.lpMint || !isCanonicalSolanaBase58(poolState.lpMint)) {
                    failureReason = `Bootstrap pool account missing valid LP mint address (${poolState.lpMint ?? "undefined"})`;
                  } else {
                    discoveredIdentities = {
                      poolId,
                      lpMint: poolState.lpMint,
                      baseVault: poolState.baseVault,
                      quoteVault: poolState.quoteVault,
                      ...(expectedTokenMint !== null ? { expectedTokenMint } : {}),
                    };
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // If bootstrap failed: terminate immediately. HTTP attempts remains 1. Zero second call!
  if (failureReason !== null || discoveredIdentities === null || bootstrapSlot === null) {
    return await finalizeAcquisition({
      clock,
      startedAt,
      publicEndpoint,
      poolId,
      expectedTokenMint,
      pacingMs,
      timeoutMs,
      overallTimeoutMs,
      httpAttempts,
      pacingEnforcedMs: null,
      bootstrapSlot,
      batchSlot: null,
      staleSlotDetected: false,
      requests,
      discoveredIdentities: null,
      derivedAuthority,
      retrievalOk: false,
      structuralValidationOk: false,
      meetsNinetyPercentThreshold: false,
      validationResult: null,
      accounting: null,
      failureReason,
      effectiveEvidenceOrigin,
      effectiveIsSyntheticFixture,
      retrievedAtIso: req1Record.responseTimestampIso,
      outDir: config.outDir,
    });
  }

  // =========================================================================
  // HOST PACING: Enforce at least 2,500 ms pause before Request 2
  // =========================================================================
  const remainingBeforePacing = getRemainingBudgetMs();
  if (remainingBeforePacing <= 0) {
    failureReason = `DEADLINE_EXCEEDED: Acquisition deadline of ${overallTimeoutMs}ms reached before host pacing`;
    return await finalizeAcquisition({
      clock,
      startedAt,
      publicEndpoint,
      poolId,
      expectedTokenMint,
      pacingMs,
      timeoutMs,
      overallTimeoutMs,
      httpAttempts,
      pacingEnforcedMs: null,
      bootstrapSlot,
      batchSlot: null,
      staleSlotDetected: false,
      requests,
      discoveredIdentities,
      derivedAuthority,
      retrievalOk: false,
      structuralValidationOk: false,
      meetsNinetyPercentThreshold: false,
      validationResult: null,
      accounting: null,
      failureReason,
      effectiveEvidenceOrigin,
      effectiveIsSyntheticFixture,
      retrievedAtIso: req1Record.responseTimestampIso,
      outDir: config.outDir,
    });
  }

  if (remainingBeforePacing < pacingMs) {
    failureReason = `DEADLINE_EXCEEDED: Remaining budget (${remainingBeforePacing}ms) is insufficient for required ${pacingMs}ms host pacing`;
    return await finalizeAcquisition({
      clock,
      startedAt,
      publicEndpoint,
      poolId,
      expectedTokenMint,
      pacingMs,
      timeoutMs,
      overallTimeoutMs,
      httpAttempts,
      pacingEnforcedMs: null,
      bootstrapSlot,
      batchSlot: null,
      staleSlotDetected: false,
      requests,
      discoveredIdentities,
      derivedAuthority,
      retrievalOk: false,
      structuralValidationOk: false,
      meetsNinetyPercentThreshold: false,
      validationResult: null,
      accounting: null,
      failureReason,
      effectiveEvidenceOrigin,
      effectiveIsSyntheticFixture,
      retrievedAtIso: req1Record.responseTimestampIso,
      outDir: config.outDir,
    });
  }

  try {
    await sleeper(pacingMs);
    pacingEnforcedMs = pacingMs;
  } catch (pacingErr) {
    const rawMsg = pacingErr instanceof Error ? pacingErr.message : String(pacingErr);
    failureReason = `PACING_INTERRUPTED: ${redactString(rawMsg, sensitiveTokens, rawRpcUrl)}`;
    return await finalizeAcquisition({
      clock,
      startedAt,
      publicEndpoint,
      poolId,
      expectedTokenMint,
      pacingMs,
      timeoutMs,
      overallTimeoutMs,
      httpAttempts,
      pacingEnforcedMs: null,
      bootstrapSlot,
      batchSlot: null,
      staleSlotDetected: false,
      requests,
      discoveredIdentities,
      derivedAuthority,
      retrievalOk: false,
      structuralValidationOk: false,
      meetsNinetyPercentThreshold: false,
      validationResult: null,
      accounting: null,
      failureReason,
      effectiveEvidenceOrigin,
      effectiveIsSyntheticFixture,
      retrievedAtIso: req1Record.responseTimestampIso,
      outDir: config.outDir,
    });
  }

  // Check deadline again after host pacing completes
  const remainingBeforeReq2 = getRemainingBudgetMs();
  if (remainingBeforeReq2 <= 0) {
    failureReason = `DEADLINE_EXCEEDED: Acquisition deadline of ${overallTimeoutMs}ms reached during host pacing`;
    return await finalizeAcquisition({
      clock,
      startedAt,
      publicEndpoint,
      poolId,
      expectedTokenMint,
      pacingMs,
      timeoutMs,
      overallTimeoutMs,
      httpAttempts,
      pacingEnforcedMs,
      bootstrapSlot,
      batchSlot: null,
      staleSlotDetected: false,
      requests,
      discoveredIdentities,
      derivedAuthority,
      retrievalOk: false,
      structuralValidationOk: false,
      meetsNinetyPercentThreshold: false,
      validationResult: null,
      accounting: null,
      failureReason,
      effectiveEvidenceOrigin,
      effectiveIsSyntheticFixture,
      retrievedAtIso: req1Record.responseTimestampIso,
      outDir: config.outDir,
    });
  }

  // =========================================================================
  // REQUEST 2: getMultipleAccounts([pool, lpMint, baseVault, quoteVault])
  // =========================================================================
  const batchAccountKeys = [
    discoveredIdentities.poolId,
    discoveredIdentities.lpMint,
    discoveredIdentities.baseVault,
    discoveredIdentities.quoteVault,
  ] as const;

  const batchParams = [
    batchAccountKeys,
    {
      encoding: "base64",
      commitment: "confirmed",
      minContextSlot: bootstrapSlot,
    },
  ] as const;

  const { record: req2Record, json: req2Json } = await executeRpcCall(
    "getMultipleAccounts",
    batchParams,
  );

  if (req2Record.error !== null || !req2Json) {
    if (req2Record.error?.startsWith("PRE_DISPATCH_BUDGET_DENIED")) {
      failureReason = `Batch Request 2 pre-dispatch budget denial: ${req2Record.error}`;
    } else if (req2Record.error?.startsWith("PRE_DISPATCH_DENIED")) {
      failureReason = `Batch Request 2 pre-dispatch denial: ${req2Record.error}`;
    } else {
      failureReason = `Batch Request 2 failed: ${req2Record.error ?? "Empty response"}`;
    }
  } else if (req2Json.error) {
    const errorStr =
      typeof req2Json.error === "object" ? JSON.stringify(req2Json.error) : String(req2Json.error);
    failureReason = `Batch Request 2 RPC error: ${redactString(errorStr, sensitiveTokens, rawRpcUrl)}`;
  } else {
    // Extract batch context slot
    const resultRecord = req2Json.result as Record<string, unknown> | undefined;
    const context = resultRecord?.context as Record<string, unknown> | undefined;
    const slot = context?.slot;

    if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot <= 0) {
      failureReason = `Batch Request 2 returned invalid context slot: ${slot ?? "null"}`;
    } else {
      batchSlot = slot;
      // Independently verify slot is not below bootstrap minContextSlot
      if (batchSlot < bootstrapSlot) {
        staleSlotDetected = true;
        failureReason = `Stale batch context slot: batch slot ${batchSlot} is less than bootstrap slot ${bootstrapSlot}`;
      } else {
        retrievalOk = true;

        // Perform strict offline snapshot validation on final batch payload
        validationResult = await validateRaydiumAmmV4Snapshot(discoveredIdentities, req2Json, {
          evidenceOrigin: effectiveEvidenceOrigin ?? undefined,
          isSyntheticFixture: effectiveIsSyntheticFixture ?? undefined,
          retrievedAtIso: req2Record.responseTimestampIso,
        });

        if (!validationResult.ok) {
          structuralValidationOk = false;
          failureReason = `Snapshot validation failed [${validationResult.category}]: ${validationResult.message}`;
        } else {
          // Verify that final batch retains bootstrap-discovered references
          const finalPoolState = validationResult.diagnostics.poolState;
          if (
            finalPoolState.lpMint !== discoveredIdentities.lpMint ||
            finalPoolState.baseVault !== discoveredIdentities.baseVault ||
            finalPoolState.quoteVault !== discoveredIdentities.quoteVault
          ) {
            structuralValidationOk = false;
            failureReason =
              "Final batch pool references do not match bootstrap-discovered references";
          } else {
            structuralValidationOk = true;
            accounting = validationResult.accounting;
            meetsNinetyPercentThreshold = validationResult.accounting.meetsNinetyPercentThreshold;
          }
        }
      }
    }
  }

  return await finalizeAcquisition({
    clock,
    startedAt,
    publicEndpoint,
    poolId,
    expectedTokenMint,
    pacingMs,
    timeoutMs,
    overallTimeoutMs,
    httpAttempts,
    pacingEnforcedMs,
    bootstrapSlot,
    batchSlot,
    staleSlotDetected,
    requests,
    discoveredIdentities,
    derivedAuthority,
    retrievalOk,
    structuralValidationOk,
    meetsNinetyPercentThreshold,
    validationResult,
    accounting,
    failureReason,
    effectiveEvidenceOrigin,
    effectiveIsSyntheticFixture,
    retrievedAtIso: req2Record?.responseTimestampIso ?? req1Record.responseTimestampIso,
    outDir: config.outDir,
  });
}

/**
 * Seals the snapshot acquisition evidence with an overall SHA-256 digest, writes evidence bytes,
 * and records the exact file SHA-256 and byte size in a separate manifest.
 * Write failures fail closed and render the operation unsuccessful.
 */
async function finalizeAcquisition(params: {
  clock: () => Date;
  startedAt: Date;
  publicEndpoint: PublicRpcEndpointInfo;
  poolId: string;
  expectedTokenMint: string | null;
  pacingMs: number;
  timeoutMs: number;
  overallTimeoutMs: number;
  httpAttempts: number;
  pacingEnforcedMs: number | null;
  bootstrapSlot: number | null;
  batchSlot: number | null;
  staleSlotDetected: boolean;
  requests: readonly BoundedRpcRequestRecord[];
  discoveredIdentities: RaydiumAmmV4SnapshotIdentities | null;
  derivedAuthority: DerivedAmmAuthority;
  retrievalOk: boolean;
  structuralValidationOk: boolean;
  meetsNinetyPercentThreshold: boolean;
  validationResult: RaydiumAmmV4SnapshotValidationResult | null;
  accounting: AmmV4LpAccountingSuccess | null;
  failureReason: string | null;
  effectiveEvidenceOrigin: EvidenceOrigin | null;
  effectiveIsSyntheticFixture: boolean | null;
  retrievedAtIso: string | null;
  outDir?: string | undefined;
}): Promise<SnapshotAcquisitionResult> {
  const completedAt = params.clock();
  let failureReason = params.failureReason;
  let finalOk = params.structuralValidationOk;

  if (
    params.requests.length > 0 &&
    completedAt.getTime() > params.startedAt.getTime() + params.overallTimeoutMs
  ) {
    finalOk = false;
    const deadlineMsg = `DEADLINE_EXCEEDED: Overall acquisition deadline of ${params.overallTimeoutMs}ms exceeded`;
    failureReason = failureReason ? `${failureReason}; ${deadlineMsg}` : deadlineMsg;
  }

  const evidence: SnapshotAcquisitionEvidence = {
    schemaVersion: "1.0",
    command: "RaydiumAmmV4SnapshotAcquisition",
    executionMode: "LIVE_ACQUISITION",
    evidenceOrigin: params.effectiveEvidenceOrigin,
    isSyntheticFixture: params.effectiveIsSyntheticFixture,
    retrievedAtIso: params.retrievedAtIso,
    startedAtIso: params.startedAt.toISOString(),
    completedAtIso: completedAt.toISOString(),
    endpoint: params.publicEndpoint,
    config: {
      poolId: params.poolId,
      expectedTokenMint: params.expectedTokenMint,
      pacingMs: params.pacingMs,
      timeoutMs: params.timeoutMs,
      overallTimeoutMs: params.overallTimeoutMs,
    },
    httpAttempts: params.httpAttempts,
    maxHttpAttemptsAllowed: MAX_HTTP_ATTEMPTS_ALLOWED,
    pacingEnforcedMs: params.pacingEnforcedMs,
    contextSlots: {
      bootstrapSlot: params.bootstrapSlot,
      batchSlot: params.batchSlot,
      minContextSlotEnforced: true,
      staleSlotDetected: params.staleSlotDetected,
    },
    requests: params.requests,
    discoveredIdentities: params.discoveredIdentities,
    canonicalAmmAuthority: params.derivedAuthority,
    outcomes: {
      retrievalOk: params.retrievalOk,
      structuralValidationOk: params.structuralValidationOk,
      meetsNinetyPercentThreshold: params.meetsNinetyPercentThreshold,
    },
    validationResult: params.validationResult,
    accounting: params.accounting,
    failureReason,
    evidenceBoundary: {
      bytecodeEquivalenceVerified: false,
      completeExecutableReservesVerified: false,
      generalTokenSafetyVerified: false,
      strategyGateAdmitted: false,
    },
  };

  // Compute canonical payload digest prior to file writing
  const payloadJson = serializeJsonPreservingBigInts(evidence);
  const payloadDigestSha256 = crypto.createHash("sha256").update(payloadJson).digest("hex");
  evidence.payloadDigestSha256 = payloadDigestSha256;

  let manifest: SnapshotAcquisitionManifest | undefined;

  // Persist evidence and separate manifest if outDir is provided
  if (params.outDir && params.outDir.trim() !== "") {
    try {
      await fs.mkdir(params.outDir, { recursive: true });
      const safePoolPrefix = params.poolId.slice(0, 8);
      const timestampTag = (evidence.retrievedAtIso ?? evidence.completedAtIso).replace(
        /[:.]/g,
        "-",
      );

      let baseName = `raydium-amm-v4-snapshot-${safePoolPrefix}-${timestampTag}`;
      let evidencePath = path.resolve(params.outDir, `${baseName}.json`);
      let manifestPath = path.resolve(params.outDir, `${baseName}-manifest.json`);

      // Anti-overwrite check: if either artifact exists, find unique filename
      let counter = 1;
      while ((await fileExists(evidencePath)) || (await fileExists(manifestPath))) {
        baseName = `raydium-amm-v4-snapshot-${safePoolPrefix}-${timestampTag}-${counter++}`;
        evidencePath = path.resolve(params.outDir, `${baseName}.json`);
        manifestPath = path.resolve(params.outDir, `${baseName}-manifest.json`);
      }

      // Serialize finalized evidence bytes and compute exact file hash + size
      const evidenceBytes = Buffer.from(
        serializeJsonPreservingBigInts(evidence, 2) + "\n",
        "utf-8",
      );
      const evidenceFileSha256 = crypto.createHash("sha256").update(evidenceBytes).digest("hex");
      const evidenceByteSize = evidenceBytes.length;

      // Write evidence file exclusively
      await fs.writeFile(evidencePath, evidenceBytes, { flag: "wx" });

      const status = evidence.outcomes.structuralValidationOk
        ? "SUCCESS"
        : evidence.outcomes.retrievalOk
          ? "STRUCTURAL_VALIDATION_FAILED"
          : params.requests.length > 0
            ? "RETRIEVAL_FAILED"
            : "INTERRUPTED";

      manifest = {
        manifestVersion: "1.0",
        manifestType: "RAYDIUM_AMM_V4_SNAPSHOT_MANIFEST",
        createdAtIso: completedAt.toISOString(),
        poolId: params.poolId,
        status,
        httpAttempts: params.httpAttempts,
        evidenceFileName: path.basename(evidencePath),
        evidenceFilePath: evidencePath,
        evidenceFileSha256,
        evidenceByteSize,
        payloadDigestSha256,
        contextSlots: {
          bootstrapSlot: params.bootstrapSlot,
          batchSlot: params.batchSlot,
        },
        outcomes: evidence.outcomes,
        failureReason: evidence.failureReason,
      };

      const manifestBytes = Buffer.from(
        serializeJsonPreservingBigInts(manifest, 2) + "\n",
        "utf-8",
      );
      const manifestFileSha256 = crypto.createHash("sha256").update(manifestBytes).digest("hex");
      const manifestByteSize = manifestBytes.length;

      // Write manifest file exclusively
      await fs.writeFile(manifestPath, manifestBytes, { flag: "wx" });

      evidence.artifacts = {
        evidenceFileName: path.basename(evidencePath),
        evidenceFilePath: evidencePath,
        evidenceFileSha256,
        evidenceByteSize,
        manifestFileName: path.basename(manifestPath),
        manifestFilePath: manifestPath,
        manifestFileSha256,
        manifestByteSize,
      };
    } catch (writeErr) {
      // Storage failures make the operation unsuccessful
      finalOk = false;
      (evidence.outcomes as { structuralValidationOk: boolean }).structuralValidationOk = false;
      (evidence.outcomes as { meetsNinetyPercentThreshold: boolean }).meetsNinetyPercentThreshold =
        false;
      const storageErrMsg = `EVIDENCE_STORAGE_FAILED: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`;
      failureReason = failureReason ? `${failureReason}; ${storageErrMsg}` : storageErrMsg;
      evidence.failureReason = failureReason;
    }
  }

  return {
    ok: finalOk,
    dryRun: false,
    httpAttempts: params.httpAttempts,
    evidence,
    manifest,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
