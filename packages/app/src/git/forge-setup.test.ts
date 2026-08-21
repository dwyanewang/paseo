import { describe, expect, it, vi } from "vitest";
import { buildForgeSetupMessage, computeForgeSetupState } from "./forge-setup";

const CODEUP_REMOTE = "git@codeup.aliyun.com:org/team/repo.git";

describe("computeForgeSetupState", () => {
  it("requires a host update for a Codeup remote on an old daemon", () => {
    expect(
      computeForgeSetupState({
        forge: "github",
        remoteUrl: CODEUP_REMOTE,
        forgeProvidersSupported: false,
        codeupForgeSupported: false,
        authState: "cli_missing",
      }),
    ).toEqual({ action: "update_host", forge: "codeup" });
  });

  it("makes the Codeup host-update action take precedence over auth prompts", () => {
    expect(
      computeForgeSetupState({
        forge: "codeup",
        remoteUrl: CODEUP_REMOTE,
        forgeProvidersSupported: true,
        codeupForgeSupported: false,
        authState: "unauthenticated",
      }),
    ).toEqual({ action: "update_host", forge: "codeup" });
  });

  it("uses normal Codeup auth onboarding when the daemon supports Codeup", () => {
    expect(
      computeForgeSetupState({
        forge: "codeup",
        remoteUrl: CODEUP_REMOTE,
        forgeProvidersSupported: true,
        codeupForgeSupported: true,
        authState: "cli_missing",
      }),
    ).toEqual({ action: "install_cli", forge: "codeup" });
    expect(
      computeForgeSetupState({
        forge: "codeup",
        remoteUrl: CODEUP_REMOTE,
        forgeProvidersSupported: true,
        codeupForgeSupported: true,
        authState: "unauthenticated",
      }),
    ).toEqual({ action: "sign_in", forge: "codeup" });
  });

  it("does not gate unrelated forge remotes on the Codeup capability", () => {
    expect(
      computeForgeSetupState({
        forge: "gitlab",
        remoteUrl: "git@gitlab.com:org/repo.git",
        forgeProvidersSupported: true,
        codeupForgeSupported: false,
        authState: "authenticated",
      }),
    ).toEqual({ action: null, forge: "gitlab" });
  });

  it("builds the host-update prompt with Codeup branding", () => {
    const t = vi.fn((key: string, values: { brand: string }) => `${key}:${values.brand}`);
    expect(
      buildForgeSetupMessage({
        action: "update_host",
        forge: "codeup",
        remoteUrl: CODEUP_REMOTE,
        t: t as never,
      }),
    ).toBe("workspace.git.forgeSetup.updateHost:Codeup");
  });
});
