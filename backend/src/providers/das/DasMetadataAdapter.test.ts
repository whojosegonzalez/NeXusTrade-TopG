import { parseTokenMintAddress, providerSuccess } from "@nexustrade/shared";
import { describe, expect, it, vi } from "vitest";

import type { ProviderHttpClient } from "../http/ProviderHttpClient.js";
import { DasMetadataAdapter } from "./DasMetadataAdapter.js";

const MINT = parseTokenMintAddress("So11111111111111111111111111111111111111112");

describe("DasMetadataAdapter", () => {
  it("maps DAS getAsset responses to token metadata snapshots", async () => {
    const postJson = vi.fn().mockResolvedValue(
      providerSuccess({
        provider: "QUICKNODE_DAS",
        data: {
          jsonrpc: "2.0",
          id: "1",
          result: {
            id: MINT,
            content: {
              json_uri: "https://example.test/metadata.json",
              metadata: {
                name: "Wrapped SOL",
                symbol: "SOL",
                description: "Test asset",
              },
              links: {
                image: "https://example.test/sol.png",
              },
            },
            token_info: {
              decimals: 9,
              supply: "1000000",
              token_program: "spl-token",
              mint_authority: null,
              freeze_authority: null,
            },
          },
        },
        fetchedAt: new Date("2026-07-17T00:00:00.000Z"),
        latencyMs: 9,
      }),
    );
    const adapter = new DasMetadataAdapter({
      providerName: "QUICKNODE_DAS",
      httpClient: { postJson } as unknown as ProviderHttpClient,
      maxRetries: 0,
      retryBackoffMs: 0,
      allowRawPayloadLogging: false,
      metadataEnabled: true,
    });

    const result = await adapter.getTokenMetadata(MINT);

    expect(result.ok).toBe(true);
    expect(postJson).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          method: "getAsset",
          params: expect.objectContaining({
            id: MINT,
            options: { showFungible: true },
          }),
        }),
      }),
    );

    if (!result.ok) {
      return;
    }

    expect(result.data).toEqual(
      expect.objectContaining({
        mintAddress: MINT,
        source: "QUICKNODE_DAS",
        name: "Wrapped SOL",
        symbol: "SOL",
        decimals: 9,
        supply: "1000000",
      }),
    );
  });
});
