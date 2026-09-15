#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash dwyanewang/rebuild-rw-main.sh --build-root PATH [options]

Synchronize the persistent rw-base with main, then rebuild rw-main from that
base plus the reviewed overlay manifest. Both product refs move only after the
candidate passes repository checks.

  --build-root PATH       Worktree used to assemble and check candidates.
  --base-candidate REF    Use an already prepared rw-base candidate instead of
                          merging main into the current rw-base.
  --frozen-main SHA       Build this run snapshot even if tracking refs advance.
  --run-id ID             Bind the operation to a prepare request.
  --parent-operation PATH Bind the operation to an rw-base lifecycle request.
  --lock-fd FD            Reuse the caller's inherited build lock.
  --operation-status PATH Print one preserved operation without changing it.
  --abort-operation PATH  Abort one preserved operation.
  --confirm-operation PATH
                          Confirm caller ready-state persistence and clean up.
  --dry-run               Verify candidates without moving rw-base or rw-main.
  --push                  Atomically update origin/rw-base and origin/rw-main.
  --help                  Show this help.
EOF
}

dry_run=0
push_target=0
build_root_arg=
base_candidate_arg=
frozen_main=
run_id=
parent_operation=
inherited_lock_fd=
operation_status_arg=
abort_operation_arg=
confirm_operation_arg=
assembled_candidate_arg=
while (($# > 0)); do
  case "$1" in
    --frozen-main)
      (($# >= 2)) || exit 2
      [[ -z "$frozen_main" && "$2" =~ ^[0-9a-f]{40}$ ]] || exit 2
      frozen_main=$2
      shift 2
      ;;
    --build-root)
      (($# >= 2)) || {
        printf '%s\n' 'Missing value for --build-root.' >&2
        exit 2
      }
      [[ -z "$build_root_arg" ]] || {
        printf '%s\n' '--build-root may only be specified once.' >&2
        exit 2
      }
      build_root_arg=$2
      shift 2
      ;;
    --run-id)
      (($# >= 2)) || exit 2
      [[ -z "$run_id" && "$2" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$ ]] || exit 2
      run_id=$2
      shift 2
      ;;
    --parent-operation)
      (($# >= 2)) || exit 2
      [[ -z "$parent_operation" ]] || exit 2
      parent_operation=$2
      shift 2
      ;;
    --lock-fd)
      (($# >= 2)) || exit 2
      [[ -z "$inherited_lock_fd" && "$2" =~ ^[0-9]+$ ]] || exit 2
      inherited_lock_fd=$2
      shift 2
      ;;
    --operation-status)
      (($# >= 2)) || exit 2
      [[ -z "$operation_status_arg" ]] || exit 2
      operation_status_arg=$2
      shift 2
      ;;
    --abort-operation)
      (($# >= 2)) || exit 2
      [[ -z "$abort_operation_arg" ]] || exit 2
      abort_operation_arg=$2
      shift 2
      ;;
    --confirm-operation)
      (($# >= 2)) || exit 2
      [[ -z "$confirm_operation_arg" ]] || exit 2
      confirm_operation_arg=$2
      shift 2
      ;;
    --assembled-candidate)
      (($# >= 2)) || exit 2
      [[ -z "$assembled_candidate_arg" ]] || exit 2
      assembled_candidate_arg=$2
      shift 2
      ;;
    --base-candidate)
      (($# >= 2)) || {
        printf '%s\n' 'Missing value for --base-candidate.' >&2
        exit 2
      }
      [[ -z "$base_candidate_arg" ]] || {
        printf '%s\n' '--base-candidate may only be specified once.' >&2
        exit 2
      }
      base_candidate_arg=$2
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --push)
      push_target=1
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

if ((dry_run && push_target)); then
  printf '%s\n' '--dry-run and --push cannot be used together.' >&2
  exit 2
fi

operation_control_count=0
[[ -n "$operation_status_arg" ]] && ((operation_control_count += 1))
[[ -n "$abort_operation_arg" ]] && ((operation_control_count += 1))
[[ -n "$confirm_operation_arg" ]] && ((operation_control_count += 1))
if ((operation_control_count > 1)) ||
  { [[ -n "$assembled_candidate_arg" ]] && ((operation_control_count > 0)); }; then
  printf '%s\n' 'Operation control options are mutually exclusive.' >&2
  exit 2
fi

[[ -n "$build_root_arg" ]] || {
  printf '%s\n' '--build-root is required.' >&2
  usage >&2
  exit 2
}

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
control_root=$(git -C "$script_dir/.." rev-parse --show-toplevel)
patched_dependencies_helper=${PASEO_PATCHED_DEPENDENCIES_HELPER:-"$control_root/dwyanewang/prepare-patched-dependencies.mjs"}
build_state_helper=${PASEO_BUILD_STATE_HELPER:-"$control_root/dwyanewang/build-paseo-state.sh"}
expo_router_types_helper=${PASEO_EXPO_ROUTER_TYPES_HELPER:-"$control_root/dwyanewang/refresh-expo-router-types.mjs"}
conflict_evidence_helper=${PASEO_CONFLICT_EVIDENCE_HELPER:-"$control_root/dwyanewang/rw-conflict-evidence.sh"}

upstream_branch=main
base_branch=rw-base
base_backup_branch=rw-base-backup-latest
packaging_branch=chore/build-paseo
target_branch=rw-main
target_backup_branch=rw-main-backup-latest
manifest_path="$control_root/dwyanewang/rw-main-branches.txt"
candidate_suffix="$(date +%Y%m%d-%H%M%S)-$$"
base_candidate_branch="rw-base-sync-$candidate_suffix"
target_candidate_branch="rw-main-rebuild-$candidate_suffix"

fail() {
  printf 'rebuild-rw-main: %s\n' "$1" >&2
  exit 1
}

[[ -f "$build_state_helper" ]] || fail "missing build state helper: $build_state_helper"
[[ -f "$patched_dependencies_helper" ]] ||
  fail "missing patched dependencies helper: $patched_dependencies_helper"
[[ -f "$expo_router_types_helper" ]] || fail "missing Expo Router types helper: $expo_router_types_helper"
[[ -f "$conflict_evidence_helper" ]] || fail "missing conflict evidence helper: $conflict_evidence_helper"
# shellcheck disable=SC1090
source "$build_state_helper"
# shellcheck disable=SC1090
source "$conflict_evidence_helper"

canonical_common_dir() {
  local root=$1
  local common_dir
  common_dir=$(git -C "$root" rev-parse --git-common-dir)
  if [[ "$common_dir" != /* ]]; then
    common_dir="$root/$common_dir"
  fi
  realpath -e -- "$common_dir"
}

find_worktree_for_branch() {
  local branch_ref="refs/heads/$1"
  git worktree list --porcelain | awk -v wanted="$branch_ref" '
    /^worktree / {
      path = $0
      sub(/^worktree /, "", path)
    }
    /^branch / && $2 == wanted { print path }
  '
}

require_clean_worktree() {
  local branch_name=$1
  local worktree_path
  worktree_path=$(find_worktree_for_branch "$branch_name")
  if [[ -n "$worktree_path" && -n "$(git -C "$worktree_path" status --porcelain)" ]]; then
    fail "worktree for $branch_name is dirty: $worktree_path"
  fi
}

[[ -d "$build_root_arg" ]] || fail "build root is not a directory: $build_root_arg"
build_root=$(realpath -e -- "$build_root_arg")
build_repo_root=$(git -C "$build_root" rev-parse --show-toplevel 2>/dev/null) ||
  fail "build root is not a Git worktree: $build_root"
build_repo_root=$(realpath -e -- "$build_repo_root")
[[ "$build_root" == "$build_repo_root" ]] ||
  fail "--build-root must name the worktree root: $build_repo_root"
[[ "$(canonical_common_dir "$control_root")" == "$(canonical_common_dir "$build_root")" ]] ||
  fail "control and build worktrees do not belong to the same Git repository"

control_operation() {
  local action=$1 request_path=$2 request_name token actual operation_dir meta_file
  local expected_parent expected_worktree expected_branch active_request= result_state=
  local current_branch current_base current_target candidate_head= local_published=0
  local lock_file="$build_root/.dev/build-paseo-artifacts.lock"
  [[ -z "$base_candidate_arg$frozen_main$run_id$parent_operation$assembled_candidate_arg" &&
    "$dry_run" == 0 && "$push_target" == 0 ]] ||
    fail "--operation-$action cannot be combined with rebuild inputs or publication options"
  command -v flock >/dev/null || fail 'flock is required'
  mkdir -p -- "$build_root/.dev"
  if [[ -n "$inherited_lock_fd" ]]; then
    [[ -e "/proc/$$/fd/$inherited_lock_fd" ]] || fail 'inherited build lock fd is not open'
    [[ "$(realpath -e -- "/proc/$$/fd/$inherited_lock_fd")" == "$(realpath -m -- "$lock_file")" ]] ||
      fail 'inherited build lock does not match the build root'
  else
    exec {control_lock_fd}>"$lock_file"
    flock -n "$control_lock_fd" || fail "another build-paseo workflow owns $build_root"
  fi

  [[ -f "$request_path" ]] || fail "operation request is not a file: $request_path"
  request_path=$(realpath -e -- "$request_path")
  request_name=$(basename -- "$request_path")
  [[ "$request_name" =~ ^([0-9a-f]{40})\.env$ ]] || fail 'operation request filename is invalid'
  token=${BASH_REMATCH[1]}
  actual=$(git -C "$control_root" hash-object -- "$request_path")
  [[ "$actual" == "$token" ]] || fail 'operation request content does not match its token'
  operation_dir=$(dirname -- "$request_path")
  expected_parent=$(realpath -m -- "$(dirname -- "$build_root")/.paseo-rw-main-operations")
  [[ "$(dirname -- "$operation_dir")" == "$expected_parent" && "$(basename -- "$operation_dir")" == "$token" ]] ||
    fail 'operation request is outside this build root operation directory'
  # shellcheck disable=SC1090
  source "$request_path"
  [[ "${rw_main_operation_version:-}" == 1 && "$operation_build_root" == "$build_root" ]] ||
    fail 'operation request does not belong to this build root'
  meta_file="$operation_dir/meta.env"
  [[ -f "$meta_file" ]] || fail 'operation metadata is missing'
  # shellcheck disable=SC1090
  source "$meta_file"
  expected_worktree="$operation_dir/worktree"
  expected_branch="rw-main-operation-$token"
  [[ "$operation_worktree" == "$expected_worktree" && "$operation_branch_name" == "$expected_branch" ]] ||
    fail 'operation worktree metadata does not match its request'
  if [[ -d "$operation_worktree" ]]; then
    [[ "$(canonical_common_dir "$operation_worktree")" == "$(canonical_common_dir "$build_root")" ]] ||
      fail 'operation worktree belongs to another Git repository'
    current_branch=$(git -C "$operation_worktree" symbolic-ref --quiet --short HEAD 2>/dev/null || true)
    [[ "$current_branch" == "$operation_branch_name" ]] || fail 'operation worktree branch does not match its request'
    candidate_head=$(git -C "$operation_worktree" rev-parse HEAD)
  fi
  if [[ -f "$build_root/.dev/rw-main-operation" ]]; then
    active_request=$(<"$build_root/.dev/rw-main-operation")
  fi
  if [[ -f "$operation_dir/result" ]]; then
    result_state=$(awk '{print $1}' "$operation_dir/result")
  fi
  if [[ -f "$operation_dir/progress.env" ]]; then
    # shellcheck disable=SC1090
    source "$operation_dir/progress.env"
  else
    rw_main_operation_phase=unknown
    rw_main_operation_index=unknown
    rw_main_operation_base_head=
    rw_main_operation_remote_published=0
    rw_main_operation_local_published=0
  fi
  current_base=$(git -C "$build_root" rev-parse --verify refs/heads/rw-base 2>/dev/null || true)
  current_target=$(git -C "$build_root" rev-parse --verify refs/heads/rw-main 2>/dev/null || true)
  if [[ -n "$candidate_head" && -n "$rw_main_operation_base_head" &&
    "$current_base" == "$rw_main_operation_base_head" && "$current_target" == "$candidate_head" ]]; then
    local_published=1
  fi

  if [[ "$action" == status ]]; then
    printf 'PASEO_RW_MAIN_OPERATION=%s\n' "$request_path"
    printf 'PASEO_RW_MAIN_OPERATION_WORKTREE=%s\n' "$operation_worktree"
    printf 'PASEO_RW_MAIN_OPERATION_PHASE=%s\n' "$rw_main_operation_phase"
    printf 'PASEO_RW_MAIN_OPERATION_INDEX=%s\n' "$rw_main_operation_index"
    printf 'PASEO_RW_MAIN_OPERATION_ACTIVE=%s\n' "$([[ "$active_request" == "$request_path" ]] && printf 1 || printf 0)"
    printf 'PASEO_RW_MAIN_OPERATION_RESULT=%s\n' "${result_state:-pending}"
    printf 'PASEO_RW_MAIN_OPERATION_LOCAL_PUBLISHED=%s\n' "$local_published"
    printf 'PASEO_RW_MAIN_OPERATION_MAIN=%s\n' "$operation_main"
    printf 'PASEO_RW_MAIN_OPERATION_BASE=%s\n' "$operation_base_before"
    printf 'PASEO_RW_MAIN_OPERATION_TARGET=%s\n' "$operation_target_before"
    printf 'PASEO_RW_MAIN_OPERATION_CONTROL=%s\n' "$operation_control"
    printf 'PASEO_RW_MAIN_OPERATION_RUN_ID=%s\n' "$operation_run_id"
    printf 'PASEO_RW_MAIN_OPERATION_PARENT=%s\n' "$operation_parent_request"
    if [[ -f "$operation_dir/conflict.env" ]]; then
      # shellcheck disable=SC1090
      source "$operation_dir/conflict.env"
      printf 'PASEO_RW_MAIN_CONFLICT_PHASE=%s\n' "$conflict_phase"
      printf 'PASEO_RW_MAIN_CONFLICT_PATHS=%s\n' "${conflict_paths[*]}"
    fi
    return 0
  fi

  if [[ "$action" == confirm ]]; then
    [[ "$result_state" != aborted ]] || fail 'aborted operation cannot be confirmed'
    [[ "${rw_main_operation_local_published:-0}" == 1 && "$local_published" == 1 ]] ||
      fail 'operation has not completed local publication'
    if [[ "$operation_push" == 1 ]]; then
      [[ "${rw_main_operation_remote_published:-0}" == 1 ]] ||
        fail 'operation has not completed remote publication'
    fi
    if [[ -d "$operation_worktree" ]]; then
      git -C "$control_root" worktree remove --force "$operation_worktree" >/dev/null
    fi
    if git -C "$control_root" show-ref --verify --quiet "refs/heads/$operation_branch_name"; then
      git -C "$control_root" branch -D "$operation_branch_name" >/dev/null
    fi
    printf '%s %s\n' completed "$(date +%s)" >"$operation_dir/result"
    if [[ "$active_request" == "$request_path" ]]; then
      rm -f -- "$build_root/.dev/rw-main-operation"
    fi
    printf '%s\n' 'Confirmed rw-main ready state and cleaned up the operation.'
    return 0
  fi

  [[ "$result_state" != completed ]] || fail 'published/completed operation cannot be aborted'
  case "$rw_main_operation_phase" in
    publishing | awaiting-ready)
      fail 'publication may have started; resume finalization instead of aborting'
      ;;
  esac
  [[ "${rw_main_operation_remote_published:-0}" == 0 &&
    "${rw_main_operation_local_published:-0}" == 0 && "$local_published" == 0 ]] ||
    fail 'published operation cannot be aborted; resume finalization instead'
  if [[ -d "$operation_worktree" ]]; then
    git -C "$control_root" worktree remove --force "$operation_worktree" >/dev/null
  fi
  if git -C "$control_root" show-ref --verify --quiet "refs/heads/$operation_branch_name"; then
    git -C "$control_root" branch -D "$operation_branch_name" >/dev/null
  fi
  printf '%s %s\n' aborted "$(date +%s)" >"$operation_dir/result"
  if [[ "$active_request" == "$request_path" ]]; then
    rm -f -- "$build_root/.dev/rw-main-operation"
  fi
  printf '%s\n' 'Aborted rw-main operation.'
}

if [[ -n "$operation_status_arg" ]]; then
  control_operation status "$operation_status_arg"
  exit 0
fi
if [[ -n "$abort_operation_arg" ]]; then
  control_operation abort "$abort_operation_arg"
  exit 0
fi
if [[ -n "$confirm_operation_arg" ]]; then
  control_operation confirm "$confirm_operation_arg"
  exit 0
fi

control_branch=$(git -C "$control_root" symbolic-ref --quiet --short HEAD) ||
  fail "control worktree is detached: $control_root"
[[ "$control_branch" == "$packaging_branch" ]] ||
  fail "control worktree must be on $packaging_branch (current: $control_branch)"
[[ -z "$(git -C "$control_root" status --porcelain)" ]] ||
  fail "control worktree is not clean: $control_root"

cd "$build_root"
[[ -f "$manifest_path" ]] || fail "missing manifest: $manifest_path"
[[ -z "$(git status --porcelain)" ]] || fail "build worktree is not clean: $build_root"
starting_branch=$(git symbolic-ref --quiet --short HEAD) || fail "detached HEAD is not supported"
starting_head=$(git rev-parse HEAD)
server_build_stamp="$build_root/.dev/build-paseo-server-build.env"

git show-ref --verify --quiet "refs/heads/$upstream_branch" ||
  fail "missing local branch: $upstream_branch"
main_head=$(git rev-parse "$upstream_branch")
control_head_before=$(git -C "$control_root" rev-parse HEAD)
if [[ -n "$frozen_main" ]]; then
  paseo_assert_frozen_main "$build_root" "$frozen_main" || fail 'frozen main validation failed'
else
for mirror_ref in refs/remotes/upstream/main refs/remotes/origin/main; do
  if git show-ref --verify --quiet "$mirror_ref"; then
    mirror_head=$(git rev-parse "$mirror_ref")
    [[ "$mirror_head" == "$main_head" ]] ||
      fail "$upstream_branch differs from $mirror_ref; synchronize main first"
  fi
done
fi

base_before=$(git rev-parse --verify "$base_branch" 2>/dev/null || true)
target_before=$(git rev-parse --verify "$target_branch" 2>/dev/null || true)
if [[ -z "$base_candidate_arg" && -z "$base_before" ]]; then
  fail "missing local $base_branch; promote the first persistent feature before rebuilding"
fi

declare -a integration_branches=()
declare -A seen_branches=()
declare -A integration_heads=()
declare -A integration_dependencies=()
while IFS= read -r line || [[ -n "$line" ]]; do
  entry=${line%%#*}
  entry=${entry#"${entry%%[![:space:]]*}"}
  entry=${entry%"${entry##*[![:space:]]}"}
  [[ -n "$entry" ]] || continue
  git check-ref-format --branch "$entry" >/dev/null || fail "invalid branch in manifest: $entry"
  [[ -z "${seen_branches[$entry]:-}" ]] || fail "duplicate branch in manifest: $entry"
  [[ "$entry" != "$upstream_branch" && "$entry" != "$base_branch" &&
    "$entry" != "$packaging_branch" && "$entry" != "$target_branch" ]] ||
    fail "manifest contains a reserved branch: $entry"
  git show-ref --verify --quiet "refs/heads/$entry" ||
    fail "missing local branch from manifest: $entry"

  if [[ "$line" =~ \#[[:space:]]*reviewed-main:([0-9a-f]{40})([[:space:]]|$) ]]; then
    entry_reviewed_main=${BASH_REMATCH[1]}
  else
    fail "missing or malformed reviewed-main metadata for $entry"
  fi
  if [[ "$line" =~ \#[[:space:]]*reviewed-head:([0-9a-f]{40})([[:space:]]|$) ]]; then
    entry_reviewed_head=${BASH_REMATCH[1]}
  else
    fail "missing or malformed reviewed-head metadata for $entry"
  fi

  branch_head=$(git rev-parse "$entry")
  integration_heads[$entry]=$branch_head
  if [[ "$line" =~ \#[[:space:]]*depends-on:([^#[:space:]]+) ]]; then
    integration_dependencies[$entry]=${BASH_REMATCH[1]}
  else
    integration_dependencies[$entry]=
  fi
  if [[ -n "$frozen_main" ]]; then
    paseo_assert_frozen_ancestry "$build_root" "$frozen_main" "$branch_head" "$entry" ||
      fail 'overlay is outside the main snapshot'
  fi
  [[ "$entry_reviewed_main" == "$main_head" ]] ||
    fail "$entry has not been reviewed against $upstream_branch $main_head (manifest: $entry_reviewed_main)"
  [[ "$entry_reviewed_head" == "$branch_head" ]] ||
    fail "$entry head $branch_head has not completed semantic review (manifest: $entry_reviewed_head)"
  seen_branches[$entry]=1
  integration_branches+=("$entry")
done <"$manifest_path"

operation_index_file="$build_root/.dev/rw-main-operation"
operation_parent="$(dirname -- "$build_root")/.paseo-rw-main-operations"
operation_request=
operation_dir=
operation_worktree=
operation_branch_name=
operation_keep=0

atomic_write() {
  local destination=$1
  shift
  local temp
  temp=$(mktemp "$(dirname -- "$destination")/.tmp.XXXXXX")
  "$@" >"$temp"
  chmod 600 "$temp"
  mv -- "$temp" "$destination"
}

write_array() {
  local name=$1
  shift
  local value
  printf '%s=(' "$name"
  for value in "$@"; do printf ' %q' "$value"; done
  printf ' )\n'
}

acquire_build_lock() {
  local lock_file="$build_root/.dev/build-paseo-artifacts.lock" inherited_target
  command -v flock >/dev/null || fail 'flock is required'
  mkdir -p -- "$build_root/.dev"
  if [[ -n "$inherited_lock_fd" ]]; then
    [[ -e "/proc/$$/fd/$inherited_lock_fd" ]] || fail 'inherited build lock fd is not open'
    inherited_target=$(realpath -e -- "/proc/$$/fd/$inherited_lock_fd")
    [[ "$inherited_target" == "$(realpath -m -- "$lock_file")" ]] ||
      fail 'inherited build lock does not match the build root'
    return 0
  fi
  exec {rebuild_lock_fd}>"$lock_file"
  flock -n "$rebuild_lock_fd" || fail "another build-paseo workflow owns $build_root"
}

load_operation() {
  local request_path=$1 request_name token actual
  [[ -f "$request_path" ]] || fail "operation request is not a file: $request_path"
  request_path=$(realpath -e -- "$request_path")
  request_name=$(basename -- "$request_path")
  [[ "$request_name" =~ ^([0-9a-f]{40})\.env$ ]] || fail 'operation request filename is invalid'
  token=${BASH_REMATCH[1]}
  actual=$(git -C "$control_root" hash-object -- "$request_path")
  [[ "$actual" == "$token" ]] || fail 'operation request content does not match its token'
  operation_request=$request_path
  operation_dir=$(dirname -- "$request_path")
  # shellcheck disable=SC1090
  source "$request_path"
  [[ "${rw_main_operation_version:-}" == 1 ]] || fail 'unsupported rw-main operation version'
  [[ -f "$operation_dir/meta.env" ]] || fail 'operation metadata is missing'
  # shellcheck disable=SC1090
  source "$operation_dir/meta.env"
}

write_operation_progress() {
  local phase=$1 index=$2 base_head=${3:-} published_remote=${4:-0} published_local=${5:-0}
  local temp
  temp=$(mktemp "$operation_dir/.progress.XXXXXX")
  {
    printf 'rw_main_operation_phase=%q\n' "$phase"
    printf 'rw_main_operation_index=%q\n' "$index"
    printf 'rw_main_operation_base_head=%q\n' "$base_head"
    printf 'rw_main_operation_remote_published=%q\n' "$published_remote"
    printf 'rw_main_operation_local_published=%q\n' "$published_local"
  } >"$temp"
  chmod 600 "$temp"
  mv -- "$temp" "$operation_dir/progress.env"
}

operation_status() {
  load_operation "$1"
  [[ -f "$operation_dir/progress.env" ]] || fail 'operation progress is missing'
  # shellcheck disable=SC1090
  source "$operation_dir/progress.env"
  printf 'PASEO_RW_MAIN_OPERATION=%s\n' "$operation_request"
  printf 'PASEO_RW_MAIN_OPERATION_WORKTREE=%s\n' "$operation_worktree"
  printf 'PASEO_RW_MAIN_OPERATION_PHASE=%s\n' "$rw_main_operation_phase"
  printf 'PASEO_RW_MAIN_OPERATION_INDEX=%s\n' "$rw_main_operation_index"
  printf 'PASEO_RW_MAIN_OPERATION_MAIN=%s\n' "$operation_main"
  printf 'PASEO_RW_MAIN_OPERATION_BASE=%s\n' "$operation_base_before"
  printf 'PASEO_RW_MAIN_OPERATION_TARGET=%s\n' "$operation_target_before"
  printf 'PASEO_RW_MAIN_OPERATION_CONTROL=%s\n' "$operation_control"
  printf 'PASEO_RW_MAIN_OPERATION_RUN_ID=%s\n' "$operation_run_id"
  printf 'PASEO_RW_MAIN_OPERATION_PARENT=%s\n' "$operation_parent_request"
  if [[ -f "$operation_dir/conflict.env" ]]; then
    # shellcheck disable=SC1090
    source "$operation_dir/conflict.env"
    printf 'PASEO_RW_MAIN_CONFLICT_PHASE=%s\n' "$conflict_phase"
    printf 'PASEO_RW_MAIN_CONFLICT_PATHS=%s\n' "${conflict_paths[*]}"
  fi
}

cleanup_operation_files() {
  local request_path=$1 audit_state=${2:-completed}
  load_operation "$request_path"
  if [[ -d "$operation_worktree" ]]; then
    git -C "$control_root" worktree remove --force "$operation_worktree" >/dev/null
  fi
  if git -C "$control_root" show-ref --verify --quiet "refs/heads/$operation_branch_name"; then
    git -C "$control_root" branch -D "$operation_branch_name" >/dev/null
  fi
  printf '%s %s\n' "$audit_state" "$(date +%s)" >"$operation_dir/result"
  if [[ -f "$operation_index_file" && "$(<"$operation_index_file")" == "$operation_request" ]]; then
    rm -f -- "$operation_index_file"
  fi
}

abort_operation() {
  load_operation "$1"
  if [[ -n "$operation_parent_request" && -f "$operation_parent_request" ]]; then
    : # The child may be aborted while its parent stays available.
  fi
  cleanup_operation_files "$operation_request" aborted
  printf '%s\n' 'Aborted rw-main operation.'
}

acquire_build_lock

configure_managed_rerere() {
  local configured
  configured=$(git -C "$control_root" config --local --get rerere.enabled || true)
  if [[ -z "$configured" ]]; then
    git -C "$control_root" config --local rerere.enabled false
    printf '%s\n' 'Configured repository-default rerere.enabled=false; managed operations opt in explicitly.'
  elif [[ "$configured" == true ]]; then
    printf '%s\n' 'Repository rerere.enabled=true is user-configured; preserving it while managed merges use command-scoped isolation.' >&2
  fi
}

create_operation() {
  local temp token index manifest_oid rerere_setting
  mkdir -p -- "$operation_parent"
  manifest_oid=$(git -C "$control_root" hash-object -- "$manifest_path")
  rerere_setting=$(git -C "$control_root" config --local --get rerere.enabled || true)
  temp=$(mktemp "$operation_parent/.request.XXXXXX")
  {
    printf '%s\n' 'rw_main_operation_version=1'
    printf 'operation_created_at=%q\n' "$(date +%s)"
    printf 'operation_nonce=%q\n' "$$-$RANDOM"
    printf 'operation_build_root=%q\n' "$build_root"
    printf 'operation_control=%q\n' "$control_head_before"
    printf 'operation_main=%q\n' "$main_head"
    printf 'operation_base_before=%q\n' "$base_before"
    printf 'operation_target_before=%q\n' "$(git rev-parse --verify "$target_branch" 2>/dev/null || true)"
    printf 'operation_remote_base_before=%q\n' "$(git rev-parse --verify "refs/remotes/origin/$base_branch" 2>/dev/null || true)"
    printf 'operation_remote_target_before=%q\n' "$(git rev-parse --verify "refs/remotes/origin/$target_branch" 2>/dev/null || true)"
    printf 'operation_base_input=%q\n' "$base_candidate_arg"
    printf 'operation_manifest_oid=%q\n' "$manifest_oid"
    printf 'operation_run_id=%q\n' "$run_id"
    printf 'operation_parent_request=%q\n' "$parent_operation"
    printf 'operation_dry_run=%q\n' "$dry_run"
    printf 'operation_push=%q\n' "$push_target"
    printf 'operation_rerere_setting=%q\n' "$rerere_setting"
    write_array operation_branches "${integration_branches[@]}"
    printf 'operation_heads=('
    for index in "${!integration_branches[@]}"; do
      printf ' %q' "${integration_heads[${integration_branches[$index]}]}"
    done
    printf ' )\n'
    printf 'operation_dependencies=('
    for index in "${!integration_branches[@]}"; do
      printf ' %q' "${integration_dependencies[${integration_branches[$index]}]}"
    done
    printf ' )\n'
  } >"$temp"
  token=$(git -C "$control_root" hash-object -- "$temp")
  operation_dir="$operation_parent/$token"
  [[ ! -e "$operation_dir" ]] || fail "operation already exists without an active index: $operation_dir"
  mkdir -- "$operation_dir"
  operation_request="$operation_dir/$token.env"
  mv -- "$temp" "$operation_request"
  chmod 400 "$operation_request"
  operation_branch_name="rw-main-operation-$token"
  operation_worktree="$operation_dir/worktree"
  {
    printf 'operation_branch_name=%q\n' "$operation_branch_name"
    printf 'operation_worktree=%q\n' "$operation_worktree"
  } >"$operation_dir/meta.env"
  chmod 400 "$operation_dir/meta.env"
  atomic_write "$operation_index_file" printf '%s\n' "$operation_request"
  write_operation_progress sync 0
  configure_managed_rerere
  paseo_build_stage "integration:operation-created run=${run_id:-standalone}"
}

verify_operation_inputs() {
  local manifest_oid index current current_base current_target expected_target phase
  [[ "$operation_build_root" == "$build_root" ]] || fail 'operation build root does not match'
  [[ "$operation_control" == "$control_head_before" ]] || fail 'control HEAD moved since operation creation'
  [[ "$operation_main" == "$main_head" ]] || fail 'main moved since operation creation'
  phase=
  rw_main_operation_base_head=
  if [[ -f "$operation_dir/progress.env" ]]; then
    # shellcheck disable=SC1090
    source "$operation_dir/progress.env"
    phase=$rw_main_operation_phase
  fi
  current_base=$(git rev-parse --verify "$base_branch" 2>/dev/null || true)
  current_target=$(git rev-parse --verify "$target_branch" 2>/dev/null || true)
  expected_target=$(git -C "$operation_worktree" rev-parse HEAD 2>/dev/null || true)
  if [[ "$phase" == publishing || "$phase" == awaiting-ready ]]; then
    if [[ "$current_base" != "$operation_base_before" &&
      ( -z "$rw_main_operation_base_head" || "$current_base" != "$rw_main_operation_base_head" ) ]]; then
      fail 'rw-base moved to an unexpected value during publication'
    fi
    if [[ "$current_target" != "$operation_target_before" &&
      ( -z "$expected_target" || "$current_target" != "$expected_target" ) ]]; then
      fail 'rw-main moved to an unexpected value during publication'
    fi
  else
    [[ "$operation_base_before" == "$current_base" ]] || fail 'rw-base moved since operation creation'
    [[ "$operation_target_before" == "$current_target" ]] || fail 'rw-main moved since operation creation'
  fi
  [[ "$operation_run_id" == "$run_id" ]] || fail 'operation run identity does not match'
  [[ "$operation_parent_request" == "$parent_operation" ]] || fail 'operation parent identity does not match'
  [[ "$operation_dry_run" == "$dry_run" && "$operation_push" == "$push_target" ]] ||
    fail 'operation publication intent changed'
  [[ "$operation_base_input" == "$base_candidate_arg" ]] || fail 'operation base candidate changed'
  manifest_oid=$(git -C "$control_root" hash-object -- "$manifest_path")
  [[ "$operation_manifest_oid" == "$manifest_oid" ]] || fail 'overlay manifest changed since operation creation'
  ((${#operation_branches[@]} == ${#integration_branches[@]})) || fail 'overlay order changed'
  for index in "${!operation_branches[@]}"; do
    [[ "${operation_branches[$index]}" == "${integration_branches[$index]}" ]] || fail 'overlay order changed'
    current=${integration_heads[${integration_branches[$index]}]}
    [[ "${operation_heads[$index]}" == "$current" ]] || fail "${operation_branches[$index]} moved"
    [[ "${operation_dependencies[$index]:-}" == "${integration_dependencies[${integration_branches[$index]}]:-}" ]] ||
      fail "dependency metadata changed for ${operation_branches[$index]}"
  done
}

supported_text_conflict() {
  local record metadata path mode blob stage extra
  local count=0
  while IFS= read -r -d '' record; do
    metadata=${record%%$'\t'*}
    path=${record#*$'\t'}
    read -r mode blob stage extra <<<"$metadata"
    [[ -z "${extra:-}" && "$mode" != 160000 ]] || return 1
    if [[ "$path" != *.patch ]] && ! paseo_blob_is_supported_text "$operation_worktree" "$blob"; then
      return 1
    fi
    ((count += 1))
  done < <(git -C "$operation_worktree" ls-files -u -z)
  ((count > 0))
}

snapshot_conflict() {
  local phase=$1 index=$2 source_head=$3 ours theirs auto_tree temp record metadata path mode blob stage extra
  local rerere_matched
  local -a paths=() index_records=() upstream_records=()
  local -A seen=()
  # A previous step may have advanced before cleaning up its live evidence.
  rm -f -- "$operation_dir/resolved-tree" "$operation_dir/conflict-review-accepted.env"
  ours=$(git -C "$operation_worktree" rev-parse HEAD)
  theirs=$(git -C "$operation_worktree" rev-parse MERGE_HEAD)
  auto_tree=$(git -C "$operation_worktree" rev-parse 'AUTO_MERGE^{tree}' 2>/dev/null) ||
    fail 'supported conflict is missing AUTO_MERGE tree'
  while IFS= read -r -d '' record; do
    metadata=${record%%$'\t'*}
    path=${record#*$'\t'}
    read -r mode blob stage extra <<<"$metadata"
    [[ -z "${extra:-}" ]] || fail "malformed conflict index entry for $path"
    index_records+=("$mode"$'\t'"$blob"$'\t'"$stage"$'\t'"$path")
    if [[ -z "${seen[$path]+present}" ]]; then paths+=("$path"); seen[$path]=1; fi
  done < <(git -C "$operation_worktree" ls-files -u -z)
  temp=$(mktemp "$operation_dir/.conflict.XXXXXX")
  {
    printf 'conflict_version=1\nconflict_phase=%q\nconflict_index=%q\n' "$phase" "$index"
    printf 'conflict_ours=%q\nconflict_theirs=%q\nconflict_source=%q\nconflict_auto_tree=%q\n' \
      "$ours" "$theirs" "$source_head" "$auto_tree"
    write_array conflict_paths "${paths[@]}"
    write_array conflict_index_records "${index_records[@]}"
  } >"$temp"
  chmod 600 "$temp"
  mv -- "$temp" "$operation_dir/conflict.env"
  git -C "$operation_worktree" ls-files -u >"$operation_dir/conflict-ls-files-u.txt"
  {
    printf '# Replace the tree TODO with `git write-tree` after staging, and every explanation TODO with reviewed evidence. Keep every generated row.\n'
    printf 'resolution-tree\tTODO\tTODO\n'
    for path in "${paths[@]}"; do
      printf 'parents\t%s\t%s\t%s\tTODO\n' "$path" "$ours" "$theirs"
      if [[ "$phase" == sync ]]; then
        while IFS= read -r commit; do
          [[ -n "$commit" ]] && printf 'upstream\t%s\t%s\tTODO\n' "$path" "$commit"
        done < <(paseo_conflict_upstream_commits "$operation_worktree" "$operation_base_before" "$operation_main" "$path")
      else
        while IFS= read -r commit; do
          [[ -n "$commit" ]] && printf 'upstream\t%s\t%s\tTODO\n' "$path" "$commit"
        done < <(paseo_conflict_upstream_commits "$operation_worktree" "$source_head" "$operation_main" "$path")
      fi
    done
  } >"$operation_dir/conflict-review.tsv"
  awk -F '\t' '!/^#/ && $1 != "resolution-tree" { print $1 "\t" $2 "\t" $3 }' \
    "$operation_dir/conflict-review.tsv" >"$operation_dir/conflict-review-required.tsv"
  git -C "$operation_worktree" -c rerere.enabled=true -c rerere.autoupdate=false rerere || true
  rerere_matched=0
  if [[ -z "$(git -C "$operation_worktree" -c rerere.enabled=true rerere remaining)" ]]; then
    rerere_matched=1
    printf '%s\n' 'rerere restored file contents; review and stage them before continuing.'
    paseo_build_stage "integration:rerere-match phase=$phase index=$index"
  else
    paseo_build_stage "integration:conflict phase=$phase index=$index paths=${#paths[@]}"
  fi
  atomic_write "$operation_dir/conflict-rerere.env" printf \
    'conflict_rerere_matched=%q\n' "$rerere_matched"
  for path in "${paths[@]}"; do
    record_conflict_recurrence "$phase" "$index" "$path" "$rerere_matched"
  done
  write_operation_progress conflict "$index" "${rw_main_operation_base_head:-}"
  printf 'PASEO_RW_MAIN_OPERATION=%s\n' "$operation_request"
  printf 'PASEO_RW_MAIN_OPERATION_WORKTREE=%s\n' "$operation_worktree"
  printf '%s\n' 'PASEO_PREFLIGHT_STATUS=integration-conflict'
  printf 'PASEO_RW_MAIN_CONFLICT_PHASE=%s\n' "$phase"
  printf 'Conflict paths: %s\n' "${paths[*]}"
  printf 'Resolve, git add, complete %s, then rerun the original command.\n' "$operation_dir/conflict-review.tsv"
  exit 6
}

record_conflict_recurrence() {
  local phase=$1 index=$2 path=$3 rerere_matched=$4 label history_dir key count_file count=0 temp
  if [[ "$phase" == sync ]]; then label=rw-base-sync; else label=${operation_branches[$index]}; fi
  history_dir=$(git -C "$control_root" rev-parse --git-path paseo-conflict-history)
  [[ "$history_dir" == /* ]] || history_dir="$control_root/$history_dir"
  mkdir -p -- "$history_dir"
  key=$(printf '%s\t%s\t%s\n' "$phase" "$label" "$path" | git -C "$control_root" hash-object --stdin)
  count_file="$history_dir/$key.count"
  if [[ -f "$count_file" ]]; then
    read -r count <"$count_file" || count=0
    [[ "$count" =~ ^[0-9]+$ ]] || count=0
  fi
  ((count += 1))
  temp=$(mktemp "$history_dir/.count.XXXXXX")
  printf '%s\n' "$count" >"$temp"
  mv -- "$temp" "$count_file"
  printf '%s\t%s\t%s\t%s\t%s\n' "$phase" "$label" "$path" "$count" "$rerere_matched" \
    >>"$history_dir/events.tsv"
  paseo_build_stage "integration:conflict-history phase=$phase branch=$label count=$count rerere-match=$rerere_matched"
  if ((count >= 2)); then
    printf 'Maintenance suggestion: conflict for %s (%s) recurred %s times; consider updating the source branch instead of repeating candidate-only resolution.\n' \
      "$label" "$path" "$count" >&2
  fi
}

validate_conflict_resolution() {
  # shellcheck disable=SC1090
  source "$operation_dir/conflict.env"
  [[ "$conflict_version" == 1 ]] || fail 'unsupported conflict snapshot version'
  [[ "$(git -C "$operation_worktree" rev-parse HEAD)" == "$conflict_ours" ]] || fail 'operation HEAD was changed manually'
  [[ "$(git -C "$operation_worktree" rev-parse MERGE_HEAD 2>/dev/null || true)" == "$conflict_theirs" ]] ||
    fail 'operation merge state or other parent changed'
  [[ -z "$(git -C "$operation_worktree" diff --name-only --diff-filter=U)" ]] || fail 'conflict index is not fully resolved'
  [[ -z "$(git -C "$operation_worktree" diff --name-only)" ]] || fail 'conflict resolution has unstaged changes'
  [[ -z "$(git -C "$operation_worktree" ls-files --others --exclude-standard)" ]] || fail 'conflict resolution has untracked files'
  local staged_tree changed path allowed=0
  staged_tree=$(git -C "$operation_worktree" write-tree)
  while IFS= read -r changed; do
    [[ -n "$changed" ]] || continue
    allowed=0
    for path in "${conflict_paths[@]}"; do [[ "$changed" == "$path" ]] && allowed=1; done
    ((allowed)) || fail "conflict resolution modified non-conflict path: $changed"
  done < <(git -C "$operation_worktree" diff-tree --no-commit-id --name-only -r "$conflict_auto_tree" "$staged_tree")
  validate_conflict_evidence "$staged_tree"
  if [[ -f "$operation_dir/conflict-rerere.env" ]]; then
    # shellcheck disable=SC1090
    source "$operation_dir/conflict-rerere.env"
  else
    conflict_rerere_matched=0
  fi
  if [[ "$conflict_rerere_matched" == 1 ]]; then
    # Git retains the prior postimage when a user corrects an auto-restored
    # resolution. Forget it, then restore the exact reviewed tree so rerere
    # records the correction rather than silently keeping the stale result.
    git -C "$operation_worktree" -c rerere.enabled=true rerere forget -- "${conflict_paths[@]}" >/dev/null
    git -C "$operation_worktree" read-tree --reset -u "$staged_tree"
    [[ "$(git -C "$operation_worktree" write-tree)" == "$staged_tree" ]] ||
      fail 'failed to restore the reviewed resolution before recording rerere'
  fi
  git -C "$operation_worktree" -c rerere.enabled=true -c rerere.autoupdate=false rerere
  printf '%s\n' "$staged_tree" >"$operation_dir/resolved-tree"
  write_conflict_review_binding "$staged_tree"
}

validate_conflict_evidence() {
  local resolved_tree=$1 required_review path changed allowed=0 recorded_tree
  local review_file="$operation_dir/conflict-review.tsv"
  [[ -f "$review_file" ]] || fail 'conflict review record is missing'
  awk -F '\t' '
    /^#/ { next }
    $1 == "resolution-tree" {
      if (NF != 3 || $2 !~ /^[0-9a-f]{40}$/) exit 1
      explanation = $3
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", explanation)
      if (explanation == "" || explanation == "TODO") exit 1
      tree_rows++
      next
    }
    NF < 4 { exit 1 }
    {
      explanation = $NF
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", explanation)
      if (explanation == "" || explanation == "TODO") exit 1
    }
    END { if (tree_rows != 1) exit 1 }
  ' "$review_file" || fail 'every conflict review row requires a non-empty explanation'
  recorded_tree=$(awk -F '\t' '$1 == "resolution-tree" { print $2 }' "$review_file")
  [[ "$recorded_tree" == "$resolved_tree" ]] ||
    fail "conflict review was recorded for staged tree $recorded_tree, current tree is $resolved_tree"
  paseo_validate_add_add_patch_resolution \
    "$operation_worktree" "$operation_dir/conflict-ls-files-u.txt" "$resolved_tree" ||
    fail 'add/add patch conflict resolution does not preserve both parents'
  while IFS= read -r required_review; do
    grep -Fq "$required_review"$'\t' "$review_file" ||
      fail "conflict review is missing required evidence: $required_review"
  done <"$operation_dir/conflict-review-required.tsv"
  for path in "${conflict_paths[@]}"; do
    grep -Fq $'parents\t'"$path"$'\t'"$conflict_ours"$'\t'"$conflict_theirs"$'\t' "$review_file" ||
      fail "conflict review is missing the double-parent explanation for $path"
  done
  while IFS= read -r changed; do
    [[ -n "$changed" ]] || continue
    allowed=0
    for path in "${conflict_paths[@]}"; do [[ "$changed" == "$path" ]] && allowed=1; done
    ((allowed)) || fail "conflict resolution modified non-conflict path: $changed"
  done < <(git -C "$operation_worktree" diff-tree --no-commit-id --name-only -r "$conflict_auto_tree" "$resolved_tree")
}

write_conflict_review_binding() {
  local resolved_tree=$1 temp review_hash
  review_hash=$(git -C "$control_root" hash-object -- "$operation_dir/conflict-review.tsv")
  temp=$(mktemp "$operation_dir/.conflict-review-accepted.XXXXXX")
  {
    printf 'accepted_conflict_ours=%q\n' "$conflict_ours"
    printf 'accepted_conflict_theirs=%q\n' "$conflict_theirs"
    printf 'accepted_resolved_tree=%q\n' "$resolved_tree"
    printf 'accepted_review_hash=%q\n' "$review_hash"
  } >"$temp"
  chmod 400 "$temp"
  mv -- "$temp" "$operation_dir/conflict-review-accepted.env"
}

verify_conflict_review_binding() {
  local resolved_tree=$1 actual_hash
  [[ -f "$operation_dir/conflict-review-accepted.env" ]] || return 1
  # shellcheck disable=SC1090
  source "$operation_dir/conflict-review-accepted.env"
  [[ "$accepted_conflict_ours" == "$conflict_ours" &&
    "$accepted_conflict_theirs" == "$conflict_theirs" &&
    "$accepted_resolved_tree" == "$resolved_tree" ]] || return 1
  actual_hash=$(git -C "$control_root" hash-object -- "$operation_dir/conflict-review.tsv") || return 1
  [[ "$actual_hash" == "$accepted_review_hash" ]]
}

write_completed_merge_record() {
  local phase=$1 index=$2 ours=$3 theirs=$4 commit=$5 tree temp
  tree=$(git -C "$operation_worktree" rev-parse "$commit^{tree}")
  temp=$(mktemp "$operation_dir/.merge-completed.XXXXXX")
  {
    printf 'completed_merge_phase=%q\n' "$phase"
    printf 'completed_merge_index=%q\n' "$index"
    printf 'completed_merge_ours=%q\n' "$ours"
    printf 'completed_merge_theirs=%q\n' "$theirs"
    printf 'completed_merge_commit=%q\n' "$commit"
    printf 'completed_merge_tree=%q\n' "$tree"
  } >"$temp"
  chmod 400 "$temp"
  mv -- "$temp" "$operation_dir/merge-completed-$phase-$index.env"
}

write_merge_intent() {
  local phase=$1 index=$2 ours=$3 theirs=$4 tree=$5 message=$6 temp
  temp=$(mktemp "$operation_dir/.merge-intent.XXXXXX")
  {
    printf 'merge_intent_phase=%q\n' "$phase"
    printf 'merge_intent_index=%q\n' "$index"
    printf 'merge_intent_ours=%q\n' "$ours"
    printf 'merge_intent_theirs=%q\n' "$theirs"
    printf 'merge_intent_tree=%q\n' "$tree"
    printf 'merge_intent_message=%q\n' "$message"
  } >"$temp"
  chmod 400 "$temp"
  mv -- "$temp" "$operation_dir/merge-intent-$phase-$index.env"
}

write_noop_merge_record() {
  local phase=$1 index=$2 head=$3 source_head=$4 temp
  temp=$(mktemp "$operation_dir/.merge-noop.XXXXXX")
  {
    printf 'noop_merge_phase=%q\n' "$phase"
    printf 'noop_merge_index=%q\n' "$index"
    printf 'noop_merge_head=%q\n' "$head"
    printf 'noop_merge_source=%q\n' "$source_head"
    printf '%s\n' 'noop_merge_reason=source-already-in-prefix'
  } >"$temp"
  chmod 400 "$temp"
  mv -- "$temp" "$operation_dir/merge-noop-$phase-$index.env"
}

expected_clean_merge_tree() {
  local ours=$1 theirs=$2 expected status=0
  expected=$(git -C "$operation_worktree" merge-tree --write-tree "$ours" "$theirs") || status=$?
  ((status == 0)) || fail 'cannot reconstruct the expected clean merge tree from frozen parents'
  expected=${expected%%$'\n'*}
  [[ "$expected" =~ ^[0-9a-f]{40}$ ]] || fail 'reconstructed clean merge tree is invalid'
  printf '%s\n' "$expected"
}

recover_resolved_conflict_commit() {
  local current tree
  local -a commit_and_parents
  current=$(git -C "$operation_worktree" rev-parse HEAD)
  read -r -a commit_and_parents < <(git -C "$operation_worktree" rev-list --parents -n 1 "$current")
  [[ ${#commit_and_parents[@]} -eq 3 &&
    "${commit_and_parents[1]}" == "$conflict_ours" &&
    "${commit_and_parents[2]}" == "$conflict_theirs" ]] || return 1
  [[ -f "$operation_dir/resolved-tree" ]] || return 1
  tree=$(git -C "$operation_worktree" rev-parse "$current^{tree}")
  [[ "$tree" == "$(<"$operation_dir/resolved-tree")" ]] || return 1
  if ! verify_conflict_review_binding "$tree"; then
    validate_conflict_evidence "$tree"
    write_conflict_review_binding "$tree"
  fi
  write_completed_merge_record "$conflict_phase" "$conflict_index" \
    "$conflict_ours" "$conflict_theirs" "$current"
}

managed_merge() {
  local phase=$1 index=$2 source_head=$3 message=$4 before after tree
  before=$(git -C "$operation_worktree" rev-parse HEAD)
  if git -C "$operation_worktree" merge-base --is-ancestor "$source_head" "$before"; then
    write_noop_merge_record "$phase" "$index" "$before" "$source_head"
    return 0
  fi
  write_merge_intent "$phase" "$index" "$before" "$source_head" '' "$message"
  if ! GIT_MERGE_AUTOEDIT=no git -C "$operation_worktree" \
    -c core.hooksPath=/dev/null -c rerere.enabled=false -c rerere.autoupdate=false \
    merge --no-verify --no-commit --no-ff --no-edit -m "$message" "$source_head"; then
    supported_text_conflict || fail "unsupported or non-text conflict while merging $phase"
    snapshot_conflict "$phase" "$index" "$source_head"
  fi
  if [[ "${PASEO_TEST_INTERRUPT_AFTER_MERGE_BEFORE_TREE_INTENT:-}" == "$phase:$index" ]]; then
    printf '%s\n' 'Injected interruption after clean merge and before expected tree journal write.' >&2
    exit 90
  fi
  if [[ -z "$(git -C "$operation_worktree" rev-parse MERGE_HEAD 2>/dev/null || true)" ]]; then
    if git -C "$operation_worktree" merge-base --is-ancestor "$source_head" HEAD; then
      write_noop_merge_record "$phase" "$index" "$before" "$source_head"
      return 0
    fi
    fail "merge for $phase returned without a commit state and did not contain its frozen source"
  fi
  tree=$(git -C "$operation_worktree" write-tree)
  write_merge_intent "$phase" "$index" "$before" "$source_head" "$tree" "$message"
  git -C "$operation_worktree" -c core.hooksPath=/dev/null commit --no-verify --no-edit
  after=$(git -C "$operation_worktree" rev-parse HEAD)
  [[ "$after" != "$before" ]] || fail "merge for $phase produced no commit"
  if [[ "${PASEO_TEST_INTERRUPT_AFTER_MERGE_COMMIT_BEFORE_RECORD:-}" == "$phase:$index" ]]; then
    printf '%s\n' 'Injected interruption after merge commit and before completion record write.' >&2
    exit 91
  fi
  write_completed_merge_record "$phase" "$index" "$before" "$source_head" "$after"
  if [[ "${PASEO_TEST_INTERRUPT_AFTER_MERGE:-}" == "$phase:$index" ]]; then
    printf '%s\n' 'Injected interruption after merge commit and before progress write.' >&2
    exit 91
  fi
}

recover_completed_merge() {
  local phase=$1 index=$2 expected_theirs=$3 record noop_record intent current tree merge_head
  local reconstructed_tree
  local -a commit_and_parents
  noop_record="$operation_dir/merge-noop-$phase-$index.env"
  if [[ -f "$noop_record" ]]; then
    # shellcheck disable=SC1090
    source "$noop_record"
    [[ "$noop_merge_phase" == "$phase" && "$noop_merge_index" == "$index" &&
      "$noop_merge_source" == "$expected_theirs" &&
      "$noop_merge_reason" == source-already-in-prefix ]] ||
      fail "no-op merge record does not match $phase step $index"
    current=$(git -C "$operation_worktree" rev-parse HEAD)
    [[ "$current" == "$noop_merge_head" ]] || fail "no-op merge HEAD mismatch for $phase step $index"
    git -C "$operation_worktree" merge-base --is-ancestor "$expected_theirs" "$current" ||
      fail "no-op merge source is not contained in the recorded prefix for $phase step $index"
    return 0
  fi
  record="$operation_dir/merge-completed-$phase-$index.env"
  if [[ -f "$record" ]]; then
    # shellcheck disable=SC1090
    source "$record"
    [[ "$completed_merge_phase" == "$phase" && "$completed_merge_index" == "$index" &&
      "$completed_merge_theirs" == "$expected_theirs" ]] ||
      fail "completed merge record does not match $phase step $index"
    current=$(git -C "$operation_worktree" rev-parse HEAD)
    [[ "$current" == "$completed_merge_commit" ]] ||
      fail "completed merge HEAD mismatch for $phase step $index"
    read -r -a commit_and_parents < <(git -C "$operation_worktree" rev-list --parents -n 1 "$current")
    [[ ${#commit_and_parents[@]} -eq 3 &&
      "${commit_and_parents[1]}" == "$completed_merge_ours" &&
      "${commit_and_parents[2]}" == "$expected_theirs" ]] ||
      fail "completed merge parent mismatch for $phase step $index"
    tree=$(git -C "$operation_worktree" rev-parse "$current^{tree}")
    [[ "$tree" == "$completed_merge_tree" ]] ||
      fail "completed merge tree mismatch for $phase step $index"
    return 0
  fi

  intent="$operation_dir/merge-intent-$phase-$index.env"
  [[ -f "$intent" ]] || return 1
  # shellcheck disable=SC1090
  source "$intent"
  [[ "$merge_intent_phase" == "$phase" && "$merge_intent_index" == "$index" &&
    "$merge_intent_theirs" == "$expected_theirs" ]] ||
    fail "merge intent does not match $phase step $index"
  current=$(git -C "$operation_worktree" rev-parse HEAD)
  if [[ "$current" == "$merge_intent_ours" ]]; then
    merge_head=$(git -C "$operation_worktree" rev-parse MERGE_HEAD 2>/dev/null || true)
    if [[ -z "$merge_head" ]]; then
      [[ -z "$(git -C "$operation_worktree" status --porcelain)" && -z "$merge_intent_tree" ]] ||
        fail "merge intent has changes without a merge state for $phase step $index"
      rm -f -- "$intent"
      return 1
    fi
    [[ "$merge_head" == "$expected_theirs" ]] ||
      fail "merge intent parent mismatch for $phase step $index"
    if [[ -n "$(git -C "$operation_worktree" ls-files -u)" ]]; then
      supported_text_conflict || fail "unsupported or non-text conflict while merging $phase"
      snapshot_conflict "$phase" "$index" "$expected_theirs"
    fi
    tree=$(git -C "$operation_worktree" write-tree)
    reconstructed_tree=$(expected_clean_merge_tree "$merge_intent_ours" "$expected_theirs")
    [[ "$tree" == "$reconstructed_tree" ]] ||
      fail "merge intent tree mismatch for $phase step $index"
    if [[ -z "$merge_intent_tree" ]]; then
      merge_intent_tree=$reconstructed_tree
      write_merge_intent "$phase" "$index" "$merge_intent_ours" "$expected_theirs" \
        "$merge_intent_tree" "$merge_intent_message"
    fi
    [[ "$tree" == "$merge_intent_tree" ]] ||
      fail "merge intent tree mismatch for $phase step $index"
    git -C "$operation_worktree" -c core.hooksPath=/dev/null commit --no-verify --no-edit
    current=$(git -C "$operation_worktree" rev-parse HEAD)
  fi
  if [[ -z "$merge_intent_tree" ]]; then
    merge_intent_tree=$(expected_clean_merge_tree "$merge_intent_ours" "$expected_theirs")
    write_merge_intent "$phase" "$index" "$merge_intent_ours" "$expected_theirs" \
      "$merge_intent_tree" "$merge_intent_message"
  fi
  read -r -a commit_and_parents < <(git -C "$operation_worktree" rev-list --parents -n 1 "$current")
  [[ ${#commit_and_parents[@]} -eq 3 &&
    "${commit_and_parents[1]}" == "$merge_intent_ours" &&
    "${commit_and_parents[2]}" == "$expected_theirs" ]] ||
    fail "merge intent parent mismatch for $phase step $index"
  tree=$(git -C "$operation_worktree" rev-parse "$current^{tree}")
  [[ "$tree" == "$merge_intent_tree" ]] ||
    fail "merge intent tree mismatch for $phase step $index"
  write_completed_merge_record "$phase" "$index" "$merge_intent_ours" "$expected_theirs" "$current"
}

assemble_operation() {
  load_operation "$operation_request"
  verify_operation_inputs
  base_before=$operation_base_before
  target_before=$operation_target_before
  # shellcheck disable=SC1090
  source "$operation_dir/progress.env"
  if [[ "$rw_main_operation_phase" == assembled || "$rw_main_operation_phase" == publishing ||
    "$rw_main_operation_phase" == awaiting-ready ]]; then
    assembled_candidate_arg=$(git -C "$operation_worktree" rev-parse HEAD)
    base_candidate_arg=$rw_main_operation_base_head
    operation_keep=1
    return 0
  fi
  if [[ "$rw_main_operation_phase" == conflict ]]; then
    # shellcheck disable=SC1090
    source "$operation_dir/conflict.env"
    if ! recover_resolved_conflict_commit; then
      validate_conflict_resolution
      conflict_before=$(git -C "$operation_worktree" rev-parse HEAD)
      git -C "$operation_worktree" -c core.hooksPath=/dev/null commit --no-verify --no-edit
      conflict_commit=$(git -C "$operation_worktree" rev-parse HEAD)
      write_completed_merge_record "$conflict_phase" "$conflict_index" \
        "$conflict_before" "$conflict_theirs" "$conflict_commit"
      if [[ "${PASEO_TEST_INTERRUPT_AFTER_CONFLICT_COMMIT:-}" == "$conflict_phase:$conflict_index" ]]; then
        printf '%s\n' 'Injected interruption after conflict resolution commit and before progress write.' >&2
        exit 93
      fi
    fi
    # Keep live evidence until every archive is complete and progress advances.
    # Recovery can validate the committed resolution and repeat these copies.
    atomic_write "$operation_dir/conflict-review-$conflict_phase-$conflict_index.tsv" \
      cat -- "$operation_dir/conflict-review.tsv"
    if [[ "${PASEO_TEST_INTERRUPT_DURING_CONFLICT_ARCHIVE:-}" == "$conflict_phase:$conflict_index" ]]; then
      printf '%s\n' 'Injected interruption during conflict evidence archival.' >&2
      exit 98
    fi
    atomic_write "$operation_dir/conflict-index-$conflict_phase-$conflict_index.txt" \
      cat -- "$operation_dir/conflict-ls-files-u.txt"
    atomic_write "$operation_dir/conflict-review-required-$conflict_phase-$conflict_index.tsv" \
      cat -- "$operation_dir/conflict-review-required.tsv"
    atomic_write "$operation_dir/resolved-tree-$conflict_phase-$conflict_index" \
      cat -- "$operation_dir/resolved-tree"
    atomic_write "$operation_dir/conflict-review-accepted-$conflict_phase-$conflict_index.env" \
      cat -- "$operation_dir/conflict-review-accepted.env"
    atomic_write "$operation_dir/conflict-$conflict_phase-$conflict_index.env" \
      cat -- "$operation_dir/conflict.env"
    if [[ "$conflict_phase" == sync ]]; then
      rw_main_operation_base_head=$(git -C "$operation_worktree" rev-parse HEAD)
      write_operation_progress assembling 0 "$rw_main_operation_base_head"
    else
      write_operation_progress assembling "$((conflict_index + 1))" "$rw_main_operation_base_head"
    fi
    if [[ "${PASEO_TEST_INTERRUPT_AFTER_CONFLICT_PROGRESS:-}" == "$conflict_phase:$conflict_index" ]]; then
      printf '%s\n' 'Injected interruption after conflict progress and before live evidence cleanup.' >&2
      exit 99
    fi
    rm -f -- "$operation_dir/conflict.env" "$operation_dir/conflict-review.tsv" \
      "$operation_dir/conflict-ls-files-u.txt" "$operation_dir/conflict-review-required.tsv" \
      "$operation_dir/resolved-tree" "$operation_dir/conflict-review-accepted.env"
  fi
  # shellcheck disable=SC1090
  source "$operation_dir/progress.env"
  if [[ "$rw_main_operation_phase" == sync ]]; then
    local start_ref=${operation_base_input:-$operation_base_before}
    [[ -n "$start_ref" ]] || fail 'operation has no base input'
    if [[ ! -d "$operation_worktree" ]]; then
      git -C "$control_root" worktree add --quiet -b "$operation_branch_name" "$operation_worktree" "$start_ref"
    fi
    if recover_completed_merge sync 0 "$operation_main"; then
      :
    elif git -C "$operation_worktree" merge-base --is-ancestor "$operation_main" HEAD; then
      :
    elif git -C "$operation_worktree" merge-base --is-ancestor HEAD "$operation_main"; then
      git -C "$operation_worktree" merge --ff-only "$operation_main"
    else
      managed_merge sync 0 "$operation_main" "Merge branch 'main' into $operation_branch_name"
    fi
    rw_main_operation_base_head=$(git -C "$operation_worktree" rev-parse HEAD)
    write_operation_progress assembling 0 "$rw_main_operation_base_head"
  fi
  # shellcheck disable=SC1090
  source "$operation_dir/progress.env"
  local index branch head
  for ((index = rw_main_operation_index; index < ${#operation_branches[@]}; index++)); do
    branch=${operation_branches[$index]}
    head=${operation_heads[$index]}
    if recover_completed_merge overlay "$index" "$head"; then
      write_operation_progress assembling "$((index + 1))" "$rw_main_operation_base_head"
      continue
    fi
    managed_merge overlay "$index" "$head" "Merge branch '$branch' into $operation_branch_name"
    write_operation_progress assembling "$((index + 1))" "$rw_main_operation_base_head"
  done
  write_operation_progress assembled "${#operation_branches[@]}" "$rw_main_operation_base_head"
  assembled_candidate_arg=$(git -C "$operation_worktree" rev-parse HEAD)
  base_candidate_arg=$rw_main_operation_base_head
  operation_keep=1
}

target_matches_base_inputs() {
  local base_head=$1 current_commit branch_head merge_index
  local -a commit_and_parents
  [[ -n "$target_before" ]] || return 1
  current_commit=$target_before
  for ((merge_index = ${#integration_branches[@]} - 1; merge_index >= 0; merge_index--)); do
    branch_head=${integration_heads[${integration_branches[$merge_index]}]}
    # The frozen base may itself be a merge of this overlay. Never peel its history.
    if [[ "$current_commit" == "$base_head" ]]; then
      git merge-base --is-ancestor "$branch_head" "$base_head" || return 1
      continue
    fi
    read -r -a commit_and_parents < <(git rev-list --parents -n 1 "$current_commit")
    if [[ ${#commit_and_parents[@]} -eq 3 && "${commit_and_parents[2]}" == "$branch_head" ]]; then
      current_commit=${commit_and_parents[1]}
    elif git merge-base --is-ancestor "$branch_head" "$current_commit"; then
      : # This overlay was already contained by the legal prefix at its step.
    else
      return 1
    fi
  done
  [[ "$current_commit" == "$base_head" ]]
}

if [[ -z "$assembled_candidate_arg" && ! -f "$operation_index_file" ]] && ((!dry_run)); then
  published_base_candidate=
  if [[ -n "$base_candidate_arg" ]]; then
    published_base_candidate=$(git rev-parse --verify "$base_candidate_arg^{commit}" 2>/dev/null || true)
  elif [[ -n "$base_before" ]] && git merge-base --is-ancestor "$main_head" "$base_before"; then
    published_base_candidate=$base_before
  elif [[ -n "$base_before" ]] && git merge-base --is-ancestor "$base_before" "$main_head"; then
    published_base_candidate=$main_head
  fi
  if [[ -n "$published_base_candidate" ]] && target_matches_base_inputs "$published_base_candidate"; then
    assembled_candidate_arg=$target_before
    base_candidate_arg=$published_base_candidate
  fi
fi

if [[ -z "$assembled_candidate_arg" ]]; then
  if [[ -f "$operation_index_file" ]]; then
    active_request=$(<"$operation_index_file")
    load_operation "$active_request"
  else
    create_operation
  fi
  assemble_operation
fi

printf '%s\n' 'Activating repository-pinned mise toolchain for readiness validation...'
command -v mise >/dev/null || fail "mise is required"
paseo_build_timed readiness:toolchain mise install
eval "$(mise activate bash)"

target_worktree=$(find_worktree_for_branch "$target_branch")
if [[ -n "$target_worktree" && "$(realpath -e -- "$target_worktree")" != "$build_root" ]]; then
  fail "$target_branch is checked out in another worktree: $target_worktree"
fi
for reserved_branch in "$base_backup_branch" "$target_backup_branch"; do
  reserved_worktree=$(find_worktree_for_branch "$reserved_branch")
  [[ -z "$reserved_worktree" ]] || fail "$reserved_branch is checked out: $reserved_worktree"
done
for branch_name in "${integration_branches[@]}"; do
  require_clean_worktree "$branch_name"
done

created_base_candidate=0
created_target_candidate=0
completed=0
declare -a temporary_files=()
cleanup() {
  local exit_code=$?
  trap - EXIT
  if ((!completed)); then
    if git rev-parse --quiet --verify MERGE_HEAD >/dev/null; then
      git merge --abort || true
    fi
    current_branch=$(git symbolic-ref --quiet --short HEAD || true)
    if [[ -n "$current_branch" && "$current_branch" != "$starting_branch" ]]; then
      git switch --quiet "$starting_branch" || true
    fi
  fi
  if ((created_target_candidate)) && git show-ref --verify --quiet "refs/heads/$target_candidate_branch"; then
    git branch -D "$target_candidate_branch" >/dev/null || true
  fi
  if ((created_base_candidate)) && git show-ref --verify --quiet "refs/heads/$base_candidate_branch"; then
    git branch -D "$base_candidate_branch" >/dev/null || true
  fi
  for temporary_file in "${temporary_files[@]}"; do
    rm -f -- "$temporary_file"
  done
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if [[ -n "$base_candidate_arg" ]]; then
  git cat-file -e "$base_candidate_arg^{commit}" 2>/dev/null ||
    fail "base candidate is not a commit: $base_candidate_arg"
  base_candidate_head=$(git rev-parse "$base_candidate_arg")
  if [[ -n "$frozen_main" ]]; then
    paseo_assert_frozen_ancestry "$build_root" "$frozen_main" "$base_candidate_head" 'base candidate' ||
      fail 'base candidate is outside the main snapshot'
  fi
  git merge-base --is-ancestor "$main_head" "$base_candidate_head" ||
    fail "base candidate does not contain current main $main_head"
else
  if [[ -n "$frozen_main" ]]; then
    paseo_assert_frozen_ancestry "$build_root" "$frozen_main" "$base_before" "$base_branch" ||
      fail 'rw-base is outside the main snapshot'
  fi
  git switch --quiet --create "$base_candidate_branch" "$base_branch"
  created_base_candidate=1
  if ! git merge-base --is-ancestor "$main_head" HEAD; then
    if git merge-base --is-ancestor HEAD "$main_head"; then
      git merge --ff-only "$main_head"
    else
      GIT_MERGE_AUTOEDIT=no git merge --no-ff --no-edit \
        -m "Merge branch 'main' into $base_candidate_branch" "$main_head"
    fi
  fi
  base_candidate_head=$(git rev-parse HEAD)
fi

base_rebuilt=0
[[ "$base_before" == "$base_candidate_head" ]] || base_rebuilt=1

push_candidates() {
  local base_source=$1
  local target_source=$2
  local remote_base_expected= remote_target_expected=
  if [[ -n "$operation_request" ]]; then
    remote_base_expected=$operation_remote_base_before
    remote_target_expected=$operation_remote_target_before
  else
    remote_base_expected=$(git rev-parse --verify "refs/remotes/origin/$base_branch" 2>/dev/null || true)
    remote_target_expected=$(git rev-parse --verify "refs/remotes/origin/$target_branch" 2>/dev/null || true)
  fi
  git push --atomic \
    "--force-with-lease=refs/heads/$base_branch:$remote_base_expected" \
    "--force-with-lease=refs/heads/$target_branch:$remote_target_expected" \
    origin \
    "$base_source:refs/heads/$base_branch" \
    "$target_source:refs/heads/$target_branch"
}

dependency_inputs_changed() {
  local old_ref=$1
  local new_ref=$2
  ! git diff --quiet "$old_ref..$new_ref" -- \
    package.json package-lock.json ':(glob)**/package.json' \
    ':(glob)patches/**' scripts/postinstall-patches.mjs
}

install_dependencies() {
  local old_ref=$1
  local new_ref=$2
  local install_log refresh_state npm_status tee_status
  local -a pipeline_status

  refresh_state=$(mktemp "${TMPDIR:-/tmp}/paseo-patch-refresh.XXXXXX")
  temporary_files+=("$refresh_state")
  install_log=$(mktemp "${TMPDIR:-/tmp}/paseo-npm-install.XXXXXX")
  temporary_files+=("$install_log")

  node "$patched_dependencies_helper" prepare \
    --root "$build_root" \
    --old-ref "$old_ref" \
    --new-ref "$new_ref" \
    --state-file "$refresh_state"
  printf '%s\n' 'Installing dependencies for the selected product tree...'
  if paseo_build_timed readiness:npm-install npm install 2>&1 | tee "$install_log"; then
    pipeline_status=("${PIPESTATUS[@]}")
  else
    pipeline_status=("${PIPESTATUS[@]}")
  fi
  npm_status=${pipeline_status[0]:-1}
  tee_status=${pipeline_status[1]:-1}
  if ((tee_status != 0)); then
    printf 'rebuild-rw-main: failed to capture npm install output (exit %s)\n' "$tee_status" >&2
    return "$tee_status"
  fi
  if ((npm_status != 0)); then
    printf 'rebuild-rw-main: npm install failed (exit %s)\n' "$npm_status" >&2
    return "$npm_status"
  fi
  node "$patched_dependencies_helper" check-install-log --log "$install_log"
  node "$patched_dependencies_helper" verify \
    --root "$build_root" \
    --state-file "$refresh_state"
  [[ -z "$(git status --porcelain)" ]] ||
    fail "npm install left tracked or untracked changes in the build worktree"
}

validate_patch_registry() {
  node "$patched_dependencies_helper" validate --root "$build_root"
}

verify_installed_patches() {
  node "$patched_dependencies_helper" verify --root "$build_root"
}

refresh_expo_router_types() {
  paseo_build_timed readiness:router-types node "$expo_router_types_helper" --root "$build_root"
}

verify_candidate_inputs() {
  local branch_name current_base current_target phase=
  [[ "$(git -C "$control_root" rev-parse "refs/heads/$packaging_branch")" == "$control_head_before" ]] || fail 'control HEAD moved during readiness'
  if [[ "$control_root" != "$build_root" ]]; then
    [[ "$(git -C "$control_root" rev-parse HEAD)" == "$control_head_before" ]] || fail 'control checkout moved during readiness'
    [[ -z "$(git -C "$control_root" status --porcelain)" ]] || fail 'control worktree changed during readiness'
  fi
  [[ "$(git rev-parse "$upstream_branch")" == "$main_head" ]] || fail 'main moved during readiness'
  current_base=$(git rev-parse --verify "refs/heads/$base_branch" 2>/dev/null || true)
  current_target=$(git rev-parse --verify "$target_branch" 2>/dev/null || true)
  if [[ -n "$operation_request" && -f "$operation_dir/progress.env" ]]; then
    # shellcheck disable=SC1090
    source "$operation_dir/progress.env"
    phase=$rw_main_operation_phase
  fi
  if [[ "$phase" == publishing || "$phase" == awaiting-ready ]]; then
    [[ "$current_base" == "$base_before" || "$current_base" == "$base_candidate_head" ]] ||
      fail 'rw-base moved to an unexpected value during readiness recovery'
    [[ "$current_target" == "$target_before" || "$current_target" == "$(git rev-parse HEAD)" ]] ||
      fail 'rw-main moved to an unexpected value during readiness recovery'
  else
    [[ "$current_base" == "$base_before" ]] || fail 'rw-base moved during readiness'
    [[ "$current_target" == "$target_before" ]] || fail 'rw-main moved during readiness'
  fi
  if [[ -n "$frozen_main" ]]; then
    paseo_assert_frozen_main "$build_root" "$frozen_main" || fail 'frozen main validation failed'
  fi
  for branch_name in "${integration_branches[@]}"; do
    [[ "$(git rev-parse "$branch_name")" == "${integration_heads[$branch_name]}" ]] || fail "$branch_name moved during readiness"
    require_clean_worktree "$branch_name"
    if [[ -n "$frozen_main" ]]; then
      paseo_assert_frozen_ancestry "$build_root" "$frozen_main" "${integration_heads[$branch_name]}" "$branch_name" ||
        fail 'overlay is outside the main snapshot'
    fi
  done
}

printf 'Upstream: %s (%s)\n' "$upstream_branch" "$(git rev-parse --short "$main_head")"
printf 'Base candidate: %s\n' "$base_candidate_head"
for branch_name in "${integration_branches[@]}"; do
  read -r behind ahead < <(git rev-list --left-right --count "$main_head...$branch_name")
  printf 'Overlay: %s (%s; behind main %s, ahead %s)\n' \
    "$branch_name" "$(git rev-parse --short "$branch_name")" "$behind" "$ahead"
done

if ((!dry_run)) && ((base_rebuilt == 0)) && target_matches_base_inputs "$base_candidate_head"; then
  printf 'No-op: %s and %s already match every input.\n' "$base_branch" "$target_branch"
  if [[ "$(git symbolic-ref --quiet --short HEAD || true)" != "$target_branch" ]]; then
    git switch --quiet "$target_branch"
  fi
  validate_patch_registry
  if [[ "$starting_branch" != "$target_branch" ]]; then
    install_dependencies "$starting_head" "$target_before"
  else
    verify_installed_patches
  fi
  refresh_expo_router_types
  verify_candidate_inputs
  if ((push_target)); then
    push_candidates "$base_candidate_head" "$target_before"
    printf 'Updated origin/%s and origin/%s atomically.\n' "$base_branch" "$target_branch"
  fi
  completed=1
  if [[ -n "$operation_request" ]]; then
    write_operation_progress awaiting-ready "${#integration_branches[@]}" "$base_candidate_head" \
      "${rw_main_operation_remote_published:-0}" 1
    if [[ -n "$run_id" || -n "$parent_operation" ]]; then
      printf 'PASEO_RW_MAIN_OPERATION=%s\n' "$operation_request"
    else
      cleanup_operation_files "$operation_request" completed
    fi
  fi
  printf 'PASEO_RW_BASE_BEFORE=%s\n' "$base_before"
  printf 'PASEO_RW_BASE_AFTER=%s\n' "$base_candidate_head"
  printf '%s\n' 'PASEO_RW_BASE_REBUILT=0'
  printf 'PASEO_RW_MAIN_BEFORE=%s\n' "$target_before"
  printf 'PASEO_RW_MAIN_AFTER=%s\n' "$target_before"
  printf '%s\n' 'PASEO_RW_MAIN_REBUILT=0'
  exit 0
fi

if [[ "$(git symbolic-ref --quiet --short HEAD || true)" != "$starting_branch" ]]; then
  git switch --quiet "$starting_branch"
fi
git switch --quiet --create "$target_candidate_branch" "$base_candidate_head"
created_target_candidate=1

if [[ -n "$assembled_candidate_arg" ]]; then
  git cat-file -e "$assembled_candidate_arg^{commit}" 2>/dev/null ||
    fail "assembled candidate is not a commit: $assembled_candidate_arg"
  git reset --hard "$assembled_candidate_arg" >/dev/null
else
  for branch_name in "${integration_branches[@]}"; do
    printf 'Merging overlay %s...\n' "$branch_name"
    GIT_MERGE_AUTOEDIT=no git merge --no-ff --no-edit \
      -m "Merge branch '$branch_name' into $target_candidate_branch" "${integration_heads[$branch_name]}"
  done
fi

validate_patch_registry
if [[ "$starting_branch" != "$target_branch" ]] ||
  [[ -z "$target_before" ]] || dependency_inputs_changed "$target_before" HEAD; then
  install_dependencies "$starting_head" HEAD
else
  verify_installed_patches
fi
refresh_expo_router_types

run_candidate_capability_checks() {
  [[ -n "$operation_request" ]] || return 0
  local conflict_file path directory stem test_file input_hash previous_hash status
  local branch dependencies dependency head comparison_base index platform applicable
  local node_version npm_version toolchain_hash dependency_hash output_hash executor_hash
  local candidate_tree max_batch_tests=8 automatic_test_limit=32 reason_key conflict_name
  local test_directory test_name source_path batch_number runner_key runner_label runner_cwd
  local source_directory source_name source_stem direct_source category selection_file selection_hash
  local applicable_set_hash selection_version selection_tree selection_set_hash
  local record_kind record_path record_action record_explanation record_extra
  local workspace workspace_root runner_project runner_arg temp
  local -a relevant_paths=() conflict_relevant_paths=() candidate_tests=() selected_tests=()
  local -a applicable_tests=() batch_tests=() batch_args=() runner_order=()
  local -a conflict_files=() dependency_source_paths=() dependency_changed_tests=()
  local -a excluded_tests=() batch_records=()
  local -A seen_paths=() seen_conflict_paths=() seen_tests=() seen_test_reasons=() test_reasons=()
  local -A direct_tests=() excluded_reasons=() seen_excluded=() test_applicable=()
  local -A test_runner_keys=() test_runner_labels=() test_runner_cwds=() test_runner_projects=()
  local -A test_runner_args=() seen_runners=() applicable_set=() selection_seen=()
  local -A selection_actions=() selection_explanations=()

  normalize_repo_path() {
    local normalized=$1
    while [[ "$normalized" == ./* ]]; do normalized=${normalized#./}; done
    printf '%s\n' "$normalized"
  }

  add_relevant_path() {
    local relevant_path
    relevant_path=$(normalize_repo_path "$1")
    [[ -n "$relevant_path" ]] || return 0
    if [[ -z "${seen_paths[$relevant_path]+present}" ]]; then
      relevant_paths+=("$relevant_path")
      seen_paths[$relevant_path]=1
    fi
  }

  test_is_related_to_paths() {
    local candidate_path=$1
    shift
    test_directory=.
    [[ "$candidate_path" != */* ]] || test_directory=${candidate_path%/*}
    test_name=${candidate_path##*/}
    for source_path in "$@"; do
      # Keep this nested candidate/path loop in the shell; spawning two
      # processes per comparison makes dense dependency changes expensive.
      source_directory=.
      [[ "$source_path" != */* ]] || source_directory=${source_path%/*}
      [[ "$test_directory" == "$source_directory" ]] || continue
      source_name=${source_path##*/}
      source_stem=${source_name%.*}
      case "$test_name" in
        "$source_stem".test.* | "$source_stem".*.test.* | "$source_stem"-*.test.*)
          return 0
          ;;
      esac
    done
    return 1
  }

  excluded_test_category() {
    # Node's built-in runner accepts the same extensions as Vitest.
    local node_test_import="(^|[^[:alnum:]_$])(from[[:space:]]+|require[[:space:]]*\\([[:space:]]*|import[[:space:]]*(\\([[:space:]]*)?)[\"']node:test[\"']"
    if LC_ALL=C grep -Eq -- "$node_test_import" "$1"; then
      printf '%s\n' node-test-runner
      return 0
    fi
    case "$1" in
      *.real.*) printf '%s\n' real-provider ;;
      *.local.*) printf '%s\n' local-resource ;;
      *.e2e.test.*) printf '%s\n' e2e-daemon ;;
      *.browser.test.*) printf '%s\n' browser ;;
      packages/cli/tests/*) printf '%s\n' cli-script-runner ;;
      packages/app/*)
        # The product's unit config also explicitly includes its version helper test.
        case "$1" in
          packages/app/src/*.test.ts | packages/app/src/*.test.tsx | \
            packages/app/native-release-version.test.ts) return 1 ;;
          *) printf '%s\n' outside-app-unit-include ;;
        esac
        ;;
      *)
        # Vitest's default test extension set, excluding other .test. assets.
        case "$1" in
          *.test.[jt]s | *.test.[jt]sx | *.test.[cm][jt]s | *.test.[cm][jt]sx) return 1 ;;
          *) printf '%s\n' unsupported-vitest-extension ;;
        esac
        ;;
    esac
  }

  add_excluded_test() {
    local excluded_path reason=$2 excluded_category=$3
    excluded_path=$(normalize_repo_path "$1")
    [[ -f "$excluded_path" ]] || return 0
    if [[ -z "${seen_excluded[$excluded_path]+present}" ]]; then
      excluded_tests+=("$excluded_path")
      excluded_reasons[$excluded_path]="$excluded_category:$reason"
      seen_excluded[$excluded_path]=1
    else
      excluded_reasons[$excluded_path]+=";$excluded_category:$reason"
    fi
  }

  add_test_candidate() {
    local candidate_path reason=$2
    candidate_path=$(normalize_repo_path "$1")
    [[ "$candidate_path" == *.test.* && -f "$candidate_path" ]] || return 0
    if category=$(excluded_test_category "$candidate_path"); then
      add_excluded_test "$candidate_path" "$reason" "$category"
      return 0
    fi
    if [[ -z "${seen_tests[$candidate_path]+present}" ]]; then
      candidate_tests+=("$candidate_path")
      seen_tests[$candidate_path]=1
      test_reasons[$candidate_path]=$reason
    else
      reason_key="$candidate_path"$'\034'"$reason"
      if [[ -z "${seen_test_reasons[$reason_key]+present}" ]]; then
        test_reasons[$candidate_path]+=";$reason"
      fi
    fi
    seen_test_reasons["$candidate_path"$'\034'"$reason"]=1
  }

  mark_direct_test() {
    add_test_candidate "$1" "$2"
    local normalized
    normalized=$(normalize_repo_path "$1")
    [[ -n "${seen_tests[$normalized]+present}" ]] && direct_tests[$normalized]=1
    return 0
  }

  record_capability_failure() {
    # Validation during publication recovery cannot erase an irreversible push.
    # shellcheck disable=SC1090
    source "$operation_dir/progress.env"
    case "$rw_main_operation_phase" in
      publishing | awaiting-ready) return 0 ;;
    esac
    write_operation_progress validation-failed "${#integration_branches[@]}" "$base_candidate_head"
  }

  direct_source_for_test() {
    local candidate_path=$1 candidate_name candidate_stem candidate_directory
    candidate_name=$(basename -- "$candidate_path")
    candidate_directory=$(dirname -- "$candidate_path")
    case "$candidate_name" in
      *.windows-shell.test.*) candidate_stem=${candidate_name%%.windows-shell.test.*} ;;
      *.posix.test.*) candidate_stem=${candidate_name%%.posix.test.*} ;;
      *.test.*) candidate_stem=${candidate_name%%.test.*} ;;
      *) return 1 ;;
    esac
    find "$candidate_directory" -maxdepth 1 -type f \
      -name "$candidate_stem.*" ! -name '*.test.*' -print -quit 2>/dev/null
  }

  assign_test_runner() {
    local candidate_path=$1 config=
    workspace_root=.
    runner_project=
    runner_arg=$candidate_path
    if [[ "$candidate_path" == packages/*/* ]]; then
      workspace=${candidate_path#packages/}
      workspace=${workspace%%/*}
      workspace_root="packages/$workspace"
      for config in vitest.config.ts vitest.config.mts vitest.config.js vitest.config.mjs; do
        [[ -f "$workspace_root/$config" ]] && break
        config=
      done
      if [[ -n "$config" ]]; then
        runner_arg=${candidate_path#"$workspace_root/"}
        [[ "$workspace_root" == packages/app ]] && runner_project=unit
      else
        workspace_root=.
      fi
    fi
    runner_key="$workspace_root"$'\034'"$runner_project"
    runner_label=$workspace_root
    [[ -n "$runner_project" ]] && runner_label+="?project=$runner_project"
    test_runner_keys[$candidate_path]=$runner_key
    test_runner_labels[$candidate_path]=$runner_label
    test_runner_cwds[$runner_key]=$workspace_root
    test_runner_projects[$runner_key]=$runner_project
    test_runner_args[$candidate_path]=$runner_arg
  }

  test_is_applicable() {
    local candidate_path=$1
    if [[ "$candidate_path" == *.windows-shell.test.* ]]; then
      [[ "$platform" == MINGW* || "$platform" == MSYS* || "$platform" == CYGWIN* ]]
    elif [[ "$candidate_path" == *.posix.test.* ]]; then
      [[ "$platform" != MINGW* && "$platform" != MSYS* && "$platform" != CYGWIN* ]]
    else
      return 0
    fi
  }

  shopt -s nullglob
  conflict_files=(
    "$operation_dir"/conflict-sync-[0-9]*.env
    "$operation_dir"/conflict-overlay-[0-9]*.env
  )
  for conflict_file in "${conflict_files[@]}"; do
    # shellcheck disable=SC1090
    source "$conflict_file"
    conflict_name=$(basename -- "$conflict_file")
    [[ "${conflict_version:-}" == 1 &&
      ( "$conflict_phase" == sync || "$conflict_phase" == overlay ) &&
      "$conflict_name" == "conflict-$conflict_phase-$conflict_index.env" ]] ||
      fail "invalid conflict snapshot: $conflict_file"
    for path in "${conflict_paths[@]}"; do
      path=$(normalize_repo_path "$path")
      add_relevant_path "$path"
      if [[ -z "${seen_conflict_paths[$path]+present}" ]]; then
        conflict_relevant_paths+=("$path")
        seen_conflict_paths[$path]=1
      fi
    done
    comparison_base=$(git merge-base "$operation_main" "$conflict_source" 2>/dev/null || true)
    if [[ -n "$comparison_base" ]]; then
      while IFS= read -r test_file; do
        test_file=$(normalize_repo_path "$test_file")
        if [[ -n "$test_file" ]] && test_is_related_to_paths "$test_file" "${conflict_relevant_paths[@]}"; then
          add_test_candidate "$test_file" "conflict-source-range:$conflict_phase:$conflict_index"
        fi
      done < <(git diff --name-only "$comparison_base..$conflict_source" -- ':(glob)**/*.test.*')
    fi
    if [[ "$conflict_phase" == sync ]]; then
      comparison_base=$operation_base_before
    else
      comparison_base=$conflict_source
    fi
    while IFS= read -r test_file; do
      test_file=$(normalize_repo_path "$test_file")
      if [[ -n "$test_file" ]] && test_is_related_to_paths "$test_file" "${conflict_relevant_paths[@]}"; then
        add_test_candidate "$test_file" "conflict-upstream-range:$conflict_phase:$conflict_index"
      fi
    done < <(git diff --name-only "$comparison_base..$operation_main" -- ':(glob)**/*.test.*')
  done
  shopt -u nullglob
  for index in "${!operation_branches[@]}"; do
    branch=${operation_branches[$index]}
    dependencies=${operation_dependencies[$index]:-}
    [[ -n "$dependencies" ]] || continue
    IFS=',' read -r -a declared_dependencies <<<"$dependencies"
    for dependency in "$branch" "${declared_dependencies[@]}"; do
      dependency=${dependency#"${dependency%%[![:space:]]*}"}
      dependency=${dependency%"${dependency##*[![:space:]]}"}
      [[ -n "$dependency" ]] || continue
      head=$(git rev-parse "$dependency")
      if [[ -n "$target_before" ]] && git merge-base --is-ancestor "$head" "$target_before"; then
        continue
      fi
      comparison_base=$(git merge-base "$target_before" "$head" 2>/dev/null || git merge-base "$operation_main" "$head")
      dependency_source_paths=()
      dependency_changed_tests=()
      while IFS= read -r path; do
        [[ -n "$path" ]] || continue
        path=$(normalize_repo_path "$path")
        if [[ "$path" == *.test.* ]]; then
          dependency_changed_tests+=("$path")
        else
          dependency_source_paths+=("$path")
          add_relevant_path "$path"
        fi
      done < <(git diff --name-only "$comparison_base..$head")
      for test_file in "${dependency_changed_tests[@]}"; do
        direct_source=$(direct_source_for_test "$test_file")
        if test_is_related_to_paths "$test_file" "${dependency_source_paths[@]}" ||
          [[ -n "$direct_source" ]]; then
          add_test_candidate "$test_file" "dependency-range:$dependency"
          [[ -n "$direct_source" ]] && add_relevant_path "$direct_source"
        fi
      done
    done
  done
  ((${#relevant_paths[@]} > 0)) || return 0
  for path in "${relevant_paths[@]}"; do
    if [[ "$path" == *.test.* ]]; then
      mark_direct_test "$path" "direct:$path"
      continue
    fi
    directory=$(dirname -- "$path")
    stem=$(basename -- "$path")
    stem=${stem%.*}
    while IFS= read -r test_file; do
      test_file=$(normalize_repo_path "$test_file")
      test_name=$(basename -- "$test_file")
      case "$test_name" in
        "$stem".test.* | "$stem".posix.test.* | "$stem".windows-shell.test.*)
          mark_direct_test "$test_file" "direct:$path"
          ;;
        *)
          if category=$(excluded_test_category "$test_file"); then
            add_excluded_test "$test_file" "neighbor:$path" "$category"
          fi
          ;;
      esac
    done < <(find "$directory" -maxdepth 1 -type f \
      -name "$stem*.test.*" \
      -print 2>/dev/null | LC_ALL=C sort)
  done
  mapfile -t relevant_paths < <(printf '%s\n' "${relevant_paths[@]}" | LC_ALL=C sort -u)
  if ((${#candidate_tests[@]} > 0)); then
    mapfile -t candidate_tests < <(printf '%s\n' "${candidate_tests[@]}" | LC_ALL=C sort -u)
  fi
  if ((${#excluded_tests[@]} > 0)); then
    mapfile -t excluded_tests < <(printf '%s\n' "${excluded_tests[@]}" | LC_ALL=C sort -u)
  fi
  platform=${PASEO_TEST_PLATFORM:-$(uname -s)}
  for test_file in "${candidate_tests[@]}"; do
    assign_test_runner "$test_file"
    if test_is_applicable "$test_file"; then
      test_applicable[$test_file]=1
      applicable_tests+=("$test_file")
      applicable_set[$test_file]=1
    else
      test_applicable[$test_file]=0
    fi
  done

  candidate_tree=$(git rev-parse HEAD^{tree})
  node_version=$(_paseo_build_stamp_runtime_version node) || fail 'cannot identify Node runtime for capability tests'
  npm_version=$(_paseo_build_stamp_runtime_version npm) || fail 'cannot identify npm runtime for capability tests'
  toolchain_hash=$(_paseo_build_stamp_toolchain_hash "$build_root" "$node_version" "$npm_version") ||
    fail 'cannot hash toolchain inputs for capability tests'
  dependency_hash=$(_paseo_build_stamp_dependency_hash "$build_root") ||
    fail 'cannot hash dependency inputs for capability tests'
  output_hash=$(_paseo_build_stamp_output_hash "$build_root" 2>/dev/null || printf missing)
  executor_hash=$(
    {
      git -C "$control_root" show "$control_head_before:dwyanewang/rebuild-rw-main.sh"
      git -C "$control_root" show "$control_head_before:dwyanewang/rw-conflict-evidence.sh"
    } | sha256sum | awk '{print $1}'
  )
  selected_tests=("${applicable_tests[@]}")
  selection_file="$operation_dir/capability-test-selection.tsv"
  selection_hash=none
  if ((${#applicable_tests[@]} > automatic_test_limit)); then
    applicable_set_hash=$(
      for test_file in "${applicable_tests[@]}"; do
        printf '%s\t%s\t%s\n' "$test_file" "${direct_tests[$test_file]:-0}" \
          "${test_runner_labels[$test_file]}"
      done | sha256sum | awk '{print $1}'
    )
    if [[ ! -f "$selection_file" ]]; then
      temp=$(mktemp "$operation_dir/.capability-test-selection.XXXXXX")
      {
        printf '# Bind every applicable candidate to run or skip. Direct tests must run; every decision needs a non-TODO explanation.\n'
        printf 'selection-version\t1\n'
        printf 'candidate-tree\t%s\n' "$candidate_tree"
        printf 'applicable-set\t%s\n' "$applicable_set_hash"
        for test_file in "${applicable_tests[@]}"; do
          printf 'test\t%s\tTODO\tTODO\n' "$test_file"
        done
      } >"$temp"
      chmod 600 "$temp"
      mv -- "$temp" "$selection_file"
      paseo_build_stage "integration:capability-tests selection-required=${#applicable_tests[@]} limit=$automatic_test_limit"
      fail "${#applicable_tests[@]} applicable candidate tests exceed the automatic selection limit $automatic_test_limit; review $selection_file in this operation, mark every row run or skip with a reason, keep every direct test as run, then retry the same request"
    fi
    selection_version=
    selection_tree=
    selection_set_hash=
    while IFS=$'\t' read -r record_kind record_path record_action record_explanation record_extra ||
      [[ -n "$record_kind$record_path$record_action$record_explanation$record_extra" ]]; do
      [[ -n "$record_kind" && "$record_kind" != \#* ]] || continue
      case "$record_kind" in
        selection-version)
          [[ -z "$record_action$record_explanation$record_extra" ]] || fail 'malformed capability test selection version'
          selection_version=$record_path
          ;;
        candidate-tree)
          [[ -z "$record_action$record_explanation$record_extra" ]] || fail 'malformed capability test selection tree'
          selection_tree=$record_path
          ;;
        applicable-set)
          [[ -z "$record_action$record_explanation$record_extra" ]] || fail 'malformed capability test selection set'
          selection_set_hash=$record_path
          ;;
        test)
          [[ -z "$record_extra" && -n "$record_path" && -n "${applicable_set[$record_path]+present}" ]] ||
            fail "capability test selection contains an unknown or malformed row: $record_path"
          [[ -z "${selection_seen[$record_path]+present}" ]] ||
            fail "capability test selection repeats $record_path"
          [[ "$record_action" == run || "$record_action" == skip ]] ||
            fail "capability test selection must mark $record_path as run or skip"
          record_explanation=${record_explanation#"${record_explanation%%[![:space:]]*}"}
          record_explanation=${record_explanation%"${record_explanation##*[![:space:]]}"}
          [[ -n "$record_explanation" && "$record_explanation" != TODO ]] ||
            fail "capability test selection requires a reviewed explanation for $record_path"
          if [[ "$record_action" == skip && -n "${direct_tests[$record_path]+present}" ]]; then
            fail "direct capability test cannot be skipped: $record_path"
          fi
          selection_seen[$record_path]=1
          selection_actions[$record_path]=$record_action
          selection_explanations[$record_path]=$record_explanation
          ;;
        *) fail "unknown capability test selection row: $record_kind" ;;
      esac
    done <"$selection_file"
    [[ "$selection_version" == 1 && "$selection_tree" == "$candidate_tree" &&
      "$selection_set_hash" == "$applicable_set_hash" ]] ||
      fail 'capability test selection does not match the frozen candidate tree and complete applicable set'
    selected_tests=()
    for test_file in "${applicable_tests[@]}"; do
      [[ -n "${selection_seen[$test_file]+present}" ]] ||
        fail "capability test selection is missing $test_file"
      [[ "${selection_actions[$test_file]}" == run ]] && selected_tests+=("$test_file")
    done
    # The threshold requires a reviewed budget, not discarded mandatory coverage.
    # A multi-branch operation may legitimately need more than 32 direct tests.
    selection_hash=$(sha256sum "$selection_file" | awk '{print $1}')
  fi

  for test_file in "${selected_tests[@]}"; do
    runner_key=${test_runner_keys[$test_file]}
    if [[ -z "${seen_runners[$runner_key]+present}" ]]; then
      runner_order+=("$runner_key")
      seen_runners[$runner_key]=1
    fi
  done
  batch_number=0
  for runner_key in "${runner_order[@]}"; do
    index=0
    for test_file in "${selected_tests[@]}"; do
      [[ "${test_runner_keys[$test_file]}" == "$runner_key" ]] || continue
      if ((index % max_batch_tests == 0)); then ((batch_number += 1)); fi
      batch_records+=("$batch_number"$'\t'"$test_file"$'\t'"${test_runner_args[$test_file]}")
      ((index += 1))
    done
  done
  {
    printf 'candidate\t%s\n' "$candidate_tree"
    printf 'platform\t%s\nnode\t%s\nnpm\t%s\n' "$platform" "$node_version" "$npm_version"
    printf 'toolchain\t%s\ndependencies\t%s\noutputs\t%s\nexecutor\t%s\n' \
      "$toolchain_hash" "$dependency_hash" "$output_hash" "$executor_hash"
    printf 'batch-size\t%s\napplicable-tests\t%s\nselected-tests\t%s\n' \
      "$max_batch_tests" "${#applicable_tests[@]}" "${#selected_tests[@]}"
    printf 'selection-file\t%s\nselection-hash\t%s\n' "$selection_file" "$selection_hash"
    for path in "${relevant_paths[@]}"; do printf 'path\t%s\n' "$path"; done
    for test_file in "${candidate_tests[@]}"; do
      printf 'candidate-test\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$test_file" "${test_applicable[$test_file]}" "${test_reasons[$test_file]}" \
        "${direct_tests[$test_file]:-0}" "${test_runner_labels[$test_file]}" \
        "${test_runner_args[$test_file]}"
    done
    for test_file in "${excluded_tests[@]}"; do
      printf 'excluded-test\t%s\t%s\n' "$test_file" "${excluded_reasons[$test_file]}"
      printf 'coverage-gap\t%s\texcluded:%s\n' "$test_file" "${excluded_reasons[$test_file]}"
    done
    for test_file in "${candidate_tests[@]}"; do
      [[ "${test_applicable[$test_file]}" == 1 ]] ||
        printf 'coverage-gap\t%s\tplatform:%s\n' "$test_file" "$platform"
      if [[ "${selection_actions[$test_file]:-}" == skip ]]; then
        printf 'coverage-gap\t%s\treviewed-skip:%s\n' \
          "$test_file" "${selection_explanations[$test_file]}"
      fi
    done
    for path in "${batch_records[@]}"; do
      printf 'batch-test\t%s\n' "$path"
    done
  } >"$operation_dir/capability-tests.tsv"
  if ((${#selected_tests[@]} == 0)); then
    printf '%s\n' 'No related candidate tests were found; recording the coverage gap and relying on reviewed evidence plus readiness.'
    paseo_build_stage 'integration:capability-tests gap=no-related-tests'
    return 0
  fi
  input_hash=$(git hash-object -- "$operation_dir/capability-tests.tsv")
  previous_hash=$(cat "$operation_dir/capability-tests.pass" 2>/dev/null || true)
  if [[ "$previous_hash" == "$input_hash" ]]; then
    printf '%s\n' 'Reusing candidate capability tests for identical source, platform, toolchain, dependency, dist, and executor inputs.'
    paseo_build_stage "integration:capability-tests reuse=1 count=${#selected_tests[@]}"
    return 0
  fi
  batch_number=0
  for runner_key in "${runner_order[@]}"; do
    runner_cwd=${test_runner_cwds[$runner_key]}
    runner_project=${test_runner_projects[$runner_key]}
    batch_tests=()
    batch_args=()
    for test_file in "${selected_tests[@]}"; do
      [[ "${test_runner_keys[$test_file]}" == "$runner_key" ]] || continue
      batch_tests+=("$test_file")
      batch_args+=("${test_runner_args[$test_file]}")
      if ((${#batch_tests[@]} == max_batch_tests)); then
        ((batch_number += 1))
        status=0
        if [[ -n "$runner_project" ]]; then
          (cd "$build_root/$runner_cwd" && paseo_build_timed \
            "integration:capability-tests:batch-$batch_number" npm exec -- vitest run \
            --project "$runner_project" "${batch_args[@]}" --bail=1) || status=$?
        else
          (cd "$build_root/$runner_cwd" && paseo_build_timed \
            "integration:capability-tests:batch-$batch_number" npm exec -- vitest run \
            "${batch_args[@]}" --bail=1) || status=$?
        fi
        if ((status != 0)); then
          record_capability_failure
          fail "candidate capability tests failed with exit $status in batch $batch_number"
        fi
        batch_tests=()
        batch_args=()
      fi
    done
    if ((${#batch_tests[@]} > 0)); then
      ((batch_number += 1))
      status=0
      if [[ -n "$runner_project" ]]; then
        (cd "$build_root/$runner_cwd" && paseo_build_timed \
          "integration:capability-tests:batch-$batch_number" npm exec -- vitest run \
          --project "$runner_project" "${batch_args[@]}" --bail=1) || status=$?
      else
        (cd "$build_root/$runner_cwd" && paseo_build_timed \
          "integration:capability-tests:batch-$batch_number" npm exec -- vitest run \
          "${batch_args[@]}" --bail=1) || status=$?
      fi
      if ((status != 0)); then
        record_capability_failure
        fail "candidate capability tests failed with exit $status in batch $batch_number"
      fi
    fi
  done
  [[ -z "$(git status --porcelain)" ]] || fail 'candidate capability tests left tracked or untracked changes'
  printf '%s\n' "$input_hash" >"$operation_dir/capability-tests.pass"
}

validation_mode=full
stamp_check_started=$SECONDS
paseo_build_stage 'readiness:stamp-check:start'
if paseo_verify_build_stamp "$build_root" "$server_build_stamp" tree readiness HEAD; then
  paseo_build_stage "readiness:stamp-check:end exit=0 elapsed=$((SECONDS - stamp_check_started))s"
  validation_mode=trusted-tree-reuse
  printf 'Reusing trusted readiness validation for candidate tree %s.\n' \
    "$(git rev-parse --short HEAD^{tree})"
else
  paseo_build_stage "readiness:stamp-check:end exit=1 reason=${PASEO_BUILD_STAMP_MISS_REASON:-unknown} elapsed=$((SECONDS - stamp_check_started))s"
  printf 'Readiness stamp miss (%s); refreshing generated workspace declarations...\n' \
    "${PASEO_BUILD_STAMP_MISS_REASON:-unknown}"
  paseo_build_timed readiness:build-server-deps npm run build:server-deps
  paseo_build_timed readiness:build-app-audio-dep \
    npm run build --workspace=@getpaseo/expo-two-way-audio
  paseo_build_timed readiness:typecheck-app-early \
    npm run typecheck --workspace=@getpaseo/app
  paseo_build_timed readiness:build-server \
    npm run build --workspace=@getpaseo/server
  paseo_build_timed readiness:build-cli \
    npm run build --workspace=@getpaseo/cli

  printf '%s\n' 'Running repository checks...'
  paseo_build_timed readiness:format-check npm run format:check
  paseo_build_timed readiness:typecheck npm run typecheck
  paseo_build_timed readiness:lint npm run lint
fi
[[ -z "$(git status --porcelain)" ]] || fail "repository checks left tracked or untracked changes"
if paseo_build_timed readiness:stamp-write paseo_write_build_stamp "$build_root" "$server_build_stamp" readiness HEAD; then
  printf 'PASEO_SERVER_BUILD_STAMP_FILE=%s\n' "$server_build_stamp"
else
  rm -f -- "$server_build_stamp"
  printf '%s\n' \
    'rebuild-rw-main: could not record the optional readiness stamp; future candidates will run full validation.' \
    >&2
fi
printf 'PASEO_RW_MAIN_VALIDATION_MODE=%s\n' "$validation_mode"

run_candidate_capability_checks
[[ -z "$(git status --porcelain)" ]] || fail 'candidate capability tests left tracked or untracked changes'
if [[ "${PASEO_TEST_INTERRUPT_AFTER_CAPABILITY_CHECKS:-0}" == 1 ]]; then
  printf '%s\n' 'Injected interruption after candidate capability checks and before publication.' >&2
  exit 97
fi

target_candidate_head=$(git rev-parse HEAD)
printf 'Final candidate: %s\n' "$target_candidate_head"
verify_candidate_inputs

if ((dry_run)); then
  git switch --quiet "$starting_branch"
  completed=1
  if [[ -n "$operation_request" ]]; then
    cleanup_operation_files "$operation_request" completed
  fi
  printf '%s\n' 'Dry run passed; product refs were not changed.'
  exit 0
fi

if [[ -n "$operation_request" ]]; then
  # shellcheck disable=SC1090
  source "$operation_dir/progress.env"
  if [[ "$rw_main_operation_phase" != publishing ]]; then
    write_operation_progress publishing "${#integration_branches[@]}" "$base_candidate_head"
  fi
fi

remote_already_published=0
if [[ -n "$operation_request" && -f "$operation_dir/progress.env" ]]; then
  # shellcheck disable=SC1090
  source "$operation_dir/progress.env"
  remote_already_published=${rw_main_operation_remote_published:-0}
fi
if ((push_target)); then
  remote_base_actual=$(git ls-remote --heads origin "refs/heads/$base_branch" | awk '{print $1}')
  remote_target_actual=$(git ls-remote --heads origin "refs/heads/$target_branch" | awk '{print $1}')
  if [[ "$remote_base_actual" == "$base_candidate_head" && "$remote_target_actual" == "$target_candidate_head" ]]; then
    remote_already_published=1
    if [[ -n "$operation_request" ]]; then
      write_operation_progress publishing "${#integration_branches[@]}" "$base_candidate_head" 1 0
    fi
    printf '%s\n' 'Remote publication already completed; continuing local finalization.'
  elif [[ "$remote_base_actual" == "${operation_remote_base_before:-$remote_base_actual}" &&
    "$remote_target_actual" == "${operation_remote_target_before:-$remote_target_actual}" &&
    "$remote_already_published" == 0 ]]; then
    push_candidates "$base_candidate_head" "$target_candidate_head"
    remote_already_published=1
    if [[ "${PASEO_TEST_INTERRUPT_AFTER_REMOTE_REFS_BEFORE_PROGRESS:-0}" == 1 ]]; then
      printf '%s\n' 'Injected interruption after remote refs and before publication progress write.' >&2
      exit 96
    fi
    if [[ -n "$operation_request" ]]; then
      write_operation_progress publishing "${#integration_branches[@]}" "$base_candidate_head" 1 0
    fi
    if [[ "${PASEO_TEST_INTERRUPT_AFTER_PUSH:-0}" == 1 ]]; then
      printf '%s\n' 'Injected interruption after remote publication and before local refs.' >&2
      exit 92
    fi
  else
    fail 'remote refs moved to values outside the operation publication transition'
  fi
fi

local_base_actual=$(git rev-parse --verify "refs/heads/$base_branch" 2>/dev/null || true)
local_target_actual=$(git rev-parse --verify "refs/heads/$target_branch" 2>/dev/null || true)
[[ "$local_base_actual" == "$base_before" || "$local_base_actual" == "$base_candidate_head" ]] ||
  fail 'rw-base moved to a third value during local publication'
[[ "$local_target_actual" == "$target_before" || "$local_target_actual" == "$target_candidate_head" ]] ||
  fail 'rw-main moved to a third value during local publication'
if [[ -n "$base_before" ]]; then
  git branch -f "$base_backup_branch" "$base_before" >/dev/null
fi
if [[ -n "$target_before" ]]; then
  git branch -f "$target_backup_branch" "$target_before" >/dev/null
fi
git branch -f "$base_branch" "$base_candidate_head" >/dev/null
git branch -f "$target_branch" "$target_candidate_head" >/dev/null
if [[ "${PASEO_TEST_INTERRUPT_AFTER_LOCAL_REFS:-0}" == 1 ]]; then
  printf '%s\n' 'Injected interruption after local refs and before progress write.' >&2
  exit 94
fi
git switch --quiet "$target_branch"
if [[ -n "$operation_request" ]]; then
  write_operation_progress awaiting-ready "${#integration_branches[@]}" "$base_candidate_head" \
    "$remote_already_published" 1
fi
completed=1
if [[ -n "$operation_request" ]]; then
  if [[ -n "$run_id" || -n "$parent_operation" ]]; then
    printf 'PASEO_RW_MAIN_OPERATION=%s\n' "$operation_request"
  else
    cleanup_operation_files "$operation_request" completed
  fi
fi

printf 'Updated %s -> %s\n' "$base_branch" "$(git rev-parse --short "$base_branch")"
printf 'Updated %s -> %s\n' "$target_branch" "$(git rev-parse --short "$target_branch")"
if ((push_target)); then
  printf 'Updated origin/%s and origin/%s atomically.\n' "$base_branch" "$target_branch"
else
  printf '%s\n' 'Remote unchanged; rerun with --push after review if needed.'
fi
printf 'PASEO_RW_BASE_BEFORE=%s\n' "$base_before"
printf 'PASEO_RW_BASE_AFTER=%s\n' "$base_candidate_head"
printf 'PASEO_RW_BASE_REBUILT=%s\n' "$base_rebuilt"
printf 'PASEO_RW_MAIN_BEFORE=%s\n' "$target_before"
printf 'PASEO_RW_MAIN_AFTER=%s\n' "$target_candidate_head"
printf '%s\n' 'PASEO_RW_MAIN_REBUILT=1'
