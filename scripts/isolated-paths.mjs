import fs from "node:fs";
import path from "node:path";

// Inspect each existing ancestor before creating anything below it.
export function ensureOwnedDirectory(root, relative) {
  const base = fs.realpathSync(root);
  const target = path.resolve(base, relative);
  const suffix = path.relative(base, target);
  if (suffix.startsWith("..") || path.isAbsolute(suffix)) throw new Error("ISOLATED_PATH_ESCAPE");
  let current = base;
  for (const part of suffix.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current)) {
      if (fs.lstatSync(current).isSymbolicLink() || fs.realpathSync(current) !== current)
        throw new Error("ISOLATED_OUTPUT_REDIRECTED");
    } else fs.mkdirSync(current);
    if (!fs.statSync(current).isDirectory()) throw new Error("ISOLATED_OUTPUT_NOT_DIRECTORY");
  }
  return target;
}
