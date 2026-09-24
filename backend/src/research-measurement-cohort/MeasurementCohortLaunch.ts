import { readFileSync } from "node:fs";

import { z } from "zod";

import {
  MEASUREMENT_COHORT_ARCHIVE_PREFIX,
  MEASUREMENT_COHORT_PROTOCOL_PATH,
  MEASUREMENT_COHORT_PROTOCOL_SHA256,
  MEASUREMENT_COHORT_STATIC_FINGERPRINT,
} from "./MeasurementCohortConstants.js";
import { MeasurementCohortError } from "./MeasurementCohortErrors.js";
import type { MeasurementCohortLaunchRecord } from "./MeasurementCohortTypes.js";

const launchSchema = z
  .object({
    contractVersion: z.literal("1"),
    archiveRoot: z.string().regex(/^data\/archive\/phase10\.6a\/measurement-v3-\d{8}-\d{4}Z\/$/),
    cohortStartAt: z.string().datetime({ offset: true }),
    protocolPath: z.literal(MEASUREMENT_COHORT_PROTOCOL_PATH),
    protocolSha256: z.literal(MEASUREMENT_COHORT_PROTOCOL_SHA256),
    protocolValidationFingerprint: z.literal(MEASUREMENT_COHORT_STATIC_FINGERPRINT),
    authorization: z.literal("USER_AUTHORIZED_FOR_ONE_MEASUREMENT_ONLY_COLLECTION"),
    authorizationReference: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9._ -]+$/),
    operator: z
      .object({
        kind: z.literal("EXTERNAL_OPERATOR"),
        label: z
          .string()
          .min(1)
          .max(80)
          .regex(/^[A-Za-z0-9._ -]+$/),
      })
      .strict(),
  })
  .strict();

export function loadMeasurementLaunch(launchPath: string): MeasurementCohortLaunchRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(launchPath, "utf8")) as unknown;
  } catch {
    throw invalidLaunch("The V3 launch record cannot be parsed.");
  }
  const parsed = launchSchema.safeParse(raw);
  if (!parsed.success)
    throw invalidLaunch("The V3 launch record does not match its strict schema.");
  const launch = parsed.data;
  const rootStamp = launch.archiveRoot.slice(MEASUREMENT_COHORT_ARCHIVE_PREFIX.length, -1);
  const start = new Date(launch.cohortStartAt);
  const expectedStamp = `${start.toISOString().slice(0, 10).replaceAll("-", "")}-${start
    .toISOString()
    .slice(11, 16)
    .replace(":", "")}Z`;
  if (rootStamp !== expectedStamp || Number.isNaN(start.valueOf())) {
    throw invalidLaunch("The V3 launch root and UTC cohort start are inconsistent.");
  }
  return launch;
}

export function assertLaunchProtocolIdentity(launch: MeasurementCohortLaunchRecord): void {
  if (
    launch.protocolPath !== MEASUREMENT_COHORT_PROTOCOL_PATH ||
    launch.protocolSha256 !== MEASUREMENT_COHORT_PROTOCOL_SHA256 ||
    launch.protocolValidationFingerprint !== MEASUREMENT_COHORT_STATIC_FINGERPRINT
  ) {
    throw invalidLaunch("The V3 launch record does not match the fixed protocol identity.");
  }
}

export function measurementLaunchSchemaForTests(): z.ZodType<MeasurementCohortLaunchRecord> {
  return launchSchema;
}

function invalidLaunch(message: string): MeasurementCohortError {
  return new MeasurementCohortError("MEASUREMENT_COHORT_LAUNCH_INCONSISTENCY", message);
}
