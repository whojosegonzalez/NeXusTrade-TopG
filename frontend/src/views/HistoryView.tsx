import type { HistoricalSessionSummary } from "@nexustrade/shared";

export interface HistoryViewProps {
  readonly sessions?: readonly HistoricalSessionSummary[];
}

interface DaySessionGroup {
  readonly dateLabel: string;
  readonly dateKey: string;
  readonly sessions: HistoricalSessionSummary[];
  readonly dayStartingCapital: number;
  readonly dayEndingCapital: number;
  readonly dayNetPnlSol: number;
  readonly dayNetPnlPct: number;
  readonly totalBuys: number;
  readonly totalSells: number;
  readonly totalWatched: number;
  readonly totalMissed: number;
}

function formatSessionDate(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return isoString.slice(0, 10);
  }
}

function formatTimeWindow(startedAt: string, endedAt: string): string {
  try {
    const d1 = new Date(startedAt);
    const d2 = new Date(endedAt);
    const t1 = d1.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    });
    const t2 = d2.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    });
    return `${t1} - ${t2} UTC`;
  } catch {
    return `${startedAt.slice(11, 16)} - ${endedAt.slice(11, 16)} UTC`;
  }
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0) {
    return `${h}h ${m.toString().padStart(2, "0")}m`;
  }
  return `${m}m`;
}

function groupSessionsByDate(
  sessions: readonly HistoricalSessionSummary[],
): readonly DaySessionGroup[] {
  const map = new Map<string, HistoricalSessionSummary[]>();

  for (const session of sessions) {
    const dateKey = session.startedAt.slice(0, 10);
    const existing = map.get(dateKey) ?? [];
    existing.push(session);
    map.set(dateKey, existing);
  }

  const groups: DaySessionGroup[] = [];
  const sortedDateKeys = Array.from(map.keys()).sort().reverse();

  for (const dateKey of sortedDateKeys) {
    const daySessions = (map.get(dateKey) ?? []).slice().sort((a, b) => {
      return new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime();
    });

    if (daySessions.length === 0) continue;

    const firstSession = daySessions[0]!;
    const lastSession = daySessions[daySessions.length - 1]!;
    const dayStartingCapital = firstSession.startingCapitalSol;
    const dayEndingCapital = lastSession.endingCapitalSol;
    const dayNetPnlSol = daySessions.reduce((acc, s) => acc + s.netPnlSol, 0);
    const dayNetPnlPct = dayStartingCapital > 0 ? (dayNetPnlSol / dayStartingCapital) * 100 : 0;
    const totalBuys = daySessions.reduce((acc, s) => acc + (s.buysCount ?? s.totalTrades), 0);
    const totalSells = daySessions.reduce((acc, s) => acc + (s.sellsCount ?? s.totalTrades), 0);
    const totalWatched = daySessions.reduce((acc, s) => acc + (s.coinsWatchedCount ?? 0), 0);
    const totalMissed = daySessions.reduce((acc, s) => acc + (s.missedOpportunitiesCount ?? 0), 0);

    groups.push({
      dateLabel: formatSessionDate(firstSession.startedAt),
      dateKey,
      sessions: daySessions,
      dayStartingCapital,
      dayEndingCapital,
      dayNetPnlSol,
      dayNetPnlPct,
      totalBuys,
      totalSells,
      totalWatched,
      totalMissed,
    });
  }

  return groups;
}

export function HistoryView({ sessions = [] }: HistoryViewProps) {
  if (sessions.length === 0) {
    return (
      <div className="view-container" data-testid="history-view">
        <div className="view-header">
          <h1>Past Sessions & Daily Performance Ledger</h1>
          <p className="subtitle">
            Audit daily operational track records, portfolio capital progression, and macro
            discovery flow without noise.
          </p>
        </div>
        <div className="empty-card">
          <p>No historical trading sessions found in archive.</p>
          <p className="hint">
            Completed sessions recorded by the daemon will automatically populate here.
          </p>
        </div>
      </div>
    );
  }

  const dateGroups = groupSessionsByDate(sessions);

  // Aggregate high-level stats across all sessions
  const totalSessions = sessions.length;
  const totalTrades = sessions.reduce((acc, s) => acc + s.totalTrades, 0);
  const totalWins = sessions.reduce((acc, s) => acc + s.winsCount, 0);
  const totalLosses = sessions.reduce((acc, s) => acc + s.lossesCount, 0);
  const totalScratches = sessions.reduce((acc, s) => acc + s.scratchesCount, 0);
  const totalNetPnlSol = sessions.reduce((acc, s) => acc + s.netPnlSol, 0);
  const overallWinRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
  const isCumulativePositive = totalNetPnlSol >= 0;

  const totalBuysAll = sessions.reduce((acc, s) => acc + (s.buysCount ?? s.totalTrades), 0);
  const totalSellsAll = sessions.reduce((acc, s) => acc + (s.sellsCount ?? s.totalTrades), 0);
  const totalWatchedAll = sessions.reduce((acc, s) => acc + (s.coinsWatchedCount ?? 0), 0);
  const totalMissedAll = sessions.reduce((acc, s) => acc + (s.missedOpportunitiesCount ?? 0), 0);

  return (
    <div className="view-container" data-testid="history-view">
      <div className="view-header">
        <h1>Past Sessions & Daily Performance Ledger</h1>
        <p className="subtitle">
          Audit daily operational track records, portfolio capital progression, and macro discovery
          flow without noise.
        </p>
      </div>

      {/* 1. High-Level Executive Summary Cards */}
      <section className="dashboard-section" aria-label="Cumulative Stats">
        <h2>Executive Portfolio Overview</h2>
        <div className="telemetry-grid">
          <div
            className={`stat-card main-pnl ${isCumulativePositive ? "pnl-card-pos" : "pnl-card-neg"}`}
          >
            <span className="stat-label">Cumulative Net P/L</span>
            <span className="stat-value big">
              {isCumulativePositive ? "+" : ""}
              {totalNetPnlSol.toFixed(4)} SOL
            </span>
            <span className="stat-sub">
              {totalSessions} session{totalSessions > 1 ? "s" : ""} across {dateGroups.length}{" "}
              trading day{dateGroups.length > 1 ? "s" : ""}
            </span>
          </div>

          <div className="stat-card">
            <span className="stat-label">Win Rate & Execution</span>
            <span className="stat-value text-green">{overallWinRate.toFixed(1)}%</span>
            <span className="stat-sub">
              {totalWins}W / {totalLosses}L / {totalScratches}S ({totalTrades} closed trades)
            </span>
          </div>

          <div className="stat-card">
            <span className="stat-label">Discovery & Filter Efficiency</span>
            <span className="stat-value">{totalWatchedAll}</span>
            <span className="stat-sub">
              {totalWatchedAll} candidates watched · {totalMissedAll} missed opportunities
            </span>
          </div>

          <div className="stat-card">
            <span className="stat-label">Total Execution Orders</span>
            <span className="stat-value">
              {totalBuysAll} / {totalSellsAll}
            </span>
            <span className="stat-sub">Buys / Sells filled</span>
          </div>
        </div>
      </section>

      {/* 2. Date-Grouped Performance Sections */}
      <section className="dashboard-section" aria-label="Daily Performance Ledger">
        <h2>Daily Performance Ledger</h2>
        <div className="daily-ledger-container">
          {dateGroups.map((group) => {
            const isDayPos = group.dayNetPnlSol >= 0;
            return (
              <div
                key={group.dateKey}
                className="day-ledger-card"
                data-testid={`day-section-${group.dateKey}`}
                style={{
                  marginBottom: "24px",
                  background: "var(--card-bg, #1a1a24)",
                  border: "1px solid var(--border-color, #2a2a38)",
                  borderRadius: "8px",
                  overflow: "hidden",
                }}
              >
                {/* Date Section Summary Bar */}
                <div
                  className="day-summary-bar"
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "14px 20px",
                    background: "var(--header-bg, #222230)",
                    borderBottom: "1px solid var(--border-color, #2a2a38)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <span style={{ fontSize: "1.1rem", fontWeight: 700 }}>
                      📅 {group.dateLabel}
                    </span>
                    <span
                      className="badge"
                      style={{
                        fontSize: "0.8rem",
                        padding: "2px 8px",
                        background: "rgba(255,255,255,0.1)",
                        borderRadius: "4px",
                      }}
                    >
                      {group.sessions.length} Session{group.sessions.length > 1 ? "s" : ""} Ran
                    </span>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "24px",
                      fontSize: "0.95rem",
                    }}
                  >
                    <div>
                      <span style={{ color: "var(--text-muted, #888)", marginRight: "6px" }}>
                        Day Capital:
                      </span>
                      <strong>
                        {group.dayStartingCapital.toFixed(4)} → {group.dayEndingCapital.toFixed(4)}{" "}
                        SOL
                      </strong>
                    </div>

                    <div>
                      <span style={{ color: "var(--text-muted, #888)", marginRight: "6px" }}>
                        Cumulative Day P/L:
                      </span>
                      <strong className={isDayPos ? "text-green" : "text-red"}>
                        {isDayPos ? "+" : ""}
                        {group.dayNetPnlSol.toFixed(4)} SOL ({isDayPos ? "+" : ""}
                        {group.dayNetPnlPct.toFixed(2)}%)
                      </strong>
                    </div>
                  </div>
                </div>

                {/* Executive Sessions Table (Zero Coin Clutter) */}
                <div className="table-responsive">
                  <table className="history-table" style={{ width: "100%", margin: 0 }}>
                    <thead>
                      <tr>
                        <th>Time Window</th>
                        <th>Duration</th>
                        <th>Buys / Sells</th>
                        <th>Coins Watched</th>
                        <th>Missed Opportunities</th>
                        <th>Session P/L</th>
                        <th>Capital Delta</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.sessions.map((s) => {
                        const isPos = s.netPnlSol >= 0;
                        return (
                          <tr
                            key={s.sessionId}
                            className="session-summary-row"
                            data-testid={`session-row-${s.sessionId}`}
                          >
                            <td>
                              <strong>{formatTimeWindow(s.startedAt, s.endedAt)}</strong>
                              <div
                                style={{ fontSize: "0.75rem", color: "var(--text-muted, #888)" }}
                              >
                                <code>{s.sessionId}</code>
                              </div>
                            </td>
                            <td>{formatDuration(s.durationMinutes)}</td>
                            <td>
                              {s.buysCount ?? s.totalTrades} / {s.sellsCount ?? s.totalTrades}
                            </td>
                            <td>{s.coinsWatchedCount ?? 0} candidates</td>
                            <td>
                              <span
                                style={{
                                  color:
                                    (s.missedOpportunitiesCount ?? 0) > 0
                                      ? "var(--color-warning, #f59e0b)"
                                      : "inherit",
                                }}
                              >
                                {s.missedOpportunitiesCount ?? 0} missed
                              </span>
                            </td>
                            <td className={isPos ? "text-green font-bold" : "text-red font-bold"}>
                              {isPos ? "+" : ""}
                              {s.netPnlSol.toFixed(4)} SOL ({isPos ? "+" : ""}
                              {s.netPnlPct.toFixed(2)}%)
                            </td>
                            <td>
                              {s.startingCapitalSol.toFixed(4)} → {s.endingCapitalSol.toFixed(4)}{" "}
                              SOL
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
