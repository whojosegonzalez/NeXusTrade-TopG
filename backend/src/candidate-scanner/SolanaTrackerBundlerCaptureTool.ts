/**
 * Phase 12.94-D Milestone D.3.3: Solana Tracker Bundlers Operator Capture Tool
 *
 * Implements a bounded, one-shot operator capture tool for acquiring raw bundler
 * evidence from the documented Solana Tracker Data API GET /tokens/{token}/bundlers endpoint.
 *
 * Operational & Safety Invariants:
 * 1. Exactly One Mint: Operates on a single explicitly provided canonical Solana token mint.
 * 2. At Most One HTTP Request: Dispatches at most 1 HTTP GET request to the fixed, documented
 *    HTTPS origin (https://data.solanatracker.io/tokens/{mint}/bundlers). No URL override in production.
 *    Zero discovery, zero retries, zero redirects, zero polling, zero automatic reruns.
 * 3. Dry-Run by Default: Dry-run performs zero network requests and requires no API key.
 *    Live execution requires an explicit --live flag.
 * 4. Active Deadline Across Full Lifecycle: Request deadline remains active through header retrieval
 *    and streaming response body reads. Awaited operations are raced against the deadline; late
 *    completions are discarded on timeout or overflow.
 * 5. Streaming Byte Limit Enforcement: Reads response bytes with an enforced size limit (default 2 MB,
 *    max 10 MB); aborts reading immediately on overflow rather than buffering excess bytes first.
 * 6. Authentic Wire Digest: Received byte count and SHA-256 wire digest are computed directly from raw
 *    wire bytes before text decoding. Partial or truncated captures are labeled honestly.
 * 7. Comprehensive Credential Hygiene: Reads API key strictly from SOLANA_TRACKER_API_KEY during
 *    operator live execution. Redacts plain text, decoded JSON, and unicode-escaped JSON representations
 *    across every saved artifact (sanitized-response.json, capture-metadata.json, parser-result.json),
 *    returned diagnostics, and error paths.
 * 8. Atomic Destination Reservation: Exclusively creates destination directory pre-dispatch to prevent
 *    concurrent captures from competing or overwriting evidence. Uses exclusive file writes.
 * 9. Accurate Manifest Labeling: Clearly separates and labels entriesDigestSha256 and manifestFileSha256.
 * 10. Budget Accounting: Uses GlobalResourceBudgetManager in a standalone 1-request configuration
 *     (maxTotalRequests = 1, maxEnrichmentAttempts = 1, minReservedForwardRequests = 0), recording the
 *     attempt exactly once.
 * 11. Fail-Closed Strategy Isolation: Provider data remains unverified (PROVIDER_REPORTED_UNVERIFIED);
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
import { loadLocalEnvFile } from "../config/loadEnvFile.js";

export const SOLANA_TRACKER_DATA_API_BASE_URL = "https://data.solanatracker.io";
export const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
export const MAX_REQUEST_TIMEOUT_MS = 15000;
export const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB
export const MAX_ALLOWED_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB ceiling
export const SOLANA_TRACKER_API_KEY_ENV_VAR = "SOLANA_TRACKER_API_KEY";

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

export class ResponseTooLargeError extends Error {
  readonly partialBytes: Buffer;
  readonly totalBytesRead: number;
  readonly incrementalWireSha256: string;
  readonly prefixSha256: string;

  constructor(
    message: string,
    partialBytes: Buffer,
    totalBytesRead: number,
    incrementalWireSha256: string,
    prefixSha256: string,
  ) {
    super(message);
    this.name = "ResponseTooLargeError";
    this.partialBytes = partialBytes;
    this.totalBytesRead = totalBytesRead;
    this.incrementalWireSha256 = incrementalWireSha256;
    this.prefixSha256 = prefixSha256;
  }
}

export interface HttpTransportBodyResult {
  readonly bytes: Buffer;
  readonly totalObservedBytes: number;
  readonly incrementalWireSha256: string;
}

/**
 * Reads bytes from a ReadableStream<Uint8Array> up to maxBytes, enforcing streaming bounds.
 * Retains at most maxBytes of raw prefix data as bounded owned copies (independent memory allocation).
 * Computes incremental wire SHA-256 across all observed bytes.
 * Aborts and cancels the reader immediately if maxBytes is exceeded.
 */
export async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<HttpTransportBodyResult> {
  const reader = stream.getReader();
  const retainedChunks: Buffer[] = [];
  let retainedBytes = 0;
  let totalObservedBytes = 0;

  const wireHasher = crypto.createHash("sha256");

  let abortListener: (() => void) | undefined;
  let abortPromise: Promise<never> | undefined;

  if (signal) {
    abortPromise = new Promise<never>((_, reject) => {
      if (signal.aborted) {
        const err = new Error("Operation aborted");
        err.name = "AbortError";
        reject(err);
        return;
      }
      abortListener = () => {
        const err = new Error("Operation aborted");
        err.name = "AbortError";
        reject(err);
      };
      signal.addEventListener("abort", abortListener, { once: true });
    });
  }

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel(signal.reason);
        const err = new Error("Operation aborted");
        err.name = "AbortError";
        throw err;
      }

      const readPromise = reader.read();
      const { done, value } = abortPromise
        ? await Promise.race([readPromise, abortPromise])
        : await readPromise;

      if (done) break;
      if (value && value.byteLength > 0) {
        // 1. Accumulate total observed count and update wire digest incrementally
        totalObservedBytes += value.byteLength;
        wireHasher.update(value);

        // 2. Check remaining retention capacity before copying
        const remainingCapacity = maxBytes - retainedBytes;
        if (remainingCapacity > 0) {
          const bytesToCopy = Math.min(value.byteLength, remainingCapacity);
          // Allocate an owned independent Buffer copy so backing ArrayBuffer of oversized chunks is not kept alive
          const ownedCopy = Buffer.alloc(bytesToCopy);
          ownedCopy.set(value.subarray(0, bytesToCopy));
          retainedChunks.push(ownedCopy);
          retainedBytes += bytesToCopy;
        }

        // 3. Immediately abort and cancel stream if observed bytes exceed limit
        if (totalObservedBytes > maxBytes) {
          const partialBytes = Buffer.concat(retainedChunks);
          const incrementalWireSha256 = wireHasher.digest("hex");
          const prefixSha256 = computeSha256(partialBytes);

          await reader.cancel(
            new Error(`Response body size exceeded maximum limit of ${maxBytes} bytes.`),
          );

          throw new ResponseTooLargeError(
            `Response body size exceeded maximum limit of ${maxBytes} bytes (observed ${totalObservedBytes} bytes, retained prefix of ${partialBytes.length} bytes).`,
            partialBytes,
            totalObservedBytes,
            incrementalWireSha256,
            prefixSha256,
          );
        }
      }
    }

    const fullBuffer = Buffer.concat(retainedChunks);
    const incrementalWireSha256 = wireHasher.digest("hex");
    return {
      bytes: fullBuffer,
      totalObservedBytes,
      incrementalWireSha256,
    };
  } catch (err) {
    try {
      await reader.cancel(err);
    } catch {
      // ignore
    }
    throw err;
  } finally {
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
    reader.releaseLock();
  }
}

export interface HttpTransportResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Record<string, string>;
  readonly readBodyBytes: (
    maxBytes: number,
    signal?: AbortSignal,
  ) => Promise<HttpTransportBodyResult | Buffer>;
  readonly cancelBody?: (reason?: unknown) => Promise<void>;
}

export type HttpTransport = (
  url: string,
  options: {
    readonly method: "GET";
    readonly headers: Record<string, string>;
    readonly signal?: AbortSignal;
  },
) => Promise<HttpTransportResponse>;

/**
 * Converts a standard Web API fetch Response into an HttpTransportResponse with streaming reader and cancelBody.
 */
export function createTransportResponseFromFetchResponse(resp: Response): HttpTransportResponse {
  return {
    status: resp.status,
    statusText: resp.statusText,
    headers: Object.fromEntries(resp.headers.entries()),
    cancelBody: async (reason?: unknown) => {
      if (resp.body && !resp.body.locked) {
        try {
          await resp.body.cancel(reason);
        } catch {
          // ignore
        }
      }
    },
    readBodyBytes: async (maxBytes: number, signal?: AbortSignal) => {
      if (!resp.body) {
        return {
          bytes: Buffer.alloc(0),
          totalObservedBytes: 0,
          incrementalWireSha256: computeSha256(Buffer.alloc(0)),
        };
      }
      return readStreamWithLimit(resp.body, maxBytes, signal);
    },
  };
}

/**
 * Production fetch transport wrapping global fetch with manual redirect rejection and streaming body reader.
 */
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
  return createTransportResponseFromFetchResponse(resp);
};

export interface BundlerCaptureConfig {
  readonly mint: string;
  readonly isLive?: boolean | undefined; // default: false (dry-run)
  readonly apiKey?: string | undefined; // Optional explicit key (defaults to process.env.SOLANA_TRACKER_API_KEY in live mode)
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
  readonly entriesDigestSha256: string; // SHA-256 of sorted 'filename:sha256\n' lines
  readonly manifestFileSha256: string; // Actual SHA-256 of the sealed capture-manifest.json file on disk
}

export interface BundlerCaptureMetadata {
  readonly requestedMint: string;
  readonly providerUrl: string;
  readonly httpStatus: number | null;
  readonly localRequestTimeIso: string;
  readonly localResponseTimeIso: string | null;
  readonly localRetrievedAtMs: number;
  readonly executionDurationMs: number;
  readonly receivedBytesCount: number; // Observed wire bytes read from transport
  readonly retainedBytesCount: number; // Bounded prefix bytes retained on disk (<= maxResponseSizeBytes)
  readonly receivedWireSha256: string | null; // Incremental digest across all observed bytes
  readonly retainedPrefixSha256: string | null; // Digest of bounded retained prefix bytes
  readonly wasRedacted: boolean;
  readonly savedEvidenceSha256: string;
  readonly isTruncated: boolean;
  readonly isUtf8Valid: boolean;
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
  readonly plannedDestinationDir: string;
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
 * Resolves project root directory by traversing upwards to find the top-level package.json.
 */
export function resolveProjectRoot(): string {
  let current = process.cwd();
  for (let i = 0; i < 5; i++) {
    const pkgPath = path.join(current, "package.json");
    if (fsSync.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fsSync.readFileSync(pkgPath, "utf8")) as { name?: string };
        if (pkg.name === "nexustrade-otis") {
          return current;
        }
      } catch {
        // ignore
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

/**
 * Builds a regex that matches a secret string where characters may be plain or unicode-escaped (e.g. \u0061).
 */
export function buildEscapedSecretRegex(secret: string): RegExp {
  const charPatterns = Array.from(secret).map((char) => {
    const code = char.charCodeAt(0);
    const hexLower = code.toString(16).padStart(4, "0").toLowerCase();
    const hexUpper = hexLower.toUpperCase();
    const escapedChar = char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return `(?:${escapedChar}|\\\\u00(?:${hexLower.slice(2)}|${hexUpper.slice(2)}))`;
  });
  return new RegExp(charPatterns.join(""), "gi");
}

/**
 * Detects whether an object property key represents a sensitive credential field
 * (e.g. apiKey, token, clientSecret, password, privateKey, auth, authorization).
 */
export function isSensitiveKeyName(key: string): boolean {
  if (!key) return false;
  const tokens = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return false;

  // 1. First, check if ANY credential/secret-bearing token exists anywhere in the key
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (
      t === "secret" ||
      t === "password" ||
      t === "passwd" ||
      t === "pwd" ||
      t === "credential" ||
      t === "credentials" ||
      t === "apikey" ||
      t === "privkey" ||
      t === "auth" ||
      t === "authorization" ||
      t === "bearer"
    ) {
      return true;
    }
    if (t === "api" && i + 1 < tokens.length && tokens[i + 1] === "key") {
      return true;
    }
    if (t === "private" && i + 1 < tokens.length && tokens[i + 1] === "key") {
      return true;
    }
    if (t === "access" && i + 1 < tokens.length && tokens[i + 1] === "key") {
      return true;
    }
    if (
      (t === "access" || t === "auth" || t === "session" || t === "jwt" || t === "refresh") &&
      i + 1 < tokens.length &&
      tokens[i + 1] === "token"
    ) {
      return true;
    }
  }

  // 2. Exact recognized public Solana / SPL token domain fields (without credential keywords)
  const EXACT_PUBLIC_TOKEN_KEYS = new Set([
    "tokenmint",
    "candidatetokenmint",
    "quotetokenmint",
    "basemint",
    "quotemint",
    "tokenaddress",
    "basetoken",
    "quotetoken",
    "tokenmeta",
    "tokenamount",
    "tokenaccount",
    "tokenprogram",
    "tokendecimals",
    "pretokenbalances",
    "posttokenbalances",
    "tokens",
  ]);

  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (EXACT_PUBLIC_TOKEN_KEYS.has(normalized)) {
    return false;
  }

  // 3. Any remaining standalone or auth-associated 'token' is sensitive
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "token") {
      return true;
    }
  }

  return false;
}

/**
 * Sanitizes plain text by redacting secret keys, unicode-escaped keys, and standard auth headers.
 */
export function redactSensitiveText(text: string, secrets: readonly string[] = []): string {
  if (!text) return "";
  let out = text;

  for (const s of secrets) {
    if (s && s.length >= 4) {
      // 1. Literal replacement
      out = out.split(s).join("[REDACTED]");

      // 2. Unicode-escaped replacement (e.g. \u0061\u0070\u0069...)
      try {
        const regex = buildEscapedSecretRegex(s);
        out = out.replace(regex, "[REDACTED]");
      } catch {
        // Ignore regex construction errors on unusual input
      }
    }
  }

  // 3. Standard credential pattern replacements
  out = out.replace(
    /([?&])(api[-_]?key|token|secret|password|auth)=([^&\s'"]+)/gi,
    "$1$2=[REDACTED]",
  );
  out = out.replace(
    /(^|\s)(api[-_]?key|token|secret|password|auth)=([^&\s'"]+)/gi,
    "$1$2=[REDACTED]",
  );
  out = out.replace(
    /(['"]?)(api[-_]?key|apikey|token|secret|client[-_]?secret|password|passwd|pwd|auth|authorization|x-api-key)(['"]?\s*:\s*['"]?)([^"',\s}]+)(['"]?)/gi,
    "$1$2$3[REDACTED]$5",
  );
  out = out.replace(
    /(api[-_]?key|token|secret|password|auth|x-api-key):\s*['"]?([^&\s'"]+)['"]?/gi,
    "$1:[REDACTED]",
  );
  out = out.replace(/([a-zA-Z0-9]+:\/\/)([^:]+):([^@]+)@/g, "$1[REDACTED]:[REDACTED]@");
  return out;
}

/**
 * Recursively walks and deeply redacts sensitive strings and sensitive keys in any JSON-compatible object tree.
 */
export function deepRedactSensitiveObject<T>(value: T, secrets: readonly string[] = []): T {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return redactSensitiveText(value, secrets) as unknown as T;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepRedactSensitiveObject(item, secrets)) as unknown as T;
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKeyName(k)) {
        result[k] = "[REDACTED]";
      } else {
        const sanitizedKey = redactSensitiveText(k, secrets);
        result[sanitizedKey] = deepRedactSensitiveObject(v, secrets);
      }
    }
    return result as T;
  }
  return value;
}

/**
 * Builds and seals a cryptographic manifest for the capture directory.
 */
function sealCaptureManifest(
  targetDir: string,
  requestedMint: string,
  createdAtIso: string,
): CaptureManifest {
  const fileNames = fsSync
    .readdirSync(targetDir)
    .filter((f) => f !== "capture-manifest.json" && !f.startsWith("."));
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
  const entriesDigestSha256 = computeSha256(manifestPayload);

  // Write capture-manifest.json to disk (exclusive creation)
  const manifestPath = path.join(targetDir, "capture-manifest.json");
  const manifestDataOnDisk = {
    manifestVersion: "1.0",
    capturedAtIso: createdAtIso,
    requestedMint,
    totalFiles: entries.length,
    totalBytes,
    files: entries,
    entriesDigestSha256,
  };

  fsSync.writeFileSync(manifestPath, JSON.stringify(manifestDataOnDisk, null, 2), {
    encoding: "utf8",
    flag: "wx",
  });

  // Calculate actual written manifest file SHA-256
  const writtenManifestBytes = fsSync.readFileSync(manifestPath);
  const manifestFileSha256 = computeSha256(writtenManifestBytes);

  return {
    manifestVersion: "1.0",
    capturedAtIso: createdAtIso,
    requestedMint,
    totalFiles: entries.length,
    totalBytes,
    files: entries,
    entriesDigestSha256,
    manifestFileSha256,
  };
}

/**
 * Safely cancels and aborts an unread or rejected HTTP response body, bounded by the capture deadline.
 */
async function cleanupUnreadBody(
  response: HttpTransportResponse | undefined,
  abortController: AbortController,
  deadlinePromise: Promise<never>,
): Promise<void> {
  if (!abortController.signal.aborted) {
    try {
      abortController.abort(new Error("Capture terminated early; connection aborted"));
    } catch {
      // ignore
    }
  }

  if (response && typeof response.cancelBody === "function") {
    try {
      await Promise.race([
        response.cancelBody(new Error("Capture terminated early; unread body discarded")),
        deadlinePromise,
      ]);
    } catch {
      // ignore
    }
  }
}

/**
 * Executes a bounded one-shot bundler capture for an explicitly selected mint.
 */
export async function captureSolanaTrackerBundlers(
  config: BundlerCaptureConfig,
): Promise<BundlerCaptureResult> {
  const clock = config.clock ?? (() => Date.now());
  const isLive = config.isLive === true;

  // 1. Validate requested mint (canonical Solana base58)
  if (!config.mint || typeof config.mint !== "string" || !isCanonicalSolanaBase58(config.mint)) {
    return {
      success: false,
      dryRun: !isLive,
      status: "INVALID_INPUT",
      message: `Invalid token mint: '${config.mint}'. Must be a canonical 32-byte Solana base58 address.`,
    };
  }
  const mint = config.mint;

  // 2. Validate configuration limits (safe positive integers within hard ceilings)
  const timeoutMs = config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_REQUEST_TIMEOUT_MS
  ) {
    return {
      success: false,
      dryRun: !isLive,
      status: "INVALID_INPUT",
      message: `Invalid timeoutMs: '${config.timeoutMs}'. Must be a safe positive integer between 1 and ${MAX_REQUEST_TIMEOUT_MS} ms.`,
    };
  }

  const maxResponseSizeBytes = config.maxResponseSizeBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (
    typeof maxResponseSizeBytes !== "number" ||
    !Number.isSafeInteger(maxResponseSizeBytes) ||
    maxResponseSizeBytes <= 0 ||
    maxResponseSizeBytes > MAX_ALLOWED_RESPONSE_BYTES
  ) {
    return {
      success: false,
      dryRun: !isLive,
      status: "INVALID_INPUT",
      message: `Invalid maxResponseSizeBytes: '${config.maxResponseSizeBytes}'. Must be between 1 and ${MAX_ALLOWED_RESPONSE_BYTES} bytes.`,
    };
  }

  // Fixed HTTPS endpoint origin (no production URL override)
  const providerUrl = `${SOLANA_TRACKER_DATA_API_BASE_URL}/tokens/${mint}/bundlers`;

  // Determine exact absolute destination directory
  const localRequestTimeMs = clock();
  const localRequestTimeIso = new Date(localRequestTimeMs).toISOString();
  const defaultDirName = `${localRequestTimeIso.replace(/[:.]/g, "-")}_${mint}`;
  const targetDir = config.outDir
    ? path.resolve(config.outDir)
    : path.resolve(
        resolveProjectRoot(),
        "data/research/captures/solana-tracker-bundler",
        defaultDirName,
      );

  // 3. Initialize or reuse GlobalResourceBudgetManager
  const budget = config.budget ?? createStandaloneOneRequestBudget(clock);

  // 4. DRY-RUN MODE: Zero network requests dispatched, no API key required
  if (!isLive) {
    return {
      success: true,
      dryRun: true,
      status: "DRY_RUN",
      mint,
      plannedUrl: providerUrl,
      plannedDestinationDir: targetDir,
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
  loadLocalEnvFile();
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

  // 7. Atomic Pre-dispatch Destination Reservation (Exclusively create target directory before network call)
  try {
    fsSync.mkdirSync(path.dirname(targetDir), { recursive: true });
    fsSync.mkdirSync(targetDir, { recursive: false });
  } catch {
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
    // Clean up reserved directory if budget recording fails
    try {
      fsSync.rmdirSync(targetDir);
    } catch {
      // ignore
    }
    return {
      success: false,
      dryRun: false,
      status: "BUDGET_DENIED",
      message: "Failed to record single request attempt in budget manager.",
    };
  }

  // 9. Prepare HTTP transport and deadline management
  const transport = config.transport ?? defaultFetchTransport;
  const abortController = new AbortController();
  const deadlineMs = localRequestTimeMs + timeoutMs;
  let isTimedOut = false;
  let timeoutHandle: NodeJS.Timeout | null = null;

  // Deadline promise kept active through full request + body read lifecycle
  const deadlinePromise = new Promise<never>((_, reject) => {
    const delay = Math.max(0, deadlineMs - clock());
    timeoutHandle = setTimeout(() => {
      isTimedOut = true;
      abortController.abort(new Error(`Request timed out after ${timeoutMs} ms`));
      const err = new Error(`Request timed out after ${timeoutMs} ms`);
      err.name = "TimeoutError";
      reject(err);
    }, delay);
  });

  const raceWithDeadline = async <T>(operation: Promise<T>): Promise<T> => {
    return Promise.race([operation, deadlinePromise]);
  };

  let response: HttpTransportResponse | undefined;
  let rawWireBytes: Buffer = Buffer.alloc(0);
  let totalObservedBytes = 0;
  let incrementalWireSha256: string | null = null;
  let httpStatus: number | null = null;
  let localResponseTimeMs: number | null = null;
  let localResponseTimeIso: string | null = null;
  let captureStatus: BundlerCaptureStatus = "SUCCESS";
  let errorMessage: string | null = null;
  let isTruncated = false;

  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "x-api-key": apiKey,
    };

    // Race header acquisition against deadline
    response = await raceWithDeadline(
      transport(providerUrl, {
        method: "GET",
        headers,
        signal: abortController.signal,
      }),
    );

    // Verify deadline has not elapsed while awaiting transport
    if (clock() >= deadlineMs || isTimedOut) {
      const err = new Error(`Request timed out after ${timeoutMs} ms`);
      err.name = "TimeoutError";
      throw err;
    }

    httpStatus = response.status;
    budget.recordResponseStatus(httpStatus);

    // Reject HTTP redirects immediately without following
    if (httpStatus >= 300 && httpStatus < 400) {
      captureStatus = "REDIRECT_REJECTED";
      const sanitizedStatusText = redactSensitiveText(response.statusText ?? "", secretsToRedact);
      errorMessage =
        `HTTP redirects are strictly prohibited. Received status: ${httpStatus} ${sanitizedStatusText}`.trim();
      await cleanupUnreadBody(response, abortController, deadlinePromise);
    } else {
      // Check Content-Length header against max size before reading body
      const contentLengthHeader = response.headers["content-length"];
      if (contentLengthHeader) {
        const contentLength = parseInt(contentLengthHeader, 10);
        if (Number.isFinite(contentLength) && contentLength > maxResponseSizeBytes) {
          captureStatus = "RESPONSE_TOO_LARGE";
          errorMessage = `Response Content-Length (${contentLength} bytes) exceeds limit of ${maxResponseSizeBytes} bytes.`;
          isTruncated = true;
          await cleanupUnreadBody(response, abortController, deadlinePromise);
        }
      }

      if (captureStatus === "SUCCESS") {
        // Race streaming body read against deadline with byte-level limit
        try {
          const bodyResult = await raceWithDeadline(
            response.readBodyBytes(maxResponseSizeBytes, abortController.signal),
          );
          if (Buffer.isBuffer(bodyResult)) {
            rawWireBytes = bodyResult;
            totalObservedBytes = bodyResult.length;
            incrementalWireSha256 = computeSha256(bodyResult);
          } else {
            rawWireBytes = bodyResult.bytes;
            totalObservedBytes = bodyResult.totalObservedBytes;
            incrementalWireSha256 = bodyResult.incrementalWireSha256;
          }
        } catch (readErr: unknown) {
          await cleanupUnreadBody(response, abortController, deadlinePromise);
          throw readErr;
        }

        if (clock() >= deadlineMs || isTimedOut) {
          const err = new Error(`Request timed out after ${timeoutMs} ms`);
          err.name = "TimeoutError";
          throw err;
        }

        if (httpStatus !== 200) {
          captureStatus = "HTTP_ERROR";
          const sanitizedStatusText = redactSensitiveText(
            response.statusText ?? "",
            secretsToRedact,
          );
          errorMessage =
            `Provider returned non-200 HTTP status: ${httpStatus} ${sanitizedStatusText}`.trim();
        }
      }
    }

    localResponseTimeMs = clock();
    localResponseTimeIso = new Date(localResponseTimeMs).toISOString();
  } catch (err: unknown) {
    localResponseTimeMs = clock();
    localResponseTimeIso = new Date(localResponseTimeMs).toISOString();

    const errName = err instanceof Error ? err.name : "";
    if (isTimedOut || errName === "TimeoutError" || errName === "AbortError") {
      captureStatus = "TIMEOUT";
      errorMessage = `Request timed out after ${timeoutMs} ms.`;
      isTruncated = true;
    } else if (errName === "ResponseTooLargeError") {
      captureStatus = "RESPONSE_TOO_LARGE";
      isTruncated = true;
      if (err instanceof ResponseTooLargeError) {
        rawWireBytes = err.partialBytes;
        totalObservedBytes = err.totalBytesRead;
        incrementalWireSha256 = err.incrementalWireSha256;
      } else if (
        err &&
        typeof err === "object" &&
        "partialBytes" in err &&
        Buffer.isBuffer((err as { partialBytes: unknown }).partialBytes)
      ) {
        const customErr = err as {
          partialBytes: Buffer;
          totalBytesRead?: number;
          incrementalWireSha256?: string;
        };
        rawWireBytes = customErr.partialBytes;
        totalObservedBytes = customErr.totalBytesRead ?? rawWireBytes.length;
        incrementalWireSha256 = customErr.incrementalWireSha256 ?? computeSha256(rawWireBytes);
      }
      const rawMsg = err instanceof Error ? err.message : String(err);
      errorMessage = redactSensitiveText(rawMsg, secretsToRedact);
    } else {
      captureStatus = "NETWORK_ERROR";
      const rawMsg = err instanceof Error ? err.message : String(err);
      errorMessage = redactSensitiveText(rawMsg, secretsToRedact);
    }
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }

  // 10. Compute received byte count, retained prefix count, and digests
  const retainedBytesCount = rawWireBytes.length;
  const receivedBytesCount = totalObservedBytes;

  const receivedWireSha256: string | null =
    totalObservedBytes > 0
      ? (incrementalWireSha256 ?? computeSha256(rawWireBytes))
      : captureStatus === "SUCCESS"
        ? computeSha256(rawWireBytes)
        : null;

  const retainedPrefixSha256: string | null =
    retainedBytesCount > 0
      ? computeSha256(rawWireBytes)
      : captureStatus === "SUCCESS"
        ? computeSha256(rawWireBytes)
        : null;

  // 11. Decode text and redact response body before saving to disk
  let rawWireText = "";
  let isUtf8Valid = true;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    rawWireText = decoder.decode(rawWireBytes);
  } catch {
    isUtf8Valid = false;
    rawWireText = rawWireBytes.toString("latin1"); // Safe fallback for writing sanitized representation
    if (captureStatus === "SUCCESS") {
      captureStatus = "PARSE_ERROR";
      errorMessage = "Response body is not valid UTF-8 text.";
    }
  }

  // Sanitize response body:
  // If valid JSON, deeply sanitize all string fields and serialize back (eliminating unicode escapes)
  let sanitizedResponseBody = "";
  let parsedJsonValue: unknown = undefined;
  let isJson = false;
  let wasRedacted = false;

  try {
    parsedJsonValue = JSON.parse(rawWireText);
    isJson = true;
    const sanitizedObj = deepRedactSensitiveObject(parsedJsonValue, secretsToRedact);
    sanitizedResponseBody = JSON.stringify(sanitizedObj, null, 2);
    sanitizedResponseBody = redactSensitiveText(sanitizedResponseBody, secretsToRedact);

    // Track actual redaction separately from serialization formatting
    const unredactedCanonical = JSON.stringify(parsedJsonValue, null, 2);
    wasRedacted = unredactedCanonical !== sanitizedResponseBody;
  } catch {
    // Non-JSON response text: redact directly
    sanitizedResponseBody = redactSensitiveText(rawWireText, secretsToRedact);
    wasRedacted = rawWireText !== sanitizedResponseBody;
  }

  const savedEvidenceSha256 = computeSha256(sanitizedResponseBody);

  // 12. Parse response through SolanaTrackerBundlerParser (if 200 OK and valid JSON)
  let parserResult: SolanaTrackerBundlerParseResult | undefined;
  if (captureStatus === "SUCCESS" && httpStatus === 200) {
    if (isJson) {
      parserResult = parseSolanaTrackerBundlersResponse(parsedJsonValue, {
        requestedMint: mint,
        localRetrievedAtMs: localResponseTimeMs ?? localRequestTimeMs,
      });

      if (!parserResult.success) {
        captureStatus = "PARSE_ERROR";
        errorMessage = `Parser failed validation with error [${parserResult.error}]: ${parserResult.message}`;
      }
    } else {
      captureStatus = "PARSE_ERROR";
      errorMessage = "Response payload is not valid JSON.";
      parserResult = {
        success: false,
        error: "MALFORMED_PAYLOAD",
        message: errorMessage,
      };
    }
  }

  // Deeply redact parser result object before persisting and returning
  const sanitizedParserResult: SolanaTrackerBundlerParseResult | undefined = parserResult
    ? deepRedactSensitiveObject(parserResult, secretsToRedact)
    : undefined;

  const sanitizedErrorMessage = errorMessage
    ? redactSensitiveText(errorMessage, secretsToRedact)
    : null;

  // 13. Write sanitized-response.json into exclusively reserved destination directory
  fsSync.writeFileSync(path.join(targetDir, "sanitized-response.json"), sanitizedResponseBody, {
    encoding: "utf8",
    flag: "wx",
  });

  // 14. Write parser-result.json if present
  if (sanitizedParserResult) {
    fsSync.writeFileSync(
      path.join(targetDir, "parser-result.json"),
      JSON.stringify(sanitizedParserResult, null, 2),
      { encoding: "utf8", flag: "wx" },
    );
  }

  // 15. Write capture-metadata.json BEFORE sealing manifest to avoid circular hash dependency
  const metadata: BundlerCaptureMetadata = {
    requestedMint: mint,
    providerUrl,
    httpStatus,
    localRequestTimeIso,
    localResponseTimeIso,
    localRetrievedAtMs: localResponseTimeMs ?? localRequestTimeMs,
    executionDurationMs: (localResponseTimeMs ?? clock()) - localRequestTimeMs,
    receivedBytesCount,
    retainedBytesCount,
    receivedWireSha256,
    retainedPrefixSha256,
    wasRedacted,
    savedEvidenceSha256,
    isTruncated,
    isUtf8Valid,
    status: captureStatus,
    errorMessage: sanitizedErrorMessage,
    disclaimer:
      "PROVIDER_REPORTED_UNVERIFIED: Capture does not establish provider accuracy, complete launch history, strategy eligibility, or production trade-flow completeness. Gate 11 remains fail-closed.",
  };

  fsSync.writeFileSync(
    path.join(targetDir, "capture-metadata.json"),
    JSON.stringify(metadata, null, 2),
    { encoding: "utf8", flag: "wx" },
  );

  // 16. Seal manifest with file hashes (covers sanitized-response.json, capture-metadata.json, and parser-result.json)
  const manifest = sealCaptureManifest(targetDir, mint, localRequestTimeIso);

  if (captureStatus === "SUCCESS" && sanitizedParserResult?.success) {
    const successResult: BundlerCaptureSuccessResult = {
      success: true,
      dryRun: false,
      status: "SUCCESS",
      targetDir,
      metadata,
      parserResult: sanitizedParserResult,
      manifest,
    };
    return deepRedactSensitiveObject(successResult, secretsToRedact);
  }

  const failureResult: BundlerCaptureFailureResult = {
    success: false,
    dryRun: false,
    status: captureStatus,
    message: sanitizedErrorMessage ?? `Capture failed with status: ${captureStatus}`,
    targetDir,
    metadata,
    parserResult: sanitizedParserResult,
    manifest,
  };
  return deepRedactSensitiveObject(failureResult, secretsToRedact);
}

/**
 * Parses and strictly validates CLI arguments for the bundler capture tool.
 * Rejects malformed, missing, conflicting, duplicate, and unknown arguments.
 */
export function parseBundlerCaptureArgs(args: readonly string[]): {
  readonly mint?: string | undefined;
  readonly isLive: boolean;
  readonly outDir?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxResponseSizeBytes?: number | undefined;
  readonly help: boolean;
} {
  const seenFlags = new Set<string>();
  let mint: string | undefined;
  let isLive: boolean | undefined;
  let outDir: string | undefined;
  let timeoutMs: number | undefined;
  let maxResponseSizeBytes: number | undefined;
  let help = false;

  const validFlagsWithValues = new Set(["--mint", "--out-dir", "--timeout-ms", "--max-bytes"]);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (!arg.startsWith("-")) {
      throw new Error(`Unexpected positional argument: '${arg}'. Options must begin with a flag.`);
    }

    if (seenFlags.has(arg)) {
      throw new Error(`Duplicate argument: '${arg}'. Each option may only be specified once.`);
    }
    seenFlags.add(arg);

    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }

    if (arg === "--live") {
      if (seenFlags.has("--dry-run")) {
        throw new Error("Conflicting flags: cannot specify both --live and --dry-run.");
      }
      isLive = true;
      continue;
    }

    if (arg === "--dry-run") {
      if (seenFlags.has("--live")) {
        throw new Error("Conflicting flags: cannot specify both --live and --dry-run.");
      }
      isLive = false;
      continue;
    }

    if (!validFlagsWithValues.has(arg)) {
      throw new Error(`Unknown argument: '${arg}'. Run with --help for valid options.`);
    }

    // Argument requires a value
    if (i + 1 >= args.length) {
      throw new Error(`Missing required value for '${arg}'.`);
    }

    const value = args[++i]!;
    if (value.startsWith("-") && value !== "-") {
      throw new Error(`Missing required value for '${arg}'. Found flag '${value}' instead.`);
    }

    if (arg === "--mint") {
      mint = value;
    } else if (arg === "--out-dir") {
      if (value.trim().length === 0) {
        throw new Error("Value for --out-dir cannot be empty.");
      }
      outDir = value;
    } else if (arg === "--timeout-ms") {
      if (!/^\d+$/.test(value)) {
        throw new Error(
          `Invalid integer value for --timeout-ms: '${value}'. Must be a positive safe integer.`,
        );
      }
      const num = Number(value);
      if (num <= 0 || num > MAX_REQUEST_TIMEOUT_MS) {
        throw new Error(
          `Invalid --timeout-ms value: ${num}. Must be between 1 and ${MAX_REQUEST_TIMEOUT_MS} ms.`,
        );
      }
      timeoutMs = num;
    } else if (arg === "--max-bytes") {
      if (!/^\d+$/.test(value)) {
        throw new Error(
          `Invalid integer value for --max-bytes: '${value}'. Must be a positive safe integer.`,
        );
      }
      const num = Number(value);
      if (num <= 0 || num > MAX_ALLOWED_RESPONSE_BYTES) {
        throw new Error(
          `Invalid --max-bytes value: ${num}. Must be between 1 and ${MAX_ALLOWED_RESPONSE_BYTES} bytes.`,
        );
      }
      maxResponseSizeBytes = num;
    }
  }

  return {
    mint,
    isLive: isLive ?? false, // Defaults to dry-run
    outDir,
    timeoutMs,
    maxResponseSizeBytes,
    help,
  };
}
