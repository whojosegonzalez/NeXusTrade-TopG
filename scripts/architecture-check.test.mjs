import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkArchitecture, runArchitectureCli } from "./architecture-check.mjs";
import { ensureOwnedDirectory } from "./isolated-paths.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const owner = ensureOwnedDirectory(root, ".tmp/h4");
assert.equal(fs.realpathSync(owner), owner);
const directories = [];
afterEach(() => {
  for (const dir of directories.splice(0)) {
    assert.equal(path.dirname(dir), owner);
    assert.equal(fs.realpathSync(dir), dir);
    fs.rmSync(dir, { recursive: true });
  }
});
function fixture(source, additional = {}, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(owner, "architecture-"));
  directories.push(dir);
  fs.mkdirSync(path.join(dir, "backend/src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.writeFileSync(
    path.join(dir, "backend/tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        moduleResolution: "NodeNext",
        module: "NodeNext",
        paths: { "@local/*": ["./src/*"] },
      },
    }),
  );
  for (const [name, content] of Object.entries({ "entry.ts": source, ...additional }))
    fs.writeFileSync(path.join(dir, "backend/src", name), content);
  const group = {
    name: "fixture",
    pure: true,
    roots: ["backend/src/entry.ts"],
    files: ["backend/src/entry.ts", "backend/src/allowed.ts"],
    typeFiles: ["backend/src/types.ts"],
    external: {},
    ...overrides,
  };
  const policy = { version: 1, groups: [group] };
  fs.writeFileSync(path.join(dir, "scripts/architecture-policy.json"), JSON.stringify(policy));
  return { dir, policy };
}

test("output guard rejects redirected ancestors before creating directories", () => {
  const f = fixture("");
  const target = path.join(f.dir, "actual");
  fs.mkdirSync(target);
  fs.symlinkSync(
    target,
    path.join(f.dir, "redirect"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => ensureOwnedDirectory(f.dir, "redirect/uncreated"), /REDIRECTED/);
  assert.equal(fs.existsSync(path.join(target, "uncreated")), false);
  assert.throws(() => ensureOwnedDirectory(f.dir, "../escape"), /PATH_ESCAPE/);
  assert.equal(ensureOwnedDirectory(f.dir, "safe/nested"), path.join(f.dir, "safe/nested"));
});
test("allowed cycles terminate and type-only edges are classified separately", () => {
  const f = fixture('import "./allowed.js"; import type { T } from "./types.js";', {
    "allowed.ts": 'import "./entry.js";',
    "types.ts": "export type T = string;",
  });
  const result = checkArchitecture(f.dir, f.policy);
  assert.deepEqual(result.failures, []);
  assert.equal(result.inventory.length, 2);
  assert.equal(result.inventory[0].edges[1].typeOnly, true);
});

function packageFixture(layout, source = 'import type { T } from "fixture-package";') {
  const f = fixture(
    source,
    {},
    {
      typePackages: { "backend/src/entry.ts": ["fixture-package"] },
    },
  );
  const store = path.join(f.dir, "node_modules/.pnpm", layout, "node_modules/fixture-package");
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(
    path.join(store, "package.json"),
    JSON.stringify({
      name: "fixture-package",
      version: "1.0.0",
      types: "index.d.ts",
    }),
  );
  fs.writeFileSync(path.join(store, "index.d.ts"), "export type T = string;");
  fs.symlinkSync(
    store,
    path.join(f.dir, "node_modules/fixture-package"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return f;
}
for (const layout of ["fixture-package@1.0.0_short-hash", "fixture-package@1.0.0_peer-long-layout"])
  test(`type package permissions ignore pnpm storage layout: ${layout}`, () => {
    const f = packageFixture(layout);
    assert.deepEqual(checkArchitecture(f.dir, f.policy).failures, []);
  });
test("type package permission does not allow runtime imports or other sources", () => {
  const runtime = packageFixture("runtime", 'import "fixture-package";');
  assert.match(checkArchitecture(runtime.dir, runtime.policy).failures.join(), /FORBIDDEN_MODULE/);
  const other = packageFixture("other");
  other.policy.groups[0].typePackages = { "backend/src/allowed.ts": ["fixture-package"] };
  assert.match(checkArchitecture(other.dir, other.policy).failures.join(), /FORBIDDEN_TYPE_EDGE/);
});
test("type package permission rejects unresolved packages and local alias substitutions", () => {
  const missing = fixture(
    'import type { T } from "missing";',
    {},
    {
      typePackages: { "backend/src/entry.ts": ["missing"] },
    },
  );
  assert.match(
    checkArchitecture(missing.dir, missing.policy).failures.join(),
    /FORBIDDEN_TYPE_EDGE/,
  );
  const alias = fixture(
    'import type { T } from "@local/forbidden";',
    {
      "forbidden.ts": "export type T = string;",
    },
    { typePackages: { "backend/src/entry.ts": ["@local/forbidden"] } },
  );
  assert.match(checkArchitecture(alias.dir, alias.policy).failures.join(), /FORBIDDEN_TYPE_EDGE/);
});
for (const source of [
  'import "./forbidden.js";',
  'export * from "./forbidden.js";',
  'import "@local/forbidden";',
])
  test(`rejects forbidden edge ${source}`, () => {
    const f = fixture(source, { "forbidden.ts": "export const x = 1;" });
    assert.match(checkArchitecture(f.dir, f.policy).failures.join(), /FORBIDDEN_MODULE/);
  });
test("rejects transitive barrel routes and returns nonzero CLI status", () => {
  const f = fixture('export * from "./allowed.js";', {
    "allowed.ts": 'export * from "./forbidden.js";',
    "forbidden.ts": "export const x = 1;",
  });
  const errors = [];
  assert.equal(
    runArchitectureCli(
      f.dir,
      [],
      () => undefined,
      (value) => errors.push(value),
    ),
    1,
  );
  assert.match(errors.join(), /FORBIDDEN_MODULE/);
});
for (const source of [
  'import("./allowed.js")',
  "import(name)",
  'require("x")',
  'import loader = require("x");',
  'process["env"]',
  'globalThis["fetch"]("x")',
  'new Function("return 1")',
  "Date.now()",
  "setTimeout(()=>{},1)",
])
  test(`rejects capability ${source}`, () => {
    const f = fixture(source);
    assert.match(checkArchitecture(f.dir, f.policy).failures.join(), /FORBIDDEN_API/);
  });
test("unresolved runtime and unreviewed type dependencies fail explicitly", () => {
  const f = fixture('import "missing"; import type { T } from "./forbidden.js";', {
    "forbidden.ts": "export type T = string;",
  });
  assert.match(checkArchitecture(f.dir, f.policy).failures.join(), /UNRESOLVED_RUNTIME/);
  assert.match(checkArchitecture(f.dir, f.policy).failures.join(), /FORBIDDEN_TYPE_EDGE/);
});
test("renamed filesystem writes cannot pass a named read API allowance", () => {
  const f = fixture(
    'import { writeFileSync as readFileSync } from "node:fs";',
    {},
    { external: { "node:fs": ["readFileSync"] } },
  );
  assert.match(checkArchitecture(f.dir, f.policy).failures.join(), /FORBIDDEN_IMPORT_API/);
});

test("an audited package name still requires successful module resolution", () => {
  const f = fixture(
    'import "uninstalled-package";',
    {},
    {
      external: { "uninstalled-package": "AUDITED_PACKAGE" },
    },
  );
  assert.match(checkArchitecture(f.dir, f.policy).failures.join(), /UNRESOLVED_RUNTIME/);
});
test("rejects redirected source before reading its target", () => {
  const f = fixture("export {};"),
    other = fixture("export {};");
  fs.unlinkSync(path.join(f.dir, "backend/src/entry.ts"));
  // Directory junction works without Windows symlink privilege and has equivalent escape semantics.
  fs.renameSync(path.join(f.dir, "backend/src"), path.join(f.dir, "backend/saved"));
  fs.symlinkSync(
    path.join(other.dir, "backend/src"),
    path.join(f.dir, "backend/src"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => checkArchitecture(f.dir, f.policy), /SOURCE_REDIRECTED/);
});
