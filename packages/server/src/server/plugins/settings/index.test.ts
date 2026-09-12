import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { PluginSettingsStore } from "./index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const definition = defineSettings({
  id: "display",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(true),
    count: z.number().int().min(1).default(5),
  }),
});
async function setup(options?: { watchdogMs?: number; onPoisoned?: (message: string) => void }) {
  const directory = await mkdtemp(path.join(tmpdir(), "plugin-settings-"));
  roots.push(directory);
  const changes: string[] = [];
  const store = new PluginSettingsStore(
    directory,
    (id) => changes.push(id),
    options?.watchdogMs,
    options?.onPoisoned,
  );
  return { directory, changes, store, handlers: store.register(definition) };
}

test("defaults, atomic saves, concurrent revisions, and restart persistence", async () => {
  const { directory, changes, handlers } = await setup();
  expect(await handlers.read.handle()).toEqual({
    status: "ready",
    revision: "missing",
    values: { enabled: true, count: 5 },
  });
  const outcomes = await Promise.all([
    handlers.write.handle({ revision: "missing", values: { enabled: false, count: 10 } }),
    handlers.write.handle({ revision: "missing", values: { enabled: true, count: 20 } }),
  ]);
  expect(outcomes.map((result) => result.status)).toEqual(["saved", "conflict"]);
  const reopened = new PluginSettingsStore(directory, () => {}).register(definition);
  expect(await reopened.read.handle()).toMatchObject({
    status: "ready",
    values: { enabled: false, count: 10 },
  });
  expect(changes).toEqual(["display"]);
});

test("validation failure preserves disk and leaves the writer usable", async () => {
  const { handlers, changes } = await setup();
  expect(await handlers.write.handle({ revision: "missing", values: { count: -1 } })).toMatchObject(
    { status: "invalid" },
  );
  expect(await handlers.read.handle()).toMatchObject({ revision: "missing" });
  expect(changes).toEqual([]);
  expect(await handlers.write.handle({ revision: "missing", values: { count: 2 } })).toMatchObject({
    status: "saved",
    values: { enabled: true, count: 2 },
  });
});

test("migrates once, persists the validated version, and rejects old clients", async () => {
  const { directory, handlers } = await setup();
  const saved = await handlers.write.handle({ revision: "missing", values: { count: 7 } });
  if (saved.status !== "saved") throw new Error("save failed");
  let migrations = 0;
  const upgraded = new PluginSettingsStore(directory, () => {}).register({
    ...definition,
    version: 2,
    schema: z.object({ total: z.number().default(0) }),
    migrate(values, version) {
      migrations++;
      expect(version).toBe(1);
      return { total: z.object({ count: z.number() }).parse(values).count };
    },
  });
  expect(await upgraded.read.handle()).toMatchObject({ status: "ready", values: { total: 7 } });
  await upgraded.read.handle();
  expect(migrations).toBe(1);
  expect(
    await handlers.write.handle({ revision: saved.revision, values: { count: 9 } }),
  ).toMatchObject({ status: "conflict" });
  const newer = await handlers.read.handle();
  expect(newer).toMatchObject({
    status: "invalid",
    error: "Stored settings are invalid. Reset them explicitly to recover.",
  });
  expect(
    await handlers.write.handle({ revision: newer.revision, values: { count: 9 } }),
  ).toMatchObject({ status: "invalid" });
  expect(await upgraded.read.handle()).toMatchObject({ values: { total: 7 } });
});

test("failed migrations and corrupt data survive reads until an explicit reset", async () => {
  const { directory, handlers } = await setup();
  await handlers.write.handle({ revision: "missing", values: { count: 7 } });
  const file = path.join(directory, "display.json");
  const before = await readFile(file, "utf8");
  const upgraded = new PluginSettingsStore(directory, () => {}).register({
    ...definition,
    version: 2,
    migrate() {
      throw new Error("migration failed");
    },
  });
  expect(await upgraded.read.handle()).toMatchObject({
    status: "invalid",
    error: "Settings migration failed. The stored document was preserved.",
  });
  expect(await readFile(file, "utf8")).toBe(before);
  await writeFile(file, "broken JSON");
  const invalid = await handlers.read.handle();
  expect(invalid.status).toBe("invalid");
  expect(await readFile(file, "utf8")).toBe("broken JSON");
  expect(await handlers.reset.handle({ revision: invalid.revision })).toMatchObject({
    status: "saved",
    values: { enabled: true, count: 5 },
  });
});

test("installation namespaces and definition IDs remain separate", async () => {
  const first = await setup();
  const second = await setup();
  await first.handlers.write.handle({ revision: "missing", values: { enabled: false } });
  expect(await second.handlers.read.handle()).toMatchObject({ values: { enabled: true } });
  const store = new PluginSettingsStore(first.directory, () => {});
  store.register(definition);
  expect(() => store.register(definition)).toThrow("Duplicate settings");
  expect(() => store.register({ ...definition, id: "../escape" })).toThrow("Invalid settings ID");
});

test("document reads defaults and reports invalid storage with stable safe errors", async () => {
  const { directory, handlers } = await setup();
  expect(await handlers.document.read()).toEqual({
    status: "ready",
    snapshot: { revision: "missing", values: { enabled: true, count: 5 } },
  });
  await writeFile(path.join(directory, "display.json"), '{"secret":"do-not-echo"}');
  expect(await handlers.document.read()).toEqual({
    status: "invalid",
    revision: expect.any(String),
    error: {
      code: "stored_invalid",
      message: "Stored settings are invalid. Reset them explicitly to recover.",
    },
  });
});

test("document updates serialize and unchanged does not write or invalidate", async () => {
  const { changes, handlers } = await setup();
  const observations: number[] = [];
  const first = handlers.document.update((current) => {
    observations.push(current.count);
    return { status: "commit", values: { ...current, count: 6 }, result: "first" };
  });
  const second = handlers.document.update((current) => {
    observations.push(current.count);
    return { status: "commit", values: { ...current, count: 7 }, result: "second" };
  });
  expect(await first).toMatchObject({ status: "saved", result: "first" });
  expect(await second).toMatchObject({ status: "saved", result: "second" });
  const unchanged = await handlers.document.update((current) => ({
    status: "unchanged",
    result: current.count,
  }));
  expect(unchanged).toMatchObject({ status: "unchanged", result: 7 });
  expect(observations).toEqual([5, 6]);
  expect(changes).toEqual(["display", "display"]);
});

test("migration and mutation persist once, including migration plus unchanged", async () => {
  const first = await setup();
  await first.handlers.write.handle({ revision: "missing", values: { count: 7 } });
  const changed: string[] = [];
  const upgradedStore = new PluginSettingsStore(first.directory, (id) => changed.push(id));
  const upgraded = upgradedStore.register({
    ...definition,
    version: 2,
    schema: z.object({ enabled: z.boolean().default(true), count: z.number().int() }),
    migrate(values) {
      return values;
    },
  });
  expect(
    await upgraded.document.update((current) => ({
      status: "commit",
      values: { ...current, count: current.count + 1 },
      result: null,
    })),
  ).toMatchObject({ status: "saved", snapshot: { values: { count: 8 } } });
  expect(changed).toEqual(["display"]);

  const thirdVersionChanges: string[] = [];
  const thirdVersion = new PluginSettingsStore(first.directory, (id) =>
    thirdVersionChanges.push(id),
  ).register({
    ...definition,
    version: 3,
    migrate(values) {
      return values;
    },
  });
  expect(
    await thirdVersion.document.update((current) => ({
      status: "unchanged",
      result: current.count,
    })),
  ).toMatchObject({ status: "saved", result: 8 });
  expect(thirdVersionChanges).toEqual(["display"]);
});

test("client CAS is checked after a queued server migration update", async () => {
  const first = await setup();
  const saved = await first.handlers.write.handle({ revision: "missing", values: { count: 5 } });
  if (saved.status !== "saved") throw new Error("save failed");
  let releaseMigration!: () => void;
  const migrationGate = new Promise<void>((resolve) => {
    releaseMigration = resolve;
  });
  const store = new PluginSettingsStore(first.directory, () => {});
  const upgraded = store.register({
    ...definition,
    version: 2,
    async migrate(values) {
      await migrationGate;
      return values;
    },
  });
  const serverUpdate = upgraded.document.update((current) => ({
    status: "commit",
    values: { ...current, count: 6 },
    result: null,
  }));
  const clientWrite = upgraded.write.handle({ revision: saved.revision, values: { count: 9 } });
  releaseMigration();
  expect(await serverUpdate).toMatchObject({ status: "saved" });
  expect(await clientWrite).toMatchObject({ status: "conflict" });
  expect(await upgraded.document.read()).toMatchObject({ snapshot: { values: { count: 6 } } });
});

test("mutator input is deeply detached and frozen", async () => {
  const nestedDefinition = defineSettings({
    id: "nested",
    scope: "host",
    version: 1,
    schema: z.object({ nested: z.object({ value: z.number() }).default({ value: 1 }) }),
  });
  const { store } = await setup();
  const nested = store.register(nestedDefinition);
  const result = await nested.document.update((current) => {
    expect(Object.isFrozen(current)).toBe(true);
    expect(Object.isFrozen(current.nested)).toBe(true);
    (current.nested as { value: number }).value = 9;
    return { status: "unchanged", result: null };
  });
  expect(result).toMatchObject({ status: "invalid", error: { code: "mutator_threw" } });
  expect(await nested.document.read()).toMatchObject({
    snapshot: { values: { nested: { value: 1 } } },
  });
});

test("thenables, reentry, throws, and invalid next values do not commit and leave queue usable", async () => {
  const { changes, handlers } = await setup();
  expect(
    await handlers.document.update((() =>
      Promise.resolve({ status: "unchanged", result: null })) as never),
  ).toMatchObject({ status: "invalid", error: { code: "thenable_returned" } });

  let nestedResult: unknown;
  expect(
    await handlers.document.update((current) => {
      void handlers.document.read().then((result) => {
        nestedResult = result;
        return null;
      });
      return { status: "commit", values: { ...current, count: 8 }, result: null };
    }),
  ).toMatchObject({ status: "invalid", error: { code: "reentrant_access" } });
  await Promise.resolve();
  expect(nestedResult).toMatchObject({ status: "invalid", error: { code: "reentrant_access" } });

  expect(
    await handlers.document.update(() => {
      throw new Error("secret value");
    }),
  ).toMatchObject({ status: "invalid", error: { code: "mutator_threw" } });
  expect(
    await handlers.document.update(() => ({
      status: "commit",
      values: { enabled: true, count: 0 },
      result: null,
    })),
  ).toMatchObject({ status: "invalid", error: { code: "next_invalid" } });
  expect(changes).toEqual([]);
  expect(
    await handlers.document.update((current) => ({
      status: "commit",
      values: { ...current, count: 6 },
      result: null,
    })),
  ).toMatchObject({ status: "saved", snapshot: { values: { count: 6 } } });
});

test("watchdog poisons callers without releasing the blocked queue item", async () => {
  const poisoned: string[] = [];
  const { directory } = await setup();
  await writeFile(
    path.join(directory, "display.json"),
    JSON.stringify({ version: 1, values: { count: 5 } }),
  );
  const never = new Promise<never>(() => undefined);
  const store = new PluginSettingsStore(
    directory,
    () => {},
    5,
    (message) => poisoned.push(message),
  );
  const handlers = store.register({
    ...definition,
    version: 2,
    migrate: () => never,
  });
  expect(await handlers.document.read()).toMatchObject({
    status: "invalid",
    error: { code: "store_poisoned" },
  });
  expect(
    await handlers.document.update(() => ({ status: "unchanged", result: null })),
  ).toMatchObject({ status: "invalid", error: { code: "store_poisoned" } });
  expect(poisoned).toEqual(["Settings access is unavailable until the plugin is reloaded."]);
});
