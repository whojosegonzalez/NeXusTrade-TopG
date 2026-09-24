import type { ProviderHttpClient } from "../http/ProviderHttpClient.js";
import type {
  RaydiumPreflightPoolType,
  RaydiumPreflightSortField,
  RaydiumPreflightSortType,
} from "../config/providerConfig.js";
import { mapRaydiumPoolsByMintResponse } from "./raydium.pool.mappers.js";
import { raydiumPoolsByMintResponseSchema } from "./raydium.pool.schemas.js";
import {
  classifyRaydiumFailureDetail,
  sanitizeRaydiumMessage,
  type RaydiumQuoteFailureDetail,
} from "./RaydiumErrorClassifier.js";
import type { RaydiumPreflightCache } from "./RaydiumPreflightCache.js";

export type RaydiumPreflightStatus = "DISABLED" | "FOUND" | "NO_POOL" | "FAILED";

export interface RaydiumPreflightResult {
  readonly status: RaydiumPreflightStatus;
  readonly poolsFound: number;
  readonly productTypes: readonly string[];
  readonly cacheStatus: "BYPASS" | "HIT" | "MISS";
  readonly poolType?: RaydiumPreflightPoolType;
  readonly sortField?: RaydiumPreflightSortField;
  readonly sortType?: RaydiumPreflightSortType;
  readonly pageSize?: number;
  readonly page?: number;
  readonly failureDetail?: RaydiumQuoteFailureDetail;
  readonly message?: string;
}

export interface RaydiumPoolPreflightServiceOptions {
  readonly enabled: boolean;
  readonly httpClient: ProviderHttpClient;
  readonly cache: RaydiumPreflightCache;
  readonly allowRawPayloadLogging: boolean;
  readonly poolType: RaydiumPreflightPoolType;
  readonly sortField: RaydiumPreflightSortField;
  readonly sortType: RaydiumPreflightSortType;
  readonly pageSize: number;
  readonly page: number;
  readonly maxErrorMessageLength: number;
}

export interface RaydiumPoolPreflightRequest {
  readonly inputMint: string;
  readonly outputMint: string;
}

export class RaydiumPoolPreflightService {
  constructor(private readonly options: RaydiumPoolPreflightServiceOptions) {}

  async check(request: RaydiumPoolPreflightRequest): Promise<RaydiumPreflightResult> {
    if (!this.options.enabled) {
      return {
        status: "DISABLED",
        poolsFound: 0,
        productTypes: [],
        cacheStatus: "BYPASS",
        ...this.requestContract(),
      };
    }

    const cached = this.options.cache.get(request.inputMint, request.outputMint);

    if (cached) {
      return {
        status: cached.status,
        poolsFound: cached.poolsFound,
        productTypes: cached.productTypes,
        cacheStatus: "HIT",
        ...this.requestContract(),
        ...(cached.message ? { message: cached.message } : {}),
      };
    }

    const result = await this.options.httpClient.getJson<unknown>({
      path: "pools/info/mint",
      query: {
        mint1: request.inputMint,
        mint2: request.outputMint,
        poolType: this.options.poolType,
        poolSortField: this.options.sortField,
        sortType: this.options.sortType,
        pageSize: this.options.pageSize,
        page: this.options.page,
      },
      operation: "preflight",
      endpointId: "RAYDIUM_POOL_PREFLIGHT",
      allowRawPayloadLogging: this.options.allowRawPayloadLogging,
    });

    if (!result.ok) {
      const failureDetail = classifyRaydiumFailureDetail({
        providerErrorCode: result.error.code,
        message: result.error.message,
        ...(result.error.statusCode !== undefined ? { statusCode: result.error.statusCode } : {}),
      });
      const entry = this.options.cache.set({
        inputMint: request.inputMint,
        outputMint: request.outputMint,
        status: "FAILED",
        poolsFound: 0,
        productTypes: [],
        message: sanitizeRaydiumMessage(result.error.message, this.options.maxErrorMessageLength),
      });

      return {
        status: entry.status,
        poolsFound: entry.poolsFound,
        productTypes: entry.productTypes,
        cacheStatus: "MISS",
        ...this.requestContract(),
        failureDetail,
        ...(entry.message ? { message: entry.message } : {}),
      };
    }

    const parsed = raydiumPoolsByMintResponseSchema.safeParse(result.data);

    if (!parsed.success) {
      const entry = this.options.cache.set({
        inputMint: request.inputMint,
        outputMint: request.outputMint,
        status: "FAILED",
        poolsFound: 0,
        productTypes: [],
        message: "Raydium pool preflight response schema was invalid.",
      });

      return {
        status: entry.status,
        poolsFound: entry.poolsFound,
        productTypes: entry.productTypes,
        cacheStatus: "MISS",
        ...this.requestContract(),
        failureDetail: "SCHEMA_INVALID",
        ...(entry.message ? { message: entry.message } : {}),
      };
    }

    if (parsed.data.success === false) {
      const message = parsed.data.msg ?? "Raydium pool preflight was not successful.";
      const failureDetail = classifyRaydiumFailureDetail({
        providerErrorCode: "BAD_REQUEST",
        message,
      });
      const entry = this.options.cache.set({
        inputMint: request.inputMint,
        outputMint: request.outputMint,
        status: "FAILED",
        poolsFound: 0,
        productTypes: [],
        message: sanitizeRaydiumMessage(message, this.options.maxErrorMessageLength),
      });

      return {
        status: entry.status,
        poolsFound: entry.poolsFound,
        productTypes: entry.productTypes,
        cacheStatus: "MISS",
        ...this.requestContract(),
        failureDetail,
        ...(entry.message ? { message: entry.message } : {}),
      };
    }

    const summary = mapRaydiumPoolsByMintResponse(parsed.data);
    const entry = this.options.cache.set({
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      status: summary.poolsFound > 0 ? "FOUND" : "NO_POOL",
      poolsFound: summary.poolsFound,
      productTypes: summary.productTypes,
    });

    return {
      status: entry.status,
      poolsFound: entry.poolsFound,
      productTypes: entry.productTypes,
      cacheStatus: "MISS",
      ...this.requestContract(),
    };
  }

  private requestContract(): {
    readonly poolType: RaydiumPreflightPoolType;
    readonly sortField: RaydiumPreflightSortField;
    readonly sortType: RaydiumPreflightSortType;
    readonly pageSize: number;
    readonly page: number;
  } {
    return {
      poolType: this.options.poolType,
      sortField: this.options.sortField,
      sortType: this.options.sortType,
      pageSize: this.options.pageSize,
      page: this.options.page,
    };
  }
}
