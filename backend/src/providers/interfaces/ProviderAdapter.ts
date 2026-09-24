import type { ProviderCapability, ProviderName } from "@nexustrade/shared";

export interface ProviderAdapter {
  readonly name: ProviderName;
  readonly capabilities: readonly ProviderCapability[];
}
