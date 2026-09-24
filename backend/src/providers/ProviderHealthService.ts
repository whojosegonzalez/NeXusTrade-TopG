import type { ProviderHttpAttempt, ProviderName, ProviderResult } from "@nexustrade/shared";

import type { CreateProviderHealthInput } from "../db/repositories/ProviderHealthRepository.js";
import type { ProviderStatus } from "../db/schema/index.js";
import { stringifyJson } from "../db/utils/json.js";
import type { ProviderHealthRepository } from "../db/repositories/ProviderHealthRepository.js";
import type { CreateSystemLogInput } from "../db/repositories/SystemLogRepository.js";
import type { SystemLogRepository } from "../db/repositories/SystemLogRepository.js";

export interface ProviderHealthServiceOptions {
  readonly providerHealth: ProviderHealthRepository;
  readonly systemLogs?: SystemLogRepository;
  readonly sessionId?: string;
  readonly writeProviderHealth?: boolean;
  readonly writeSystemLog?: boolean;
}

export class ProviderHealthService {
  constructor(private readonly options: ProviderHealthServiceOptions) {}

  recordResult<T>(
    operation: string,
    result: ProviderResult<T>,
    context: Readonly<Record<string, unknown>> = {},
  ): void {
    if (this.options.writeProviderHealth !== false) {
      const input: CreateProviderHealthInput = {
        provider: result.provider,
        status: toProviderStatus(result),
        latencyMs: result.latencyMs,
        rateLimited: result.rateLimited,
        contextJson: stringifyJson({
          operation,
          warnings: result.warnings,
          ...(result.ok
            ? {}
            : {
                errorCode: result.error.code,
                statusCode: result.error.statusCode,
                retryable: result.error.retryable,
              }),
          ...summarizeHttpAttempts(result.httpAttempts),
          ...context,
        }),
      };

      if (this.options.sessionId) {
        input.sessionId = this.options.sessionId;
      }

      if (!result.ok) {
        input.errorMessage = result.error.message;
      }

      this.options.providerHealth.createProviderHealth(input);
    }

    if (this.options.writeSystemLog !== false) {
      const input: CreateSystemLogInput = {
        level: result.ok ? "INFO" : result.rateLimited ? "WARN" : "ERROR",
        scope: "PROVIDER",
        message: `${result.provider} ${operation} ${result.ok ? "succeeded" : "failed"}.`,
        contextJson: stringifyJson({
          provider: result.provider,
          operation,
          ok: result.ok,
          rateLimited: result.rateLimited,
        }),
      };

      if (this.options.sessionId) {
        input.sessionId = this.options.sessionId;
      }

      this.options.systemLogs?.createLog(input);
    }
  }

  recordDisabled(provider: ProviderName, reason: string): void {
    if (this.options.writeProviderHealth !== false) {
      const input: CreateProviderHealthInput = {
        provider,
        status: "DISABLED",
        rateLimited: false,
        errorMessage: reason,
        contextJson: stringifyJson({
          reason,
        }),
      };

      if (this.options.sessionId) {
        input.sessionId = this.options.sessionId;
      }

      this.options.providerHealth.createProviderHealth(input);
    }

    if (this.options.writeSystemLog !== false) {
      const input: CreateSystemLogInput = {
        level: "WARN",
        scope: "PROVIDER",
        message: `${provider} provider disabled.`,
        contextJson: stringifyJson({
          provider,
          reason,
        }),
      };

      if (this.options.sessionId) {
        input.sessionId = this.options.sessionId;
      }

      this.options.systemLogs?.createLog(input);
    }
  }
}

function summarizeHttpAttempts(
  attempts: readonly ProviderHttpAttempt[] | undefined,
): Record<string, unknown> {
  if (!attempts || attempts.length === 0) {
    return {};
  }

  const final = attempts[attempts.length - 1];

  return {
    httpAttemptCount: attempts.length,
    httpAttemptOutcomes: joinCounts(attempts.map((attempt) => attempt.outcome)),
    httpEndpointIds: joinCounts(attempts.map((attempt) => attempt.endpointId)),
    httpStatusCodes: joinCounts(
      attempts
        .map((attempt) => attempt.statusCode)
        .filter((statusCode): statusCode is number => statusCode !== undefined)
        .map(String),
    ),
    ...(final
      ? {
          httpFinalOutcome: final.outcome,
          ...(final.statusCode !== undefined ? { httpFinalStatusCode: final.statusCode } : {}),
        }
      : {}),
  };
}

function joinCounts(values: readonly string[]): string {
  const counts = new Map<string, number>();

  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join("|");
}

function toProviderStatus<T>(result: ProviderResult<T>): ProviderStatus {
  if (result.ok) {
    return result.warnings.length > 0 ? "DEGRADED" : "OK";
  }

  return result.rateLimited ? "RATE_LIMITED" : "ERROR";
}
