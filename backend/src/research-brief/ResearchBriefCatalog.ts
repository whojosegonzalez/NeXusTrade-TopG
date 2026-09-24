import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { ResearchBriefConfig } from "./ResearchBriefConfig.js";
import { ResearchBriefError } from "./ResearchBriefErrors.js";

export interface ResearchBriefSource {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly value: unknown;
}

export interface ResearchBriefCatalogResult {
  readonly phase928RunnerSources: readonly ResearchBriefSource[];
  readonly phase929AttributionSources: readonly ResearchBriefSource[];
  readonly skippedInputs: readonly { readonly path: string; readonly reason: string }[];
}

export class ResearchBriefCatalog {
  constructor(
    private readonly options: {
      readonly archiveRoot: string;
      readonly config: ResearchBriefConfig;
    },
  ) {}

  discover(): ResearchBriefCatalogResult {
    const phases = [...this.options.config.includePhases].sort();
    for (const phase of phases) this.assertPhaseDirectory(phase);

    return {
      phase928RunnerSources: phases.includes("phase9.28")
        ? this.discoverPhase928RunnerSources()
        : [],
      phase929AttributionSources: phases.includes("phase9.29")
        ? this.discoverPhase929AttributionSources()
        : [],
      skippedInputs: phases.includes("phase9.28")
        ? [{ path: "phase9.28/legacy-root-artifacts-20260818", reason: "LEGACY_CLEANUP_COPY" }]
        : [],
    };
  }

  private discoverPhase928RunnerSources(): readonly ResearchBriefSource[] {
    const phasePath = this.phasePath("phase9.28");
    return readdirSync(phasePath)
      .sort()
      .filter((name) => !name.startsWith("legacy-root-artifacts-"))
      .map((name) => path.join(phasePath, name))
      .filter((candidate) => statSync(candidate).isDirectory())
      .flatMap((archivePath) => {
        const runnerOutput = path.join(archivePath, "runner-output");
        if (!existsSync(runnerOutput) || !statSync(runnerOutput).isDirectory()) return [];
        const jsonNames = readdirSync(runnerOutput)
          .filter((name) => name.endsWith(".json"))
          .sort();
        if (jsonNames.length !== 1) {
          throw new ResearchBriefError(
            "RESEARCH_BRIEF_UNSUPPORTED_REPORT",
            `Phase 9.28 runner archive must contain exactly one canonical JSON report: ${this.relativePath(archivePath)}.`,
          );
        }
        return [this.readSource(path.join(runnerOutput, jsonNames[0] as string))];
      });
  }

  private discoverPhase929AttributionSources(): readonly ResearchBriefSource[] {
    const cohort = this.options.config.includeCohorts[0];
    if (!cohort) {
      throw new ResearchBriefError(
        "RESEARCH_BRIEF_AMBIGUOUS_REPORT",
        "Phase 9.29 requires one explicit canonical attribution cohort.",
      );
    }
    const cohortPath = this.containedPath(cohort);
    if (!existsSync(cohortPath) || !statSync(cohortPath).isDirectory()) {
      throw new ResearchBriefError(
        "RESEARCH_BRIEF_INVALID_SCOPE",
        "The requested Phase 9.29 cohort is unavailable.",
      );
    }
    const jsonNames = readdirSync(cohortPath)
      .filter((name) => name.endsWith(".json"))
      .sort();
    if (jsonNames.length === 0) {
      throw new ResearchBriefError(
        "RESEARCH_BRIEF_UNSUPPORTED_REPORT",
        "The requested Phase 9.29 cohort contains no canonical JSON report.",
      );
    }
    return jsonNames.map((name) => this.readSource(path.join(cohortPath, name)));
  }

  private assertPhaseDirectory(phase: string): void {
    const phasePath = this.phasePath(phase);
    if (!existsSync(phasePath) || !statSync(phasePath).isDirectory()) {
      throw new ResearchBriefError(
        "RESEARCH_BRIEF_INVALID_SCOPE",
        `The requested ${phase} archive is unavailable.`,
      );
    }
  }

  private readSource(absolutePath: string): ResearchBriefSource {
    const bytes = readFileSync(absolutePath);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw new ResearchBriefError(
        "RESEARCH_BRIEF_UNSUPPORTED_REPORT",
        `A selected source is not valid canonical JSON: ${this.relativePath(absolutePath)}.`,
      );
    }
    return {
      absolutePath,
      relativePath: this.relativePath(absolutePath),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      value,
    };
  }

  private phasePath(phase: string): string {
    return this.containedPath(phase);
  }

  private containedPath(relativePath: string): string {
    const candidate = path.resolve(this.options.archiveRoot, relativePath);
    const relative = path.relative(this.options.archiveRoot, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new ResearchBriefError(
        "RESEARCH_BRIEF_INVALID_SCOPE",
        "Research brief encountered an archive path outside data/archive.",
      );
    }
    return candidate;
  }

  private relativePath(absolutePath: string): string {
    const relative = path.relative(this.options.archiveRoot, absolutePath).replace(/\\/g, "/");
    if (relative.startsWith("../") || path.isAbsolute(relative)) {
      throw new ResearchBriefError(
        "RESEARCH_BRIEF_INVALID_SCOPE",
        "Research brief encountered a source path outside data/archive.",
      );
    }
    return relative;
  }
}
