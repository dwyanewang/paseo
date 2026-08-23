import { once } from "node:events";
import { watch } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { ProviderUsage } from "../../../server/messages.js";

const LAST_GOOD_TTL_MS = 5 * 60 * 1000;
const AUTH_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;
const CREDENTIAL_CHANGE_WAIT_MS = 2_000;
const FILE_EVENT_DEBOUNCE_MS = 50;
const KEYCHAIN_REREAD_DELAYS_MS = [500, 750] as const;

export type ClaudeCredentialSourceKind = "env" | "file" | "keychain";
type WatcherEventResult = "event" | "timeout" | "error";

export interface ClaudeCredential {
  sourceId: string;
  sourceKind: ClaudeCredentialSourceKind;
  fingerprint: string;
  accessToken: string;
  subscriptionType?: string;
  rateLimitTier?: string;
  watchPath?: string;
}

interface LastGoodSnapshot {
  storedAtMs: number;
  usage: ProviderUsage;
}

interface AuthRetryState {
  fingerprint: string;
  failures: number;
  nextRetryAtMs: number;
}

interface CachedUsageOptions {
  providerId: string;
  displayName: string;
  iconProviderId?: string;
  nowMs: number;
  status: "unavailable" | "error";
  error?: string;
  preferredSourceId?: string;
  nextRetryAtMs?: number;
}

function cachedSourceLabel(sourceLabel: string | null | undefined): string | null {
  if (!sourceLabel) return null;
  return sourceLabel.endsWith(" (cached)") ? sourceLabel : `${sourceLabel} (cached)`;
}

function earliestIso(...timestamps: Array<number | undefined>): string | null {
  const finite = timestamps.filter(
    (timestamp): timestamp is number => typeof timestamp === "number" && Number.isFinite(timestamp),
  );
  return finite.length > 0 ? new Date(Math.min(...finite)).toISOString() : null;
}

function unavailableFromSnapshot(options: CachedUsageOptions): ProviderUsage {
  return {
    providerId: options.providerId,
    iconProviderId: options.iconProviderId,
    displayName: options.displayName,
    status: options.status,
    planLabel: null,
    windows: [],
    balances: [],
    details: [],
    error: options.error ?? null,
    nextRefreshAt: earliestIso(options.nextRetryAtMs),
  };
}

export class ClaudeUsageState {
  private readonly snapshots = new Map<string, LastGoodSnapshot>();
  private readonly latestSnapshotSource = new Map<string, string>();
  private readonly credentialWaits = new Map<string, Promise<ClaudeCredential | null>>();
  private readonly authRetries = new Map<string, AuthRetryState>();

  storeSuccess(sourceId: string, usage: ProviderUsage, nowMs: number): ProviderUsage {
    const nextRefreshAt = new Date(nowMs + LAST_GOOD_TTL_MS).toISOString();
    const fresh = { ...usage, nextRefreshAt };
    this.snapshots.set(`${usage.providerId}:${sourceId}`, {
      storedAtMs: nowMs,
      usage: fresh,
    });
    this.latestSnapshotSource.set(usage.providerId, sourceId);
    this.authRetries.delete(sourceId);
    return fresh;
  }

  cachedUsage(options: CachedUsageOptions): ProviderUsage {
    const sourceId =
      options.preferredSourceId ?? this.latestSnapshotSource.get(options.providerId) ?? null;
    const snapshot = sourceId ? this.snapshots.get(`${options.providerId}:${sourceId}`) : null;
    if (!snapshot) {
      return unavailableFromSnapshot(options);
    }

    const expiresAtMs = snapshot.storedAtMs + LAST_GOOD_TTL_MS;
    if (options.nowMs >= expiresAtMs) {
      return unavailableFromSnapshot({ ...options, status: "unavailable" });
    }

    return {
      ...snapshot.usage,
      sourceLabel: cachedSourceLabel(snapshot.usage.sourceLabel),
      nextRefreshAt: earliestIso(options.nextRetryAtMs, expiresAtMs),
    };
  }

  authRetryAt(credential: ClaudeCredential): number | null {
    const retry = this.authRetries.get(credential.sourceId);
    if (!retry) return null;
    if (retry.fingerprint !== credential.fingerprint) {
      this.authRetries.delete(credential.sourceId);
      return null;
    }
    return retry.nextRetryAtMs;
  }

  recordAuthFailure(credential: ClaudeCredential, nowMs: number): number {
    const previous = this.authRetries.get(credential.sourceId);
    const previousFailures =
      previous?.fingerprint === credential.fingerprint ? previous.failures : 0;
    const failures = previousFailures + 1;
    const delayIndex = Math.min(failures - 1, AUTH_RETRY_DELAYS_MS.length - 1);
    const nextRetryAtMs = nowMs + AUTH_RETRY_DELAYS_MS[delayIndex];
    this.authRetries.set(credential.sourceId, {
      fingerprint: credential.fingerprint,
      failures,
      nextRetryAtMs,
    });
    return nextRetryAtMs;
  }

  credentialChanged(sourceId: string): void {
    this.authRetries.delete(sourceId);
  }

  waitForCredentialChange(
    initial: ClaudeCredential,
    read: () => Promise<ClaudeCredential | null>,
  ): Promise<ClaudeCredential | null> {
    const existing = this.credentialWaits.get(initial.sourceId);
    if (existing) return existing;

    const wait = this.waitForCredentialChangeOnce(initial, read);
    this.credentialWaits.set(initial.sourceId, wait);
    const clear = () => {
      if (this.credentialWaits.get(initial.sourceId) === wait) {
        this.credentialWaits.delete(initial.sourceId);
      }
    };
    void wait.then(clear, clear);
    return wait;
  }

  private async waitForCredentialChangeOnce(
    initial: ClaudeCredential,
    read: () => Promise<ClaudeCredential | null>,
  ): Promise<ClaudeCredential | null> {
    const immediate = await read();
    if (immediate && immediate.fingerprint !== initial.fingerprint) {
      return immediate;
    }

    if (initial.sourceKind === "file" && initial.watchPath) {
      return await this.waitForFileCredentialChange(initial, read);
    }
    if (initial.sourceKind === "keychain") {
      return await this.waitForKeychainCredentialChange(initial, read);
    }
    return null;
  }

  private async waitForFileCredentialChange(
    initial: ClaudeCredential,
    read: () => Promise<ClaudeCredential | null>,
  ): Promise<ClaudeCredential | null> {
    const watchPath = initial.watchPath;
    if (!watchPath) return null;

    let watcher: ReturnType<typeof watch>;
    try {
      watcher = watch(watchPath);
    } catch {
      return null;
    }

    const deadlineMs = Date.now() + CREDENTIAL_CHANGE_WAIT_MS;
    try {
      while (Date.now() < deadlineMs) {
        const remainingMs = deadlineMs - Date.now();
        const event = await this.waitForWatcherEvent(watcher, remainingMs);
        if (event !== "event") return null;

        while (Date.now() < deadlineMs) {
          const quietPeriodMs = Math.min(
            FILE_EVENT_DEBOUNCE_MS,
            Math.max(0, deadlineMs - Date.now()),
          );
          if (quietPeriodMs === 0) return null;
          const debounceEvent = await this.waitForWatcherEvent(watcher, quietPeriodMs);
          if (debounceEvent === "timeout") break;
          if (debounceEvent === "error") return null;
        }
        let credential: ClaudeCredential | null;
        try {
          credential = await read();
        } catch {
          return null;
        }
        if (credential && credential.fingerprint !== initial.fingerprint) {
          return credential;
        }
      }
      return null;
    } finally {
      watcher.close();
    }
  }

  private async waitForWatcherEvent(
    watcher: ReturnType<typeof watch>,
    timeoutMs: number,
  ): Promise<WatcherEventResult> {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await once(watcher, "change", { signal: controller.signal });
      return "event";
    } catch (error) {
      return error instanceof Error && error.name === "AbortError" ? "timeout" : "error";
    } finally {
      clearTimeout(abortTimer);
    }
  }

  private async waitForKeychainCredentialChange(
    initial: ClaudeCredential,
    read: () => Promise<ClaudeCredential | null>,
  ): Promise<ClaudeCredential | null> {
    const deadlineMs = Date.now() + CREDENTIAL_CHANGE_WAIT_MS;
    for (const delayMs of KEYCHAIN_REREAD_DELAYS_MS) {
      const waitMs = Math.min(delayMs, Math.max(0, deadlineMs - Date.now()));
      if (waitMs === 0) return null;
      await delay(waitMs);
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) return null;
      const credential = await this.readBeforeDeadline(read, remainingMs);
      if (credential && credential.fingerprint !== initial.fingerprint) {
        return credential;
      }
    }
    return null;
  }

  private readBeforeDeadline(
    read: () => Promise<ClaudeCredential | null>,
    timeoutMs: number,
  ): Promise<ClaudeCredential | null> {
    const controller = new AbortController();
    const timeout = delay(timeoutMs, null, { signal: controller.signal }).catch(() => null);
    return Promise.race([read().catch(() => null), timeout]).finally(() => controller.abort());
  }
}
