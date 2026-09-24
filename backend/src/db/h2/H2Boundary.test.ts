import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const selected = [
  "paper/PaperRunner",
  "paper/PaperSellRunner",
  "paper/PaperExchangeConfig",
  "paper/PaperSellConfig",
  "exits/ExitManagerRunner",
  "exits/ExitManagerConfig",
  "session/SessionManagerRunner",
  "session/SessionManagerConfig",
  "db/repositories/repositories",
  "db/connection",
];
describe("H2 selected test dependency audit", () => {
  it("keeps ordinary entrypoints from implicitly applying database migrations", () => {
    const scripts = path.join(root, "backend/src/scripts");
    for (const file of readdirSync(scripts).filter((file) => file.endsWith(".ts")))
      expect(readFileSync(path.join(scripts, file), "utf8"), file).not.toMatch(/\brunMigrations\b/);
  });
  it("keeps the selected runner/config runtime import closures away from environment and provider implementations", () => {
    const visited = new Set<string>();
    const walk = (file: string) => {
      if (visited.has(file)) return;
      visited.add(file);
      const relative = path.relative(root, file).replaceAll("\\", "/");
      expect(relative).toMatch(/^(backend\/src\/(paper|db|exits|session)\/|shared\/src\/)/);
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/process\.env|\bfetch\s*\(|\bimport\s*\(|\brequire\s*\(/);
      const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      for (const statement of ast.statements) {
        if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
        if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) continue;
        const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined;
        if (
          clause &&
          !clause.name &&
          clause.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly)
        )
          continue;
        if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue;
        const spec = statement.moduleSpecifier;
        if (!spec || !ts.isStringLiteral(spec)) continue;
        if (spec.text.startsWith("."))
          walk(path.resolve(path.dirname(file), spec.text.replace(/\.js$/, ".ts")));
        else if (spec.text === "@nexustrade/shared") walk(path.join(root, "shared/src/index.ts"));
        else
          expect(spec.text).toMatch(
            /^(vitest|zod|better-sqlite3|drizzle-orm(?:\/[^ ]+)?|node:(?:fs|path|url|os|crypto|worker_threads))$/,
          );
      }
    };
    for (const name of selected) walk(path.join(root, `backend/src/${name}.test.ts`));
    walk(path.join(root, "backend/src/paper/PaperReconciliation.ts"));
    walk(path.join(root, "backend/src/db/h2/H2WorkerTask.ts"));
    expect(visited.size).toBeGreaterThan(30);
  });
});
