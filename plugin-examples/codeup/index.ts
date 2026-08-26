import type { PluginContext } from "@getpaseo/plugin";
import { codeupClientProvider } from "./codeup.client";
import { codeupServerProvider } from "./codeup.server";

export default function contribute(plugin: PluginContext) {
  plugin.addForgeServerProvider(codeupServerProvider);
  plugin.addForgeClientProvider(codeupClientProvider);
  return () => {};
}
