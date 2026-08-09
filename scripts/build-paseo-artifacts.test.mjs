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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceScript = path.join(repoRoot, "dwyanewang", "build-paseo-artifacts.sh");

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

function createFixture({ dependenciesReinstalled = 0, rwMainRebuilt = 0 } = {}) {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "paseo-build-artifacts-"));
  const controlRoot = path.join(fixtureRoot, "control");
  const buildRoot = path.join(fixtureRoot, "build");
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
      "packages/**/dist/",
      "packages/app/android/",
      "packages/desktop/release/",
      "packages/app/dist/",
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(controlRoot, "package.json"), '{"version":"1.2.3-beta.4"}\n');
  const terminalRelative = "packages/app/src/terminal/webview/terminal-emulator-webview-html.ts";
  const terminalControl = path.join(controlRoot, terminalRelative);
  mkdirSync(path.dirname(terminalControl), { recursive: true });
  writeFileSync(terminalControl, "export const html = 'original';\n");
  const desktopPackage = path.join(controlRoot, "packages/desktop/package.json");
  mkdirSync(path.dirname(desktopPackage), { recursive: true });
  writeFileSync(desktopPackage, '{"name":"desktop-fixture"}\n');
  git(
    controlRoot,
    "add",
    ".gitignore",
    "package.json",
    terminalRelative,
    "packages/desktop/package.json",
  );
  git(controlRoot, "commit", "-m", "test: add product fixture");
  git(controlRoot, "branch", "rw-main", "main");
  git(controlRoot, "worktree", "add", buildRoot, "rw-main");
  git(controlRoot, "switch", "-c", "chore/build-paseo");

  const controlsRoot = path.join(controlRoot, "dwyanewang");
  mkdirSync(controlsRoot);
  copyFileSync(sourceScript, path.join(controlsRoot, "build-paseo-artifacts.sh"));
  chmodSync(path.join(controlsRoot, "build-paseo-artifacts.sh"), 0o755);

  writeExecutable(
    path.join(controlsRoot, "serve-dist.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'serve|%s\\n' "$*" >>"$PASEO_TEST_COMMAND_LOG"
version=$(node -p "require('$PASEO_BUILD_ROOT/package.json').version")
apk="$PASEO_BUILD_ROOT/packages/app/android/app/build/outputs/apk/release/app-release.apk"
zip="$PASEO_BUILD_ROOT/packages/desktop/release/Paseo-Setup-$version-x64.zip"
if [[ "\${1:-}" == prepare-build ]]; then
  rm -f -- "$apk" "$zip"
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
root=$PASEO_TEST_BUILD_ROOT
case "$*" in
  *build:terminal-webview*)
    printf '%s\\n' "export const html = 'generated';" >"$root/${terminalRelative}"
    ;;
  *build:server*)
    mkdir -p "$root/packages/server/dist/server/server" "$root/packages/cli/dist" "$root/packages/protocol/dist"
    printf '%s\\n' server >"$root/packages/server/dist/server/server/exports.js"
    printf '%s\\n' cli >"$root/packages/cli/dist/index.js"
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
      `rw_main_rebuilt=${rwMainRebuilt}`,
      `dependencies_reinstalled=${dependenciesReinstalled}`,
      `rw_main_after=${buildHead}`,
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
    fixtureRoot,
    preflightState,
    script: path.join(controlsRoot, "build-paseo-artifacts.sh"),
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

test("uses the reduced server path only after a rebuild without npm install", () => {
  withFixture({ rwMainRebuilt: 1 }, (fixture) => {
    const result = runBuild(fixture, "incremental");
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const commandLog = readFileSync(fixture.commandLog, "utf8");
    assert.match(commandLog, /npm\|run build:highlight/);
    assert.match(commandLog, /npm\|run build --workspace=@getpaseo\/server/);
    assert.match(commandLog, /npm\|run build --workspace=@getpaseo\/cli/);
    assert.doesNotMatch(commandLog, /npm\|run build:server/);
    assert.match(
      readFileSync(path.join(fixture.buildRoot, ".dev/incremental/result.env"), "utf8"),
      /server_build_mode=incremental-after-rw-main-rebuild/,
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

test("rejects stale main and control coordinates before deleting artifacts", () => {
  for (const coordinate of ["main_after", "control_head"]) {
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
        new RegExp(
          `preflight state is stale: ${coordinate === "main_after" ? "main" : "control"} expected`,
        ),
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
