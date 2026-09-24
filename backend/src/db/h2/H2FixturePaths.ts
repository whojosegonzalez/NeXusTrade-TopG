import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const h2FixtureRoot = fileURLToPath(new URL("../../../../.tmp/h2/", import.meta.url));

export function assertH2FixturePath(file: string): void {
  const relative = path.relative(h2FixtureRoot, path.resolve(file));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("H2 fixture path escapes its owned root");
  let current = path.parse(path.resolve(file)).root;
  for (const part of path.resolve(file).slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink() || realpathSync(current) !== path.resolve(current))
      throw new Error("H2 fixture path is redirected");
  }
}
