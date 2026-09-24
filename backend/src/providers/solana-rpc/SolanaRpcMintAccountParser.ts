import {
  type AuthorityEvidenceSource,
  type AuthorityState,
  type TokenMintAddress,
} from "@nexustrade/shared";

export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const BASE_MINT_LAYOUT_LENGTH = 82;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export type SolanaRpcAuthorityParser = "JSON_PARSED" | "BASE64_LAYOUT";

export interface ParsedMintAccountSnapshot {
  readonly mintAddress: TokenMintAddress;
  readonly tokenProgram: string;
  readonly decimals?: number;
  readonly supply?: string;
  readonly isInitialized?: boolean;
  readonly mintAuthority?: string | null;
  readonly mintAuthorityState: AuthorityState;
  readonly freezeAuthority?: string | null;
  readonly freezeAuthorityState: AuthorityState;
  readonly authorityEvidenceSource: AuthorityEvidenceSource;
  readonly parser: SolanaRpcAuthorityParser;
  readonly slot?: number;
  readonly fetchedAt: Date;
  readonly warnings: readonly string[];
}

export type SolanaRpcMintParseFailureCategory =
  | "SOLANA_RPC_INVALID_RESPONSE"
  | "SOLANA_RPC_NOT_FOUND"
  | "SOLANA_RPC_PARSE_FAILED"
  | "SOLANA_RPC_UNSUPPORTED_OWNER";

export interface SolanaRpcMintParseFailure {
  readonly ok: false;
  readonly category: SolanaRpcMintParseFailureCategory;
  readonly message: string;
}

export interface SolanaRpcMintParseSuccess {
  readonly ok: true;
  readonly data: ParsedMintAccountSnapshot;
}

export type SolanaRpcMintParseResult = SolanaRpcMintParseFailure | SolanaRpcMintParseSuccess;

export function parseSolanaRpcMintAccountResponse(
  response: unknown,
  mintAddress: TokenMintAddress,
  fetchedAt: Date,
  preferredParser: SolanaRpcAuthorityParser,
): SolanaRpcMintParseResult {
  const responseRecord = asRecord(response);
  const result = asRecord(responseRecord?.result);
  const context = asRecord(result?.context);
  const value = result ? result.value : undefined;

  if (value === null) {
    return failure("SOLANA_RPC_NOT_FOUND", "Solana RPC account was not found.");
  }

  const account = asRecord(value);

  if (!account) {
    return failure("SOLANA_RPC_INVALID_RESPONSE", "Solana RPC account response is missing value.");
  }

  const owner = readString(account.owner);

  if (!owner || !isSupportedTokenProgram(owner)) {
    return failure("SOLANA_RPC_UNSUPPORTED_OWNER", "Solana RPC account owner is not a token mint.");
  }

  const slot = typeof context?.slot === "number" ? context.slot : undefined;
  const parsed = preferredParser === "JSON_PARSED" ? parseJsonParsedData(account.data) : undefined;

  if (parsed) {
    return {
      ok: true,
      data: {
        mintAddress,
        tokenProgram: owner,
        ...parsed,
        authorityEvidenceSource: "SOLANA_RPC_JSON_PARSED",
        parser: "JSON_PARSED",
        ...(slot !== undefined ? { slot } : {}),
        fetchedAt,
      },
    };
  }

  const base64 = readBase64AccountData(account.data);

  if (!base64) {
    return failure(
      "SOLANA_RPC_PARSE_FAILED",
      "Solana RPC account data was neither jsonParsed mint data nor base64 data.",
    );
  }

  const base64Parsed = parseBase64MintData(base64);

  if (!base64Parsed.ok) {
    return base64Parsed;
  }

  return {
    ok: true,
    data: {
      mintAddress,
      tokenProgram: owner,
      ...base64Parsed.data,
      authorityEvidenceSource: "SOLANA_RPC_BASE64_LAYOUT",
      parser: "BASE64_LAYOUT",
      ...(slot !== undefined ? { slot } : {}),
      fetchedAt,
    },
  };
}

function parseJsonParsedData(
  data: unknown,
): Omit<
  ParsedMintAccountSnapshot,
  "authorityEvidenceSource" | "fetchedAt" | "mintAddress" | "parser" | "slot" | "tokenProgram"
> | null {
  const dataRecord = asRecord(data);
  const parsed = asRecord(dataRecord?.parsed);
  const info = asRecord(parsed?.info);

  if (!info || readString(parsed?.type) !== "mint") {
    return null;
  }

  const mintAuthority = readOptionalAuthority(info.mintAuthority);
  const freezeAuthority = readOptionalAuthority(info.freezeAuthority);
  const decimals = readNumber(info.decimals);
  const supply = readSupply(info.supply);
  const isInitialized = readBoolean(info.isInitialized);

  return {
    ...(decimals !== undefined ? { decimals } : {}),
    ...(supply !== undefined ? { supply } : {}),
    ...(isInitialized !== undefined ? { isInitialized } : {}),
    mintAuthority,
    mintAuthorityState: authorityToState(mintAuthority),
    freezeAuthority,
    freezeAuthorityState: authorityToState(freezeAuthority),
    warnings: [],
  };
}

function parseBase64MintData(encoded: string):
  | {
      readonly ok: true;
      readonly data: Omit<
        ParsedMintAccountSnapshot,
        "authorityEvidenceSource" | "fetchedAt" | "mintAddress" | "parser" | "slot" | "tokenProgram"
      >;
    }
  | SolanaRpcMintParseFailure {
  let buffer: Buffer;

  try {
    buffer = Buffer.from(encoded, "base64");
  } catch {
    return failure("SOLANA_RPC_PARSE_FAILED", "Solana RPC base64 account data could not decode.");
  }

  if (buffer.length < BASE_MINT_LAYOUT_LENGTH) {
    return failure("SOLANA_RPC_PARSE_FAILED", "Solana RPC mint account data is too short.");
  }

  const mintAuthority = readCOptionPubkey(buffer, 0, 4);
  const supply = buffer.readBigUInt64LE(36).toString();
  const decimals = buffer.readUInt8(44);
  const isInitialized = buffer.readUInt8(45) !== 0;
  const freezeAuthority = readCOptionPubkey(buffer, 46, 50);

  return {
    ok: true,
    data: {
      decimals,
      supply,
      isInitialized,
      mintAuthority,
      mintAuthorityState: authorityToState(mintAuthority),
      freezeAuthority,
      freezeAuthorityState: authorityToState(freezeAuthority),
      warnings: [],
    },
  };
}

function readCOptionPubkey(
  buffer: Buffer,
  optionOffset: number,
  pubkeyOffset: number,
): string | null {
  const option = buffer.readUInt32LE(optionOffset);

  if (option === 0) {
    return null;
  }

  if (option !== 1) {
    return null;
  }

  return encodeBase58(buffer.subarray(pubkeyOffset, pubkeyOffset + 32));
}

function authorityToState(authority: string | null): AuthorityState {
  return authority ? "PRESENT" : "DISABLED";
}

function readOptionalAuthority(value: unknown): string | null {
  const valueString = readString(value);

  return valueString ?? null;
}

function readBase64AccountData(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length < 1) {
    return undefined;
  }

  const encoded = readString(value[0]);
  const encoding = readString(value[1]);

  if (!encoded || encoding !== "base64") {
    return undefined;
  }

  return encoded;
}

function isSupportedTokenProgram(owner: string): boolean {
  return owner === SPL_TOKEN_PROGRAM_ID || owner === TOKEN_2022_PROGRAM_ID;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readSupply(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function failure(
  category: SolanaRpcMintParseFailureCategory,
  message: string,
): SolanaRpcMintParseFailure {
  return {
    ok: false,
    category,
    message,
  };
}

export function encodeBase58(bytes: Uint8Array): string {
  let zeroes = 0;

  while (zeroes < bytes.length && bytes[zeroes] === 0) {
    zeroes += 1;
  }

  if (zeroes === bytes.length) {
    return "1".repeat(zeroes);
  }

  const digits: number[] = [0];

  for (let index = zeroes; index < bytes.length; index += 1) {
    let carry = bytes[index] ?? 0;

    for (let digitIndex = 0; digitIndex < digits.length; digitIndex += 1) {
      carry += (digits[digitIndex] ?? 0) << 8;
      digits[digitIndex] = carry % 58;
      carry = Math.floor(carry / 58);
    }

    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  return `${"1".repeat(zeroes)}${digits
    .reverse()
    .map((digit) => BASE58_ALPHABET[digit])
    .join("")}`;
}
