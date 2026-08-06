#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash dwyanewang/configure-android-build.sh --build-root PATH [--metro-workers N]

Configure the generated Android project for the local build-paseo workflow.
Run this after every Expo prebuild. It keeps Metro's transform cache enabled
and caps Metro itself at four workers by default; Gradle worker limits remain
controlled by the later gradlew commands.

  --build-root PATH  Dedicated Paseo build worktree (required).
  --metro-workers N  Metro transform workers, 1..32 (default: 4).
EOF
}

fail() {
  printf 'configure-android-build: %s\n' "$1" >&2
  exit 1
}

build_root_arg=
metro_workers=4
while (($# > 0)); do
  case "$1" in
    --build-root)
      (($# >= 2)) || fail "missing value for --build-root"
      [[ -z "$build_root_arg" ]] || fail "--build-root may only be specified once"
      build_root_arg=$2
      shift 2
      ;;
    --metro-workers)
      (($# >= 2)) || fail "missing value for --metro-workers"
      metro_workers=$2
      shift 2
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ -n "$build_root_arg" ]] || {
  printf '%s\n' '--build-root is required.' >&2
  usage >&2
  exit 2
}
[[ "$metro_workers" =~ ^[0-9]+$ ]] || fail "Metro worker count must be an integer: $metro_workers"
metro_workers=$((10#$metro_workers))
((metro_workers >= 1 && metro_workers <= 32)) ||
  fail "Metro worker count must be in 1..32: $metro_workers"
[[ -d "$build_root_arg" ]] || fail "build root is not a directory: $build_root_arg"
build_root=$(realpath -e -- "$build_root_arg")

app_gradle="$build_root/packages/app/android/app/build.gradle"
expo_resolve_args="$build_root/node_modules/@expo/cli/build/src/utils/resolveArgs.js"
bundle_task="$build_root/node_modules/@react-native/gradle-plugin/react-native-gradle-plugin/src/main/kotlin/com/facebook/react/tasks/BundleHermesCTask.kt"

[[ -f "$app_gradle" ]] ||
  fail "generated app/build.gradle is missing; run Expo prebuild first: $app_gradle"
[[ -f "$expo_resolve_args" ]] || fail "Expo CLI argument resolver is missing: $expo_resolve_args"
[[ -f "$bundle_task" ]] || fail "React Native bundle task source is missing: $bundle_task"

# React Native adds --reset-cache before extraPackagerArgs. Expo resolves duplicate
# boolean options from right to left, so the later "--reset-cache false" keeps the
# content-addressed Metro transform cache without reusing a stale final JS bundle.
node - "$expo_resolve_args" "$bundle_task" <<'NODE'
const fs = require("node:fs");

const resolveArgsPath = process.argv[2];
const bundleTaskPath = process.argv[3];
const { resolveCustomBooleanArgsAsync } = require(resolveArgsPath);

async function main() {
  const parsed = await resolveCustomBooleanArgsAsync(
    ["--reset-cache", "--reset-cache", "false"],
    {},
    { "--reset-cache": Boolean },
  );
  if (parsed.args["--reset-cache"] !== false) {
    throw new Error("installed Expo CLI no longer lets the later false value override --reset-cache");
  }

  const taskSource = fs.readFileSync(bundleTaskPath, "utf8");
  const hardReset = taskSource.indexOf('add("--reset-cache")');
  const extraArgs = taskSource.indexOf("addAll(extraPackagerArgs.get())");
  if (extraArgs < 0) {
    throw new Error("React Native bundle task no longer appends extraPackagerArgs");
  }
  if (hardReset >= 0 && extraArgs < hardReset) {
    throw new Error("React Native now appends extraPackagerArgs before --reset-cache; override would be ineffective");
  }
}

main().catch((error) => {
  console.error(`configure-android-build: compatibility check failed: ${error.message}`);
  process.exit(1);
});
NODE

node - "$app_gradle" "$metro_workers" <<'NODE'
const fs = require("node:fs");

const gradlePath = process.argv[2];
const workers = process.argv[3];
const source = fs.readFileSync(gradlePath, "utf8");
const assignmentStart = /^[ \t]*extraPackagerArgs\s*=/gm;
const assignments = [...source.matchAll(assignmentStart)];

if (assignments.length > 1) {
  throw new Error(`expected at most one active extraPackagerArgs assignment, found ${assignments.length}`);
}

const assignmentLine = /^([ \t]*)extraPackagerArgs\s*=\s*\[[^\r\n]*\][ \t]*$/gm;
const desiredForIndent = (indent) =>
  `${indent}extraPackagerArgs = ["--reset-cache", "false", "--max-workers", "${workers}"]`;
let next = source;

if (assignments.length === 1) {
  const lines = [...source.matchAll(assignmentLine)];
  if (lines.length !== 1 || lines[0].index !== assignments[0].index) {
    throw new Error("extraPackagerArgs uses an unsupported multi-line or computed assignment");
  }
  next = source.replace(assignmentLine, (_line, indent) => desiredForIndent(indent));
} else {
  const bundleLine = /^([ \t]*)bundleCommand\s*=\s*["']export:embed["'][ \t]*$/gm;
  const bundleMatches = [...source.matchAll(bundleLine)];
  if (bundleMatches.length !== 1) {
    throw new Error(`expected one Expo export:embed bundleCommand, found ${bundleMatches.length}`);
  }
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  next = source.replace(bundleLine, (line, indent) => `${line}${eol}${desiredForIndent(indent)}`);
}

const desiredCount = [...next.matchAll(/^[ \t]*extraPackagerArgs\s*=\s*\["--reset-cache", "false", "--max-workers", "[0-9]+"\][ \t]*$/gm)].length;
if (desiredCount !== 1) {
  throw new Error(`failed to produce exactly one optimized extraPackagerArgs assignment (found ${desiredCount})`);
}

if (next === source) {
  console.log(`✅ Android Metro already configured: cache kept, workers=${workers}`);
} else {
  fs.writeFileSync(gradlePath, next);
  console.log(`✅ Android Metro configured: cache kept, workers=${workers}`);
}
NODE
