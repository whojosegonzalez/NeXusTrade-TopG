import path from "node:path";

import { MeasurementCohortArchiveService } from "./MeasurementCohortArchiveService.js";
import { SystemMeasurementCohortClock } from "./MeasurementCohortClock.js";
import {
  parseMeasurementCohortArgs,
  resolveFixedMeasurementProtocol,
  resolveMeasurementLaunch,
  measurementCohortRepoRoot,
} from "./MeasurementCohortConfig.js";
import { createDirectMeasurementCohortGateway } from "./DirectMeasurementCohortGateway.js";
import { formatMeasurementCollection } from "./MeasurementCohortFormatter.js";
import { assertLaunchProtocolIdentity, loadMeasurementLaunch } from "./MeasurementCohortLaunch.js";
import { loadPinnedMeasurementProtocol } from "./MeasurementCohortProtocol.js";
import { MeasurementCohortRunner } from "./MeasurementCohortRunner.js";

export async function runMeasurementCohortCli(argv: readonly string[]): Promise<string> {
  const config = parseMeasurementCohortArgs(argv);
  const protocolPath = resolveFixedMeasurementProtocol(config);
  loadPinnedMeasurementProtocol(protocolPath);
  const launch = loadMeasurementLaunch(resolveMeasurementLaunch(config));
  assertLaunchProtocolIdentity(launch);
  const archiveRoot = path.resolve(measurementCohortRepoRoot(), launch.archiveRoot);
  const clock = new SystemMeasurementCohortClock();
  const archive = new MeasurementCohortArchiveService(archiveRoot, launch, () => clock.now());
  // Deliberately delayed: all fixed identity and launch checks above must pass before construction.
  const runner = new MeasurementCohortRunner({
    launch,
    archive,
    clock,
    gateway: createDirectMeasurementCohortGateway(),
  });
  const result = await runner.runOnce();
  return formatMeasurementCollection(result, config.format);
}
