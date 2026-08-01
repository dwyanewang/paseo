#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash dwyanewang/rebuild-rw-main.sh [--dry-run] [--push]

Rebuild rw-main from main, chore/build-paseo, and the branches listed in
dwyanewang/rw-main-branches.txt. The target branch is moved only after every
merge and repository check succeeds. When the existing merge chain already
matches every input exactly, the default mode reuses it without rerunning the
repository checks.

  --dry-run  Build and verify a temporary candidate without moving rw-main.
  --push     Update origin/rw-main with an exact force-with-lease after checks.
EOF
}

dry_run=0
push_target=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      dry_run=1
      ;;
    --push)
      push_target=1
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ((dry_run && push_target)); then
  printf '%s\n' '--dry-run and --push cannot be used together.' >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(git -C "$script_dir/.." rev-parse --show-toplevel)
cd "$repo_root"

base_branch=main
packaging_branch=chore/build-paseo
target_branch=rw-main
backup_branch=rw-main-backup-latest
manifest_path=dwyanewang/rw-main-branches.txt
candidate_branch="rw-main-rebuild-$(date +%Y%m%d-%H%M%S)-$$"

fail() {
  printf 'rebuild-rw-main: %s\n' "$1" >&2
  exit 1
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

[[ -f "$manifest_path" ]] || fail "missing manifest: $manifest_path"
[[ -z "$(git status --porcelain)" ]] || fail "current worktree is not clean"

starting_branch=$(git symbolic-ref --quiet --short HEAD) || fail "detached HEAD is not supported"

for branch_name in "$base_branch" "$packaging_branch"; do
  git show-ref --verify --quiet "refs/heads/$branch_name" || fail "missing local branch: $branch_name"
done

base_head=$(git rev-parse "$base_branch")
for mirror_ref in refs/remotes/upstream/main refs/remotes/origin/main; do
  if git show-ref --verify --quiet "$mirror_ref"; then
    mirror_head=$(git rev-parse "$mirror_ref")
    [[ "$mirror_head" == "$base_head" ]] || fail "$base_branch differs from $mirror_ref; sync main first"
  fi
done

declare -a integration_branches=()
declare -A seen_branches=()
while IFS= read -r line || [[ -n "$line" ]]; do
  entry=${line%%#*}
  entry=${entry#"${entry%%[![:space:]]*}"}
  entry=${entry%"${entry##*[![:space:]]}"}
  [[ -n "$entry" ]] || continue
  git check-ref-format --branch "$entry" >/dev/null || fail "invalid branch in manifest: $entry"
  [[ -z "${seen_branches[$entry]:-}" ]] || fail "duplicate branch in manifest: $entry"
  [[ "$entry" != "$base_branch" && "$entry" != "$packaging_branch" ]] ||
    fail "manifest must not include the base or packaging branch: $entry"
  git show-ref --verify --quiet "refs/heads/$entry" || fail "missing local branch from manifest: $entry"
  seen_branches[$entry]=1
  integration_branches+=("$entry")
done < "$manifest_path"

target_worktree=$(find_worktree_for_branch "$target_branch")
if [[ -n "$target_worktree" && "$target_worktree" != "$repo_root" ]]; then
  fail "$target_branch is checked out in another worktree: $target_worktree"
fi

backup_worktree=$(find_worktree_for_branch "$backup_branch")
[[ -z "$backup_worktree" ]] || fail "$backup_branch is checked out in a worktree: $backup_worktree"

require_clean_worktree "$packaging_branch"
for branch_name in "${integration_branches[@]}"; do
  require_clean_worktree "$branch_name"
done

merge_branches=("$packaging_branch" "${integration_branches[@]}")

target_matches_inputs() {
  local current_commit branch_head
  local merge_index
  local -a commit_and_parents

  git show-ref --verify --quiet "refs/heads/$target_branch" || return 1
  current_commit=$(git rev-parse "$target_branch")

  for ((merge_index = ${#merge_branches[@]} - 1; merge_index >= 0; merge_index--)); do
    read -r -a commit_and_parents < <(git rev-list --parents -n 1 "$current_commit")
    [[ ${#commit_and_parents[@]} -eq 3 ]] || return 1
    branch_head=$(git rev-parse "${merge_branches[$merge_index]}")
    [[ "${commit_and_parents[2]}" == "$branch_head" ]] || return 1
    current_commit=${commit_and_parents[1]}
  done

  [[ "$current_commit" == "$base_head" ]]
}

push_target_ref() {
  local source_ref=$1
  local remote_expected=
  if git show-ref --verify --quiet "refs/remotes/origin/$target_branch"; then
    remote_expected=$(git rev-parse "refs/remotes/origin/$target_branch")
  fi
  git push \
    "--force-with-lease=refs/heads/$target_branch:$remote_expected" \
    origin \
    "$source_ref:refs/heads/$target_branch"
}

printf 'Base: %s (%s)\n' "$base_branch" "$(git rev-parse --short "$base_branch")"
printf 'Packaging: %s (%s)\n' "$packaging_branch" "$(git rev-parse --short "$packaging_branch")"
for branch_name in "${integration_branches[@]}"; do
  read -r behind ahead < <(git rev-list --left-right --count "$base_branch...$branch_name")
  printf 'Integration: %s (%s; behind %s, ahead %s)\n' \
    "$branch_name" "$(git rev-parse --short "$branch_name")" "$behind" "$ahead"
done

if ((!dry_run)) && target_matches_inputs; then
  target_head=$(git rev-parse "$target_branch")
  printf 'No-op: %s already matches every input (%s).\n' \
    "$target_branch" "$(git rev-parse --short "$target_branch")"
  if ((push_target)); then
    remote_head=$(git rev-parse --verify "refs/remotes/origin/$target_branch" 2>/dev/null || true)
    if [[ "$remote_head" == "$target_head" ]]; then
      printf '%s\n' 'origin/rw-main already matches; remote unchanged.'
    else
      push_target_ref "$target_branch"
      printf '%s\n' 'Updated origin/rw-main with force-with-lease.'
    fi
  fi
  git switch --quiet "$target_branch"
  exit 0
fi

candidate_created=0
completed=0
cleanup() {
  local exit_code=$?
  trap - EXIT
  if ((candidate_created && !completed)); then
    if git rev-parse --quiet --verify MERGE_HEAD >/dev/null; then
      git merge --abort || true
    fi
    current_branch=$(git symbolic-ref --quiet --short HEAD || true)
    if [[ "$current_branch" == "$candidate_branch" ]]; then
      git switch --quiet "$starting_branch" || true
    fi
    if git show-ref --verify --quiet "refs/heads/$candidate_branch"; then
      git branch -D "$candidate_branch" >/dev/null || true
    fi
  fi
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

git switch --quiet --create "$candidate_branch" "$base_branch"
candidate_created=1

merge_branch() {
  local branch_name=$1
  printf 'Merging %s...\n' "$branch_name"
  GIT_MERGE_AUTOEDIT=no git merge --no-ff --no-edit "$branch_name"
}

merge_branch "$packaging_branch"
for branch_name in "${integration_branches[@]}"; do
  merge_branch "$branch_name"
done

printf '%s\n' 'Refreshing generated workspace declarations...'
npm run build --workspace=@getpaseo/relay
npm run build:client

printf '%s\n' 'Running repository checks...'
npm run format:check
npm run typecheck
npm run lint
[[ -z "$(git status --porcelain)" ]] || fail "repository checks left tracked or untracked changes"

candidate_head=$(git rev-parse HEAD)
printf 'Candidate: %s\n' "$candidate_head"

if ((dry_run)); then
  git switch --quiet "$starting_branch"
  git branch -D "$candidate_branch" >/dev/null
  completed=1
  printf '%s\n' 'Dry run passed; rw-main was not changed.'
  exit 0
fi

if git show-ref --verify --quiet "refs/heads/$target_branch"; then
  git branch -f "$backup_branch" "$target_branch" >/dev/null
  printf 'Backup: %s -> %s\n' "$backup_branch" "$(git rev-parse --short "$backup_branch")"
fi

if ((push_target)); then
  push_target_ref "$candidate_branch"
fi

git branch -f "$target_branch" "$candidate_head" >/dev/null
git switch --quiet "$target_branch"
git branch -D "$candidate_branch" >/dev/null
completed=1

printf 'Updated %s -> %s\n' "$target_branch" "$(git rev-parse --short "$target_branch")"
if ((push_target)); then
  printf '%s\n' 'Updated origin/rw-main with force-with-lease.'
else
  printf '%s\n' 'Remote unchanged; rerun with --push after review if needed.'
fi
