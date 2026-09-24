import { existsSync, statSync } from "node:fs";
import path from "node:path";

import {
  parseResearchBriefArgs,
  type ResearchBriefConfig,
  type ResearchBriefFormat,
} from "../research-brief/ResearchBriefConfig.js";
import { ResearchBriefError } from "../research-brief/ResearchBriefErrors.js";
import { getResearchBriefRepoRoot } from "../research-brief/ResearchBriefPaths.js";
import { ResearchReviewGateError } from "./ResearchReviewGateErrors.js";

export const INITIAL_REVIEW_RECORD_PATH =
  "docs/research-reviews/phase10.5-initial.v1.json" as const;
export const INITIAL_REVIEW_COHORT = "phase9.29/combined-valid-three-20260818-1539" as const;

export interface ResearchReviewGateConfig {
  readonly briefConfig: ResearchBriefConfig;
  readonly reviewRecord: typeof INITIAL_REVIEW_RECORD_PATH;
  readonly format: ResearchBriefFormat;
}

export function parseResearchReviewGateArgs(argv: readonly string[]): ResearchReviewGateConfig {
  let reviewRecord: typeof INITIAL_REVIEW_RECORD_PATH | undefined;
  const briefArgs: string[] = [];

  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg.startsWith("--review-record=")) {
      if (reviewRecord) {
        throw invalidScope("Research review gate accepts exactly one --review-record.");
      }
      reviewRecord = parseReviewRecord(arg.slice("--review-record=".length));
      continue;
    }
    if (arg === "--review-record") {
      throw invalidScope("Research review gate requires --review-record=<relative-path>.");
    }
    briefArgs.push(arg);
  }

  if (!reviewRecord) {
    throw invalidScope("Research review gate requires the explicit initial review record.");
  }

  const briefConfig = parseInitialBriefConfig(briefArgs);
  return { briefConfig, reviewRecord, format: briefConfig.format };
}

export function resolveResearchReviewRecord(config: ResearchReviewGateConfig): string {
  const repoRoot = getResearchBriefRepoRoot();
  const expectedDirectory = path.join(repoRoot, "docs", "research-reviews");
  const resolved = path.resolve(repoRoot, config.reviewRecord);
  const relative = path.relative(expectedDirectory, resolved);
  if (
    config.reviewRecord !== INITIAL_REVIEW_RECORD_PATH ||
    relative !== path.basename(INITIAL_REVIEW_RECORD_PATH) ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !existsSync(resolved) ||
    !statSync(resolved).isFile()
  ) {
    throw invalidRecord(
      "The requested review record is unavailable or outside the approved catalog.",
    );
  }
  return resolved;
}

function parseInitialBriefConfig(argv: readonly string[]): ResearchBriefConfig {
  let briefConfig: ResearchBriefConfig;
  try {
    briefConfig = parseResearchBriefArgs(argv);
  } catch (error: unknown) {
    if (error instanceof ResearchBriefError) {
      throw invalidScope("Research review gate rejected the archive scope.");
    }
    throw error;
  }

  if (
    briefConfig.includePhases.length !== 2 ||
    briefConfig.includePhases[0] !== "phase9.28" ||
    briefConfig.includePhases[1] !== "phase9.29" ||
    briefConfig.includeCohorts.length !== 1 ||
    briefConfig.includeCohorts[0] !== INITIAL_REVIEW_COHORT
  ) {
    throw invalidScope(
      "Research review gate accepts only the approved Phase 9.28/9.29 archive scope.",
    );
  }
  return briefConfig;
}

function parseReviewRecord(value: string): typeof INITIAL_REVIEW_RECORD_PATH {
  const normalized = value.trim().replace(/\\/g, "/");
  if (
    normalized !== INITIAL_REVIEW_RECORD_PATH ||
    path.isAbsolute(value) ||
    normalized.includes("..") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(normalized)
  ) {
    throw invalidScope(
      "Research review gate accepts only the approved repository-relative review record.",
    );
  }
  return INITIAL_REVIEW_RECORD_PATH;
}

function invalidScope(message: string): ResearchReviewGateError {
  return new ResearchReviewGateError("RESEARCH_REVIEW_INVALID_SCOPE", message);
}

function invalidRecord(message: string): ResearchReviewGateError {
  return new ResearchReviewGateError("RESEARCH_REVIEW_INVALID_RECORD", message);
}
