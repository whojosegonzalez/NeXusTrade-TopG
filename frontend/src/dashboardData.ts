import {
  dashboardCandidateSchema,
  dashboardCohortSchema,
  dashboardManifestSchema,
  dashboardRunSchema,
} from "@nexustrade/shared";
import type {
  DashboardCandidate,
  DashboardCohort,
  DashboardManifest,
  DashboardRun,
} from "@nexustrade/shared";
import { z } from "zod";

const defaultBasePath = "/research-dashboard-data";
const allowedResources = new Set(["runs.v1.json", "cohorts.v1.json", "candidates.v1.json"]);

export interface DashboardData {
  readonly manifest: DashboardManifest;
  readonly runs: readonly DashboardRun[];
  readonly cohorts: readonly DashboardCohort[];
  readonly candidates: readonly DashboardCandidate[];
}

export async function loadDashboardData(): Promise<DashboardData> {
  const manifest = dashboardManifestSchema.parse(
    await fetchJson(`${defaultBasePath}/manifest.v1.json`),
  );
  const [runs, cohorts, candidates] = await Promise.all([
    fetchJson(resourceUrl(manifest.resources.runs.path)).then((value) =>
      z.array(dashboardRunSchema).parse(value),
    ),
    fetchJson(resourceUrl(manifest.resources.cohorts.path)).then((value) =>
      z.array(dashboardCohortSchema).parse(value),
    ),
    fetchJson(resourceUrl(manifest.resources.candidates.path)).then((value) =>
      z.array(dashboardCandidateSchema).parse(value),
    ),
  ]);

  return { manifest, runs, cohorts, candidates };
}

function resourceUrl(resourcePath: string): string {
  if (!allowedResources.has(resourcePath)) {
    throw new Error(`Dashboard manifest requested an unsupported resource: ${resourcePath}.`);
  }
  return `${defaultBasePath}/${resourcePath}`;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { method: "GET", credentials: "same-origin" });
  if (!response.ok) throw new Error(`Could not load local dashboard data (${response.status}).`);
  return response.json();
}
