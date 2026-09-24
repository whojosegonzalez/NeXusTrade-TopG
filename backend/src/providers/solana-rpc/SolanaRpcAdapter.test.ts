import { parseTokenMintAddress, providerSuccess } from "@nexustrade/shared";
import { describe, expect, it, vi } from "vitest";

import type { ProviderHttpClient } from "../http/ProviderHttpClient.js";
import { SolanaRpcAdapter } from "./SolanaRpcAdapter.js";
import { SolanaRpcMintAccountCache } from "./SolanaRpcMintAccountCache.js";
import { SPL_TOKEN_PROGRAM_ID } from "./SolanaRpcMintAccountParser.js";

const MINT = parseTokenMintAddress("So11111111111111111111111111111111111111112");

describe("SolanaRpcAdapter", () => {
  it("returns risk evidence and reuses cached mint account snapshots", async () => {
    const postJson = vi.fn().mockResolvedValue(
      providerSuccess({
        provider: "SOLANA_RPC",
        data: {
          result: {
            context: { slot: 123 },
            value: {
              owner: SPL_TOKEN_PROGRAM_ID,
              data: {
                parsed: {
                  type: "mint",
                  info: {
                    decimals: 9,
                    supply: "1000000",
                    isInitialized: true,
                    mintAuthority: null,
                    freezeAuthority: null,
                  },
                },
              },
            },
          },
        },
        fetchedAt: new Date("2026-07-17T00:00:00.000Z"),
        latencyMs: 12,
      }),
    );
    const adapter = new SolanaRpcAdapter({
      httpClient: { postJson } as unknown as ProviderHttpClient,
      maxRetries: 0,
      retryBackoffMs: 0,
      allowRawPayloadLogging: false,
      mintAccountCache: new SolanaRpcMintAccountCache({ ttlMs: 60_000 }),
      mintAccountCacheEnabled: true,
      useJsonParsed: true,
      base64FallbackEnabled: true,
    });

    const first = await adapter.getRiskEvidence(MINT);
    const second = await adapter.getRiskEvidence(MINT);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(postJson).toHaveBeenCalledTimes(1);

    if (!first.ok || !second.ok) {
      return;
    }

    expect(first.data.source).toBe("SOLANA_RPC");
    expect(first.data.mintAuthorityState).toBe("DISABLED");
    expect(first.data.freezeAuthorityState).toBe("DISABLED");
    expect(second.warnings).toContain("Solana RPC mint-account cache hit.");
  });
});
