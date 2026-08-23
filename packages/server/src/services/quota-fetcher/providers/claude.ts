import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Logger } from "pino";
import { z } from "zod";
import type {
  ProviderUsage,
  ProviderUsageDetail,
  ProviderUsageWindow,
} from "../../../server/messages.js";
import type { AgentPlanUsage } from "../../../server/agent/agent-sdk-types.js";
import type { ProviderUsageTarget } from "../../../server/agent/provider-registry.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  ApiNumberSchema,
  fetchProviderApi,
  toneFromUsedPct,
  unavailableUsage,
  windowFromUsedPct,
} from "../usage.js";
import { type ClaudeCredential, ClaudeUsageState } from "./claude-state.js";

const execFileAsync = promisify(execFile);
const CLAUDE_KEYCHAIN_TIMEOUT_MS = 2_000;
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_API_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const LIVE_USAGE_SOURCE_ID = "claude-code";

const ClaudeCredentialsSchema = z.object({
  claudeAiOauth: z
    .object({
      accessToken: z.string().optional(),
      subscriptionType: z.string().optional(),
      rateLimitTier: z.string().optional(),
    })
    .optional(),
});

const ClaudeUsageWindowSchema = z.object({
  utilization: ApiNumberSchema,
  resets_at: z.string().nullish(),
});

// Model- and surface-scoped weekly limits live in a `limits[]` array rather than a
// top-level `seven_day_<model>` key. Entries are validated one at a time (see
// scopedLimitsFromResponse) so a single malformed or newly-shaped entry cannot take down
// the windows that already parsed from the top-level keys.
const ClaudeScopeLabelSchema = z
  .object({ id: z.string().nullish(), display_name: z.string().nullish() })
  .nullish();

const ClaudeLimitSchema = z.object({
  kind: z.string(),
  percent: ApiNumberSchema.nullish(),
  resets_at: z.string().nullish(),
  scope: z.object({ model: ClaudeScopeLabelSchema, surface: ClaudeScopeLabelSchema }).nullish(),
});

const ClaudeUsageResponseSchema = z.object({
  five_hour: ClaudeUsageWindowSchema.nullish(),
  seven_day: ClaudeUsageWindowSchema.nullish(),
  seven_day_opus: ClaudeUsageWindowSchema.nullish(),
  seven_day_omelette: ClaudeUsageWindowSchema.nullish(),
  // Deliberately permissive: an additive section must never regress the top-level
  // windows, so shape validation happens per entry rather than here.
  limits: z.array(z.unknown()).nullish(),
  extra_usage: z
    .object({
      is_enabled: z.boolean().optional(),
    })
    .nullish(),
});

type ClaudeUsageResponse = z.infer<typeof ClaudeUsageResponseSchema>;
type ClaudeLimit = z.infer<typeof ClaudeLimitSchema>;

const SCOPED_WEEKLY_KIND = "weekly_scoped";

interface ClaudePlanUsageSession {
  getPlanUsage?(): Promise<AgentPlanUsage>;
}

interface ClaudeQuotaProviderOptions {
  logger: Logger;
  target?: ProviderUsageTarget;
  liveSessions?: ClaudePlanUsageSession[];
  state?: ClaudeUsageState;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  claudeHome?: string;
  claudeKeychainReader?: (service: string) => Promise<unknown | null>;
  platform?: typeof process.platform;
  fetch?: ProviderApiFetch;
}

function buildClaudePlan(
  subscriptionType: string | undefined,
  rateLimitTier: string | undefined,
): string | null {
  if (!subscriptionType) return null;
  const label = subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
  const tier = rateLimitTier?.split("_").pop();
  return tier ? `${label} ${tier}` : label;
}

function credentialFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function claudeKeychainService(env: NodeJS.ProcessEnv): string {
  const secureStorageDir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const configDir = env.CLAUDE_CONFIG_DIR;
  const usesDefaultService =
    secureStorageDir !== undefined ? secureStorageDir.length === 0 : configDir === undefined;
  if (usesDefaultService) return CLAUDE_KEYCHAIN_SERVICE;
  const servicePath = (secureStorageDir ?? configDir ?? "").normalize("NFC");
  const suffix = createHash("sha256").update(servicePath).digest("hex").slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${suffix}`;
}

function isTruthyEnvValue(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized !== undefined &&
    normalized.length > 0 &&
    normalized !== "0" &&
    normalized !== "false" &&
    normalized !== "no" &&
    normalized !== "off"
  );
}

function hasOfficialOAuthUsage(env: NodeJS.ProcessEnv): boolean {
  const hasCustomEndpoint = Boolean(env.ANTHROPIC_BASE_URL?.trim());
  const usesCloudTransport =
    isTruthyEnvValue(env.CLAUDE_CODE_USE_BEDROCK) ||
    isTruthyEnvValue(env.CLAUDE_CODE_USE_VERTEX) ||
    isTruthyEnvValue(env.CLAUDE_CODE_USE_FOUNDRY);
  if (hasCustomEndpoint || usesCloudTransport) return false;
  if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return true;
  return !(env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim());
}

function hasExplicitCredentialSource(
  target: ProviderUsageTarget,
  platform: typeof process.platform,
): boolean {
  const env = target.runtimeSettings?.env;
  return Boolean(
    env?.CLAUDE_CODE_OAUTH_TOKEN?.trim() ||
    env?.CLAUDE_CONFIG_DIR?.trim() ||
    (platform === "darwin" && env?.CLAUDE_SECURESTORAGE_CONFIG_DIR?.trim()),
  );
}

/**
 * A weekly limit scoped to one model or one surface, normalized away from whichever
 * shape of the response described it.
 *
 * The API describes the same limit two ways during the migration: a legacy top-level
 * `seven_day_<model>` key, and an entry in `limits[]`. Everything downstream works on
 * this one representation so the two shapes are reconciled exactly once, in
 * `reconcileScopedLimits`, rather than at each place a window is built.
 */
interface ScopedLimit {
  dimension: "model" | "surface";
  /** The API's own identifier. Null on every response observed so far. */
  id: string | null;
  /** Display name, or the id when the API sends no display name. */
  name: string;
  usedPct: number | null;
  resetsAt: string | null;
}

// Windows that describe no particular model or surface.
const UNSCOPED_WINDOWS: ReadonlyArray<{
  field: "five_hour" | "seven_day";
  id: string;
  label: string;
}> = [
  { field: "five_hour", id: "five_hour", label: "Session" },
  { field: "seven_day", id: "weekly", label: "Weekly" },
];

// Scoped windows from before `limits[]` existed. Declaring the dimension here is what
// stops a *surface* named "Omelette" from being mistaken for the legacy Omelette *model*
// window: these keys are model-scoped by definition.
const LEGACY_SCOPED_WINDOWS: ReadonlyArray<{
  field: "seven_day_opus" | "seven_day_omelette";
  name: string;
}> = [
  { field: "seven_day_opus", name: "Opus" },
  { field: "seven_day_omelette", name: "Omelette" },
];

/** Fold a name down to the characters an id is allowed to carry. */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Whether two descriptions denote the same limit. This is the single definition of
 * identity for scoped limits; nothing else may compare them, and in particular nothing
 * may compare display labels, which are presentation rather than identity.
 *
 * - Different dimensions are never the same limit, so a surface and a model sharing a
 *   name stay apart.
 * - When both sides carry the API's own id, that id decides, so `fable-pro` and
 *   `fable_pro` stay apart.
 * - Otherwise fall back to the normalized name, which is the only link available between
 *   a legacy key (never has an id) and its `limits[]` counterpart.
 */
function isSameLimit(a: ScopedLimit, b: ScopedLimit): boolean {
  if (a.dimension !== b.dimension) return false;
  if (a.id && b.id) return a.id === b.id;
  return normalizeName(a.name) === normalizeName(b.name);
}

/**
 * Merge the legacy and `limits[]` descriptions into one limit per identity.
 *
 * A `limits[]` entry wins on identity because that is the representation the API is
 * migrating towards, so a limit keeps the same window id whichever shape carried it.
 * Its values are nullable though, so each field falls back to the legacy twin instead of
 * discarding a number the response did contain.
 */
function reconcileScopedLimits(
  legacy: ScopedLimit[],
  fromLimitsArray: ScopedLimit[],
): ScopedLimit[] {
  const reconciled = [...legacy];
  for (const limit of fromLimitsArray) {
    const index = reconciled.findIndex((candidate) => isSameLimit(candidate, limit));
    if (index === -1) {
      reconciled.push(limit);
      continue;
    }
    const twin = reconciled[index];
    reconciled[index] = {
      ...limit,
      usedPct: limit.usedPct ?? twin?.usedPct ?? null,
      resetsAt: limit.resetsAt ?? twin?.resetsAt ?? null,
    };
  }
  return reconciled;
}

function scopedLimitFromLegacy(
  spec: (typeof LEGACY_SCOPED_WINDOWS)[number],
  window: z.infer<typeof ClaudeUsageWindowSchema>,
): ScopedLimit {
  return {
    dimension: "model",
    id: null,
    name: spec.name,
    usedPct: window.utilization,
    resetsAt: window.resets_at ?? null,
  };
}

/** The scope of a `limits[]` entry, or null when it names nothing renderable. */
function scopedLimitFromEntry(limit: ClaudeLimit): ScopedLimit | null {
  for (const dimension of ["model", "surface"] as const) {
    const entry = limit.scope?.[dimension];
    const id = entry?.id?.trim() || null;
    const name = entry?.display_name?.trim() || id;
    if (name) {
      return {
        dimension,
        id,
        name,
        usedPct: limit.percent ?? null,
        resetsAt: limit.resets_at ?? null,
      };
    }
  }
  return null;
}

// The client uses window ids as React keys, so they must be stable across refreshes and
// unique within a response. An API-supplied id is already an identifier and is used
// verbatim (ids elsewhere carry punctuation too, e.g. MiniMax's `interval_MiniMax-M2.7`);
// only a name fallback is normalized. Normalizing an id would collapse `fable-pro` and
// `fable_pro` into one window.
function scopedWindowId(limit: ScopedLimit): string {
  return `weekly_${limit.dimension}_${limit.id ?? normalizeName(limit.name)}`;
}

// Backstop for the one residual case identity cannot rule out: an entry whose verbatim id
// equals another entry's normalized name. Suffix rather than drop, because a missing bar
// is the bug this change exists to fix.
function uniqueWindowId(candidate: string, taken: Set<string>): string {
  if (!taken.has(candidate)) return candidate;
  for (let suffix = 2; ; suffix += 1) {
    const next = `${candidate}_${suffix}`;
    if (!taken.has(next)) return next;
  }
}

function legacyScopedLimits(resp: ClaudeUsageResponse): ScopedLimit[] {
  const limits: ScopedLimit[] = [];
  for (const spec of LEGACY_SCOPED_WINDOWS) {
    const window = resp[spec.field];
    if (window) limits.push(scopedLimitFromLegacy(spec, window));
  }
  return limits;
}

function unscopedWindows(resp: ClaudeUsageResponse): ProviderUsageWindow[] {
  const windows: ProviderUsageWindow[] = [];
  for (const spec of UNSCOPED_WINDOWS) {
    const window = resp[spec.field];
    if (!window) continue;
    windows.push(
      windowFromUsedPct({
        id: spec.id,
        label: spec.label,
        utilizationPct: window.utilization,
        resetsAt: window.resets_at ?? null,
        tone: toneFromUsedPct(window.utilization),
      }),
    );
  }
  return windows;
}

function scopedWindows(limits: ScopedLimit[]): ProviderUsageWindow[] {
  const taken = new Set<string>();
  return limits.map((limit) => {
    const id = uniqueWindowId(scopedWindowId(limit), taken);
    taken.add(id);
    // Emitted even at 0% and inactive: a zero bar answers "how much of this model have I
    // used", and the bar must not come and go between refreshes.
    return windowFromUsedPct({
      id,
      label: `Weekly \u00b7 ${limit.name}`,
      utilizationPct: limit.usedPct,
      resetsAt: limit.resetsAt,
      tone: toneFromUsedPct(limit.usedPct),
    });
  });
}

type ClaudeKeychainCommandRunner = (args: string[]) => Promise<string | null>;

// Keep this in sync with Claude Code's Keychain account derivation.
const CLAUDE_KEYCHAIN_ACCOUNT_PATTERN = /^[a-zA-Z0-9._-]+$/;
const CLAUDE_KEYCHAIN_FALLBACK_ACCOUNT = "claude-code-user";

export function claudeKeychainAccount(
  user: string = process.env["USER"] || userInfo().username,
): string {
  return CLAUDE_KEYCHAIN_ACCOUNT_PATTERN.test(user) ? user : CLAUDE_KEYCHAIN_FALLBACK_ACCOUNT;
}

async function runSecurityCommand(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("security", args, {
      timeout: CLAUDE_KEYCHAIN_TIMEOUT_MS,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Read Claude Code's account-specific Keychain item, then try the legacy lookup. */
export async function readClaudeKeychainCredentials(
  run: ClaudeKeychainCommandRunner = runSecurityCommand,
  account: string = claudeKeychainAccount(),
  service: string = CLAUDE_KEYCHAIN_SERVICE,
): Promise<unknown | null> {
  const lookups = [
    ["find-generic-password", "-a", account, "-w", "-s", service],
    ["find-generic-password", "-w", "-s", service],
  ];

  for (const args of lookups) {
    const raw = await run(args);
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const creds = ClaudeCredentialsSchema.safeParse(parsed);
    if (creds.success && creds.data.claudeAiOauth?.accessToken) return parsed;
  }
  return null;
}

export class ClaudeQuotaProvider implements ProviderUsageFetcher {
  readonly providerId: string;
  readonly displayName: string;

  private readonly logger: Logger;
  private readonly target: ProviderUsageTarget;
  private readonly liveSessions: ClaudePlanUsageSession[];
  private readonly state: ClaudeUsageState;
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly configDir: string;
  private readonly readKeychainCredentials: (service: string) => Promise<unknown | null>;
  private readonly platform: typeof process.platform;
  private readonly fetchApi: ProviderApiFetch;

  constructor(options: ClaudeQuotaProviderOptions) {
    this.target =
      options.target ??
      ({
        providerId: "claude",
        displayName: "Claude",
        baseProviderId: "claude",
        iconProviderId: "claude",
      } satisfies ProviderUsageTarget);
    this.providerId = this.target.providerId;
    this.displayName = this.target.displayName;
    this.logger = options.logger.child({ module: "claude-quota-provider" });
    this.liveSessions = options.liveSessions ?? [];
    this.state = options.state ?? new ClaudeUsageState();
    this.now = options.now ?? Date.now;
    this.env = {
      ...(options.env ?? process.env),
      ...this.target.runtimeSettings?.env,
    };
    this.configDir = options.claudeHome ?? this.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
    this.readKeychainCredentials =
      options.claudeKeychainReader ??
      ((service) =>
        readClaudeKeychainCredentials(runSecurityCommand, claudeKeychainAccount(), service));
    this.platform = options.platform ?? process.platform;
    this.fetchApi = options.fetch ?? fetch;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const live = await this.readLiveUsage();
    if (live.kind === "available") {
      return live.usage;
    }
    if (live.kind === "not_applicable") {
      return this.unavailable("Claude Code");
    }

    const replacementCommand = this.target.runtimeSettings?.command?.mode === "replace";
    if (replacementCommand && !hasExplicitCredentialSource(this.target, this.platform)) {
      return this.cached({ status: "unavailable" });
    }
    if (!hasOfficialOAuthUsage(this.env)) {
      return this.cached({ status: "unavailable" });
    }

    const credential = await this.readCredential();
    if (!credential) {
      return this.cached({ status: "unavailable" });
    }

    const nowMs = this.now();
    const retryAt = this.state.authRetryAt(credential);
    if (retryAt !== null && nowMs < retryAt) {
      return this.cached({
        status: "unavailable",
        preferredSourceId: credential.sourceId,
        nextRetryAtMs: retryAt,
      });
    }

    try {
      const response = await this.callClaudeApi(credential.accessToken);
      if (response.kind === "available") {
        return this.storeHttpSuccess(credential, response.usage);
      }

      const changed = await this.state.waitForCredentialChange(credential, () =>
        this.readCredential(),
      );
      this.logger.debug(
        {
          providerId: this.providerId,
          sourceKind: credential.sourceKind,
          httpStatus: response.status,
          credentialsChanged: changed !== null,
        },
        "Claude usage authentication failed",
      );
      if (changed) {
        this.state.credentialChanged(credential.sourceId);
        this.state.credentialChanged(changed.sourceId);
        const retry = await this.callClaudeApi(changed.accessToken);
        if (retry.kind === "available") {
          return this.storeHttpSuccess(changed, retry.usage);
        }
        const nextRetryAtMs = this.state.recordAuthFailure(changed, this.now());
        return this.cached({
          status: "unavailable",
          preferredSourceId: changed.sourceId,
          nextRetryAtMs,
        });
      }

      const nextRetryAtMs = this.state.recordAuthFailure(credential, this.now());
      return this.cached({
        status: "unavailable",
        preferredSourceId: credential.sourceId,
        nextRetryAtMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.debug(
        { providerId: this.providerId, sourceKind: credential.sourceKind },
        "Claude usage request failed",
      );
      return this.cached({
        status: "error",
        error: message,
        preferredSourceId: credential.sourceId,
      });
    }
  }

  private async readLiveUsage(): Promise<
    | { kind: "available"; usage: ProviderUsage }
    | { kind: "not_applicable" }
    | { kind: "unavailable" }
  > {
    for (const session of this.liveSessions) {
      if (!session.getPlanUsage) continue;
      const usage = await session.getPlanUsage();
      if (usage.kind === "unavailable") continue;
      if (usage.kind === "not_applicable") return usage;
      const providerUsage = this.providerUsageFromLive(usage);
      return {
        kind: "available",
        usage: this.state.storeSuccess(LIVE_USAGE_SOURCE_ID, providerUsage, this.now()),
      };
    }
    return { kind: "unavailable" };
  }

  private providerUsageFromLive(
    usage: Extract<AgentPlanUsage, { kind: "available" }>,
  ): ProviderUsage {
    const providerUsage: ProviderUsage = {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: usage.planLabel,
      sourceLabel: usage.sourceLabel,
      fetchedAt: new Date(this.now()).toISOString(),
      windows: usage.windows.map((window) => ({
        ...window,
        tone: toneFromUsedPct(window.usedPct),
      })),
      balances: usage.balances,
      details: usage.details,
      error: null,
    };
    if (this.target.iconProviderId !== this.providerId) {
      providerUsage.iconProviderId = this.target.iconProviderId;
    }
    return providerUsage;
  }

  private storeHttpSuccess(credential: ClaudeCredential, resp: ClaudeUsageResponse): ProviderUsage {
    const scoped = reconcileScopedLimits(
      legacyScopedLimits(resp),
      this.scopedLimitsFromResponse(resp.limits),
    );
    const windows = [...unscopedWindows(resp), ...scopedWindows(scoped)];

    if (windows.length === 0) {
      // The response parsed but described nothing. That silence is how the previous
      // shape change went unnoticed, so make it greppable. `warn` and not `debug`
      // because file logging defaults to `info`.
      this.logger.warn("Claude usage response parsed but produced no windows");
    }

    const details: ProviderUsageDetail[] = [];
    const extraUsageEnabled = resp.extra_usage?.is_enabled;
    if (extraUsageEnabled !== undefined) {
      details.push({
        id: "extra_usage",
        label: "Extra usage",
        value: extraUsageEnabled ? "Enabled" : "Disabled",
      });
    }

    const usage: ProviderUsage = {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: buildClaudePlan(credential.subscriptionType, credential.rateLimitTier),
      sourceLabel: "Anthropic API",
      fetchedAt: new Date(this.now()).toISOString(),
      windows,
      balances: [],
      details,
      error: null,
    };
    if (this.target.iconProviderId !== this.providerId) {
      usage.iconProviderId = this.target.iconProviderId;
    }
    return this.state.storeSuccess(credential.sourceId, usage, this.now());
  }

  /**
   * Scoped limits carried by `limits[]`.
   *
   * Entries are validated one at a time so a single malformed or newly-shaped entry
   * cannot fail the whole response and take the windows that already parsed with it.
   */
  private scopedLimitsFromResponse(limits: ClaudeUsageResponse["limits"]): ScopedLimit[] {
    if (!limits) return [];

    const parsed: ScopedLimit[] = [];
    for (const entry of limits) {
      const result = ClaudeLimitSchema.safeParse(entry);
      if (!result.success) {
        this.logger.warn({ err: result.error }, "Skipping unparseable Claude usage limit entry");
        continue;
      }
      if (result.data.kind !== SCOPED_WEEKLY_KIND) continue;

      const limit = scopedLimitFromEntry(result.data);
      if (!limit) {
        this.logger.warn("Skipping scoped Claude usage limit with no resolvable scope name");
        continue;
      }
      parsed.push(limit);
    }
    return parsed;
  }

  private async readCredential(): Promise<ClaudeCredential | null> {
    const envToken = this.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
    if (envToken) {
      const sourceScope = this.target.runtimeSettings?.env?.CLAUDE_CODE_OAUTH_TOKEN
        ? `profile:${this.providerId}`
        : "process";
      return {
        sourceId: `env:${sourceScope}`,
        sourceKind: "env",
        fingerprint: credentialFingerprint(envToken),
        accessToken: envToken,
      };
    }

    if (this.platform === "darwin") {
      const service = claudeKeychainService(this.env);
      let payload: unknown | null = null;
      try {
        payload = await this.readKeychainCredentials(service);
      } catch {
        payload = null;
      }
      const credential = this.credentialFromPayload(
        payload,
        `keychain:${service}:${claudeKeychainAccount()}`,
        "keychain",
      );
      if (credential) return credential;
    }

    const credentialPath = join(this.configDir, ".credentials.json");
    try {
      const raw = await fs.readFile(credentialPath, "utf8");
      return this.credentialFromPayload(
        JSON.parse(raw),
        `file:${credentialPath}`,
        "file",
        credentialPath,
        raw,
      );
    } catch {
      return null;
    }
  }

  private credentialFromPayload(
    payload: unknown,
    sourceId: string,
    sourceKind: ClaudeCredential["sourceKind"],
    watchPath?: string,
    raw?: string,
  ): ClaudeCredential | null {
    const parsed = ClaudeCredentialsSchema.safeParse(payload);
    const oauth = parsed.success ? parsed.data.claudeAiOauth : undefined;
    if (!oauth?.accessToken) return null;
    return {
      sourceId,
      sourceKind,
      fingerprint: credentialFingerprint(raw ?? JSON.stringify(payload)),
      accessToken: oauth.accessToken,
      subscriptionType: oauth.subscriptionType,
      rateLimitTier: oauth.rateLimitTier,
      ...(watchPath ? { watchPath } : {}),
    };
  }

  private unavailable(sourceLabel?: string): ProviderUsage {
    const usage = unavailableUsage(this);
    if (sourceLabel) usage.sourceLabel = sourceLabel;
    if (this.target.iconProviderId !== this.providerId) {
      usage.iconProviderId = this.target.iconProviderId;
    }
    return usage;
  }

  private cached(options: {
    status: "unavailable" | "error";
    error?: string;
    preferredSourceId?: string;
    nextRetryAtMs?: number;
  }): ProviderUsage {
    return this.state.cachedUsage({
      providerId: this.providerId,
      displayName: this.displayName,
      ...(this.target.iconProviderId !== this.providerId
        ? { iconProviderId: this.target.iconProviderId }
        : {}),
      nowMs: this.now(),
      ...options,
    });
  }

  private async callClaudeApi(
    token: string,
  ): Promise<
    { kind: "available"; usage: ClaudeUsageResponse } | { kind: "needs_auth"; status: 401 | 403 }
  > {
    const res = await fetchProviderApi(this.fetchApi, CLAUDE_API_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "anthropic-beta": CLAUDE_OAUTH_BETA,
      },
    });
    if (res.status === 401 || res.status === 403) {
      return { kind: "needs_auth", status: res.status };
    }
    if (!res.ok) throw new Error(`Claude usage API returned ${res.status}`);
    return { kind: "available", usage: ClaudeUsageResponseSchema.parse(await res.json()) };
  }
}
