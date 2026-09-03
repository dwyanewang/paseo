import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

vi.setConfig({ testTimeout: 15_000 });

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

function createFixture({
  featureOneAddsPatch = false,
  retainedFeatureUsesSharedPath = false,
} = {}) {
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
  writeFileSync(path.join(controlRoot, ".gitignore"), ".dev/\nnode_modules/\n");
  writeFileSync(path.join(controlRoot, "package.json"), '{"name":"fixture"}\n');
  writeFileSync(path.join(controlRoot, "shared.txt"), "seed\n");
  mkdirSync(path.join(controlRoot, "scripts"));
  writeFileSync(
    path.join(controlRoot, "scripts/postinstall-patches.mjs"),
    [
      "const patchedPackages = [",
      '  { cwd: ".", nodeModulesPath: "node_modules/example", patchPrefix: "example+" },',
      "];",
      "",
    ].join("\n"),
  );
  git(controlRoot, "add", ".gitignore", "package.json", "scripts", "shared.txt");
  git(controlRoot, "commit", "-m", "seed");
  const initialMain = git(controlRoot, "rev-parse", "main");

  git(controlRoot, "switch", "-c", "feature/one");
  writeFileSync(path.join(controlRoot, "feature-one.txt"), "one\n");
  if (featureOneAddsPatch) {
    mkdirSync(path.join(controlRoot, "patches"));
    writeFileSync(
      path.join(controlRoot, "patches/example+1.0.0.patch"),
      [
        "diff --git a/node_modules/example/android/build.gradle b/node_modules/example/android/build.gradle",
        "--- a/node_modules/example/android/build.gradle",
        "+++ b/node_modules/example/android/build.gradle",
        "@@ -1 +1 @@",
        "-ndkVersion = old",
        "+ndkVersion = new",
        "",
      ].join("\n"),
    );
  }
  git(controlRoot, "add", "feature-one.txt", ...(featureOneAddsPatch ? ["patches"] : []));
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
  for (const scriptName of [
    "build-paseo-state.sh",
    "manage-rw-base.sh",
    "prepare-patched-dependencies.mjs",
    "rebuild-rw-main.sh",
  ]) {
    const target = path.join(controlsRoot, scriptName);
    copyFileSync(path.join(repoRoot, "dwyanewang", scriptName), target);
    chmodSync(target, 0o755);
  }
  writeFileSync(path.join(controlsRoot, "rw-main-branches.txt"), "# Empty overlays\n");
  git(controlRoot, "add", "dwyanewang");
  git(controlRoot, "commit", "-m", "chore: add rw-base controls");

  const npmPath = path.join(binRoot, "npm");
  writeFileSync(
    npmPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ -f "patches/example+1.0.0.patch" ]]; then',
      '  mkdir -p "node_modules/example/android" "node_modules/example/src"',
      '  printf "ndkVersion = old\\n" >"node_modules/example/android/build.gradle"',
      '  printf "registry = old\\n" >"node_modules/example/src/web.ts"',
      '  patch --force --silent --strip=1 --input="patches/example+1.0.0.patch"',
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(npmPath, 0o755);

  const miseCallLog = path.join(fixtureRoot, "mise-calls.log");
  const misePath = path.join(binRoot, "mise");
  writeFileSync(
    misePath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "%s\\n" "$*" >>"$PASEO_TEST_MISE_CALL_LOG"',
      'case "${1:-}" in',
      "  install) : ;;",
      "  activate) : ;;",
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(misePath, 0o755);

  const chmodPath = path.join(binRoot, "chmod");
  writeFileSync(
    chmodPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ -n "${PASEO_TEST_FAIL_STATE_BASENAME:-}" && "$*" == *"$PASEO_TEST_FAIL_STATE_BASENAME.tmp."* ]]; then',
      "  exit 9",
      "fi",
      'exec /usr/bin/chmod "$@"',
      "",
    ].join("\n"),
  );
  chmodSync(chmodPath, 0o755);

  return {
    buildRoot,
    controlRoot,
    env: {
      PASEO_TEST_MISE_CALL_LOG: miseCallLog,
      PATH: `${binRoot}:${process.env.PATH}`,
    },
    featureOneHead,
    featureTwoHead,
    fixtureRoot,
    initialMain,
    lifecycleState: path.join(buildRoot, ".dev", "lifecycle-ready.env"),
    miseCallLog,
    originRoot,
    script: path.join(controlsRoot, "manage-rw-base.sh"),
    upstreamRoot,
  };
}

function advanceUpstreamWithoutFetching(fixture, label) {
  const updaterRoot = path.join(fixture.fixtureRoot, `upstream-${label}`);
  git(fixture.fixtureRoot, "clone", fixture.upstreamRoot, updaterRoot);
  git(updaterRoot, "config", "user.name", "Upstream User");
  git(updaterRoot, "config", "user.email", "upstream@example.com");
  writeFileSync(path.join(updaterRoot, `${label}.txt`), `${label}\n`);
  git(updaterRoot, "add", `${label}.txt`);
  git(updaterRoot, "commit", "-m", `feat: ${label}`);
  git(updaterRoot, "push", "origin", "main");
  return git(updaterRoot, "rev-parse", "HEAD");
}

function advanceMainWithConflictingPatchAndCreateFeature(fixture, { sameTarget = false } = {}) {
  const updaterRoot = path.join(fixture.fixtureRoot, "upstream-patch-updater");
  git(fixture.fixtureRoot, "clone", fixture.upstreamRoot, updaterRoot);
  git(updaterRoot, "config", "user.name", "Upstream User");
  git(updaterRoot, "config", "user.email", "upstream@example.com");
  mkdirSync(path.join(updaterRoot, "patches"));
  writeFileSync(
    path.join(updaterRoot, "patches/example+1.0.0.patch"),
    sameTarget
      ? [
          "diff --git a/node_modules/example/android/build.gradle b/node_modules/example/android/build.gradle",
          "--- a/node_modules/example/android/build.gradle",
          "+++ b/node_modules/example/android/build.gradle",
          "@@ -2 +2 @@",
          "-minSdk = old",
          "+minSdk = new",
          "",
        ].join("\n")
      : [
          "diff --git a/node_modules/example/src/web.ts b/node_modules/example/src/web.ts",
          "--- a/node_modules/example/src/web.ts",
          "+++ b/node_modules/example/src/web.ts",
          "@@ -1 +1 @@",
          "-registry = old",
          "+registry = new",
          "",
        ].join("\n"),
  );
  git(updaterRoot, "add", "patches/example+1.0.0.patch");
  git(updaterRoot, "commit", "-m", "fix: update example web registry");
  git(updaterRoot, "push", "origin", "main");
  git(fixture.controlRoot, "fetch", "upstream");
  git(fixture.controlRoot, "branch", "-f", "main", "upstream/main");
  git(fixture.controlRoot, "push", "origin", "main:main");
  git(fixture.controlRoot, "fetch", "origin");

  const featureThreeRoot = path.join(fixture.fixtureRoot, "feature-three");
  git(fixture.controlRoot, "branch", "feature/three", "main");
  git(fixture.controlRoot, "worktree", "add", featureThreeRoot, "feature/three");
  writeFileSync(path.join(featureThreeRoot, "feature-three.txt"), "three\n");
  git(featureThreeRoot, "add", "feature-three.txt");
  git(featureThreeRoot, "commit", "-m", "feat: feature three");
  git(featureThreeRoot, "push", "-u", "origin", "feature/three");
}

function beginPatchConflict(fixture, options = {}) {
  advanceMainWithConflictingPatchAndCreateFeature(fixture, options);
  const result = runManage(fixture, "promote", [
    "--feature",
    "feature-three",
    "--branch",
    "feature/three",
  ]);
  assert.equal(result.status, 5, `${result.stdout}\n${result.stderr}`);
  const requestPath = result.stdout.match(/^PASEO_RW_BASE_OPERATION=(.+)$/m)?.[1];
  assert.notEqual(requestPath, undefined, result.stdout);
  return {
    operationWorktree: path.join(path.dirname(requestPath), "worktree"),
    requestPath,
  };
}

function runManage(fixture, command, args = [], extraEnv = {}) {
  return run(
    fixture.controlRoot,
    "bash",
    [fixture.script, "--build-root", fixture.buildRoot, "--push", command, ...args],
    { ...fixture.env, ...extraEnv },
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

test("writes a prepare-compatible ready state after a successful promotion", () => {
  withFixture({}, (fixture) => {
    const result = runManage(fixture, "promote", [
      "--state-file",
      fixture.lifecycleState,
      "--feature",
      "feature-one",
      "--branch",
      "feature/one",
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /PASEO_PREFLIGHT_STATE_FILE=/);

    const state = readFileSync(fixture.lifecycleState, "utf8");
    assert.match(state, /paseo_preflight_status=ready/);
    assert.match(state, /build_starting_branch=rw-main/);
    assert.match(state, /rw_base_rebuilt=1/);
    assert.match(state, /rw_main_rebuilt=1/);
    assert.match(state, /dependencies_reinstalled=0/);
    assert.match(
      state,
      new RegExp(`rw_base_after=${git(fixture.controlRoot, "rev-parse", "rw-base")}`),
    );
    assert.match(
      state,
      new RegExp(`rw_main_after=${git(fixture.controlRoot, "rev-parse", "rw-main")}`),
    );
    assert.match(state, new RegExp(`main_after=${fixture.initialMain}`));
    assert.match(
      state,
      new RegExp(`control_head=${git(fixture.controlRoot, "rev-parse", "HEAD")}`),
    );
    assert.equal(statSync(fixture.lifecycleState).mode & 0o777, 0o600);
    assert.deepEqual(
      readdirSync(path.dirname(fixture.lifecycleState)).filter((entry) =>
        entry.startsWith("lifecycle-ready.env.tmp."),
      ),
      [],
    );
    assert.deepEqual(readFileSync(fixture.miseCallLog, "utf8").trim().split("\n"), [
      "install",
      "activate bash",
    ]);
  });
});

test("syncs the latest upstream main before writing lifecycle ready state", () => {
  withFixture({}, (fixture) => {
    const upstreamHead = advanceUpstreamWithoutFetching(fixture, "fresh-upstream");
    const result = runManage(fixture, "promote", [
      "--state-file",
      fixture.lifecycleState,
      "--feature",
      "feature-one",
      "--branch",
      "feature/one",
    ]);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(git(fixture.controlRoot, "rev-parse", "main"), upstreamHead);
    assert.equal(git(fixture.controlRoot, "rev-parse", "origin/main"), upstreamHead);
    assert.equal(
      readFileSync(path.join(fixture.buildRoot, "fresh-upstream.txt"), "utf8"),
      "fresh-upstream\n",
    );
    assert.match(
      readFileSync(fixture.lifecycleState, "utf8"),
      new RegExp(`main_after=${upstreamHead}`),
    );
  });
});

test("keeps completed refs when the optional ready state cannot be written", () => {
  withFixture({}, (fixture) => {
    const result = runManage(
      fixture,
      "promote",
      [
        "--state-file",
        fixture.lifecycleState,
        "--feature",
        "feature-one",
        "--branch",
        "feature/one",
      ],
      { PASEO_TEST_FAIL_STATE_BASENAME: path.basename(fixture.lifecycleState) },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /could not write the optional ready state/);
    assert.equal(existsSync(fixture.lifecycleState), false);
    assert.equal(readFileSync(path.join(fixture.buildRoot, "feature-one.txt"), "utf8"), "one\n");
    assert.equal(
      git(fixture.controlRoot, "rev-parse", "rw-base"),
      git(fixture.controlRoot, "rev-parse", "origin/rw-base"),
    );
    assert.equal(
      git(fixture.controlRoot, "rev-parse", "rw-main"),
      git(fixture.controlRoot, "rev-parse", "origin/rw-main"),
    );
  });
});

test("reports direct rw-base commits and blocks lifecycle inference", () => {
  withFixture({}, (fixture) => {
    promoteBoth(fixture);
    const directRoot = path.join(fixture.fixtureRoot, "direct-rw-base");
    git(fixture.controlRoot, "worktree", "add", directRoot, "rw-base");
    writeFileSync(path.join(directRoot, "direct.txt"), "unmanaged\n");
    git(directRoot, "add", "direct.txt");
    git(directRoot, "commit", "-m", "fix(android): direct rw-base change");
    const directCommit = git(directRoot, "rev-parse", "HEAD");

    const status = runManage(fixture, "status");
    assert.equal(status.status, 0, status.stderr);
    assert.match(
      status.stdout,
      new RegExp(`UNMANAGED\\t${directCommit}\\tfix\\(android\\): direct rw-base change`),
    );

    const maintained = runManage(fixture, "maintain", [
      "--feature",
      "feature-one",
      "--branch",
      "feature/one",
    ]);
    assert.equal(maintained.status, 1);
    assert.match(maintained.stderr, /unmanaged rw-base first-parent commits/);
    assert.match(maintained.stderr, new RegExp(directCommit));
  });
}, 15_000);

test("adopts a reviewed direct rw-base commit during feature maintenance", () => {
  withFixture({}, (fixture) => {
    promoteBoth(fixture);
    const directRoot = path.join(fixture.fixtureRoot, "direct-rw-base-adoption");
    git(fixture.controlRoot, "worktree", "add", directRoot, "rw-base");
    writeFileSync(path.join(directRoot, "direct.txt"), "historical implementation\n");
    git(directRoot, "add", "direct.txt");
    git(directRoot, "commit", "-m", "fix(android): direct historical implementation");
    const directCommit = git(directRoot, "rev-parse", "HEAD");
    git(fixture.controlRoot, "worktree", "remove", directRoot);

    const maintenanceRoot = path.join(fixture.fixtureRoot, "maintenance-adoption");
    git(fixture.controlRoot, "branch", "maintenance/adoption", "rw-base");
    git(fixture.controlRoot, "worktree", "add", maintenanceRoot, "maintenance/adoption");
    writeFileSync(path.join(maintenanceRoot, "feature-one-fix.txt"), "reconciled\n");
    git(maintenanceRoot, "add", "feature-one-fix.txt");
    git(maintenanceRoot, "commit", "-m", "fix: reconcile feature one history");
    git(maintenanceRoot, "push", "-u", "origin", "maintenance/adoption");

    const maintained = runManage(fixture, "maintain", [
      "--feature",
      "feature-one",
      "--branch",
      "maintenance/adoption",
      "--adopt-commit",
      directCommit,
    ]);
    assert.equal(maintained.status, 0, `${maintained.stdout}\n${maintained.stderr}`);

    const status = runManage(fixture, "status");
    assert.equal(status.status, 0, status.stderr);
    assert.doesNotMatch(status.stdout, /UNMANAGED/);
    assert.match(status.stdout, /feature-one\tactive[^\n]*integrations=2[^\n]*adoptions=1/);
    assert.equal(
      git(
        fixture.controlRoot,
        "log",
        "-1",
        "--format=%(trailers:key=Paseo-Base-Adopted-Commit,valueonly)",
        "rw-base",
      ),
      directCommit,
    );
  });
}, 20_000);

test("rejects adoption refs that are not currently unmanaged on rw-base", () => {
  withFixture({}, (fixture) => {
    promoteBoth(fixture);
    const maintained = runManage(fixture, "maintain", [
      "--feature",
      "feature-one",
      "--branch",
      "feature/one",
      "--adopt-commit",
      fixture.initialMain,
    ]);
    assert.equal(maintained.status, 1);
    assert.match(maintained.stderr, /not currently UNMANAGED on rw-base/);
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
    assert.doesNotMatch(status.stdout, /UNMANAGED/);
  });
});

test("rejects an add/add patch resolution that drops one parent's targets", () => {
  withFixture({ featureOneAddsPatch: true }, (fixture) => {
    promoteBoth(fixture);
    const { operationWorktree, requestPath } = beginPatchConflict(fixture);
    const operationDir = path.dirname(requestPath);
    const conflictState = readFileSync(path.join(operationDir, "conflict.env"), "utf8");
    assert.match(conflictState, /conflict_phase=sync/);
    assert.match(conflictState, /conflict_ours=[0-9a-f]{40}/);
    assert.match(conflictState, /conflict_theirs=[0-9a-f]{40}/);
    assert.match(conflictState, /conflict_base=[0-9a-f]{40}/);
    assert.match(conflictState, /conflict_statuses=\( AA \)/);
    assert.match(conflictState, /conflict_stage2_blobs=\( [0-9a-f]{40} \)/);
    assert.match(conflictState, /conflict_stage3_blobs=\( [0-9a-f]{40} \)/);
    assert.equal(existsSync(path.join(operationDir, "conflict-ls-files-u.txt")), true);
    const patchTargets = readFileSync(
      path.join(operationDir, "conflict-patch-targets.env"),
      "utf8",
    );
    assert.match(patchTargets, /node_modules\/example\/android\/build\.gradle/);
    assert.match(patchTargets, /node_modules\/example\/src\/web\.ts/);

    writeFileSync(
      path.join(operationWorktree, "patches/example+1.0.0.patch"),
      git(fixture.controlRoot, "show", "main:patches/example+1.0.0.patch") + "\n",
    );
    git(operationWorktree, "add", "patches/example+1.0.0.patch");

    const continued = runManage(fixture, "continue", ["--operation", requestPath]);
    assert.equal(continued.status, 1);
    assert.match(continued.stderr, /drops patch target/);
    assert.match(continued.stderr, /node_modules\/example\/android\/build\.gradle/);
    assert.equal(existsSync(requestPath), true);
  });
}, 15_000);

test("auto-stages and accepts the semantic union of disjoint add/add patch targets", () => {
  withFixture({ featureOneAddsPatch: true }, (fixture) => {
    promoteBoth(fixture);
    const { operationWorktree, requestPath } = beginPatchConflict(fixture);
    assert.equal(git(operationWorktree, "diff", "--name-only", "--diff-filter=U"), "");
    const stagedPatch = git(operationWorktree, "show", ":patches/example+1.0.0.patch");
    assert.match(stagedPatch, /node_modules\/example\/android\/build\.gradle/);
    assert.match(stagedPatch, /node_modules\/example\/src\/web\.ts/);

    const continued = runManage(fixture, "continue", ["--operation", requestPath]);
    assert.equal(continued.status, 0, `${continued.stdout}\n${continued.stderr}`);
    const finalPatch = readFileSync(
      path.join(fixture.buildRoot, "patches/example+1.0.0.patch"),
      "utf8",
    );
    assert.match(finalPatch, /node_modules\/example\/android\/build\.gradle/);
    assert.match(finalPatch, /node_modules\/example\/src\/web\.ts/);
  });
}, 15_000);

test("refreshes upstream before continue and rejects a moved frozen main", () => {
  withFixture({ featureOneAddsPatch: true }, (fixture) => {
    promoteBoth(fixture);
    const { requestPath } = beginPatchConflict(fixture);
    advanceUpstreamWithoutFetching(fixture, "continue-drift");

    const continued = runManage(fixture, "continue", ["--operation", requestPath]);
    assert.equal(continued.status, 1);
    assert.match(continued.stderr, /upstream\/main moved since the operation was created/);
    assert.equal(existsSync(requestPath), true);
  });
}, 20_000);

test("rejects choosing one parent when add/add patches change different hunks of one target", () => {
  withFixture({ featureOneAddsPatch: true }, (fixture) => {
    promoteBoth(fixture);
    const { operationWorktree, requestPath } = beginPatchConflict(fixture, {
      sameTarget: true,
    });
    writeFileSync(
      path.join(operationWorktree, "patches/example+1.0.0.patch"),
      git(fixture.controlRoot, "show", "main:patches/example+1.0.0.patch") + "\n",
    );
    git(operationWorktree, "add", "patches/example+1.0.0.patch");

    const continued = runManage(fixture, "continue", ["--operation", requestPath]);
    assert.equal(continued.status, 1);
    assert.match(continued.stderr, /drops patch change from ours target/);
    assert.match(continued.stderr, /ndkVersion = old/);
    assert.equal(existsSync(requestPath), true);
  });
}, 15_000);

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
      "--state-file",
      fixture.lifecycleState,
      "--feature",
      "feature-one",
      "--replacement",
      "upstream-refactor",
    ]);
    assert.equal(result.status, 5, `${result.stdout}\n${result.stderr}`);
    const requestPath = result.stdout.match(/^PASEO_RW_BASE_OPERATION=(.+)$/m)?.[1];
    assert.notEqual(requestPath, undefined, result.stdout);
    assert.match(
      readFileSync(requestPath, "utf8"),
      new RegExp(`operation_state_file=${fixture.lifecycleState}`),
    );
    assert.equal(existsSync(fixture.lifecycleState), false);
    const operationWorktree = path.join(path.dirname(requestPath), "worktree");
    writeFileSync(path.join(operationWorktree, "shared.txt"), "feature two\n");
    git(operationWorktree, "add", "shared.txt");

    const continued = runManage(fixture, "continue", ["--operation", requestPath]);
    assert.equal(continued.status, 0, `${continued.stdout}\n${continued.stderr}`);
    assert.equal(existsSync(requestPath), false);
    assert.equal(existsSync(path.join(fixture.buildRoot, "feature-one.txt")), false);
    assert.equal(readFileSync(path.join(fixture.buildRoot, "shared.txt"), "utf8"), "feature two\n");
    const state = readFileSync(fixture.lifecycleState, "utf8");
    assert.match(state, /paseo_preflight_status=ready/);
    assert.match(
      state,
      new RegExp(`rw_main_after=${git(fixture.controlRoot, "rev-parse", "rw-main")}`),
    );
    const status = runManage(fixture, "status");
    assert.match(status.stdout, /feature-one\tretired/);
    assert.match(status.stdout, /feature-two\tactive/);
  });
});
