import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../schema/index.js";
import { assertMigrationsApplied } from "../migrations.js";
import { defaultPaperExchangeConfig } from "../../paper/PaperExchangeConfig.js";
import { PaperRunner } from "../../paper/PaperRunner.js";
import { h2Fixture } from "./H2Fixtures.js";
import { SessionRepository } from "../repositories/SessionRepository.js";

let fixture: ReturnType<typeof h2Fixture> | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  fixture?.cleanup();
  fixture = undefined;
});

describe("H2 retained defect regressions", () => {
  it("H-01 rolls back a BUY when the cash write fails", async () => {
    fixture = h2Fixture();
    vi.spyOn(SessionRepository.prototype, "applyAccountingDelta").mockImplementation(() => {
      throw new Error("injected cash failure");
    });
    await new PaperRunner({
      repositories: fixture.repositories,
      config: { ...defaultPaperExchangeConfig(), sessionId: fixture.session.id },
    }).runOnce();
    expect(fixture.repositories.fills.listFillsForSession(fixture.session.id)).toHaveLength(0);
    expect(fixture.repositories.positions.listOpenPositions(fixture.session.id)).toHaveLength(0);
  });
  it("H-02 prevents duplicate null-pair radar identities", () => {
    fixture = h2Fixture();
    expect(() => fixture!.repositories.tokenRadar.createRadarEntry(fixture!.radarInput)).toThrow();
  });
  it("H-02 prevents duplicate active positions", () => {
    fixture = h2Fixture();
    const position = {
      sessionId: fixture.session.id,
      mintAddress: fixture.radar.mintAddress,
      openedAtMs: 1_000,
      tokensHeld: "1",
    };
    fixture.repositories.positions.openPosition(position);
    expect(() => fixture!.repositories.positions.openPosition(position)).toThrow();
  });
  it("H-02 rejects negative cash through direct SQL", () => {
    fixture = h2Fixture();
    expect(() =>
      fixture!.context.sqlite.prepare("UPDATE sessions SET current_cash_lamports = -1").run(),
    ).toThrow();
  });
  it("H-04 rejects a sessions-only schema without a trusted migration chain", () => {
    const sqlite = new Database(":memory:");
    try {
      sqlite.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY)");
      expect(() =>
        assertMigrationsApplied({
          sqlite,
          db: drizzle(sqlite, { schema }),
          path: ":memory:",
          mode: "PAPER",
          close: () => sqlite.close(),
        }),
      ).toThrow();
    } finally {
      sqlite.close();
    }
  });
});
