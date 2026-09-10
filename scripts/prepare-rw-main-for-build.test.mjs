import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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

function startLockHolder(lockPath, readyPath) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const holder = spawn(
    "/usr/bin/flock",
    [
      "-x",
      lockPath,
      "bash",
      "-c",
      'trap "exit 0" TERM INT; : >"$1"; while :; do sleep 1; done',
      "lock-holder",
      readyPath,
    ],
    { detached: true, stdio: "ignore" },
  );
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 200 && !existsSync(readyPath); attempt += 1) {
    if (holder.exitCode !== null) assert.fail("lock holder exited before acquiring the lock");
    Atomics.wait(waitBuffer, 0, 0, 10);
  }
  assert.equal(existsSync(readyPath), true, "lock holder did not acquire the lock");
  return holder;
}

function stopLockHolder(holder) {
  try {
    process.kill(-holder.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function assertBuildLockAvailable(fixture) {
  const lockPath = path.join(fixture.buildRoot, ".dev", "build-paseo-artifacts.lock");
  const result = run(fixture.controlRoot, "/usr/bin/flock", ["-n", lockPath, "true"]);
  assert.equal(result.status, 0, `build lock remained held: ${result.stderr}`);
}

function createFixture({ advanceUpstream = false, rebuildRwMain = false } = {}) {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "paseo-prepare-rw-main-"));
  const controlRoot = path.join(fixtureRoot, "control");
  const buildRoot = path.join(fixtureRoot, "build");
  const featureRoot = path.join(fixtureRoot, "feature-one");
  const upstreamRoot = path.join(fixtureRoot, "upstream.git");
  const originRoot = path.join(fixtureRoot, "origin.git");
  const stateFile = path.join(fixtureRoot, "preflight.env");
  const binRoot = path.join(fixtureRoot, "bin");
  mkdirSync(controlRoot);
  mkdirSync(binRoot);

  git(controlRoot, "init", "-b", "main");
  git(controlRoot, "config", "user.name", "Test User");
  git(controlRoot, "config", "user.email", "test@example.com");
  writeFileSync(path.join(controlRoot, ".gitignore"), ".dev/\npackages/**/dist/\n");
  writeFileSync(path.join(controlRoot, ".tool-versions"), "nodejs 22.20.0\n");
  writeFileSync(path.join(controlRoot, ".mise.toml"), '[tools]\nnodejs = "22.20.0"\n');
  writeFileSync(path.join(controlRoot, "package.json"), '{"version":"1.2.3"}\n');
  writeFileSync(path.join(controlRoot, "package-lock.json"), '{"lockfileVersion":3}\n');
  mkdirSync(path.join(controlRoot, "scripts"));
  writeFileSync(
    path.join(controlRoot, "scripts/postinstall-patches.mjs"),
    "const patchedPackages = [];\n",
  );
  for (const workspace of ["highlight", "relay", "protocol", "client", "server", "cli"]) {
    const workspaceRoot = path.join(controlRoot, "packages", workspace);
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(path.join(workspaceRoot, "package.json"), `{"name":"${workspace}"}\n`);
  }
  writeFileSync(path.join(controlRoot, "seed.txt"), "seed\n");
  git(controlRoot, "add", ".");
  git(controlRoot, "commit", "-m", "seed");
  const reviewedMain = git(controlRoot, "rev-parse", "main");

  let featureHead;
  if (advanceUpstream) {
    git(controlRoot, "switch", "-c", "feature/one");
    writeFileSync(path.join(controlRoot, "feature.txt"), "feature\n");
    git(controlRoot, "add", "feature.txt");
    git(controlRoot, "commit", "-m", "feat: feature one");
    featureHead = git(controlRoot, "rev-parse", "HEAD");
    git(controlRoot, "switch", "main");
  }

  git(fixtureRoot, "clone", "--bare", controlRoot, upstreamRoot);
  git(fixtureRoot, "clone", "--bare", controlRoot, originRoot);
  git(controlRoot, "remote", "add", "upstream", upstreamRoot);
  git(controlRoot, "remote", "add", "origin", originRoot);
  git(controlRoot, "branch", "rw-base", "main");
  git(controlRoot, "branch", "rw-main", "rw-base");
  if (rebuildRwMain) {
    writeFileSync(path.join(controlRoot, "main-change.txt"), "main change\n");
    git(controlRoot, "add", "main-change.txt");
    git(controlRoot, "commit", "-m", "feat: advance main before rebuilding rw-main");
    git(controlRoot, "push", "upstream", "main:main");
    git(controlRoot, "push", "origin", "main:main");
  }
  git(controlRoot, "push", "origin", "rw-base:rw-base", "rw-main:rw-main");
  git(controlRoot, "worktree", "add", buildRoot, "rw-main");
  if (advanceUpstream) {
    git(controlRoot, "worktree", "add", featureRoot, "feature/one");
  }

  git(controlRoot, "switch", "-c", "chore/build-paseo");
  const controlsRoot = path.join(controlRoot, "dwyanewang");
  mkdirSync(controlsRoot);
  for (const scriptName of [
    "prepare-rw-main-for-build.sh",
    "build-paseo-state.sh",
    "prepare-patched-dependencies.mjs",
    "refresh-expo-router-types.mjs",
    "rebuild-rw-main.sh",
    "sync-rw-main-branches.sh",
  ]) {
    copyFileSync(
      path.join(repoRoot, "dwyanewang", scriptName),
      path.join(controlsRoot, scriptName),
    );
  }
  const manifest = advanceUpstream
    ? `feature/one # Personal branch # reviewed-main:${reviewedMain} # reviewed-head:${featureHead}\n`
    : "# Empty test manifest\n";
  writeFileSync(path.join(controlsRoot, "rw-main-branches.txt"), manifest);
  git(controlRoot, "add", "dwyanewang");
  git(controlRoot, "commit", "-m", "chore: add build controls");

  const ghPath = path.join(binRoot, "gh");
  writeFileSync(ghPath, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(ghPath, 0o755);

  const miseCallLog = path.join(fixtureRoot, "mise-calls.log");
  const misePath = path.join(binRoot, "mise");
  writeFileSync(
    misePath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$PASEO_TEST_MISE_CALL_LOG"
case "\${1:-}" in
  install) printf '%s\\n' 'mise tools ready' ;;
  activate) : ;;
  *) exit 2 ;;
esac
`,
  );
  chmodSync(misePath, 0o755);

  const commandLog = path.join(fixtureRoot, "commands.log");
  const npmPath = path.join(binRoot, "npm");
  writeFileSync(
    npmPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'npm|%s\\n' "$*" >>"$PASEO_TEST_COMMAND_LOG"
if [[ "$*" == --version ]]; then
  printf '%s\\n' '10.9.0'
  exit 0
fi
if [[ "$*" == 'run typecheck' && -n "\${PASEO_TEST_TYPECHECK_EXIT:-}" ]]; then
  exit "$PASEO_TEST_TYPECHECK_EXIT"
fi
if [[ "$*" == 'run build:server-deps' ]]; then
  root=$PASEO_TEST_BUILD_ROOT
  for workspace in highlight relay protocol client; do
    mkdir -p "$root/packages/$workspace/dist"
    printf '%s\\n' "$workspace" >"$root/packages/$workspace/dist/index.js"
  done
elif [[ "$*" == 'run build --workspace=@getpaseo/expo-two-way-audio' ]]; then
  :
elif [[ "$*" == 'run build --workspace=@getpaseo/server' ]]; then
  root=$PASEO_TEST_BUILD_ROOT
  mkdir -p "$root/packages/server/dist/server/server"
  printf '%s\\n' server >"$root/packages/server/dist/index.js"
  printf '%s\\n' server >"$root/packages/server/dist/server/server/exports.js"
elif [[ "$*" == 'run build --workspace=@getpaseo/cli' ]]; then
  root=$PASEO_TEST_BUILD_ROOT
  mkdir -p "$root/packages/cli/dist"
  printf '%s\\n' cli >"$root/packages/cli/dist/index.js"
fi
`,
  );
  chmodSync(npmPath, 0o755);

  let upstreamMain = reviewedMain;
  if (advanceUpstream) {
    const updaterRoot = path.join(fixtureRoot, "upstream-updater");
    git(fixtureRoot, "clone", upstreamRoot, updaterRoot);
    git(updaterRoot, "config", "user.name", "Upstream User");
    git(updaterRoot, "config", "user.email", "upstream@example.com");
    writeFileSync(path.join(updaterRoot, "upstream.txt"), "upstream\n");
    git(updaterRoot, "add", "upstream.txt");
    git(updaterRoot, "commit", "-m", "feat: upstream change");
    git(updaterRoot, "push", "origin", "main");
    upstreamMain = git(updaterRoot, "rev-parse", "HEAD");
  }

  return {
    buildRoot,
    commandLog,
    controlRoot,
    env: {
      PASEO_TEST_BUILD_ROOT: buildRoot,
      PASEO_TEST_COMMAND_LOG: commandLog,
      PASEO_TEST_MISE_CALL_LOG: miseCallLog,
      PATH: `${binRoot}:${process.env.PATH}`,
    },
    fixtureRoot,
    featureRoot,
    upstreamRoot,
    miseCallLog,
    reviewedMain,
    stampFile: path.join(buildRoot, ".dev", "build-paseo-server-build.env"),
    stateFile,
    upstreamMain,
  };
}

function runPreflight(fixture, ...syncArgs) {
  return run(
    fixture.controlRoot,
    "bash",
    [
      "dwyanewang/prepare-rw-main-for-build.sh",
      "--build-root",
      fixture.buildRoot,
      "--push",
      "--state-file",
      fixture.stateFile,
      ...syncArgs,
    ],
    fixture.env,
  );
}

function reviewRequestPath(result) {
  const match = result.stdout.match(/^PASEO_REVIEW_REQUEST_FILE=(.+)$/m);
  assert.notEqual(match, null, result.stdout);
  return match[1];
}

function withFixture(options, callback) {
  const fixture = createFixture(options);
  try {
    callback(fixture);
  } finally {
    rmSync(fixture.fixtureRoot, { force: true, recursive: true });
  }
}

test("runs the unchanged source preflight and rw-main no-op as one command", () => {
  withFixture({}, (fixture) => {
    const result = runPreflight(fixture, "--run-id", "no-op");

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No-op: rw-base and rw-main already match every input/);
    assert.match(result.stdout, /PASEO_RW_BASE_REBUILT=0/);
    assert.match(result.stdout, /PASEO_RW_MAIN_REBUILT=0/);
    assert.match(result.stdout, /PASEO_DEPENDENCIES_REINSTALLED=0/);
    assert.match(result.stdout, /PASEO_PREFLIGHT_STATUS=ready/);
    const state = readFileSync(fixture.stateFile, "utf8");
    assert.match(state, /paseo_preflight_status=ready/);
    assert.match(state, new RegExp(`rw_base_after=${fixture.reviewedMain}`));
    assert.match(state, new RegExp(`main_after=${fixture.upstreamMain}`));
    assert.match(
      state,
      new RegExp(`control_head=${git(fixture.controlRoot, "rev-parse", "HEAD")}`),
    );
    assert.equal(statSync(fixture.stateFile).mode & 0o777, 0o600);
    assert.deepEqual(
      readdirSync(fixture.fixtureRoot).filter((entry) => entry.startsWith("preflight.env.tmp.")),
      [],
    );
    assert.equal(git(fixture.buildRoot, "branch", "--show-current"), "rw-main");
    assert.deepEqual(readFileSync(fixture.miseCallLog, "utf8").trim().split("\n"), [
      "install",
      "activate bash",
    ]);
    assertBuildLockAvailable(fixture);
  });
});

test("records a readiness build stamp after rebuilding rw-main", () => {
  withFixture({ rebuildRwMain: true }, (fixture) => {
    const result = runPreflight(fixture, "--run-id", "stamp");

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(readFileSync(fixture.commandLog, "utf8"), /npm\|run build:server/);
    assert.match(result.stdout, /PASEO_SERVER_BUILD_STAMP_FILE=/);
    const stamp = readFileSync(fixture.stampFile, "utf8");
    assert.match(stamp, /paseo_build_stamp_version=1/);
    assert.match(stamp, /paseo_build_stamp_validation_level=readiness/);
    assert.match(
      stamp,
      new RegExp(`paseo_build_stamp_head=${git(fixture.buildRoot, "rev-parse", "HEAD")}`),
    );
    assert.match(stamp, /paseo_build_stamp_tree=[0-9a-f]{40}/);
    assert.match(stamp, /paseo_build_stamp_node_version=v?[0-9][0-9A-Za-z.+_-]*/);
    assert.match(stamp, /paseo_build_stamp_npm_version=10\.9\.0/);
    assert.match(stamp, /paseo_build_stamp_toolchain_sha256=[0-9a-f]{64}/);
    assert.match(stamp, /paseo_build_stamp_dependencies_sha256=[0-9a-f]{64}/);
    assert.match(stamp, /paseo_build_stamp_outputs_sha256=[0-9a-f]{64}/);
    assert.equal(statSync(fixture.stampFile).mode & 0o777, 0o600);

    git(fixture.buildRoot, "commit", "--allow-empty", "-m", "test: recreate the same tree");
    const treeMatch = run(
      fixture.controlRoot,
      "bash",
      [
        "-c",
        'source "$1"; paseo_verify_build_stamp "$2" "$3" tree readiness HEAD',
        "verify-stamp",
        path.join(fixture.controlRoot, "dwyanewang/build-paseo-state.sh"),
        fixture.buildRoot,
        fixture.stampFile,
      ],
      fixture.env,
    );
    assert.equal(treeMatch.status, 0, treeMatch.stderr);
    const headMismatch = run(
      fixture.controlRoot,
      "bash",
      [
        "-c",
        'source "$1"; paseo_verify_build_stamp "$2" "$3" exact-head readiness HEAD',
        "verify-stamp",
        path.join(fixture.controlRoot, "dwyanewang/build-paseo-state.sh"),
        fixture.buildRoot,
        fixture.stampFile,
      ],
      fixture.env,
    );
    assert.equal(headMismatch.status, 1);
  });
}, 15_000);

test("refuses preflight while the shared build lock is held and preserves the old state", () => {
  withFixture({}, (fixture) => {
    writeFileSync(fixture.stateFile, "previous-state\n");
    const lockPath = path.join(fixture.buildRoot, ".dev", "build-paseo-artifacts.lock");
    const readyPath = path.join(fixture.fixtureRoot, "preflight-lock-ready");
    const holder = startLockHolder(lockPath, readyPath);
    try {
      const result = runPreflight(fixture, "--run-id", "locked");
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /another build-paseo workflow already owns the build root/);
      assert.equal(readFileSync(fixture.stateFile, "utf8"), "previous-state\n");
    } finally {
      stopLockHolder(holder);
    }
  });
});

test("missing run-id fails before syncing, creating a request, or deleting ready state", () => {
  withFixture({ advanceUpstream: true }, (fixture) => {
    writeFileSync(fixture.stateFile, "previous-state\n");
    const result = runPreflight(fixture);
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /--run-id is required/);
    assert.equal(git(fixture.controlRoot, "rev-parse", "main"), fixture.reviewedMain);
    assert.equal(readFileSync(fixture.stateFile, "utf8"), "previous-state\n");
    assert.equal(existsSync(path.join(fixture.buildRoot, ".dev/build-paseo-runs")), false);
  });
});

test("propagates semantic-review status before rebuilding rw-main", () => {
  withFixture({ advanceUpstream: true }, (fixture) => {
    const result = runPreflight(fixture, "--run-id", "review-status");

    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stdout, /Semantic review required before rebuilding rw-main/);
    assert.match(result.stdout, /Mergeability preflight: PASS/);
    assert.match(result.stdout, new RegExp(fixture.upstreamMain));
    assert.match(result.stdout, /upstream\.txt/);
    assert.match(result.stdout, /PASEO_PREFLIGHT_STATUS=review-required/);
    assert.doesNotMatch(result.stdout, /PASEO_REBUILD_SECONDS=/);
    assert.equal(existsSync(fixture.stateFile), false);
    assert.equal(git(fixture.controlRoot, "rev-parse", "main"), fixture.upstreamMain);
    const requestPath = reviewRequestPath(result);
    assert.equal(existsSync(requestPath), true);

    const accepted = runPreflight(
      fixture,
      "--run-id",
      "review-status",
      "--no-fetch",
      "--accept-review-request",
      requestPath,
    );
    assert.equal(accepted.status, 4, accepted.stderr);
    assert.match(accepted.stdout, /PASEO_PREFLIGHT_STATUS=manifest-changed/);
    assert.doesNotMatch(accepted.stdout, /PASEO_REBUILD_SECONDS=/);
    assert.equal(existsSync(fixture.stateFile), false);
  });
}, 15_000);

test("one request accepts and rebuilds its frozen main after another worktree fetches newer upstream", () => {
  withFixture({ advanceUpstream: true }, (fixture) => {
    const options = ["--run-id", "frozen-review", "--requested-at", "1700000000"];
    const first = runPreflight(fixture, ...options);
    assert.equal(first.status, 3, first.stderr);
    const request = reviewRequestPath(first);
    const updater = path.join(fixture.fixtureRoot, "upstream-updater");
    writeFileSync(path.join(updater, "later.txt"), "later upstream\n");
    git(updater, "add", "later.txt");
    git(updater, "commit", "-m", "later upstream");
    git(updater, "push", "origin", "main");
    git(fixture.featureRoot, "fetch", "upstream");
    const newerMain = git(updater, "rev-parse", "HEAD");

    const runRoot = path.join(fixture.buildRoot, ".dev/build-paseo-runs");
    const runsBefore = readdirSync(runRoot);
    const omittedRun = runPreflight(fixture);
    assert.equal(omittedRun.status, 2, omittedRun.stderr);
    assert.match(omittedRun.stderr, /--run-id is required/);
    assert.deepEqual(readdirSync(runRoot), runsBefore);
    assert.equal(git(fixture.controlRoot, "rev-parse", "main"), fixture.upstreamMain);

    const accidentalRefresh = runPreflight(fixture, ...options);
    assert.equal(accidentalRefresh.status, 1);
    assert.match(accidentalRefresh.stderr, /--no-fetch.*--refresh-main/);
    assert.equal(git(fixture.controlRoot, "rev-parse", "main"), fixture.upstreamMain);

    const accepted = runPreflight(
      fixture,
      ...options,
      "--no-fetch",
      "--accept-review-request",
      request,
    );
    assert.equal(accepted.status, 4, `${accepted.stdout}\n${accepted.stderr}`);
    git(fixture.controlRoot, "add", "dwyanewang/rw-main-branches.txt");
    git(fixture.controlRoot, "commit", "-m", "accept review once");
    const built = runPreflight(fixture, ...options, "--no-fetch");
    assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
    assert.equal(git(fixture.controlRoot, "rev-parse", "main"), fixture.upstreamMain);
    assert.equal(
      run(fixture.controlRoot, "git", ["merge-base", "--is-ancestor", newerMain, "rw-main"]).status,
      1,
    );
    const runDir = path.join(fixture.buildRoot, ".dev/build-paseo-runs/frozen-review");
    const log = readFileSync(path.join(runDir, "preflight-stages.log"), "utf8");
    assert.match(log, /preflight:end exit=3/);
    assert.match(log, /preflight:end exit=4/);
    assert.match(log, /readiness:typecheck:end exit=0/);
    assert.match(log, /preflight:end exit=0/);
    assert.match(readFileSync(fixture.stateFile, "utf8"), /paseo_build_run_id=frozen-review/);
    assert.equal(readFileSync(path.join(runDir, "requested-at"), "utf8").trim(), "1700000000");
    assert.match(
      readFileSync(path.join(runDir, "main.refreshes"), "utf8"),
      new RegExp(`^${fixture.upstreamMain} [0-9]+ initial\\n$`),
    );
  });
}, 30_000);

test("no-fetch refuses an absent snapshot and removes old readiness without fetching", () => {
  withFixture({ advanceUpstream: true }, (fixture) => {
    writeFileSync(fixture.stateFile, "previous-state\n");
    const result = runPreflight(fixture, "--run-id", "missing", "--no-fetch");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /snapshot/);
    assert.equal(existsSync(fixture.stateFile), false);
    assert.equal(git(fixture.controlRoot, "rev-parse", "main"), fixture.reviewedMain);
  });
});

test("an empty snapshot fails with an actionable error and preserves request history", () => {
  withFixture({ advanceUpstream: true }, (fixture) => {
    const runDir = path.join(fixture.buildRoot, ".dev/build-paseo-runs/empty-snapshot");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "requested-at"), "1700000000\n");
    writeFileSync(path.join(runDir, "main.snapshot"), "");
    writeFileSync(path.join(runDir, "preflight-stages.log"), "previous attempt\n");
    writeFileSync(fixture.stateFile, "previous-state\n");
    const result = runPreflight(fixture, "--run-id", "empty-snapshot", "--no-fetch");
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /unreadable main snapshot/);
    assert.equal(git(fixture.controlRoot, "rev-parse", "main"), fixture.reviewedMain);
    assert.equal(existsSync(fixture.stateFile), false);
    assert.equal(readFileSync(path.join(runDir, "requested-at"), "utf8"), "1700000000\n");
    assert.equal(readFileSync(path.join(runDir, "main.snapshot"), "utf8"), "");
    const log = readFileSync(path.join(runDir, "preflight-stages.log"), "utf8");
    assert.match(log, /^previous attempt\n/);
    assert.match(log, /preflight:end exit=1/);
    assertBuildLockAvailable(fixture);
  });
});

test("a rebased overlay cannot smuggle later upstream into a frozen request; explicit refresh requires new review", () => {
  withFixture({ advanceUpstream: true }, (fixture) => {
    const first = runPreflight(fixture, "--run-id", "ancestry");
    assert.equal(first.status, 3, first.stderr);
    const oldRequest = reviewRequestPath(first);
    const updater = path.join(fixture.fixtureRoot, "upstream-updater");
    writeFileSync(path.join(updater, "later.txt"), "newer upstream\n");
    git(updater, "add", "later.txt");
    git(updater, "commit", "-m", "newer upstream");
    git(updater, "push", "origin", "main");
    git(fixture.featureRoot, "fetch", "upstream");
    git(fixture.featureRoot, "rebase", "upstream/main");
    const baseBefore = git(fixture.controlRoot, "rev-parse", "rw-base");
    const rejected = runPreflight(fixture, "--run-id", "ancestry", "--no-fetch");
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /feature\/one introduces upstream .* beyond frozen main/);
    assert.equal(git(fixture.controlRoot, "rev-parse", "rw-base"), baseBefore);
    assert.equal(existsSync(fixture.stateFile), false);

    const refreshed = runPreflight(fixture, "--run-id", "ancestry", "--refresh-main");
    assert.equal(refreshed.status, 3, `${refreshed.stdout}\n${refreshed.stderr}`);
    assert.notEqual(reviewRequestPath(refreshed), oldRequest);
    const refreshes = readFileSync(
      path.join(fixture.buildRoot, ".dev/build-paseo-runs/ancestry/main.refreshes"),
      "utf8",
    )
      .trim()
      .split("\n");
    assert.equal(refreshes.length, 2);
    assert.match(refreshes[0], new RegExp(`^${fixture.upstreamMain} [0-9]+ initial$`));
    assert.match(refreshes[1], new RegExp(`^${git(updater, "rev-parse", "HEAD")} [0-9]+ refresh$`));
    const stale = runPreflight(
      fixture,
      "--run-id",
      "ancestry",
      "--no-fetch",
      "--accept-review-request",
      oldRequest,
    );
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /must equal current main/);
  });
}, 30_000);

test("failed readiness keeps stage logs and the real exit code, but not a ready state or moved product refs", () => {
  withFixture({ rebuildRwMain: true }, (fixture) => {
    const base = git(fixture.controlRoot, "rev-parse", "rw-base");
    const target = git(fixture.controlRoot, "rev-parse", "rw-main");
    fixture.env.PASEO_TEST_TYPECHECK_EXIT = "7";
    const result = runPreflight(fixture, "--run-id", "failed-check");
    assert.equal(result.status, 7, `${result.stdout}\n${result.stderr}`);
    const log = readFileSync(
      path.join(fixture.buildRoot, ".dev/build-paseo-runs/failed-check/preflight-stages.log"),
      "utf8",
    );
    assert.match(log, /readiness:build-server:end exit=0/);
    assert.match(log, /readiness:typecheck:end exit=7/);
    assert.match(log, /preflight:end exit=7/);
    assert.doesNotMatch(log, /readiness:lint:start/);
    assert.equal(existsSync(fixture.stateFile), false);
    assert.equal(git(fixture.controlRoot, "rev-parse", "rw-base"), base);
    assert.equal(git(fixture.controlRoot, "rev-parse", "rw-main"), target);
    assert.equal(git(fixture.buildRoot, "branch", "--show-current"), "rw-main");
    assertBuildLockAvailable(fixture);
  });
}, 30_000);
