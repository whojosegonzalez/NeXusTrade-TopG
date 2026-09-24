import type { ProviderError } from "./provider-errors.js";
import type { ProviderErrorCode } from "./provider-errors.js";
import type { ProviderName } from "./provider.types.js";

export const PROVIDER_HTTP_ATTEMPT_OUTCOMES = [
  "OK",
  "HTTP_ERROR",
  "TIMEOUT",
  "NETWORK_ERROR",
  "RATE_LIMITED",
  "INVALID_RESPONSE",
] as const;

export type ProviderHttpAttemptOutcome = (typeof PROVIDER_HTTP_ATTEMPT_OUTCOMES)[number];

export interface ProviderHttpAttempt {
  readonly provider: ProviderName;
  readonly operation: string;
  readonly endpointId: string;
  readonly method: "GET" | "POST";
  readonly attemptNumber: number;
  readonly outcome: ProviderHttpAttemptOutcome;
  readonly statusCode?: number;
  readonly latencyMs: number;
  readonly rateLimiterWaitMs?: number;
  readonly retryable: boolean;
  readonly failureCode?: ProviderErrorCode;
  readonly rateLimitRemaining?: number;
  readonly rateLimitResetAtMs?: number;
  readonly retryAfterMs?: number;
}

interface ProviderResultBase {
  readonly provider: ProviderName;
  readonly warnings: readonly string[];
  readonly fetchedAt: Date;
  readonly latencyMs: number;
  readonly rateLimited: boolean;
  readonly raw?: unknown;
  readonly httpAttempts?: readonly ProviderHttpAttempt[];
  readonly diagnostics?: Readonly<Record<string, unknown>>;
}

export interface ProviderSuccess<T> extends ProviderResultBase {
  readonly ok: true;
  readonly data: T;
}

export interface ProviderFailure extends ProviderResultBase {
  readonly ok: false;
  readonly error: ProviderError;
}

export type ProviderResult<T> = ProviderSuccess<T> | ProviderFailure;

export interface ProviderSuccessInput<T> {
  readonly provider: ProviderName;
  readonly data: T;
  readonly warnings?: readonly string[];
  readonly fetchedAt?: Date;
  readonly latencyMs?: number;
  readonly rateLimited?: boolean;
  readonly raw?: unknown;
  readonly httpAttempts?: readonly ProviderHttpAttempt[];
  readonly diagnostics?: Readonly<Record<string, unknown>>;
}

export interface ProviderFailureInput {
  readonly provider: ProviderName;
  readonly error: ProviderError;
  readonly warnings?: readonly string[];
  readonly fetchedAt?: Date;
  readonly latencyMs?: number;
  readonly rateLimited?: boolean;
  readonly raw?: unknown;
  readonly httpAttempts?: readonly ProviderHttpAttempt[];
  readonly diagnostics?: Readonly<Record<string, unknown>>;
}

export function providerSuccess<T>(input: ProviderSuccessInput<T>): ProviderSuccess<T> {
  const result: ProviderSuccess<T> = {
    ok: true,
    provider: input.provider,
    data: input.data,
    warnings: input.warnings ?? [],
    fetchedAt: input.fetchedAt ?? new Date(),
    latencyMs: input.latencyMs ?? 0,
    rateLimited: input.rateLimited ?? false,
  };

  if (input.raw !== undefined) {
    const withRaw = {
      ...result,
      raw: input.raw,
    };

    const withAttempts = input.httpAttempts
      ? {
          ...withRaw,
          httpAttempts: input.httpAttempts,
        }
      : withRaw;

    return input.diagnostics
      ? {
          ...withAttempts,
          diagnostics: input.diagnostics,
        }
      : withAttempts;
  }

  if (input.httpAttempts) {
    const withAttempts = {
      ...result,
      httpAttempts: input.httpAttempts,
    };

    return input.diagnostics
      ? {
          ...withAttempts,
          diagnostics: input.diagnostics,
        }
      : withAttempts;
  }

  if (input.diagnostics) {
    return {
      ...result,
      diagnostics: input.diagnostics,
    };
  }

  return result;
}

export function providerFailure(input: ProviderFailureInput): ProviderFailure {
  const result: ProviderFailure = {
    ok: false,
    provider: input.provider,
    error: input.error,
    warnings: input.warnings ?? [],
    fetchedAt: input.fetchedAt ?? new Date(),
    latencyMs: input.latencyMs ?? 0,
    rateLimited: input.rateLimited ?? input.error.code === "RATE_LIMITED",
  };

  if (input.raw !== undefined) {
    const withRaw = {
      ...result,
      raw: input.raw,
    };

    const withAttempts = input.httpAttempts
      ? {
          ...withRaw,
          httpAttempts: input.httpAttempts,
        }
      : withRaw;

    return input.diagnostics
      ? {
          ...withAttempts,
          diagnostics: input.diagnostics,
        }
      : withAttempts;
  }

  if (input.httpAttempts) {
    const withAttempts = {
      ...result,
      httpAttempts: input.httpAttempts,
    };

    return input.diagnostics
      ? {
          ...withAttempts,
          diagnostics: input.diagnostics,
        }
      : withAttempts;
  }

  if (input.diagnostics) {
    return {
      ...result,
      diagnostics: input.diagnostics,
    };
  }

  return result;
}
