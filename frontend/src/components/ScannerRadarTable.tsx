import type { ScannerRadarItem } from "@nexustrade/shared";

interface ScannerRadarTableProps {
  readonly candidates: readonly ScannerRadarItem[];
}

export function ScannerRadarTable({ candidates }: ScannerRadarTableProps) {
  if (candidates.length === 0) {
    return (
      <section className="dashboard-section">
        <h2>Real-Time Scanner Radar Feed</h2>
        <p className="empty-state">No screened tokens in the radar feed yet.</p>
      </section>
    );
  }

  return (
    <section className="dashboard-section" aria-label="Scanner Radar Feed">
      <h2>Real-Time Scanner Radar Feed</h2>
      <div className="table-responsive">
        <table className="scanner-table">
          <thead>
            <tr>
              <th>Token</th>
              <th>Liquidity</th>
              <th>Market Cap</th>
              <th>L/MC Depth</th>
              <th>LP Burn</th>
              <th>Age</th>
              <th>Status</th>
              <th>Rejection Reason</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((item) => (
              <tr
                key={item.poolId}
                className={item.admitted ? "row-admitted" : "row-rejected"}
                data-testid={`radar-${item.poolId}`}
              >
                <td>
                  <strong title={item.mintAddress}>{item.symbol}</strong>
                </td>
                <td>
                  ${item.liquidityUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </td>
                <td>
                  ${item.marketCapUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </td>
                <td>{(item.lmcRatio * 100).toFixed(1)}%</td>
                <td>{item.lpBurnPct.toFixed(1)}%</td>
                <td>
                  {Math.floor(item.assetAgeSeconds / 60)}m {item.assetAgeSeconds % 60}s
                </td>
                <td>
                  <span className={`status-pill ${item.admitted ? "pill-pass" : "pill-fail"}`}>
                    {item.admitted ? "ADMITTED" : "REJECTED"}
                  </span>
                </td>
                <td className="rejection-col">{item.rejectionReason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
