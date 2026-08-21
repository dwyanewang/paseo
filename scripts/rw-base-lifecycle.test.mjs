import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(cwd, command, args, env = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}

function git(cwd, ...args) {
  const result = run(cwd, "git", args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function createFixture({ retainedFeatureUsesSharedPath = false } = {}) {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "paseo-rw-base-lifecycle-"));
  const controlRoot = path.join(fixtureRoot, "control");
  const buildRoot = path.join(fixtureRoot, "build");
  const featureOneRoot = path.join(fixtureRoot, "feature-one");
  const featureTwoRoot = path.join(fixtureRoot, "feature-two");
  const originRoot = path.join(fixtureRoot, "origin.git");
  const upstreamRoot = path.join(fixtureRoot, "upstream.git");
  const binRoot = path.join(fixtureRoot, "bin");
  mkdirSync(controlRoot);
  mkdirSync(binRoot);

  git(controlRoot, "init", "-b", "main");
  git(controlRoot, "config", "user.name", "Test User");
  git(controlRoot, "config", "user.email", "test@example.com");
  writeFileSync(path.join(controlRoot, ".gitignore"), ".dev/\n");
  writeFileSync(path.join(controlRoot, "package.json"), '{"name":"fixture"}\n');
  writeFileSync(path.join(controlRoot, "shared.txt"), "seed\n");
  git(controlRoot, "add", ".gitignore", "package.json", "shared.txt");
  git(controlRoot, "commit", "-m", "seed");
  const initialMain = git(controlRoot, "rev-parse", "main");

  git(controlRoot, "switch", "-c", "feature/one");
  writeFileSync(path.join(controlRoot, "feature-one.txt"), "one\n");
  git(controlRoot, "add", "feature-one.txt");
  git(controlRoot, "commit", "-m", "feat: feature one");
  const featureOneHead = git(controlRoot, "rev-parse", "HEAD");

  git(controlRoot, "switch", "main");
  git(controlRoot, "switch", "-c", "feature/two");
  if (retainedFeatureUsesSharedPath) {
    writeFileSync(path.join(controlRoot, "shared.txt"), "feature two\n");
    git(controlRoot, "add", "shared.txt");
  } else {
    writeFileSync(path.join(controlRoot, "feature-two.txt"), "two\n");
    git(controlRoot, "add", "feature-two.txt");
  }
  git(controlRoot, "commit", "-m", "feat: feature two");
  const featureTwoHead = git(controlRoot, "rev-parse", "HEAD");
  git(controlRoot, "switch", "main");

  git(fixtureRoot, "clone", "--bare", controlRoot, upstreamRoot);
  git(fixtureRoot, "clone", "--bare", controlRoot, originRoot);
  git(controlRoot, "remote", "add", "upstream", upstreamRoot);
  git(controlRoot, "remote", "add", "origin", originRoot);
  git(controlRoot, "fetch", "upstream");
  git(controlRoot, "fetch", "origin");
  git(controlRoot, "branch", "rw-main", "main");
  git(controlRoot, "push", "origin", "rw-main:rw-main");
  git(controlRoot, "worktree", "add", buildRoot, "rw-main");
  git(controlRoot, "worktree", "add", featureOneRoot, "feature/one");
  git(controlRoot, "worktree", "add", featureTwoRoot, "feature/two");

  git(controlRoot, "switch", "-c", "chore/build-paseo");
  const controlsRoot = path.join(controlRoot, "dwyanewang");
  mkdirSync(controlsRoot);
  for (const scriptName of ["manage-rw-base.sh", "rebuild-rw-main.sh"]) {
    const target = path.join(controlsRoot, scriptName);
    copyFileSync(path.join(repoRoot, "dwyanewang", scriptName), target);
    chmodSync(target, 0o755);
  }
  writeFileSync(path.join(controlsRoot, "rw-main-branches.txt"), "# Empty overlays\n");
  git(controlRoot, "add", "dwyanewang");
  git(controlRoot, "commit", "-m", "chore: add rw-base controls");

  const npmPath = path.join(binRoot, "npm");
  writeFileSync(npmPath, "#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n");
  chmodSync(npmPath, 0o755);

  return {
    buildRoot,
    controlRoot,
    env: { PATH: `${binRoot}:${process.env.PATH}` },
    featureOneHead,
    featureTwoHead,
    fixtureRoot,
    initialMain,
    originRoot,
    script: path.join(controlsRoot, "manage-rw-base.sh"),
    upstreamRoot,
  };
}

function runManage(fixture, command, args = []) {
  return run(
    fixture.controlRoot,
    "bash",
    [fixture.script, "--build-root", fixture.buildRoot, "--push", command, ...args],
    fixture.env,
  );
}

function promoteBoth(fixture) {
  const result = runManage(fixture, "promote", [
    "--feature",
    "feature-one",
    "--branch",
    "feature/one",
    "--feature",
    "feature-two",
    "--branch",
    "feature/two",
  ]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function withFixture(options, callback) {
  const fixture = createFixture(options);
  try {
    callback(fixture);
  } finally {
    rmSync(fixture.fixtureRoot, { force: true, recursive: true });
  }
}

test("promotes multiple features and reconstructs traceable status", () => {
  withFixture({}, (fixture) => {
    promoteBoth(fixture);

    assert.equal(readFileSync(path.join(fixture.buildRoot, "feature-one.txt"), "utf8"), "one\n");
    assert.equal(readFileSync(path.join(fixture.buildRoot, "feature-two.txt"), "utf8"), "two\n");
    assert.equal(
      git(fixture.controlRoot, "rev-parse", "rw-base"),
      git(fixture.controlRoot, "rev-parse", "origin/rw-base"),
    );
    assert.equal(
      git(fixture.controlRoot, "rev-parse", "rw-main"),
      git(fixture.controlRoot, "rev-parse", "origin/rw-main"),
    );

    const status = runManage(fixture, "status");
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /feature-one\tactive\tsource=feature\/one@/);
    assert.match(status.stdout, /feature-two\tactive\tsource=feature\/two@/);
    assert.equal(
      git(
        fixture.controlRoot,
        "log",
        "--first-parent",
        "--format=%(trailers:key=Paseo-Base-Action,valueonly)",
        "rw-base",
      )
        .split("\n")
        .filter((value) => value === "promote").length,
      2,
    );
  });
});

test("maintains an active feature and rejects duplicate promotion", () => {
  withFixture({}, (fixture) => {
    promoteBoth(fixture);
    const maintenanceRoot = path.join(fixture.fixtureRoot, "maintenance-one");
    git(fixture.controlRoot, "branch", "maintenance/one", "rw-base");
    git(fixture.controlRoot, "worktree", "add", maintenanceRoot, "maintenance/one");
    writeFileSync(path.join(maintenanceRoot, "feature-one-fix.txt"), "fix\n");
    git(maintenanceRoot, "add", "feature-one-fix.txt");
    git(maintenanceRoot, "commit", "-m", "fix: maintain feature one");
    git(maintenanceRoot, "push", "-u", "origin", "maintenance/one");

    const maintained = runManage(fixture, "maintain", [
      "--feature",
      "feature-one",
      "--branch",
      "maintenance/one",
    ]);
    assert.equal(maintained.status, 0, `${maintained.stdout}\n${maintained.stderr}`);
    const status = runManage(fixture, "status");
    assert.match(status.stdout, /feature-one\tactive[^\n]*integrations=2/);
    assert.equal(
      readFileSync(path.join(fixture.buildRoot, "feature-one-fix.txt"), "utf8"),
      "fix\n",
    );

    const duplicate = runManage(fixture, "promote", [
      "--feature",
      "feature-one",
      "--branch",
      "feature/one",
    ]);
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /feature is already active/);
  });
});

test("merges a newer main into rw-base without reviewing persistent features", () => {
  withFixture({}, (fixture) => {
    promoteBoth(fixture);
    const updaterRoot = path.join(fixture.fixtureRoot, "upstream-updater");
    git(fixture.fixtureRoot, "clone", fixture.upstreamRoot, updaterRoot);
    git(updaterRoot, "config", "user.name", "Upstream User");
    git(updaterRoot, "config", "user.email", "upstream@example.com");
    writeFileSync(path.join(updaterRoot, "upstream.txt"), "new upstream\n");
    git(updaterRoot, "add", "upstream.txt");
    git(updaterRoot, "commit", "-m", "feat: advance upstream");
    git(updaterRoot, "push", "origin", "main");
    git(fixture.controlRoot, "fetch", "upstream");
    git(fixture.controlRoot, "branch", "-f", "main", "upstream/main");
    git(fixture.controlRoot, "push", "origin", "main:main");
    git(fixture.controlRoot, "fetch", "origin");

    const rebuilt = run(
      fixture.controlRoot,
      "bash",
      [
        path.join(fixture.controlRoot, "dwyanewang/rebuild-rw-main.sh"),
        "--build-root",
        fixture.buildRoot,
        "--push",
      ],
      fixture.env,
    );
    assert.equal(rebuilt.status, 0, `${rebuilt.stdout}\n${rebuilt.stderr}`);
    assert.equal(
      readFileSync(path.join(fixture.buildRoot, "upstream.txt"), "utf8"),
      "new upstream\n",
    );
    assert.equal(readFileSync(path.join(fixture.buildRoot, "feature-one.txt"), "utf8"), "one\n");
    assert.equal(readFileSync(path.join(fixture.buildRoot, "feature-two.txt"), "utf8"), "two\n");
    const status = runManage(fixture, "status");
    assert.match(status.stdout, /feature-one\tactive/);
    assert.match(status.stdout, /feature-two\tactive/);
  });
});

test("retires one feature by rebuilding from main and retained integrations", () => {
  withFixture({}, (fixture) => {
    promoteBoth(fixture);
    const result = runManage(fixture, "retire", [
      "--feature",
      "feature-one",
      "--replacement",
      "upstream#123",
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(path.join(fixture.buildRoot, "feature-one.txt")), false);
    assert.equal(readFileSync(path.join(fixture.buildRoot, "feature-two.txt"), "utf8"), "two\n");

    const status = runManage(fixture, "status");
    assert.match(status.stdout, /feature-one\tretired[^\n]*replacement=upstream#123/);
    assert.match(status.stdout, /feature-two\tactive/);
  });
});

test("preserves refs on retirement replay conflicts and supports abort", () => {
  withFixture({ retainedFeatureUsesSharedPath: true }, (fixture) => {
    promoteBoth(fixture);
    const baseBefore = git(fixture.controlRoot, "rev-parse", "rw-base");
    const targetBefore = git(fixture.controlRoot, "rev-parse", "rw-main");

    const updaterRoot = path.join(fixture.fixtureRoot, "upstream-updater");
    git(fixture.fixtureRoot, "clone", fixture.upstreamRoot, updaterRoot);
    git(updaterRoot, "config", "user.name", "Upstream User");
    git(updaterRoot, "config", "user.email", "upstream@example.com");
    writeFileSync(path.join(updaterRoot, "shared.txt"), "upstream\n");
    git(updaterRoot, "add", "shared.txt");
    git(updaterRoot, "commit", "-m", "refactor: replace shared behavior");
    git(updaterRoot, "push", "origin", "main");
    git(fixture.controlRoot, "fetch", "upstream");
    git(fixture.controlRoot, "branch", "-f", "main", "upstream/main");
    git(fixture.controlRoot, "push", "origin", "main:main");
    git(fixture.controlRoot, "fetch", "origin");

    const result = runManage(fixture, "retire", [
      "--feature",
      "feature-one",
      "--replacement",
      "upstream-refactor",
    ]);
    assert.equal(result.status, 5, `${result.stdout}\n${result.stderr}`);
    const match = result.stdout.match(/^PASEO_RW_BASE_OPERATION=(.+)$/m);
    assert.notEqual(match, null, result.stdout);
    const requestPath = match[1];
    assert.equal(existsSync(requestPath), true);
    assert.equal(git(fixture.controlRoot, "rev-parse", "rw-base"), baseBefore);
    assert.equal(git(fixture.controlRoot, "rev-parse", "rw-main"), targetBefore);

    const aborted = runManage(fixture, "abort", ["--operation", requestPath]);
    assert.equal(aborted.status, 0, `${aborted.stdout}\n${aborted.stderr}`);
    assert.equal(existsSync(requestPath), false);
    assert.equal(git(fixture.controlRoot, "rev-parse", "rw-base"), baseBefore);
    assert.equal(git(fixture.controlRoot, "rev-parse", "rw-main"), targetBefore);
  });
});

test("continues a retirement after the retained-feature conflict is resolved", () => {
  withFixture({ retainedFeatureUsesSharedPath: true }, (fixture) => {
    promoteBoth(fixture);
    const updaterRoot = path.join(fixture.fixtureRoot, "upstream-updater");
    git(fixture.fixtureRoot, "clone", fixture.upstreamRoot, updaterRoot);
    git(updaterRoot, "config", "user.name", "Upstream User");
    git(updaterRoot, "config", "user.email", "upstream@example.com");
    writeFileSync(path.join(updaterRoot, "shared.txt"), "upstream\n");
    git(updaterRoot, "add", "shared.txt");
    git(updaterRoot, "commit", "-m", "refactor: replace shared behavior");
    git(updaterRoot, "push", "origin", "main");
    git(fixture.controlRoot, "fetch", "upstream");
    git(fixture.controlRoot, "branch", "-f", "main", "upstream/main");
    git(fixture.controlRoot, "push", "origin", "main:main");
    git(fixture.controlRoot, "fetch", "origin");

    const result = runManage(fixture, "retire", [
      "--feature",
      "feature-one",
      "--replacement",
      "upstream-refactor",
    ]);
    assert.equal(result.status, 5, `${result.stdout}\n${result.stderr}`);
    const requestPath = result.stdout.match(/^PASEO_RW_BASE_OPERATION=(.+)$/m)?.[1];
    assert.notEqual(requestPath, undefined, result.stdout);
    const operationWorktree = path.join(path.dirname(requestPath), "worktree");
    writeFileSync(path.join(operationWorktree, "shared.txt"), "feature two\n");
    git(operationWorktree, "add", "shared.txt");

    const continued = runManage(fixture, "continue", ["--operation", requestPath]);
    assert.equal(continued.status, 0, `${continued.stdout}\n${continued.stderr}`);
    assert.equal(existsSync(requestPath), false);
    assert.equal(existsSync(path.join(fixture.buildRoot, "feature-one.txt")), false);
    assert.equal(readFileSync(path.join(fixture.buildRoot, "shared.txt"), "utf8"), "feature two\n");
    const status = runManage(fixture, "status");
    assert.match(status.stdout, /feature-one\tretired/);
    assert.match(status.stdout, /feature-two\tactive/);
  });
});
