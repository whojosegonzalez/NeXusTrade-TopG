import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export class ArchiveCatalogBuilder {
  constructor(
    private readonly options: {
      readonly archiveRoot: string;
      readonly includePhases: readonly string[];
      readonly includeCohorts: readonly string[];
    },
  ) {}

  validateIncludedPhases(): readonly string[] {
    const phases = [...this.options.includePhases].sort();
    for (const phase of phases) {
      const phasePath = this.phasePath(phase);
      if (!existsSync(phasePath) || !statSync(phasePath).isDirectory()) {
        throw new Error(`Dashboard export phase archive is unavailable: ${phase}.`);
      }
    }
    return phases;
  }

  directDirectories(phase: string): readonly string[] {
    return readdirSync(this.phasePath(phase))
      .sort()
      .filter((name) => !name.startsWith("legacy-root-artifacts-"))
      .map((name) => path.join(this.phasePath(phase), name))
      .filter((candidate) => statSync(candidate).isDirectory());
  }

  selectedCohortDirectories(phase: string): readonly string[] {
    const selected = this.options.includeCohorts
      .filter((cohort) => cohort.startsWith(`${phase}/`))
      .map((cohort) => path.join(this.options.archiveRoot, cohort));
    for (const directory of selected) {
      if (!existsSync(directory) || !statSync(directory).isDirectory()) {
        throw new Error(
          `Dashboard export cohort archive is unavailable: ${path.basename(directory)}.`,
        );
      }
    }
    return selected.length > 0 ? selected : this.directDirectories(phase);
  }

  private phasePath(phase: string): string {
    return path.join(this.options.archiveRoot, phase);
  }
}
