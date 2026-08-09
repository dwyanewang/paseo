#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash dwyanewang/prepare-rw-main-for-build.sh --build-root PATH [options]

Run the source-control preflight for build-paseo as one deterministic command:
validate worktrees, synchronize main, maintain the rw-main manifest, and run the
atomic rw-main readiness gate.

  --build-root PATH         Dedicated product build worktree (required).
  --push                    Update origin/rw-main after the readiness gate.
  --state-file PATH         Atomically write sourceable readiness results on success.
  --add-pr NUMBER           Forward an explicit PR addition to manifest sync.
  --add-branch BRANCH       Forward an explicit personal branch addition.
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
    --add-pr | --add-branch | --remove-branch | --accept-main-review | --accept-review-request)
      (($# >= 2)) || {
        printf 'Missing value for %s.\n' "$1" >&2
        exit 2
      }
      sync_args+=("$1" "$2")
      shift 2
      ;;
    --accept-branch-head)
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

[[ -n "$build_root_arg" ]] || {
  printf '%s\n' '--build-root is required.' >&2
  usage >&2
  exit 2
}

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
control_root=$(git -C "$script_dir/.." rev-parse --show-toplevel)
manifest_path="$control_root/dwyanewang/rw-main-branches.txt"
base_branch=main
control_branch=chore/build-paseo
target_branch=rw-main
backup_branch=rw-main-backup-latest
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

main_worktree=$(find_worktree_for_branch "$base_branch")
if [[ -n "$main_worktree" && -n "$(git -C "$main_worktree" status --porcelain)" ]]; then
  fail "worktree for $base_branch is dirty: $main_worktree"
fi

main_sync_started=$(date +%s)
main_before=$(git -C "$control_root" rev-parse "$base_branch")
git -C "$control_root" fetch upstream
git -C "$control_root" fetch origin --prune

if [[ -n "$main_worktree" ]]; then
  git -C "$main_worktree" merge --ff-only upstream/main
else
  git -C "$control_root" merge-base --is-ancestor "$base_branch" upstream/main ||
    fail "$base_branch cannot be fast-forwarded to upstream/main"
  git -C "$control_root" branch -f "$base_branch" upstream/main
fi

main_after=$(git -C "$control_root" rev-parse "$base_branch")
origin_main=$(git -C "$control_root" rev-parse --verify refs/remotes/origin/main 2>/dev/null || true)
if [[ "$origin_main" == "$main_after" ]]; then
  printf '%s\n' 'origin/main already matches; remote unchanged.'
else
  git -C "$control_root" push origin main:main
  printf '%s\n' 'Updated origin/main.'
fi
printf 'PASEO_MAIN_BEFORE=%s\nPASEO_MAIN_AFTER=%s\nPASEO_MAIN_SYNC_SECONDS=%s\n' \
  "$main_before" "$main_after" "$(( $(date +%s) - main_sync_started ))"

manifest_sync_started=$(date +%s)
sync_status=0
(cd "$control_root" && bash dwyanewang/sync-rw-main-branches.sh "${sync_args[@]}") ||
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
rw_main_before=$(git -C "$build_root" rev-parse --verify "$target_branch" 2>/dev/null || true)
rebuild_started=$(date +%s)
rebuild_args=(--build-root "$build_root")
if ((push_target)); then
  rebuild_args+=(--push)
fi
bash "$control_root/dwyanewang/rebuild-rw-main.sh" "${rebuild_args[@]}"
rw_main_after=$(git -C "$build_root" rev-parse "$target_branch")
if [[ "$rw_main_before" == "$rw_main_after" ]]; then
  rw_main_rebuilt=0
else
  rw_main_rebuilt=1
fi

dependencies_reinstalled=0
if [[ "$build_starting_branch" != "$target_branch" ]]; then
  dependencies_reinstalled=1
elif ((rw_main_rebuilt)) &&
  { ! git -C "$build_root" show-ref --verify --quiet "refs/heads/$backup_branch" ||
    ! git -C "$build_root" diff --quiet "$backup_branch..$target_branch" -- \
      package.json package-lock.json ':(glob)**/package.json' \
      ':(glob)patches/**' scripts/postinstall-patches.mjs; }; then
  dependencies_reinstalled=1
fi

rebuild_seconds=$(( $(date +%s) - rebuild_started ))
control_head=$(git -C "$control_root" rev-parse HEAD)
[[ "$(git -C "$control_root" rev-parse "$base_branch")" == "$main_after" ]] ||
  fail "$base_branch moved after synchronization; rerun preflight"
[[ "$(git -C "$build_root" rev-parse HEAD)" == "$rw_main_after" ]] ||
  fail "$target_branch moved after readiness checks; rerun preflight"
[[ -z "$(git -C "$control_root" status --porcelain)" ]] ||
  fail "control worktree changed before readiness state was written: $control_root"
[[ -z "$(git -C "$build_root" status --porcelain)" ]] ||
  fail "build worktree changed before readiness state was written: $build_root"
total_seconds=$(( $(date +%s) - started_at ))

printf 'PASEO_BUILD_STARTING_BRANCH=%s\n' "$build_starting_branch"
printf 'PASEO_CONTROL_HEAD=%s\n' "$control_head"
printf 'PASEO_RW_MAIN_BEFORE=%s\n' "$rw_main_before"
printf 'PASEO_RW_MAIN_AFTER=%s\n' "$rw_main_after"
printf 'PASEO_RW_MAIN_REBUILT=%s\n' "$rw_main_rebuilt"
printf 'PASEO_DEPENDENCIES_REINSTALLED=%s\n' "$dependencies_reinstalled"
printf 'PASEO_REBUILD_SECONDS=%s\n' "$rebuild_seconds"
printf 'PASEO_PREFLIGHT_TOTAL_SECONDS=%s\n' "$total_seconds"

if [[ -n "$state_file" ]]; then
  state_file_temp=$(mktemp "${state_file}.tmp.XXXXXX")
  {
    printf 'build_starting_branch=%q\n' "$build_starting_branch"
    printf 'rw_main_before=%q\n' "$rw_main_before"
    printf 'rw_main_after=%q\n' "$rw_main_after"
    printf 'rw_main_rebuilt=%q\n' "$rw_main_rebuilt"
    printf 'dependencies_reinstalled=%q\n' "$dependencies_reinstalled"
    printf 'control_head=%q\n' "$control_head"
    printf 'main_before=%q\n' "$main_before"
    printf 'main_after=%q\n' "$main_after"
    printf 'paseo_preflight_total_seconds=%q\n' "$total_seconds"
    printf 'paseo_preflight_status=%q\n' ready
  } >"$state_file_temp"
  chmod 600 "$state_file_temp"
  mv -- "$state_file_temp" "$state_file"
  printf 'PASEO_PREFLIGHT_STATE_FILE=%s\n' "$state_file"
fi
printf '%s\n' 'PASEO_PREFLIGHT_STATUS=ready'
