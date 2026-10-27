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
 * - At most 2 outbound HTTP attempts; strictly counted.
 * - Zero retries, zero redirects, zero fallback providers, zero auto-discovery.
 * - Terminate immediately after attempt 1 if bootstrap validation fails.
 * - Require explicitly supplied RPC endpoint; credentials sanitized via sanitizeSolanaRpcUrl.
 * - Dry-run mode making zero network calls.
 * - Preserves evidence without inventing provenance (CAPTURED_RPC, isSyntheticFixture: false).
 * - BigInts serialized as decimal strings in JSON.
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
export const MAX_HTTP_ATTEMPTS_ALLOWED = 2;

export interface SnapshotAcquisitionConfig {
  readonly rpcUrl?: string | undefined;
  readonly poolId?: string | undefined;
  readonly expectedTokenMint?: string | undefined;
  readonly pacingMs?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly overallTimeoutMs?: number | undefined;
  readonly outDir?: string | undefined;
  readonly dryRun?: boolean | undefined;
  readonly fetch?: typeof fetch | undefined;
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
  readonly responseSha256: string | null;
  readonly parsedJson: Record<string, unknown> | null;
  readonly error: string | null;
}

export interface SnapshotAcquisitionEvidence {
  readonly schemaVersion: "1.0";
  readonly command: "RaydiumAmmV4SnapshotAcquisition";
  readonly executionMode: "LIVE_ACQUISITION" | "DRY_RUN";
  readonly evidenceOrigin: "CAPTURED_RPC";
  readonly isSyntheticFixture: false;
  readonly retrievedAtIso: string | null;
  readonly startedAtIso: string;
  readonly completedAtIso: string;
  readonly endpoint: SanitizedRpcEndpointInfo;
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
  evidenceDigestSha256?: string | undefined;
  evidenceFilePath?: string | undefined;
}

export interface SnapshotAcquisitionResult {
  readonly ok: boolean;
  readonly dryRun: boolean;
  readonly httpAttempts: number;
  readonly evidence: SnapshotAcquisitionEvidence;
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

  const poolId = config.poolId ?? REFERENCE_RAY_WSOL_POOL_ID;
  const expectedTokenMint =
    config.expectedTokenMint !== undefined
      ? config.expectedTokenMint
      : config.poolId === undefined || config.poolId === REFERENCE_RAY_WSOL_POOL_ID
        ? REFERENCE_RAY_TOKEN_MINT
        : null;

  const pacingMs = Math.max(MIN_HOST_PACING_MS, config.pacingMs ?? MIN_HOST_PACING_MS);
  const timeoutMs = config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const overallTimeoutMs = config.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;
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
  const sanitizedEndpoint: SanitizedRpcEndpointInfo =
    rawRpcUrl.length > 0
      ? sanitizeSolanaRpcUrl(rawRpcUrl)
      : {
          rawUrl: "",
          sanitizedUrl: "[DRY_RUN_ENDPOINT_UNSPECIFIED]",
          host: "dry-run",
          endpointFingerprint: "sha256:0000000000000000",
          sensitiveTokens: [],
        };

  // DRY-RUN MODE: Zero network calls, return planned sequence and evidence template
  if (dryRun) {
    const completedAt = clock();
    const dryRunEvidence: SnapshotAcquisitionEvidence = {
      schemaVersion: "1.0",
      command: "RaydiumAmmV4SnapshotAcquisition",
      executionMode: "DRY_RUN",
      evidenceOrigin: "CAPTURED_RPC",
      isSyntheticFixture: false,
      retrievedAtIso: null,
      startedAtIso: startedAt.toISOString(),
      completedAtIso: completedAt.toISOString(),
      endpoint: sanitizedEndpoint,
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

    const serializedDryRun = serializeJsonPreservingBigInts(dryRunEvidence);
    dryRunEvidence.evidenceDigestSha256 = crypto
      .createHash("sha256")
      .update(serializedDryRun)
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

  const startEpoch = startedAt.getTime();

  /**
   * Helper to execute a strictly counted, timeout-bounded outbound JSON-RPC POST request.
   */
  async function executeRpcCall(
    method: "getAccountInfo" | "getMultipleAccounts",
    params: readonly unknown[],
  ): Promise<{
    record: BoundedRpcRequestRecord;
    json: Record<string, unknown> | null;
  }> {
    if (httpAttempts >= MAX_HTTP_ATTEMPTS_ALLOWED) {
      throw new Error(
        `[BOUNDED_EXECUTION_BREACH] Exceeded maximum allowed HTTP attempts (${MAX_HTTP_ATTEMPTS_ALLOWED})`,
      );
    }

    httpAttempts++;
    const currentAttempt = httpAttempts;
    const reqTimestamp = clock();
    const requestTimestampIso = reqTimestamp.toISOString();

    const elapsedSoFar = reqTimestamp.getTime() - startEpoch;
    const remainingOverall = overallTimeoutMs - elapsedSoFar;
    if (remainingOverall <= 0) {
      const rec: BoundedRpcRequestRecord = {
        attempt: currentAttempt,
        method,
        params,
        requestTimestampIso,
        responseTimestampIso: clock().toISOString(),
        elapsedMs: 0,
        httpStatus: null,
        rawResponseBody: null,
        responseSha256: null,
        parsedJson: null,
        error: `Overall acquisition timeout ceiling of ${overallTimeoutMs}ms exceeded`,
      };
      requests.push(rec);
      return { record: rec, json: null };
    }

    const effectiveTimeout = Math.min(timeoutMs, remainingOverall);
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
    let responseSha256: string | null = null;
    let parsedJson: Record<string, unknown> | null = null;
    let errMessage: string | null = null;

    try {
      const response = await fetchImpl(rawRpcUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(rpcPayload),
        signal: controller.signal,
        redirect: "error",
      });

      httpStatus = response.status;
      rawResponseBody = await response.text();
      responseSha256 = crypto.createHash("sha256").update(rawResponseBody).digest("hex");

      if (response.status !== 200) {
        errMessage = `HTTP error ${response.status}: ${response.statusText || "Non-200 response"}`;
      } else {
        try {
          parsedJson = JSON.parse(rawResponseBody) as Record<string, unknown>;
        } catch (jsonErr) {
          errMessage = `Malformed JSON response: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`;
        }
      }
    } catch (fetchErr) {
      if (controller.signal.aborted) {
        errMessage = `Request timed out after ${effectiveTimeout}ms`;
      } else {
        errMessage = `Network error: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`;
      }
    } finally {
      clearTimeout(timer);
    }

    const respTimestamp = clock();
    const elapsedMs = respTimestamp.getTime() - reqTimestamp.getTime();

    const record: BoundedRpcRequestRecord = {
      attempt: currentAttempt,
      method,
      params,
      requestTimestampIso,
      responseTimestampIso: respTimestamp.toISOString(),
      elapsedMs,
      httpStatus,
      rawResponseBody,
      responseSha256,
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
    failureReason = `Bootstrap Request 1 failed: ${req1Record.error ?? "Empty response"}`;
  } else if (req1Json.error) {
    failureReason = `Bootstrap Request 1 RPC error: ${typeof req1Json.error === "object" ? JSON.stringify(req1Json.error) : String(req1Json.error)}`;
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
    const completedAt = clock();
    const evidence: SnapshotAcquisitionEvidence = {
      schemaVersion: "1.0",
      command: "RaydiumAmmV4SnapshotAcquisition",
      executionMode: "LIVE_ACQUISITION",
      evidenceOrigin: "CAPTURED_RPC",
      isSyntheticFixture: false,
      retrievedAtIso: req1Record.responseTimestampIso,
      startedAtIso: startedAt.toISOString(),
      completedAtIso: completedAt.toISOString(),
      endpoint: sanitizedEndpoint,
      config: {
        poolId,
        expectedTokenMint,
        pacingMs,
        timeoutMs,
        overallTimeoutMs,
      },
      httpAttempts,
      maxHttpAttemptsAllowed: MAX_HTTP_ATTEMPTS_ALLOWED,
      pacingEnforcedMs: null,
      contextSlots: {
        bootstrapSlot,
        batchSlot: null,
        minContextSlotEnforced: true,
        staleSlotDetected: false,
      },
      requests,
      discoveredIdentities,
      canonicalAmmAuthority: derivedAuthority,
      outcomes: {
        retrievalOk: false,
        structuralValidationOk: false,
        meetsNinetyPercentThreshold: false,
      },
      validationResult: null,
      accounting: null,
      failureReason,
      evidenceBoundary: {
        bytecodeEquivalenceVerified: false,
        completeExecutableReservesVerified: false,
        generalTokenSafetyVerified: false,
        strategyGateAdmitted: false,
      },
    };

    await maybeWriteEvidenceFile(evidence, config.outDir);

    return {
      ok: false,
      dryRun: false,
      httpAttempts,
      evidence,
    };
  }

  // =========================================================================
  // HOST PACING: Enforce at least 2,500 ms pause before Request 2
  // =========================================================================
  await sleeper(pacingMs);
  pacingEnforcedMs = pacingMs;

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
    failureReason = `Batch Request 2 failed: ${req2Record.error ?? "Empty response"}`;
  } else if (req2Json.error) {
    failureReason = `Batch Request 2 RPC error: ${typeof req2Json.error === "object" ? JSON.stringify(req2Json.error) : String(req2Json.error)}`;
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
          evidenceOrigin: "CAPTURED_RPC",
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

  const completedAt = clock();
  const evidence: SnapshotAcquisitionEvidence = {
    schemaVersion: "1.0",
    command: "RaydiumAmmV4SnapshotAcquisition",
    executionMode: "LIVE_ACQUISITION",
    evidenceOrigin: "CAPTURED_RPC",
    isSyntheticFixture: false,
    retrievedAtIso: req2Record?.responseTimestampIso ?? req1Record.responseTimestampIso,
    startedAtIso: startedAt.toISOString(),
    completedAtIso: completedAt.toISOString(),
    endpoint: sanitizedEndpoint,
    config: {
      poolId,
      expectedTokenMint,
      pacingMs,
      timeoutMs,
      overallTimeoutMs,
    },
    httpAttempts,
    maxHttpAttemptsAllowed: MAX_HTTP_ATTEMPTS_ALLOWED,
    pacingEnforcedMs,
    contextSlots: {
      bootstrapSlot,
      batchSlot,
      minContextSlotEnforced: true,
      staleSlotDetected,
    },
    requests,
    discoveredIdentities,
    canonicalAmmAuthority: derivedAuthority,
    outcomes: {
      retrievalOk,
      structuralValidationOk,
      meetsNinetyPercentThreshold,
    },
    validationResult,
    accounting,
    failureReason,
    evidenceBoundary: {
      bytecodeEquivalenceVerified: false,
      completeExecutableReservesVerified: false,
      generalTokenSafetyVerified: false,
      strategyGateAdmitted: false,
    },
  };

  await maybeWriteEvidenceFile(evidence, config.outDir);

  return {
    ok: structuralValidationOk,
    dryRun: false,
    httpAttempts,
    evidence,
  };
}

/**
 * Seals the snapshot acquisition evidence with an overall SHA-256 digest and writes it to disk if requested.
 */
async function maybeWriteEvidenceFile(
  evidence: SnapshotAcquisitionEvidence,
  outDir?: string | undefined,
): Promise<void> {
  const serialized = serializeJsonPreservingBigInts(evidence);
  const digest = crypto.createHash("sha256").update(serialized).digest("hex");
  evidence.evidenceDigestSha256 = digest;

  if (outDir && outDir.trim() !== "") {
    try {
      await fs.mkdir(outDir, { recursive: true });
      const safePoolPrefix = evidence.config.poolId.slice(0, 8);
      const timestampTag = (evidence.retrievedAtIso ?? evidence.completedAtIso).replace(
        /[:.]/g,
        "-",
      );
      const filename = `raydium-amm-v4-snapshot-${safePoolPrefix}-${timestampTag}.json`;
      const fullPath = path.resolve(outDir, filename);

      await fs.writeFile(fullPath, serializeJsonPreservingBigInts(evidence), "utf-8");
      evidence.evidenceFilePath = fullPath;
    } catch (writeErr) {
      // Do not crash execution if filesystem write fails; preserve error in manifest
      evidence.failureReason =
        (evidence.failureReason ? `${evidence.failureReason}; ` : "") +
        `Failed to write evidence file: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`;
    }
  }
}
