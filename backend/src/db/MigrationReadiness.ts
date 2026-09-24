import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { DatabaseContext } from "./connection.js";
import { migrationContract } from "./MigrationContract.js";

const journalSchema = z
  .object({
    version: z.literal("7"),
    dialect: z.literal("sqlite"),
    entries: z.array(
      z
        .object({
          idx: z.number().int(),
          version: z.literal("6"),
          when: z.number().int(),
          tag: z.string(),
          breakpoints: z.literal(true),
        })
        .strict(),
    ),
  })
  .strict();
const appliedSchema = z.array(z.object({ hash: z.string(), created_at: z.number().int().safe() }));
const objectsSchema = z.array(
  z.object({ type: z.string(), name: z.string(), tbl_name: z.string(), sql: z.string() }),
);

export function readTrustedMigrationSources(folder: string): readonly string[] {
  try {
    const journal = journalSchema.parse(
      JSON.parse(readFileSync(path.join(folder, "meta/_journal.json"), "utf8")),
    );
    if (journal.entries.length !== migrationContract.length) throw new Error();
    return migrationContract.map((expected, index) => {
      const entry = journal.entries[index]!;
      if (
        entry.idx !== index ||
        entry.when !== expected.when ||
        `${entry.tag}.sql` !== expected.file
      )
        throw new Error();
      const source = readFileSync(path.join(folder, expected.file));
      const hash = createHash("sha256").update(source).digest("hex");
      if (hash !== expected.sha256 && hash !== expected.legacyCrlfSha256) throw new Error();
      return source.toString("utf8");
    });
  } catch {
    throw new Error("DATABASE_MIGRATION_SOURCE_UNTRUSTED");
  }
}

/** Read-only inspection of an explicitly supplied connection; never opens or upgrades a database. */
export function inspectMigrationState(context: Pick<DatabaseContext, "sqlite">): {
  readonly appliedCount: number;
  readonly ready: boolean;
} {
  try {
    const journal = context.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
      .get();
    if (journal) {
      const columns = z
        .array(
          z.object({
            name: z.string(),
            type: z.string().transform((value) => value.toUpperCase()),
            notnull: z.number(),
            pk: z.number(),
            dflt_value: z.null(),
          }),
        )
        .parse(context.sqlite.pragma("table_info('__drizzle_migrations')"));
      const expectedColumns = [
        { name: "id", type: "SERIAL", notnull: 0, pk: 1, dflt_value: null },
        { name: "hash", type: "TEXT", notnull: 1, pk: 0, dflt_value: null },
        { name: "created_at", type: "NUMERIC", notnull: 0, pk: 0, dflt_value: null },
      ];
      if (JSON.stringify(columns) !== JSON.stringify(expectedColumns)) throw new Error();
    }
    const applied = journal
      ? appliedSchema.parse(
          context.sqlite
            .prepare("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at")
            .all(),
        )
      : [];
    if (applied.length > migrationContract.length) throw new Error();
    for (const [index, row] of applied.entries()) {
      const expected = migrationContract[index]!;
      if (
        row.created_at !== expected.when ||
        (row.hash !== expected.sha256 && row.hash !== expected.legacyCrlfSha256)
      )
        throw new Error();
    }
    const actual = objectsSchema.parse(
      context.sqlite
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY type,name",
        )
        .all(),
    );
    const expected = applied.length ? migrationContract[applied.length - 1]!.schema : [];
    // The only representation alternative is the recorded historical LF/CRLF checkout form.
    const canonical = (
      rows: readonly {
        readonly type: string;
        readonly name: string;
        readonly tbl_name: string;
        readonly sql: string;
      }[],
    ) => JSON.stringify(rows.map((row) => ({ ...row, sql: row.sql.replaceAll("\r\n", "\n") })));
    if (canonical(actual) !== canonical(expected)) throw new Error();
    return { appliedCount: applied.length, ready: applied.length === migrationContract.length };
  } catch {
    throw new Error("DATABASE_MIGRATION_STATE_UNTRUSTED");
  }
}
