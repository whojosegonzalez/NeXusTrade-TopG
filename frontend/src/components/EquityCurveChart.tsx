import type { ClosedTrade } from "@nexustrade/shared";

interface EquityCurveChartProps {
  readonly initialPortfolioSol: number;
  readonly currentPortfolioSol: number;
  readonly totalRealizedPnlSol: number;
  readonly totalUnrealizedPnlSol: number;
  readonly trades: readonly ClosedTrade[];
}

export function EquityCurveChart({
  initialPortfolioSol,
  currentPortfolioSol,
  totalRealizedPnlSol,
  totalUnrealizedPnlSol,
  trades,
}: EquityCurveChartProps) {
  const totalClosed = trades.length;
  const wins = trades.filter((t) => t.realizedPnlBps > 150).length;
  const scratches = trades.filter((t) => t.realizedPnlBps >= 0 && t.realizedPnlBps <= 150).length;
  const losses = trades.filter((t) => t.realizedPnlBps < 0).length;

  const winRate = totalClosed > 0 ? ((wins / totalClosed) * 100).toFixed(1) : "0.0";
  const scratchRate = totalClosed > 0 ? ((scratches / totalClosed) * 100).toFixed(1) : "0.0";
  const lossRate = totalClosed > 0 ? ((losses / totalClosed) * 100).toFixed(1) : "0.0";

  const totalPnlSol = currentPortfolioSol - initialPortfolioSol;
  const totalPnlPct =
    initialPortfolioSol > 0 ? ((totalPnlSol / initialPortfolioSol) * 100).toFixed(2) : "0.00";
  const isPositive = totalPnlSol >= 0;

  return (
    <section className="dashboard-section" aria-label="Session Performance & Equity">
      <h2>Session Performance & Portfolio Equity</h2>
      <div className="metrics-summary-grid">
        <div className="metric-box">
          <span className="metric-label">Portfolio Equity</span>
          <span className="metric-headline">{currentPortfolioSol.toFixed(4)} SOL</span>
          <span className={`metric-sub ${isPositive ? "pnl-positive" : "pnl-negative"}`}>
            {isPositive ? `+${totalPnlPct}%` : `${totalPnlPct}%`} (
            {isPositive ? `+${totalPnlSol.toFixed(4)}` : totalPnlSol.toFixed(4)} SOL)
          </span>
        </div>

        <div className="metric-box">
          <span className="metric-label">Realized / Unrealized</span>
          <span className="metric-headline">
            {totalRealizedPnlSol >= 0
              ? `+${totalRealizedPnlSol.toFixed(4)}`
              : totalRealizedPnlSol.toFixed(4)}{" "}
            SOL
          </span>
          <span className="metric-sub">
            Unrealized:{" "}
            {totalUnrealizedPnlSol >= 0
              ? `+${totalUnrealizedPnlSol.toFixed(4)}`
              : totalUnrealizedPnlSol.toFixed(4)}{" "}
            SOL
          </span>
        </div>

        <div className="metric-box">
          <span className="metric-label">Win / Scratch / Loss</span>
          <span className="metric-headline">
            {winRate}% / {scratchRate}% / {lossRate}%
          </span>
          <span className="metric-sub">
            {wins} Wins, {scratches} Scratches, {losses} Losses ({totalClosed} Total)
          </span>
        </div>
      </div>
    </section>
  );
}
