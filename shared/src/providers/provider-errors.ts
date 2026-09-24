export const PROVIDER_ERROR_CODES = [
  "TIMEOUT",
  "RATE_LIMITED",
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "INVALID_RESPONSE",
  "NETWORK_ERROR",
  "PROVIDER_UNAVAILABLE",
  "UNKNOWN",
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export interface ProviderError {
  readonly code: ProviderErrorCode;
  readonly message: string;
  readonly statusCode?: number;
  readonly retryable: boolean;
}

export interface CreateProviderErrorInput {
  readonly code: ProviderErrorCode;
  readonly message: string;
  readonly statusCode?: number;
  readonly retryable?: boolean;
}

export function isProviderErrorCode(value: string): value is ProviderErrorCode {
  return PROVIDER_ERROR_CODES.includes(value as ProviderErrorCode);
}

export function createProviderError(input: CreateProviderErrorInput): ProviderError {
  const retryable = input.retryable ?? isRetryableErrorCode(input.code);
  const error: ProviderError = {
    code: input.code,
    message: input.message,
    retryable,
  };

  if (input.statusCode !== undefined) {
    return {
      ...error,
      statusCode: input.statusCode,
    };
  }

  return error;
}

export function isRetryableErrorCode(code: ProviderErrorCode): boolean {
  return (
    code === "TIMEOUT" ||
    code === "RATE_LIMITED" ||
    code === "NETWORK_ERROR" ||
    code === "PROVIDER_UNAVAILABLE"
  );
}

export function mapHttpStatusToProviderErrorCode(statusCode: number): ProviderErrorCode {
  if (statusCode === 400) {
    return "BAD_REQUEST";
  }

  if (statusCode === 401 || statusCode === 403) {
    return "UNAUTHORIZED";
  }

  if (statusCode === 404) {
    return "NOT_FOUND";
  }

  if (statusCode === 408) {
    return "TIMEOUT";
  }

  if (statusCode === 429) {
    return "RATE_LIMITED";
  }

  if (statusCode >= 500) {
    return "PROVIDER_UNAVAILABLE";
  }

  return "UNKNOWN";
}

export function normalizeUnknownProviderError(error: unknown): ProviderError {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return createProviderError({
        code: "TIMEOUT",
        message: "Provider request timed out.",
      });
    }

    return createProviderError({
      code: "NETWORK_ERROR",
      message: error.message,
    });
  }

  return createProviderError({
    code: "UNKNOWN",
    message: "Unknown provider error.",
    retryable: false,
  });
}
