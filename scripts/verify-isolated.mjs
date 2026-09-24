import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureOwnedDirectory } from "./isolated-paths.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function verificationPlan(mode = "all") {
  if (!["all", "static", "tests"].includes(mode)) throw new Error("ISOLATED_VERIFY_INVALID_MODE");
  const node = (args) => ({ command: process.execPath, args });
  const plan = [node(["scripts/check-isolation.mjs"]), node(["scripts/architecture-check.mjs"])];
  if (mode !== "tests") {
    for (const config of [
      "backend/tsconfig.json",
      "shared/tsconfig.json",
      "frontend/tsconfig.app.json",
    ])
      plan.push(node(["node_modules/typescript/bin/tsc", "-p", config, "--noEmit"]));
    plan.push(
      node([
        "node_modules/typescript/bin/tsc",
        "--noEmit",
        "--module",
        "NodeNext",
        "--target",
        "ES2022",
        "--skipLibCheck",
        "--strict",
        "backend/vitest.measurement-analysis.config.ts",
        "backend/vitest.h2.config.ts",
        "backend/vitest.h3.config.ts",
        "backend/vitest.h4.config.ts",
      ]),
    );
    plan.push(
      node([
        "node_modules/eslint/bin/eslint.js",
        ".",
        "--ignore-pattern",
        ".pnpm-store/**",
        "--ignore-pattern",
        ".tmp/**",
      ]),
    );
    plan.push(
      node([
        "node_modules/prettier/bin/prettier.cjs",
        ".",
        "--check",
        "--ignore-path",
        ".gitignore",
        "--ignore-path",
        ".prettierignore",
      ]),
    );
    plan.push(node(["scripts/check-secrets.mjs"]));
    plan.push({ command: "git", args: ["diff", "--check"] });
  }
  if (mode !== "static") {
    plan.push(
      node(["--test", "scripts/architecture-check.test.mjs", "scripts/verify-isolated.test.mjs"]),
    );
    for (const config of ["measurement-analysis", "h2", "h3", "h4"])
      plan.push(
        node([
          "node_modules/vitest/vitest.mjs",
          "run",
          "--config",
          `backend/vitest.${config}.config.ts`,
        ]),
      );
  }
  return plan;
}
export function runVerification(mode = "all", execute = spawnSync, log = console.log) {
  const plan = verificationPlan(mode);
  const temp = ensureOwnedDirectory(root, ".tmp/isolated");
  for (const step of plan) {
    log([path.basename(step.command), ...step.args].join(" "));
    const result = execute(step.command, step.args, {
      cwd: root,
      stdio: "inherit",
      shell: false,
      env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp, HUSKY: "0" },
    });
    if (result.error || result.signal || result.status !== 0) return result.status || 1;
  }
  // Fixture owners clean their own paths; never recursively delete a shared temp root here.
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1) throw new Error("ISOLATED_VERIFY_INVALID_ARGUMENT");
  process.exitCode = runVerification(args[0] ?? "all");
}
