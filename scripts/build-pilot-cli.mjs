#!/usr/bin/env node
/**
 * Phase 12.94-D Milestone D.2.4: Build Pilot CLI Script
 *
 * Compiles backend source TypeScript files into backend/dist as pure ES Modules
 * for standalone execution on Linux (Fedora 44) and Windows without tsx or ts-node.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(rootDir, "backend", "src");
const distDir = path.join(rootDir, "backend", "dist");

function collectTsFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      results.push(fullPath);
    }
  }
  return results;
}

export function buildPilotDist() {
  const tsFiles = collectTsFiles(srcDir);
  let builtCount = 0;
  for (const tsFile of tsFiles) {
    const relPath = path.relative(srcDir, tsFile);
    const destJsFile = path.join(distDir, relPath.replace(/\.ts$/, ".js"));
    fs.mkdirSync(path.dirname(destJsFile), { recursive: true });

    const sourceText = fs.readFileSync(tsFile, "utf8");
    const transpiled = ts.transpileModule(sourceText, {
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022,
        inlineSourceMap: true,
      },
      fileName: tsFile,
    });
    fs.writeFileSync(destJsFile, transpiled.outputText, "utf8");
    builtCount++;
  }
  console.log(`[BUILD] Transpiled ${builtCount} backend TypeScript files to backend/dist`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildPilotDist();
}
