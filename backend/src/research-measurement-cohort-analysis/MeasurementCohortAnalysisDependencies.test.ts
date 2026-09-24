import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const directory = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(directory, "../scripts/research-measurement-cohort-analyze.ts");
const builtins: Record<string, readonly string[]> = {
  "node:fs": ["existsSync", "lstatSync", "realpathSync", "readFileSync", "readdirSync"],
  "node:crypto": ["createHash"],
  "node:path": ["default"],
  "node:url": ["fileURLToPath"],
};
const forbidden = new Set([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "eval",
  "Function",
  "require",
  "globalThis",
  "global",
  "setTimeout",
  "setInterval",
  "Worker",
]);
function audit(source: string, isEntry = false, thirdParty = false): string[] {
  const parsed = ts.createSourceFile("audit.ts", source, ts.ScriptTarget.Latest, true);
  const errors: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec)) {
        const name = spec.text;
        if (!name.startsWith(".") && name !== "zod" && !Object.hasOwn(builtins, name))
          errors.push(`import:${name}`);
        if (thirdParty && !name.startsWith(".")) errors.push(`third-party-import:${name}`);
        if (ts.isImportDeclaration(node) && Object.hasOwn(builtins, name)) {
          const clause = node.importClause;
          if (!clause) errors.push("side-effect-import");
          if (clause?.name && !builtins[name]!.includes("default")) errors.push("default-import");
          const bindings = clause?.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings)) errors.push("namespace-import");
          if (bindings && ts.isNamedImports(bindings))
            for (const element of bindings.elements)
              if (!builtins[name]!.includes(element.propertyName?.text ?? element.name.text))
                errors.push(`api:${element.name.text}`);
        }
      } else if (spec) errors.push("computed-import");
    }
    if (ts.isImportEqualsDeclaration(node)) errors.push("import-equals");
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      errors.push("dynamic-import");
    if (ts.isIdentifier(node) && forbidden.has(node.text)) errors.push(`global:${node.text}`);
    if (ts.isIdentifier(node) && node.text === "process") {
      const parent = node.parent;
      if (
        !isEntry ||
        !ts.isPropertyAccessExpression(parent) ||
        !["argv", "stdout", "stderr", "exitCode"].includes(parent.name.text)
      )
        errors.push("process-access");
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return errors;
}
function relativeImports(source: string): string[] {
  const parsed = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest, true);
  return parsed.statements.flatMap((statement) =>
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
    statement.moduleSpecifier &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text.startsWith(".")
      ? [statement.moduleSpecifier.text]
      : [],
  );
}
describe("H1 complete dependency and API boundary", () => {
  it("audits every production module and the entrypoint including transitive local edges", () => {
    const modules = readdirSync(directory).filter(
      (name) => name.endsWith(".ts") && !name.includes(".test"),
    );
    const allowed = new Set(modules.map((name) => path.join(directory, name)));
    allowed.add(entry);
    const visited = new Set<string>();
    const walk = (file: string): void => {
      if (visited.has(file)) return;
      visited.add(file);
      expect(allowed.has(file), `unexpected transitive module: ${file}`).toBe(true);
      const text = readFileSync(file, "utf8");
      expect(audit(text, file === entry), file).toEqual([]);
      for (const spec of relativeImports(text))
        walk(path.resolve(path.dirname(file), spec.replace(/\.js$/, ".ts")));
    };
    walk(entry);
    expect([...visited].sort()).toEqual([...allowed].sort());
  });
  it("audits the installed Zod runtime's entire static import/export closure", () => {
    const require = createRequire(import.meta.url);
    // Resolve the ESM entry used by production rather than the CommonJS require target.
    const packageRoot = path.dirname(require.resolve("zod/package.json"));
    const start = path.join(packageRoot, "index.js");
    const visited = new Set<string>();
    const walk = (file: string): void => {
      file = realpathSync(file);
      if (visited.has(file)) return;
      visited.add(file);
      expect(path.relative(realpathSync(packageRoot), file).startsWith("..")).toBe(false);
      const text = readFileSync(file, "utf8");
      expect(audit(text, false, true), file).toEqual([]);
      for (const spec of relativeImports(text)) walk(path.resolve(path.dirname(file), spec));
    };
    walk(start);
    expect(visited.size).toBeGreaterThan(5);
  });
  it.each([
    'import { x } from "../providers/Provider.js";',
    'import { x } from "../research-measurement-cohort/MeasurementCohortRunner.js";',
    'import { x } from "../research-exploratory-cohort-analysis/Analyzer.js";',
    'import { x } from "../db/connection.js";',
    'import { x } from "../paper/PaperRunner.js";',
  ])("detects local dependency escape %s", (snippet) => {
    const targets = relativeImports(snippet).map((spec) => path.resolve(directory, spec));
    expect(targets.every((file) => path.dirname(file) === directory)).toBe(false);
  });
  it.each([
    'import "node:http";',
    'import { exec } from "node:child_process";',
    'import { writeFileSync as read } from "node:fs";',
    'import * as fs from "node:fs";',
    'import fs from "node:fs";',
    'import "dotenv/config";',
    "const x=process.env;",
    'const x=process["env"];',
    'import("../providers/x.js");',
    'const x=require("fs");',
    'fetch("https://synthetic.invalid");',
    'globalThis["fetch"]("x");',
    "setInterval(()=>{},1);",
    'new Function("return 1");',
    'eval("1");',
  ])("rejects prohibited dynamic/global/import API %s", (snippet) => {
    expect(audit(snippet).length).toBeGreaterThan(0);
  });
});
