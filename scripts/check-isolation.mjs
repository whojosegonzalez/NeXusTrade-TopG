import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ensureOwnedDirectory } from "./isolated-paths.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function inside(file) {
  const relative = path.relative(root, fs.realpathSync(file));
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("ISOLATED_PATH_ESCAPE");
}
for (const dir of [
  "backend/src",
  "shared/src",
  "frontend/src",
  "node_modules",
  "backend/node_modules",
])
  inside(path.join(root, dir));
let links = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      inside(file);
      links++;
    } else if (entry.isDirectory()) walk(file);
  }
}
walk(path.join(root, "node_modules"));
walk(path.join(root, "backend/node_modules"));
for (const dir of [".tmp/h2", ".tmp/h4", ".tmp/isolated", "node_modules/.cache"]) {
  ensureOwnedDirectory(root, dir);
}
const require = createRequire(path.join(root, "backend/package.json"));
inside(require.resolve("better-sqlite3"));
const Database = require("better-sqlite3"),
  db = new Database(":memory:");
try {
  console.log(
    `Isolation verified (${links} dependency links); SQLite ${db.prepare("select sqlite_version() as version").get().version}; memory only.`,
  );
} finally {
  db.close();
}
