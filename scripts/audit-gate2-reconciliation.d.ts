export const DEFAULT_GATE2_SESSION_DIR: string;

export function computeSha256Hex(data: Buffer | string): string;

export function countNonEmptyLines(text: string): number;

export interface Gate2ReconciliationAuditResult {
  readonly success: boolean;
  readonly errors: readonly string[];
  readonly details: {
    readonly decisionsCount: number;
    readonly diagnosticsCount: number;
    readonly manifestFileCount: number;
    readonly crossTab: Record<string, unknown>;
  } | null;
}

export function runGate2ReconciliationAudit(
  sessionDir?: string,
  options?: { silent?: boolean },
): Gate2ReconciliationAuditResult;
