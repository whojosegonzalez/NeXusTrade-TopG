import { describe, expect, it } from "vitest";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  captureSolanaTrackerBundlers,
  computeSha256,
  createStandaloneOneRequestBudget,
  redactSensitiveText,
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
  describe("Redaction and Wire Digest Hashing", () => {
    it("redacts secret keys and common auth tokens from text", () => {
      const sensitive = `Error: call failed with x-api-key: "${FAKE_API_KEY}" and token=abc123secret`;
      const sanitized = redactSensitiveText(sensitive, [FAKE_API_KEY]);

      expect(sanitized).not.toContain(FAKE_API_KEY);
      expect(sanitized).toContain("[REDACTED]");
    });

    it("keeps received raw wire digest distinct from sanitized evidence hash", () => {
      const rawWire = `{"error": "Unauthorized key: ${FAKE_API_KEY}"}`;
      const rawDigest = computeSha256(rawWire);
      const sanitized = redactSensitiveText(rawWire, [FAKE_API_KEY]);
      const sanitizedDigest = computeSha256(sanitized);

      expect(rawDigest).not.toBe(sanitizedDigest);
      expect(sanitized).not.toContain(FAKE_API_KEY);
    });
  });

  describe("Zero-Network Dry-Run Mode", () => {
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

    it("rejects invalid mints pre-flight without network calls or budget consumption", async () => {
      let transportCalled = false;
      const transport = createFakeTransport(() => {
        transportCalled = true;
        throw new Error("Must not be invoked");
      });

      const budget = createStandaloneOneRequestBudget();
      const result = await captureSolanaTrackerBundlers({
        mint: "invalid-short-mint",
        isLive: false,
        transport,
        budget,
      });

      expect(transportCalled).toBe(false);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.status).toBe("INVALID_INPUT");
        expect(result.message).toContain("canonical 32-byte Solana base58");
      }
      expect(budget.getTotalRequests()).toBe(0);
    });
  });

  describe("Live Execution: Success & Evidence Sealing", () => {
    it("dispatches exactly one request, seals evidence, and parses through SolanaTrackerBundlerParser", async () => {
      let callCount = 0;
      let requestedHeaders: Record<string, string> = {};
      const payload = createValidBundlerPayload();
      const payloadString = JSON.stringify(payload);

      const transport = createFakeTransport((_url, options) => {
        callCount++;
        requestedHeaders = options.headers;
        return {
          status: 200,
          statusText: "OK",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payloadString).toString(),
          },
          bodyText: async () => payloadString,
        };
      });

      const outDir = getTempTestDir();
      const budget = createStandaloneOneRequestBudget();

      const result = await captureSolanaTrackerBundlers({
        mint: CANONICAL_MINT,
        isLive: true,
        apiKey: FAKE_API_KEY,
        outDir,
        transport,
        budget,
      });

      try {
        expect(callCount).toBe(1);
        expect(requestedHeaders["x-api-key"]).toBe(FAKE_API_KEY);
        expect(budget.getTotalRequests()).toBe(1);
        expect(budget.getStats().enrichmentRequests).toBe(1);

        expect(result.success).toBe(true);
        if (!result.success || result.dryRun) return;

        expect(result.status).toBe("SUCCESS");
        expect(result.targetDir).toBe(outDir);
        expect(result.metadata.httpStatus).toBe(200);
        expect(result.metadata.requestedMint).toBe(CANONICAL_MINT);
        expect(result.metadata.receivedBytesCount).toBe(Buffer.byteLength(payloadString));
        expect(result.metadata.receivedWireSha256).toBe(computeSha256(payloadString));

        // Parser Result
        expect(result.parserResult.success).toBe(true);
        if (result.parserResult.success) {
          expect(result.parserResult.data.totalBundlersCount).toBe(2);
          expect(result.parserResult.data.currentHoldingPct).toBe(0.05); // 5% -> 0.05
          expect(result.parserResult.data.initialPct).toBe(0.2); // 20% -> 0.2
          expect(result.parserResult.data.walletSampleCount).toBe(2);
          expect(result.parserResult.data.isProviderAccuracyVerified).toBe(false);
          expect(result.parserResult.data.upstreamSnapshotTimeMs).toBeNull();
        }

        // Verify Disk Artifacts
        expect(fsSync.existsSync(path.join(outDir, "sanitized-response.json"))).toBe(true);
        expect(fsSync.existsSync(path.join(outDir, "capture-metadata.json"))).toBe(true);
        expect(fsSync.existsSync(path.join(outDir, "parser-result.json"))).toBe(true);
        expect(fsSync.existsSync(path.join(outDir, "capture-manifest.json"))).toBe(true);

        // Verify Manifest
        expect(result.manifest.manifestVersion).toBe("1.0");
        expect(result.manifest.requestedMint).toBe(CANONICAL_MINT);
        expect(result.manifest.totalFiles).toBe(3); // 3 evidence files excluding manifest itself
        expect(result.manifest.files.length).toBe(3);

        for (const fileEntry of result.manifest.files) {
          const diskContent = fsSync.readFileSync(path.join(outDir, fileEntry.filename));
          expect(fileEntry.byteSize).toBe(diskContent.length);
          expect(fileEntry.sha256).toBe(computeSha256(diskContent));
        }
      } finally {
        fsSync.rmSync(outDir, { recursive: true, force: true });
      }
    });

    it("enforces anti-overwrite protection: refuses to overwrite existing directory", async () => {
      const outDir = getTempTestDir();
      fsSync.mkdirSync(outDir, { recursive: true });
      fsSync.writeFileSync(path.join(outDir, "existing.txt"), "pre-existing data");

      let callCount = 0;
      const transport = createFakeTransport(() => {
        callCount++;
        return {
          status: 200,
          statusText: "OK",
          headers: {},
          bodyText: async () => JSON.stringify(createValidBundlerPayload()),
        };
      });

      try {
        const result = await captureSolanaTrackerBundlers({
          mint: CANONICAL_MINT,
          isLive: true,
          apiKey: FAKE_API_KEY,
          outDir,
          transport,
        });

        expect(callCount).toBe(0); // Zero network calls made
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.status).toBe("DESTINATION_ALREADY_EXISTS");
          expect(result.message).toContain("Refusing to overwrite");
        }
      } finally {
        fsSync.rmSync(outDir, { recursive: true, force: true });
      }
    });
  });

  describe("Failure Modes, Bounds, and Redaction", () => {
    it("handles HTTP 401 Unauthorized without retries and records attempt in budget", async () => {
      let callCount = 0;
      const transport = createFakeTransport(() => {
        callCount++;
        return {
          status: 401,
          statusText: "Unauthorized",
          headers: {},
          bodyText: async () => JSON.stringify({ error: "Invalid API key" }),
        };
      });

      const outDir = getTempTestDir();
      const budget = createStandaloneOneRequestBudget();

      try {
        const result = await captureSolanaTrackerBundlers({
          mint: CANONICAL_MINT,
          isLive: true,
          apiKey: FAKE_API_KEY,
          outDir,
          transport,
          budget,
        });

        expect(callCount).toBe(1); // Exactly 1 request; no retry
        expect(budget.getTotalRequests()).toBe(1);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.status).toBe("HTTP_ERROR");
          expect(result.metadata?.httpStatus).toBe(401);
        }
      } finally {
        fsSync.rmSync(outDir, { recursive: true, force: true });
      }
    });

    it("handles HTTP 429 Too Many Requests without retries and notifies budget manager", async () => {
      let callCount = 0;
      const transport = createFakeTransport(() => {
        callCount++;
        return {
          status: 429,
          statusText: "Too Many Requests",
          headers: {},
          bodyText: async () => JSON.stringify({ error: "Rate limit exceeded" }),
        };
      });

      const outDir = getTempTestDir();
      const budget = createStandaloneOneRequestBudget();

      try {
        const result = await captureSolanaTrackerBundlers({
          mint: CANONICAL_MINT,
          isLive: true,
          apiKey: FAKE_API_KEY,
          outDir,
          transport,
          budget,
        });

        expect(callCount).toBe(1);
        expect(budget.getTotalRequests()).toBe(1);
        expect(budget.getStats().consecutive429sEncountered).toBe(1);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.status).toBe("HTTP_ERROR");
          expect(result.metadata?.httpStatus).toBe(429);
        }
      } finally {
        fsSync.rmSync(outDir, { recursive: true, force: true });
      }
    });

    it("handles malformed 200 payload: seals evidence and records parser failure details", async () => {
      const malformedPayload = {
        total: "not-a-number", // Schema violation
        balance: 1000,
        percentage: 1.0,
        initialBalance: 1000,
        initialPercentage: 1.0,
        wallets: [],
      };

      const transport = createFakeTransport(() => ({
        status: 200,
        statusText: "OK",
        headers: {},
        bodyText: async () => JSON.stringify(malformedPayload),
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
          expect(result.parserResult?.success).toBe(false);
          if (result.parserResult && !result.parserResult.success) {
            expect(result.parserResult.error).toBe("INVALID_TOTAL_COUNT");
          }
        }

        // Verify evidence was sealed despite parse failure
        expect(fsSync.existsSync(path.join(outDir, "parser-result.json"))).toBe(true);
        expect(fsSync.existsSync(path.join(outDir, "capture-manifest.json"))).toBe(true);
      } finally {
        fsSync.rmSync(outDir, { recursive: true, force: true });
      }
    });

    it("rejects HTTP redirects (301, 302, 307, 308) without following", async () => {
      for (const redirectStatus of [301, 302, 307, 308]) {
        let callCount = 0;
        const transport = createFakeTransport(() => {
          callCount++;
          return {
            status: redirectStatus,
            statusText: "Moved",
            headers: { location: "https://evil.redirect.com" },
            bodyText: async () => "Redirecting...",
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

    it("enforces response body size limit", async () => {
      const largeBody = "x".repeat(1024 * 1024 + 10); // > 1 MB
      const transport = createFakeTransport(() => ({
        status: 200,
        statusText: "OK",
        headers: { "content-length": largeBody.length.toString() },
        bodyText: async () => largeBody,
      }));

      const outDir = getTempTestDir();
      try {
        const result = await captureSolanaTrackerBundlers({
          mint: CANONICAL_MINT,
          isLive: true,
          apiKey: FAKE_API_KEY,
          maxResponseSizeBytes: 1024 * 1024, // 1 MB limit
          outDir,
          transport,
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.status).toBe("RESPONSE_TOO_LARGE");
        }
      } finally {
        fsSync.rmSync(outDir, { recursive: true, force: true });
      }
    });

    it("enforces request timeout bounds", async () => {
      const transport = createFakeTransport(async (_url, options) => {
        return new Promise<HttpTransportResponse>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      });

      const outDir = getTempTestDir();
      try {
        const result = await captureSolanaTrackerBundlers({
          mint: CANONICAL_MINT,
          isLive: true,
          apiKey: FAKE_API_KEY,
          timeoutMs: 50, // 50ms fast timeout
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

    it("redacts credentials from error messages and disk artifacts", async () => {
      // Simulate an error payload reflecting the API key
      const sensitiveWireResponse = JSON.stringify({
        error: `Invalid credentials for key ${FAKE_API_KEY}`,
      });

      const transport = createFakeTransport(() => ({
        status: 403,
        statusText: "Forbidden",
        headers: {},
        bodyText: async () => sensitiveWireResponse,
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
          expect(result.message).not.toContain(FAKE_API_KEY);

          // Check sanitized-response.json on disk
          const savedResponse = fsSync.readFileSync(
            path.join(outDir, "sanitized-response.json"),
            "utf8",
          );
          expect(savedResponse).not.toContain(FAKE_API_KEY);
          expect(savedResponse).toContain("[REDACTED]");

          // Check capture-metadata.json on disk
          const savedMeta = fsSync.readFileSync(path.join(outDir, "capture-metadata.json"), "utf8");
          expect(savedMeta).not.toContain(FAKE_API_KEY);

          // Check wire digest vs saved digest
          expect(result.metadata?.receivedWireSha256).toBe(computeSha256(sensitiveWireResponse));
          expect(result.metadata?.savedEvidenceSha256).toBe(computeSha256(savedResponse));
          expect(result.metadata?.wasRedacted).toBe(true);
        }
      } finally {
        fsSync.rmSync(outDir, { recursive: true, force: true });
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
          bodyText: async () => "{}",
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
  });
});
