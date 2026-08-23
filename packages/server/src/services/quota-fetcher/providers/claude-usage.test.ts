import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderUsageTarget } from "../../../server/agent/provider-registry.js";
import { ClaudeUsageState } from "./claude-state.js";
import { ClaudeQuotaProvider } from "./claude.js";

function createLogger() {
  const logger = {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger as never;
}

function target(
  providerId: string,
  displayName: string,
  runtimeSettings?: ProviderUsageTarget["runtimeSettings"],
): ProviderUsageTarget {
  return {
    providerId,
    displayName,
    baseProviderId: "claude",
    iconProviderId: "claude",
    ...(runtimeSettings ? { runtimeSettings } : {}),
  };
}

function usageResponse(used = 12): Response {
  return new Response(
    JSON.stringify({
      five_hour: { utilization: used, resets_at: "2026-08-22T12:00:00.000Z" },
      seven_day: { utilization: 3, resets_at: "2026-08-29T00:00:00.000Z" },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const tempDirs: string[] = [];

function createCredentialDir(accessToken: string): string {
  const dir = mkdtempSync(join(tmpdir(), "paseo-claude-usage-"));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken, subscriptionType: "pro" } }),
  );
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ClaudeQuotaProvider safe usage sources", () => {
  it("prefers live SDK usage without reading credentials or calling HTTP", async () => {
    const fetchApi = vi.fn(async () => {
      throw new Error("HTTP fallback must not run");
    });
    const keychain = vi.fn(async () => {
      throw new Error("credentials must not be read");
    });
    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      platform: "darwin",
      claudeKeychainReader: keychain,
      fetch: fetchApi,
      liveSessions: [
        {
          getPlanUsage: async () => ({
            kind: "available",
            planLabel: "Max",
            sourceLabel: "Claude Code",
            windows: [
              {
                id: "five_hour",
                label: "Session",
                usedPct: 25,
                remainingPct: 75,
                resetsAt: null,
              },
            ],
            balances: [],
            details: [],
          }),
        },
      ],
      now: () => Date.parse("2026-08-22T00:00:00.000Z"),
    });

    await expect(provider.fetchUsage()).resolves.toMatchObject({
      status: "available",
      sourceLabel: "Claude Code",
      fetchedAt: "2026-08-22T00:00:00.000Z",
      windows: [expect.objectContaining({ usedPct: 25 })],
    });
    expect(keychain).not.toHaveBeenCalled();
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it("treats live not-applicable data as authoritative", async () => {
    const fetchApi = vi.fn(async () => usageResponse());
    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      fetch: fetchApi,
      liveSessions: [{ getPlanUsage: async () => ({ kind: "not_applicable" }) }],
    });

    await expect(provider.fetchUsage()).resolves.toMatchObject({
      status: "unavailable",
      sourceLabel: "Claude Code",
    });
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it("isolates derived profiles by effective OAuth token and provider id", async () => {
    const authorizations: string[] = [];
    const fetchApi = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      authorizations.push(headers.get("Authorization") ?? "");
      return usageResponse();
    });
    const state = new ClaudeUsageState();
    const work = new ClaudeQuotaProvider({
      logger: createLogger(),
      target: target("claude-work", "Claude (Work)", {
        env: { CLAUDE_CODE_OAUTH_TOKEN: "work-token" },
      }),
      state,
      fetch: fetchApi,
      env: {},
    });
    const personal = new ClaudeQuotaProvider({
      logger: createLogger(),
      target: target("claude-personal", "Claude (Personal)", {
        env: { CLAUDE_CODE_OAUTH_TOKEN: "personal-token" },
      }),
      state,
      fetch: fetchApi,
      env: {},
    });

    const [workUsage, personalUsage] = await Promise.all([
      work.fetchUsage(),
      personal.fetchUsage(),
    ]);

    expect(authorizations.sort()).toEqual(["Bearer personal-token", "Bearer work-token"]);
    expect(workUsage).toMatchObject({
      providerId: "claude-work",
      iconProviderId: "claude",
      displayName: "Claude (Work)",
    });
    expect(personalUsage).toMatchObject({
      providerId: "claude-personal",
      iconProviderId: "claude",
      displayName: "Claude (Personal)",
    });
  });

  it("fails closed for replacement commands without an explicit credential source", async () => {
    const fetchApi = vi.fn(async () => usageResponse());
    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      target: target("claude-wrapper", "Claude Wrapper", {
        command: { mode: "replace", argv: ["claude-wrapper"] },
      }),
      fetch: fetchApi,
      env: {},
    });

    await expect(provider.fetchUsage()).resolves.toMatchObject({ status: "unavailable" });
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it("does not treat a Keychain-only source as explicit off macOS", async () => {
    const dir = createCredentialDir("default-file-token");
    const fetchApi = vi.fn(async () => usageResponse());
    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      target: target("claude-wrapper", "Claude Wrapper", {
        command: { mode: "replace", argv: ["claude-wrapper"] },
        env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/tmp/claude-wrapper" },
      }),
      claudeHome: dir,
      platform: "linux",
      fetch: fetchApi,
      env: {},
    });

    await expect(provider.fetchUsage()).resolves.toMatchObject({ status: "unavailable" });
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it.each([
    ["API key", { ANTHROPIC_API_KEY: "sk-ant-test" }],
    ["auth token", { ANTHROPIC_AUTH_TOKEN: "gateway-token" }],
    ["custom endpoint", { ANTHROPIC_BASE_URL: "https://gateway.example.com" }],
    ["Bedrock", { CLAUDE_CODE_USE_BEDROCK: "1" }],
    ["Vertex", { CLAUDE_CODE_USE_VERTEX: "true" }],
    ["Foundry", { CLAUDE_CODE_USE_FOUNDRY: "yes" }],
  ])("does not call the OAuth usage endpoint for %s sessions", async (_label, env) => {
    const dir = createCredentialDir("oauth-token-that-must-not-be-read");
    const fetchApi = vi.fn(async () => usageResponse());
    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      target: target("claude", "Claude", { env }),
      claudeHome: dir,
      fetch: fetchApi,
      env: {},
    });

    await expect(provider.fetchUsage()).resolves.toMatchObject({ status: "unavailable" });
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it("reads each profile from its effective Claude config directory", async () => {
    const workDir = createCredentialDir("work-file-token");
    const personalDir = createCredentialDir("personal-file-token");
    const authorizations: string[] = [];
    const fetchApi = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("Authorization") ?? "");
      return usageResponse();
    });

    const work = new ClaudeQuotaProvider({
      logger: createLogger(),
      target: target("claude-work", "Claude (Work)", {
        env: { CLAUDE_CONFIG_DIR: workDir },
      }),
      fetch: fetchApi,
      env: {},
    });
    const personal = new ClaudeQuotaProvider({
      logger: createLogger(),
      target: target("claude-personal", "Claude (Personal)", {
        env: { CLAUDE_CONFIG_DIR: personalDir },
      }),
      fetch: fetchApi,
      env: {},
    });

    await Promise.all([work.fetchUsage(), personal.fetchUsage()]);

    expect(authorizations.sort()).toEqual(["Bearer personal-file-token", "Bearer work-file-token"]);
  });

  it("prefers the macOS Keychain over the profile credential file", async () => {
    const dir = createCredentialDir("file-token");
    let authorization = "";
    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      claudeHome: dir,
      platform: "darwin",
      claudeKeychainReader: async () => ({
        claudeAiOauth: { accessToken: "keychain-token" },
      }),
      fetch: async (_url, init) => {
        authorization = new Headers(init?.headers).get("Authorization") ?? "";
        return usageResponse();
      },
      env: {},
    });

    await provider.fetchUsage();

    expect(authorization).toBe("Bearer keychain-token");
  });

  it("retries once when the credential file changes after an auth failure", async () => {
    const dir = createCredentialDir("expired-token");
    const credentialPath = join(dir, ".credentials.json");
    let calls = 0;
    const fetchApi = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        writeFileSync(
          credentialPath,
          JSON.stringify({
            claudeAiOauth: { accessToken: "fresh-token", subscriptionType: "pro" },
          }),
        );
        return new Response(null, { status: 401 });
      }
      return usageResponse(19);
    });
    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      claudeHome: dir,
      fetch: fetchApi,
      env: {},
    });

    await expect(provider.fetchUsage()).resolves.toMatchObject({
      status: "available",
      sourceLabel: "Anthropic API",
      windows: expect.arrayContaining([expect.objectContaining({ usedPct: 19 })]),
    });
    expect(fetchApi).toHaveBeenCalledTimes(2);
    expect(readFileSync(credentialPath, "utf8")).toContain("fresh-token");
  });

  it("does not retry again when the changed credential is also rejected", async () => {
    const dir = createCredentialDir("expired-token");
    const credentialPath = join(dir, ".credentials.json");
    let calls = 0;
    const fetchApi = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        writeFileSync(
          credentialPath,
          JSON.stringify({ claudeAiOauth: { accessToken: "still-expired-token" } }),
        );
      }
      return new Response(null, { status: calls === 1 ? 401 : 403 });
    });
    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      claudeHome: dir,
      fetch: fetchApi,
      env: {},
      now: () => Date.parse("2026-08-22T00:00:00.000Z"),
    });

    await expect(provider.fetchUsage()).resolves.toMatchObject({
      status: "unavailable",
      nextRefreshAt: "2026-08-22T00:00:05.000Z",
    });
    expect(fetchApi).toHaveBeenCalledTimes(2);
  });

  it("backs off unchanged env credentials and never calls a token endpoint", async () => {
    let now = Date.parse("2026-08-22T00:00:00.000Z");
    const fetchApi = vi.fn(async (url: RequestInfo | URL) => {
      expect(url.toString()).toBe("https://api.anthropic.com/api/oauth/usage");
      return new Response(null, { status: 401 });
    });
    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      target: target("claude", "Claude", {
        env: { CLAUDE_CODE_OAUTH_TOKEN: "expired-token" },
      }),
      fetch: fetchApi,
      env: {},
      now: () => now,
    });

    const first = await provider.fetchUsage();
    now += 1_000;
    const backedOff = await provider.fetchUsage();

    expect(first.status).toBe("unavailable");
    expect(backedOff.status).toBe("unavailable");
    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(backedOff.nextRefreshAt).toBe("2026-08-22T00:00:05.000Z");
  });

  it("serves a five-minute last-good snapshot and then becomes unavailable", async () => {
    let now = Date.parse("2026-08-22T00:00:00.000Z");
    let shouldFail = false;
    const fetchApi = vi.fn(async () => {
      if (shouldFail) throw new Error("network down");
      return usageResponse(31);
    });
    const provider = new ClaudeQuotaProvider({
      logger: createLogger(),
      target: target("claude", "Claude", {
        env: { CLAUDE_CODE_OAUTH_TOKEN: "valid-token" },
      }),
      fetch: fetchApi,
      env: {},
      now: () => now,
    });

    const fresh = await provider.fetchUsage();
    shouldFail = true;
    now += 60_000;
    const cached = await provider.fetchUsage();
    now += 5 * 60_000;
    const expired = await provider.fetchUsage();

    expect(fresh.fetchedAt).toBe("2026-08-22T00:00:00.000Z");
    expect(cached).toMatchObject({
      status: "available",
      sourceLabel: "Anthropic API (cached)",
      fetchedAt: "2026-08-22T00:00:00.000Z",
    });
    expect(expired).toMatchObject({ status: "unavailable", error: "network down" });
  });

  it("clears auth backoff when the credential fingerprint changes", async () => {
    let now = Date.parse("2026-08-22T00:00:00.000Z");
    const fetchApi = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("Authorization");
      return authorization === "Bearer fresh-token"
        ? usageResponse(27)
        : new Response(null, { status: 401 });
    });
    const state = new ClaudeUsageState();
    const expiredProvider = new ClaudeQuotaProvider({
      logger: createLogger(),
      target: target("claude", "Claude", {
        env: { CLAUDE_CODE_OAUTH_TOKEN: "expired-token" },
      }),
      state,
      fetch: fetchApi,
      env: {},
      now: () => now,
    });

    await expiredProvider.fetchUsage();
    now += 1_000;
    const refreshedProvider = new ClaudeQuotaProvider({
      logger: createLogger(),
      target: target("claude", "Claude", {
        env: { CLAUDE_CODE_OAUTH_TOKEN: "fresh-token" },
      }),
      state,
      fetch: fetchApi,
      env: {},
      now: () => now,
    });

    await expect(refreshedProvider.fetchUsage()).resolves.toMatchObject({
      status: "available",
      windows: expect.arrayContaining([expect.objectContaining({ usedPct: 27 })]),
    });
    expect(fetchApi).toHaveBeenCalledTimes(2);
  });

  it("shares one debounced file credential wait across concurrent callers", async () => {
    const dir = createCredentialDir("expired-token");
    const credentialPath = join(dir, ".credentials.json");
    const state = new ClaudeUsageState();
    const initial = {
      sourceId: `file:${credentialPath}`,
      sourceKind: "file" as const,
      fingerprint: "expired-token",
      accessToken: "expired-token",
      watchPath: credentialPath,
    };
    const read = vi.fn(async () => {
      const raw = readFileSync(credentialPath, "utf8");
      const token = JSON.parse(raw).claudeAiOauth.accessToken as string;
      return {
        ...initial,
        fingerprint: token,
        accessToken: token,
      };
    });

    const first = state.waitForCredentialChange(initial, read);
    const second = state.waitForCredentialChange(initial, read);
    expect(second).toBe(first);
    setTimeout(() => {
      writeFileSync(
        credentialPath,
        JSON.stringify({ claudeAiOauth: { accessToken: "fresh-token" } }),
      );
    }, 100);

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ accessToken: "fresh-token" }),
      expect.objectContaining({ accessToken: "fresh-token" }),
    ]);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
