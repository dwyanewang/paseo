import type { TFunction } from "i18next";
import type { ForgeAuthState } from "@getpaseo/protocol/messages";
import { parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";
import {
  buildForgeSignInCommand,
  forgeFromRemoteUrl,
  getForgePresentation,
  type Forge,
} from "@/git/forge";

export type ForgeSetupAction = "update_host" | "install_cli" | "sign_in" | null;

export interface ForgeSetupState {
  action: ForgeSetupAction;
  forge: Forge;
}

// The precise setup step a workspace needs before its forge features work, or
// null when nothing is actionable (authenticated, or no forge remote at all).
export function computeForgeSetupState(input: {
  forge: Forge;
  remoteUrl: string | null | undefined;
  forgeProvidersSupported: boolean;
  codeupForgeSupported: boolean;
  authState: ForgeAuthState | undefined;
}): ForgeSetupState {
  const configuredForge = forgeFromRemoteUrl(input.remoteUrl);

  // COMPAT(codeupForge): added in v0.2.0, remove after 2027-01-20 when the
  // minimum supported daemon advertises native Codeup Forge support.
  if (configuredForge === "codeup" && !input.codeupForgeSupported) {
    return { action: "update_host", forge: "codeup" };
  }

  // A daemon without pluggable forge support can't operate any non-GitHub forge,
  // so don't offer a setup action for one it can't drive.
  if (input.forge !== "github" && !input.forgeProvidersSupported) {
    return { action: null, forge: input.forge };
  }

  switch (input.authState) {
    case "cli_missing":
      return { action: "install_cli", forge: input.forge };
    case "unauthenticated":
      return { action: "sign_in", forge: input.forge };
    case "authenticated":
    case "no_remote":
    case "error":
      return { action: null, forge: input.forge };
    default:
      return { action: null, forge: input.forge };
  }
}

export function buildForgeSetupMessage(input: {
  action: ForgeSetupAction;
  forge: Forge;
  remoteUrl: string | null | undefined;
  t: TFunction;
}): string | null {
  if (input.action === null) {
    return null;
  }
  const { brandLabel, signInCli } = getForgePresentation(input.forge);
  if (input.action === "update_host") {
    return input.t("workspace.git.forgeSetup.updateHost", { brand: brandLabel });
  }
  // A forge with no known CLI (an unknown/third-party forge rendered neutrally)
  // has no install/sign-in command to interpolate — show neutral guidance.
  if (signInCli === null) {
    return input.t("workspace.git.forgeSetup.generic", { brand: brandLabel });
  }
  if (input.action === "install_cli") {
    return input.t("workspace.git.forgeSetup.installCli", { cli: signInCli, brand: brandLabel });
  }
  const host = input.remoteUrl ? (parseGitRemoteLocation(input.remoteUrl)?.host ?? null) : null;
  const command = buildForgeSignInCommand(input.forge, host);
  return input.t("workspace.git.forgeSetup.signIn", { command, brand: brandLabel });
}
