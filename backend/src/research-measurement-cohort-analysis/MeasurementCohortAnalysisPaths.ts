import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const analysisDirectory = path.dirname(fileURLToPath(import.meta.url));

export function getMeasurementCohortAnalysisRepoRoot(): string {
  return path.resolve(analysisDirectory, "..", "..", "..");
}

/** Reject redirection anywhere along a fixed repository path, including above the repo root. */
export function isSafeMeasurementCohortAnalysisPath(
  repoRoot: string,
  candidate: string,
  kind: "file" | "directory",
): boolean {
  const root = path.resolve(repoRoot);
  const target = path.resolve(candidate);
  const relative = path.relative(root, target);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    return false;

  try {
    let current = path.parse(target).root;
    for (const component of target.slice(current.length).split(path.sep)) {
      current = path.join(current, component);
      const stat = lstatSync(current);
      const needsFile = current === target && kind === "file";
      if (stat.isSymbolicLink() || !(needsFile ? stat.isFile() : stat.isDirectory())) {
        return false;
      }
    }
    return path.relative(target, realpathSync(target)) === "";
  } catch {
    // Missing paths and filesystem errors share the caller's bounded, fail-closed error.
    return false;
  }
}
