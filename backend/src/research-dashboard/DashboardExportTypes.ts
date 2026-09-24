import type {
  DashboardCandidate,
  DashboardCohort,
  DashboardManifest,
  DashboardRun,
} from "@nexustrade/shared";

export interface DashboardExportBundle {
  readonly manifest: DashboardManifest;
  readonly runs: readonly DashboardRun[];
  readonly cohorts: readonly DashboardCohort[];
  readonly candidates: readonly DashboardCandidate[];
}

export interface DashboardExportResult {
  readonly bundle: DashboardExportBundle;
  readonly writtenFiles: readonly string[];
}
