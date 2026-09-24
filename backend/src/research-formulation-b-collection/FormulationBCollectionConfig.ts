import { FormulationBCollectionError } from "./FormulationBCollectionErrors.js";
import type { FormulationBCollectionConfig } from "./FormulationBCollectionTypes.js";

export function parseFormulationBCollectionArgs(
  args: readonly string[],
): FormulationBCollectionConfig {
  let archiveRoot: string | null = null;
  let targetSlots = 96;
  let days = 8;
  let slotsPerDay = 12;
  let dryRun = false;
  let rateLimitMs = 1000;
  let requestTimeoutMs = 5000;

  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--once") {
      continue;
    }
    if (arg.startsWith("--archive-root=")) {
      if (archiveRoot !== null) {
        throw new FormulationBCollectionError(
          "FORMULATION_B_COLLECTION_INVALID_SCOPE",
          "Multiple --archive-root options provided",
        );
      }
      const val = arg.substring("--archive-root=".length).trim();
      if (!val) {
        throw new FormulationBCollectionError(
          "FORMULATION_B_COLLECTION_INVALID_SCOPE",
          "Empty --archive-root provided",
        );
      }
      if (
        val.includes("..") ||
        val.includes("*") ||
        val.includes("?") ||
        val.includes("<") ||
        val.includes(">") ||
        val.includes("|")
      ) {
        throw new FormulationBCollectionError(
          "FORMULATION_B_COLLECTION_INVALID_SCOPE",
          `Disallowed path shape in --archive-root: ${val}`,
        );
      }
      archiveRoot = val;
    } else if (arg.startsWith("--target-slots=")) {
      const parsed = Number.parseInt(arg.substring("--target-slots=".length).trim(), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new FormulationBCollectionError(
          "FORMULATION_B_COLLECTION_INVALID_SCOPE",
          `Invalid --target-slots: ${arg}`,
        );
      }
      targetSlots = parsed;
    } else if (arg.startsWith("--days=")) {
      const parsed = Number.parseInt(arg.substring("--days=".length).trim(), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new FormulationBCollectionError(
          "FORMULATION_B_COLLECTION_INVALID_SCOPE",
          `Invalid --days: ${arg}`,
        );
      }
      days = parsed;
    } else if (arg.startsWith("--slots-per-day=")) {
      const parsed = Number.parseInt(arg.substring("--slots-per-day=".length).trim(), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new FormulationBCollectionError(
          "FORMULATION_B_COLLECTION_INVALID_SCOPE",
          `Invalid --slots-per-day: ${arg}`,
        );
      }
      slotsPerDay = parsed;
    } else if (arg.startsWith("--rate-limit-ms=")) {
      const parsed = Number.parseInt(arg.substring("--rate-limit-ms=".length).trim(), 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new FormulationBCollectionError(
          "FORMULATION_B_COLLECTION_INVALID_SCOPE",
          `Invalid --rate-limit-ms: ${arg}`,
        );
      }
      rateLimitMs = parsed;
    } else if (arg.startsWith("--timeout-ms=")) {
      const parsed = Number.parseInt(arg.substring("--timeout-ms=".length).trim(), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new FormulationBCollectionError(
          "FORMULATION_B_COLLECTION_INVALID_SCOPE",
          `Invalid --timeout-ms: ${arg}`,
        );
      }
      requestTimeoutMs = parsed;
    } else {
      throw new FormulationBCollectionError(
        "FORMULATION_B_COLLECTION_INVALID_SCOPE",
        `Unrecognized argument: ${arg}`,
      );
    }
  }

  if (!archiveRoot) {
    throw new FormulationBCollectionError(
      "FORMULATION_B_COLLECTION_INVALID_SCOPE",
      "Missing required --archive-root argument",
    );
  }

  return {
    archiveRoot,
    targetSlots,
    days,
    slotsPerDay,
    dryRun,
    rateLimitMs,
    requestTimeoutMs,
  };
}
