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
if [[ "\${PASEO_TEST_FAIL_LABEL:-}" == "$label" ]]; then
  exit 7
fi
transcript="$output_dir/$label.transcript.log"
if [[ "$label" == android-metro-hermes ]]; then
  mkdir -p app/build/generated/assets/createBundleReleaseJsAndAssets
  printf '%s\\n' bundle >app/build/generated/assets/createBundleReleaseJsAndAssets/index.android.bundle
  printf '%s\\n' 'BUILD SUCCESSFUL' >"$transcript"
else
  mkdir -p app/build/outputs/apk/release
  printf '%s\\n' apk >app/build/outputs/apk/release/app-release.apk
  printf '%s\\n' '> Task :app:createBundleReleaseJsAndAssets UP-TO-DATE' 'BUILD SUCCESSFUL' >"$transcript"
fi
cat >"$output_dir/$label.summary" <<'SUMMARY'
exit_status=0
systemd_cleanup_degraded=0
command_wall_seconds=1.000
average_cpu_cores=2.000
host_cpu_percent=10.000
peak_sampled_cpu_cores=4.000
memory_peak_bytes=1024
swap_peak_bytes=0
SUMMARY
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
  writeFileSync(
    preflightState,
    [
      "paseo_preflight_status=ready",
      `rw_main_rebuilt=${rwMainRebuilt}`,
      `dependencies_reinstalled=${dependenciesReinstalled}`,
      `rw_main_after=${buildHead}`,
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
      "profile|android-native-assemble",
      "npm|run build --workspace=@getpaseo/expo-two-way-audio",
      "npx|expo export --platform web",
      "npm|run build:main --workspace=@getpaseo/desktop",
      "npx|electron-builder --config electron-builder.yml --win zip --x64 --publish never",
      "serve|8800 10800",
    ]);

    const runDir = path.join(fixture.buildRoot, ".dev", "successful");
    assert.equal(readFileSync(path.join(runDir, "exit-status"), "utf8").trim(), "0");
    assert.match(readFileSync(path.join(runDir, "result.env"), "utf8"), /status=ready/);
    assert.equal(
      readFileSync(path.join(fixture.buildRoot, fixture.terminalRelative), "utf8"),
      "export const html = 'original';\n",
    );
    assert.equal(git(fixture.buildRoot, "status", "--porcelain"), "");
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
    assert.doesNotMatch(readFileSync(fixture.commandLog, "utf8"), /serve\|8800 10800/);
  });
});

test("rejects a stale preflight state before deleting artifacts", () => {
  withFixture({}, (fixture) => {
    writeFileSync(
      fixture.preflightState,
      [
        "paseo_preflight_status=ready",
        "rw_main_rebuilt=0",
        "dependencies_reinstalled=0",
        `rw_main_after=${"0".repeat(40)}`,
        "",
      ].join("\n"),
    );
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
