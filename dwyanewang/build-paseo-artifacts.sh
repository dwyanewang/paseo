#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: bash dwyanewang/build-paseo-artifacts.sh --build-root PATH \
  (--preflight-state PATH | --skip-preflight) [options]

Build and verify the Paseo server, Android ARM64 APK, and Windows x64 zip from
the dedicated product worktree. The script owns stage logging, resource
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
parallel_min_available_bytes=${PASEO_BUILD_PARALLEL_MIN_AVAILABLE_BYTES:-17179869184}

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
[[ "$parallel_min_available_bytes" =~ ^[0-9]+$ ]] ||
  fail "parallel minimum available memory must be numeric: $parallel_min_available_bytes" 2
parallel_min_available_bytes=$((10#$parallel_min_available_bytes))

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

for required_command in flock setsid; do
  command -v "$required_command" >/dev/null || fail "$required_command is required"
done
mkdir -p -- "$build_root/.dev"
build_lock_file="$build_root/.dev/build-paseo-artifacts.lock"
exec {build_lock_fd}>"$build_lock_file"
flock -n "$build_lock_fd" ||
  fail "another build-paseo workflow already owns the build root: $build_root"

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
control_start_head=$(git -C "$control_root" rev-parse HEAD)
build_start_head=$(git -C "$build_root" rev-parse HEAD)

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
distribution_cleanup_needed=0
result_temp=
android_native_pid=
windows_pid=
android_native_log="$run_dir/android-native-assemble.branch.log"
windows_log="$run_dir/windows-artifacts.branch.log"
android_native_bundle_gate=not-checked
artifact_parallel_mode=not-evaluated
mem_available_bytes=0

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

terminate_branch_group() {
  local pid=$1
  [[ -n "$pid" ]] || return 0
  # Let the profile wrapper handle TERM first so its EXIT trap can stop the
  # transient systemd cgroup. Killing the whole process group immediately can
  # kill systemd-run/tee before that cleanup reaches the unit.
  kill -TERM -- "$pid" 2>/dev/null || true
  for _ in {1..30}; do
    if ! kill -0 -- "$pid" 2>/dev/null; then
      kill -TERM -- "-$pid" 2>/dev/null || true
      return 0
    fi
    sleep 0.1
  done
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in {1..10}; do
    kill -0 -- "-$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -KILL -- "-$pid" 2>/dev/null || true
}

stop_active_branches() {
  local pid
  for pid in "$android_native_pid" "$windows_pid"; do
    terminate_branch_group "$pid"
  done
  for pid in "$android_native_pid" "$windows_pid"; do
    [[ -n "$pid" ]] && wait "$pid" >/dev/null 2>&1 || true
  done
  android_native_pid=
  windows_pid=
}

finish() {
  local status=$? restore_status=0
  trap - EXIT INT TERM
  set +e
  stop_active_branches
  if ((status != 0 && distribution_cleanup_needed)); then
    (
      eval "exec ${build_lock_fd}>&-"
      exec bash "$control_root/dwyanewang/serve-dist.sh" stop
    ) || printf '%s\n' 'build-paseo-artifacts: failed to stop distribution after a late build failure.' >&2
    distribution_cleanup_needed=0
  fi
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
    [[ -z "$result_temp" ]] || rm -f -- "$result_temp"
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

print_branch_log() {
  local label=$1 log_file=$2
  printf 'PASEO_PARALLEL_BRANCH_LOG_BEGIN=%s|%s\n' "$label" "$log_file"
  if [[ -f "$log_file" ]]; then
    cat -- "$log_file"
  else
    printf 'build-paseo-artifacts: branch log is missing: %s\n' "$log_file" >&2
  fi
  printf 'PASEO_PARALLEL_BRANCH_LOG_END=%s|%s\n' "$label" "$log_file"
}

launch_android_native_branch() {
  (
    cd "$build_root/packages/app/android"
    eval "exec ${build_lock_fd}>&-"
    exec setsid bash "$control_root/dwyanewang/profile-build-resources.sh" \
      --label android-native-assemble \
      --output-dir "$resource_profile_dir" \
      -- ./gradlew assembleRelease \
      --console=plain --no-daemon --parallel --max-workers=8 \
      -Dorg.gradle.jvmargs="-Xmx4g -XX:MaxMetaspaceSize=1024m" \
      -PreactNativeArchitectures=arm64-v8a
  ) >"$android_native_log" 2>&1 &
  android_native_pid=$!
}

launch_windows_branch() {
  (
    cd "$build_root"
    eval "exec ${build_lock_fd}>&-"
    exec setsid bash "$control_root/dwyanewang/profile-build-resources.sh" \
      --label windows-artifacts \
      --output-dir "$resource_profile_dir" \
      -- bash -c '
        set -Eeuo pipefail
        build_root=$1
        cd "$build_root"
        windows_stage() {
          printf "[%s] windows: %s\n" "$(date "+%Y-%m-%d %H:%M:%S %z")" "$1"
        }
        windows_stage "build two-way-audio"
        npm run build --workspace=@getpaseo/expo-two-way-audio
        windows_stage "export Electron web bundle"
        (cd packages/app && PASEO_WEB_PLATFORM=electron npx expo export --platform web)
        windows_stage "compile Electron main process"
        npm run build:main --workspace=@getpaseo/desktop
        windows_stage "package x64 zip with compression level 3"
        (
          cd packages/desktop
          ELECTRON_BUILDER_COMPRESSION_LEVEL=3 \
            npx electron-builder --config electron-builder.yml --win zip --x64 --publish never
        )
      ' paseo-windows "$build_root"
  ) >"$windows_log" 2>&1 &
  windows_pid=$!
}

wait_for_active_branches() {
  local completed_pid completed_status completed_name first_failure=0 first_failure_name=
  local -a active_pids

  while [[ -n "$android_native_pid" || -n "$windows_pid" ]]; do
    active_pids=()
    [[ -n "$android_native_pid" ]] && active_pids+=("$android_native_pid")
    [[ -n "$windows_pid" ]] && active_pids+=("$windows_pid")
    completed_pid=
    set +e
    wait -n -p completed_pid "${active_pids[@]}"
    completed_status=$?
    set -e

    case "${completed_pid:-}" in
      "$android_native_pid")
        completed_name=android-native-assemble
        android_native_pid=
        ;;
      "$windows_pid")
        completed_name=windows-artifacts
        windows_pid=
        ;;
      *)
        completed_name=unknown
        ((first_failure != 0)) || first_failure=1
        [[ -n "$first_failure_name" ]] || first_failure_name=wait-controller
        stop_active_branches
        break
        ;;
    esac

    stage "parallel: $completed_name exited with status $completed_status"
    if ((completed_status != 0 && first_failure == 0)); then
      first_failure=$completed_status
      first_failure_name=$completed_name
      stage "parallel: $completed_name failed; terminate the sibling process group"
      terminate_branch_group "$android_native_pid"
      terminate_branch_group "$windows_pid"
      if [[ -n "$android_native_pid" ]]; then
        set +e
        wait "$android_native_pid"
        completed_status=$?
        set -e
        stage "parallel: terminated android-native-assemble sibling exited with status $completed_status"
        android_native_pid=
      fi
      if [[ -n "$windows_pid" ]]; then
        set +e
        wait "$windows_pid"
        completed_status=$?
        set -e
        stage "parallel: terminated windows-artifacts sibling exited with status $completed_status"
        windows_pid=
      fi
    fi
  done

  if ((first_failure != 0)); then
    printf 'build-paseo-artifacts: parallel branch failed: %s (status %s)\n' \
      "$first_failure_name" "$first_failure" >&2
    return "$first_failure"
  fi
}

wait_for_android_bundle_gate() {
  local observed_line native_status
  local task_line='> Task :app:createBundleReleaseJsAndAssets'
  local gate_line='> Task :app:createBundleReleaseJsAndAssets UP-TO-DATE'

  while :; do
    observed_line=$(
      awk -v task="$task_line" '
        $0 == task || index($0, task " ") == 1 { print; exit }
      ' "$android_native_log"
    )
    if [[ "$observed_line" == "$gate_line" ]]; then
      android_native_bundle_gate=up-to-date
      stage "android: second-phase bundle producer is UP-TO-DATE; Windows may start"
      return 0
    fi
    if [[ -n "$observed_line" ]]; then
      android_native_bundle_gate=not-up-to-date
      stage "android: second-phase bundle producer is not UP-TO-DATE; stop before Windows"
      terminate_branch_group "$android_native_pid"
      if wait "$android_native_pid"; then
        native_status=0
      else
        native_status=$?
      fi
      android_native_pid=
      printf 'build-paseo-artifacts: second Android phase attempted to rerun the bundle producer: %s\n' \
        "$observed_line" >&2
      return 1
    fi
    kill -0 "$android_native_pid" 2>/dev/null || break
    sleep 0.05
  done

  # The process may have written its last line immediately before exiting.
  observed_line=$(
    awk -v task="$task_line" '
      $0 == task || index($0, task " ") == 1 { print; exit }
    ' "$android_native_log"
  )
  if [[ "$observed_line" == "$gate_line" ]]; then
    android_native_bundle_gate=up-to-date
    stage "android: second-phase bundle producer is UP-TO-DATE; Windows may start"
    return 0
  fi
  if [[ -n "$observed_line" ]]; then
    android_native_bundle_gate=not-up-to-date
    if wait "$android_native_pid"; then
      native_status=0
    else
      native_status=$?
    fi
    android_native_pid=
    printf 'build-paseo-artifacts: second Android phase attempted to rerun the bundle producer: %s\n' \
      "$observed_line" >&2
    return 1
  fi

  if wait "$android_native_pid"; then
    native_status=0
  else
    native_status=$?
  fi
  android_native_pid=
  if ((native_status != 0)); then
    android_native_bundle_gate=native-failed-before-gate
    stage "android: native branch failed before the bundle producer gate (status $native_status)"
    return "$native_status"
  fi
  android_native_bundle_gate=missing
  printf '%s\n' \
    'build-paseo-artifacts: Android native branch completed without an UP-TO-DATE bundle producer gate' \
    >&2
  return 1
}

read_mem_available_bytes() {
  awk '$1 == "MemAvailable:" { printf "%.0f\n", $2 * 1024; found = 1; exit } END { if (!found) exit 1 }' \
    /proc/meminfo
}

run_profiled_artifact_branches() {
  local status=0
  launch_android_native_branch
  if wait_for_android_bundle_gate; then
    status=0
  else
    status=$?
  fi

  if ((status == 0)); then
    mem_available_bytes=$(read_mem_available_bytes) ||
      fail "could not read MemAvailable from /proc/meminfo"
    if ((mem_available_bytes >= parallel_min_available_bytes)); then
      artifact_parallel_mode=concurrent
      stage "artifact branches: concurrent mode after bundle gate (MemAvailable=$mem_available_bytes, minimum=$parallel_min_available_bytes)"
    else
      artifact_parallel_mode=serial-low-memory
      stage "artifact branches: serial low-memory fallback after bundle gate (MemAvailable=$mem_available_bytes, minimum=$parallel_min_available_bytes)"
    fi
  fi

  if ((status == 0)) && [[ "$artifact_parallel_mode" == concurrent ]]; then
    launch_windows_branch
    if wait_for_active_branches; then
      status=0
    else
      status=$?
    fi
  elif ((status == 0)); then
    if wait_for_active_branches; then
      status=0
    else
      status=$?
    fi
    if ((status == 0)); then
      launch_windows_branch
      if wait_for_active_branches; then
        status=0
      else
        status=$?
      fi
    fi
  fi

  stage "artifact branches: replay isolated logs"
  print_branch_log android-native-assemble "$android_native_log"
  print_branch_log windows-artifacts "$windows_log"
  return "$status"
}

printf 'PASEO_BUILD_RUN_DIR=%s\nPASEO_BUILD_LOG=%s\nPASEO_BUILD_STAGE_LOG=%s\n' \
  "$run_dir" "$full_log" "$stage_log"

rw_main_rebuilt=0
dependencies_reinstalled=1
preflight_mode=skipped
if [[ -n "$preflight_state_arg" ]]; then
  preflight_state=$(realpath -e -- "$preflight_state_arg" 2>/dev/null) ||
    fail "preflight state does not exist: $preflight_state_arg"
  unset paseo_preflight_status rw_main_rebuilt dependencies_reinstalled rw_main_after main_after control_head
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
  [[ "${main_after:-}" =~ ^[0-9a-f]{40}$ ]] ||
    fail "invalid main_after value in preflight state"
  [[ "${control_head:-}" =~ ^[0-9a-f]{40}$ ]] ||
    fail "invalid control_head value in preflight state"
  [[ "$build_branch" == rw-main ]] ||
    fail "ready builds must use rw-main (current: $build_branch)"
  current_build_head=$(git -C "$build_root" rev-parse HEAD)
  [[ "$current_build_head" == "$rw_main_after" ]] ||
    fail "preflight state is stale: expected $rw_main_after, current $current_build_head"
  current_main_head=$(git -C "$control_root" rev-parse --verify refs/heads/main)
  [[ "$current_main_head" == "$main_after" ]] ||
    fail "preflight state is stale: main expected $main_after, current $current_main_head"
  current_control_head=$(git -C "$control_root" rev-parse HEAD)
  [[ "$current_control_head" == "$control_head" ]] ||
    fail "preflight state is stale: control expected $control_head, current $current_control_head"
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

export PYTHONPATH= PYTHONHOME= WINEDEBUG=-all CI=1
stage "artifact branches: launch Android ARM64 native assemble; gate Windows on the bundle producer"
printf 'PASEO_PARALLEL_BRANCH_LOG=android-native-assemble|%s\n' "$android_native_log"
printf 'PASEO_PARALLEL_BRANCH_LOG=windows-artifacts|%s\n' "$windows_log"
run_profiled_artifact_branches

native_transcript="$resource_profile_dir/android-native-assemble.transcript.log"
grep -Fx '> Task :app:createBundleReleaseJsAndAssets UP-TO-DATE' "$native_transcript" >/dev/null ||
  fail "second Android phase did not keep the bundle producer UP-TO-DATE: $native_transcript"
apk_artifact="$build_root/packages/app/android/app/build/outputs/apk/release/app-release.apk"
[[ -s "$apk_artifact" ]] || fail "Android APK is missing or empty: $apk_artifact"
stage "android: APK and second-phase bundle producer verified"

version=$(node -e '
  const pkg = require(process.argv[1]);
  if (typeof pkg.version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(pkg.version)) process.exit(1);
  process.stdout.write(pkg.version);
' "$build_root/package.json") || fail "could not read a safe package version"
zip_artifact="$build_root/packages/desktop/release/Paseo-Setup-${version}-x64.zip"
[[ -s "$zip_artifact" ]] || fail "Windows zip is missing or empty: $zip_artifact"
stage "windows: profiled x64 zip verified"

restore_terminal_webview
stage "cleanup: terminal-webview restored"
[[ -z "$(git -C "$build_root" status --porcelain)" ]] ||
  fail "build worktree is not clean after artifact generation: $build_root"
[[ -z "$(git -C "$control_root" status --porcelain)" ]] ||
  fail "control worktree changed during artifact generation: $control_root"
[[ "$(git -C "$control_root" rev-parse HEAD)" == "$control_start_head" ]] ||
  fail "control HEAD changed during artifact generation: $control_root"
[[ "$(git -C "$build_root" rev-parse HEAD)" == "$build_start_head" ]] ||
  fail "build HEAD changed during artifact generation: $build_root"
if [[ "$preflight_mode" == ready-state ]]; then
  [[ "$(git -C "$control_root" rev-parse refs/heads/main)" == "$main_after" ]] ||
    fail "main moved during artifact generation; rerun preflight"
fi

download_service_started=0
metro_summary="$resource_profile_dir/android-metro-hermes.summary"
native_summary="$resource_profile_dir/android-native-assemble.summary"
windows_summary="$resource_profile_dir/windows-artifacts.summary"
windows_transcript="$resource_profile_dir/windows-artifacts.transcript.log"
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
  minimum_host_mem_available_bytes
)
for summary in "$metro_summary" "$native_summary" "$windows_summary"; do
  [[ -s "$summary" ]] || fail "resource summary is missing or empty: $summary"
  for summary_key in "${summary_keys[@]}"; do
    grep -q "^${summary_key}=" "$summary" ||
      fail "resource summary is missing $summary_key: $summary"
  done
  grep -q '^exit_status=0$' "$summary" ||
    fail "resource summary recorded a failed command: $summary"
  if [[ "$summary" == "$windows_summary" ]]; then
    summary_platform=WINDOWS
  else
    summary_platform=ANDROID
  fi
  printf 'PASEO_%s_SUMMARY_BEGIN=%s\n' "$summary_platform" "$summary"
  grep -E '^(command_wall_seconds|average_cpu_cores|peak_sampled_cpu_cores|host_cpu_percent|memory_peak_bytes|swap_peak_bytes|minimum_host_mem_available_bytes|exit_status|systemd_cleanup_degraded)=' \
    "$summary"
  printf 'PASEO_%s_SUMMARY_END=%s\n' "$summary_platform" "$summary"
done

if ((serve_dist)); then
  stage "serve-dist: start download service"
  # The long-lived download server must not inherit the artifact-build lock.
  (
    eval "exec ${build_lock_fd}>&-"
    exec bash "$control_root/dwyanewang/serve-dist.sh" "$download_port" "$download_ttl"
  )
  download_service_started=1
  distribution_cleanup_needed=1
fi

finished_epoch=$(date +%s)
total_seconds=$((finished_epoch - started_epoch))

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
  printf 'paseo_artifact_windows_profile_dir=%q\n' "$resource_profile_dir"
  printf 'paseo_artifact_windows_summary=%q\n' "$windows_summary"
  printf 'paseo_artifact_windows_transcript=%q\n' "$windows_transcript"
  printf 'paseo_artifact_parallel_mode=%q\n' "$artifact_parallel_mode"
  printf 'paseo_artifact_android_native_bundle_gate=%q\n' "$android_native_bundle_gate"
  printf 'paseo_artifact_parallel_mem_available_bytes=%q\n' "$mem_available_bytes"
  printf 'paseo_artifact_parallel_min_available_bytes=%q\n' "$parallel_min_available_bytes"
  printf 'paseo_artifact_android_native_branch_log=%q\n' "$android_native_log"
  printf 'paseo_artifact_windows_branch_log=%q\n' "$windows_log"
  printf 'paseo_artifact_download_service_started=%q\n' "$download_service_started"
  printf 'paseo_artifact_download_port=%q\n' "$download_port"
  printf 'paseo_artifact_download_ttl=%q\n' "$download_ttl"
} >"$result_temp"
chmod 600 "$result_temp"
mv -- "$result_temp" "$result_file"
distribution_cleanup_needed=0

stage "complete: server, Android, Windows, cleanup, and requested distribution succeeded"
printf 'PASEO_ARTIFACT_BUILD_VERSION=%s\n' "$version"
printf 'PASEO_ARTIFACT_BUILD_TOTAL_SECONDS=%s\n' "$total_seconds"
printf 'PASEO_ARTIFACT_SERVER=%s\n' "$server_artifact"
printf 'PASEO_ARTIFACT_APK=%s\n' "$apk_artifact"
printf 'PASEO_ARTIFACT_WINDOWS_ZIP=%s\n' "$zip_artifact"
printf 'PASEO_ANDROID_PROFILE_DIR=%s\n' "$resource_profile_dir"
printf 'PASEO_WINDOWS_PROFILE_DIR=%s\n' "$resource_profile_dir"
printf 'PASEO_ARTIFACT_RESULT_FILE=%s\n' "$result_file"
