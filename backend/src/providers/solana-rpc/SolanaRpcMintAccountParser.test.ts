import { parseTokenMintAddress } from "@nexustrade/shared";
import { describe, expect, it } from "vitest";

import {
  encodeBase58,
  parseSolanaRpcMintAccountResponse,
  SPL_TOKEN_PROGRAM_ID,
} from "./SolanaRpcMintAccountParser.js";

const MINT = parseTokenMintAddress("So11111111111111111111111111111111111111112");

describe("parseSolanaRpcMintAccountResponse", () => {
  it("parses jsonParsed mint authority states as disabled when authorities are absent", () => {
    const result = parseSolanaRpcMintAccountResponse(
      {
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
      MINT,
      new Date("2026-07-17T00:00:00.000Z"),
      "JSON_PARSED",
    );

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.data.parser).toBe("JSON_PARSED");
    expect(result.data.authorityEvidenceSource).toBe("SOLANA_RPC_JSON_PARSED");
    expect(result.data.mintAuthorityState).toBe("DISABLED");
    expect(result.data.freezeAuthorityState).toBe("DISABLED");
    expect(result.data.decimals).toBe(9);
    expect(result.data.supply).toBe("1000000");
    expect(result.data.slot).toBe(123);
  });

  it("parses base64 mint layout authority states", () => {
    const buffer = Buffer.alloc(82);
    const freezeAuthority = Buffer.alloc(32, 7);

    buffer.writeBigUInt64LE(12345n, 36);
    buffer.writeUInt8(6, 44);
    buffer.writeUInt8(1, 45);
    buffer.writeUInt32LE(1, 46);
    freezeAuthority.copy(buffer, 50);

    const result = parseSolanaRpcMintAccountResponse(
      {
        result: {
          value: {
            owner: SPL_TOKEN_PROGRAM_ID,
            data: [buffer.toString("base64"), "base64"],
          },
        },
      },
      MINT,
      new Date("2026-07-17T00:00:00.000Z"),
      "BASE64_LAYOUT",
    );

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.data.parser).toBe("BASE64_LAYOUT");
    expect(result.data.mintAuthorityState).toBe("DISABLED");
    expect(result.data.freezeAuthorityState).toBe("PRESENT");
    expect(result.data.freezeAuthority).toBe(encodeBase58(freezeAuthority));
    expect(result.data.decimals).toBe(6);
    expect(result.data.supply).toBe("12345");
  });

  it("rejects unsupported account owners", () => {
    const result = parseSolanaRpcMintAccountResponse(
      {
        result: {
          value: {
            owner: "11111111111111111111111111111111",
            data: ["", "base64"],
          },
        },
      },
      MINT,
      new Date("2026-07-17T00:00:00.000Z"),
      "BASE64_LAYOUT",
    );

    expect(result).toEqual({
      ok: false,
      category: "SOLANA_RPC_UNSUPPORTED_OWNER",
      message: "Solana RPC account owner is not a token mint.",
    });
  });
});
