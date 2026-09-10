#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash dwyanewang/prepare-rw-main-for-build.sh --build-root PATH --run-id ID [options]

Run the source-control preflight for build-paseo as one deterministic command:
validate worktrees, synchronize main, maintain the overlay manifest, and run
the atomic rw-base/rw-main readiness gate.

  --build-root PATH         Dedicated product build worktree (required).
  --push                    Atomically update origin/rw-base and origin/rw-main.
  --state-file PATH         Atomically write sourceable readiness results on success.
  --run-id ID               Required request identity; reuse across all attempts.
  --requested-at EPOCH      Original user-request time (defaults to now).
  --no-fetch                Reuse this run's frozen main; never fetch/ff/push main.
  --refresh-main            Explicitly refresh this run's main snapshot.
  --add-pr NUMBER           Forward an explicit PR addition to manifest sync.
  --add-branch BRANCH       Forward an explicit personal branch addition.
  --update-pr BRANCH NUMBER Update an existing branch's PR mapping explicitly.
  --remove-branch BRANCH    Forward a reviewed branch removal.
  --accept-review-request PATH
                            Forward one frozen semantic-review request.
  --accept-main-review SHA  Forward an accepted main review coordinate.
  --accept-branch-head BRANCH SHA
                            Forward an accepted exact branch head coordinate.
  --help                    Show this help.

Exit status 3 means semantic review is required. Exit status 4 means the
manifest changed and must be formatted, reviewed, committed, and pushed before
rerunning this command without addition/removal arguments.
EOF
}

build_root_arg=
push_target=0
state_file_arg=
run_id=
requested_at=
no_fetch=0
refresh_main=0
accepting_review=0
declare -a sync_args=()

while (($# > 0)); do
  case "$1" in
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
    --push)
      push_target=1
      shift
      ;;
    --state-file)
      (($# >= 2)) || {
        printf '%s\n' 'Missing value for --state-file.' >&2
        exit 2
      }
      [[ -z "$state_file_arg" ]] || {
        printf '%s\n' '--state-file may only be specified once.' >&2
        exit 2
      }
      state_file_arg=$2
      shift 2
      ;;
    --run-id | --requested-at)
      (($# >= 2)) || { printf 'Missing value for %s.\n' "$1" >&2; exit 2; }
      if [[ "$1" == --run-id ]]; then
        [[ -z "$run_id" && "$2" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$ ]] || exit 2
        run_id=$2
      else
        [[ -z "$requested_at" && "$2" =~ ^[1-9][0-9]{0,9}$ ]] || exit 2
        requested_at=$2
      fi
      shift 2
      ;;
    --no-fetch)
      no_fetch=1
      shift
      ;;
    --refresh-main)
      refresh_main=1
      shift
      ;;
    --add-pr | --add-branch | --remove-branch | --accept-main-review | --accept-review-request)
      (($# >= 2)) || {
        printf 'Missing value for %s.\n' "$1" >&2
        exit 2
      }
      sync_args+=("$1" "$2")
      if [[ "$1" == --accept-review-request || "$1" == --accept-main-review ]]; then
        accepting_review=1
      fi
      shift 2
      ;;
    --accept-branch-head | --update-pr)
      (($# >= 3)) || {
        printf '%s\n' 'Missing BRANCH or SHA for --accept-branch-head.' >&2
        exit 2
      }
      sync_args+=("$1" "$2" "$3")
      shift 3
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

((!no_fetch || !refresh_main)) || { printf '%s\n' '--no-fetch and --refresh-main are mutually exclusive.' >&2; exit 2; }
if [[ -z "$run_id" ]]; then
  printf '%s\n' '--run-id is required; retries must reuse the original ID with --no-fetch or --refresh-main.' >&2
  exit 2
fi
if ((accepting_review && !no_fetch)); then
  printf '%s\n' 'Accepting review requires the same --run-id and --no-fetch; refresh separately before reviewing.' >&2
  exit 2
fi

[[ -n "$build_root_arg" ]] || {
  printf '%s\n' '--build-root is required.' >&2
  usage >&2
  exit 2
}

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
control_root=$(git -C "$script_dir/.." rev-parse --show-toplevel)
manifest_path="$control_root/dwyanewang/rw-main-branches.txt"
upstream_branch=main
base_branch=rw-base
control_branch=chore/build-paseo
target_branch=rw-main
target_backup_branch=rw-main-backup-latest
started_at=$(date +%s)

state_file=
if [[ -n "$state_file_arg" ]]; then
  state_file=$(realpath -m -- "$state_file_arg")
  [[ ! -d "$state_file" ]] || {
    printf 'State file path is a directory: %s\n' "$state_file" >&2
    exit 2
  }
fi

fail() {
  printf 'prepare-rw-main-for-build: %s\n' "$1" >&2
  exit 1
}

state_helper="$control_root/dwyanewang/build-paseo-state.sh"
[[ -f "$state_helper" ]] || fail "missing build state helper: $state_helper"
source "$state_helper"

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
  git -C "$control_root" worktree list --porcelain | awk -v wanted="$branch_ref" '
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
  [[ -n "$worktree_path" ]] || fail "missing worktree for manifest branch: $branch_name"
  [[ -z "$(git -C "$worktree_path" status --porcelain)" ]] ||
    fail "worktree for $branch_name is dirty: $worktree_path"
}

[[ -f "$manifest_path" ]] || fail "missing manifest: $manifest_path"
[[ -d "$build_root_arg" ]] || fail "build root is not a directory: $build_root_arg"
build_root=$(realpath -e -- "$build_root_arg")
build_repo_root=$(git -C "$build_root" rev-parse --show-toplevel 2>/dev/null) ||
  fail "build root is not a Git worktree: $build_root"
build_repo_root=$(realpath -e -- "$build_repo_root")
[[ "$build_root" == "$build_repo_root" ]] ||
  fail "--build-root must name the worktree root: $build_repo_root"
[[ "$build_root" != "$control_root" ]] || fail "control and build worktrees must be distinct"
[[ "$(canonical_common_dir "$control_root")" == "$(canonical_common_dir "$build_root")" ]] ||
  fail "control and build worktrees do not belong to the same Git repository"

command -v flock >/dev/null || fail "flock is required"
mkdir -p -- "$build_root/.dev"
build_lock_file="$build_root/.dev/build-paseo-artifacts.lock"
exec {build_lock_fd}>"$build_lock_file"
flock -n "$build_lock_fd" ||
  fail "another build-paseo workflow already owns the build root: $build_root"
if [[ -n "$state_file" ]]; then
  mkdir -p -- "$(dirname -- "$state_file")"
  rm -f -- "$state_file"
fi

run_dir="$build_root/.dev/build-paseo-runs/$run_id"
[[ ! -L "$run_dir" ]] || fail "run directory is a symlink: $run_dir"
mkdir -p -- "$run_dir"
export PASEO_BUILD_REQUEST_STAGE_LOG="$run_dir/preflight-stages.log"
export PASEO_BUILD_ATTEMPT="$(date +%Y%m%d-%H%M%S)-$$"
attempt_log="$run_dir/preflight-$PASEO_BUILD_ATTEMPT.log"
exec > >(exec {build_lock_fd}>&-; tee -a "$attempt_log") \
  2> >(exec {build_lock_fd}>&-; tee -a "$attempt_log" >&2)
trap 'code=$?; paseo_build_stage "preflight:end exit=$code elapsed=$(( $(date +%s) - started_at ))s"; exit "$code"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
paseo_build_stage 'preflight:start'
printf 'PASEO_BUILD_RUN_ID=%s\nPASEO_BUILD_RUN_DIR=%s\n' "$run_id" "$run_dir"
if [[ -f "$run_dir/requested-at" ]]; then
  saved_requested_at=$(<"$run_dir/requested-at")
  [[ "$saved_requested_at" =~ ^[1-9][0-9]{0,9}$ ]] || fail 'invalid saved request time'
  [[ -z "$requested_at" || "$requested_at" == "$saved_requested_at" ]] || fail 'request time changed'
  requested_at=$saved_requested_at
else
  requested_at=${requested_at:-$started_at}
  ((requested_at <= started_at)) || fail 'request time is in the future'
  printf '%s\n' "$requested_at" >"$run_dir/requested-at"
fi
snapshot_file="$run_dir/main.snapshot"
frozen_main=
frozen_at=
if [[ -f "$snapshot_file" ]]; then
  read -r frozen_main frozen_at snapshot_extra <"$snapshot_file" || fail "unreadable main snapshot: $snapshot_file"
  [[ "$frozen_main" =~ ^[0-9a-f]{40}$ && "$frozen_at" =~ ^[1-9][0-9]{0,9}$ && -z "$snapshot_extra" ]] ||
    fail 'invalid main snapshot'
  ((no_fetch || refresh_main)) || fail 'run already has a snapshot; use --no-fetch or --refresh-main'
elif ((no_fetch)); then
  fail '--no-fetch requires an existing main snapshot'
fi

current_control_branch=$(git -C "$control_root" symbolic-ref --quiet --short HEAD) ||
  fail "control worktree is detached: $control_root"
[[ "$current_control_branch" == "$control_branch" ]] ||
  fail "control worktree must be on $control_branch (current: $current_control_branch)"
[[ -z "$(git -C "$control_root" status --porcelain)" ]] ||
  fail "control worktree is not clean: $control_root"
[[ -n "$(git -C "$build_root" symbolic-ref --quiet --short HEAD)" ]] ||
  fail "build worktree is detached: $build_root"
[[ -z "$(git -C "$build_root" status --porcelain)" ]] ||
  fail "build worktree is not clean: $build_root"

while IFS= read -r line || [[ -n "$line" ]]; do
  branch_name=${line%%#*}
  branch_name=${branch_name#"${branch_name%%[![:space:]]*}"}
  branch_name=${branch_name%"${branch_name##*[![:space:]]}"}
  [[ -n "$branch_name" ]] || continue
  require_clean_worktree "$branch_name"
done <"$manifest_path"

git -C "$control_root" remote get-url upstream >/dev/null || fail "missing upstream remote"
git -C "$control_root" remote get-url origin >/dev/null || fail "missing origin remote"

main_worktree=$(find_worktree_for_branch "$upstream_branch")
if [[ -n "$main_worktree" && -n "$(git -C "$main_worktree" status --porcelain)" ]]; then
  fail "worktree for $upstream_branch is dirty: $main_worktree"
fi

main_sync_started=$(date +%s)
main_before=$(git -C "$control_root" rev-parse "$upstream_branch")
if ((no_fetch)); then
  paseo_assert_frozen_main "$control_root" "$frozen_main" || fail 'frozen main validation failed'
  main_after=$frozen_main
  paseo_build_stage "main:reuse snapshot=$frozen_main frozen-at=$frozen_at"
else
  paseo_build_timed main:fetch-upstream git -C "$control_root" fetch upstream
  paseo_build_timed main:fetch-origin git -C "$control_root" fetch origin --prune

  if [[ -n "$main_worktree" ]]; then
    git -C "$main_worktree" merge --ff-only upstream/main
  else
    git -C "$control_root" merge-base --is-ancestor "$upstream_branch" upstream/main ||
      fail "$upstream_branch cannot be fast-forwarded to upstream/main"
    git -C "$control_root" branch -f "$upstream_branch" upstream/main
  fi

  main_after=$(git -C "$control_root" rev-parse "$upstream_branch")
  origin_main=$(git -C "$control_root" rev-parse --verify refs/remotes/origin/main 2>/dev/null || true)
  if [[ "$origin_main" == "$main_after" ]]; then
    printf '%s\n' 'origin/main already matches; remote unchanged.'
  else
    paseo_build_timed main:push git -C "$control_root" push origin main:main
    printf '%s\n' 'Updated origin/main.'
  fi
  frozen_main=$main_after
  frozen_at=$(date +%s)
  snapshot_temp=$(mktemp "$run_dir/.main.snapshot.XXXXXX")
  printf '%s %s\n' "$frozen_main" "$frozen_at" >"$snapshot_temp"
  mv -- "$snapshot_temp" "$snapshot_file"
  paseo_build_stage "main:freeze snapshot=$frozen_main frozen-at=$frozen_at"
fi
printf 'PASEO_MAIN_BEFORE=%s\nPASEO_MAIN_AFTER=%s\nPASEO_MAIN_SYNC_SECONDS=%s\n' \
  "$main_before" "$main_after" "$(( $(date +%s) - main_sync_started ))"

manifest_sync_started=$(date +%s)
sync_status=0
(cd "$control_root" && paseo_build_timed manifest:sync bash dwyanewang/sync-rw-main-branches.sh \
  --frozen-main "$frozen_main" --check-mergeability "${sync_args[@]}") ||
  sync_status=$?
printf 'PASEO_MANIFEST_SYNC_SECONDS=%s\n' "$(( $(date +%s) - manifest_sync_started ))"
if ((sync_status == 3)); then
  printf '%s\n' 'PASEO_PREFLIGHT_STATUS=review-required'
  exit 3
elif ((sync_status != 0)); then
  exit "$sync_status"
fi

if ! git -C "$control_root" diff --quiet -- "$manifest_path"; then
  printf '%s\n' 'PASEO_PREFLIGHT_STATUS=manifest-changed'
  printf '%s\n' 'Manifest changed; format, review, commit, and push it before rebuilding rw-main.'
  exit 4
fi

build_starting_branch=$(git -C "$build_root" branch --show-current)
rw_base_before=$(git -C "$build_root" rev-parse --verify "$base_branch" 2>/dev/null || true)
rw_main_before=$(git -C "$build_root" rev-parse --verify "$target_branch" 2>/dev/null || true)
rebuild_started=$(date +%s)
rebuild_args=(--build-root "$build_root" --frozen-main "$frozen_main")
if ((push_target)); then
  rebuild_args+=(--push)
fi
paseo_build_timed readiness bash "$control_root/dwyanewang/rebuild-rw-main.sh" "${rebuild_args[@]}"
rw_base_after=$(git -C "$build_root" rev-parse "$base_branch")
rw_main_after=$(git -C "$build_root" rev-parse "$target_branch")
if [[ "$rw_base_before" == "$rw_base_after" ]]; then
  rw_base_rebuilt=0
else
  rw_base_rebuilt=1
fi
if [[ "$rw_main_before" == "$rw_main_after" ]]; then
  rw_main_rebuilt=0
else
  rw_main_rebuilt=1
fi

dependencies_reinstalled=0
if [[ "$build_starting_branch" != "$target_branch" ]]; then
  dependencies_reinstalled=1
elif ((rw_main_rebuilt)) &&
  { ! git -C "$build_root" show-ref --verify --quiet "refs/heads/$target_backup_branch" ||
    ! git -C "$build_root" diff --quiet "$target_backup_branch..$target_branch" -- \
      package.json package-lock.json ':(glob)**/package.json' \
      ':(glob)patches/**' scripts/postinstall-patches.mjs; }; then
  dependencies_reinstalled=1
fi

rebuild_seconds=$(( $(date +%s) - rebuild_started ))
control_head=$(git -C "$control_root" rev-parse HEAD)
[[ "$(git -C "$control_root" rev-parse "$upstream_branch")" == "$main_after" ]] ||
  fail "$upstream_branch moved after synchronization; rerun preflight"
[[ "$(git -C "$control_root" rev-parse "$base_branch")" == "$rw_base_after" ]] ||
  fail "$base_branch moved after readiness checks; rerun preflight"
[[ "$(git -C "$build_root" rev-parse HEAD)" == "$rw_main_after" ]] ||
  fail "$target_branch moved after readiness checks; rerun preflight"
[[ -z "$(git -C "$control_root" status --porcelain)" ]] ||
  fail "control worktree changed before readiness state was written: $control_root"
[[ -z "$(git -C "$build_root" status --porcelain)" ]] ||
  fail "build worktree changed before readiness state was written: $build_root"
total_seconds=$(( $(date +%s) - started_at ))

printf 'PASEO_BUILD_STARTING_BRANCH=%s\n' "$build_starting_branch"
printf 'PASEO_CONTROL_HEAD=%s\n' "$control_head"
printf 'PASEO_RW_BASE_BEFORE=%s\n' "$rw_base_before"
printf 'PASEO_RW_BASE_AFTER=%s\n' "$rw_base_after"
printf 'PASEO_RW_BASE_REBUILT=%s\n' "$rw_base_rebuilt"
printf 'PASEO_RW_MAIN_BEFORE=%s\n' "$rw_main_before"
printf 'PASEO_RW_MAIN_AFTER=%s\n' "$rw_main_after"
printf 'PASEO_RW_MAIN_REBUILT=%s\n' "$rw_main_rebuilt"
printf 'PASEO_DEPENDENCIES_REINSTALLED=%s\n' "$dependencies_reinstalled"
printf 'PASEO_REBUILD_SECONDS=%s\n' "$rebuild_seconds"
printf 'PASEO_PREFLIGHT_TOTAL_SECONDS=%s\n' "$total_seconds"

if [[ -n "$state_file" ]]; then
  paseo_atomic_write_state_file "$state_file" \
    build_starting_branch "$build_starting_branch" \
    rw_base_before "$rw_base_before" \
    rw_base_after "$rw_base_after" \
    rw_base_rebuilt "$rw_base_rebuilt" \
    rw_main_before "$rw_main_before" \
    rw_main_after "$rw_main_after" \
    rw_main_rebuilt "$rw_main_rebuilt" \
    dependencies_reinstalled "$dependencies_reinstalled" \
    control_head "$control_head" \
    main_before "$main_before" \
    main_after "$main_after" \
    paseo_build_run_id "$run_id" \
    paseo_build_requested_at "$requested_at" \
    paseo_build_frozen_at "$frozen_at" \
    paseo_preflight_total_seconds "$total_seconds" \
    paseo_preflight_status ready
  printf 'PASEO_PREFLIGHT_STATE_FILE=%s\n' "$state_file"
fi
printf '%s\n' 'PASEO_PREFLIGHT_STATUS=ready'
