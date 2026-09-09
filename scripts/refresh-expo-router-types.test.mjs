import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helper = path.join(repoRoot, "dwyanewang", "refresh-expo-router-types.mjs");

test("regenerates Expo Router declarations from the selected product tree", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "paseo-expo-router-types-"));
  try {
    const appRoot = path.join(fixtureRoot, "packages", "app");
    const routeRoot = path.join(
      appRoot,
      "src",
      "app",
      "settings",
      "hosts",
      "[serverId]",
      "plugins",
      "[pluginId]",
    );
    const typesRoot = path.join(appRoot, ".expo", "types");
    mkdirSync(routeRoot, { recursive: true });
    mkdirSync(typesRoot, { recursive: true });
    writeFileSync(path.join(appRoot, "package.json"), '{"name":"router-fixture"}\n');
    writeFileSync(path.join(appRoot, "src", "app", "index.tsx"), "export default null;\n");
    writeFileSync(path.join(routeRoot, "[screenId].tsx"), "export default null;\n");
    writeFileSync(path.join(typesRoot, "router.d.ts"), "stale declaration\n");
    symlinkSync(path.join(repoRoot, "node_modules"), path.join(fixtureRoot, "node_modules"), "dir");

    const result = spawnSync(process.execPath, [helper, "--root", fixtureRoot], {
      encoding: "utf8",
      timeout: 10_000,
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Expo Router types: refreshed/);
    const declaration = readFileSync(path.join(typesRoot, "router.d.ts"), "utf8");
    assert.doesNotMatch(declaration, /stale declaration/);
    assert.match(
      declaration,
      /\/settings\/hosts\/\[serverId\]\/plugins\/\[pluginId\]\/\[screenId\]/,
    );
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});
