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
  --dry-run               Verify candidates without moving rw-base or rw-main.
  --push                  Atomically update origin/rw-base and origin/rw-main.
  --help                  Show this help.
EOF
}

dry_run=0
push_target=0
build_root_arg=
base_candidate_arg=
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

[[ -n "$build_root_arg" ]] || {
  printf '%s\n' '--build-root is required.' >&2
  usage >&2
  exit 2
}

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
control_root=$(git -C "$script_dir/.." rev-parse --show-toplevel)

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

git show-ref --verify --quiet "refs/heads/$upstream_branch" ||
  fail "missing local branch: $upstream_branch"
main_head=$(git rev-parse "$upstream_branch")
for mirror_ref in refs/remotes/upstream/main refs/remotes/origin/main; do
  if git show-ref --verify --quiet "$mirror_ref"; then
    mirror_head=$(git rev-parse "$mirror_ref")
    [[ "$mirror_head" == "$main_head" ]] ||
      fail "$upstream_branch differs from $mirror_ref; synchronize main first"
  fi
done

base_before=$(git rev-parse --verify "$base_branch" 2>/dev/null || true)
if [[ -z "$base_candidate_arg" && -z "$base_before" ]]; then
  fail "missing local $base_branch; promote the first persistent feature before rebuilding"
fi

declare -a integration_branches=()
declare -A seen_branches=()
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
  [[ "$entry_reviewed_main" == "$main_head" ]] ||
    fail "$entry has not been reviewed against $upstream_branch $main_head (manifest: $entry_reviewed_main)"
  [[ "$entry_reviewed_head" == "$branch_head" ]] ||
    fail "$entry head $branch_head has not completed semantic review (manifest: $entry_reviewed_head)"
  seen_branches[$entry]=1
  integration_branches+=("$entry")
done <"$manifest_path"

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
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if [[ -n "$base_candidate_arg" ]]; then
  git cat-file -e "$base_candidate_arg^{commit}" 2>/dev/null ||
    fail "base candidate is not a commit: $base_candidate_arg"
  base_candidate_head=$(git rev-parse "$base_candidate_arg")
  git merge-base --is-ancestor "$main_head" "$base_candidate_head" ||
    fail "base candidate does not contain current main $main_head"
else
  git switch --quiet --create "$base_candidate_branch" "$base_branch"
  created_base_candidate=1
  if ! git merge-base --is-ancestor "$main_head" HEAD; then
    if git merge-base --is-ancestor HEAD "$main_head"; then
      git merge --ff-only "$upstream_branch"
    else
      GIT_MERGE_AUTOEDIT=no git merge --no-ff --no-edit "$upstream_branch"
    fi
  fi
  base_candidate_head=$(git rev-parse HEAD)
fi

base_rebuilt=0
[[ "$base_before" == "$base_candidate_head" ]] || base_rebuilt=1

target_matches_inputs() {
  local current_commit branch_head merge_index
  local -a commit_and_parents
  git show-ref --verify --quiet "refs/heads/$target_branch" || return 1
  current_commit=$(git rev-parse "$target_branch")
  for ((merge_index = ${#integration_branches[@]} - 1; merge_index >= 0; merge_index--)); do
    read -r -a commit_and_parents < <(git rev-list --parents -n 1 "$current_commit")
    [[ ${#commit_and_parents[@]} -eq 3 ]] || return 1
    branch_head=$(git rev-parse "${integration_branches[$merge_index]}")
    [[ "${commit_and_parents[2]}" == "$branch_head" ]] || return 1
    current_commit=${commit_and_parents[1]}
  done
  [[ "$current_commit" == "$base_candidate_head" ]]
}

push_candidates() {
  local base_source=$1
  local target_source=$2
  local remote_base_expected= remote_target_expected=
  remote_base_expected=$(git rev-parse --verify "refs/remotes/origin/$base_branch" 2>/dev/null || true)
  remote_target_expected=$(git rev-parse --verify "refs/remotes/origin/$target_branch" 2>/dev/null || true)
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
  printf '%s\n' 'Installing dependencies for the selected product tree...'
  npm install
  [[ -z "$(git status --porcelain)" ]] ||
    fail "npm install left tracked or untracked changes in the build worktree"
}

printf 'Upstream: %s (%s)\n' "$upstream_branch" "$(git rev-parse --short "$main_head")"
printf 'Base candidate: %s\n' "$base_candidate_head"
for branch_name in "${integration_branches[@]}"; do
  read -r behind ahead < <(git rev-list --left-right --count "$main_head...$branch_name")
  printf 'Overlay: %s (%s; behind main %s, ahead %s)\n' \
    "$branch_name" "$(git rev-parse --short "$branch_name")" "$behind" "$ahead"
done

target_before=$(git rev-parse --verify "$target_branch" 2>/dev/null || true)
if ((!dry_run)) && ((base_rebuilt == 0)) && target_matches_inputs; then
  printf 'No-op: %s and %s already match every input.\n' "$base_branch" "$target_branch"
  if [[ "$(git symbolic-ref --quiet --short HEAD || true)" != "$target_branch" ]]; then
    git switch --quiet "$target_branch"
  fi
  if [[ "$starting_branch" != "$target_branch" ]]; then
    install_dependencies
  fi
  if ((push_target)); then
    push_candidates "$base_candidate_head" "$target_before"
    printf 'Updated origin/%s and origin/%s atomically.\n' "$base_branch" "$target_branch"
  fi
  completed=1
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

for branch_name in "${integration_branches[@]}"; do
  printf 'Merging overlay %s...\n' "$branch_name"
  GIT_MERGE_AUTOEDIT=no git merge --no-ff --no-edit "$branch_name"
done

if [[ "$starting_branch" != "$target_branch" ]] ||
  [[ -z "$target_before" ]] || dependency_inputs_changed "$target_before" HEAD; then
  install_dependencies
fi

printf '%s\n' 'Refreshing generated workspace declarations...'
npm run build --workspace=@getpaseo/relay
npm run build:client
npm run build:plugin

printf '%s\n' 'Running repository checks...'
npm run format:check
npm run typecheck
npm run lint
[[ -z "$(git status --porcelain)" ]] || fail "repository checks left tracked or untracked changes"

target_candidate_head=$(git rev-parse HEAD)
printf 'Final candidate: %s\n' "$target_candidate_head"

if ((dry_run)); then
  git switch --quiet "$starting_branch"
  completed=1
  printf '%s\n' 'Dry run passed; product refs were not changed.'
  exit 0
fi

if ((push_target)); then
  push_candidates "$base_candidate_head" "$target_candidate_head"
fi

if [[ -n "$base_before" ]]; then
  git branch -f "$base_backup_branch" "$base_before" >/dev/null
fi
if [[ -n "$target_before" ]]; then
  git branch -f "$target_backup_branch" "$target_before" >/dev/null
fi
git branch -f "$base_branch" "$base_candidate_head" >/dev/null
git branch -f "$target_branch" "$target_candidate_head" >/dev/null
git switch --quiet "$target_branch"
completed=1

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
