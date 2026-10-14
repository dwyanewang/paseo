import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(
  new URL("../dwyanewang/dependency-install-state.mjs", import.meta.url),
);

function run(root, command, args) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C", LANGUAGE: "C" },
    timeout: 30_000,
  });
}

function writeJson(root, file, value) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-install-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeJson(root, "package.json", {
    name: "install-state-fixture",
    version: "1.0.0",
    private: true,
    workspaces: ["packages/protocol"],
  });
  writeJson(root, "packages/protocol/package.json", {
    name: "@getpaseo/protocol",
    version: "1.0.0",
    scripts: { build: "node build.mjs" },
  });
  writeFileSync(path.join(root, ".gitignore"), "node_modules/\n.dev/\n");
  assert.equal(run(root, "git", ["init", "-q"]).status, 0);
  const installed = run(root, "npm", ["install", "--offline", "--no-audit", "--no-fund"]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(run(root, "git", ["add", "."]).status, 0);
  return root;
}

function state(root, command) {
  return run(root, "node", [script, command, "--root", root]);
}

test("reuses a verified installation when only the audited benchmark command is added", (t) => {
  const root = fixture(t);
  assert.equal(state(root, "check").status, 3);
  const sentinel = path.join(root, "node_modules/native-cache/build/object.o");
  mkdirSync(path.dirname(sentinel), { recursive: true });
  writeFileSync(sentinel, "retained native cache");
  const recorded = state(root, "record");
  assert.equal(recorded.status, 0, recorded.stderr);
  const manifest = JSON.parse(readFileSync(path.join(root, "packages/protocol/package.json")));
  manifest.scripts["benchmark:hermes"] = "node scripts/benchmark-validation-hermes.mjs";
  writeJson(root, "packages/protocol/package.json", manifest);
  const checked = state(root, "check");
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
  assert.match(checked.stdout, /reuse/);
  assert.equal(readFileSync(sentinel, "utf8"), "retained native cache");
});

test("detects damaged regular packages, executables and hidden lock inventory", (t) => {
  const root = fixture(t);
  const source = path.join(root, "package-source");
  mkdirSync(source);
  writeJson(source, "package.json", {
    name: "example",
    version: "1.0.0",
    bin: { example: "cli.js" },
  });
  writeFileSync(path.join(source, "cli.js"), "#!/usr/bin/env node\n");
  const packed = run(source, "npm", ["pack", "--offline", "--json"]);
  assert.equal(packed.status, 0, packed.stderr);
  const archive = path.join(source, JSON.parse(packed.stdout)[0].filename);
  const archiveContents = readFileSync(archive);
  const installed = run(root, "npm", ["install", archive, "--offline", "--no-audit", "--no-fund"]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(run(root, "git", ["add", "package.json", "package-lock.json"]).status, 0);
  assert.equal(state(root, "record").status, 0);
  const manifest = JSON.parse(readFileSync(path.join(root, "node_modules/example/package.json")));
  writeJson(root, "node_modules/example/package.json", { ...manifest, version: "2.0.0" });
  assert.equal(state(root, "check").status, 3);
  writeJson(root, "node_modules/example/package.json", manifest);
  assert.equal(state(root, "check").status, 0);
  const executable = path.join(root, "node_modules/example/cli.js");
  rmSync(executable);
  assert.equal(state(root, "check").status, 3);
  writeFileSync(executable, "#!/usr/bin/env node\n");
  const link = path.join(root, "node_modules/.bin/example");
  rmSync(link);
  symlinkSync(path.join(root, "node_modules/example/package.json"), link);
  assert.equal(state(root, "check").status, 3);
  rmSync(link);
  symlinkSync(executable, link);
  const hidden = JSON.parse(readFileSync(path.join(root, "node_modules/.package-lock.json")));
  const integrity = hidden.packages["node_modules/example"].integrity;
  hidden.packages["node_modules/example"].integrity = "damaged";
  writeJson(root, "node_modules/.package-lock.json", hidden);
  assert.equal(state(root, "check").status, 3);
  hidden.packages["node_modules/example"].integrity = integrity;
  writeJson(root, "node_modules/.package-lock.json", hidden);
  assert.equal(state(root, "check").status, 0);
  writeFileSync(archive, "changed local dependency archive");
  assert.equal(state(root, "check").status, 3);
  const external = mkdtempSync(path.join(tmpdir(), "paseo-install-external-archive-"));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  const externalArchive = path.join(external, "example.tgz");
  writeFileSync(externalArchive, archiveContents);
  rmSync(archive);
  symlinkSync(externalArchive, archive);
  assert.equal(state(root, "check").status, 3);
});

test("reinstalls for dependency, lifecycle, unknown script and metadata changes", (t) => {
  const root = fixture(t);
  const file = "packages/protocol/package.json";
  const original = JSON.parse(readFileSync(path.join(root, file)));
  assert.equal(state(root, "record").status, 0);
  for (const change of [
    { dependencies: { example: "1.0.0" } },
    { scripts: { postinstall: "node setup.mjs" } },
    { scripts: { "benchmark:hermes": "node different.mjs" } },
    { scripts: { build: "node changed-build.mjs" } },
    { version: "2.0.0" },
    { bin: "cli.js" },
    { customUnknownField: true },
  ]) {
    writeJson(root, file, { ...original, ...change });
    assert.equal(state(root, "check").status, 3, JSON.stringify(change));
  }
  writeJson(root, file, original);
  assert.equal(state(root, "check").status, 0);
});

test("unknown hooks keep script bodies and ordinary commands in the installation inputs", (t) => {
  const root = fixture(t);
  const file = "packages/protocol/package.json";
  const manifest = JSON.parse(readFileSync(path.join(root, file)));
  manifest.scripts.postinstall = "node setup.mjs";
  writeJson(root, file, manifest);
  writeFileSync(path.join(root, "packages/protocol/setup.mjs"), "// setup\n");
  assert.equal(run(root, "git", ["add", "."]).status, 0);
  assert.equal(state(root, "record").status, 0);
  writeFileSync(path.join(root, "packages/protocol/setup.mjs"), "// changed setup\n");
  assert.equal(state(root, "check").status, 3);
  writeFileSync(path.join(root, "packages/protocol/setup.mjs"), "// setup\n");
  manifest.scripts["benchmark:hermes"] = "node scripts/benchmark-validation-hermes.mjs";
  writeJson(root, file, manifest);
  assert.equal(state(root, "check").status, 3);
});

test("formatting does not reinstall, while npm options and lock changes do", (t) => {
  const root = fixture(t);
  assert.equal(state(root, "record").status, 0);
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json")));
  writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
  assert.equal(state(root, "check").status, 0);
  writeFileSync(path.join(root, ".npmrc"), "ignore-scripts=true\n");
  assert.equal(state(root, "check").status, 3);
  rmSync(path.join(root, ".npmrc"));
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json")));
  lock.packages[""].version = "2.0.0";
  writeJson(root, "package-lock.json", lock);
  assert.equal(state(root, "check").status, 3);
});

test("missing or retargeted workspace links cannot reuse the installation", (t) => {
  const root = fixture(t);
  assert.equal(state(root, "record").status, 0);
  const link = path.join(root, "node_modules/@getpaseo/protocol");
  rmSync(link);
  assert.equal(state(root, "check").status, 3);
  symlinkSync(path.join(root, "packages"), link);
  assert.equal(state(root, "check").status, 3);
  rmSync(link);
  const workspace = path.join(root, "packages/protocol");
  symlinkSync(workspace, link);
  const external = mkdtempSync(path.join(tmpdir(), "paseo-install-external-workspace-"));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  writeFileSync(
    path.join(external, "package.json"),
    readFileSync(path.join(workspace, "package.json")),
  );
  rmSync(workspace, { recursive: true, force: true });
  symlinkSync(external, workspace);
  assert.equal(state(root, "check").status, 3);
});

test("invalidation before a failed install leaves no reusable receipt", (t) => {
  const root = fixture(t);
  assert.equal(state(root, "record").status, 0);
  assert.equal(state(root, "invalidate").status, 0);
  rmSync(path.join(root, "node_modules/.package-lock.json"));
  assert.equal(state(root, "record").status, 1);
  assert.equal(existsSync(path.join(root, ".dev/build-paseo-install.json")), false);
  assert.equal(state(root, "check").status, 3);
});
