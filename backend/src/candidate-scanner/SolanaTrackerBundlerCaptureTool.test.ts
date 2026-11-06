import { describe, expect, it } from "vitest";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  captureSolanaTrackerBundlers,
  computeSha256,
  createStandaloneOneRequestBudget,
  createTransportResponseFromFetchResponse,
  parseBundlerCaptureArgs,
  SOLANA_TRACKER_DATA_API_BASE_URL,
  type HttpTransport,
  type HttpTransportResponse,
} from "./SolanaTrackerBundlerCaptureTool.js";
import { GlobalResourceBudgetManager } from "../research/prospective/GlobalResourceBudgetManager.js";

const CANONICAL_MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const CANONICAL_WALLET_1 = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const CANONICAL_WALLET_2 = "So11111111111111111111111111111111111111112";
const FAKE_API_KEY = "test-secret-api-key-998877";

function createValidBundlerPayload() {
  return {
    total: 2,
    balance: 5000000,
    percentage: 5.0,
    initialBalance: 20000000,
    initialPercentage: 20.0,
    wallets: [
      {
        wallet: CANONICAL_WALLET_1,
        balance: 2500000,
        percentage: 2.5,
        initialBalance: 10000000,
        initialPercentage: 10.0,
        bundleTime: 1712345678000,
      },
      {
        wallet: CANONICAL_WALLET_2,
        balance: 2500000,
        percentage: 2.5,
        initialBalance: 10000000,
        initialPercentage: 10.0,
        bundleTime: 1712345679000,
      },
    ],
  };
}

/**
 * Creates a streaming body reader from a buffer with optional chunking and delays.
 */
function createStreamingBodyReader(
  buffer: Buffer,
  options: {
    chunkSize?: number;
    delayBetweenChunksMs?: number;
    onBytesConsumed?: (n: number) => void;
  } = {},
): (maxBytes: number, signal?: AbortSignal) => Promise<Buffer> {
  const chunkSize = options.chunkSize ?? 64;
  const delayMs = options.delayBetweenChunksMs ?? 0;

  return async (maxBytes: number, signal?: AbortSignal) => {
    let offset = 0;
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    while (offset < buffer.length) {
      if (signal?.aborted) {
        const err = new Error("Operation aborted");
        err.name = "AbortError";
        throw err;
      }

      const nextChunkSize = Math.min(chunkSize, buffer.length - offset);
      const chunk = buffer.subarray(offset, offset + nextChunkSize);
      offset += nextChunkSize;
      totalBytes += chunk.length;
      options.onBytesConsumed?.(totalBytes);

      if (totalBytes > maxBytes) {
        const err = new Error(
          `Response body size exceeded maximum limit of ${maxBytes} bytes (read ${totalBytes} bytes).`,
        );
        err.name = "ResponseTooLargeError";
        throw err;
      }

      chunks.push(chunk);

      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    return Buffer.concat(chunks);
  };
}

function createFakeTransport(
  handler: (
    url: string,
    options: {
      readonly method: "GET";
      readonly headers: Record<string, string>;
      readonly signal?: AbortSignal;
    },
  ) => Promise<HttpTransportResponse> | HttpTransportResponse,
): HttpTransport {
  return async (url, options) => handler(url, options);
}

function getTempTestDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `solana-tracker-test-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
  );
  return dir;
}

describe("SolanaTrackerBundlerCaptureTool", () => {
  describe("Defect 1: Full Request Deadline & Streaming Byte Limit", () => {
    it("enforces deadline through body reading: 10 ms timeout with 80 ms body delay fails with TIMEOUT", async () => {
      const payloadBuf = Buffer.from(JSON.stringify(createValidBundlerPayload()), "utf8");

      const transport = createFakeTransport(() => ({
        status: 200,
        statusText: "OK",
        headers: {},
        readBodyBytes: createStreamingBodyReader(payloadBuf, {
          chunkSize: 10,
          delayBetweenChunksMs: 30, // 30ms * multiple chunks > 10ms timeout
        }),
      }));

      const outDir = getTempTestDir();
      try {
        const result = await captureSolanaTrackerBundlers({
          mint: CANONICAL_MINT,
          isLive: true,
          apiKey: FAKE_API_KEY,
          timeoutMs: 10, // 10ms deadline
          outDir,
          transport,
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.status).toBe("TIMEOUT");
          expect(result.metadata?.isTruncated).toBe(true);
        }
      } finally {
        fsSync.rmSync(outDir, { recursive: true, force: true });
      }
    });

    it("discards late completions when transport ignores abort signal", async () => {
      // Simulates an unruly transport that ignores signal.abort and resolves after deadline
      const transport = createFakeTransport(async () => {
        await new Promise((r) => setTimeout(r, 60)); // Delays 60ms ignoring abort
        return {
          status: 200,
          statusText: "OK",
          headers: {},
          readBodyBytes: async () => Buffer.from(JSON.stringify(createValidBundlerPayload())),
        };
      });

      const outDir = getTempTestDir();
      try {
        const result = await captureSolanaTrackerBundlers({
          mint: CANONICAL_MINT,
          isLive: true,
          apiKey: FAKE_API_KEY,
          timeoutMs: 15, // 15ms deadline
          outDir,
          transport,
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.status).toBe("TIMEOUT");
        }
      } finally {
        fsSync.rmSync(outDir, { recursive: true, force: true });
      }
    });

    it("enforces streaming byte limit without consuming full response: 16-byte limit stops reading after overflow", async () => {
      const largePayload = Buffer.alloc(320, 0x61); // 320 bytes
      let bytesConsumed = 0;

      const transport = createFakeTransport(() => ({
        status: 200,
        statusText: "OK",
        headers: {},
        readBodyBytes: createStreamingBodyReader(largePayload, {
          chunkSize: 10,
          onBytesConsumed: (n) => {
            bytesConsumed = n;
          },
        }),
      }));

      const outDir = getTempTestDir();
      try {
        const result = await captureSolanaTrackerBundlers({
          mint: CANONICAL_MINT,
          isLive: true,
          apiKey: FAKE_API_KEY,
          maxResponseSizeBytes: 16, // 16-byte ceiling
          outDir,
          transport,
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.status).toBe("RESPONSE_TOO_LARGE");
          expect(result.metadata?.isTruncated).toBe(true);
        }
        // Verified reading aborted on overflow; did not consume all 320 bytes
        expect(bytesConsumed).toBeLessThan(320);
      } finally {
        fsSync.rmSync(outDir, { recursive: true, force: true });
      }
    });

    it("computes received digest and byte count directly from raw bytes before text decoding (handles invalid UTF-8)", async () => {
      // 3-byte invalid UTF-8 sequence
      const invalidUtf8Bytes = Buffer.from([0xff, 0xfe, 0xfd]);

      const transport = createFakeTransport(() => ({
        status: 200,
        statusText: "OK",
        headers: {},
        readBodyBytes: async () => invalidUtf8Bytes,
      }));

      const outDir = getTempTestDir();
      try {
        const result = await captureSolanaTrackerBundlers({
          mint: CANONICAL_MINT,
          isLive: true,
          apiKey: FAKE_API_KEY,
          outDir,
          transport,
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.status).toBe("PARSE_ERROR");
          expect(result.metadata?.receivedBytesCount).toBe(3); // Exactly 3 bytes, not coerced to 7
          expect(result.metadata?.receivedWireSha256).toBe(computeSha256(invalidUtf8Bytes));
          expect(result.metadata?.isUtf8Valid).toBe(false);
        }
      } finally {
        fsSync.rmSync(outDir, { recursive: true, force: true });
      }
    });
  });

  describe("Defect 2: Comprehensive Credential Protection Across All Artifacts", () => {
    it("redacts unicode-escaped JSON credentials so key cannot be recovered by JSON.parse", async () => {
      // Create JSON where the fake API key is unicode-escaped: e.g. \u0074\u0065...
      const escapedKey = Array.from(FAKE_API_KEY)
        .map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))
        .join("");

      const rawJsonString = `{"status":"ok","secret":"${escapedKey}","wallets":[]}`;
      const rawJsonBuf = Buffer.from(rawJsonString, "utf8");

      const transport = createFakeTransport(() => ({
        status: 200,
        statusText: "OK",
        headers: {},
        readBodyBytes: async () => rawJsonBuf,
      }));

      const outDir = getTempTestDir();
      try {
        const result = await captureSolanaTrackerBundlers({
          mint: CANONICAL_MINT,
          isLive: true,
          apiKey: FAKE_API_KEY,
          outDir,
          transport,
        });

        // Check sanitized-response.json on disk
        const savedText = fsSync.readFileSync(path.join(outDir, "sanitized-response.json"), "utf8");
        expect(savedText).not.toContain(FAKE_API_KEY);
        expect(savedText).not.toContain(escapedKey);

        // Crucial test: Parsing the saved JSON must NOT recover the key
        const parsedSaved = JSON.parse(savedText);
        expect(parsedSaved.secret).toBe("[REDACTED]");
        expect(result.dryRun).toBe(false);
        if (!result.dryRun) {
          expect(result.metadata?.wasRedacted).toBe(true);
        }
      } finally {
        fsSync.rmSync(outDir, { recursive: true, force: true });
      }
    });

    it("redacts credentials appearing in valid parsed wallet fields from parser-result.json and return object", async () => {
      // Use a canonical Solana base58 address as the fake API key for this test
      // to ensure it survives parser schema validation before being redacted
      const base58ApiKey = "11111111111111111111111111111111";
      const payload = createValidBundlerPayload();
      // Inject fake key into a valid wallet field
      (payload.wallets[0] as Record<string, unknown>).wallet = base58ApiKey;

      const payloadBuf = Buffer.from(JSON.stringify(payload), "utf8");

      const transport = createFakeTransport(() => ({
        status: 200,
        statusText: "OK",
        headers: {},
        readBodyBytes: async () => payloadBuf,
      }));

      const outDir = getTempTestDir();
      try {
        const result = await captureSolanaTrackerBundlers({
          mint: CANONICAL_MINT,
          isLive: true,
          apiKey: base58ApiKey,
          outDir,
          transport,
        });

        // Check parser-result.json on disk
        const savedParserJson = fsSync.readFileSync(
          path.join(outDir, "parser-result.json"),
          "utf8",
        );
        expect(savedParserJson).not.toContain(base58ApiKey);
        expect(savedParserJson).toContain("[REDACTED]");

        // Check returned result object
        const stringifiedResult = JSON.stringify(result);
        expect(stringifiedResult).not.toContain(base58ApiKey);
      } finally {
        fsSync.rmSync(outDir, { recursive: true, force: true });
      }
    });

    it("strictly targets the fixed documented HTTPS origin without production URL override", async () => {
      let requestedUrl = "";
      const transport = createFakeTransport((url) => {
        requestedUrl = url;
        return {
          status: 200,
          statusText: "OK",
          headers: {},
          readBodyBytes: async () => Buffer.from(JSON.stringify(createValidBundlerPayload())),
        };
      });

      const outDir = getTempTestDir();
      try {
        await captureSolanaTrackerBundlers({
          mint: CANONICAL_MINT,
          isLive: true,
          apiKey: FAKE_API_KEY,
          outDir,
          transport,
        });

        expect(requestedUrl).toBe(
          `${SOLANA_TRACKER_DATA_API_BASE_URL}/tokens/${CANONICAL_MINT}/bundlers`,
        );
        expect(requestedUrl.startsWith("https://data.solanatracker.io/")).toBe(true);
      } finally {
        fsSync.rmSync(outDir, { recursive: true, force: true });
      }
    });
  });

  describe("Defect 3: Atomic Pre-dispatch Destination Reservation & Accurate Manifest Hashes", () => {
    it("fails competing concurrent captures pre-dispatch before any network call occurs", async () => {
      let callCount = 0;
      const transport = createFakeTransport(() => {
        callCount++;
        return {
          status: 200,
          statusText: "OK",
          headers: {},
          readBodyBytes: async () => Buffer.from(JSON.stringify(createValidBundlerPayload())),
        };
      });

      const sharedDir = getTempTestDir();
      try {
        // First capture creates the directory exclusively
        const p1 = captureSolanaTrackerBundlers({
          mint: CANONICAL_MINT,
          isLive: true,
          apiKey: FAKE_API_KEY,
          outDir: sharedDir,
          transport,
        });

        // Second competing capture targeting the exact same directory
        const p2 = captureSolanaTrackerBundlers({
          mint: CANONICAL_MINT,
          isLive: true,
          apiKey: FAKE_API_KEY,
          outDir: sharedDir,
          transport,
        });

        const [r1, r2] = await Promise.all([p1, p2]);

        // Exactly one capture must succeed and one must fail pre-dispatch with DESTINATION_ALREADY_EXISTS
        const succeeded = [r1, r2].filter((r) => r.success);
        const failed = [r1, r2].filter(
          (r) => !r.success && r.status === "DESTINATION_ALREADY_EXISTS",
        );

        expect(succeeded.length).toBe(1);
        expect(failed.length).toBe(1);
        // The failed capture must not have dispatched an extra network request
        expect(callCount).toBe(1);
      } finally {
        fsSync.rmSync(sharedDir, { recursive: true, force: true });
      }
    });

    it("accurately separates and labels entriesDigestSha256 and actual manifestFileSha256 and seals all evidence", async () => {
      const payloadBuf = Buffer.from(JSON.stringify(createValidBundlerPayload()), "utf8");
      const transport = createFakeTransport(() => ({
        status: 200,
        statusText: "OK",
        headers: {},
        readBodyBytes: async () => payloadBuf,
      }));

      const outDir = getTempTestDir();
      try {
        const result = await captureSolanaTrackerBundlers({
          mint: CANONICAL_MINT,
          isLive: true,
          apiKey: FAKE_API_KEY,
          outDir,
          transport,
        });

        expect(result.success).toBe(true);
        if (!result.success || result.dryRun) return;

        const manifestPath = path.join(outDir, "capture-manifest.json");
        const onDiskManifestBytes = fsSync.readFileSync(manifestPath);
        const actualFileHash = computeSha256(onDiskManifestBytes);

        // entriesDigestSha256 must match the internal entries digest
        expect(result.manifest.entriesDigestSha256).toBeDefined();
        expect(result.manifest.entriesDigestSha256.length).toBe(64);

        // manifestFileSha256 must match the actual file on disk
        expect(result.manifest.manifestFileSha256).toBe(actualFileHash);

        // The entries digest and the file hash must NOT be falsely equated
        expect(result.manifest.entriesDigestSha256).not.toBe(result.manifest.manifestFileSha256);

        // Correction 1: Manifest covers every intended evidence file
        const manifestFilenames = result.manifest.files.map((f) => f.filename).sort();
        expect(manifestFilenames).toEqual([
          "capture-metadata.json",
          "parser-result.json",
          "sanitized-response.json",
        ]);

        // Each recorded size and hash in manifest must match the final bytes on disk
        for (const fileEntry of result.manifest.files) {
          const filePath = path.join(outDir, fileEntry.filename);
          const onDiskBytes = fsSync.readFileSync(filePath);
          expect(onDiskBytes.length).toBe(fileEntry.byteSize);
          expect(computeSha256(onDiskBytes)).toBe(fileEntry.sha256);
        }

        // Circular dependency prevention: capture-metadata.json on disk does NOT contain back-reference hashes
        const savedMetaJson = fsSync.readFileSync(
          path.join(outDir, "capture-metadata.json"),
          "utf8",
        );
        const parsedMeta = JSON.parse(savedMetaJson);
        expect(parsedMeta.entriesDigestSha256).toBeUndefined();
        expect(parsedMeta.manifestFileSha256).toBeUndefined();
      } finally {
        fsSync.rmSync(outDir, { recursive: true, force: true });
      }
    });
  });

  describe("Defect 4: CLI Argument Validation & Strict Discipline", () => {
    it("rejects malformed integer values with trailing characters (e.g. 100junk)", () => {
      expect(() =>
        parseBundlerCaptureArgs(["--mint", CANONICAL_MINT, "--timeout-ms", "100junk"]),
      ).toThrow(/Invalid integer value for --timeout-ms/);
      expect(() =>
        parseBundlerCaptureArgs(["--mint", CANONICAL_MINT, "--max-bytes", "100junk"]),
      ).toThrow(/Invalid integer value for --max-bytes/);
    });

    it("rejects conflicting --live and --dry-run flags", () => {
      expect(() =>
        parseBundlerCaptureArgs(["--mint", CANONICAL_MINT, "--live", "--dry-run"]),
      ).toThrow(/Conflicting flags/);
      expect(() =>
        parseBundlerCaptureArgs(["--mint", CANONICAL_MINT, "--dry-run", "--live"]),
      ).toThrow(/Conflicting flags/);
    });

    it("rejects unknown arguments fail-closed", () => {
      expect(() => parseBundlerCaptureArgs(["--mint", CANONICAL_MINT, "--unknown-flag"])).toThrow(
        /Unknown argument: '--unknown-flag'/,
      );
    });

    it("rejects duplicate arguments fail-closed", () => {
      expect(() =>
        parseBundlerCaptureArgs(["--mint", CANONICAL_MINT, "--mint", CANONICAL_WALLET_2]),
      ).toThrow(/Duplicate argument/);
      expect(() => parseBundlerCaptureArgs(["--mint", CANONICAL_MINT, "--live", "--live"])).toThrow(
        /Duplicate argument/,
      );
    });

    it("rejects missing argument values", () => {
      expect(() => parseBundlerCaptureArgs(["--mint"])).toThrow(
        /Missing required value for '--mint'/,
      );
      expect(() => parseBundlerCaptureArgs(["--mint", CANONICAL_MINT, "--timeout-ms"])).toThrow(
        /Missing required value for '--timeout-ms'/,
      );
      expect(() =>
        parseBundlerCaptureArgs(["--mint", CANONICAL_MINT, "--timeout-ms", "--live"]),
      ).toThrow(/Found flag '--live' instead/);
    });

    it("rejects values exceeding documented hard ceilings", () => {
      expect(() =>
        parseBundlerCaptureArgs(["--mint", CANONICAL_MINT, "--timeout-ms", "16000"]),
      ).toThrow(/between 1 and 15000 ms/);
      expect(() =>
        parseBundlerCaptureArgs(["--mint", CANONICAL_MINT, "--max-bytes", "20000000"]),
      ).toThrow(/between 1 and 10485760 bytes/);
    });

    it("includes exact absolute destination in dry-run plan", async () => {
      const result = await captureSolanaTrackerBundlers({
        mint: CANONICAL_MINT,
        isLive: false,
      });

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      if (result.success && result.dryRun) {
        expect(path.isAbsolute(result.plannedDestinationDir)).toBe(true);
        expect(result.plannedDestinationDir).toContain("solana-tracker-bundler");
      }
    });

    it("failed dry-run on invalid mint returns failure status", async () => {
      const result = await captureSolanaTrackerBundlers({
        mint: "invalid-short-mint",
        isLive: false,
      });

      expect(result.success).toBe(false);
      expect(result.dryRun).toBe(true);
      if (!result.success) {
        expect(result.status).toBe("INVALID_INPUT");
        expect(result.message).toContain("canonical 32-byte Solana base58");
      }
    });
  });

  describe("Baseline Lifecycle and Edge Conditions", () => {
    it("performs zero network requests and requires no API key when dry-run", async () => {
      let transportCalled = false;
      const transport = createFakeTransport(() => {
        transportCalled = true;
        throw new Error("Transport must not be invoked during dry-run");
      });

      const budget = createStandaloneOneRequestBudget();
      const result = await captureSolanaTrackerBundlers({
        mint: CANONICAL_MINT,
        isLive: false,
        transport,
        budget,
      });

      expect(transportCalled).toBe(false);
      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      if (result.success && result.dryRun) {
        expect(result.status).toBe("DRY_RUN");
        expect(result.mint).toBe(CANONICAL_MINT);
        expect(result.plannedUrl).toBe(
          `https://data.solanatracker.io/tokens/${CANONICAL_MINT}/bundlers`,
        );
        expect(result.limits.maxHttpAttempts).toBe(1);
        expect(result.budgetStatus.totalRequests).toBe(0);
      }
    });

    it("denies dispatch pre-flight when budget is exhausted", async () => {
      let callCount = 0;
      const transport = createFakeTransport(() => {
        callCount++;
        return {
          status: 200,
          statusText: "OK",
          headers: {},
          readBodyBytes: async () => Buffer.from("{}"),
        };
      });

      const budget = new GlobalResourceBudgetManager({ maxTotalRequests: 0 }); // 0 allowed
      const result = await captureSolanaTrackerBundlers({
        mint: CANONICAL_MINT,
        isLive: true,
        apiKey: FAKE_API_KEY,
        transport,
        budget,
      });

      expect(callCount).toBe(0); // Zero network calls
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.status).toBe("BUDGET_DENIED");
        expect(result.message).toContain("GLOBAL_REQUEST_CEILING_REACHED");
      }
    });

    it("strictly prohibits redirects fail-closed", async () => {
      const redirectStatuses = [301, 302, 307, 308];
      for (const code of redirectStatuses) {
        let callCount = 0;
        const transport = createFakeTransport(() => {
          callCount++;
          return {
            status: code,
            statusText: "Redirect",
            headers: { location: "https://evil-redirect.com/api" },
            readBodyBytes: async () => Buffer.from("redirect body"),
          };
        });

        const outDir = getTempTestDir();
        try {
          const result = await captureSolanaTrackerBundlers({
            mint: CANONICAL_MINT,
            isLive: true,
            apiKey: FAKE_API_KEY,
            outDir,
            transport,
          });

          expect(callCount).toBe(1); // Never followed redirect
          expect(result.success).toBe(false);
          if (!result.success) {
            expect(result.status).toBe("REDIRECT_REJECTED");
            expect(result.message).toContain("strictly prohibited");
          }
        } finally {
          fsSync.rmSync(outDir, { recursive: true, force: true });
        }
      }
    });

    it("handles HTTP error statuses safely without throwing unhandled exceptions", async () => {
      const transport = createFakeTransport(() => ({
        status: 401,
        statusText: "Unauthorized",
        headers: { "content-type": "application/json" },
        readBodyBytes: async () => Buffer.from(JSON.stringify({ error: "Invalid API key" })),
      }));

      const outDir = getTempTestDir();
      try {
        const result = await captureSolanaTrackerBundlers({
          mint: CANONICAL_MINT,
          isLive: true,
          apiKey: FAKE_API_KEY,
          outDir,
          transport,
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.status).toBe("HTTP_ERROR");
          expect(result.metadata?.httpStatus).toBe(401);
          expect(result.message).toContain("401 Unauthorized");
        }
      } finally {
        fsSync.rmSync(outDir, { recursive: true, force: true });
      }
    });

    it("dispatches exactly one request, seals evidence, and parses through SolanaTrackerBundlerParser on 200 OK", async () => {
      let callCount = 0;
      let requestedHeaders: Record<string, string> = {};
      const payloadBuf = Buffer.from(JSON.stringify(createValidBundlerPayload()), "utf8");

      const transport = createFakeTransport((_url, options) => {
        callCount++;
        requestedHeaders = options.headers;
        return {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          readBodyBytes: async () => payloadBuf,
        };
      });

      const outDir = getTempTestDir();
      try {
        const result = await captureSolanaTrackerBundlers({
          mint: CANONICAL_MINT,
          isLive: true,
          apiKey: FAKE_API_KEY,
          outDir,
          transport,
        });

        expect(callCount).toBe(1);
        expect(requestedHeaders["x-api-key"]).toBe(FAKE_API_KEY);
        expect(result.success).toBe(true);
        if (!result.success || result.dryRun) return;

        expect(result.status).toBe("SUCCESS");
        expect(result.parserResult.success).toBe(true);
        expect(fsSync.existsSync(path.join(outDir, "sanitized-response.json"))).toBe(true);
        expect(fsSync.existsSync(path.join(outDir, "capture-metadata.json"))).toBe(true);
        expect(fsSync.existsSync(path.join(outDir, "parser-result.json"))).toBe(true);
        expect(fsSync.existsSync(path.join(outDir, "capture-manifest.json"))).toBe(true);
      } finally {
        fsSync.rmSync(outDir, { recursive: true, force: true });
      }
    });
  });

  describe("Correction 2: Sanitized Failure Messages & Precise wasRedacted Tracking", () => {
    it("sanitizes returned failure message, statusText, and all saved artifacts when key is in statusText", async () => {
      const secretStatusText = `Forbidden - unauthorized key: ${FAKE_API_KEY}`;
      const transport = createFakeTransport(() => ({
        status: 403,
        statusText: secretStatusText,
        headers: {},
        readBodyBytes: async () => Buffer.from(`{"error":"access denied for ${FAKE_API_KEY}"}`),
      }));

      const outDir = getTempTestDir();
      try {
        const result = await captureSolanaTrackerBundlers({
          mint: CANONICAL_MINT,
          isLive: true,
          apiKey: FAKE_API_KEY,
          outDir,
          transport,
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          // Assert returned message is sanitized
          expect(result.message).not.toContain(FAKE_API_KEY);
          expect(result.message).toContain("[REDACTED]");
        }

        // Assert full returned object is sanitized
        const resultStr = JSON.stringify(result);
        expect(resultStr).not.toContain(FAKE_API_KEY);

        // Assert all files on disk are sanitized
        const files = fsSync.readdirSync(outDir);
        for (const file of files) {
          const content = fsSync.readFileSync(path.join(outDir, file), "utf8");
          expect(content).not.toContain(FAKE_API_KEY);
        }
      } finally {
        fsSync.rmSync(outDir, { recursive: true, force: true });
      }
    });

    it("tracks wasRedacted: false on clean formatted JSON responses", async () => {
      const cleanPayload = createValidBundlerPayload();
      const payloadBuf = Buffer.from(JSON.stringify(cleanPayload), "utf8");
      const transport = createFakeTransport(() => ({
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        readBodyBytes: async () => payloadBuf,
      }));

      const outDir = getTempTestDir();
      try {
        const result = await captureSolanaTrackerBundlers({
          mint: CANONICAL_MINT,
          isLive: true,
          apiKey: FAKE_API_KEY,
          outDir,
          transport,
        });

        expect(result.success).toBe(true);
        if (!result.success || result.dryRun) return;

        // Must report false because no secret was present or redacted
        expect(result.metadata.wasRedacted).toBe(false);

        const savedMeta = JSON.parse(
          fsSync.readFileSync(path.join(outDir, "capture-metadata.json"), "utf8"),
        );
        expect(savedMeta.wasRedacted).toBe(false);
      } finally {
        fsSync.rmSync(outDir, { recursive: true, force: true });
      }
    });

    it("tracks wasRedacted: true when secrets are removed from JSON payload", async () => {
      const dirtyPayload = {
        ...createValidBundlerPayload(),
        embeddedSecret: FAKE_API_KEY,
      };
      const payloadBuf = Buffer.from(JSON.stringify(dirtyPayload), "utf8");
      const transport = createFakeTransport(() => ({
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        readBodyBytes: async () => payloadBuf,
      }));

      const outDir = getTempTestDir();
      try {
        const result = await captureSolanaTrackerBundlers({
          mint: CANONICAL_MINT,
          isLive: true,
          apiKey: FAKE_API_KEY,
          outDir,
          transport,
        });

        expect(result.success).toBe(true);
        if (!result.success || result.dryRun) return;

        expect(result.metadata.wasRedacted).toBe(true);
        const savedMeta = JSON.parse(
          fsSync.readFileSync(path.join(outDir, "capture-metadata.json"), "utf8"),
        );
        expect(savedMeta.wasRedacted).toBe(true);
      } finally {
        fsSync.rmSync(outDir, { recursive: true, force: true });
      }
    });
  });

  describe("Correction 3: Partial-Response Evidence & Unread Body Cancellation Regressions", () => {
    it("retains bounded partial bytes, count, and wire digest on streaming overflow using production streaming reader", async () => {
      let streamCancelled = false;

      // Stream two 8-byte chunks (total 16 bytes) against a 12-byte limit
      const chunk1 = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const chunk2 = new Uint8Array([9, 10, 11, 12, 13, 14, 15, 16]);
      const expected16Bytes = Buffer.concat([Buffer.from(chunk1), Buffer.from(chunk2)]);

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk1);
          controller.enqueue(chunk2);
        },
        cancel() {
          streamCancelled = true;
        },
      });

      const response = new Response(stream, {
        status: 200,
        statusText: "OK",
        headers: {},
      });

      const transport: HttpTransport = async () =>
        createTransportResponseFromFetchResponse(response);

      const outDir = getTempTestDir();
      try {
        const result = await captureSolanaTrackerBundlers({
          mint: CANONICAL_MINT,
          isLive: true,
          apiKey: FAKE_API_KEY,
          maxResponseSizeBytes: 12, // 12-byte limit
          outDir,
          transport,
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.status).toBe("RESPONSE_TOO_LARGE");
          expect(result.metadata?.isTruncated).toBe(true);
          // Accurately records the 16 bytes read before overflow
          expect(result.metadata?.receivedBytesCount).toBe(16);
          expect(result.metadata?.receivedWireSha256).toBe(computeSha256(expected16Bytes));
          // Proves it does NOT describe an empty-buffer digest
          expect(result.metadata?.receivedWireSha256).not.toBe(computeSha256(Buffer.alloc(0)));

          // Stream was cancelled on overflow
          expect(streamCancelled).toBe(true);
        }
      } finally {
        fsSync.rmSync(outDir, { recursive: true, force: true });
      }
    });

    it("cancels unread body and aborts signal on early Content-Length rejection without empty-buffer hash", async () => {
      let streamCancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start() {},
        cancel() {
          streamCancelled = true;
        },
      });

      const response = new Response(stream, {
        status: 200,
        statusText: "OK",
        headers: { "content-length": "5000000" }, // 5 MB > 2 MB limit
      });

      let transportSignal: AbortSignal | undefined;
      const transport: HttpTransport = async (_url, options) => {
        transportSignal = options.signal;
        return createTransportResponseFromFetchResponse(response);
      };

      const outDir = getTempTestDir();
      try {
        const result = await captureSolanaTrackerBundlers({
          mint: CANONICAL_MINT,
          isLive: true,
          apiKey: FAKE_API_KEY,
          maxResponseSizeBytes: 2000000,
          outDir,
          transport,
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.status).toBe("RESPONSE_TOO_LARGE");
          expect(result.metadata?.isTruncated).toBe(true);
          expect(result.metadata?.receivedBytesCount).toBe(0);
          // Explicitly reports unavailable capture information (null), NOT empty-buffer hash
          expect(result.metadata?.receivedWireSha256).toBeNull();

          // Body stream cancelled and transport signal aborted
          expect(streamCancelled).toBe(true);
          expect(transportSignal?.aborted).toBe(true);
        }
      } finally {
        fsSync.rmSync(outDir, { recursive: true, force: true });
      }
    });

    it("cancels unread body and aborts signal on early redirect rejection without empty-buffer hash", async () => {
      let streamCancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start() {},
        cancel() {
          streamCancelled = true;
        },
      });

      const response = new Response(stream, {
        status: 301,
        statusText: "Moved Permanently",
        headers: { location: "https://evil.com" },
      });

      let transportSignal: AbortSignal | undefined;
      const transport: HttpTransport = async (_url, options) => {
        transportSignal = options.signal;
        return createTransportResponseFromFetchResponse(response);
      };

      const outDir = getTempTestDir();
      try {
        const result = await captureSolanaTrackerBundlers({
          mint: CANONICAL_MINT,
          isLive: true,
          apiKey: FAKE_API_KEY,
          outDir,
          transport,
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.status).toBe("REDIRECT_REJECTED");
          expect(result.metadata?.receivedBytesCount).toBe(0);
          expect(result.metadata?.receivedWireSha256).toBeNull();

          // Stream was cancelled and signal was aborted
          expect(streamCancelled).toBe(true);
          expect(transportSignal?.aborted).toBe(true);
        }
      } finally {
        fsSync.rmSync(outDir, { recursive: true, force: true });
      }
    });
  });
});
