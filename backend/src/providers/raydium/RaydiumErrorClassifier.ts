import type { ProviderErrorCode } from "@nexustrade/shared";

export const RAYDIUM_QUOTE_FAILURE_CATEGORIES = [
  "NO_ROUTE",
  "UNSUPPORTED_MINT",
  "UNSUPPORTED_TOKEN_PROGRAM",
  "BAD_AMOUNT",
  "BAD_REQUEST",
  "RATE_LIMITED",
  "RAYDIUM_UNAVAILABLE",
  "HTTP_ERROR",
  "RESPONSE_NOT_SUCCESSFUL",
  "SCHEMA_INVALID",
  "MAPPER_ERROR",
  "TIMEOUT",
  "UNKNOWN",
] as const;

export type RaydiumQuoteFailureCategory = (typeof RAYDIUM_QUOTE_FAILURE_CATEGORIES)[number];

export const RAYDIUM_QUOTE_FAILURE_DETAILS = [
  "NONE",
  "REQ_INPUT_MINT_ERROR",
  "REQ_OUTPUT_MINT_ERROR",
  "REQ_AMOUNT_ERROR",
  "REQ_SLIPPAGE_BPS_ERROR",
  "REQ_TX_VERSION_ERROR",
  "NO_ROUTE",
  "UNSUPPORTED_TOKEN_PROGRAM",
  "HTTP_4XX",
  "HTTP_5XX",
  "RATE_LIMITED",
  "TIMEOUT",
  "SCHEMA_INVALID",
  "MAPPER_ERROR",
  "UNKNOWN",
] as const;

export type RaydiumQuoteFailureDetail = (typeof RAYDIUM_QUOTE_FAILURE_DETAILS)[number];

export interface ClassifyRaydiumFailureInput {
  readonly providerErrorCode?: ProviderErrorCode;
  readonly statusCode?: number;
  readonly message?: string;
  readonly schemaInvalid?: boolean;
  readonly mapperError?: boolean;
}

export function classifyRaydiumFailure(
  input: ClassifyRaydiumFailureInput,
): RaydiumQuoteFailureCategory {
  const detail = classifyRaydiumFailureDetail(input);

  switch (detail) {
    case "REQ_INPUT_MINT_ERROR":
    case "REQ_OUTPUT_MINT_ERROR":
      return "UNSUPPORTED_MINT";
    case "REQ_AMOUNT_ERROR":
    case "REQ_SLIPPAGE_BPS_ERROR":
      return "BAD_AMOUNT";
    case "REQ_TX_VERSION_ERROR":
      return "BAD_REQUEST";
    case "NO_ROUTE":
      return "NO_ROUTE";
    case "UNSUPPORTED_TOKEN_PROGRAM":
      return "UNSUPPORTED_TOKEN_PROGRAM";
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    case "TIMEOUT":
      return "TIMEOUT";
    case "SCHEMA_INVALID":
      return "SCHEMA_INVALID";
    case "MAPPER_ERROR":
      return "MAPPER_ERROR";
    case "HTTP_5XX":
      return "RAYDIUM_UNAVAILABLE";
    case "HTTP_4XX":
      return input.statusCode === 404 ? "NO_ROUTE" : "HTTP_ERROR";
    case "NONE":
    case "UNKNOWN":
      break;
  }

  if (input.schemaInvalid) {
    return "SCHEMA_INVALID";
  }

  if (input.mapperError) {
    return "MAPPER_ERROR";
  }

  if (input.statusCode === 429 || input.providerErrorCode === "RATE_LIMITED") {
    return "RATE_LIMITED";
  }

  if (input.providerErrorCode === "TIMEOUT") {
    return "TIMEOUT";
  }

  if (input.statusCode !== undefined) {
    if (input.statusCode === 400) {
      return classifyByMessage(input.message) ?? "BAD_REQUEST";
    }

    if (input.statusCode === 404) {
      return "NO_ROUTE";
    }

    if (input.statusCode >= 500) {
      return "RAYDIUM_UNAVAILABLE";
    }

    if (input.statusCode >= 400) {
      return "HTTP_ERROR";
    }
  }

  if (input.providerErrorCode === "BAD_REQUEST") {
    return classifyByMessage(input.message) ?? "BAD_REQUEST";
  }

  if (input.providerErrorCode === "NOT_FOUND") {
    return "NO_ROUTE";
  }

  if (input.providerErrorCode === "PROVIDER_UNAVAILABLE") {
    return classifyByMessage(input.message) ?? "RAYDIUM_UNAVAILABLE";
  }

  if (input.providerErrorCode === "INVALID_RESPONSE") {
    return classifyByMessage(input.message) ?? "SCHEMA_INVALID";
  }

  return classifyByMessage(input.message) ?? "UNKNOWN";
}

export function classifyRaydiumFailureDetail(
  input: ClassifyRaydiumFailureInput,
): RaydiumQuoteFailureDetail {
  if (input.schemaInvalid) {
    return "SCHEMA_INVALID";
  }

  if (input.mapperError) {
    return "MAPPER_ERROR";
  }

  const documented = classifyDocumentedMessage(input.message);

  if (documented) {
    return documented;
  }

  if (input.statusCode === 429 || input.providerErrorCode === "RATE_LIMITED") {
    return "RATE_LIMITED";
  }

  if (input.providerErrorCode === "TIMEOUT") {
    return "TIMEOUT";
  }

  if (input.statusCode !== undefined) {
    if (input.statusCode >= 500) {
      return "HTTP_5XX";
    }

    if (input.statusCode >= 400) {
      return input.statusCode === 404 ? "NO_ROUTE" : "HTTP_4XX";
    }
  }

  if (input.providerErrorCode === "NOT_FOUND") {
    return "NO_ROUTE";
  }

  if (input.providerErrorCode === "INVALID_RESPONSE") {
    return "SCHEMA_INVALID";
  }

  if (input.providerErrorCode === "NETWORK_ERROR") {
    return "UNKNOWN";
  }

  return classifyGenericDetailByMessage(input.message) ?? "UNKNOWN";
}

export function sanitizeRaydiumMessage(message: string | undefined, maxLength: number): string {
  if (!message) {
    return "";
  }

  const compact = message.replace(/\s+/g, " ").trim();

  return compact.length > maxLength
    ? `${compact.slice(0, Math.max(0, maxLength - 3))}...`
    : compact;
}

function classifyByMessage(message: string | undefined): RaydiumQuoteFailureCategory | undefined {
  const normalized = message?.toLowerCase() ?? "";

  if (!normalized) {
    return undefined;
  }

  if (
    normalized.includes("no route") ||
    normalized.includes("route not found") ||
    normalized.includes("pool not found") ||
    normalized.includes("no pool") ||
    normalized.includes("not found pool") ||
    normalized.includes("cannot find route")
  ) {
    return "NO_ROUTE";
  }

  if (
    normalized.includes("token-2022") ||
    normalized.includes("token 2022") ||
    normalized.includes("token program") ||
    normalized.includes("transfer fee")
  ) {
    return "UNSUPPORTED_TOKEN_PROGRAM";
  }

  if (
    normalized.includes("mint") ||
    normalized.includes("token not found") ||
    normalized.includes("unsupported token") ||
    normalized.includes("invalid token")
  ) {
    return "UNSUPPORTED_MINT";
  }

  if (
    normalized.includes("amount") ||
    normalized.includes("slippage") ||
    normalized.includes("input") ||
    normalized.includes("output")
  ) {
    return "BAD_AMOUNT";
  }

  if (normalized.includes("rate limit") || normalized.includes("too many requests")) {
    return "RATE_LIMITED";
  }

  if (
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("abort")
  ) {
    return "TIMEOUT";
  }

  if (
    normalized.includes("unavailable") ||
    normalized.includes("bad gateway") ||
    normalized.includes("service")
  ) {
    return "RAYDIUM_UNAVAILABLE";
  }

  return undefined;
}

function classifyDocumentedMessage(
  message: string | undefined,
): RaydiumQuoteFailureDetail | undefined {
  const normalized = message?.trim().toUpperCase() ?? "";

  switch (normalized) {
    case "REQ_INPUT_MINT_ERROR":
      return "REQ_INPUT_MINT_ERROR";
    case "REQ_OUTPUT_MINT_ERROR":
      return "REQ_OUTPUT_MINT_ERROR";
    case "REQ_AMOUNT_ERROR":
      return "REQ_AMOUNT_ERROR";
    case "REQ_SLIPPAGE_BPS_ERROR":
      return "REQ_SLIPPAGE_BPS_ERROR";
    case "REQ_TX_VERSION_ERROR":
      return "REQ_TX_VERSION_ERROR";
    default:
      return undefined;
  }
}

function classifyGenericDetailByMessage(
  message: string | undefined,
): RaydiumQuoteFailureDetail | undefined {
  const broad = classifyByMessage(message);

  switch (broad) {
    case "NO_ROUTE":
      return "NO_ROUTE";
    case "UNSUPPORTED_TOKEN_PROGRAM":
      return "UNSUPPORTED_TOKEN_PROGRAM";
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    case "TIMEOUT":
      return "TIMEOUT";
    case "SCHEMA_INVALID":
      return "SCHEMA_INVALID";
    case "MAPPER_ERROR":
      return "MAPPER_ERROR";
    default:
      return undefined;
  }
}
