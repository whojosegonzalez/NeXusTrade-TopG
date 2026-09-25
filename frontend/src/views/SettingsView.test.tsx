import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DashboardSettings, WalletTelemetry } from "@nexustrade/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, SettingsView } from "./SettingsView.js";

describe("SettingsView", () => {
  afterEach(() => {
    cleanup();
  });
  const mockWalletTelemetry: WalletTelemetry = {
    solBalance: 10.5,
    deployableSol: 10.45,
    signatureReady: true,
    fetchedAt: "2026-09-24T20:00:00.000Z",
    tokens: [
      {
        mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
        symbol: "BONK",
        amount: 5000000,
        decimals: 5,
      },
    ],
  };

  it("renders default settings and calculates deployable SOL", () => {
    render(
      <SettingsView initialSettings={DEFAULT_SETTINGS} walletTelemetry={mockWalletTelemetry} />,
    );

    expect(screen.getByTestId("settings-view")).toBeDefined();
    expect(screen.getByText("10.5000 SOL")).toBeDefined();
    expect(screen.getByText("10.4500 SOL")).toBeDefined();
    expect(screen.getByText("CONNECTED / READY")).toBeDefined();
    expect(screen.getByText("BONK")).toBeDefined();
  });

  it("triggers wallet refresh callback when button clicked", async () => {
    const onRefreshWallet = vi.fn().mockResolvedValue(undefined);
    render(
      <SettingsView
        initialSettings={{
          ...DEFAULT_SETTINGS,
          walletAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        }}
        onRefreshWallet={onRefreshWallet}
      />,
    );

    const refreshBtn = screen.getByText("Refresh Wallet Info");
    fireEvent.click(refreshBtn);

    expect(onRefreshWallet).toHaveBeenCalledWith("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
  });

  it("allows changing concurrency slider and position size", () => {
    render(<SettingsView initialSettings={DEFAULT_SETTINGS} />);

    const concurrencySlider = screen.getByLabelText(/Max Concurrent Positions/);
    fireEvent.change(concurrencySlider, { target: { value: "5" } });

    expect(screen.getByText(/Max Concurrent Positions:/)).toBeDefined();

    const positionSizeInput = screen.getByLabelText(/Position Size/);
    fireEvent.change(positionSizeInput, { target: { value: "2.5" } });
  });

  it("toggles goal mode between % gain and final SOL target", () => {
    render(<SettingsView initialSettings={DEFAULT_SETTINGS} />);

    const finalSolBtn = screen.getByText("Final Wallet SOL Target");
    fireEvent.click(finalSolBtn);

    expect(screen.getByText("Target Final Wallet Balance (SOL)")).toBeDefined();

    const percentGainBtn = screen.getByText("% Portfolio Gain Goal");
    fireEvent.click(percentGainBtn);

    expect(screen.getByText("Target Portfolio Return (%)")).toBeDefined();
  });

  it("submits form and calls onSaveSettings callback", () => {
    const onSaveSettings = vi.fn();
    render(<SettingsView initialSettings={DEFAULT_SETTINGS} onSaveSettings={onSaveSettings} />);

    const submitBtn = screen.getByText("Save & Apply Settings");
    fireEvent.submit(submitBtn.closest("form")!);

    expect(onSaveSettings).toHaveBeenCalledWith(
      expect.objectContaining<Partial<DashboardSettings>>({
        maxConcurrentPositions: 3,
        positionSizeSol: 1.0,
      }),
    );
    expect(screen.getByText("✓ Settings saved successfully!")).toBeDefined();
  });
});
