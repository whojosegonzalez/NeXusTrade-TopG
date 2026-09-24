import path from "node:path";

import { createHash } from "node:crypto";

import type { DatabaseContext } from "./connection.js";
import { getRepoRoot } from "./utils/paths.js";
import { migrationContract } from "./MigrationContract.js";
import { inspectMigrationState, readTrustedMigrationSources } from "./MigrationReadiness.js";
import { preflightH2Migration } from "./H2MigrationPreflight.js";

export function getMigrationsFolder(): string {
  return path.resolve(getRepoRoot(), "backend", "drizzle");
}

export function runMigrations(context: DatabaseContext): void {
  const sources = readTrustedMigrationSources(getMigrationsFolder());
  if (context.sqlite.inTransaction) throw new Error("DATABASE_MIGRATION_NESTED_TRANSACTION");
  const previousForeignKeys = context.sqlite.pragma("foreign_keys", { simple: true });
  // SQLite rebuilds require this outside the transaction. Validate ownership before committing.
  context.sqlite.pragma("foreign_keys = OFF");
  try {
    context.sqlite
      .transaction(() => {
        const state = inspectMigrationState(context);
        if (state.ready) return;
        if (state.appliedCount > 0 && state.appliedCount < 3) preflightH2Migration(context.sqlite);
        context.sqlite.exec(
          "CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
        );
        for (let index = state.appliedCount; index < sources.length; index++) {
          const source = sources[index]!;
          context.sqlite.exec(source);
          context.sqlite
            .prepare("INSERT INTO __drizzle_migrations (hash,created_at) VALUES (?,?)")
            .run(createHash("sha256").update(source).digest("hex"), migrationContract[index]!.when);
        }
        const foreignKeyIssues = context.sqlite.pragma("foreign_key_check");
        if (!Array.isArray(foreignKeyIssues) || foreignKeyIssues.length !== 0)
          throw new Error("DATABASE_MIGRATION_FOREIGN_KEY_FAILURE");
        if (!inspectMigrationState(context).ready) throw new Error("DATABASE_MIGRATION_INCOMPLETE");
      })
      .immediate();
  } finally {
    context.sqlite.pragma(`foreign_keys = ${previousForeignKeys === 1 ? "ON" : "OFF"}`);
  }
}

export function assertMigrationsApplied(context: DatabaseContext): void {
  readTrustedMigrationSources(getMigrationsFolder());
  if (!inspectMigrationState(context).ready) throw new Error("DATABASE_MIGRATIONS_NOT_APPLIED");
}
