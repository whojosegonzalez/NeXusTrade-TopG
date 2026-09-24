import {
  createProviderError,
  providerFailure,
  type ProviderName,
  type ProviderHttpAttempt,
  type ProviderResult,
} from "@nexustrade/shared";
import { ProviderAdmissionError } from "./providerRateLimiter.js";
import { withAbort } from "./providerAbort.js";

type Sleep = (delayMs: number) => Promise<void>;

export interface ProviderRetryOptions {
  readonly maxRetries: number;
  readonly retryBackoffMs: number;
  readonly sleep?: Sleep;
  readonly signal?: AbortSignal;
  /** Required when cancellation is supplied, so a pre-attempt result has an honest owner. */
  readonly provider?: ProviderName;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export async function withProviderRetries<T>(
  operation: () => Promise<ProviderResult<T>>,
  options: ProviderRetryOptions,
): Promise<ProviderResult<T>> {
  const sleep = options.sleep ?? defaultSleep;
  let attempt = 0;
  let attempts: readonly ProviderHttpAttempt[] = [];
  if (options.signal && !options.provider)
    throw new ProviderAdmissionError("ADMISSION_INVALID_CONFIG");
  const cancelled = (): ProviderResult<T> => {
    if (!options.provider) throw new ProviderAdmissionError("ADMISSION_INVALID_CONFIG");
    return providerFailure({
      provider: options.provider,
      error: createProviderError({
        code: "PROVIDER_UNAVAILABLE",
        message: "ADMISSION_CANCELLED",
        retryable: false,
      }),
      httpAttempts: attempts,
      diagnostics: { admissionControl: "ADMISSION_CANCELLED" },
    });
  };

  while (true) {
    if (options.signal?.aborted) return cancelled();
    const result = await operation();
    attempts = renumberAttempts([...attempts, ...(result.httpAttempts ?? [])]);
    const resultWithAttempts = attempts.length > 0 ? { ...result, httpAttempts: attempts } : result;
    if (options.signal?.aborted) return cancelled();

    if (result.ok || !result.error.retryable || attempt >= options.maxRetries) {
      return resultWithAttempts;
    }

    attempt += 1;

    if (options.retryBackoffMs > 0) {
      if (options.signal) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const wait = options.sleep
            ? options.sleep(options.retryBackoffMs * attempt)
            : new Promise<void>((resolve) => {
                timer = setTimeout(resolve, options.retryBackoffMs * attempt);
              });
          await withAbort(wait, options.signal);
        } catch (error) {
          if (options.signal.aborted) return cancelled();
          throw error;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      } else await sleep(options.retryBackoffMs * attempt);
    }
  }
}

function renumberAttempts(
  attempts: readonly ProviderHttpAttempt[],
): readonly ProviderHttpAttempt[] {
  return attempts.map((httpAttempt, index) => ({
    ...httpAttempt,
    attemptNumber: index + 1,
  }));
}
