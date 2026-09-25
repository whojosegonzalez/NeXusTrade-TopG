import { useState } from "react";
import type { HistoricalSessionSummary, HistoricalTrade } from "@nexustrade/shared";

export interface HistoryViewProps {
  readonly sessions?: readonly HistoricalSessionSummary[];
}

export function HistoryView({ sessions = [] }: HistoryViewProps) {
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);

  if (sessions.length === 0) {
    return (
      <div className="view-container" data-testid="history-view">
        <div className="view-header">
          <h1>Past Sessions & Performance Ledger</h1>
          <p className="subtitle">
            Audit historical trading sessions, individual trade lifecycles, and cumulative portfolio
            growth.
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

  // Aggregate stats across all historical sessions
  const totalSessions = sessions.length;
  const totalTrades = sessions.reduce((acc, s) => acc + s.totalTrades, 0);
  const totalWins = sessions.reduce((acc, s) => acc + s.winsCount, 0);
  const totalLosses = sessions.reduce((acc, s) => acc + s.lossesCount, 0);
  const totalScratches = sessions.reduce((acc, s) => acc + s.scratchesCount, 0);
  const totalNetPnlSol = sessions.reduce((acc, s) => acc + s.netPnlSol, 0);
  const overallWinRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
  const isCumulativePositive = totalNetPnlSol >= 0;

  // Compute equity points for chart
  let runningEquity = sessions[0]?.startingCapitalSol ?? 10.0;
  const equityPoints: { label: string; equity: number }[] = [
    { label: "Start", equity: runningEquity },
  ];
  for (const s of sessions) {
    runningEquity += s.netPnlSol;
    equityPoints.push({ label: s.sessionId.slice(-6), equity: runningEquity });
  }

  const minEquity = Math.min(...equityPoints.map((p) => p.equity));
  const maxEquity = Math.max(...equityPoints.map((p) => p.equity));
  const equityRange = maxEquity - minEquity || 1.0;

  const svgWidth = 600;
  const svgHeight = 160;
  const padding = 20;
  const chartWidth = svgWidth - padding * 2;
  const chartHeight = svgHeight - padding * 2;

  const pointsString = equityPoints
    .map((pt, idx) => {
      const x = padding + (idx / Math.max(1, equityPoints.length - 1)) * chartWidth;
      const y = padding + chartHeight - ((pt.equity - minEquity) / equityRange) * chartHeight;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const toggleExpand = (sessionId: string) => {
    setExpandedSessionId((prev) => (prev === sessionId ? null : sessionId));
  };

  return (
    <div className="view-container" data-testid="history-view">
      <div className="view-header">
        <h1>Past Sessions & Performance Ledger</h1>
        <p className="subtitle">
          Audit historical trading sessions, individual trade lifecycles, and cumulative portfolio
          growth.
        </p>
      </div>

      {/* 1. Cumulative Performance Overview */}
      <section className="dashboard-section" aria-label="Cumulative Stats">
        <h2>Cumulative Performance Overview</h2>
        <div className="telemetry-grid">
          <div
            className={`stat-card main-pnl ${isCumulativePositive ? "pnl-card-pos" : "pnl-card-neg"}`}
          >
            <span className="stat-label">Cumulative Net P/L</span>
            <span className="stat-value big">
              {isCumulativePositive ? "+" : ""}
              {totalNetPnlSol.toFixed(4)} SOL
            </span>
            <span className="stat-sub">Across {totalSessions} completed sessions</span>
          </div>

          <div className="stat-card">
            <span className="stat-label">Overall Win Rate</span>
            <span className="stat-value text-green">{overallWinRate.toFixed(1)}%</span>
            <span className="stat-sub">
              {totalWins}W / {totalLosses}L / {totalScratches}S ({totalTrades} trades)
            </span>
          </div>

          <div className="stat-card">
            <span className="stat-label">Total Completed Sessions</span>
            <span className="stat-value">{totalSessions}</span>
            <span className="stat-sub">Ledger records verified</span>
          </div>
        </div>
      </section>

      {/* 2. Cumulative Equity Curve Chart */}
      <section className="dashboard-section chart-section" aria-label="Equity Curve Chart">
        <h2>Cumulative Equity Progression (SOL)</h2>
        <div className="chart-container">
          <svg
            viewBox={`0 0 ${svgWidth} ${svgHeight}`}
            className="equity-chart-svg"
            role="img"
            aria-label="Cumulative Equity Curve"
          >
            {/* Grid baseline */}
            <line
              x1={padding}
              y1={padding + chartHeight}
              x2={padding + chartWidth}
              y2={padding + chartHeight}
              stroke="var(--border-color, #333)"
              strokeWidth="1"
            />
            {/* Polyline */}
            <polyline
              fill="none"
              stroke="var(--accent-color, #10b981)"
              strokeWidth="3"
              points={pointsString}
            />
            {/* Points */}
            {equityPoints.map((pt, idx) => {
              const x = padding + (idx / Math.max(1, equityPoints.length - 1)) * chartWidth;
              const y =
                padding + chartHeight - ((pt.equity - minEquity) / equityRange) * chartHeight;
              return (
                <circle
                  key={`${pt.label}-${idx}`}
                  cx={x}
                  cy={y}
                  r="4"
                  fill="var(--accent-color, #10b981)"
                />
              );
            })}
          </svg>
          <div className="chart-bounds">
            <span>Min: {minEquity.toFixed(4)} SOL</span>
            <span>Max: {maxEquity.toFixed(4)} SOL</span>
            <span>Current: {runningEquity.toFixed(4)} SOL</span>
          </div>
        </div>
      </section>

      {/* 3. Historical Sessions Ledger */}
      <section className="dashboard-section" aria-label="Historical Sessions Table">
        <h2>Completed Sessions Ledger ({sessions.length})</h2>
        <div className="table-responsive">
          <table className="history-table">
            <thead>
              <tr>
                <th>Session ID</th>
                <th>Date / Time</th>
                <th>Duration</th>
                <th>Capital (Start &rarr; End)</th>
                <th>Net P/L ($SOL$)</th>
                <th>Net P/L (%)</th>
                <th>Win Rate</th>
                <th>Trades (W/L/S)</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const isPos = s.netPnlSol >= 0;
                const isExpanded = expandedSessionId === s.sessionId;
                return (
                  <tr
                    key={s.sessionId}
                    className="session-summary-row"
                    data-testid={`session-row-${s.sessionId}`}
                  >
                    <td>
                      <code>{s.sessionId}</code>
                    </td>
                    <td>{new Date(s.startedAt).toLocaleString()}</td>
                    <td>{s.durationMinutes} min</td>
                    <td>
                      {s.startingCapitalSol.toFixed(2)} &rarr; {s.endingCapitalSol.toFixed(2)} SOL
                    </td>
                    <td className={isPos ? "text-green font-bold" : "text-red font-bold"}>
                      {isPos ? "+" : ""}
                      {s.netPnlSol.toFixed(4)} SOL
                    </td>
                    <td className={isPos ? "text-green" : "text-red"}>
                      {isPos ? "+" : ""}
                      {s.netPnlPct.toFixed(2)}%
                    </td>
                    <td>{s.winRatePct.toFixed(1)}%</td>
                    <td>
                      {s.winsCount}W / {s.lossesCount}L / {s.scratchesCount}S ({s.totalTrades})
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-xs btn-outline"
                        onClick={() => toggleExpand(s.sessionId)}
                      >
                        {isExpanded ? "Hide Trades" : `View Trades (${s.trades.length})`}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Trade Drill-down Modal/Section for Expanded Session */}
        {expandedSessionId &&
          (() => {
            const activeSession = sessions.find((s) => s.sessionId === expandedSessionId);
            if (!activeSession) return null;

            return (
              <div className="trade-drilldown-card" data-testid="trade-drilldown">
                <div className="drilldown-header">
                  <h3>Individual Trades for Session: {activeSession.sessionId}</h3>
                  <button
                    type="button"
                    className="btn btn-xs btn-secondary"
                    onClick={() => setExpandedSessionId(null)}
                  >
                    Close
                  </button>
                </div>

                {activeSession.trades.length === 0 ? (
                  <p className="empty-state">No trades executed during this session.</p>
                ) : (
                  <div className="table-responsive">
                    <table className="trades-table">
                      <thead>
                        <tr>
                          <th>Token</th>
                          <th>Entry Price</th>
                          <th>Exit Price</th>
                          <th>Hold Time</th>
                          <th>Peak Gain</th>
                          <th>Net P/L ($SOL$)</th>
                          <th>Net P/L (%)</th>
                          <th>Exit Tier</th>
                          <th>Exit Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeSession.trades.map((trade: HistoricalTrade) => {
                          const isTradePos = trade.finalPnlBps >= 0;
                          const pnlPct = (trade.finalPnlBps / 100).toFixed(2);
                          const peakPct = (trade.peakGainBps / 100).toFixed(2);
                          return (
                            <tr key={trade.tradeId} className="trade-row">
                              <td>
                                <strong>{trade.symbol}</strong>
                                <span className="sub-mint">
                                  {trade.mintAddress.slice(0, 4)}...{trade.mintAddress.slice(-4)}
                                </span>
                              </td>
                              <td>{trade.entryPriceSol.toFixed(6)} SOL</td>
                              <td>{trade.exitPriceSol.toFixed(6)} SOL</td>
                              <td>{trade.holdDurationSeconds}s</td>
                              <td className="text-green">+{peakPct}%</td>
                              <td
                                className={
                                  isTradePos ? "text-green font-bold" : "text-red font-bold"
                                }
                              >
                                {isTradePos ? "+" : ""}
                                {trade.finalPnlSol.toFixed(4)} SOL
                              </td>
                              <td
                                className={
                                  isTradePos ? "text-green font-bold" : "text-red font-bold"
                                }
                              >
                                {isTradePos ? `+${pnlPct}%` : `${pnlPct}%`}
                              </td>
                              <td>
                                <span className="tier-pill">{trade.finalTier}</span>
                              </td>
                              <td className="exit-reason-col">{trade.exitReason}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })()}
      </section>
    </div>
  );
}
