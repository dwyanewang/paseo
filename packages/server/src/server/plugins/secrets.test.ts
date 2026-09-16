import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginSecretStore } from "./secrets.js";

const directories: string[] = [];

async function createStore() {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-secrets-"));
  directories.push(directory);
  return { directory, store: new PluginSecretStore(directory) };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("PluginSecretStore", () => {
  it("round-trips a value and reports absence as null", async () => {
    const { store } = await createStore();

    expect(await store.get("api-token")).toBeNull();
    expect(await store.has("api-token")).toBe(false);

    await store.set("api-token", "secret-value");

    expect(await store.get("api-token")).toBe("secret-value");
    expect(await store.has("api-token")).toBe(true);
  });

  it("writes owner-only so another account on the host cannot read the token", async () => {
    const { directory, store } = await createStore();

    await store.set("api-token", "secret-value");

    const mode = (await stat(path.join(directory, "secrets.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("lists key names without exposing values", async () => {
    const { store } = await createStore();

    await store.set("b-token", "second");
    await store.set("a-token", "first");

    expect(await store.keys()).toEqual(["a-token", "b-token"]);
  });

  it("removes a key", async () => {
    const { store } = await createStore();

    await store.set("api-token", "secret-value");
    await store.delete("api-token");

    expect(await store.get("api-token")).toBeNull();
    expect(await store.keys()).toEqual([]);
  });

  it("keeps concurrent writes to different keys", async () => {
    const { store } = await createStore();

    await Promise.all([store.set("first", "1"), store.set("second", "2"), store.set("third", "3")]);

    expect(await store.keys()).toEqual(["first", "second", "third"]);
  });

  it("rejects a key that is not a plain identifier", async () => {
    const { store } = await createStore();

    await expect(store.set("../escape", "x")).rejects.toThrow("Invalid plugin secret key");
    await expect(store.get("Token")).rejects.toThrow("Invalid plugin secret key");
  });

  it("treats an unreadable or corrupt file as empty instead of throwing", async () => {
    const { directory, store } = await createStore();
    await writeFile(path.join(directory, "secrets.json"), "{not json", "utf8");

    expect(await store.get("api-token")).toBeNull();

    await store.set("api-token", "recovered");
    expect(await store.get("api-token")).toBe("recovered");
  });

  it("leaves no temporary file behind", async () => {
    const { directory, store } = await createStore();

    await store.set("api-token", "secret-value");

    const raw = await readFile(path.join(directory, "secrets.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({ "api-token": "secret-value" });
  });
});
