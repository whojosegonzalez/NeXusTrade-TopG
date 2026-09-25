import type { LivePaperPosition, RatchetTier } from "@nexustrade/shared";

interface LivePositionsGridProps {
  readonly positions: readonly LivePaperPosition[];
}

function getTierBadgeClass(tier: RatchetTier): string {
  switch (tier) {
    case "TIER_2":
      return "tier-badge tier-2"; // +45% lock (purple/gold)
    case "TIER_1":
      return "tier-badge tier-1"; // +20% lock (green)
    case "SCRATCH":
      return "tier-badge tier-scratch"; // scratch exit (slate)
    case "TIER_0_DRAWDOWN":
      return "tier-badge tier-drawdown"; // drawdown grace (orange)
    case "HARD_STOP":
    default:
      return "tier-badge tier-hard-stop"; // initial stop (red)
  }
}

export function LivePositionsGrid({ positions }: LivePositionsGridProps) {
  if (positions.length === 0) {
    return (
      <section className="dashboard-section">
        <h2>Live Positions & Dynamic Ratchets</h2>
        <p className="empty-state">No open positions currently active.</p>
      </section>
    );
  }

  return (
    <section className="dashboard-section" aria-label="Live Positions Grid">
      <h2>Live Positions & Dynamic Ratchets</h2>
      <div className="positions-grid">
        {positions.map((pos) => {
          const isPositive = pos.currentPnlBps >= 0;
          const pnlPct = (pos.currentPnlBps / 100).toFixed(2);
          const peakGainPct = (pos.peakGainBps / 100).toFixed(2);
          const stopFloorPct = (pos.currentStopFloorBps / 100).toFixed(2);

          return (
            <div
              key={pos.positionId}
              className={`position-card ${pos.drawdownState === "EVALUATING_DRAWDOWN" ? "drawdown-evaluating" : ""}`}
              data-testid={`position-${pos.positionId}`}
            >
              <div className="position-header">
                <span className="position-mint" title={pos.mintAddress}>
                  {pos.symbol ?? `${pos.mintAddress.slice(0, 4)}...${pos.mintAddress.slice(-4)}`}
                </span>
                <span className={getTierBadgeClass(pos.activeTier)}>{pos.activeTier}</span>
              </div>

              <div className="position-metrics">
                <div className="metric-row">
                  <span className="metric-label">Unrealized PnL:</span>
                  <span className={`metric-value ${isPositive ? "pnl-positive" : "pnl-negative"}`}>
                    {isPositive ? `+${pnlPct}%` : `${pnlPct}%`}
                  </span>
                </div>

                <div className="metric-row">
                  <span className="metric-label">Peak Gain:</span>
                  <span className="metric-value">+{peakGainPct}%</span>
                </div>

                <div className="metric-row">
                  <span className="metric-label">Stop Floor:</span>
                  <span className="metric-value">{stopFloorPct}%</span>
                </div>

                <div className="metric-row">
                  <span className="metric-label">Entry / Spot:</span>
                  <span className="metric-value">
                    {pos.entryPriceSol.toFixed(6)} / {pos.spotPriceSol.toFixed(6)} SOL
                  </span>
                </div>

                {pos.drawdownState === "EVALUATING_DRAWDOWN" && (
                  <div className="drawdown-alert">
                    ⚠️ Smart Re-evaluation: Grace Period Active (-8% Dip)
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
