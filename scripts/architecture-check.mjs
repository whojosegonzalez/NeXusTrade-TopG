import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ownRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const slash = (value) => value.replaceAll("\\", "/");
export function createGraph(root) {
  const configFile = ts.readConfigFile(path.join(root, "backend/tsconfig.json"), ts.sys.readFile);
  const config = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.join(root, "backend"),
  );
  if (configFile.error || config.errors.length) throw new Error("ARCHITECTURE_CONFIG_INVALID");
  const files = new Map();
  function inspect(file) {
    const full = path.resolve(root, file);
    if (files.has(file)) return files.get(file);
    const real = fs.realpathSync(full);
    const relative = path.relative(root, real);
    if (relative.startsWith("..") || path.isAbsolute(relative) || real !== full)
      throw new Error("ARCHITECTURE_SOURCE_REDIRECTED");
    const source = fs.readFileSync(full, "utf8");
    const ast = ts.createSourceFile(full, source, ts.ScriptTarget.Latest, true);
    const entry = { file, edges: [], capabilities: [] };
    files.set(file, entry);
    const add = (spec, typeOnly, node) => {
      const resolved = ts.resolveModuleName(spec, full, config.options, ts.sys).resolvedModule;
      let target;
      if (resolved) {
        const real = fs.realpathSync(resolved.resolvedFileName);
        const rel = slash(path.relative(root, real));
        target = rel.startsWith("../") || path.isAbsolute(rel) ? "OUTSIDE_WORKSPACE" : rel;
      }
      const symbols = [];
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (clause?.name) symbols.push("default");
        if (clause?.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) symbols.push("*");
          else
            for (const element of clause.namedBindings.elements)
              if (!element.isTypeOnly) symbols.push((element.propertyName ?? element.name).text);
        }
      } else symbols.push("*");
      entry.edges.push({
        spec,
        typeOnly,
        target,
        symbols,
        packageName: resolved?.packageId?.name,
        externalLibrary: resolved?.isExternalLibraryImport === true,
      });
    };
    const visit = (node) => {
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
        entry.capabilities.push("DYNAMIC_LOADING");
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
        const bindings = clause?.namedBindings;
        const typeOnly = Boolean(
          node.isTypeOnly ||
          clause?.isTypeOnly ||
          (bindings &&
            ts.isNamedImports(bindings) &&
            !clause.name &&
            bindings.elements.length &&
            bindings.elements.every((item) => item.isTypeOnly)) ||
          (ts.isExportDeclaration(node) &&
            node.exportClause &&
            ts.isNamedExports(node.exportClause) &&
            node.exportClause.elements.length &&
            node.exportClause.elements.every((item) => item.isTypeOnly)),
        );
        add(node.moduleSpecifier.text, typeOnly, node);
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            ["require", "eval", "Function"].includes(node.expression.text)))
      )
        entry.capabilities.push("DYNAMIC_LOADING");
      if (
        ts.isIdentifier(node) &&
        [
          "fetch",
          "XMLHttpRequest",
          "WebSocket",
          "process",
          "global",
          "globalThis",
          "setTimeout",
          "setInterval",
          "Worker",
          "Function",
          "eval",
          "require",
        ].includes(node.text)
      )
        entry.capabilities.push(node.text);
      if (ts.isIdentifier(node) && node.text === "Date") entry.capabilities.push("WALL_CLOCK");
      ts.forEachChild(node, visit);
    };
    visit(ast);
    entry.capabilities = [...new Set(entry.capabilities)].sort();
    return entry;
  }
  return { inspect, files };
}

export function checkArchitecture(root, policy) {
  if (policy.version !== 1) throw new Error("ARCHITECTURE_POLICY_VERSION_UNSUPPORTED");
  const graph = createGraph(root),
    failures = [],
    inventory = [];
  for (const group of policy.groups) {
    const visited = new Set();
    const walk = (file) => {
      if (visited.has(file)) return;
      visited.add(file);
      if (!group.files.includes(file)) {
        failures.push(`${group.name}: FORBIDDEN_MODULE ${file}`);
        return;
      }
      const entry = graph.inspect(file);
      inventory.push({ group: group.name, ...entry });
      for (const capability of entry.capabilities) {
        if (capability === "WALL_CLOCK" && !group.pure) continue;
        if ((group.capabilities?.[file] ?? []).includes(capability)) continue;
        failures.push(`${group.name}: FORBIDDEN_API ${file} ${capability}`);
      }
      for (const edge of entry.edges) {
        if (edge.typeOnly) {
          const packageAllowed =
            (group.typePackages?.[file] ?? []).includes(edge.spec) &&
            edge.externalLibrary &&
            edge.packageName &&
            (edge.spec === edge.packageName || edge.spec.startsWith(`${edge.packageName}/`)) &&
            edge.target?.startsWith("node_modules/");
          if (
            !edge.target ||
            edge.target === "OUTSIDE_WORKSPACE" ||
            (!(group.typeFiles ?? group.files).includes(edge.target) && !packageAllowed)
          )
            failures.push(`${group.name}: FORBIDDEN_TYPE_EDGE ${file} ${edge.spec}`);
          continue;
        }
        if (edge.target === "OUTSIDE_WORKSPACE") {
          failures.push(`${group.name}: PATH_ESCAPE ${file} ${edge.spec}`);
          continue;
        }
        if (Object.hasOwn(group.external, edge.spec)) {
          const symbols = group.external[edge.spec];
          if (symbols === "AUDITED_PACKAGE" && !edge.target)
            failures.push(`${group.name}: UNRESOLVED_RUNTIME ${file} ${edge.spec}`);
          if (
            symbols !== "AUDITED_PACKAGE" &&
            edge.symbols.some((symbol) => !symbols.includes(symbol))
          )
            failures.push(`${group.name}: FORBIDDEN_IMPORT_API ${file} ${edge.spec}`);
          continue;
        }
        if (!edge.target) {
          failures.push(`${group.name}: UNRESOLVED_RUNTIME ${file} ${edge.spec}`);
          continue;
        }
        walk(edge.target);
      }
    };
    group.roots.forEach(walk);
  }
  return { failures: [...new Set(failures)].sort(), inventory };
}

export function workspaceInventory(root) {
  const graph = createGraph(root);
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error("ARCHITECTURE_SOURCE_REDIRECTED");
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) graph.inspect(slash(path.relative(root, full)));
    }
  }
  for (const folder of ["backend/src", "shared/src", "frontend/src"]) walk(path.join(root, folder));
  return [...graph.files.values()].sort((a, b) => a.file.localeCompare(b.file));
}

export function runArchitectureCli(root, args, output = console.log, error = console.error) {
  if (args.length && !(args.length === 1 && args[0] === "--inventory"))
    throw new Error("ARCHITECTURE_INVALID_ARGUMENT");
  if (args[0] === "--inventory") output(JSON.stringify(workspaceInventory(root), null, 2));
  else {
    const policy = JSON.parse(
      fs.readFileSync(path.join(root, "scripts/architecture-policy.json"), "utf8"),
    );
    const result = checkArchitecture(root, policy);
    if (result.failures.length) {
      error(result.failures.join("\n"));
      return 1;
    }
    output(`Architecture policy v1 passed (${result.inventory.length} protected module visits).`);
  }
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runArchitectureCli(ownRoot, process.argv.slice(2));
}
