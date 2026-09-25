import type { ClosedTrade } from "@nexustrade/shared";

interface TradeHistoryTableProps {
  readonly trades: readonly ClosedTrade[];
}

export function TradeHistoryTable({ trades }: TradeHistoryTableProps) {
  if (trades.length === 0) {
    return (
      <section className="dashboard-section">
        <h2>Trade History</h2>
        <p className="empty-state">No closed trades recorded in this session yet.</p>
      </section>
    );
  }

  return (
    <section className="dashboard-section" aria-label="Trade History Table">
      <h2>Trade History</h2>
      <div className="table-responsive">
        <table className="trades-table">
          <thead>
            <tr>
              <th>Mint</th>
              <th>Entry Price</th>
              <th>Exit Price</th>
              <th>Realized PnL (SOL)</th>
              <th>Realized PnL (%)</th>
              <th>Exit Trigger / Reason</th>
              <th>Closed At</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade) => {
              const isWin = trade.realizedPnlBps > 0;
              const isScratch = trade.realizedPnlBps >= 0 && trade.realizedPnlBps <= 150;
              const pnlPct = (trade.realizedPnlBps / 100).toFixed(2);

              return (
                <tr
                  key={trade.positionId}
                  className={isWin ? "row-win" : isScratch ? "row-scratch" : "row-loss"}
                  data-testid={`trade-${trade.positionId}`}
                >
                  <td title={trade.mintAddress}>
                    {trade.mintAddress.slice(0, 4)}...{trade.mintAddress.slice(-4)}
                  </td>
                  <td>{trade.entryPriceSol.toFixed(6)} SOL</td>
                  <td>{trade.exitPriceSol.toFixed(6)} SOL</td>
                  <td className={isWin ? "pnl-positive" : "pnl-negative"}>
                    {trade.realizedPnlSol > 0
                      ? `+${trade.realizedPnlSol.toFixed(4)}`
                      : trade.realizedPnlSol.toFixed(4)}{" "}
                    SOL
                  </td>
                  <td className={isWin ? "pnl-positive" : "pnl-negative"}>
                    {trade.realizedPnlBps > 0 ? `+${pnlPct}%` : `${pnlPct}%`}
                  </td>
                  <td>
                    <span className="exit-reason-badge">{trade.exitReason}</span>
                  </td>
                  <td>{new Date(trade.closedAtMs).toLocaleTimeString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
