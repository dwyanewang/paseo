import type { PaseoApi } from "@getpaseo/client";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import type { PluginSettingsDocument, SettingsDefinition } from "../settings.js";
import type { PluginRpcContract } from "../rpc.js";
import type { PluginCleanup } from "../contracts.js";
import type { ProviderRegistration } from "./provider.js";
import type { PluginLifecycleRegistration } from "./lifecycle.js";
import type { PluginForgeServerProviderContribution } from "../forge.js";

export interface PluginHandlerContext {
  paseo: PaseoApi;
}

export interface PluginServerContext extends PluginLifecycleRegistration {
  readonly paseo: PaseoApi;
  registerSettings<Schema extends ZodType>(
    definition: SettingsDefinition<Schema>,
  ): PluginSettingsDocument<Schema>;
  handle<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
    handler: (
      input: ZodOutput<InputSchema>,
      context: PluginHandlerContext,
    ) => ZodInput<OutputSchema> | Promise<ZodInput<OutputSchema>>,
  ): void;
  registerProvider(provider: ProviderRegistration): void;
  addForgeServerProvider(contribution: PluginForgeServerProviderContribution): void;
}

export type PluginServerContribution = (server: PluginServerContext) => PluginCleanup;
