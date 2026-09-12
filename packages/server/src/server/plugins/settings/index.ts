import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defineSettings,
  type DeepReadonly,
  type PluginSettingsDecision,
  type PluginSettingsDocument,
  type PluginSettingsError,
  type PluginSettingsReadResult,
  type PluginSettingsUpdateResult,
  type SettingsDefinition,
  settingsRpc,
} from "@getpaseo/plugin";
import { z, type ZodType } from "zod";

const envelopeSchema = z.object({ version: z.number().int().positive(), values: z.json() });
const DEFAULT_WATCHDOG_MS = 30_000;

interface StoredSettings {
  raw: string | null;
  revision: string;
}

interface LoadedSettings<Values> {
  stored: StoredSettings;
  values: Values;
  migrated: boolean;
}

interface LoadFailure {
  stored: StoredSettings;
  error: PluginSettingsError;
}

interface ActiveMutation {
  reentryDetected: boolean;
}

function safeMessage(code: PluginSettingsError["code"]): string {
  switch (code) {
    case "stored_invalid":
      return "Stored settings are invalid. Reset them explicitly to recover.";
    case "migration_failed":
      return "Settings migration failed. The stored document was preserved.";
    case "mutator_threw":
      return "The settings update failed before any values were saved.";
    case "thenable_returned":
      return "Settings mutators must return synchronously.";
    case "reentrant_access":
      return "A settings mutator cannot access the same document recursively.";
    case "next_invalid":
      return "The updated settings document is invalid.";
    case "store_poisoned":
      return "Settings access is unavailable until the plugin is reloaded.";
  }
}

function pluginError(code: PluginSettingsError["code"]): PluginSettingsError {
  return { code, message: safeMessage(code) };
}

function revisionOf(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof Reflect.get(value, "then") === "function"
  );
}

function deepFreeze<Value>(value: Value): DeepReadonly<Value> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<Value>;
}

function detachedReadonly<Value>(value: Value): DeepReadonly<Value> {
  return deepFreeze(JSON.parse(JSON.stringify(value)) as Value);
}

/** One instance per installation. The subprocess lifetime gives writes a single owner. */
export class PluginSettingsStore {
  private readonly directory: string;
  private readonly changed: (id: string) => void;
  private readonly watchdogMs: number;
  private readonly onPoisoned: (message: string) => void;
  private readonly definitions = new Map<string, SettingsDefinition>();
  private readonly activeMutations = new Map<string, ActiveMutation>();
  private queue: Promise<unknown> = Promise.resolve();
  private poisoned = false;
  private poisonWaiters = new Set<() => void>();

  constructor(
    directory: string,
    changed: (id: string) => void,
    watchdogMs = DEFAULT_WATCHDOG_MS,
    onPoisoned: (message: string) => void = () => undefined,
  ) {
    this.directory = directory;
    this.changed = changed;
    this.watchdogMs = watchdogMs;
    this.onPoisoned = onPoisoned;
  }

  register<Schema extends ZodType>(definition: SettingsDefinition<Schema>) {
    defineSettings(definition);
    if (this.definitions.has(definition.id)) {
      throw new Error(`Duplicate settings: ${definition.id}`);
    }
    this.definitions.set(definition.id, definition);
    const rpc = settingsRpc(definition.id);
    const document = this.createDocument(definition);
    return {
      document,
      read: {
        contract: rpc.read,
        handle: () =>
          this.serial(async () => {
            const result = await this.readDocument(definition);
            return result.status === "ready"
              ? {
                  status: "ready" as const,
                  revision: result.snapshot.revision,
                  values: result.snapshot.values,
                }
              : {
                  status: "invalid" as const,
                  revision: result.revision,
                  error: result.error.message,
                };
          }),
      },
      write: {
        contract: rpc.write,
        handle: (input: z.output<typeof rpc.write.input>) =>
          this.serial(() => this.write(definition, input.revision, input.values, "save")),
      },
      reset: {
        contract: rpc.reset,
        handle: (input: z.output<typeof rpc.reset.input>) =>
          this.serial(() => this.write(definition, input.revision, {}, "reset")),
      },
    };
  }

  private createDocument<Schema extends ZodType>(
    definition: SettingsDefinition<Schema>,
  ): PluginSettingsDocument<Schema> {
    return {
      read: () => {
        if (this.markReentry(definition.id)) {
          return Promise.resolve({
            status: "invalid",
            revision: "unknown",
            error: pluginError("reentrant_access"),
          });
        }
        if (this.poisoned) return Promise.resolve(this.poisonedRead());
        return this.serial(() => this.readDocument(definition)).catch(() => this.poisonedRead());
      },
      update: <Result>(
        mutate: (
          current: DeepReadonly<z.output<Schema>>,
        ) => PluginSettingsDecision<z.input<Schema>, Result>,
      ) => {
        if (this.markReentry(definition.id)) {
          return Promise.resolve({
            status: "invalid",
            revision: "unknown",
            error: pluginError("reentrant_access"),
          });
        }
        if (this.poisoned) {
          return Promise.resolve(this.poisonedUpdate<z.output<Schema>, Result>());
        }
        return this.serial(() => this.updateDocument(definition, mutate)).catch(() =>
          this.poisonedUpdate<z.output<Schema>, Result>(),
        );
      },
    };
  }

  private markReentry(id: string): boolean {
    const active = this.activeMutations.get(id);
    if (!active) return false;
    active.reentryDetected = true;
    return true;
  }

  private poisonedRead<Values>(): PluginSettingsReadResult<Values> {
    return { status: "invalid", revision: "unknown", error: pluginError("store_poisoned") };
  }

  private poisonedUpdate<Values, Result>(): PluginSettingsUpdateResult<Values, Result> {
    return { status: "invalid", revision: "unknown", error: pluginError("store_poisoned") };
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    if (this.poisoned) return Promise.reject(new Error(safeMessage("store_poisoned")));
    const guardedWork = async () => {
      if (this.poisoned) throw new Error(safeMessage("store_poisoned"));
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const pending = work();
      if (this.watchdogMs > 0) watchdog = setTimeout(() => this.poison(), this.watchdogMs);
      try {
        return await pending;
      } finally {
        if (watchdog) clearTimeout(watchdog);
      }
    };
    const pending = this.queue.then(guardedWork);
    this.queue = pending.catch(() => undefined);
    const poison = new Promise<never>((_resolve, reject) => {
      const waiter = () => reject(new Error(safeMessage("store_poisoned")));
      this.poisonWaiters.add(waiter);
      void pending.finally(() => this.poisonWaiters.delete(waiter)).catch(() => undefined);
    });
    return Promise.race([pending, poison]);
  }

  private poison(): void {
    if (this.poisoned) return;
    this.poisoned = true;
    this.onPoisoned(safeMessage("store_poisoned"));
    for (const reject of this.poisonWaiters) reject();
    this.poisonWaiters.clear();
  }

  private async stored(id: string): Promise<StoredSettings> {
    try {
      const raw = await readFile(path.join(this.directory, `${id}.json`), "utf8");
      return { raw, revision: revisionOf(raw) };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { raw: null, revision: "missing" };
      }
      throw error;
    }
  }

  private async load<Schema extends ZodType>(
    definition: SettingsDefinition<Schema>,
  ): Promise<LoadedSettings<z.output<Schema>> | LoadFailure> {
    const stored = await this.stored(definition.id);
    let envelope: z.output<typeof envelopeSchema> | null;
    try {
      envelope = stored.raw === null ? null : envelopeSchema.parse(JSON.parse(stored.raw));
    } catch {
      return { stored, error: pluginError("stored_invalid") };
    }
    let values: unknown = envelope?.values ?? {};
    const migrated = envelope !== null && envelope.version !== definition.version;
    if (migrated && envelope) {
      if (envelope.version > definition.version || !definition.migrate) {
        return { stored, error: pluginError("stored_invalid") };
      }
      try {
        values = await definition.migrate(values, envelope.version);
      } catch {
        return { stored, error: pluginError("migration_failed") };
      }
    }
    try {
      const parsed = z.json().parse(await definition.schema.parseAsync(values));
      return { stored, values: parsed as z.output<Schema>, migrated };
    } catch {
      return { stored, error: pluginError(migrated ? "migration_failed" : "stored_invalid") };
    }
  }

  private async readDocument<Schema extends ZodType>(
    definition: SettingsDefinition<Schema>,
  ): Promise<PluginSettingsReadResult<z.output<Schema>>> {
    const loaded = await this.load(definition);
    if ("error" in loaded) {
      return { status: "invalid", revision: loaded.stored.revision, error: loaded.error };
    }
    const revision = loaded.migrated
      ? await this.persist(definition, loaded.values)
      : loaded.stored.revision;
    return { status: "ready", snapshot: { values: loaded.values, revision } };
  }

  private async updateDocument<Schema extends ZodType, Result>(
    definition: SettingsDefinition<Schema>,
    mutate: (
      current: DeepReadonly<z.output<Schema>>,
    ) => PluginSettingsDecision<z.input<Schema>, Result>,
  ): Promise<PluginSettingsUpdateResult<z.output<Schema>, Result>> {
    const loaded = await this.load(definition);
    if ("error" in loaded) {
      return { status: "invalid", revision: loaded.stored.revision, error: loaded.error };
    }
    const active: ActiveMutation = { reentryDetected: false };
    this.activeMutations.set(definition.id, active);
    let decision: PluginSettingsDecision<z.input<Schema>, Result>;
    try {
      decision = mutate(detachedReadonly(loaded.values));
    } catch {
      return {
        status: "invalid",
        revision: loaded.stored.revision,
        error: pluginError("mutator_threw"),
      };
    } finally {
      this.activeMutations.delete(definition.id);
    }
    if (active.reentryDetected) {
      return {
        status: "invalid",
        revision: loaded.stored.revision,
        error: pluginError("reentrant_access"),
      };
    }
    if (isThenable(decision)) {
      return {
        status: "invalid",
        revision: loaded.stored.revision,
        error: pluginError("thenable_returned"),
      };
    }
    if (decision.status === "unchanged") {
      if (!loaded.migrated) {
        return {
          status: "unchanged",
          snapshot: { values: loaded.values, revision: loaded.stored.revision },
          result: decision.result,
        };
      }
      const revision = await this.persist(definition, loaded.values);
      return {
        status: "saved",
        snapshot: { values: loaded.values, revision },
        result: decision.result,
      };
    }
    let values: z.output<Schema>;
    try {
      values = z
        .json()
        .parse(await definition.schema.parseAsync(decision.values)) as z.output<Schema>;
    } catch {
      return {
        status: "invalid",
        revision: loaded.stored.revision,
        error: pluginError("next_invalid"),
      };
    }
    const revision = await this.persist(definition, values);
    return { status: "saved", snapshot: { values, revision }, result: decision.result };
  }

  private async write(
    definition: SettingsDefinition,
    revision: string,
    values: unknown,
    intent: "save" | "reset",
  ): Promise<z.output<ReturnType<typeof settingsRpc>["write"]["output"]>> {
    const stored = await this.stored(definition.id);
    if (stored.revision !== revision) {
      return {
        status: "conflict",
        error: "Settings changed on another client. Reload before saving again.",
      };
    }
    let parsed: z.output<ReturnType<typeof z.json>>;
    try {
      if (intent === "save" && stored.raw !== null) {
        const envelope = envelopeSchema.parse(JSON.parse(stored.raw));
        if (envelope.version !== definition.version) throw new Error("schema version changed");
      }
      parsed = z.json().parse(await definition.schema.parseAsync(values));
    } catch {
      return { status: "invalid", error: "Settings values are invalid." };
    }
    return { status: "saved", values: parsed, revision: await this.persist(definition, parsed) };
  }

  private async persist(definition: SettingsDefinition, values: unknown): Promise<string> {
    await mkdir(this.directory, { recursive: true });
    const target = path.join(this.directory, `${definition.id}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const raw = JSON.stringify({ version: definition.version, values });
    try {
      await writeFile(temporary, raw, { mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    this.changed(definition.id);
    return revisionOf(raw);
  }
}
