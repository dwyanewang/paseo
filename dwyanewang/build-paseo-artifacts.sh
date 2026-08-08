#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: bash dwyanewang/build-paseo-artifacts.sh --build-root PATH \
  (--preflight-state PATH | --skip-preflight) [options]

Build and verify the Paseo server, Android ARM64 APK, and Windows x64 zip from
the dedicated product worktree. The script owns stage logging, Android resource
profiles, terminal-webview cleanup, final artifact verification, and the
download service.

  --build-root PATH       Dedicated product build worktree (required).
  --preflight-state PATH  State written by prepare-rw-main-for-build.sh.
  --skip-preflight        Build the current clean checkout without synchronizing.
  --run-dir PATH          New directory for logs and the sourceable result file.
  --download-port PORT    Download service port (default: 8800).
  --download-ttl SECONDS  Download service lifetime (default: 10800).
  --no-serve-dist         Build artifacts without starting the download service.
  --help                  Show this help.

Exactly one of --preflight-state and --skip-preflight is required. The normal
build-paseo flow uses --preflight-state; --skip-preflight is only for an
explicit user request to build the current checkout without syncing.
EOF
}

fail() {
  printf 'build-paseo-artifacts: %s\n' "$1" >&2
  exit "${2:-1}"
}

build_root_arg=
preflight_state_arg=
skip_preflight=0
run_dir_arg=
download_port=8800
download_ttl=10800
serve_dist=1

while (($# > 0)); do
  case "$1" in
    --build-root)
      (($# >= 2)) || fail "missing value for --build-root" 2
      [[ -z "$build_root_arg" ]] || fail "--build-root may only be specified once" 2
      build_root_arg=$2
      shift 2
      ;;
    --preflight-state)
      (($# >= 2)) || fail "missing value for --preflight-state" 2
      [[ -z "$preflight_state_arg" ]] ||
        fail "--preflight-state may only be specified once" 2
      preflight_state_arg=$2
      shift 2
      ;;
    --skip-preflight)
      skip_preflight=1
      shift
      ;;
    --run-dir)
      (($# >= 2)) || fail "missing value for --run-dir" 2
      [[ -z "$run_dir_arg" ]] || fail "--run-dir may only be specified once" 2
      run_dir_arg=$2
      shift 2
      ;;
    --download-port)
      (($# >= 2)) || fail "missing value for --download-port" 2
      download_port=$2
      shift 2
      ;;
    --download-ttl)
      (($# >= 2)) || fail "missing value for --download-ttl" 2
      download_ttl=$2
      shift 2
      ;;
    --no-serve-dist)
      serve_dist=0
      shift
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
  usage >&2
  fail "--build-root is required" 2
}
if [[ -n "$preflight_state_arg" ]] && ((skip_preflight)); then
  fail "--preflight-state and --skip-preflight are mutually exclusive" 2
fi
if [[ -z "$preflight_state_arg" ]] && ((skip_preflight == 0)); then
  fail "exactly one of --preflight-state and --skip-preflight is required" 2
fi
[[ "$download_port" =~ ^[0-9]+$ ]] || fail "download port must be numeric: $download_port" 2
[[ "$download_ttl" =~ ^[0-9]+$ ]] || fail "download TTL must be numeric: $download_ttl" 2
download_port=$((10#$download_port))
download_ttl=$((10#$download_ttl))
((download_port >= 1 && download_port <= 65535)) ||
  fail "download port must be in 1..65535: $download_port" 2
((download_port != 6767)) || fail "refusing to use the main daemon port 6767" 2
((download_ttl >= 1 && download_ttl <= 604800)) ||
  fail "download TTL must be in 1..604800: $download_ttl" 2

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
control_root=$(git -C "$script_dir/.." rev-parse --show-toplevel 2>/dev/null) ||
  fail "control script is not inside a Git worktree"
control_root=$(realpath -e -- "$control_root")
[[ -d "$build_root_arg" ]] || fail "build root is not a directory: $build_root_arg"
build_root=$(realpath -e -- "$build_root_arg")
build_repo_root=$(git -C "$build_root" rev-parse --show-toplevel 2>/dev/null) ||
  fail "build root is not a Git worktree: $build_root"
build_repo_root=$(realpath -e -- "$build_repo_root")
[[ "$build_root" == "$build_repo_root" ]] ||
  fail "--build-root must name the worktree root: $build_repo_root"
[[ "$build_root" != "$control_root" ]] ||
  fail "control and build worktrees must be distinct"

canonical_common_dir() {
  local root=$1 common_dir
  common_dir=$(git -C "$root" rev-parse --git-common-dir)
  if [[ "$common_dir" != /* ]]; then
    common_dir="$root/$common_dir"
  fi
  realpath -e -- "$common_dir"
}

[[ "$(canonical_common_dir "$control_root")" == "$(canonical_common_dir "$build_root")" ]] ||
  fail "control and build worktrees do not belong to the same Git repository"
control_branch=$(git -C "$control_root" symbolic-ref --quiet --short HEAD) ||
  fail "control worktree is detached: $control_root"
[[ "$control_branch" == chore/build-paseo ]] ||
  fail "control worktree must be on chore/build-paseo (current: $control_branch)"
[[ -z "$(git -C "$control_root" status --porcelain)" ]] ||
  fail "control worktree is not clean: $control_root"
build_branch=$(git -C "$build_root" symbolic-ref --quiet --short HEAD) ||
  fail "build worktree is detached: $build_root"
[[ -z "$(git -C "$build_root" status --porcelain)" ]] ||
  fail "build worktree is not clean: $build_root"

run_id=$(date +%Y%m%d-%H%M%S)-$$
if [[ -n "$run_dir_arg" ]]; then
  run_dir=$(realpath -m -- "$run_dir_arg")
else
  run_dir="$build_root/.dev/build-paseo-runs/$run_id"
fi
[[ ! -e "$run_dir" ]] || fail "run directory already exists: $run_dir"
mkdir -p -- "$run_dir"
full_log="$run_dir/build.log"
stage_log="$run_dir/stages.log"
exit_status_file="$run_dir/exit-status"
result_file="$run_dir/result.env"
: >"$full_log"
: >"$stage_log"

exec > >(tee -a "$full_log") 2>&1

started_epoch=$(date +%s)
terminal_webview=packages/app/src/terminal/webview/terminal-emulator-webview-html.ts
terminal_restore_needed=0

write_exit_status() {
  local status=$1 status_temp
  status_temp="${exit_status_file}.tmp.$$"
  printf '%s\n' "$status" >"$status_temp"
  mv -- "$status_temp" "$exit_status_file"
}

restore_terminal_webview() {
  ((terminal_restore_needed)) || return 0
  git -C "$build_root" restore --worktree -- "$terminal_webview"
  terminal_restore_needed=0
  [[ -z "$(git -C "$build_root" status --porcelain -- "$terminal_webview")" ]]
}

finish() {
  local status=$? restore_status=0
  trap - EXIT INT TERM
  set +e
  if ((terminal_restore_needed)); then
    git -C "$build_root" restore --worktree -- "$terminal_webview"
    restore_status=$?
    if ((restore_status == 0)); then
      terminal_restore_needed=0
      printf '%s\n' 'build-paseo-artifacts: restored terminal-webview after interruption.'
    else
      printf '%s\n' 'build-paseo-artifacts: failed to restore terminal-webview.' >&2
      ((status != 0)) || status=1
    fi
  fi
  write_exit_status "$status"
  if ((status == 0)); then
    printf 'PASEO_ARTIFACT_BUILD_STATUS=ready\n'
  else
    rm -f -- "$result_file"
    printf 'PASEO_ARTIFACT_BUILD_STATUS=failed\n' >&2
  fi
  printf 'PASEO_BUILD_RUN_DIR=%s\nPASEO_BUILD_LOG=%s\nPASEO_BUILD_EXIT_STATUS_FILE=%s\n' \
    "$run_dir" "$full_log" "$exit_status_file"
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

stage() {
  local line
  printf -v line '[%s] %s' "$(date '+%Y-%m-%d %H:%M:%S %z')" "$1"
  printf '%s\n' "$line"
  printf '%s\n' "$line" >>"$stage_log"
}

printf 'PASEO_BUILD_RUN_DIR=%s\nPASEO_BUILD_LOG=%s\nPASEO_BUILD_STAGE_LOG=%s\n' \
  "$run_dir" "$full_log" "$stage_log"

rw_main_rebuilt=0
dependencies_reinstalled=1
preflight_mode=skipped
if [[ -n "$preflight_state_arg" ]]; then
  preflight_state=$(realpath -e -- "$preflight_state_arg" 2>/dev/null) ||
    fail "preflight state does not exist: $preflight_state_arg"
  unset paseo_preflight_status rw_main_rebuilt dependencies_reinstalled rw_main_after
  # The file is written atomically by prepare-rw-main-for-build.sh and is a
  # sourceable shell state contract shared by the two versioned orchestrators.
  source "$preflight_state"
  [[ "${paseo_preflight_status:-}" == ready ]] ||
    fail "preflight state is not ready: $preflight_state"
  [[ "${rw_main_rebuilt:-}" =~ ^[01]$ ]] ||
    fail "invalid rw_main_rebuilt value in preflight state"
  [[ "${dependencies_reinstalled:-}" =~ ^[01]$ ]] ||
    fail "invalid dependencies_reinstalled value in preflight state"
  [[ "${rw_main_after:-}" =~ ^[0-9a-f]{40}$ ]] ||
    fail "invalid rw_main_after value in preflight state"
  [[ "$build_branch" == rw-main ]] ||
    fail "ready builds must use rw-main (current: $build_branch)"
  current_build_head=$(git -C "$build_root" rev-parse HEAD)
  [[ "$current_build_head" == "$rw_main_after" ]] ||
    fail "preflight state is stale: expected $rw_main_after, current $current_build_head"
  preflight_mode=ready-state
fi

stage "environment: activate repository-pinned mise toolchain"
cd "$build_root"
command -v mise >/dev/null || fail "mise is required"
mise install
eval "$(mise activate bash)"
[[ -n "${ANDROID_HOME:-}" ]] || fail "ANDROID_HOME was not set by the repository mise config"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
paseo_wineprefix=${PASEO_WINEPREFIX:-"${HOME:?}/.local/share/paseo/wineprefix"}
export WINEPREFIX="$paseo_wineprefix"
export PASEO_BUILD_ROOT="$build_root"

[[ -z "$(git status --porcelain -- "$terminal_webview")" ]] ||
  fail "terminal-webview has pre-existing changes: $build_root/$terminal_webview"

stage "prepare-build: clear exact old artifacts and write this run's marker"
bash "$control_root/dwyanewang/serve-dist.sh" prepare-build
terminal_restore_needed=1
stage "terminal-webview: regenerate embedded HTML"
(cd packages/app && npm run build:terminal-webview)

stage "server: build workspace artifacts"
if ((rw_main_rebuilt && !dependencies_reinstalled)); then
  npm run build:highlight
  npm run build --workspace=@getpaseo/server
  npm run build --workspace=@getpaseo/cli
  server_build_mode=incremental-after-rw-main-rebuild
else
  npm run build:server
  server_build_mode=full
fi
server_artifact="$build_root/packages/server/dist/server/server/exports.js"
cli_artifact="$build_root/packages/cli/dist/index.js"
[[ -s "$server_artifact" ]] || fail "server entry artifact is missing or empty: $server_artifact"
[[ -s "$cli_artifact" ]] || fail "CLI entry artifact is missing or empty: $cli_artifact"
compgen -G "$build_root/packages/protocol/dist/*.js" >/dev/null ||
  fail "protocol JavaScript artifacts are missing"
stage "server: CLI, server, and protocol artifacts verified"

resource_profile_dir="$build_root/.dev/build-profiles/$run_id"
stage "android: Expo prebuild"
(cd packages/app && CI=1 npx cross-env APP_VARIANT=production expo prebuild --platform android)
stage "android: configure Metro 8 workers and local-balanced Hermes"
bash "$control_root/dwyanewang/configure-android-build.sh" \
  --build-root "$build_root" \
  --metro-workers 8 \
  --hermes-profile local-balanced

stage "android: Metro/Hermes first phase (profile: $resource_profile_dir)"
(
  cd packages/app/android
  bash "$control_root/dwyanewang/profile-build-resources.sh" \
    --label android-metro-hermes \
    --output-dir "$resource_profile_dir" \
    -- ./gradlew :app:createBundleReleaseJsAndAssets \
    --no-daemon --no-parallel --max-workers=1 \
    -Dorg.gradle.jvmargs="-Xmx2g -XX:MaxMetaspaceSize=768m" \
    -PreactNativeArchitectures=arm64-v8a
)
android_bundle="$build_root/packages/app/android/app/build/generated/assets/createBundleReleaseJsAndAssets/index.android.bundle"
[[ -s "$android_bundle" ]] || fail "Android bundle is missing or empty: $android_bundle"

stage "android: ARM64 native assemble second phase"
(
  cd packages/app/android
  bash "$control_root/dwyanewang/profile-build-resources.sh" \
    --label android-native-assemble \
    --output-dir "$resource_profile_dir" \
    -- ./gradlew assembleRelease \
    --no-daemon --parallel --max-workers=8 \
    -Dorg.gradle.jvmargs="-Xmx4g -XX:MaxMetaspaceSize=1024m" \
    -PreactNativeArchitectures=arm64-v8a
)
native_transcript="$resource_profile_dir/android-native-assemble.transcript.log"
grep -F '> Task :app:createBundleReleaseJsAndAssets UP-TO-DATE' "$native_transcript" >/dev/null ||
  fail "second Android phase did not keep the bundle producer UP-TO-DATE: $native_transcript"
apk_artifact="$build_root/packages/app/android/app/build/outputs/apk/release/app-release.apk"
[[ -s "$apk_artifact" ]] || fail "Android APK is missing or empty: $apk_artifact"
stage "android: APK and second-phase bundle producer verified"

stage "windows: build two-way-audio"
export PYTHONPATH= PYTHONHOME= WINEDEBUG=-all CI=1
npm run build --workspace=@getpaseo/expo-two-way-audio
stage "windows: export Electron web bundle"
(cd packages/app && PASEO_WEB_PLATFORM=electron npx expo export --platform web)
stage "windows: compile Electron main process"
npm run build:main --workspace=@getpaseo/desktop
stage "windows: package x64 zip with compression level 3"
(
  cd packages/desktop
  ELECTRON_BUILDER_COMPRESSION_LEVEL=3 \
    npx electron-builder --config electron-builder.yml --win zip --x64 --publish never
)

version=$(node -e '
  const pkg = require(process.argv[1]);
  if (typeof pkg.version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(pkg.version)) process.exit(1);
  process.stdout.write(pkg.version);
' "$build_root/package.json") || fail "could not read a safe package version"
zip_artifact="$build_root/packages/desktop/release/Paseo-Setup-${version}-x64.zip"
[[ -s "$zip_artifact" ]] || fail "Windows zip is missing or empty: $zip_artifact"
stage "windows: x64 zip verified"

restore_terminal_webview
stage "cleanup: terminal-webview restored"
[[ -z "$(git -C "$build_root" status --porcelain)" ]] ||
  fail "build worktree is not clean after artifact generation: $build_root"
[[ -z "$(git -C "$control_root" status --porcelain)" ]] ||
  fail "control worktree changed during artifact generation: $control_root"

download_service_started=0
if ((serve_dist)); then
  stage "serve-dist: start download service"
  bash "$control_root/dwyanewang/serve-dist.sh" "$download_port" "$download_ttl"
  download_service_started=1
fi

finished_epoch=$(date +%s)
total_seconds=$((finished_epoch - started_epoch))
metro_summary="$resource_profile_dir/android-metro-hermes.summary"
native_summary="$resource_profile_dir/android-native-assemble.summary"
stat --printf='PASEO_ARTIFACT_STAT=%n|%s|%y\n' \
  "$server_artifact" "$apk_artifact" "$zip_artifact"
summary_keys=(
  exit_status
  systemd_cleanup_degraded
  command_wall_seconds
  average_cpu_cores
  host_cpu_percent
  peak_sampled_cpu_cores
  memory_peak_bytes
  swap_peak_bytes
)
for summary in "$metro_summary" "$native_summary"; do
  [[ -s "$summary" ]] || fail "Android resource summary is missing or empty: $summary"
  for summary_key in "${summary_keys[@]}"; do
    grep -q "^${summary_key}=" "$summary" ||
      fail "Android resource summary is missing $summary_key: $summary"
  done
  grep -q '^exit_status=0$' "$summary" ||
    fail "Android resource summary recorded a failed command: $summary"
  printf 'PASEO_ANDROID_SUMMARY_BEGIN=%s\n' "$summary"
  grep -E '^(command_wall_seconds|average_cpu_cores|peak_sampled_cpu_cores|host_cpu_percent|memory_peak_bytes|swap_peak_bytes|exit_status|systemd_cleanup_degraded)=' \
    "$summary"
  printf 'PASEO_ANDROID_SUMMARY_END=%s\n' "$summary"
done

result_temp=$(mktemp "${result_file}.tmp.XXXXXX")
{
  printf 'paseo_artifact_build_status=%q\n' ready
  printf 'paseo_artifact_build_version=%q\n' "$version"
  printf 'paseo_artifact_build_root=%q\n' "$build_root"
  printf 'paseo_artifact_build_run_dir=%q\n' "$run_dir"
  printf 'paseo_artifact_build_log=%q\n' "$full_log"
  printf 'paseo_artifact_stage_log=%q\n' "$stage_log"
  printf 'paseo_artifact_exit_status_file=%q\n' "$exit_status_file"
  printf 'paseo_artifact_total_seconds=%q\n' "$total_seconds"
  printf 'paseo_artifact_preflight_mode=%q\n' "$preflight_mode"
  printf 'paseo_artifact_server_build_mode=%q\n' "$server_build_mode"
  printf 'paseo_artifact_server=%q\n' "$server_artifact"
  printf 'paseo_artifact_apk=%q\n' "$apk_artifact"
  printf 'paseo_artifact_windows_zip=%q\n' "$zip_artifact"
  printf 'paseo_artifact_android_profile_dir=%q\n' "$resource_profile_dir"
  printf 'paseo_artifact_android_metro_summary=%q\n' "$metro_summary"
  printf 'paseo_artifact_android_native_summary=%q\n' "$native_summary"
  printf 'paseo_artifact_download_service_started=%q\n' "$download_service_started"
  printf 'paseo_artifact_download_port=%q\n' "$download_port"
  printf 'paseo_artifact_download_ttl=%q\n' "$download_ttl"
} >"$result_temp"
chmod 600 "$result_temp"
mv -- "$result_temp" "$result_file"

stage "complete: server, Android, Windows, cleanup, and requested distribution succeeded"
printf 'PASEO_ARTIFACT_BUILD_VERSION=%s\n' "$version"
printf 'PASEO_ARTIFACT_BUILD_TOTAL_SECONDS=%s\n' "$total_seconds"
printf 'PASEO_ARTIFACT_SERVER=%s\n' "$server_artifact"
printf 'PASEO_ARTIFACT_APK=%s\n' "$apk_artifact"
printf 'PASEO_ARTIFACT_WINDOWS_ZIP=%s\n' "$zip_artifact"
printf 'PASEO_ANDROID_PROFILE_DIR=%s\n' "$resource_profile_dir"
printf 'PASEO_ARTIFACT_RESULT_FILE=%s\n' "$result_file"
