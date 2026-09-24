import { afterEach, describe, expect, it } from "vitest";
import { h2Fixture } from "./H2Fixtures.js";
import type { AccountingRepositories } from "../AccountingUnitOfWork.js";

describe("H2 accounting transaction boundary", () => {
  const fixtures: ReturnType<typeof h2Fixture>[] = [];
  const fixture = () => {
    const f = h2Fixture();
    fixtures.push(f);
    return f;
  };
  afterEach(() => {
    for (const f of fixtures.splice(0)) f.cleanup();
  });

  it("rolls back earlier writes when an order or position transition is stale", () => {
    const f = fixture();
    const order = f.repositories.orders.createOrder({
      sessionId: f.session.id,
      mode: "PAPER",
      side: "BUY",
      mintAddress: f.radar.mintAddress,
    });
    f.repositories.orders.transitionOrder(order, "QUOTED");
    expect(() =>
      f.repositories.accounting.run((r) => {
        r.sessions.applyAccountingDelta(f.session, -10, 0);
        r.orders.transitionOrder(order, "FILLED");
      }),
    ).toThrow("STALE_ORDER");
    const position = f.repositories.positions.openPosition({
      sessionId: f.session.id,
      mintAddress: f.radar.mintAddress,
      openedAtMs: 1000,
      tokensHeld: "1",
    });
    f.repositories.positions.closePositionConditionally(position, {
      tokensHeld: "0",
      proceedsLamports: 10,
      realizedPnlLamports: 10,
    });
    expect(() =>
      f.repositories.accounting.run((r) => {
        r.sessions.applyAccountingDelta(f.session, 10, 10);
        r.positions.closePositionConditionally(position, {
          tokensHeld: "0",
          proceedsLamports: 10,
          realizedPnlLamports: 10,
        });
      }),
    ).toThrow("STALE_POSITION");
    expect(f.repositories.sessions.getSessionById(f.session.id)).toEqual(f.session);
  });

  it("commits cash and radar together and rolls both back on failure", () => {
    const f = fixture();
    expect(() =>
      f.repositories.accounting.run((r) => {
        r.sessions.applyAccountingDelta(f.session, -100, -25);
        r.tokenRadar.updateRadarStatus(f.radar.id, "BOUGHT");
        throw new Error("injected");
      }),
    ).toThrow("injected");
    expect(f.repositories.sessions.getSessionById(f.session.id)).toEqual(f.session);
    expect(f.repositories.tokenRadar.getRadarEntryById(f.radar.id)).toEqual(f.radar);
    f.repositories.accounting.run((r) => {
      r.sessions.applyAccountingDelta(f.session, -100, -25);
      r.tokenRadar.updateRadarStatus(f.radar.id, "BOUGHT");
    });
    expect(f.repositories.sessions.getSessionById(f.session.id)).toMatchObject({
      currentCashLamports: 999_999_900,
      realizedPnlLamports: -25,
    });
    expect(f.repositories.tokenRadar.getRadarEntryById(f.radar.id)?.status).toBe("BOUGHT");
  });

  it("rejects stale balances, unsafe sums and overdrafts without overwriting current cash", () => {
    const f = fixture();
    f.repositories.accounting.run((r) => r.sessions.applyAccountingDelta(f.session, -1, 0));
    expect(() =>
      f.repositories.accounting.run((r) => r.sessions.applyAccountingDelta(f.session, -10, 0)),
    ).toThrow("STALE_SESSION");
    for (const delta of [-2_000_000_000, Number.MAX_SAFE_INTEGER, 0.5, NaN]) {
      expect(() =>
        f.repositories.accounting.run((r) => r.sessions.applyAccountingDelta(f.session, delta, 0)),
      ).toThrow("INVALID_AMOUNT");
    }
    expect(f.repositories.sessions.getSessionById(f.session.id)?.currentCashLamports).toBe(
      999_999_999,
    );
  });

  it("invalidates escaped repositories and cached methods", () => {
    const f = fixture();
    let escaped: AccountingRepositories | undefined;
    const method = f.repositories.accounting.run((r) => {
      escaped = r;
      return r.sessions.getSessionById;
    });
    expect(() => method(f.session.id)).toThrow("TRANSACTION_EXPIRED");
    expect(() => escaped?.sessions.getSessionById(f.session.id)).toThrow("TRANSACTION_EXPIRED");
  });

  it("rolls back an async callback and prevents its late continuation", async () => {
    const f = fixture();
    let late: unknown;
    expect(() =>
      f.repositories.accounting.run(async (r) => {
        r.sessions.applyAccountingDelta(f.session, -1, 0);
        await Promise.resolve();
        try {
          r.tokenRadar.updateRadarStatus(f.radar.id, "BOUGHT");
        } catch (error) {
          late = error;
        }
      }),
    ).toThrow("ASYNC_CALLBACK");
    await Promise.resolve();
    expect(late).toBeInstanceOf(Error);
    expect(String(late)).toContain("TRANSACTION_EXPIRED");
    expect(f.repositories.sessions.getSessionById(f.session.id)).toEqual(f.session);
    expect(f.repositories.tokenRadar.getRadarEntryById(f.radar.id)).toEqual(f.radar);
  });

  it("rejects nesting and rolls back the enclosing writes", () => {
    const f = fixture();
    expect(() =>
      f.repositories.accounting.run((r) => {
        r.sessions.applyAccountingDelta(f.session, -1, 0);
        f.repositories.accounting.run(() => undefined);
      }),
    ).toThrow("NESTED_TRANSACTION");
    expect(f.repositories.sessions.getSessionById(f.session.id)).toEqual(f.session);
  });

  it.each([null, "pair-a"])("merges radar identity atomically for pair %s", (pairAddress) => {
    const f = fixture();
    const repo = f.repositories.tokenRadar;
    const original = repo.upsertRadarEntry({ ...f.radarInput, pairAddress, symbol: "OLD" });
    repo.updateRadarStatus(original.id, "BOUGHT");
    const newer = repo.upsertRadarEntry({
      ...f.radarInput,
      pairAddress,
      id: "discarded-id",
      discoveredAtMs: 2000,
      firstSeenAtMs: 900,
      priceSol: "0.002",
    });
    expect(newer).toMatchObject({
      id: original.id,
      createdAtMs: original.createdAtMs,
      firstSeenAtMs: 900,
      priceSol: "0.002",
      status: "BOUGHT",
      symbol: original.symbol,
    });
    const tied = repo.upsertRadarEntry({
      ...f.radarInput,
      pairAddress,
      discoveredAtMs: 2000,
      priceSol: "999",
    });
    expect(tied).toEqual(newer);
    const older = repo.upsertRadarEntry({
      ...f.radarInput,
      pairAddress,
      discoveredAtMs: 1500,
      priceSol: "888",
    });
    expect(older).toEqual(newer);
    expect(
      repo.listRadarEntries(f.session.id).filter((row) => row.pairAddress === pairAddress),
    ).toHaveLength(1);
  });

  it("normalizes missing pairs and keeps distinct pairs separate", () => {
    const f = fixture();
    const repo = f.repositories.tokenRadar;
    expect(repo.upsertRadarEntry({ ...f.radarInput, pairAddress: null }).id).toBe(f.radar.id);
    const a = repo.upsertRadarEntry({ ...f.radarInput, pairAddress: "a" });
    const b = repo.upsertRadarEntry({ ...f.radarInput, pairAddress: "b" });
    expect(a.id).not.toBe(b.id);
    expect(() => repo.upsertRadarEntry({ ...f.radarInput, pairAddress: "  " })).toThrow(
      "INVALID_PAIR",
    );
  });
});
