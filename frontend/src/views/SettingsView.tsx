import { useState } from "react";
import type { DashboardSettings, WalletTelemetry } from "@nexustrade/shared";

export interface SettingsViewProps {
  readonly initialSettings?: DashboardSettings;
  readonly walletTelemetry?: WalletTelemetry;
  readonly onRefreshWallet?: (walletAddress: string) => Promise<void>;
  readonly onSaveSettings?: (settings: DashboardSettings) => void;
}

const envMeta = import.meta as unknown as { env?: Record<string, string | undefined> };
const envWallet =
  typeof envMeta !== "undefined" && envMeta.env?.VITE_SOLANA_PUBLIC_KEY
    ? String(envMeta.env.VITE_SOLANA_PUBLIC_KEY)
    : "";

export const DEFAULT_SETTINGS: DashboardSettings = {
  maxConcurrentPositions: 3,
  positionSizeSol: 1.0,
  gasReserveSol: 0.05,
  goalMode: "PERCENT_GAIN",
  targetGoalValue: 10.0,
  walletAddress: envWallet,
  strategyThresholds: {
    minLmcRatio: 0.15,
    maxLmcRatio: 0.3,
    minBuyToSellRatio: 1.5,
    minVolume5mUsd: 2500,
    minMaturityAgeSec: 300,
    maxMaturityAgeSec: 900,
  },
};

export function SettingsView({
  initialSettings = DEFAULT_SETTINGS,
  walletTelemetry,
  onRefreshWallet,
  onSaveSettings,
}: SettingsViewProps) {
  const [settings, setSettings] = useState<DashboardSettings>(initialSettings);
  const [isRefreshingWallet, setIsRefreshingWallet] = useState(false);
  const [savedNotification, setSavedNotification] = useState(false);

  const totalSol = walletTelemetry?.solBalance ?? 0;
  const gasReserve = settings.gasReserveSol;
  const deployableSol = Math.max(0, totalSol - gasReserve);
  const maxCapacity =
    settings.positionSizeSol > 0 ? Math.floor(deployableSol / settings.positionSizeSol) : 0;

  const handleRefresh = async () => {
    if (!onRefreshWallet) return;
    setIsRefreshingWallet(true);
    try {
      await onRefreshWallet(settings.walletAddress);
    } finally {
      setIsRefreshingWallet(false);
    }
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (onSaveSettings) {
      onSaveSettings(settings);
    }
    setSavedNotification(true);
    setTimeout(() => setSavedNotification(false), 3000);
  };

  return (
    <div className="view-container" data-testid="settings-view">
      <div className="view-header">
        <h1>Trading Dashboard Settings & Control Plane</h1>
        <p className="subtitle">
          Configure capital sizing, wallet connection, target profit goals, and quantitative
          screening thresholds.
        </p>
      </div>

      <form onSubmit={handleSave} className="settings-form">
        {/* 1. Wallet Header Card */}
        <section className="dashboard-section">
          <h2>1. Wallet & Connectivity Audit</h2>
          <div className="form-group">
            <label htmlFor="walletAddress">Solana Wallet Address / Public Key</label>
            <div className="input-with-button">
              <input
                id="walletAddress"
                type="text"
                value={settings.walletAddress}
                onChange={(e) => setSettings({ ...settings, walletAddress: e.target.value })}
                placeholder="Enter Solana Base58 public key..."
                className="text-input"
              />
              <button
                type="button"
                onClick={handleRefresh}
                disabled={isRefreshingWallet || !settings.walletAddress.trim()}
                className="btn btn-secondary"
              >
                {isRefreshingWallet ? "Querying RPC..." : "Refresh Wallet Info"}
              </button>
            </div>
            {envWallet ? (
              <small style={{ color: "#10b981", marginTop: "4px", display: "block" }}>
                ✓ Pre-populated from .env (VITE_SOLANA_PUBLIC_KEY)
              </small>
            ) : null}
          </div>

          <div className="wallet-stats-grid">
            <div className="stat-card">
              <span className="stat-label">Total SOL Balance</span>
              <span className="stat-value">{totalSol.toFixed(4)} SOL</span>
            </div>

            <div className="stat-card highlight">
              <span className="stat-label">Deployable SOL</span>
              <span className="stat-value">{deployableSol.toFixed(4)} SOL</span>
              <span className="stat-sub">
                (Max Capacity: <strong>{maxCapacity}</strong> positions @ {settings.positionSizeSol}{" "}
                SOL)
              </span>
            </div>

            <div className="stat-card">
              <span className="stat-label">Signature Readiness</span>
              <span
                className={`badge ${
                  walletTelemetry?.signatureReady ? "badge-success" : "badge-neutral"
                }`}
              >
                {walletTelemetry?.signatureReady
                  ? "CONNECTED / READY"
                  : "READ-ONLY / NOT CONNECTED"}
              </span>
            </div>
          </div>

          {walletTelemetry && walletTelemetry.tokens.length > 0 && (
            <div className="token-holdings-list">
              <h3>SPL Token Holdings ({walletTelemetry.tokens.length})</h3>
              <ul className="tokens-ul">
                {walletTelemetry.tokens.map((token) => (
                  <li key={token.mint} className="token-li">
                    <span className="token-symbol">{token.symbol}</span>
                    <span className="token-amount">
                      {token.amount.toLocaleString(undefined, {
                        maximumFractionDigits: 4,
                      })}
                    </span>
                    <span className="token-mint" title={token.mint}>
                      {token.mint.slice(0, 4)}...{token.mint.slice(-4)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* 2. Position Sizing & Concurrency */}
        <section className="dashboard-section">
          <h2>2. Capital Allocation & Concurrency Guardrails</h2>
          <div className="form-grid">
            <div className="form-group">
              <label htmlFor="maxConcurrentPositions">
                Max Concurrent Positions: <strong>{settings.maxConcurrentPositions}</strong>
              </label>
              <input
                id="maxConcurrentPositions"
                type="range"
                min={1}
                max={10}
                value={settings.maxConcurrentPositions}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    maxConcurrentPositions: parseInt(e.target.value, 10),
                  })
                }
                className="slider"
              />
              <span className="hint">Bounded between 1 and 10 active positions.</span>
            </div>

            <div className="form-group">
              <label htmlFor="positionSizeSol">Position Size (SOL per Trade)</label>
              <input
                id="positionSizeSol"
                type="number"
                step="0.1"
                min="0.1"
                max="100"
                value={settings.positionSizeSol}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    positionSizeSol: parseFloat(e.target.value) || 0.1,
                  })
                }
                className="text-input"
              />
            </div>

            <div className="form-group">
              <label htmlFor="gasReserveSol">Gas Fee Reserve (SOL Buffer)</label>
              <input
                id="gasReserveSol"
                type="number"
                step="0.01"
                min="0"
                max="10"
                value={settings.gasReserveSol}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    gasReserveSol: parseFloat(e.target.value) || 0,
                  })
                }
                className="text-input"
              />
              <span className="hint">Reserved for Solana base & priority transaction fees.</span>
            </div>
          </div>
        </section>

        {/* 3. Target Goal Setting with Mode Toggle */}
        <section className="dashboard-section">
          <h2>3. Session Profit Target Goal</h2>
          <div className="goal-mode-toggle">
            <button
              type="button"
              className={`toggle-btn ${settings.goalMode === "PERCENT_GAIN" ? "active" : ""}`}
              onClick={() => setSettings({ ...settings, goalMode: "PERCENT_GAIN" })}
            >
              % Portfolio Gain Goal
            </button>
            <button
              type="button"
              className={`toggle-btn ${settings.goalMode === "FINAL_SOL_BALANCE" ? "active" : ""}`}
              onClick={() => setSettings({ ...settings, goalMode: "FINAL_SOL_BALANCE" })}
            >
              Final Wallet SOL Target
            </button>
          </div>

          <div className="form-group">
            <label htmlFor="targetGoalValue">
              {settings.goalMode === "PERCENT_GAIN"
                ? "Target Portfolio Return (%)"
                : "Target Final Wallet Balance (SOL)"}
            </label>
            <input
              id="targetGoalValue"
              type="number"
              step={settings.goalMode === "PERCENT_GAIN" ? "1.0" : "0.5"}
              min="0.1"
              value={settings.targetGoalValue}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  targetGoalValue: parseFloat(e.target.value) || 1.0,
                })
              }
              className="text-input"
            />
            <div className="info-banner">
              ℹ️ <strong>Auto-Wind-Down Trigger</strong>: When this target is satisfied, the system
              automatically transitions the session into <strong>`START EXITING`</strong> mode
              (freezing new buys and allowing open positions to ride to natural profit locks).
            </div>
          </div>
        </section>

        {/* 4. Strategy & Screening Thresholds */}
        <section className="dashboard-section">
          <h2>4. Quantitative Screening Thresholds (Stage 1 & Stage 2)</h2>
          <div className="form-grid">
            <div className="form-group">
              <label htmlFor="minLmcRatio">
                Min L/MC Ratio:{" "}
                <strong>{(settings.strategyThresholds.minLmcRatio * 100).toFixed(0)}%</strong>
              </label>
              <input
                id="minLmcRatio"
                type="range"
                min="0.05"
                max="0.40"
                step="0.01"
                value={settings.strategyThresholds.minLmcRatio}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    strategyThresholds: {
                      ...settings.strategyThresholds,
                      minLmcRatio: parseFloat(e.target.value),
                    },
                  })
                }
                className="slider"
              />
            </div>

            <div className="form-group">
              <label htmlFor="maxLmcRatio">
                Max L/MC Ratio:{" "}
                <strong>{(settings.strategyThresholds.maxLmcRatio * 100).toFixed(0)}%</strong>
              </label>
              <input
                id="maxLmcRatio"
                type="range"
                min="0.15"
                max="0.60"
                step="0.01"
                value={settings.strategyThresholds.maxLmcRatio}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    strategyThresholds: {
                      ...settings.strategyThresholds,
                      maxLmcRatio: parseFloat(e.target.value),
                    },
                  })
                }
                className="slider"
              />
            </div>

            <div className="form-group">
              <label htmlFor="minBuyToSellRatio">
                Min Buy / Sell Volume Ratio:{" "}
                <strong>{settings.strategyThresholds.minBuyToSellRatio}x</strong>
              </label>
              <input
                id="minBuyToSellRatio"
                type="range"
                min="1.0"
                max="3.0"
                step="0.1"
                value={settings.strategyThresholds.minBuyToSellRatio}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    strategyThresholds: {
                      ...settings.strategyThresholds,
                      minBuyToSellRatio: parseFloat(e.target.value),
                    },
                  })
                }
                className="slider"
              />
            </div>

            <div className="form-group">
              <label htmlFor="minVolume5mUsd">Min 5-Minute Volume ($ USD)</label>
              <input
                id="minVolume5mUsd"
                type="number"
                step="250"
                min="500"
                value={settings.strategyThresholds.minVolume5mUsd}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    strategyThresholds: {
                      ...settings.strategyThresholds,
                      minVolume5mUsd: parseFloat(e.target.value) || 500,
                    },
                  })
                }
                className="text-input"
              />
            </div>
          </div>
        </section>

        {/* Action Controls */}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary">
            Save & Apply Settings
          </button>
          {savedNotification && (
            <span className="save-success" aria-live="polite">
              ✓ Settings saved successfully!
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
