import {
  createProviderError,
  mapHttpStatusToProviderErrorCode,
  normalizeUnknownProviderError,
  providerFailure,
  providerSuccess,
  type ProviderError,
  type ProviderErrorCode,
  type ProviderHttpAttempt,
  type ProviderHttpAttemptOutcome,
  type ProviderName,
  type ProviderResult,
} from "@nexustrade/shared";

import {
  ProviderAdmissionError,
  type ProviderAdmissionControls,
  type ProviderRateLimiter,
} from "./providerRateLimiter.js";
import { withAbort } from "./providerAbort.js";

type QueryValue = boolean | number | string | undefined;

export interface ProviderHttpClientOptions {
  readonly provider: ProviderName;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly rateLimitPerMinute: number;
  readonly rateLimiter?: ProviderRateLimiter;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
}

export interface ProviderJsonRequestOptions extends ProviderAdmissionControls {
  readonly path?: string;
  readonly operation?: string;
  readonly endpointId?: string;
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly allowRawPayloadLogging?: boolean;
}

interface ResponsePayload {
  readonly value: unknown;
  readonly text?: string;
}

export class ProviderHttpClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ProviderHttpClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  getJson<T>(options: ProviderJsonRequestOptions = {}): Promise<ProviderResult<T>> {
    return this.requestJson<T>("GET", options);
  }

  postJson<T>(options: ProviderJsonRequestOptions = {}): Promise<ProviderResult<T>> {
    return this.requestJson<T>("POST", options);
  }

  private async requestJson<T>(
    method: "GET" | "POST",
    options: ProviderJsonRequestOptions,
  ): Promise<ProviderResult<T>> {
    const startMs = Date.now();
    const fetchedAt = new Date();
    let dispatched = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const abort = () => controller.abort(new ProviderAdmissionError("ADMISSION_CANCELLED"));

    try {
      if (options.signal?.aborted) throw new ProviderAdmissionError("ADMISSION_CANCELLED");
      if (
        options.maxQueueWaitMs !== undefined &&
        (!Number.isSafeInteger(options.maxQueueWaitMs) || options.maxQueueWaitMs < 0)
      )
        throw new ProviderAdmissionError("ADMISSION_INVALID_CONFIG");
      if (options.maxQueueWaitMs === 0) throw new ProviderAdmissionError("ADMISSION_DEADLINE");
      const rateLimitDecision = await this.options.rateLimiter?.waitForSlot(
        this.options.provider,
        this.options.rateLimitPerMinute,
        options,
      );
      if (options.signal?.aborted) throw new ProviderAdmissionError("ADMISSION_CANCELLED");
      options.signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        () => controller.abort(new DOMException("Provider request timed out.", "TimeoutError")),
        this.options.timeoutMs,
      );
      const requestInit: RequestInit = {
        method,
        headers: this.buildHeaders(options),
        signal: controller.signal,
      };

      if (options.body !== undefined) {
        requestInit.body = JSON.stringify(options.body);
      }

      const url = this.buildUrl(options);
      if (controller.signal.aborted) throw controller.signal.reason;
      dispatched = true;
      const response = await withAbort(this.fetchImpl(url, requestInit), controller.signal);
      const latencyMs = Date.now() - startMs;
      const payload = await withAbort(readResponsePayload(response), controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason;
      const rateLimitHints = readRateLimitHints(response.headers);

      if (!response.ok) {
        const code = mapHttpStatusToProviderErrorCode(response.status);
        const error = createProviderError({
          code,
          message: extractErrorMessage(payload, response.status),
          statusCode: response.status,
        });
        const attempt = this.createHttpAttempt({
          method,
          options,
          attemptNumber: 1,
          outcome: response.status === 429 ? "RATE_LIMITED" : "HTTP_ERROR",
          latencyMs,
          ...(rateLimitDecision?.waitedMs !== undefined
            ? { rateLimiterWaitMs: rateLimitDecision.waitedMs }
            : {}),
          statusCode: response.status,
          failureCode: code,
          retryable: error.retryable,
          rateLimitHints,
        });

        return providerFailure({
          provider: this.options.provider,
          error,
          fetchedAt,
          latencyMs,
          rateLimited: response.status === 429,
          httpAttempts: [attempt],
        });
      }

      const warnings =
        rateLimitDecision?.delayed === true
          ? [`Rate limiter waited ${rateLimitDecision.waitedMs}ms before request.`]
          : [];

      return providerSuccess({
        provider: this.options.provider,
        data: payload.value as T,
        fetchedAt,
        latencyMs,
        warnings,
        raw: options.allowRawPayloadLogging ? payload.value : undefined,
        httpAttempts: [
          this.createHttpAttempt({
            method,
            options,
            attemptNumber: 1,
            outcome: "OK",
            latencyMs,
            ...(rateLimitDecision?.waitedMs !== undefined
              ? { rateLimiterWaitMs: rateLimitDecision.waitedMs }
              : {}),
            statusCode: response.status,
            retryable: false,
            rateLimitHints,
          }),
        ],
      });
    } catch (error) {
      const control =
        error instanceof ProviderAdmissionError
          ? error
          : controller.signal.reason instanceof ProviderAdmissionError
            ? controller.signal.reason
            : undefined;
      const normalized = control
        ? createProviderError({
            code: "PROVIDER_UNAVAILABLE",
            message: control.code,
            retryable: false,
          })
        : normalizeUnknownProviderError(error);

      return providerFailure({
        provider: this.options.provider,
        error: normalized,
        fetchedAt,
        latencyMs: Date.now() - startMs,
        ...(control ? { diagnostics: { admissionControl: control.code } } : {}),
        httpAttempts: dispatched
          ? [
              this.createHttpAttempt({
                method,
                options,
                attemptNumber: 1,
                outcome: toErrorOutcome(normalized),
                latencyMs: Date.now() - startMs,
                failureCode: normalized.code,
                retryable: normalized.retryable,
              }),
            ]
          : [],
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  private buildUrl(options: ProviderJsonRequestOptions): URL {
    const url = options.path
      ? new URL(
          options.path,
          this.options.baseUrl.endsWith("/") ? this.options.baseUrl : `${this.options.baseUrl}/`,
        )
      : new URL(this.options.baseUrl);

    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    return url;
  }

  private buildHeaders(options: ProviderJsonRequestOptions): HeadersInit {
    return {
      Accept: "application/json",
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(this.options.defaultHeaders ?? {}),
      ...(options.headers ?? {}),
    };
  }

  private createHttpAttempt(input: {
    readonly method: "GET" | "POST";
    readonly options: ProviderJsonRequestOptions;
    readonly attemptNumber: number;
    readonly outcome: ProviderHttpAttemptOutcome;
    readonly latencyMs: number;
    readonly rateLimiterWaitMs?: number;
    readonly statusCode?: number;
    readonly failureCode?: ProviderErrorCode;
    readonly retryable: boolean;
    readonly rateLimitHints?: RateLimitHints;
  }): ProviderHttpAttempt {
    const attempt: ProviderHttpAttempt = {
      provider: this.options.provider,
      operation: sanitizeIdentifier(input.options.operation ?? input.options.path ?? "request"),
      endpointId: sanitizeIdentifier(input.options.endpointId ?? input.options.path ?? "root"),
      method: input.method,
      attemptNumber: input.attemptNumber,
      outcome: input.outcome,
      latencyMs: input.latencyMs,
      retryable: input.retryable,
    };

    return {
      ...attempt,
      ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
      ...(input.rateLimiterWaitMs !== undefined && input.rateLimiterWaitMs > 0
        ? { rateLimiterWaitMs: input.rateLimiterWaitMs }
        : {}),
      ...(input.failureCode ? { failureCode: input.failureCode } : {}),
      ...(input.rateLimitHints?.rateLimitRemaining !== undefined
        ? { rateLimitRemaining: input.rateLimitHints.rateLimitRemaining }
        : {}),
      ...(input.rateLimitHints?.rateLimitResetAtMs !== undefined
        ? { rateLimitResetAtMs: input.rateLimitHints.rateLimitResetAtMs }
        : {}),
      ...(input.rateLimitHints?.retryAfterMs !== undefined
        ? { retryAfterMs: input.rateLimitHints.retryAfterMs }
        : {}),
    };
  }
}

interface RateLimitHints {
  readonly rateLimitRemaining?: number;
  readonly rateLimitResetAtMs?: number;
  readonly retryAfterMs?: number;
}

async function readResponsePayload(response: Response): Promise<ResponsePayload> {
  const text = await response.text();

  if (text.length === 0) {
    return {
      value: undefined,
    };
  }

  try {
    return {
      value: JSON.parse(text),
      text,
    };
  } catch {
    return {
      value: text,
      text,
    };
  }
}

function extractErrorMessage(payload: ResponsePayload, statusCode: number): string {
  const value = payload.value;

  if (value && typeof value === "object") {
    const maybeMessage = "message" in value ? value.message : undefined;
    const maybeError = "error" in value ? value.error : undefined;

    if (typeof maybeMessage === "string") {
      return maybeMessage;
    }

    if (typeof maybeError === "string") {
      return maybeError;
    }
  }

  if (payload.text) {
    return payload.text.slice(0, 200);
  }

  return `Provider request failed with HTTP ${statusCode}.`;
}

function readRateLimitHints(headers: Headers): RateLimitHints {
  return {
    ...readIntegerHeader(headers, "x-ratelimit-remaining", "rateLimitRemaining"),
    ...readResetHeader(headers),
    ...readRetryAfterHeader(headers),
  };
}

function readIntegerHeader(
  headers: Headers,
  name: string,
  target: "rateLimitRemaining",
): Pick<RateLimitHints, typeof target> {
  const raw = headers.get(name);
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;

  return Number.isFinite(parsed) ? { [target]: parsed } : {};
}

function readResetHeader(headers: Headers): Pick<RateLimitHints, "rateLimitResetAtMs"> {
  const raw = headers.get("x-ratelimit-reset");
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return {};
  }

  return {
    rateLimitResetAtMs: parsed < 10_000_000_000 ? parsed * 1_000 : parsed,
  };
}

function readRetryAfterHeader(headers: Headers): Pick<RateLimitHints, "retryAfterMs"> {
  const raw = headers.get("retry-after");

  if (!raw) {
    return {};
  }

  const seconds = Number.parseInt(raw, 10);

  if (Number.isFinite(seconds)) {
    return {
      retryAfterMs: seconds * 1_000,
    };
  }

  const dateMs = Date.parse(raw);

  return Number.isFinite(dateMs) ? { retryAfterMs: Math.max(0, dateMs - Date.now()) } : {};
}

function toErrorOutcome(error: ProviderError): ProviderHttpAttemptOutcome {
  switch (error.code) {
    case "TIMEOUT":
      return "TIMEOUT";
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    case "INVALID_RESPONSE":
      return "INVALID_RESPONSE";
    case "NETWORK_ERROR":
      return "NETWORK_ERROR";
    default:
      return "NETWORK_ERROR";
  }
}

function sanitizeIdentifier(value: string): string {
  return value
    .replace(/[^A-Za-z0-9_.:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}
