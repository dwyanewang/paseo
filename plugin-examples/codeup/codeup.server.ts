import { defineForgeServerProvider } from "@getpaseo/plugin/server";
import { createCodeupService } from "./codeup-service.server";
import { codeupDefinition } from "./codeup-definition.shared";

export const codeupServerProvider = defineForgeServerProvider({
  definition: codeupDefinition,
  service: createCodeupService(),
});
