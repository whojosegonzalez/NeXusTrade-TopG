import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScannerRadarTable } from "./ScannerRadarTable.js";
import type { ScannerRadarItem } from "@nexustrade/shared";

describe("ScannerRadarTable", () => {
  it("renders empty state when radar feed has no items", () => {
    render(<ScannerRadarTable candidates={[]} />);
    expect(screen.getByText(/No screened tokens in the radar feed yet/i)).toBeInTheDocument();
  });

  it("renders admitted and rejected candidates with metrics and diagnostics", () => {
    const mockCandidates: ScannerRadarItem[] = [
      {
        poolId: "pool-1",
        mintAddress: "Mint111111111111111111111111111111111111",
        symbol: "PASS_TOKEN",
        liquidityUsd: 25_000,
        marketCapUsd: 100_000,
        lmcRatio: 0.25,
        lpBurnPct: 98.0,
        assetAgeSeconds: 450,
        admitted: true,
        discoveredAt: "2026-09-24T20:00:00Z",
      },
      {
        poolId: "pool-2",
        mintAddress: "Mint222222222222222222222222222222222222",
        symbol: "FAIL_TOKEN",
        liquidityUsd: 10_000,
        marketCapUsd: 100_000,
        lmcRatio: 0.1,
        lpBurnPct: 50.0,
        assetAgeSeconds: 200,
        admitted: false,
        rejectionReason: "REJECTED_IMBALANCED_LIQUIDITY_DEPTH",
        discoveredAt: "2026-09-24T20:00:00Z",
      },
    ];

    render(<ScannerRadarTable candidates={mockCandidates} />);

    expect(screen.getByText("PASS_TOKEN")).toBeInTheDocument();
    expect(screen.getByText("ADMITTED")).toBeInTheDocument();
    expect(screen.getByText("25.0%")).toBeInTheDocument();

    expect(screen.getByText("FAIL_TOKEN")).toBeInTheDocument();
    expect(screen.getByText("REJECTED")).toBeInTheDocument();
    expect(screen.getByText("REJECTED_IMBALANCED_LIQUIDITY_DEPTH")).toBeInTheDocument();
  });
});
