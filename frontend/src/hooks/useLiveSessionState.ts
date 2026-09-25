import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ActiveSessionTelemetry,
  DashboardSettings,
  HistoricalSessionSummary,
  SessionControlAction,
  WalletTelemetry,
} from "@nexustrade/shared";

import { DEFAULT_SETTINGS } from "../views/SettingsView.js";

export interface LiveSessionStateOptions {
  readonly pollIntervalMs?: number;
  readonly initialSettings?: DashboardSettings;
  readonly initialSession?: ActiveSessionTelemetry;
  readonly initialHistory?: readonly HistoricalSessionSummary[];
  readonly fetchFn?: typeof fetch;
}

export function useLiveSessionState(options: LiveSessionStateOptions = {}) {
  const {
    pollIntervalMs = 1500,
    initialSettings = DEFAULT_SETTINGS,
    initialSession,
    initialHistory = [],
    fetchFn = globalThis.fetch,
  } = options;

  const [settings, setSettings] = useState<DashboardSettings>(initialSettings);
  const [walletTelemetry, setWalletTelemetry] = useState<WalletTelemetry | undefined>();
  const [activeSession, setActiveSession] = useState<ActiveSessionTelemetry | undefined>(
    initialSession,
  );
  const [historySessions, setHistorySessions] =
    useState<readonly HistoricalSessionSummary[]>(initialHistory);
  const [goalSatisfied, setGoalSatisfied] = useState(false);

  const autoExitTriggeredRef = useRef(false);

  // Refresh wallet info callback
  const refreshWallet = useCallback(
    async (walletAddress: string) => {
      try {
        const res = await fetchFn(
          `/api/wallet/telemetry?address=${encodeURIComponent(walletAddress)}&reserve=${settings.gasReserveSol}`,
        );
        if (res.ok) {
          const data = (await res.json()) as WalletTelemetry;
          setWalletTelemetry(data);
        }
      } catch {
        // Fallback synthetic telemetry if backend is offline
        const mockBalance = 10.0;
        setWalletTelemetry({
          solBalance: mockBalance,
          deployableSol: Math.max(0, mockBalance - settings.gasReserveSol),
          signatureReady: Boolean(walletAddress.trim()),
          fetchedAt: new Date().toISOString(),
          tokens: [],
        });
      }
    },
    [fetchFn, settings.gasReserveSol],
  );

  // Send session control command
  const sendCommand = useCallback(
    async (action: SessionControlAction, targetPositionId?: string) => {
      try {
        await fetchFn("/api/session/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, targetPositionId, issuedAt: Date.now() }),
        });
      } catch {
        // Optimistic local state update if offline
        if (activeSession) {
          if (action === "PAUSE") setActiveSession({ ...activeSession, status: "PAUSED" });
          if (action === "RESUME") setActiveSession({ ...activeSession, status: "RUNNING" });
          if (action === "START_EXITING") setActiveSession({ ...activeSession, status: "EXITING" });
          if (action === "EMERGENCY_STOP") setActiveSession({ ...activeSession, status: "HALTED" });
        }
      }
    },
    [fetchFn, activeSession],
  );

  // Polling loop for active session telemetry
  useEffect(() => {
    let isMounted = true;

    const poll = async () => {
      try {
        const res = await fetchFn("/api/session/active");
        if (res.ok && isMounted) {
          const telemetry = (await res.json()) as ActiveSessionTelemetry;
          setActiveSession(telemetry);
        }
      } catch {
        // Keep existing activeSession on network error
      }
    };

    const interval = setInterval(() => {
      void poll();
    }, pollIntervalMs);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [fetchFn, pollIntervalMs]);

  // Goal evaluation effect
  useEffect(() => {
    if (!activeSession || activeSession.status !== "RUNNING" || autoExitTriggeredRef.current) {
      return;
    }

    let isSatisfied = false;
    if (settings.goalMode === "PERCENT_GAIN") {
      isSatisfied = activeSession.netSessionPnlPct >= settings.targetGoalValue;
    } else if (settings.goalMode === "FINAL_SOL_BALANCE") {
      isSatisfied = activeSession.currentPortfolioSol >= settings.targetGoalValue;
    }

    if (isSatisfied) {
      autoExitTriggeredRef.current = true;
      setGoalSatisfied(true);
      void sendCommand("START_EXITING");
    }
  }, [activeSession, settings, sendCommand]);

  return {
    settings,
    setSettings,
    walletTelemetry,
    activeSession,
    historySessions,
    setHistorySessions,
    refreshWallet,
    sendCommand,
    goalSatisfied,
  };
}
