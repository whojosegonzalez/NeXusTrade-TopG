import { sql } from "drizzle-orm";
import { check, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

/** Existing nullable columns remain nullable; NOT NULL is owned by the column definition. */
export function safeIntegerCheck(name: string, column: AnySQLiteColumn, signed = false) {
  const minimum = sql.raw(signed ? "-9007199254740991" : "0");
  return check(
    name,
    sql`${column} IS NULL OR (typeof(${column}) = 'integer' AND ${column} BETWEEN ${minimum} AND 9007199254740991)`,
  );
}
export function domainCheck(name: string, column: AnySQLiteColumn, values: readonly string[]) {
  const literals = sql.join(
    values.map((value) => sql.raw(`'${value.replaceAll("'", "''")}'`)),
    sql`, `,
  );
  return check(name, sql`${column} IN (${literals})`);
}
