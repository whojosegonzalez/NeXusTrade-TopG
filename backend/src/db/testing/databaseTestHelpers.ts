import type { DatabaseContext } from "../connection.js";

export function listTableNames(context: DatabaseContext): string[] {
  return context.sqlite
    .prepare(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
    )
    .all()
    .map((row) => (row as { name: string }).name);
}

export function expectForeignKeysEnabled(context: DatabaseContext): boolean {
  return context.sqlite.pragma("foreign_keys", { simple: true }) === 1;
}

export function expectWalModeEnabled(context: DatabaseContext): boolean {
  return context.sqlite.pragma("journal_mode", { simple: true }) === "wal";
}
