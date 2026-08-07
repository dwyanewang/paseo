import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "dwyanewang", "configure-android-build.sh");
const fixtures = [];

function createFixture(buildGradle) {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-configure-android-build-"));
  fixtures.push(root);

  const gradlePath = path.join(root, "packages/app/android/app/build.gradle");
  mkdirSync(path.dirname(gradlePath), { recursive: true });
  writeFileSync(gradlePath, buildGradle);

  for (const packagePath of [
    ["@expo", "cli"],
    ["@react-native", "gradle-plugin"],
  ]) {
    const target = path.join(root, "node_modules", ...packagePath);
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(path.join(repoRoot, "node_modules", ...packagePath), target, "dir");
  }

  return { gradlePath, root };
}

function run(root, ...args) {
  return spawnSync("bash", [script, "--build-root", root, ...args], {
    encoding: "utf8",
  });
}

try {
  const existing = createFixture(`react {
    bundleCommand = "export:embed"
    extraPackagerArgs = ["--max-workers", "2"]
}
`);
  let result = run(existing.root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /configured: Metro cache kept, workers=8/);
  assert.match(
    readFileSync(existing.gradlePath, "utf8"),
    /extraPackagerArgs = \["--reset-cache", "false", "--max-workers", "8"\]/,
  );

  result = run(existing.root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already configured/);

  const inserted = createFixture(`react {
    bundleCommand = "export:embed"
    // extraPackagerArgs = []
}
`);
  result = run(inserted.root, "--metro-workers", "6");
  assert.equal(result.status, 0, result.stderr);
  const insertedSource = readFileSync(inserted.gradlePath, "utf8");
  assert.match(
    insertedSource,
    /bundleCommand = "export:embed"\n    extraPackagerArgs = \["--reset-cache", "false", "--max-workers", "6"\]/,
  );
  assert.equal(insertedSource.match(/^\s*extraPackagerArgs\s*=/gm)?.length, 1);

  const invalidWorkers = createFixture(`react {
    bundleCommand = "export:embed"
}
`);
  result = run(invalidWorkers.root, "--metro-workers", "0");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be in 1\.\.32/);

  const ambiguous = createFixture(`react {
    bundleCommand = "export:embed"
    extraPackagerArgs = ["--max-workers", "2"]
    extraPackagerArgs = ["--max-workers", "3"]
}
`);
  result = run(ambiguous.root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected at most one active extraPackagerArgs assignment/);

  console.log("configure-android-build: 5 checks passed");
} finally {
  for (const fixture of fixtures) {
    rmSync(fixture, { recursive: true, force: true });
  }
}
