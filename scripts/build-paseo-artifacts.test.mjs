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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";

vi.setConfig({ testTimeout: 15_000 });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceScript = path.join(repoRoot, "dwyanewang", "build-paseo-artifacts.sh");
const sourceStateHelper = path.join(repoRoot, "dwyanewang", "build-paseo-state.sh");
const sourcePatchedDependenciesHelper = path.join(
  repoRoot,
  "dwyanewang",
  "prepare-patched-dependencies.mjs",
);

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

function writeExecutable(filePath, contents) {
  writeFileSync(filePath, contents);
  chmodSync(filePath, 0o755);
}

function killIfAlive(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
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
    if (holder.exitCode !== null) {
      assert.fail(`lock holder exited before acquiring ${lockPath}`);
    }
    Atomics.wait(waitBuffer, 0, 0, 10);
  }
  assert.equal(existsSync(readyPath), true, `lock holder did not acquire ${lockPath}`);
  return holder;
}

function stopLockHolder(holder) {
  killIfAlive(-holder.pid, "SIGTERM");
}

function assertBuildLockAvailable(fixture) {
  const lockPath = path.join(fixture.buildRoot, ".dev", "build-paseo-artifacts.lock");
  const result = run(fixture.controlRoot, "/usr/bin/flock", ["-n", lockPath, "true"]);
  assert.equal(result.status, 0, `build lock remained held: ${result.stderr}`);
}

function createFixture({
  dependenciesReinstalled = 0,
  patchedDependency = false,
  rwMainRebuilt = 0,
} = {}) {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "paseo-build-artifacts-"));
  const controlRoot = path.join(fixtureRoot, "control");
  const buildRoot = path.join(fixtureRoot, "build");
  const featureRoot = path.join(fixtureRoot, "feature-local");
  const binRoot = path.join(fixtureRoot, "bin");
  const androidHome = path.join(fixtureRoot, "android-sdk");
  const commandLog = path.join(fixtureRoot, "commands.log");
  const preflightState = path.join(buildRoot, ".dev", "preflight.env");
  mkdirSync(controlRoot);
  mkdirSync(binRoot);
  mkdirSync(androidHome);

  git(controlRoot, "init", "-b", "main");
  git(controlRoot, "config", "user.name", "Test User");
  git(controlRoot, "config", "user.email", "test@example.com");
  writeFileSync(
    path.join(controlRoot, ".gitignore"),
    [
      ".dev/",
      "node_modules/",
      "packages/**/dist/",
      "packages/app/android/",
      "packages/desktop/release/",
      "packages/app/dist/",
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(controlRoot, ".tool-versions"), "nodejs 22.20.0\n");
  writeFileSync(path.join(controlRoot, ".mise.toml"), '[tools]\nnodejs = "22.20.0"\n');
  writeFileSync(path.join(controlRoot, "package.json"), '{"version":"1.2.3-beta.4"}\n');
  writeFileSync(path.join(controlRoot, "package-lock.json"), '{"lockfileVersion":3}\n');
  mkdirSync(path.join(controlRoot, "scripts"));
  writeFileSync(
    path.join(controlRoot, "scripts/postinstall-patches.mjs"),
    patchedDependency
      ? 'const patchedPackages = [{ cwd: ".", nodeModulesPath: "node_modules/example", patchPrefix: "example+" }];\n'
      : "const patchedPackages = [];\n",
  );
  if (patchedDependency) {
    mkdirSync(path.join(controlRoot, "patches"));
    writeFileSync(
      path.join(controlRoot, "patches/example+1.0.0.patch"),
      [
        "diff --git a/node_modules/example/value.txt b/node_modules/example/value.txt",
        "--- a/node_modules/example/value.txt",
        "+++ b/node_modules/example/value.txt",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n"),
    );
  }
  for (const workspace of ["highlight", "relay", "protocol", "client", "server", "cli"]) {
    const workspaceRoot = path.join(controlRoot, "packages", workspace);
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(path.join(workspaceRoot, "package.json"), `{"name":"${workspace}"}\n`);
  }
  const terminalRelative = "packages/app/src/terminal/webview/terminal-emulator-webview-html.ts";
  const terminalControl = path.join(controlRoot, terminalRelative);
  mkdirSync(path.dirname(terminalControl), { recursive: true });
  writeFileSync(terminalControl, "export const html = 'original';\n");
  const desktopPackage = path.join(controlRoot, "packages/desktop/package.json");
  mkdirSync(path.dirname(desktopPackage), { recursive: true });
  writeFileSync(desktopPackage, '{"name":"desktop-fixture"}\n');
  git(controlRoot, "add", ".");
  git(controlRoot, "commit", "-m", "test: add product fixture");
  git(controlRoot, "branch", "rw-base", "main");
  git(controlRoot, "branch", "rw-main", "rw-base");
  git(controlRoot, "worktree", "add", buildRoot, "rw-main");
  if (patchedDependency) {
    mkdirSync(path.join(buildRoot, "node_modules", "example"), { recursive: true });
    writeFileSync(path.join(buildRoot, "node_modules/example/value.txt"), "new\n");
  }
  git(controlRoot, "switch", "-c", "chore/build-paseo");

  const controlsRoot = path.join(controlRoot, "dwyanewang");
  mkdirSync(controlsRoot);
  copyFileSync(sourceScript, path.join(controlsRoot, "build-paseo-artifacts.sh"));
  chmodSync(path.join(controlsRoot, "build-paseo-artifacts.sh"), 0o755);
  copyFileSync(sourceStateHelper, path.join(controlsRoot, "build-paseo-state.sh"));
  copyFileSync(
    sourcePatchedDependenciesHelper,
    path.join(controlsRoot, "prepare-patched-dependencies.mjs"),
  );

  writeExecutable(
    path.join(controlsRoot, "serve-dist.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'serve|%s\\n' "$*" >>"$PASEO_TEST_COMMAND_LOG"
version=$(node -p "require('$PASEO_BUILD_ROOT/package.json').version")
apk="$PASEO_BUILD_ROOT/packages/app/android/app/build/outputs/apk/release/app-release.apk"
zip="$PASEO_BUILD_ROOT/packages/desktop/release/Paseo-Setup-$version-x64.zip"
if [[ "\${1:-}" == prepare-build ]]; then
  shift
  target_android=1
  target_windows=1
  if [[ "\${1:-}" == --target ]]; then
    target_android=0
    target_windows=0
    case "$2" in
      android) target_android=1 ;;
      windows) target_windows=1 ;;
      *) exit 2 ;;
    esac
  fi
  ((target_android == 0)) || rm -f -- "$apk"
  ((target_windows == 0)) || rm -f -- "$zip"
  exit 0
fi
if [[ -n "\${PASEO_TEST_LONG_LIVED_DOWNLOAD_PID_FILE:-}" ]]; then
  sleep 30 </dev/null >/dev/null 2>&1 &
  printf '%s\\n' "$!" >"$PASEO_TEST_LONG_LIVED_DOWNLOAD_PID_FILE"
fi
printf '%s\\n' '物理机浏览器访问: http://127.0.0.1:8800/'
`,
  );
  writeExecutable(
    path.join(controlsRoot, "configure-android-build.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'configure|%s\\n' "$*" >>"$PASEO_TEST_COMMAND_LOG"
`,
  );
  writeExecutable(
    path.join(controlsRoot, "profile-build-resources.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
label=
output_dir=
while (($# > 0)); do
  case "$1" in
    --label) label=$2; shift 2 ;;
    --output-dir) output_dir=$2; shift 2 ;;
    --) shift; break ;;
    *) shift ;;
  esac
done
printf 'profile|%s|%s\\n' "$label" "$*" >>"$PASEO_TEST_COMMAND_LOG"
mkdir -p -- "$output_dir"
transcript="$output_dir/$label.transcript.log"
if [[ "$label" == android-metro-hermes ]]; then
  mkdir -p app/build/generated/assets/createBundleReleaseJsAndAssets
  printf '%s\\n' bundle >app/build/generated/assets/createBundleReleaseJsAndAssets/index.android.bundle
  printf '%s\\n' 'BUILD SUCCESSFUL' >"$transcript"
elif [[ "$label" == android-native-assemble ]]; then
  if [[ -n "\${PASEO_TEST_PARALLEL_SYNC_DIR:-}" ]]; then
    mkdir -p -- "$PASEO_TEST_PARALLEL_SYNC_DIR"
    : >"$PASEO_TEST_PARALLEL_SYNC_DIR/$label.started"
  fi
  if [[ "\${PASEO_TEST_FAIL_LABEL:-}" == "$label" ]]; then
    exit 7
  fi
  native_bundle_state=\${PASEO_TEST_NATIVE_BUNDLE_STATE:-UP-TO-DATE}
  if [[ "$native_bundle_state" == UP-TO-DATE ]]; then
    native_bundle_line='> Task :app:createBundleReleaseJsAndAssets UP-TO-DATE'
  elif [[ "$native_bundle_state" == EXECUTED ]]; then
    native_bundle_line='> Task :app:createBundleReleaseJsAndAssets'
  else
    native_bundle_line="> Task :app:createBundleReleaseJsAndAssets $native_bundle_state"
  fi
  printf '%s\\n' "$native_bundle_line" | tee "$transcript"
  if [[ -n "\${PASEO_TEST_PARALLEL_SYNC_DIR:-}" ]]; then
    : >"$PASEO_TEST_PARALLEL_SYNC_DIR/android-native-assemble.gate"
    windows_ready=0
    for _ in {1..200}; do
      if [[ -e "$PASEO_TEST_PARALLEL_SYNC_DIR/windows-artifacts.started" ]]; then
        windows_ready=1
        break
      fi
      sleep 0.01
    done
    ((windows_ready == 1)) || exit 9
  fi
  if [[ "\${PASEO_TEST_BLOCK_NATIVE:-}" == 1 ]]; then
    trap 'printf terminated >"$PASEO_TEST_NATIVE_TERMINATED_FILE"; exit 143' TERM
    : >"$PASEO_TEST_NATIVE_BLOCK_STARTED_FILE"
    while :; do sleep 1; done
  fi
  mkdir -p app/build/outputs/apk/release
  printf '%s\\n' apk >app/build/outputs/apk/release/app-release.apk
  printf '%s\\n' 'BUILD SUCCESSFUL' | tee -a "$transcript"
else
  if [[ -n "\${PASEO_TEST_PARALLEL_SYNC_DIR:-}" ]]; then
    mkdir -p -- "$PASEO_TEST_PARALLEL_SYNC_DIR"
    : >"$PASEO_TEST_PARALLEL_SYNC_DIR/$label.started"
    [[ -e "$PASEO_TEST_PARALLEL_SYNC_DIR/android-native-assemble.gate" ]] || exit 9
  fi
  if [[ "\${PASEO_TEST_FAIL_LABEL:-}" == "$label" ]]; then
    if [[ -n "\${PASEO_TEST_FAIL_DELAY_SECONDS:-}" ]]; then
      sleep "$PASEO_TEST_FAIL_DELAY_SECONDS"
    fi
    exit 7
  fi
  if [[ "\${PASEO_TEST_BLOCK_WINDOWS:-}" == 1 ]]; then
    trap 'printf terminated >"$PASEO_TEST_WINDOWS_TERMINATED_FILE"; exit 143' TERM
    : >"$PASEO_TEST_WINDOWS_BLOCK_STARTED_FILE"
    while :; do sleep 1; done
  fi
  "$@" 2>&1 | tee "$transcript"
fi
summary_exit_status=0
summary_mode=
if [[ "\${PASEO_TEST_BAD_SUMMARY_LABEL:-}" == "$label" ]]; then
  summary_mode=\${PASEO_TEST_BAD_SUMMARY_MODE:-}
  [[ "$summary_mode" != nonzero ]] || summary_exit_status=9
fi
{
  printf 'exit_status=%s\\n' "$summary_exit_status"
  printf '%s\\n' 'systemd_cleanup_degraded=0'
  printf '%s\\n' 'command_wall_seconds=1.000'
  printf '%s\\n' 'average_cpu_cores=2.000'
  [[ "$summary_mode" == missing-key ]] || printf '%s\\n' 'host_cpu_percent=10.000'
  printf '%s\\n' 'peak_sampled_cpu_cores=4.000'
  printf '%s\\n' 'memory_peak_bytes=1024'
  printf '%s\\n' 'swap_peak_bytes=0'
  printf '%s\\n' 'minimum_host_mem_available_bytes=17179869184'
} >"$output_dir/$label.summary"
`,
  );
  git(controlRoot, "add", "dwyanewang");
  git(controlRoot, "commit", "-m", "test: add build controls");

  git(controlRoot, "branch", "feature/local", "rw-main");
  git(controlRoot, "worktree", "add", featureRoot, "feature/local");
  writeFileSync(path.join(featureRoot, "local-feature.txt"), "local overlay\n");
  git(featureRoot, "add", "local-feature.txt");
  git(featureRoot, "commit", "-m", "test: add local overlay feature");
  const localBranchHead = git(featureRoot, "rev-parse", "HEAD");

  writeExecutable(
    path.join(binRoot, "mise"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'mise|%s\\n' "$*" >>"$PASEO_TEST_COMMAND_LOG"
case "\${1:-}" in
  install) printf '%s\\n' 'mise tools ready' ;;
  activate) : ;;
  *) exit 2 ;;
esac
`,
  );
  writeExecutable(
    path.join(binRoot, "flock"),
    `#!/usr/bin/env bash
set -euo pipefail
exec /usr/bin/flock "$@"
`,
  );
  writeExecutable(
    path.join(binRoot, "chmod"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${PASEO_TEST_FAIL_RESULT_WRITE:-}" == 1 && "$*" == *result.env.tmp.* ]]; then
  exit 6
fi
exec /usr/bin/chmod "$@"
`,
  );
  writeExecutable(
    path.join(binRoot, "npm"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'npm|%s\\n' "$*" >>"$PASEO_TEST_COMMAND_LOG"
if [[ "$*" == --version ]]; then
  printf '%s\\n' '10.9.0'
  exit 0
fi
root=$PASEO_TEST_BUILD_ROOT
case "$*" in
  install)
    if [[ -f "$root/patches/example+1.0.0.patch" ]]; then
      [[ ! -e "$root/node_modules/example" ]] || {
        printf '%s\\n' 'npm fixture found a stale patched package before install' >&2
        exit 23
      }
      mkdir -p "$root/node_modules/example"
      printf '%s\\n' old >"$root/node_modules/example/value.txt"
      (cd "$root" && git apply patches/example+1.0.0.patch)
    fi
    ;;
  *build:terminal-webview*)
    printf '%s\\n' "export const html = 'generated';" >"$root/${terminalRelative}"
    ;;
  *build:server*)
    for workspace in highlight relay protocol client server cli; do
      mkdir -p "$root/packages/$workspace/dist"
      printf '%s\\n' "$workspace" >"$root/packages/$workspace/dist/index.js"
    done
    mkdir -p "$root/packages/server/dist/server/server"
    printf '%s\\n' server >"$root/packages/server/dist/server/server/exports.js"
    printf '%s\\n' protocol >"$root/packages/protocol/dist/messages.js"
    ;;
  *--workspace=@getpaseo/server*)
    mkdir -p "$root/packages/server/dist/server/server"
    printf '%s\\n' server >"$root/packages/server/dist/server/server/exports.js"
    ;;
  *--workspace=@getpaseo/cli*)
    mkdir -p "$root/packages/cli/dist"
    printf '%s\\n' cli >"$root/packages/cli/dist/index.js"
    ;;
esac
`,
  );
  writeExecutable(
    path.join(binRoot, "npx"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'npx|%s\\n' "$*" >>"$PASEO_TEST_COMMAND_LOG"
if [[ " $* " == *' expo prebuild '* ]]; then
  mkdir -p "$PASEO_TEST_BUILD_ROOT/packages/app/android"
fi
if [[ " $* " == *' electron-builder '* ]]; then
  version=$(node -p "require('$PASEO_TEST_BUILD_ROOT/package.json').version")
  mkdir -p "$PASEO_TEST_BUILD_ROOT/packages/desktop/release"
  printf '%s\\n' zip >"$PASEO_TEST_BUILD_ROOT/packages/desktop/release/Paseo-Setup-$version-x64.zip"
fi
`,
  );

  mkdirSync(path.join(buildRoot, "packages/protocol/dist"), { recursive: true });
  writeFileSync(path.join(buildRoot, "packages/protocol/dist/messages.js"), "protocol\n");
  mkdirSync(path.dirname(preflightState), { recursive: true });
  const buildHead = git(buildRoot, "rev-parse", "HEAD");
  const controlHead = git(controlRoot, "rev-parse", "HEAD");
  const mainHead = git(controlRoot, "rev-parse", "main");
  writeFileSync(
    preflightState,
    [
      "paseo_preflight_status=ready",
      "rw_base_rebuilt=0",
      `rw_main_rebuilt=${rwMainRebuilt}`,
      `dependencies_reinstalled=${dependenciesReinstalled}`,
      `rw_main_after=${buildHead}`,
      `rw_base_after=${mainHead}`,
      `main_after=${mainHead}`,
      `control_head=${controlHead}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  return {
    buildRoot,
    commandLog,
    controlRoot,
    env: {
      ANDROID_HOME: androidHome,
      PASEO_SKIP_TAILSCALE: "1",
      PASEO_TEST_BUILD_ROOT: buildRoot,
      PASEO_TEST_COMMAND_LOG: commandLog,
      PATH: `${binRoot}:${process.env.PATH}`,
    },
    featureRoot,
    fixtureRoot,
    localBranch: "feature/local",
    localBranchHead,
    npmPath: path.join(binRoot, "npm"),
    preflightState,
    script: path.join(controlsRoot, "build-paseo-artifacts.sh"),
    stampFile: path.join(buildRoot, ".dev", "build-paseo-server-build.env"),
    terminalRelative,
  };
}

function runBuild(fixture, runName, extraArgs = [], extraEnv = {}) {
  return run(
    fixture.controlRoot,
    "bash",
    [
      fixture.script,
      "--build-root",
      fixture.buildRoot,
      "--preflight-state",
      fixture.preflightState,
      "--run-dir",
      path.join(fixture.buildRoot, ".dev", runName),
      ...extraArgs,
    ],
    { ...fixture.env, ...extraEnv },
  );
}

function withFixture(options, callback) {
  const fixture = createFixture(options);
  try {
    callback(fixture);
  } finally {
    rmSync(fixture.fixtureRoot, { force: true, recursive: true });
  }
}

function assertOrdered(log, fragments) {
  let previousIndex = -1;
  for (const fragment of fragments) {
    const index = log.indexOf(fragment);
    assert.ok(index > previousIndex, `missing or out-of-order command: ${fragment}\n${log}`);
    previousIndex = index;
  }
}

function assertBetween(log, fragment, beforeFragment, afterFragment) {
  const index = log.indexOf(fragment);
  assert.ok(
    index > log.indexOf(beforeFragment),
    `${fragment} did not follow ${beforeFragment}\n${log}`,
  );
  assert.ok(
    index < log.indexOf(afterFragment),
    `${fragment} did not precede ${afterFragment}\n${log}`,
  );
}

function updatePreflightBuildHead(fixture) {
  const buildHead = git(fixture.buildRoot, "rev-parse", "HEAD");
  const state = readFileSync(fixture.preflightState, "utf8").replace(
    /^rw_main_after=.*$/m,
    `rw_main_after=${buildHead}`,
  );
  writeFileSync(fixture.preflightState, state, { mode: 0o600 });
  return buildHead;
}

function replaceStampField(fixture, field, value) {
  const stamp = readFileSync(fixture.stampFile, "utf8").replace(
    new RegExp(`^${field}=.*$`, "m"),
    `${field}=${value}`,
  );
  writeFileSync(fixture.stampFile, stamp, { mode: 0o600 });
}

test("rejects the main daemon port before starting a build", () => {
  const result = run(repoRoot, "bash", [
    sourceScript,
    "--build-root",
    "/does/not/exist",
    "--skip-preflight",
    "--download-port",
    "6767",
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /main daemon port 6767/);
});

test("requires skip-preflight for temporary local branches", () => {
  const result = run(repoRoot, "bash", [
    sourceScript,
    "--build-root",
    "/does/not/exist",
    "--preflight-state",
    "/does/not/exist",
    "--local-branch",
    "feature/local",
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--local-branch requires --skip-preflight/);
});

test("runs the complete three-platform artifact chain from one ready state", () => {
  withFixture({}, (fixture) => {
    const result = runBuild(fixture, "successful");
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /PASEO_ARTIFACT_BUILD_STATUS=ready/);
    assert.match(result.stdout, /PASEO_ARTIFACT_BUILD_VERSION=1\.2\.3-beta\.4/);

    const commandLog = readFileSync(fixture.commandLog, "utf8");
    assertOrdered(commandLog, [
      "mise|install",
      "serve|prepare-build",
      "npm|run build:terminal-webview",
      "npm|run build:server",
      "npx|cross-env APP_VARIANT=production expo prebuild --platform android",
      "configure|--build-root",
      "profile|android-metro-hermes",
      "serve|8800 10800",
    ]);
    for (const fragment of [
      "profile|android-native-assemble",
      "profile|windows-artifacts",
      "npm|run build --workspace=@getpaseo/expo-two-way-audio",
      "npx|expo export --platform web",
      "npm|run build:main --workspace=@getpaseo/desktop",
      "npx|electron-builder --config electron-builder.yml --win zip --x64 --publish never",
    ]) {
      assertBetween(commandLog, fragment, "profile|android-metro-hermes", "serve|8800 10800");
    }

    const runDir = path.join(fixture.buildRoot, ".dev", "successful");
    assert.equal(readFileSync(path.join(runDir, "exit-status"), "utf8").trim(), "0");
    const resultState = readFileSync(path.join(runDir, "result.env"), "utf8");
    assert.match(resultState, /status=ready/);
    assert.match(resultState, /paseo_artifact_windows_summary=/);
    assert.match(resultState, /paseo_artifact_parallel_mode=/);
    assert.match(resultState, /paseo_artifact_android_native_bundle_gate=up-to-date/);
    assert.match(resultState, /paseo_artifact_parallel_min_available_bytes=17179869184/);
    assert.equal(existsSync(path.join(runDir, "windows-artifacts.branch.log")), true);
    assert.equal(
      readFileSync(path.join(fixture.buildRoot, fixture.terminalRelative), "utf8"),
      "export const html = 'original';\n",
    );
    assert.equal(git(fixture.buildRoot, "status", "--porcelain"), "");
    assertBuildLockAvailable(fixture);
  });
});

test("builds only the Windows artifact while retaining its server prerequisites", () => {
  withFixture({}, (fixture) => {
    const result = runBuild(fixture, "windows-only", ["--target", "desktop"], { ANDROID_HOME: "" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /PASEO_ARTIFACT_TARGETS=windows/);
    assert.match(result.stdout, /PASEO_ARTIFACT_WINDOWS_ZIP=/);
    assert.doesNotMatch(result.stdout, /PASEO_ARTIFACT_APK=/);

    const commandLog = readFileSync(fixture.commandLog, "utf8");
    assert.match(commandLog, /serve\|prepare-build --target windows/);
    assert.match(commandLog, /npm\|run build:server/);
    assert.match(commandLog, /profile\|windows-artifacts/);
    assert.match(commandLog, /serve\|--target windows 8800 10800/);
    assert.doesNotMatch(commandLog, /expo prebuild --platform android/);
    assert.doesNotMatch(commandLog, /profile\|android-/);

    const resultState = readFileSync(
      path.join(fixture.buildRoot, ".dev/windows-only/result.env"),
      "utf8",
    );
    assert.match(resultState, /paseo_artifact_targets=windows/);
    assert.match(resultState, /paseo_artifact_parallel_mode=windows-only/);
    assert.match(resultState, /paseo_artifact_android_native_bundle_gate=not-selected/);
  });
});

test("keeps only the current and two most recently built Windows zip versions", () => {
  withFixture({}, (fixture) => {
    const releaseDir = path.join(fixture.buildRoot, "packages/desktop/release");
    mkdirSync(path.join(releaseDir, "win-unpacked"), { recursive: true });
    writeFileSync(path.join(releaseDir, "builder-debug.yml"), "debug\n");
    writeFileSync(path.join(releaseDir, "Paseo-Setup-0.7.2-x64.exe"), "installer\n");

    const historicalVersions = ["0.5.0-beta.3", "0.5.0-beta.5", "0.5.1", "0.7.0", "0.7.2"];
    historicalVersions.forEach((version, index) => {
      const archive = path.join(releaseDir, `Paseo-Setup-${version}-x64.zip`);
      const builtAt = new Date(Date.UTC(2026, 0, index + 1));
      writeFileSync(archive, `${version}\n`);
      utimesSync(archive, builtAt, builtAt);
    });

    const result = runBuild(
      fixture,
      "windows-retention",
      ["--target", "windows", "--no-serve-dist"],
      { ANDROID_HOME: "" },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(
      result.stdout,
      /windows: retained 3 newest x64 zip archive\(s\), pruned 3 older archive\(s\)/,
    );

    const archives = readdirSync(releaseDir)
      .filter((entry) => /^Paseo-Setup-.*-x64\.zip$/.test(entry))
      .sort();
    assert.deepEqual(archives, [
      "Paseo-Setup-0.7.0-x64.zip",
      "Paseo-Setup-0.7.2-x64.zip",
      "Paseo-Setup-1.2.3-beta.4-x64.zip",
    ]);
    assert.equal(existsSync(path.join(releaseDir, "builder-debug.yml")), true);
    assert.equal(existsSync(path.join(releaseDir, "Paseo-Setup-0.7.2-x64.exe")), true);
    assert.equal(existsSync(path.join(releaseDir, "win-unpacked")), true);

    const resultState = readFileSync(
      path.join(fixture.buildRoot, ".dev/windows-retention/result.env"),
      "utf8",
    );
    assert.match(resultState, /paseo_artifact_windows_retention_limit=3/);
    assert.match(resultState, /paseo_artifact_windows_archive_count=3/);
    assert.match(resultState, /paseo_artifact_windows_pruned_count=3/);
  });
});

test("does not prune Windows zip history before resource validation succeeds", () => {
  withFixture({}, (fixture) => {
    const releaseDir = path.join(fixture.buildRoot, "packages/desktop/release");
    mkdirSync(releaseDir, { recursive: true });
    const historicalArchives = ["0.5.0", "0.6.0", "0.7.0", "0.8.0"].map((version) => {
      const archive = path.join(releaseDir, `Paseo-Setup-${version}-x64.zip`);
      writeFileSync(archive, `${version}\n`);
      return archive;
    });

    const result = runBuild(
      fixture,
      "windows-retention-validation-failure",
      ["--target", "windows", "--no-serve-dist"],
      {
        ANDROID_HOME: "",
        PASEO_TEST_BAD_SUMMARY_LABEL: "windows-artifacts",
        PASEO_TEST_BAD_SUMMARY_MODE: "missing-key",
      },
    );
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    for (const archive of historicalArchives) {
      assert.equal(
        existsSync(archive),
        true,
        `history was pruned after a failed build: ${archive}`,
      );
    }
  });
});

test("builds only Android with app dependencies and no Windows or server artifact", () => {
  withFixture({}, (fixture) => {
    const result = runBuild(fixture, "android-only", ["--target", "android", "--no-serve-dist"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /PASEO_ARTIFACT_TARGETS=android/);
    assert.match(result.stdout, /PASEO_ARTIFACT_APK=/);
    assert.doesNotMatch(result.stdout, /PASEO_ARTIFACT_SERVER=/);
    assert.doesNotMatch(result.stdout, /PASEO_ARTIFACT_WINDOWS_ZIP=/);

    const commandLog = readFileSync(fixture.commandLog, "utf8");
    assert.match(commandLog, /npm\|run build:app-deps/);
    assert.match(commandLog, /profile\|android-native-assemble/);
    assert.doesNotMatch(commandLog, /npm\|run build:server/);
    assert.doesNotMatch(commandLog, /profile\|windows-artifacts/);
    const resultState = readFileSync(
      path.join(fixture.buildRoot, ".dev/android-only/result.env"),
      "utf8",
    );
    assert.match(resultState, /paseo_artifact_server_build_mode=app-deps-only/);
    assert.match(resultState, /paseo_artifact_parallel_mode=android-only/);
  });
});

test("builds only the server and skips app preparation and distribution", () => {
  withFixture({}, (fixture) => {
    const result = runBuild(fixture, "server-only", ["--target", "server"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /PASEO_ARTIFACT_TARGETS=server/);
    assert.match(result.stdout, /PASEO_ARTIFACT_SERVER=/);
    const commandLog = readFileSync(fixture.commandLog, "utf8");
    assert.match(commandLog, /npm\|run build:server/);
    assert.doesNotMatch(commandLog, /build:terminal-webview/);
    assert.doesNotMatch(commandLog, /serve\|/);
    assert.doesNotMatch(commandLog, /profile\|/);
    assert.match(
      readFileSync(path.join(fixture.buildRoot, ".dev/server-only/result.env"), "utf8"),
      /paseo_artifact_download_service_started=0/,
    );
  });
});

test("reuses server artifacts only when the trusted stamp still matches", () => {
  withFixture({}, (fixture) => {
    const first = runBuild(fixture, "server-stamp-prime", ["--target", "server"]);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    assert.equal(existsSync(fixture.stampFile), true);

    writeFileSync(fixture.commandLog, "");
    const reused = runBuild(fixture, "server-stamp-reuse", ["--target", "server"]);
    assert.equal(reused.status, 0, `${reused.stdout}\n${reused.stderr}`);
    assert.match(reused.stdout, /trusted build stamp matched/);
    assert.doesNotMatch(readFileSync(fixture.commandLog, "utf8"), /npm\|run build:server/);
    assert.match(
      readFileSync(path.join(fixture.buildRoot, ".dev/server-stamp-reuse/result.env"), "utf8"),
      /paseo_artifact_server_build_mode=trusted-stamp-reuse/,
    );
  });
});

test("rejects ignored patched-dependency drift before reusing a trusted stamp", () => {
  withFixture({ patchedDependency: true }, (fixture) => {
    const first = runBuild(fixture, "server-patch-prime", ["--target", "server"]);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    assert.equal(existsSync(fixture.stampFile), true);

    rmSync(path.join(fixture.buildRoot, "node_modules", "example"), {
      force: true,
      recursive: true,
    });
    writeFileSync(fixture.commandLog, "");
    const drifted = runBuild(fixture, "server-patch-drift", ["--target", "server"]);

    assert.equal(drifted.status, 1, `${drifted.stdout}\n${drifted.stderr}`);
    const buildLog = readFileSync(
      path.join(fixture.buildRoot, ".dev", "server-patch-drift", "build.log"),
      "utf8",
    );
    assert.match(buildLog, /installed package .* is missing: node_modules\/example/);
    assert.doesNotMatch(drifted.stdout, /trusted build stamp matched/);
    assert.doesNotMatch(readFileSync(fixture.commandLog, "utf8"), /serve\|prepare-build/);
  });
});

test("rebuilds when the trusted stamp belongs to a different HEAD", () => {
  withFixture({}, (fixture) => {
    const first = runBuild(fixture, "server-stamp-old-head", ["--target", "server"]);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);

    writeFileSync(path.join(fixture.buildRoot, "source-change.txt"), "changed\n");
    git(fixture.buildRoot, "add", "source-change.txt");
    git(fixture.buildRoot, "commit", "-m", "test: change source identity");
    updatePreflightBuildHead(fixture);
    writeFileSync(fixture.commandLog, "");

    const rebuilt = runBuild(fixture, "server-stamp-new-head", ["--target", "server"]);
    assert.equal(rebuilt.status, 0, `${rebuilt.stdout}\n${rebuilt.stderr}`);
    assert.match(readFileSync(fixture.commandLog, "utf8"), /npm\|run build:server/);
    assert.match(
      readFileSync(path.join(fixture.buildRoot, ".dev/server-stamp-new-head/result.env"), "utf8"),
      /paseo_artifact_server_build_mode=full/,
    );
  });
});

test("rebuilds when pinned toolchain or dependency inputs differ from the stamp", () => {
  for (const [label, relativePath, contents] of [
    ["toolchain", ".tool-versions", "nodejs 22.21.0\n"],
    ["dependencies", "package-lock.json", '{"lockfileVersion":3,"changed":true}\n'],
  ]) {
    withFixture({}, (fixture) => {
      const first = runBuild(fixture, `server-stamp-${label}-prime`, ["--target", "server"]);
      assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);

      writeFileSync(path.join(fixture.buildRoot, relativePath), contents);
      git(fixture.buildRoot, "add", relativePath);
      git(fixture.buildRoot, "commit", "-m", `test: change ${label} input`);
      const buildHead = updatePreflightBuildHead(fixture);
      const buildTree = git(fixture.buildRoot, "rev-parse", "HEAD^{tree}");
      replaceStampField(fixture, "paseo_build_stamp_head", buildHead);
      replaceStampField(fixture, "paseo_build_stamp_tree", buildTree);
      writeFileSync(fixture.commandLog, "");

      const rebuilt = runBuild(fixture, `server-stamp-${label}-changed`, ["--target", "server"]);
      assert.equal(rebuilt.status, 0, `${rebuilt.stdout}\n${rebuilt.stderr}`);
      assert.match(readFileSync(fixture.commandLog, "utf8"), /npm\|run build:server/);
    });
  }
}, 20_000);

test("rebuilds when the active npm executable version differs from the stamp", () => {
  withFixture({}, (fixture) => {
    const first = runBuild(fixture, "server-stamp-runtime-prime", ["--target", "server"]);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);

    const changedNpm = readFileSync(fixture.npmPath, "utf8").replace("10.9.0", "10.9.1");
    writeFileSync(fixture.npmPath, changedNpm, { mode: 0o755 });
    writeFileSync(fixture.commandLog, "");

    const rebuilt = runBuild(fixture, "server-stamp-runtime-changed", ["--target", "server"]);
    assert.equal(rebuilt.status, 0, `${rebuilt.stdout}\n${rebuilt.stderr}`);
    assert.match(rebuilt.stdout, /trusted build stamp missed \(toolchain-runtime\)/);
    assert.match(readFileSync(fixture.commandLog, "utf8"), /npm\|run build:server/);
  });
}, 15_000);

test("rebuilds when stamped dist output is missing or damaged", () => {
  for (const damage of ["missing", "changed"]) {
    withFixture({}, (fixture) => {
      const first = runBuild(fixture, `server-stamp-${damage}-prime`, ["--target", "server"]);
      assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);

      const protocolOutput = path.join(fixture.buildRoot, "packages/protocol/dist/messages.js");
      if (damage === "missing") {
        rmSync(protocolOutput);
      } else {
        writeFileSync(protocolOutput, "damaged\n");
      }
      writeFileSync(fixture.commandLog, "");

      const rebuilt = runBuild(fixture, `server-stamp-${damage}-rebuilt`, ["--target", "server"]);
      assert.equal(rebuilt.status, 0, `${rebuilt.stdout}\n${rebuilt.stderr}`);
      assert.match(readFileSync(fixture.commandLog, "utf8"), /npm\|run build:server/);
      assert.equal(readFileSync(protocolOutput, "utf8"), "protocol\n");
    });
  }
}, 20_000);

test("treats a malformed build stamp as a safe cache miss", () => {
  withFixture({}, (fixture) => {
    const first = runBuild(fixture, "server-stamp-malformed-prime", ["--target", "server"]);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    writeFileSync(fixture.stampFile, "paseo_build_stamp_version=$(false)\n", {
      mode: 0o600,
    });
    writeFileSync(fixture.commandLog, "");

    const rebuilt = runBuild(fixture, "server-stamp-malformed-rebuilt", ["--target", "server"]);
    assert.equal(rebuilt.status, 0, `${rebuilt.stdout}\n${rebuilt.stderr}`);
    assert.match(readFileSync(fixture.commandLog, "utf8"), /npm\|run build:server/);
  });
}, 15_000);

test("temporarily merges a local branch without synchronization and restores rw-main", () => {
  withFixture({}, (fixture) => {
    const runDir = path.join(fixture.buildRoot, ".dev", "local-overlay-windows");
    const result = run(
      fixture.controlRoot,
      "bash",
      [
        fixture.script,
        "--build-root",
        fixture.buildRoot,
        "--skip-preflight",
        "--local-branch",
        fixture.localBranch,
        "--target",
        "windows",
        "--run-dir",
        runDir,
        "--no-serve-dist",
      ],
      fixture.env,
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /local-overlay: candidate ready/);
    assert.match(result.stdout, /local-overlay: restored rw-main/);

    const commandLog = readFileSync(fixture.commandLog, "utf8");
    assertOrdered(commandLog, [
      "npm|run build --workspace=@getpaseo/relay",
      "npm|run build:client",
      "npm|run build:plugin",
      "npm|run format:check",
      "npm|run typecheck",
      "npm|run lint",
      "profile|windows-artifacts",
    ]);
    assert.equal(git(fixture.buildRoot, "branch", "--show-current"), "rw-main");
    assert.equal(
      git(fixture.controlRoot, "rev-parse", fixture.localBranch),
      fixture.localBranchHead,
    );
    assert.equal(existsSync(path.join(fixture.buildRoot, "local-feature.txt")), false);
    const temporaryBranches = git(fixture.controlRoot, "branch", "--list", "rw-local-build-*");
    assert.equal(temporaryBranches, "");

    const resultState = readFileSync(path.join(runDir, "result.env"), "utf8");
    assert.match(resultState, /paseo_artifact_preflight_mode=local-overlay/);
    assert.match(resultState, /paseo_artifact_local_overlay_count=1/);
    assert.match(resultState, /paseo_artifact_local_overlay_branch_0=feature\/local/);
    assert.match(
      resultState,
      new RegExp(`paseo_artifact_local_overlay_head_0=${fixture.localBranchHead}`),
    );
  });
});

test("refreshes a changed local-overlay patch before the single dependency install", () => {
  withFixture({ patchedDependency: true }, (fixture) => {
    const patchPath = path.join(fixture.featureRoot, "patches", "example+1.0.0.patch");
    writeFileSync(patchPath, readFileSync(patchPath, "utf8").replace("+new\n", "+local\n"));
    git(fixture.featureRoot, "add", "patches/example+1.0.0.patch");
    git(fixture.featureRoot, "commit", "-m", "test: change local overlay patch");

    const runDir = path.join(fixture.buildRoot, ".dev", "local-overlay-patch-refresh");
    const result = run(
      fixture.controlRoot,
      "bash",
      [
        fixture.script,
        "--build-root",
        fixture.buildRoot,
        "--skip-preflight",
        "--local-branch",
        fixture.localBranch,
        "--target",
        "server",
        "--run-dir",
        runDir,
      ],
      fixture.env,
    );

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Patch refresh: removed node_modules\/example/);
    assert.match(
      result.stdout,
      /patch registry and installed applications verified during local-overlay install/,
    );
    const installs = readFileSync(fixture.commandLog, "utf8")
      .split("\n")
      .filter((line) => line === "npm|install");
    assert.equal(installs.length, 1);
    assert.equal(
      readFileSync(path.join(runDir, "local-overlay-patch-refresh.json"), "utf8").includes(
        '"node_modules/example"',
      ),
      true,
    );
    assert.equal(existsSync(path.join(runDir, "local-overlay-npm-install.log")), true);
  });
});

test("restores rw-main when a local-overlay artifact branch fails", () => {
  withFixture({}, (fixture) => {
    const runDir = path.join(fixture.buildRoot, ".dev", "failed-local-overlay");
    const result = run(
      fixture.controlRoot,
      "bash",
      [
        fixture.script,
        "--build-root",
        fixture.buildRoot,
        "--skip-preflight",
        "--local-branch",
        fixture.localBranch,
        "--target",
        "windows",
        "--run-dir",
        runDir,
        "--no-serve-dist",
      ],
      { ...fixture.env, PASEO_TEST_FAIL_LABEL: "windows-artifacts" },
    );
    assert.equal(result.status, 7, `${result.stdout}\n${result.stderr}`);
    assert.equal(git(fixture.buildRoot, "branch", "--show-current"), "rw-main");
    assert.equal(git(fixture.buildRoot, "status", "--porcelain"), "");
    assert.equal(git(fixture.controlRoot, "branch", "--list", "rw-local-build-*"), "");
    assert.equal(existsSync(path.join(runDir, "result.env")), false);
  });
});

test("uses a full server rebuild when a rebuilt rw-main has no trusted stamp", () => {
  withFixture({ rwMainRebuilt: 1 }, (fixture) => {
    const result = runBuild(fixture, "incremental");
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const commandLog = readFileSync(fixture.commandLog, "utf8");
    assert.match(commandLog, /npm\|run build:server/);
    assert.doesNotMatch(commandLog, /npm\|run build:highlight/);
    assert.match(
      readFileSync(path.join(fixture.buildRoot, ".dev/incremental/result.env"), "utf8"),
      /server_build_mode=full/,
    );
  });
});

test("starts Android native and Windows only after Metro and runs them concurrently", () => {
  withFixture({}, (fixture) => {
    const syncDir = path.join(fixture.fixtureRoot, "parallel-sync");
    const result = runBuild(fixture, "parallel", [], {
      PASEO_BUILD_PARALLEL_MIN_AVAILABLE_BYTES: "0",
      PASEO_TEST_PARALLEL_SYNC_DIR: syncDir,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(path.join(syncDir, "android-native-assemble.started")), true);
    assert.equal(existsSync(path.join(syncDir, "android-native-assemble.gate")), true);
    assert.equal(existsSync(path.join(syncDir, "windows-artifacts.started")), true);
    const commandLog = readFileSync(fixture.commandLog, "utf8");
    assertBetween(
      commandLog,
      "profile|android-native-assemble",
      "profile|android-metro-hermes",
      "serve|8800 10800",
    );
    assertBetween(
      commandLog,
      "profile|windows-artifacts",
      "profile|android-metro-hermes",
      "serve|8800 10800",
    );
    assert.match(
      readFileSync(path.join(fixture.buildRoot, ".dev/parallel/result.env"), "utf8"),
      /paseo_artifact_parallel_mode=concurrent/,
    );
  });
});

test("falls back to profiled serial branches when available memory is below the threshold", () => {
  withFixture({}, (fixture) => {
    const result = runBuild(fixture, "serial-low-memory", [], {
      PASEO_BUILD_PARALLEL_MIN_AVAILABLE_BYTES: "9000000000000000000",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const commandLog = readFileSync(fixture.commandLog, "utf8");
    assertOrdered(commandLog, ["profile|android-native-assemble", "profile|windows-artifacts"]);
    const resultState = readFileSync(
      path.join(fixture.buildRoot, ".dev/serial-low-memory/result.env"),
      "utf8",
    );
    assert.match(resultState, /paseo_artifact_parallel_mode=serial-low-memory/);
    assert.match(resultState, /paseo_artifact_windows_summary=/);
  });
});

test("fails fast when another workflow owns the real build-root lock", () => {
  withFixture({}, (fixture) => {
    const lockPath = path.join(fixture.buildRoot, ".dev", "build-paseo-artifacts.lock");
    const readyPath = path.join(fixture.fixtureRoot, "lock-holder-ready");
    const holder = startLockHolder(lockPath, readyPath);
    try {
      const result = runBuild(fixture, "locked");
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /another build-paseo workflow already owns the build root/);
      assert.equal(existsSync(path.join(fixture.buildRoot, ".dev/locked")), false);
      assert.equal(existsSync(fixture.commandLog), false);
    } finally {
      stopLockHolder(holder);
    }
  });
});

test("preserves the failing build status and restores terminal-webview", () => {
  withFixture({}, (fixture) => {
    const result = runBuild(fixture, "failed-native", [], {
      PASEO_TEST_FAIL_LABEL: "android-native-assemble",
    });
    assert.equal(result.status, 7, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /PASEO_ARTIFACT_BUILD_STATUS=failed/);
    const runDir = path.join(fixture.buildRoot, ".dev", "failed-native");
    assert.equal(readFileSync(path.join(runDir, "exit-status"), "utf8").trim(), "7");
    assert.equal(existsSync(path.join(runDir, "result.env")), false);
    assert.equal(
      readFileSync(path.join(fixture.buildRoot, fixture.terminalRelative), "utf8"),
      "export const html = 'original';\n",
    );
    assert.equal(git(fixture.buildRoot, "status", "--porcelain"), "");
    const commandLog = readFileSync(fixture.commandLog, "utf8");
    assert.doesNotMatch(commandLog, /profile\|windows-artifacts/);
    assert.doesNotMatch(commandLog, /serve\|8800 10800/);
    assertBuildLockAvailable(fixture);
  });
});

test("never starts Windows when the second Android phase reruns the bundle producer", () => {
  withFixture({}, (fixture) => {
    const result = runBuild(fixture, "bundle-rerun", [], {
      PASEO_BUILD_PARALLEL_MIN_AVAILABLE_BYTES: "0",
      PASEO_TEST_NATIVE_BUNDLE_STATE: "EXECUTED",
    });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /attempted to rerun the bundle producer/);
    const commandLog = readFileSync(fixture.commandLog, "utf8");
    assert.doesNotMatch(commandLog, /profile\|windows-artifacts/);
    assert.doesNotMatch(commandLog, /expo export --platform web/);
    assert.doesNotMatch(commandLog, /serve\|8800 10800/);
  });
});

test("terminates and waits for the sibling process group after a parallel branch fails", () => {
  withFixture({}, (fixture) => {
    const syncDir = path.join(fixture.fixtureRoot, "failure-sync");
    const nativeStarted = path.join(fixture.fixtureRoot, "native-block-started");
    const nativeTerminated = path.join(fixture.fixtureRoot, "native-terminated");
    const result = runBuild(fixture, "failed-parallel", [], {
      PASEO_BUILD_PARALLEL_MIN_AVAILABLE_BYTES: "0",
      PASEO_TEST_BLOCK_NATIVE: "1",
      PASEO_TEST_FAIL_DELAY_SECONDS: "0.2",
      PASEO_TEST_FAIL_LABEL: "windows-artifacts",
      PASEO_TEST_PARALLEL_SYNC_DIR: syncDir,
      PASEO_TEST_NATIVE_BLOCK_STARTED_FILE: nativeStarted,
      PASEO_TEST_NATIVE_TERMINATED_FILE: nativeTerminated,
    });
    assert.equal(result.status, 7, `${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(nativeStarted), true);
    assert.equal(existsSync(nativeTerminated), true);
    const runDir = path.join(fixture.buildRoot, ".dev/failed-parallel");
    assert.equal(existsSync(path.join(runDir, "android-native-assemble.branch.log")), true);
    assert.equal(existsSync(path.join(runDir, "windows-artifacts.branch.log")), true);
    assert.equal(existsSync(path.join(runDir, "result.env")), false);
    assert.doesNotMatch(readFileSync(fixture.commandLog, "utf8"), /serve\|8800 10800/);
  });
});

test("rejects incomplete or failed resource summaries before distribution", () => {
  for (const summaryMode of ["missing-key", "nonzero"]) {
    withFixture({}, (fixture) => {
      const result = runBuild(fixture, `bad-summary-${summaryMode}`, [], {
        PASEO_TEST_BAD_SUMMARY_LABEL: "windows-artifacts",
        PASEO_TEST_BAD_SUMMARY_MODE: summaryMode,
      });
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      if (summaryMode === "missing-key") {
        assert.match(result.stdout, /resource summary is missing host_cpu_percent/);
      } else {
        assert.match(result.stdout, /resource summary recorded a failed command/);
      }
      assert.doesNotMatch(readFileSync(fixture.commandLog, "utf8"), /serve\|8800 10800/);
    });
  }
});

test("a long-lived download process does not inherit the build lock", () => {
  withFixture({}, (fixture) => {
    const pidFile = path.join(fixture.fixtureRoot, "download-sleep.pid");
    const result = runBuild(fixture, "download-lock-release", [], {
      PASEO_TEST_LONG_LIVED_DOWNLOAD_PID_FILE: pidFile,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const downloadPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isInteger(downloadPid) && downloadPid > 1);
    try {
      assertBuildLockAvailable(fixture);
    } finally {
      killIfAlive(downloadPid, "SIGTERM");
    }
  });
});

test("stops a newly started download service after a late result write failure", () => {
  withFixture({}, (fixture) => {
    const result = runBuild(fixture, "failed-result-write", [], {
      PASEO_TEST_FAIL_RESULT_WRITE: "1",
    });
    assert.equal(result.status, 6, `${result.stdout}\n${result.stderr}`);
    const commandLog = readFileSync(fixture.commandLog, "utf8");
    assertOrdered(commandLog, ["serve|8800 10800", "serve|stop"]);
    const runDir = path.join(fixture.buildRoot, ".dev/failed-result-write");
    assert.equal(readFileSync(path.join(runDir, "exit-status"), "utf8").trim(), "6");
    assert.equal(existsSync(path.join(runDir, "result.env")), false);
    assert.deepEqual(
      readdirSync(runDir).filter((entry) => entry.startsWith("result.env.tmp.")),
      [],
    );
  });
});

test("rejects a stale preflight state before deleting artifacts", () => {
  withFixture({}, (fixture) => {
    const staleState = readFileSync(fixture.preflightState, "utf8").replace(
      /^rw_main_after=.*$/m,
      `rw_main_after=${"0".repeat(40)}`,
    );
    writeFileSync(fixture.preflightState, staleState);
    const result = runBuild(fixture, "stale-state");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /preflight state is stale/);
    assert.equal(existsSync(fixture.commandLog), false);
    assert.equal(
      readFileSync(path.join(fixture.buildRoot, fixture.terminalRelative), "utf8"),
      "export const html = 'original';\n",
    );
  });
});

test("rejects stale base, main, and control coordinates before deleting artifacts", () => {
  const coordinateLabels = {
    control_head: "control",
    main_after: "main",
    rw_base_after: "rw-base",
  };
  for (const coordinate of ["rw_base_after", "main_after", "control_head"]) {
    withFixture({}, (fixture) => {
      const staleState = readFileSync(fixture.preflightState, "utf8").replace(
        new RegExp(`^${coordinate}=.*$`, "m"),
        `${coordinate}=${"0".repeat(40)}`,
      );
      writeFileSync(fixture.preflightState, staleState);
      const result = runBuild(fixture, `stale-${coordinate}`);
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.match(
        result.stdout,
        new RegExp(`preflight state is stale: ${coordinateLabels[coordinate]} expected`),
      );
      assert.equal(existsSync(fixture.commandLog), false);
    });
  }
});

test("supports an explicit clean-checkout build without source synchronization", () => {
  withFixture({}, (fixture) => {
    const runDir = path.join(fixture.buildRoot, ".dev", "skip-preflight");
    const result = run(
      fixture.controlRoot,
      "bash",
      [
        fixture.script,
        "--build-root",
        fixture.buildRoot,
        "--skip-preflight",
        "--run-dir",
        runDir,
        "--no-serve-dist",
      ],
      fixture.env,
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const resultState = readFileSync(path.join(runDir, "result.env"), "utf8");
    assert.match(resultState, /preflight_mode=skipped/);
    assert.match(resultState, /server_build_mode=full/);
    assert.match(resultState, /download_service_started=0/);
    assert.doesNotMatch(readFileSync(fixture.commandLog, "utf8"), /serve\|8800 10800/);
  });
});
