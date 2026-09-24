import { readFileSync } from "node:fs";
import { request } from "node:http";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
describe("H4 execution boundary", () => {
  it("blocks real fetch, alternate HTTP and subprocess access", () => {
    expect(() => fetch("https://synthetic.invalid")).toThrow("H4_REAL_NETWORK_FORBIDDEN");
    expect(() => request("https://synthetic.invalid")).toThrow("H4_EXTERNAL_IO_FORBIDDEN");
    expect(() => spawnSync("anything")).toThrow("H4_EXTERNAL_IO_FORBIDDEN");
  });
  it("rejects environment, archive and default database access before opening paths", () => {
    expect(() => readFileSync(path.join(root, ".env"))).toThrow("H4_ENV_OR_ARCHIVE_READ_FORBIDDEN");
    expect(() => readFileSync(path.join(root, "data/archive/forbidden.json"))).toThrow(
      "H4_ENV_OR_ARCHIVE_READ_FORBIDDEN",
    );
    expect(() => new Database(path.join(root, "data/default.sqlite"))).toThrow(
      "H2 fixture path escapes its owned root",
    );
  });
});
