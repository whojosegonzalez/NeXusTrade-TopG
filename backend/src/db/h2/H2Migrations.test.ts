import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type DatabaseContext } from "../connection.js";
import { migrationContract } from "../MigrationContract.js";
import { inspectMigrationState, readTrustedMigrationSources } from "../MigrationReadiness.js";
import { assertMigrationsApplied, getMigrationsFolder, runMigrations } from "../migrations.js";

let context: DatabaseContext | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  context?.close();
  context = undefined;
});
function memory() {
  context = openDatabase(":memory:", "PAPER");
  return context;
}
function prior(count: number, crlf = false) {
  const db = memory();
  db.sqlite.pragma("foreign_keys = OFF");
  db.sqlite.exec(
    "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
  );
  for (const step of migrationContract.slice(0, count)) {
    const source = readFileSync(path.join(getMigrationsFolder(), step.file), "utf8");
    db.sqlite.exec(source);
    db.sqlite
      .prepare("INSERT INTO __drizzle_migrations (hash,created_at) VALUES (?,?)")
      .run(crlf ? step.legacyCrlfSha256 : step.sha256, step.when);
  }
  db.sqlite.pragma("foreign_keys = ON");
  return db;
}
describe("H2 trusted migration readiness and atomic upgrades", () => {
  it("keeps readiness read-only on an empty database", () => {
    const db = memory();
    const exec = vi.spyOn(db.sqlite, "exec");
    expect(() => assertMigrationsApplied(db)).toThrow("NOT_APPLIED");
    expect(exec).not.toHaveBeenCalled();
    expect(db.sqlite.prepare("SELECT name FROM sqlite_master").all()).toEqual([]);
  });
  it.each([0, 1, 2, 3])(
    "initializes or upgrades the supported %i-step chain exactly once",
    (count) => {
      const db = count ? prior(count) : memory();
      if (count < migrationContract.length)
        expect(() => assertMigrationsApplied(db)).toThrow("NOT_APPLIED");
      runMigrations(db);
      expect(() => assertMigrationsApplied(db)).not.toThrow();
      const before = db.sqlite.prepare("SELECT * FROM __drizzle_migrations").all();
      runMigrations(db);
      expect(db.sqlite.prepare("SELECT * FROM __drizzle_migrations").all()).toEqual(before);
      expect(db.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
    },
  );
  it("accepts only the explicitly pinned historical CRLF identities", () => {
    const db = prior(2, true);
    expect(() => assertMigrationsApplied(db)).toThrow("NOT_APPLIED");
    runMigrations(db);
    expect(() => assertMigrationsApplied(db)).not.toThrow();
    expect(readTrustedMigrationSources(getMigrationsFolder())).toHaveLength(3);
  });
  it.each(["missing-middle", "wrong-hash", "newer", "duplicate", "missing-index", "forged-table"])(
    "rejects %s without repairing or migrating",
    (failure) => {
      const db = prior(2);
      if (failure === "missing-middle")
        db.sqlite
          .prepare("DELETE FROM __drizzle_migrations WHERE created_at=?")
          .run(migrationContract[0].when);
      if (failure === "wrong-hash")
        db.sqlite.exec("UPDATE __drizzle_migrations SET hash='untrusted'");
      if (failure === "newer" || failure === "duplicate")
        db.sqlite
          .prepare("INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)")
          .run(
            migrationContract[1].sha256,
            failure === "newer" ? Number.MAX_SAFE_INTEGER : migrationContract[1].when,
          );
      if (failure === "missing-index") db.sqlite.exec("DROP INDEX idx_sessions_status");
      if (failure === "forged-table") db.sqlite.exec("CREATE TABLE unreviewed_schema (value TEXT)");
      const before = db.sqlite.prepare("SELECT * FROM __drizzle_migrations").all();
      expect(() => assertMigrationsApplied(db)).toThrow("STATE_UNTRUSTED");
      expect(() => runMigrations(db)).toThrow("STATE_UNTRUSTED");
      expect(db.sqlite.prepare("SELECT * FROM __drizzle_migrations").all()).toEqual(before);
      expect(db.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    },
  );
  it("rejects a forged journal structure despite matching hashes", () => {
    const db = prior(2);
    db.sqlite.exec(
      "ALTER TABLE __drizzle_migrations RENAME TO saved; CREATE TABLE __drizzle_migrations (hash TEXT,created_at NUMERIC); INSERT INTO __drizzle_migrations SELECT hash,created_at FROM saved; DROP TABLE saved",
    );
    expect(() => inspectMigrationState(db)).toThrow("STATE_UNTRUSTED");
  });
  it("rolls back schema and journal together after an injected migration interruption", () => {
    const db = memory();
    const exec = db.sqlite.exec.bind(db.sqlite);
    vi.spyOn(db.sqlite, "exec").mockImplementation((sql) => {
      if (sql.includes("watchlist_return_observations"))
        throw new Error("injected migration interruption");
      return exec(sql);
    });
    expect(() => runMigrations(db)).toThrow("injected migration interruption");
    expect(db.sqlite.prepare("SELECT name FROM sqlite_master").all()).toEqual([]);
    expect(db.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
  });
  it("refuses nesting without changing the caller transaction", () => {
    const db = memory();
    db.sqlite.transaction(() => {
      expect(() => runMigrations(db)).toThrow("NESTED_TRANSACTION");
      expect(db.sqlite.inTransaction).toBe(true);
      expect(db.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    })();
  });
});
