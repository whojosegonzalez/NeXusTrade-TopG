import type {
  ActiveSessionTelemetry,
  LivePaperPosition,
  RatchetTier,
  SessionControlAction,
} from "@nexustrade/shared";

export interface ActiveSessionViewProps {
  readonly session?: ActiveSessionTelemetry | undefined;
  readonly onSendCommand?: (action: SessionControlAction, targetPositionId?: string) => void;
}

function getTierBadgeInfo(tier: RatchetTier): { label: string; className: string } {
  switch (tier) {
    case "TIER_2":
      return { label: "TIER 2 LOCKED (+35%)", className: "tier-badge tier-2" };
    case "TIER_1":
      return { label: "TIER 1 LOCKED (+20%)", className: "tier-badge tier-1" };
    case "SCRATCH":
      return { label: "SCRATCH ARMED (+0.5%)", className: "tier-badge tier-scratch" };
    case "RUNNING":
      return { label: "RUNNING", className: "tier-badge tier-running" };
    case "TIER_0_DRAWDOWN":
      return { label: "SMART HOLD (-8% GRACE)", className: "tier-badge tier-drawdown" };
    case "HARD_STOP":
    default:
      return { label: "ENTRY STOP", className: "tier-badge tier-hard-stop" };
  }
}

function formatDuration(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

export function ActiveSessionView({ session, onSendCommand }: ActiveSessionViewProps) {
  if (!session) {
    return (
      <div className="view-container" data-testid="active-session-view">
        <div className="view-header">
          <h1>Active Trading Session</h1>
          <p className="subtitle">
            Real-time telemetry, dynamic ratchet stops, and session controls.
          </p>
        </div>
        <div className="empty-card">
          <p>No active paper trading daemon running or session state file found.</p>
          <p className="hint">
            Start the daemon via <code>pnpm daemon:paper</code> to begin streaming live session
            telemetry.
          </p>
        </div>
      </div>
    );
  }

  const isNetPositive = session.netSessionPnlSol >= 0;
  const isRealizedPositive = session.realizedPnlSol >= 0;
  const isUnrealizedPositive = session.unrealizedPnlSol >= 0;

  const handleAction = (action: SessionControlAction, positionId?: string) => {
    if (onSendCommand) {
      onSendCommand(action, positionId);
    }
  };

  return (
    <div className="view-container" data-testid="active-session-view">
      <div className="view-header">
        <div className="header-title-row">
          <h1>Active Trading Session</h1>
          <span className={`status-badge status-${session.status.toLowerCase()}`}>
            {session.status}
          </span>
        </div>
        <p className="subtitle">
          Session ID: <code>{session.sessionId}</code> | Elapsed:{" "}
          <strong>{formatDuration(session.elapsedSeconds)}</strong> / Planned:{" "}
          {session.durationHours}h
        </p>
      </div>

      {/* 1. Telemetry Banner */}
      <section className="dashboard-section telemetry-banner" aria-label="Telemetry Banner">
        <div className="telemetry-grid">
          <div className={`stat-card main-pnl ${isNetPositive ? "pnl-card-pos" : "pnl-card-neg"}`}>
            <span className="stat-label">Net Session P/L</span>
            <span className="stat-value big">
              {isNetPositive ? "+" : ""}
              {session.netSessionPnlSol.toFixed(4)} SOL
            </span>
            <span className="stat-sub">
              ({isNetPositive ? "+" : ""}
              {session.netSessionPnlPct.toFixed(2)}%)
            </span>
          </div>

          <div className="stat-card">
            <span className="stat-label">Realized P/L</span>
            <span className={`stat-value ${isRealizedPositive ? "text-green" : "text-red"}`}>
              {isRealizedPositive ? "+" : ""}
              {session.realizedPnlSol.toFixed(4)} SOL
            </span>
            <span className="stat-sub">Closed Trades: {session.closedTradesCount}</span>
          </div>

          <div className="stat-card">
            <span className="stat-label">Unrealized P/L</span>
            <span className={`stat-value ${isUnrealizedPositive ? "text-green" : "text-red"}`}>
              {isUnrealizedPositive ? "+" : ""}
              {session.unrealizedPnlSol.toFixed(4)} SOL
            </span>
            <span className="stat-sub">Open: {session.openPositionCount} positions</span>
          </div>

          <div className="stat-card">
            <span className="stat-label">Portfolio Equity</span>
            <span className="stat-value">{session.currentPortfolioSol.toFixed(4)} SOL</span>
            <span className="stat-sub">Initial: {session.initialPortfolioSol.toFixed(4)} SOL</span>
          </div>
        </div>
      </section>

      {/* 2. 5-Stat Metric Counter Grid */}
      <section className="dashboard-section" aria-label="Performance Counters">
        <h2>Performance Metrics & Trade Breakdown</h2>
        <div className="counters-grid">
          <div className="counter-card">
            <span className="counter-num">
              {session.openPositionCount} / {session.maxConcurrentPositions}
            </span>
            <span className="counter-lbl">Open Positions</span>
          </div>

          <div className="counter-card">
            <span className="counter-num">{session.closedTradesCount}</span>
            <span className="counter-lbl">Total Closed</span>
          </div>

          <div className="counter-card card-win">
            <span className="counter-num text-green">{session.winsCount}</span>
            <span className="counter-lbl">Wins (&ge; +1.0%)</span>
          </div>

          <div className="counter-card card-loss">
            <span className="counter-num text-red">{session.lossesCount}</span>
            <span className="counter-lbl">Losses (&lt; -1.0%)</span>
          </div>

          <div className="counter-card card-scratch">
            <span className="counter-num text-muted">{session.scratchesCount}</span>
            <span className="counter-lbl">Scratches (&plusmn;1.0%)</span>
          </div>
        </div>
      </section>

      {/* 3. Session Controls Suite */}
      <section className="dashboard-section controls-section" aria-label="Session Control Suite">
        <h2>Session Control Suite</h2>
        <div className="controls-button-group">
          {session.status === "RUNNING" && (
            <button type="button" className="btn btn-warning" onClick={() => handleAction("PAUSE")}>
              ⏸ Pause Session
            </button>
          )}

          {session.status === "PAUSED" && (
            <button
              type="button"
              className="btn btn-success"
              onClick={() => handleAction("RESUME")}
            >
              ▶ Resume Session
            </button>
          )}

          {(session.status === "RUNNING" || session.status === "PAUSED") && (
            <button
              type="button"
              className="btn btn-purple"
              onClick={() => handleAction("START_EXITING")}
            >
              🛑 Start Exiting (Graceful Wind-Down)
            </button>
          )}

          {session.status !== "COMPLETED" && session.status !== "HALTED" && (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                if (window.confirm("EMERGENCY STOP: Close all positions and halt immediately?")) {
                  handleAction("EMERGENCY_STOP");
                }
              }}
            >
              ⚠️ Emergency Stop
            </button>
          )}
        </div>
      </section>

      {/* 4. Open Positions & Dynamic Ratchets */}
      <section className="dashboard-section" aria-label="Open Positions Grid">
        <div className="section-title-row">
          <h2>Active Open Positions ({session.openPositions.length})</h2>
          <span className="capacity-indicator">
            Capacity: {session.openPositions.length} / {session.maxConcurrentPositions}
          </span>
        </div>

        {session.openPositions.length === 0 ? (
          <div className="empty-state-box">No open positions currently active in this session.</div>
        ) : (
          <div className="table-responsive" style={{ maxHeight: "320px", overflowY: "auto" }}>
            <table className="positions-table">
              <thead>
                <tr>
                  <th>Token / Symbol</th>
                  <th>Entry Price</th>
                  <th>Current Spot</th>
                  <th>Unrealized PnL</th>
                  <th>Peak Gain</th>
                  <th>Stop Floor</th>
                  <th>Tier Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {session.openPositions.map((pos: LivePaperPosition) => {
                  const isPos = pos.currentPnlBps >= 0;
                  const pnlPct = (pos.currentPnlBps / 100).toFixed(2);
                  const peakPct = (pos.peakGainBps / 100).toFixed(2);
                  const floorPct = (pos.currentStopFloorBps / 100).toFixed(2);
                  const tierInfo = getTierBadgeInfo(pos.activeTier);
                  const stopDistancePct = (
                    (pos.currentPnlBps - pos.currentStopFloorBps) /
                    100
                  ).toFixed(2);

                  return (
                    <tr
                      key={pos.positionId}
                      className={
                        pos.drawdownState === "EVALUATING_DRAWDOWN" ? "row-drawdown-evaluating" : ""
                      }
                      data-testid={`active-pos-${pos.positionId}`}
                    >
                      <td>
                        <a
                          href={`https://birdeye.so/solana/token/${encodeURIComponent(pos.mintAddress)}?tab=trades&trades_layout=table`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="token-link"
                          title={`View ${pos.symbol ?? pos.mintAddress} on Birdeye`}
                        >
                          <strong className="pos-symbol">
                            {pos.symbol ??
                              `${pos.mintAddress.slice(0, 4)}...${pos.mintAddress.slice(-4)}`}
                          </strong>
                          <span className="sub-mint opacity-60 ml-1" title={pos.mintAddress}>
                            ({pos.mintAddress.slice(0, 4)}...{pos.mintAddress.slice(-4)})
                          </span>
                        </a>
                      </td>
                      <td>{pos.entryPriceSol.toFixed(6)} SOL</td>
                      <td>{pos.spotPriceSol.toFixed(6)} SOL</td>
                      <td>
                        <span
                          className={`metric-value ${isPos ? "pnl-positive text-green" : "pnl-negative text-red"}`}
                        >
                          {isPos ? `+${pnlPct}%` : `${pnlPct}%`}
                        </span>
                      </td>
                      <td>
                        <span className="text-green">+{peakPct}%</span>
                      </td>
                      <td>
                        <span>{floorPct}%</span>
                        <span className="sub-text text-muted"> ({stopDistancePct}% away)</span>
                      </td>
                      <td>
                        <span className={tierInfo.className}>{tierInfo.label}</span>
                        {pos.drawdownState === "EVALUATING_DRAWDOWN" && (
                          <span className="sub-tag drawdown-tag">⚠️ Smart Hold (-8%)</span>
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-danger"
                          onClick={() => handleAction("MANUAL_EXIT", pos.positionId)}
                        >
                          Market Close Position
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 5. Candidate Watchlist & Buy Gate Funnel */}
      <section className="dashboard-section" aria-label="Watchlist Table">
        <h2>Candidate Watchlist Radar & Buy Gate ({session.watchlist.length})</h2>
        {session.watchlist.length === 0 ? (
          <div className="empty-state-box">No candidates currently on the screening radar.</div>
        ) : (
          <div className="table-responsive">
            <table className="watchlist-table">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Age</th>
                  <th>Liquidity</th>
                  <th>Market Cap</th>
                  <th>L/MC Depth</th>
                  <th>5m Volume</th>
                  <th>5m Buys / Sells</th>
                  <th>Buy Gate Status</th>
                </tr>
              </thead>
              <tbody>
                {session.watchlist.map((item) => {
                  const ageMins = Math.floor(item.assetAgeSeconds / 60);
                  const ageSecs = item.assetAgeSeconds % 60;
                  return (
                    <tr
                      key={item.poolId}
                      className={`row-status-${item.status.toLowerCase()}`}
                      data-testid={`watchlist-${item.poolId}`}
                    >
                      <td>
                        <a
                          href={`https://birdeye.so/solana/token/${encodeURIComponent(item.mintAddress)}?tab=trades&trades_layout=table`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="token-link"
                          title={`View ${item.symbol} on Birdeye`}
                        >
                          <strong title={item.mintAddress}>{item.symbol}</strong>
                          <span className="sub-mint opacity-60 ml-1">
                            ({item.mintAddress.slice(0, 4)}...{item.mintAddress.slice(-4)})
                          </span>
                        </a>
                      </td>
                      <td>
                        {ageMins}m {ageSecs}s
                      </td>
                      <td>
                        ${item.liquidityUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </td>
                      <td>
                        ${item.marketCapUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </td>
                      <td>{(item.lmcRatio * 100).toFixed(1)}%</td>
                      <td>
                        ${item.volume5mUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </td>
                      <td>
                        {item.buys5m} / {item.sells5m} ({item.buyToSellRatio.toFixed(1)}x)
                      </td>
                      <td>
                        <span className={`status-pill pill-${item.status.toLowerCase()}`}>
                          {item.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 6. Live Activity Log */}
      <section className="dashboard-section" aria-label="Activity Feed">
        <h2>Live Session Activity Feed</h2>
        {session.recentActivityLogs.length === 0 ? (
          <div className="empty-state-box">No activity events logged yet.</div>
        ) : (
          <div className="table-responsive" style={{ maxHeight: "520px", overflowY: "auto" }}>
            <table className="activity-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Type</th>
                  <th>Activity Details</th>
                </tr>
              </thead>
              <tbody>
                {session.recentActivityLogs.map((log, idx) => (
                  <tr key={`${log.timestamp}-${idx}`}>
                    <td className="activity-time">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </td>
                    <td>
                      <span className={`activity-badge badge-log-${log.type.toLowerCase()}`}>
                        {log.type}
                      </span>
                    </td>
                    <td className="activity-message">
                      {log.mintAddress ? (
                        <>
                          <a
                            href={`https://birdeye.so/solana/token/${encodeURIComponent(log.mintAddress)}?tab=trades&trades_layout=table`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="token-link"
                            title={`View ${log.symbol ?? "token"} on Birdeye`}
                            style={{ marginRight: "8px", fontWeight: "bold" }}
                          >
                            [
                            {log.symbol ??
                              `${log.mintAddress.slice(0, 4)}...${log.mintAddress.slice(-4)}`}
                            ]
                          </a>
                          <span>{log.message}</span>
                        </>
                      ) : (
                        log.message
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
