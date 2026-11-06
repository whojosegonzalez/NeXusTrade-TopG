/**
 * Phase 12.94-D Milestone D.3.3: Solana Tracker Bundlers Operator Capture Tool
 *
 * Implements a bounded, one-shot operator capture tool for acquiring raw bundler
 * evidence from the documented Solana Tracker Data API GET /tokens/{token}/bundlers endpoint.
 *
 * Operational & Safety Invariants:
 * 1. Exactly One Mint: Operates on a single explicitly provided canonical Solana token mint.
 * 2. At Most One HTTP Request: Dispatches at most 1 HTTP GET request. Zero discovery, zero retries,
 *    zero redirects, zero polling, zero automatic reruns.
 * 3. Dry-Run by Default: Dry-run performs zero network requests and requires no API key.
 *    Live execution requires an explicit --live flag.
 * 4. Credential Hygiene: Reads API key strictly from the environment variable (SOLANA_TRACKER_API_KEY)
 *    during operator live execution. Never prints, saves, or logs the key, authorization headers,
 *    or credential-bearing error diagnostics.
 * 5. Budget Accounting: Uses GlobalResourceBudgetManager to enforce request limits, recording the
 *    attempt exactly once.
 * 6. Bounded Resources: Enforces strict request timeout (default 10,000 ms, max 15,000 ms) and
 *    response body size ceiling (default 2 MB).
 * 7. Schema Parsing: Passes raw response through the accepted SolanaTrackerBundlerParser.
 * 8. Evidence Sealing: Saves requested mint, exact provider URL, HTTP status, timestamps,
 *    received raw wire digest (SHA-256), sanitized response body, parser result, and a
 *    cryptographic manifest with exact file hashes and byte sizes.
 * 9. Anti-Overwrite Protection: Refuses to overwrite existing capture destinations.
 * 10. Fail-Closed Strategy Isolation: Provider data remains unverified (PROVIDER_REPORTED_UNVERIFIED);
 *     does not alter Gate 11 or admit candidates.
 */

import crypto from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import { isCanonicalSolanaBase58 } from "./LpScreeningBridge.js";
import {
  parseSolanaTrackerBundlersResponse,
  type SolanaTrackerBundlerParseResult,
} from "./SolanaTrackerBundlerParser.js";
import { GlobalResourceBudgetManager } from "../research/prospective/GlobalResourceBudgetManager.js";

export const DEFAULT_SOLANA_TRACKER_DATA_API_BASE_URL = "https://data.solanatracker.io";
export const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
export const MAX_REQUEST_TIMEOUT_MS = 15000;
export const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB
export const SOLANA_TRACKER_API_KEY_ENV_VAR = "SOLANA_TRACKER_API_KEY";

/**
 * Creates a standalone one-request budget manager for one-shot operator tools.
 * Configures maxTotalRequests = 1, maxEnrichmentAttempts = 1, minReservedForwardRequests = 0, minProviderSpacingMs = 0.
 */
export function createStandaloneOneRequestBudget(
  clock?: () => number,
): GlobalResourceBudgetManager {
  return new GlobalResourceBudgetManager({
    maxTotalRequests: 1,
    maxEnrichmentAttempts: 1,
    minReservedForwardRequests: 0,
    minProviderSpacingMs: 0,
    ...(clock ? { clock } : {}),
  });
}

export type BundlerCaptureStatus =
  | "SUCCESS"
  | "DRY_RUN"
  | "HTTP_ERROR"
  | "PARSE_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "REDIRECT_REJECTED"
  | "RESPONSE_TOO_LARGE"
  | "BUDGET_DENIED"
  | "INVALID_INPUT"
  | "DESTINATION_ALREADY_EXISTS";

export interface HttpTransportResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Record<string, string>;
  readonly bodyText: () => Promise<string>;
}

export type HttpTransport = (
  url: string,
  options: {
    readonly method: "GET";
    readonly headers: Record<string, string>;
    readonly signal?: AbortSignal;
  },
) => Promise<HttpTransportResponse>;

export const defaultFetchTransport: HttpTransport = async (url, options) => {
  const init: RequestInit = {
    method: options.method,
    headers: options.headers,
    redirect: "manual", // Reject redirects
  };
  if (options.signal) {
    init.signal = options.signal;
  }
  const resp = await fetch(url, init);
  return {
    status: resp.status,
    statusText: resp.statusText,
    headers: Object.fromEntries(resp.headers.entries()),
    bodyText: () => resp.text(),
  };
};

export interface BundlerCaptureConfig {
  readonly mint: string;
  readonly isLive?: boolean | undefined; // default: false (dry-run)
  readonly apiKey?: string | undefined; // Optional explicit key (defaults to process.env.SOLANA_TRACKER_API_KEY in live mode)
  readonly baseUrl?: string | undefined; // default: https://data.solanatracker.io
  readonly timeoutMs?: number | undefined; // default: 10000 ms, max 15000 ms
  readonly maxResponseSizeBytes?: number | undefined; // default: 2 MB
  readonly outDir?: string | undefined; // destination directory for evidence
  readonly budget?: GlobalResourceBudgetManager | undefined;
  readonly transport?: HttpTransport | undefined;
  readonly clock?: () => number;
}

export interface CaptureManifestFileEntry {
  readonly filename: string;
  readonly sha256: string;
  readonly byteSize: number;
}

export interface CaptureManifest {
  readonly manifestVersion: "1.0";
  readonly capturedAtIso: string;
  readonly requestedMint: string;
  readonly totalFiles: number;
  readonly totalBytes: number;
  readonly files: readonly CaptureManifestFileEntry[];
  readonly manifestSha256: string;
}

export interface BundlerCaptureMetadata {
  readonly requestedMint: string;
  readonly providerUrl: string;
  readonly httpStatus: number | null;
  readonly localRequestTimeIso: string;
  readonly localResponseTimeIso: string | null;
  readonly localRetrievedAtMs: number;
  readonly executionDurationMs: number;
  readonly receivedBytesCount: number;
  readonly receivedWireSha256: string;
  readonly wasRedacted: boolean;
  readonly savedEvidenceSha256: string;
  readonly status: BundlerCaptureStatus;
  readonly errorMessage: string | null;
  readonly disclaimer: string;
}

export interface BundlerCaptureSuccessResult {
  readonly success: true;
  readonly dryRun: false;
  readonly status: "SUCCESS";
  readonly targetDir: string;
  readonly metadata: BundlerCaptureMetadata;
  readonly parserResult: SolanaTrackerBundlerParseResult;
  readonly manifest: CaptureManifest;
}

export interface BundlerCaptureDryRunResult {
  readonly success: true;
  readonly dryRun: true;
  readonly status: "DRY_RUN";
  readonly mint: string;
  readonly plannedUrl: string;
  readonly limits: {
    readonly timeoutMs: number;
    readonly maxResponseSizeBytes: number;
    readonly maxHttpAttempts: 1;
  };
  readonly budgetStatus: ReturnType<GlobalResourceBudgetManager["getStats"]>;
  readonly message: string;
}

export interface BundlerCaptureFailureResult {
  readonly success: false;
  readonly dryRun: boolean;
  readonly status: BundlerCaptureStatus;
  readonly message: string;
  readonly targetDir?: string | undefined;
  readonly metadata?: BundlerCaptureMetadata | undefined;
  readonly parserResult?: SolanaTrackerBundlerParseResult | undefined;
  readonly manifest?: CaptureManifest | undefined;
}

export type BundlerCaptureResult =
  | BundlerCaptureSuccessResult
  | BundlerCaptureDryRunResult
  | BundlerCaptureFailureResult;

/**
 * Computes hexadecimal SHA-256 digest of utf8 text or Buffer.
 */
export function computeSha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Sanitizes text by thoroughly redacting known secret keys and common auth token patterns.
 */
export function redactSensitiveText(text: string, secrets: string[] = []): string {
  if (!text) return "";
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) {
      out = out.split(s).join("[REDACTED]");
    }
  }
  out = out.replace(
    /([?&])(api[-_]?key|token|secret|password|auth)=([^&\s'"]+)/gi,
    "$1$2=[REDACTED]",
  );
  out = out.replace(
    /(^|\s)(api[-_]?key|token|secret|password|auth)=([^&\s'"]+)/gi,
    "$1$2=[REDACTED]",
  );
  out = out.replace(
    /(api[-_]?key|token|secret|password|auth|x-api-key):\s*['"]?([^&\s'"]+)['"]?/gi,
    "$1:[REDACTED]",
  );
  out = out.replace(/([a-zA-Z0-9]+:\/\/)([^:]+):([^@]+)@/g, "$1[REDACTED]:[REDACTED]@");
  return out;
}

/**
 * Builds and seals a cryptographic manifest for the capture directory.
 */
function sealCaptureManifest(
  targetDir: string,
  requestedMint: string,
  createdAtIso: string,
): CaptureManifest {
  const fileNames = fsSync.readdirSync(targetDir).filter((f) => f !== "capture-manifest.json");
  const entries: CaptureManifestFileEntry[] = [];
  let totalBytes = 0;

  for (const filename of fileNames) {
    const filePath = path.join(targetDir, filename);
    const content = fsSync.readFileSync(filePath);
    entries.push({
      filename,
      sha256: computeSha256(content),
      byteSize: content.length,
    });
    totalBytes += content.length;
  }

  // Sort entries deterministically by filename
  entries.sort((a, b) => a.filename.localeCompare(b.filename));

  const manifestPayload = entries.map((f) => `${f.filename}:${f.sha256}`).join("\n");
  const manifestSha256 = computeSha256(manifestPayload);

  const manifest: CaptureManifest = {
    manifestVersion: "1.0",
    capturedAtIso: createdAtIso,
    requestedMint,
    totalFiles: entries.length,
    totalBytes,
    files: entries,
    manifestSha256,
  };

  const manifestPath = path.join(targetDir, "capture-manifest.json");
  fsSync.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

/**
 * Executes a bounded one-shot bundler capture for an explicitly selected mint.
 */
export async function captureSolanaTrackerBundlers(
  config: BundlerCaptureConfig,
): Promise<BundlerCaptureResult> {
  const clock = config.clock ?? (() => Date.now());
  const isLive = config.isLive === true;

  // 1. Validate requested mint
  if (!config.mint || typeof config.mint !== "string" || !isCanonicalSolanaBase58(config.mint)) {
    return {
      success: false,
      dryRun: !isLive,
      status: "INVALID_INPUT",
      message: `Invalid token mint: '${config.mint}'. Must be a canonical 32-byte Solana base58 address.`,
    };
  }
  const mint = config.mint;

  // 2. Validate configuration limits
  const timeoutMs = Math.min(
    config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    MAX_REQUEST_TIMEOUT_MS,
  );
  if (timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    return {
      success: false,
      dryRun: !isLive,
      status: "INVALID_INPUT",
      message: `Invalid timeoutMs: '${config.timeoutMs}'. Must be a positive safe number.`,
    };
  }

  const maxResponseSizeBytes = config.maxResponseSizeBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (maxResponseSizeBytes <= 0 || !Number.isFinite(maxResponseSizeBytes)) {
    return {
      success: false,
      dryRun: !isLive,
      status: "INVALID_INPUT",
      message: `Invalid maxResponseSizeBytes: '${config.maxResponseSizeBytes}'. Must be positive.`,
    };
  }

  const baseUrl = (config.baseUrl ?? DEFAULT_SOLANA_TRACKER_DATA_API_BASE_URL).replace(/\/+$/, "");
  const providerUrl = `${baseUrl}/tokens/${mint}/bundlers`;

  // 3. Initialize or reuse GlobalResourceBudgetManager
  // Standalone one-request configuration: max 1 request, max 1 enrichment attempt, 0 reserved
  const budget = config.budget ?? createStandaloneOneRequestBudget(clock);

  // 4. DRY-RUN MODE: Zero network requests dispatched, no API key required
  if (!isLive) {
    return {
      success: true,
      dryRun: true,
      status: "DRY_RUN",
      mint,
      plannedUrl: providerUrl,
      limits: {
        timeoutMs,
        maxResponseSizeBytes,
        maxHttpAttempts: 1,
      },
      budgetStatus: budget.getStats(),
      message: "Dry-run completed successfully. Zero network requests dispatched.",
    };
  }

  // 5. LIVE EXECUTION MODE: Verify API key from env or config
  const rawApiKey = config.apiKey ?? process.env[SOLANA_TRACKER_API_KEY_ENV_VAR];
  if (!rawApiKey || typeof rawApiKey !== "string" || rawApiKey.trim().length === 0) {
    return {
      success: false,
      dryRun: false,
      status: "INVALID_INPUT",
      message: `Missing API key for live execution. Set the '${SOLANA_TRACKER_API_KEY_ENV_VAR}' environment variable.`,
    };
  }
  const apiKey = rawApiKey.trim();
  const secretsToRedact = [apiKey];

  // 6. Pre-flight budget check
  const nowPreFlight = clock();
  const canMake = budget.canMakeRequest("SOLANA_TRACKER", nowPreFlight, "CANDIDATE_ENRICHMENT");
  if (!canMake.allowed) {
    return {
      success: false,
      dryRun: false,
      status: "BUDGET_DENIED",
      message: `Request denied by budget manager: ${canMake.reason ?? "BUDGET_EXHAUSTED"}`,
    };
  }

  // 7. Determine and validate target output directory (Anti-overwrite protection)
  const localRequestTimeMs = clock();
  const localRequestTimeIso = new Date(localRequestTimeMs).toISOString();
  const defaultDirName = `${localRequestTimeIso.replace(/[:.]/g, "-")}_${mint}`;
  const targetDir = config.outDir
    ? path.resolve(config.outDir)
    : path.resolve("data/research/captures/solana-tracker-bundler", defaultDirName);

  if (fsSync.existsSync(targetDir)) {
    return {
      success: false,
      dryRun: false,
      status: "DESTINATION_ALREADY_EXISTS",
      targetDir,
      message: `Refusing to overwrite existing evidence directory: ${targetDir}`,
    };
  }

  // 8. Record single request attempt in budget manager (Atomic recording)
  const attemptRecorded = budget.recordRequestAttempt(
    "SOLANA_TRACKER",
    "CANDIDATE_ENRICHMENT",
    localRequestTimeMs,
  );
  if (!attemptRecorded) {
    return {
      success: false,
      dryRun: false,
      status: "BUDGET_DENIED",
      message: "Failed to record single request attempt in budget manager.",
    };
  }

  // 9. Prepare HTTP transport and abort controller
  const transport = config.transport ?? defaultFetchTransport;
  const abortController = new AbortController();
  let isTimedOut = false;

  const timer = setTimeout(() => {
    isTimedOut = true;
    abortController.abort(new Error(`Request timed out after ${timeoutMs} ms`));
  }, timeoutMs);

  let rawWireBody = "";
  let httpStatus: number | null = null;
  let localResponseTimeMs: number | null = null;
  let localResponseTimeIso: string | null = null;
  let captureStatus: BundlerCaptureStatus = "SUCCESS";
  let errorMessage: string | null = null;

  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "x-api-key": apiKey,
    };

    const response = await transport(providerUrl, {
      method: "GET",
      headers,
      signal: abortController.signal,
    });

    clearTimeout(timer);
    localResponseTimeMs = clock();
    localResponseTimeIso = new Date(localResponseTimeMs).toISOString();
    httpStatus = response.status;

    // Record response status in budget manager (for 429 tracking)
    budget.recordResponseStatus(httpStatus);

    // 9.1 Reject HTTP redirects
    if (httpStatus >= 300 && httpStatus < 400) {
      captureStatus = "REDIRECT_REJECTED";
      errorMessage = `HTTP redirects are strictly prohibited. Received status: ${httpStatus}`;
    } else {
      // 9.2 Check Content-Length header against max size before reading body
      const contentLengthHeader = response.headers["content-length"];
      if (contentLengthHeader) {
        const contentLength = parseInt(contentLengthHeader, 10);
        if (Number.isFinite(contentLength) && contentLength > maxResponseSizeBytes) {
          captureStatus = "RESPONSE_TOO_LARGE";
          errorMessage = `Response Content-Length (${contentLength} bytes) exceeds limit of ${maxResponseSizeBytes} bytes.`;
        }
      }

      if (captureStatus === "SUCCESS") {
        rawWireBody = await response.bodyText();

        if (Buffer.byteLength(rawWireBody, "utf8") > maxResponseSizeBytes) {
          captureStatus = "RESPONSE_TOO_LARGE";
          errorMessage = `Response body size (${Buffer.byteLength(rawWireBody, "utf8")} bytes) exceeds limit of ${maxResponseSizeBytes} bytes.`;
        } else if (httpStatus !== 200) {
          captureStatus = "HTTP_ERROR";
          errorMessage = `Provider returned non-200 HTTP status: ${httpStatus} ${response.statusText}`;
        }
      }
    }
  } catch (err: unknown) {
    clearTimeout(timer);
    localResponseTimeMs = clock();
    localResponseTimeIso = new Date(localResponseTimeMs).toISOString();

    if (isTimedOut || (err instanceof Error && err.name === "AbortError")) {
      captureStatus = "TIMEOUT";
      errorMessage = `Request timed out after ${timeoutMs} ms.`;
    } else {
      captureStatus = "NETWORK_ERROR";
      const rawMsg = err instanceof Error ? err.message : String(err);
      errorMessage = redactSensitiveText(rawMsg, secretsToRedact);
    }
  }

  // 10. Compute received raw wire digest (before any redaction)
  const receivedWireSha256 = computeSha256(rawWireBody);
  const receivedBytesCount = Buffer.byteLength(rawWireBody, "utf8");

  // 11. Redact response body before saving to disk
  const sanitizedResponseBody = redactSensitiveText(rawWireBody, secretsToRedact);
  const wasRedacted = sanitizedResponseBody !== rawWireBody;
  const savedEvidenceSha256 = computeSha256(sanitizedResponseBody);

  // 12. Parse response through SolanaTrackerBundlerParser (if 200 OK)
  let parserResult: SolanaTrackerBundlerParseResult | undefined;
  if (captureStatus === "SUCCESS" && httpStatus === 200) {
    try {
      const parsedJson = JSON.parse(rawWireBody);
      parserResult = parseSolanaTrackerBundlersResponse(parsedJson, {
        requestedMint: mint,
        localRetrievedAtMs: localResponseTimeMs ?? localRequestTimeMs,
      });

      if (!parserResult.success) {
        captureStatus = "PARSE_ERROR";
        errorMessage = `Parser failed validation with error [${parserResult.error}]: ${parserResult.message}`;
      }
    } catch (parseErr: unknown) {
      captureStatus = "PARSE_ERROR";
      const rawMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      errorMessage = `JSON parsing failed: ${redactSensitiveText(rawMsg, secretsToRedact)}`;
      parserResult = {
        success: false,
        error: "MALFORMED_PAYLOAD",
        message: errorMessage,
      };
    }
  }

  // 13. Create destination directory and write sealed evidence
  fsSync.mkdirSync(targetDir, { recursive: true });

  const metadata: BundlerCaptureMetadata = {
    requestedMint: mint,
    providerUrl,
    httpStatus,
    localRequestTimeIso,
    localResponseTimeIso,
    localRetrievedAtMs: localResponseTimeMs ?? localRequestTimeMs,
    executionDurationMs: (localResponseTimeMs ?? clock()) - localRequestTimeMs,
    receivedBytesCount,
    receivedWireSha256,
    wasRedacted,
    savedEvidenceSha256,
    status: captureStatus,
    errorMessage: errorMessage ? redactSensitiveText(errorMessage, secretsToRedact) : null,
    disclaimer:
      "PROVIDER_REPORTED_UNVERIFIED: Capture does not establish provider accuracy, complete launch history, strategy eligibility, or production trade-flow completeness. Gate 11 remains fail-closed.",
  };

  fsSync.writeFileSync(
    path.join(targetDir, "sanitized-response.json"),
    sanitizedResponseBody,
    "utf8",
  );

  fsSync.writeFileSync(
    path.join(targetDir, "capture-metadata.json"),
    JSON.stringify(metadata, null, 2),
    "utf8",
  );

  if (parserResult) {
    fsSync.writeFileSync(
      path.join(targetDir, "parser-result.json"),
      JSON.stringify(parserResult, null, 2),
      "utf8",
    );
  }

  // 14. Seal manifest with cryptographic hashes of all files in directory
  const manifest = sealCaptureManifest(targetDir, mint, localRequestTimeIso);

  if (captureStatus === "SUCCESS" && parserResult?.success) {
    return {
      success: true,
      dryRun: false,
      status: "SUCCESS",
      targetDir,
      metadata,
      parserResult,
      manifest,
    };
  }

  return {
    success: false,
    dryRun: false,
    status: captureStatus,
    message: errorMessage ?? `Capture failed with status: ${captureStatus}`,
    targetDir,
    metadata,
    parserResult,
    manifest,
  };
}

/**
 * Parses CLI arguments for the bundler capture tool.
 */
export function parseBundlerCaptureArgs(args: readonly string[]): {
  readonly mint?: string | undefined;
  readonly isLive: boolean;
  readonly outDir?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxResponseSizeBytes?: number | undefined;
  readonly baseUrl?: string | undefined;
  readonly help: boolean;
} {
  let mint: string | undefined;
  let isLive = false;
  let outDir: string | undefined;
  let timeoutMs: number | undefined;
  let maxResponseSizeBytes: number | undefined;
  let baseUrl: string | undefined;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "--live") {
      isLive = true;
    } else if (arg === "--dry-run") {
      isLive = false;
    } else if (arg === "--mint" && i + 1 < args.length) {
      mint = args[++i];
    } else if (arg === "--out-dir" && i + 1 < args.length) {
      outDir = args[++i];
    } else if (arg === "--timeout-ms" && i + 1 < args.length) {
      timeoutMs = parseInt(args[++i]!, 10);
    } else if (arg === "--max-bytes" && i + 1 < args.length) {
      maxResponseSizeBytes = parseInt(args[++i]!, 10);
    } else if (arg === "--base-url" && i + 1 < args.length) {
      baseUrl = args[++i];
    }
  }

  return {
    mint,
    isLive,
    outDir,
    timeoutMs,
    maxResponseSizeBytes,
    baseUrl,
    help,
  };
}
