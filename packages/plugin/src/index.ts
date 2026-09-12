// Shared SDK entry. Keep runtime-specific imports and re-exports on /client or /server.
export type {
  PluginTheme,
  PluginWorkspaceSnapshot,
  PluginAgentSnapshot,
  PluginThemeColors,
  PluginThemeContribution,
  PluginAttachmentSourceContribution,
  PluginTimelineData,
  PluginTimelineItem,
  PluginTimelineTransformResult,
  PluginCleanup,
} from "./contracts.js";
export {
  defineSettings,
  settingsRpc,
  type DeepReadonly,
  type PluginSettingsDecision,
  type PluginSettingsDocument,
  type PluginSettingsError,
  type PluginSettingsErrorCode,
  type PluginSettingsReadResult,
  type PluginSettingsSnapshot,
  type PluginSettingsUpdateResult,
  type SettingsDefinition,
} from "./settings.js";
export {
  defineAttachmentSource,
  PluginAttachmentItemSchema,
  PluginAttachmentSearchPayloadSchema,
  type PluginAttachmentItem,
  type PluginAttachmentSearchPayload,
} from "./attachments.js";
export { defineRpc, type PluginRpcContract, type RpcInput, type RpcOutput } from "./rpc.js";
export {
  defineForgeClientProvider,
  defineForgeFacts,
  type PluginForgeClientProviderContribution,
  type PluginForgeClientView,
  type PluginForgeDefinition,
  type PluginForgeFactsRegistration,
  type PluginForgeFactsContribution,
  type PluginForgeMergeCapability,
  type PluginForgeMergeMethod,
  type PluginForgeReferencePath,
  type PluginForgeSignInCommand,
  type PluginForgeSpecificEnvelope,
  type PluginForgeSvgPathIcon,
  type PluginForgeUrlGrammar,
} from "./forge.js";
