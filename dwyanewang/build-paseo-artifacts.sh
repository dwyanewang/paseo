#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: bash dwyanewang/build-paseo-artifacts.sh --build-root PATH \
  (--preflight-state PATH | --skip-preflight) [options]

Build and verify selected Paseo artifacts from the dedicated product worktree.
The default remains server + Android ARM64 APK + Windows x64 zip. The script
owns stage logging, resource profiles, temporary local overlays,
terminal-webview cleanup, final artifact verification, and the download service.

  --build-root PATH       Dedicated product build worktree (required).
  --preflight-state PATH  State written by prepare-rw-main-for-build.sh.
  --skip-preflight        Build the current clean checkout without synchronizing.
  --local-branch BRANCH   Temporarily merge a local branch for this build only.
                          Repeatable; requires --skip-preflight and never fetches,
                          changes the overlay manifest, or moves rw-main.
  --target TARGET         Artifact target: server, android, or windows. Repeatable;
                          desktop is accepted as an alias for windows. Default: all.
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
declare -a local_branches=()
declare -A requested_targets=()
target_option_seen=0
run_dir_arg=
download_port=8800
download_ttl=10800
serve_dist=1
parallel_min_available_bytes=${PASEO_BUILD_PARALLEL_MIN_AVAILABLE_BYTES:-17179869184}
windows_archive_retention_limit=3
windows_archive_count=0
windows_pruned_count=0

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
    --local-branch)
      (($# >= 2)) || fail "missing value for --local-branch" 2
      local_branches+=("$2")
      shift 2
      ;;
    --target)
      (($# >= 2)) || fail "missing value for --target" 2
      target_option_seen=1
      case "$2" in
        all)
          requested_targets[server]=1
          requested_targets[android]=1
          requested_targets[windows]=1
          ;;
        server | android | windows)
          requested_targets[$2]=1
          ;;
        desktop)
          requested_targets[windows]=1
          ;;
        *)
          fail "unknown build target: $2 (expected server, android, windows, or desktop)" 2
          ;;
      esac
      shift 2
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
if ((${#local_branches[@]} > 0)) && ((skip_preflight == 0)); then
  fail "--local-branch requires --skip-preflight" 2
fi
if ((target_option_seen == 0)); then
  requested_targets[server]=1
  requested_targets[android]=1
  requested_targets[windows]=1
fi
build_server_target=${requested_targets[server]:-0}
build_android_target=${requested_targets[android]:-0}
build_windows_target=${requested_targets[windows]:-0}
declare -a selected_target_names=()
((build_server_target)) && selected_target_names+=(server)
((build_android_target)) && selected_target_names+=(android)
((build_windows_target)) && selected_target_names+=(windows)
selected_targets_csv=$(IFS=,; printf '%s' "${selected_target_names[*]}")
((build_android_target || build_windows_target)) || serve_dist=0
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
state_helper="$control_root/dwyanewang/build-paseo-state.sh"
[[ -f "$state_helper" ]] || fail "missing build state helper: $state_helper"
source "$state_helper"
patched_dependencies_helper=${PASEO_PATCHED_DEPENDENCIES_HELPER:-"$control_root/dwyanewang/prepare-patched-dependencies.mjs"}
[[ -f "$patched_dependencies_helper" ]] ||
  fail "missing patched dependencies helper: $patched_dependencies_helper"
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

find_worktree_for_branch() {
  local branch_ref="refs/heads/$1"
  git -C "$control_root" worktree list --porcelain | awk -v wanted="$branch_ref" '
    /^worktree / {
      path = $0
      sub(/^worktree /, "", path)
    }
    /^branch / && $2 == wanted { print path }
  '
}

dependency_inputs_changed() {
  local old_ref=$1 new_ref=$2
  ! git -C "$build_root" diff --quiet "$old_ref..$new_ref" -- \
    package.json package-lock.json ':(glob)**/package.json' \
    ':(glob)patches/**' scripts/postinstall-patches.mjs
}

prune_windows_archives() {
  local current_archive=$1 release_dir inventory entry archive archive_name
  local retained_count=1

  release_dir=$(dirname -- "$current_archive")
  inventory=$(
    find "$release_dir" -maxdepth 1 -type f -name 'Paseo-Setup-*-x64.zip' \
      -printf '%T@ %p\n' | sort -k1,1nr -k2,2r
  ) || fail "could not enumerate Windows zip archives in $release_dir"

  windows_pruned_count=0
  if [[ -n "$inventory" ]]; then
    while IFS= read -r entry; do
      archive=${entry#* }
      [[ "$archive" == "$current_archive" ]] && continue
      archive_name=${archive##*/}
      [[ "$archive_name" =~ ^Paseo-Setup-[0-9A-Za-z][0-9A-Za-z.+-]*-x64\.zip$ ]] || continue
      if ((retained_count < windows_archive_retention_limit)); then
        ((retained_count += 1))
        continue
      fi
      rm -f -- "$archive"
      ((windows_pruned_count += 1))
      printf 'PASEO_ARTIFACT_WINDOWS_PRUNED=%s\n' "$archive"
    done <<<"$inventory"
  fi
  windows_archive_count=$retained_count
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
if ((${#local_branches[@]} > 0)); then
  [[ "$build_branch" == rw-main ]] ||
    fail "local overlay builds must start from rw-main (current: $build_branch)"
fi
control_start_head=$(git -C "$control_root" rev-parse HEAD)
build_start_head=$(git -C "$build_root" rev-parse HEAD)
build_base_branch=$build_branch
build_base_head=$build_start_head

declare -A seen_local_branches=()
declare -a local_branch_heads=()
for local_branch in "${local_branches[@]}"; do
  git check-ref-format --branch "$local_branch" >/dev/null ||
    fail "invalid local branch: $local_branch"
  case "$local_branch" in
    main | rw-base | rw-main | chore/build-paseo)
      fail "local overlay uses a reserved branch: $local_branch"
      ;;
  esac
  [[ -z "${seen_local_branches[$local_branch]:-}" ]] ||
    fail "duplicate --local-branch value: $local_branch" 2
  git -C "$build_root" show-ref --verify --quiet "refs/heads/$local_branch" ||
    fail "local overlay branch does not exist: $local_branch"
  local_worktree=$(find_worktree_for_branch "$local_branch")
  if [[ -n "$local_worktree" && -n "$(git -C "$local_worktree" status --porcelain)" ]]; then
    fail "worktree for local overlay branch is dirty: $local_worktree"
  fi
  seen_local_branches[$local_branch]=1
  local_branch_heads+=("$(git -C "$build_root" rev-parse "$local_branch")")
done

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
local_overlay_branch=
local_overlay_cleanup_needed=0
patched_dependencies_verified=0
android_native_pid=
windows_pid=
android_native_log="$run_dir/android-native-assemble.branch.log"
windows_log="$run_dir/windows-artifacts.branch.log"
android_native_bundle_gate=not-checked
artifact_parallel_mode=not-evaluated
mem_available_bytes=0

restore_local_overlay() {
  ((local_overlay_cleanup_needed)) || return 0
  local current_branch restore_status=0
  if git -C "$build_root" rev-parse --quiet --verify MERGE_HEAD >/dev/null; then
    git -C "$build_root" merge --abort || restore_status=$?
  fi
  current_branch=$(git -C "$build_root" symbolic-ref --quiet --short HEAD || true)
  if [[ "$current_branch" == "$local_overlay_branch" ]]; then
    git -C "$build_root" switch --quiet "$build_base_branch" || restore_status=$?
  elif [[ "$current_branch" != "$build_base_branch" ]]; then
    printf 'build-paseo-artifacts: local overlay cleanup found unexpected branch: %s\n' \
      "${current_branch:-detached}" >&2
    restore_status=1
  fi
  if git -C "$build_root" show-ref --verify --quiet "refs/heads/$local_overlay_branch"; then
    git -C "$build_root" branch -D "$local_overlay_branch" >/dev/null || restore_status=$?
  fi
  if ((restore_status == 0)); then
    local_overlay_cleanup_needed=0
  fi
  return "$restore_status"
}

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
  if ((local_overlay_cleanup_needed)); then
    if restore_local_overlay; then
      printf '%s\n' 'build-paseo-artifacts: restored rw-main after the temporary local overlay.'
    else
      printf '%s\n' 'build-paseo-artifacts: failed to restore the build worktree after the temporary local overlay.' >&2
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

install_local_overlay_dependencies() {
  local old_ref=$1 new_ref=$2
  local install_log="$run_dir/local-overlay-npm-install.log"
  local refresh_state="$run_dir/local-overlay-patch-refresh.json"
  local npm_status tee_status
  local -a pipeline_status

  node "$patched_dependencies_helper" prepare \
    --root "$build_root" \
    --old-ref "$old_ref" \
    --new-ref "$new_ref" \
    --state-file "$refresh_state"
  if (cd "$build_root" && npm install) 2>&1 | tee "$install_log"; then
    pipeline_status=("${PIPESTATUS[@]}")
  else
    pipeline_status=("${PIPESTATUS[@]}")
  fi
  npm_status=${pipeline_status[0]:-1}
  tee_status=${pipeline_status[1]:-1}
  if ((tee_status != 0)); then
    printf 'build-paseo-artifacts: failed to capture local-overlay npm install output (exit %s)\n' \
      "$tee_status" >&2
    return "$tee_status"
  fi
  if ((npm_status != 0)); then
    printf 'build-paseo-artifacts: local-overlay npm install failed (exit %s)\n' \
      "$npm_status" >&2
    return "$npm_status"
  fi
  node "$patched_dependencies_helper" check-install-log --log "$install_log"
  node "$patched_dependencies_helper" verify \
    --root "$build_root" \
    --state-file "$refresh_state"
  patched_dependencies_verified=1
}

prepare_local_overlay() {
  local branch_index branch_name branch_head candidate_suffix

  ((${#local_branches[@]} > 0)) || return 0
  candidate_suffix="$(date +%Y%m%d-%H%M%S)-$$"
  local_overlay_branch="rw-local-build-$candidate_suffix"
  git -C "$build_root" show-ref --verify --quiet "refs/heads/$local_overlay_branch" &&
    fail "temporary local overlay branch already exists: $local_overlay_branch"

  stage "local-overlay: create $local_overlay_branch from $build_base_branch $build_base_head"
  git -C "$build_root" switch --quiet --create "$local_overlay_branch" "$build_base_head"
  local_overlay_cleanup_needed=1
  for ((branch_index = 0; branch_index < ${#local_branches[@]}; branch_index++)); do
    branch_name=${local_branches[$branch_index]}
    branch_head=${local_branch_heads[$branch_index]}
    [[ "$(git -C "$build_root" rev-parse "$branch_name")" == "$branch_head" ]] ||
      fail "local overlay branch moved before merge: $branch_name"
    stage "local-overlay: merge $branch_name at $branch_head"
    GIT_MERGE_AUTOEDIT=no git -C "$build_root" merge --no-ff --no-edit "$branch_head"
  done

  if dependency_inputs_changed "$build_base_head" HEAD; then
    stage "local-overlay: install dependencies changed by the temporary candidate"
    install_local_overlay_dependencies "$build_base_head" HEAD
    dependencies_reinstalled=1
  else
    dependencies_reinstalled=0
  fi
  [[ -z "$(git -C "$build_root" status --porcelain)" ]] ||
    fail "local overlay dependency preparation left tracked or untracked changes"

  stage "local-overlay: refresh generated workspace declarations"
  (
    cd "$build_root"
    npm run build --workspace=@getpaseo/relay
    npm run build:client
    npm run build:plugin
  )
  stage "local-overlay: run format, typecheck, and lint readiness checks"
  (
    cd "$build_root"
    npm run format:check
    npm run typecheck
    npm run lint
  )
  [[ -z "$(git -C "$build_root" status --porcelain)" ]] ||
    fail "local overlay readiness checks left tracked or untracked changes"

  build_branch=$local_overlay_branch
  build_start_head=$(git -C "$build_root" rev-parse HEAD)
  rw_main_rebuilt=1
  preflight_mode=local-overlay
  stage "local-overlay: candidate ready at $build_start_head"
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
  unset paseo_preflight_status rw_base_rebuilt rw_base_after rw_main_rebuilt
  unset dependencies_reinstalled rw_main_after main_after control_head
  # The file is written atomically by prepare-rw-main-for-build.sh and is a
  # sourceable shell state contract shared by the two versioned orchestrators.
  source "$preflight_state"
  [[ "${paseo_preflight_status:-}" == ready ]] ||
    fail "preflight state is not ready: $preflight_state"
  [[ "${rw_main_rebuilt:-}" =~ ^[01]$ ]] ||
    fail "invalid rw_main_rebuilt value in preflight state"
  [[ "${rw_base_rebuilt:-}" =~ ^[01]$ ]] ||
    fail "invalid rw_base_rebuilt value in preflight state"
  [[ "${dependencies_reinstalled:-}" =~ ^[01]$ ]] ||
    fail "invalid dependencies_reinstalled value in preflight state"
  [[ "${rw_main_after:-}" =~ ^[0-9a-f]{40}$ ]] ||
    fail "invalid rw_main_after value in preflight state"
  [[ "${rw_base_after:-}" =~ ^[0-9a-f]{40}$ ]] ||
    fail "invalid rw_base_after value in preflight state"
  [[ "${main_after:-}" =~ ^[0-9a-f]{40}$ ]] ||
    fail "invalid main_after value in preflight state"
  [[ "${control_head:-}" =~ ^[0-9a-f]{40}$ ]] ||
    fail "invalid control_head value in preflight state"
  [[ "$build_branch" == rw-main ]] ||
    fail "ready builds must use rw-main (current: $build_branch)"
  current_build_head=$(git -C "$build_root" rev-parse HEAD)
  [[ "$current_build_head" == "$rw_main_after" ]] ||
    fail "preflight state is stale: expected $rw_main_after, current $current_build_head"
  current_base_head=$(git -C "$control_root" rev-parse --verify refs/heads/rw-base)
  [[ "$current_base_head" == "$rw_base_after" ]] ||
    fail "preflight state is stale: rw-base expected $rw_base_after, current $current_base_head"
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
if ((build_android_target)); then
  [[ -n "${ANDROID_HOME:-}" ]] || fail "ANDROID_HOME was not set by the repository mise config"
  export ANDROID_SDK_ROOT="$ANDROID_HOME"
fi
paseo_wineprefix=${PASEO_WINEPREFIX:-"${HOME:?}/.local/share/paseo/wineprefix"}
export WINEPREFIX="$paseo_wineprefix"
export PASEO_BUILD_ROOT="$build_root"

prepare_local_overlay

if ((patched_dependencies_verified)); then
  stage "dependencies: patch registry and installed applications verified during local-overlay install"
else
  stage "dependencies: validate patch registry and installed applications"
  node "$patched_dependencies_helper" validate --root "$build_root"
  node "$patched_dependencies_helper" verify --root "$build_root"
fi

version=$(node -e '
  const pkg = require(process.argv[1]);
  if (typeof pkg.version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(pkg.version)) process.exit(1);
  process.stdout.write(pkg.version);
' "$build_root/package.json") || fail "could not read a safe package version"

[[ -z "$(git status --porcelain -- "$terminal_webview")" ]] ||
  fail "terminal-webview has pre-existing changes: $build_root/$terminal_webview"

declare -a serve_target_args=()
if ((build_android_target && !build_windows_target)); then
  serve_target_args=(--target android)
elif ((build_windows_target && !build_android_target)); then
  serve_target_args=(--target windows)
fi
if ((build_android_target || build_windows_target)); then
  stage "prepare-build: clear exact selected artifacts and write this run's marker ($selected_targets_csv)"
  bash "$control_root/dwyanewang/serve-dist.sh" prepare-build "${serve_target_args[@]}"
  terminal_restore_needed=1
  stage "terminal-webview: regenerate embedded HTML"
  (cd packages/app && npm run build:terminal-webview)
else
  stage "prepare-build: server-only selection has no downloadable artifact marker"
fi

server_artifact_path="$build_root/packages/server/dist/server/server/exports.js"
cli_artifact_path="$build_root/packages/cli/dist/index.js"
server_build_stamp="$build_root/.dev/build-paseo-server-build.env"
server_artifact=
apk_artifact=
zip_artifact=
server_build_mode=not-selected
if ((build_server_target || build_windows_target)); then
  stage "server: build workspace artifacts required by selected targets"
  if paseo_verify_build_stamp "$build_root" "$server_build_stamp" exact-head server-build HEAD; then
    stage "server: trusted build stamp matched; reuse workspace artifacts"
    server_build_mode=trusted-stamp-reuse
  else
    stamp_miss_reason=${PASEO_BUILD_STAMP_MISS_REASON:-unknown}
    stage "server: trusted build stamp missed ($stamp_miss_reason); rebuild workspace artifacts"
    rm -f -- "$server_build_stamp"
    npm run build:server
    server_build_mode=full
    if ! paseo_write_build_stamp "$build_root" "$server_build_stamp" server-build HEAD; then
      rm -f -- "$server_build_stamp"
      printf '%s\n' \
        'build-paseo-artifacts: could not record the optional server build stamp; future builds will rebuild.' \
        >&2
    fi
  fi
  [[ -s "$server_artifact_path" ]] ||
    fail "server entry artifact is missing or empty: $server_artifact_path"
  [[ -s "$cli_artifact_path" ]] || fail "CLI entry artifact is missing or empty: $cli_artifact_path"
  compgen -G "$build_root/packages/protocol/dist/*.js" >/dev/null ||
    fail "protocol JavaScript artifacts are missing"
  ((build_server_target)) && server_artifact=$server_artifact_path
  stage "server: CLI, server, and protocol artifacts verified"
elif ((build_android_target)); then
  stage "android: build app workspace dependencies"
  npm run build:app-deps
  server_build_mode=app-deps-only
  compgen -G "$build_root/packages/protocol/dist/*.js" >/dev/null ||
    fail "protocol JavaScript artifacts are missing"
fi

resource_profile_dir=
if ((build_android_target || build_windows_target)); then
  resource_profile_dir="$build_root/.dev/build-profiles/$run_id"
fi
if ((build_android_target)); then
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
fi

export PYTHONPATH= PYTHONHOME= WINEDEBUG=-all CI=1
if ((build_android_target && build_windows_target)); then
  stage "artifact branches: launch Android ARM64 native assemble; gate Windows on the bundle producer"
  printf 'PASEO_PARALLEL_BRANCH_LOG=android-native-assemble|%s\n' "$android_native_log"
  printf 'PASEO_PARALLEL_BRANCH_LOG=windows-artifacts|%s\n' "$windows_log"
  run_profiled_artifact_branches
elif ((build_android_target)); then
  artifact_parallel_mode=android-only
  stage "android: launch ARM64 native assemble without a Windows branch"
  printf 'PASEO_PARALLEL_BRANCH_LOG=android-native-assemble|%s\n' "$android_native_log"
  launch_android_native_branch
  wait_for_android_bundle_gate
  wait_for_active_branches
  print_branch_log android-native-assemble "$android_native_log"
elif ((build_windows_target)); then
  artifact_parallel_mode=windows-only
  android_native_bundle_gate=not-selected
  stage "windows: launch standalone profiled x64 artifact chain"
  printf 'PASEO_PARALLEL_BRANCH_LOG=windows-artifacts|%s\n' "$windows_log"
  launch_windows_branch
  wait_for_active_branches
  print_branch_log windows-artifacts "$windows_log"
else
  artifact_parallel_mode=not-applicable
  android_native_bundle_gate=not-selected
fi

native_transcript=
if ((build_android_target)); then
  native_transcript="$resource_profile_dir/android-native-assemble.transcript.log"
  grep -Fx '> Task :app:createBundleReleaseJsAndAssets UP-TO-DATE' "$native_transcript" >/dev/null ||
    fail "second Android phase did not keep the bundle producer UP-TO-DATE: $native_transcript"
  apk_artifact="$build_root/packages/app/android/app/build/outputs/apk/release/app-release.apk"
  [[ -s "$apk_artifact" ]] || fail "Android APK is missing or empty: $apk_artifact"
  stage "android: APK and second-phase bundle producer verified"
fi

if ((build_windows_target)); then
  zip_artifact="$build_root/packages/desktop/release/Paseo-Setup-${version}-x64.zip"
  [[ -s "$zip_artifact" ]] || fail "Windows zip is missing or empty: $zip_artifact"
  stage "windows: profiled x64 zip verified"
fi

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
for ((local_index = 0; local_index < ${#local_branches[@]}; local_index++)); do
  current_local_head=$(git -C "$build_root" rev-parse "${local_branches[$local_index]}")
  [[ "$current_local_head" == "${local_branch_heads[$local_index]}" ]] ||
    fail "local overlay branch moved during artifact generation: ${local_branches[$local_index]}"
done
if [[ "$preflight_mode" == ready-state ]]; then
  [[ "$(git -C "$control_root" rev-parse refs/heads/main)" == "$main_after" ]] ||
    fail "main moved during artifact generation; rerun preflight"
  [[ "$(git -C "$control_root" rev-parse refs/heads/rw-base)" == "$rw_base_after" ]] ||
    fail "rw-base moved during artifact generation; rerun preflight"
fi
if [[ "$preflight_mode" == local-overlay ]]; then
  restore_local_overlay || fail "could not restore rw-main after the temporary local overlay"
  stage "local-overlay: restored $build_base_branch and removed the temporary candidate"
  [[ "$(git -C "$build_root" symbolic-ref --quiet --short HEAD)" == "$build_base_branch" ]] ||
    fail "build worktree did not return to $build_base_branch"
  [[ "$(git -C "$build_root" rev-parse HEAD)" == "$build_base_head" ]] ||
    fail "$build_base_branch moved during the local overlay build"
  [[ -z "$(git -C "$build_root" status --porcelain)" ]] ||
    fail "build worktree is not clean after restoring the local overlay"
fi

download_service_started=0
metro_summary=
native_summary=
windows_summary=
windows_transcript=
android_profile_dir=
windows_profile_dir=
android_native_branch_log_result=
windows_branch_log_result=
declare -a artifact_stats=()
declare -a resource_summaries=()
if ((build_server_target)); then
  artifact_stats+=("$server_artifact")
fi
if ((build_android_target)); then
  android_profile_dir=$resource_profile_dir
  android_native_branch_log_result=$android_native_log
  metro_summary="$resource_profile_dir/android-metro-hermes.summary"
  native_summary="$resource_profile_dir/android-native-assemble.summary"
  artifact_stats+=("$apk_artifact")
  resource_summaries+=("$metro_summary" "$native_summary")
fi
if ((build_windows_target)); then
  windows_profile_dir=$resource_profile_dir
  windows_branch_log_result=$windows_log
  windows_summary="$resource_profile_dir/windows-artifacts.summary"
  windows_transcript="$resource_profile_dir/windows-artifacts.transcript.log"
  artifact_stats+=("$zip_artifact")
  resource_summaries+=("$windows_summary")
fi
stat --printf='PASEO_ARTIFACT_STAT=%n|%s|%y\n' "${artifact_stats[@]}"
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
for summary in "${resource_summaries[@]}"; do
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

if ((build_windows_target)); then
  prune_windows_archives "$zip_artifact"
  stage "windows: retained $windows_archive_count newest x64 zip archive(s), pruned $windows_pruned_count older archive(s)"
fi

if ((serve_dist)); then
  stage "serve-dist: start download service"
  # The long-lived download server must not inherit the artifact-build lock.
  (
    eval "exec ${build_lock_fd}>&-"
    exec bash "$control_root/dwyanewang/serve-dist.sh" \
      "${serve_target_args[@]}" "$download_port" "$download_ttl"
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
  printf 'paseo_artifact_targets=%q\n' "$selected_targets_csv"
  printf 'paseo_artifact_preflight_mode=%q\n' "$preflight_mode"
  printf 'paseo_artifact_server_build_mode=%q\n' "$server_build_mode"
  printf 'paseo_artifact_server=%q\n' "$server_artifact"
  printf 'paseo_artifact_apk=%q\n' "$apk_artifact"
  printf 'paseo_artifact_windows_zip=%q\n' "$zip_artifact"
  printf 'paseo_artifact_windows_retention_limit=%q\n' "$windows_archive_retention_limit"
  printf 'paseo_artifact_windows_archive_count=%q\n' "$windows_archive_count"
  printf 'paseo_artifact_windows_pruned_count=%q\n' "$windows_pruned_count"
  printf 'paseo_artifact_android_profile_dir=%q\n' "$android_profile_dir"
  printf 'paseo_artifact_android_metro_summary=%q\n' "$metro_summary"
  printf 'paseo_artifact_android_native_summary=%q\n' "$native_summary"
  printf 'paseo_artifact_windows_profile_dir=%q\n' "$windows_profile_dir"
  printf 'paseo_artifact_windows_summary=%q\n' "$windows_summary"
  printf 'paseo_artifact_windows_transcript=%q\n' "$windows_transcript"
  printf 'paseo_artifact_parallel_mode=%q\n' "$artifact_parallel_mode"
  printf 'paseo_artifact_android_native_bundle_gate=%q\n' "$android_native_bundle_gate"
  printf 'paseo_artifact_parallel_mem_available_bytes=%q\n' "$mem_available_bytes"
  printf 'paseo_artifact_parallel_min_available_bytes=%q\n' "$parallel_min_available_bytes"
  printf 'paseo_artifact_android_native_branch_log=%q\n' "$android_native_branch_log_result"
  printf 'paseo_artifact_windows_branch_log=%q\n' "$windows_branch_log_result"
  printf 'paseo_artifact_local_overlay_count=%q\n' "${#local_branches[@]}"
  for ((local_index = 0; local_index < ${#local_branches[@]}; local_index++)); do
    printf 'paseo_artifact_local_overlay_branch_%s=%q\n' \
      "$local_index" "${local_branches[$local_index]}"
    printf 'paseo_artifact_local_overlay_head_%s=%q\n' \
      "$local_index" "${local_branch_heads[$local_index]}"
  done
  printf 'paseo_artifact_download_service_started=%q\n' "$download_service_started"
  printf 'paseo_artifact_download_port=%q\n' "$download_port"
  printf 'paseo_artifact_download_ttl=%q\n' "$download_ttl"
} >"$result_temp"
chmod 600 "$result_temp"
mv -- "$result_temp" "$result_file"
distribution_cleanup_needed=0

stage "complete: selected targets ($selected_targets_csv), cleanup, and requested distribution succeeded"
printf 'PASEO_ARTIFACT_BUILD_VERSION=%s\n' "$version"
printf 'PASEO_ARTIFACT_BUILD_TOTAL_SECONDS=%s\n' "$total_seconds"
printf 'PASEO_ARTIFACT_TARGETS=%s\n' "$selected_targets_csv"
[[ -z "$server_artifact" ]] || printf 'PASEO_ARTIFACT_SERVER=%s\n' "$server_artifact"
[[ -z "$apk_artifact" ]] || printf 'PASEO_ARTIFACT_APK=%s\n' "$apk_artifact"
[[ -z "$zip_artifact" ]] || printf 'PASEO_ARTIFACT_WINDOWS_ZIP=%s\n' "$zip_artifact"
if ((build_windows_target)); then
  printf 'PASEO_ARTIFACT_WINDOWS_ARCHIVE_COUNT=%s\n' "$windows_archive_count"
  printf 'PASEO_ARTIFACT_WINDOWS_PRUNED_COUNT=%s\n' "$windows_pruned_count"
fi
((build_android_target == 0)) || printf 'PASEO_ANDROID_PROFILE_DIR=%s\n' "$resource_profile_dir"
((build_windows_target == 0)) || printf 'PASEO_WINDOWS_PROFILE_DIR=%s\n' "$resource_profile_dir"
printf 'PASEO_ARTIFACT_RESULT_FILE=%s\n' "$result_file"
