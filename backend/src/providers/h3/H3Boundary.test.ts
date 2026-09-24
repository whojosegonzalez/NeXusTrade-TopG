import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
describe("H3 database-free dependency boundary", () => {
  it("audits limiter/HTTP/retry runtime dependencies without bootstrapping providers", () => {
    const visited = new Set<string>();
    const walk = (file: string) => {
      if (visited.has(file)) return;
      visited.add(file);
      const relative = path.relative(root, file).replaceAll("\\", "/");
      expect(relative).toMatch(/^(backend\/src\/providers\/|shared\/src\/)/);
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/process\.env|\bimport\s*\(|\brequire\s*\(/);
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      for (const statement of ast.statements) {
        if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
        if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) continue;
        if (ts.isImportDeclaration(statement)) {
          const bindings = statement.importClause?.namedBindings;
          if (
            bindings &&
            ts.isNamedImports(bindings) &&
            !statement.importClause?.name &&
            bindings.elements.every((element) => element.isTypeOnly)
          )
            continue;
        }
        if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue;
        const spec = statement.moduleSpecifier;
        if (!spec || !ts.isStringLiteral(spec)) continue;
        if (spec.text.startsWith("."))
          walk(path.resolve(path.dirname(file), spec.text.replace(/\.js$/, ".ts")));
        else if (spec.text === "@nexustrade/shared") walk(path.join(root, "shared/src/index.ts"));
        else expect(spec.text).toMatch(/^(vitest|zod)$/);
      }
    };
    for (const file of [
      "providerRateLimiter.test.ts",
      "ProviderHttpClient.test.ts",
      "providerRetry.ts",
    ])
      walk(path.join(root, "backend/src/providers/http", file));
    for (const file of [
      "ProviderRegistry.test.ts",
      "config/providerConfig.test.ts",
      "birdeye/BirdeyeAdapter.test.ts",
      "das/DasMetadataAdapter.test.ts",
      "helius/HeliusAdapter.test.ts",
      "raydium/RaydiumAdapter.test.ts",
      "solana-rpc/SolanaRpcAdapter.test.ts",
      "quotes/QuoteBudgetPlanner.test.ts",
      "quotes/QuoteProviderRouter.test.ts",
      "jupiter/JupiterDemandController.test.ts",
    ])
      walk(path.join(root, "backend/src/providers", file));
    expect(visited.size).toBeGreaterThan(5);
  });
  it("rejects unexpected network and environment reads", () => {
    expect(() => fetch("https://unexpected.invalid")).toThrow("H3_REAL_NETWORK_FORBIDDEN");
    expect(() => readFileSync(path.join(root, ".env"))).toThrow("H3_ENVIRONMENT_READ_FORBIDDEN");
    expect(() => new Database(path.join(root, "data", "forbidden.sqlite"))).toThrow(
      "H2 fixture path escapes its owned root",
    );
  });
});
