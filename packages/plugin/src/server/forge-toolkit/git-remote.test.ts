import { describe, expect, it } from "vitest";
import { parseGitRemoteLocation } from "./git-remote.js";

describe("parseGitRemoteLocation", () => {
  it("parses scp-like remotes", () => {
    expect(parseGitRemoteLocation("git@gitee.com:acme/app.git")).toEqual({
      transport: "scp",
      host: "gitee.com",
      path: "acme/app",
    });
  });

  it("parses https remotes and strips the default port and .git suffix", () => {
    expect(parseGitRemoteLocation("https://gitee.com:443/acme/app.git/")).toEqual({
      transport: "https",
      host: "gitee.com",
      path: "acme/app",
    });
  });

  it("keeps a non-default port", () => {
    expect(parseGitRemoteLocation("ssh://git@self.hosted:2222/acme/app")).toEqual({
      transport: "ssh",
      host: "self.hosted",
      port: "2222",
      path: "acme/app",
    });
  });

  it("rejects remotes without a usable host or path", () => {
    expect(parseGitRemoteLocation("")).toBeNull();
    expect(parseGitRemoteLocation("https://gitee.com/")).toBeNull();
    expect(parseGitRemoteLocation("file:///srv/repos/app.git")).toBeNull();
  });
});
