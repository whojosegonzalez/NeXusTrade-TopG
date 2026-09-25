import type { WalletTelemetry, WalletTokenHolding } from "@nexustrade/shared";

export interface WalletRpcClient {
  getBalance(pubkey: string): Promise<number>;
  getTokenAccounts(pubkey: string): Promise<readonly WalletTokenHolding[]>;
}

export interface WalletTelemetryServiceOptions {
  readonly rpcEndpoint?: string;
  readonly rpcClient?: WalletRpcClient;
  readonly fetchFn?: typeof fetch;
}

const DEFAULT_SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export class WalletTelemetryService {
  private readonly rpcEndpoint: string;
  private readonly rpcClient?: WalletRpcClient | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(options: WalletTelemetryServiceOptions = {}) {
    this.rpcEndpoint = options.rpcEndpoint ?? DEFAULT_SOLANA_RPC;
    this.rpcClient = options.rpcClient;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async getTelemetry(walletAddress: string, gasReserveSol = 0.05): Promise<WalletTelemetry> {
    const trimmedAddress = walletAddress.trim();
    const fetchedAt = new Date().toISOString();

    if (!trimmedAddress) {
      return {
        solBalance: 0,
        deployableSol: 0,
        tokens: [],
        signatureReady: false,
        fetchedAt,
      };
    }

    // 1. If custom / mock rpcClient is injected (e.g. for synthetic tests)
    if (this.rpcClient) {
      const solBalance = await this.rpcClient.getBalance(trimmedAddress);
      const tokens = await this.rpcClient.getTokenAccounts(trimmedAddress);
      const deployableSol = Math.max(0, solBalance - gasReserveSol);

      return {
        solBalance,
        deployableSol,
        tokens: [...tokens],
        signatureReady: true,
        fetchedAt,
      };
    }

    // 2. Query Live Solana RPC via JSON-RPC POST
    try {
      const balancePromise = this.fetchRpc<number>("getBalance", [
        trimmedAddress,
        { commitment: "confirmed" },
      ]).then((res) => (typeof res.value === "number" ? res.value / 1e9 : 0));

      const tokenAccountsPromise = this.fetchRpc<{
        value: readonly {
          account: {
            data: {
              parsed: {
                info: {
                  mint: string;
                  tokenAmount: { uiAmount: number; decimals: number };
                };
              };
            };
          };
        }[];
      }>("getTokenAccountsByOwner", [
        trimmedAddress,
        { programId: TOKEN_PROGRAM_ID },
        { encoding: "jsonParsed", commitment: "confirmed" },
      ]).then((res) => {
        if (!res.value || !Array.isArray(res.value)) return [];
        return res.value.map((item) => {
          const info = item.account.data.parsed.info;
          return {
            mint: info.mint,
            symbol: `${info.mint.slice(0, 4)}...${info.mint.slice(-4)}`,
            amount: info.tokenAmount.uiAmount ?? 0,
            decimals: info.tokenAmount.decimals,
          };
        });
      });

      const [solBalance, tokens] = await Promise.all([balancePromise, tokenAccountsPromise]);
      const deployableSol = Math.max(0, solBalance - gasReserveSol);

      return {
        solBalance,
        deployableSol,
        tokens,
        signatureReady: true,
        fetchedAt,
      };
    } catch {
      // Fail closed gracefully on network/RPC errors without crashing the UI
      return {
        solBalance: 0,
        deployableSol: 0,
        tokens: [],
        signatureReady: false,
        fetchedAt,
      };
    }
  }

  private async fetchRpc<T>(method: string, params: unknown[]): Promise<{ value?: unknown } & T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await this.fetchFn(this.rpcEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `wallet-query-${Date.now()}`,
          method,
          params,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`RPC HTTP Error: ${response.status}`);
      }

      const json = (await response.json()) as { result?: T; error?: { message: string } };
      if (json.error) {
        throw new Error(`RPC Error: ${json.error.message}`);
      }

      return (json.result ?? {}) as { value?: unknown } & T;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
