import { describe, expect, it } from "vitest";
import { WalletTelemetryService, type WalletRpcClient } from "./WalletTelemetryService.js";

describe("WalletTelemetryService", () => {
  it("returns zero balance and unready signature when wallet address is empty", async () => {
    const service = new WalletTelemetryService();
    const telemetry = await service.getTelemetry("");

    expect(telemetry.solBalance).toBe(0);
    expect(telemetry.deployableSol).toBe(0);
    expect(telemetry.tokens).toEqual([]);
    expect(telemetry.signatureReady).toBe(false);
  });

  it("queries mock RPC client and calculates deployable SOL with gas reserve", async () => {
    const mockRpcClient: WalletRpcClient = {
      getBalance: async () => 10.5,
      getTokenAccounts: async () => [
        {
          mint: "Token11111111111111111111111111111111111111",
          symbol: "TKN1",
          amount: 5000,
          decimals: 6,
        },
      ],
    };

    const service = new WalletTelemetryService({ rpcClient: mockRpcClient });
    const telemetry = await service.getTelemetry("MyWalletAddress11111111111111111111111111", 0.05);

    expect(telemetry.solBalance).toBe(10.5);
    expect(telemetry.deployableSol).toBeCloseTo(10.45, 4);
    expect(telemetry.tokens.length).toBe(1);
    expect(telemetry.tokens[0]?.symbol).toBe("TKN1");
    expect(telemetry.signatureReady).toBe(true);
  });

  it("fails closed on network exception and returns safe fallback telemetry", async () => {
    const failingFetch: typeof fetch = async () => {
      throw new Error("RPC Network Timeout");
    };

    const service = new WalletTelemetryService({ fetchFn: failingFetch });
    const telemetry = await service.getTelemetry("AnyValidAddress11111111111111111111111111");

    expect(telemetry.solBalance).toBe(0);
    expect(telemetry.deployableSol).toBe(0);
    expect(telemetry.signatureReady).toBe(false);
  });
});
