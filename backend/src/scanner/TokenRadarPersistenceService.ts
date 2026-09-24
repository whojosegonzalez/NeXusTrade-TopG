import type { CreateRadarEntryInput } from "../db/repositories/TokenRadarRepository.js";
import type { TokenRadarRecord } from "../db/schema/index.js";
import { stringifyJson } from "../db/utils/json.js";
import type { Repositories } from "../db/repositories/index.js";

export interface TokenRadarPersistenceOptions {
  readonly repositories: Pick<Repositories, "systemLogs" | "tokenRadar">;
  readonly sessionId: string;
  readonly dryRun: boolean;
}

export interface TokenRadarPersistenceResult {
  readonly attemptedCount: number;
  readonly storedCount: number;
  readonly skippedCount: number;
  readonly errorCount: number;
  readonly records: readonly TokenRadarRecord[];
  readonly errors: readonly string[];
}

export class TokenRadarPersistenceService {
  constructor(private readonly options: TokenRadarPersistenceOptions) {}

  persist(records: readonly CreateRadarEntryInput[]): TokenRadarPersistenceResult {
    if (this.options.dryRun) {
      this.writeLog("Scanner dry-run skipped TokenRadar writes.", {
        attemptedCount: records.length,
      });

      return {
        attemptedCount: records.length,
        storedCount: 0,
        skippedCount: records.length,
        errorCount: 0,
        records: [],
        errors: [],
      };
    }

    const storedRecords: TokenRadarRecord[] = [];
    const errors: string[] = [];

    for (const record of records) {
      try {
        storedRecords.push(this.options.repositories.tokenRadar.upsertRadarEntry(record));
      } catch (error) {
        errors.push(
          error instanceof Error ? error.message : "Unknown TokenRadar persistence error.",
        );
      }
    }

    this.writeLog("Scanner TokenRadar persistence completed.", {
      attemptedCount: records.length,
      storedCount: storedRecords.length,
      errorCount: errors.length,
    });

    return {
      attemptedCount: records.length,
      storedCount: storedRecords.length,
      skippedCount: 0,
      errorCount: errors.length,
      records: storedRecords,
      errors,
    };
  }

  private writeLog(message: string, context: unknown): void {
    this.options.repositories.systemLogs.createLog({
      sessionId: this.options.sessionId,
      level: "INFO",
      scope: "SCANNER",
      message,
      contextJson: stringifyJson(context),
    });
  }
}
