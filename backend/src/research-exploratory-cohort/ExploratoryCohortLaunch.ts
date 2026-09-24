import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import {
  EXPLORATORY_COHORT_LAUNCH_PREFIX,
  EXPLORATORY_COHORT_PROTOCOL_PATH,
  EXPLORATORY_COHORT_PROTOCOL_SHA256,
  EXPLORATORY_COHORT_PROTOCOL_VALIDATION_FINGERPRINT,
} from "./ExploratoryCohortConstants.js";
import { getExploratoryCohortRepoRoot } from "./ExploratoryCohortConfig.js";
import { ExploratoryCohortError } from "./ExploratoryCohortErrors.js";
import type {
  ExploratoryCohortConfig,
  ExploratoryCohortLaunchRecord,
} from "./ExploratoryCohortTypes.js";

const launchRecordSchema = z
  .object({
    contractVersion: z.literal("1"),
    archiveRoot: z.string().min(1),
    cohortStartAt: z.string().datetime(),
    protocolPath: z.literal(EXPLORATORY_COHORT_PROTOCOL_PATH),
    protocolSha256: z.literal(EXPLORATORY_COHORT_PROTOCOL_SHA256),
    protocolValidationFingerprint: z.literal(EXPLORATORY_COHORT_PROTOCOL_VALIDATION_FINGERPRINT),
    authorization: z.literal("USER_AUTHORIZED_FOR_ONE_OBSERVATIONAL_COLLECTION"),
    authorizationReference: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9._:-]+$/),
  })
  .strict();

export function loadExploratoryCohortLaunchRecord(
  config: ExploratoryCohortConfig,
): ExploratoryCohortLaunchRecord {
  const launchPath = resolveExploratoryCohortLaunchRecordPath(config);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(launchPath, "utf8")) as unknown;
  } catch {
    throw precondition("The source-controlled launch record is unavailable or invalid.");
  }
  const parsed = launchRecordSchema.safeParse(raw);
  if (!parsed.success || !isLaunchRecordConsistent(parsed.data, config)) {
    throw precondition("The source-controlled launch record does not match the approved V2 root.");
  }
  assertSafeLaunchRecord(parsed.data);
  return parsed.data;
}

export function resolveExploratoryCohortLaunchRecordPath(config: ExploratoryCohortConfig): string {
  const repoRoot = getExploratoryCohortRepoRoot();
  const expectedDirectory = path.join(repoRoot, "docs", "research-launches");
  const relative = `${EXPLORATORY_COHORT_LAUNCH_PREFIX}${config.archiveStamp}.json`;
  const resolved = path.resolve(repoRoot, relative);
  if (path.dirname(resolved) !== expectedDirectory)
    throw precondition("Invalid launch record path.");
  return resolved;
}

export function assertExploratoryCohortProtocolBytes(bytes: Uint8Array): void {
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== EXPLORATORY_COHORT_PROTOCOL_SHA256) {
    throw new ExploratoryCohortError(
      "EXPLORATORY_COHORT_PROTOCOL_INCONSISTENCY",
      "The pinned V2 protocol hash does not match.",
    );
  }
}

export function parseExploratoryCohortLaunchRecord(value: unknown): ExploratoryCohortLaunchRecord {
  const parsed = launchRecordSchema.safeParse(value);
  if (!parsed.success) throw precondition("The launch record schema is invalid.");
  assertSafeLaunchRecord(parsed.data);
  return parsed.data;
}

function isLaunchRecordConsistent(
  record: ExploratoryCohortLaunchRecord,
  config: ExploratoryCohortConfig,
): boolean {
  const expectedStart = `${config.archiveStamp.slice(0, 4)}-${config.archiveStamp.slice(4, 6)}-${config.archiveStamp.slice(6, 8)}T00:00:00.000Z`;
  return record.archiveRoot === config.archiveRoot && record.cohortStartAt === expectedStart;
}

function assertSafeLaunchRecord(record: ExploratoryCohortLaunchRecord): void {
  for (const value of Object.values(record)) {
    if (
      typeof value === "string" &&
      /https?:\/\/|authorization|bearer|api[ _-]?key|password|secret/i.test(value)
    ) {
      throw precondition("The launch record contains unsafe content.");
    }
  }
}

function precondition(message: string): ExploratoryCohortError {
  return new ExploratoryCohortError("EXPLORATORY_COHORT_PRECONDITION_UNMET", message);
}
