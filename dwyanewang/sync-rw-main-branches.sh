#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash dwyanewang/sync-rw-main-branches.sh [options]

Remove manifest entries whose upstream PRs are already merged into main, and
optionally append explicitly requested PR or personal branches.

  --add-pr NUMBER       Add an open getpaseo/paseo PR owned by dwyanewang.
  --add-branch BRANCH   Add a pushed origin branch as a persistent personal branch.
  --dry-run             Print the proposed manifest diff without changing it.
  --help                Show this help.

Options may be repeated and are appended in the order provided.
EOF
}

dry_run=0
declare -a addition_kinds=()
declare -a addition_values=()

while (($# > 0)); do
  case "$1" in
    --add-pr)
      (($# >= 2)) || {
        printf '%s\n' 'Missing value for --add-pr.' >&2
        exit 2
      }
      [[ "$2" =~ ^[1-9][0-9]*$ ]] || {
        printf 'Invalid PR number: %s\n' "$2" >&2
        exit 2
      }
      addition_kinds+=(pr)
      addition_values+=("$2")
      shift 2
      ;;
    --add-branch)
      (($# >= 2)) || {
        printf '%s\n' 'Missing value for --add-branch.' >&2
        exit 2
      }
      addition_kinds+=(branch)
      addition_values+=("$2")
      shift 2
      ;;
    --dry-run)
      dry_run=1
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

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(git -C "$script_dir/.." rev-parse --show-toplevel)
cd "$repo_root"

base_branch=main
packaging_branch=chore/build-paseo
target_branch=rw-main
manifest_path=dwyanewang/rw-main-branches.txt
upstream_repo=getpaseo/paseo
expected_pr_owner=dwyanewang

fail() {
  printf 'sync-rw-main-branches: %s\n' "$1" >&2
  exit 1
}

trim() {
  local value=$1
  value=${value#"${value%%[![:space:]]*}"}
  value=${value%"${value##*[![:space:]]}"}
  printf '%s' "$value"
}

[[ -f "$manifest_path" ]] || fail "missing manifest: $manifest_path"
git show-ref --verify --quiet "refs/heads/$base_branch" || fail "missing local branch: $base_branch"

current_branch=$(git symbolic-ref --quiet --short HEAD) || fail "detached HEAD is not supported"
if ((!dry_run)); then
  [[ -z "$(git status --porcelain)" ]] || fail "current worktree is not clean"
  [[ "$current_branch" == "$packaging_branch" ]] ||
    fail "apply mode must run on $packaging_branch (current: $current_branch)"
fi

command -v gh >/dev/null || fail "GitHub CLI (gh) is required"

pr_number=
pr_state=
pr_head_branch=
pr_head_owner=
pr_merge_commit=
query_pr() {
  local requested_number=$1
  local row
  if ! row=$(
    gh pr view "$requested_number" \
      --repo "$upstream_repo" \
      --json number,state,headRefName,headRepositoryOwner,mergeCommit \
      --jq '[.number,.state,.headRefName,(.headRepositoryOwner.login // ""),(.mergeCommit.oid // "")] | join("\u001f")'
  ); then
    fail "could not query $upstream_repo PR #$requested_number"
  fi

  IFS=$'\x1f' read -r pr_number pr_state pr_head_branch pr_head_owner pr_merge_commit <<<"$row"
  [[ "$pr_number" == "$requested_number" && -n "$pr_state" && -n "$pr_head_branch" ]] ||
    fail "invalid metadata returned for $upstream_repo PR #$requested_number"
}

validate_source_branch() {
  local branch_name=$1
  git check-ref-format --branch "$branch_name" >/dev/null || fail "invalid branch: $branch_name"
  [[ "$branch_name" != "$base_branch" && "$branch_name" != "$packaging_branch" &&
    "$branch_name" != "$target_branch" ]] || fail "reserved branch cannot be added: $branch_name"

  local local_ref="refs/heads/$branch_name"
  local remote_ref="refs/remotes/origin/$branch_name"
  git show-ref --verify --quiet "$local_ref" || fail "missing local branch: $branch_name"
  git show-ref --verify --quiet "$remote_ref" || fail "missing origin branch: $branch_name (run git fetch origin)"

  local local_head remote_head
  local_head=$(git rev-parse "$local_ref")
  remote_head=$(git rev-parse "$remote_ref")
  [[ "$local_head" == "$remote_head" ]] ||
    fail "$branch_name differs from origin/$branch_name; push or synchronize it first"
}

declare -a output_lines=()
declare -A branch_indexes=()
declare -A branch_prs=()
declare -A manifest_pr_branches=()
declare -A seen_manifest_prs=()

while IFS= read -r line || [[ -n "$line" ]]; do
  entry=${line%%#*}
  entry=$(trim "$entry")
  if [[ -z "$entry" ]]; then
    output_lines+=("$line")
    continue
  fi

  git check-ref-format --branch "$entry" >/dev/null || fail "invalid branch in manifest: $entry"
  [[ -z "${branch_indexes[$entry]+present}" ]] || fail "duplicate branch in manifest: $entry"

  entry_pr=
  if [[ "$line" =~ \#[[:space:]]*PR[[:space:]]*\#([1-9][0-9]*)([[:space:]]|$) ]]; then
    entry_pr=${BASH_REMATCH[1]}
    [[ -z "${seen_manifest_prs[$entry_pr]+present}" ]] ||
      fail "duplicate PR in manifest: #$entry_pr"
    seen_manifest_prs[$entry_pr]=1

    query_pr "$entry_pr"
    if [[ "$pr_state" == "MERGED" ]]; then
      [[ -n "$pr_merge_commit" ]] || fail "merged PR #$entry_pr has no merge commit"
      if ! git merge-base --is-ancestor "$pr_merge_commit" "$base_branch"; then
        fail "PR #$entry_pr is merged but $base_branch does not contain $pr_merge_commit; sync main first"
      fi
      printf 'Removing %s: upstream PR #%s is merged into %s.\n' "$entry" "$entry_pr" "$base_branch"
      continue
    fi
  fi

  branch_indexes[$entry]=${#output_lines[@]}
  branch_prs[$entry]=$entry_pr
  if [[ -n "$entry_pr" ]]; then
    manifest_pr_branches[$entry_pr]=$entry
  fi
  output_lines+=("$line")
done <"$manifest_path"

for index in "${!addition_kinds[@]}"; do
  kind=${addition_kinds[$index]}
  value=${addition_values[$index]}

  if [[ "$kind" == "pr" ]]; then
    query_pr "$value"
    [[ "$pr_state" == "OPEN" ]] || fail "PR #$value is $pr_state; only open PRs can be added"
    [[ "$pr_head_owner" == "$expected_pr_owner" ]] ||
      fail "PR #$value is owned by $pr_head_owner, expected $expected_pr_owner"
    validate_source_branch "$pr_head_branch"

    if [[ -n "${manifest_pr_branches[$value]+present}" ]]; then
      [[ "${manifest_pr_branches[$value]}" == "$pr_head_branch" ]] ||
        fail "PR #$value is already mapped to ${manifest_pr_branches[$value]}"
      printf 'Keeping %s: PR #%s is already listed.\n' "$pr_head_branch" "$value"
      continue
    fi

    if [[ -n "${branch_indexes[$pr_head_branch]+present}" ]]; then
      existing_pr=${branch_prs[$pr_head_branch]}
      [[ -z "$existing_pr" ]] ||
        fail "$pr_head_branch is already mapped to PR #$existing_pr"
      line_index=${branch_indexes[$pr_head_branch]}
      output_lines[$line_index]="$pr_head_branch # PR #$value"
      branch_prs[$pr_head_branch]=$value
      manifest_pr_branches[$value]=$pr_head_branch
      printf 'Annotating %s with upstream PR #%s.\n' "$pr_head_branch" "$value"
      continue
    fi

    branch_indexes[$pr_head_branch]=${#output_lines[@]}
    branch_prs[$pr_head_branch]=$value
    manifest_pr_branches[$value]=$pr_head_branch
    output_lines+=("$pr_head_branch # PR #$value")
    printf 'Adding %s from upstream PR #%s.\n' "$pr_head_branch" "$value"
    continue
  fi

  validate_source_branch "$value"
  if [[ -n "${branch_indexes[$value]+present}" ]]; then
    printf 'Keeping %s: branch is already listed.\n' "$value"
    continue
  fi
  branch_indexes[$value]=${#output_lines[@]}
  branch_prs[$value]=
  output_lines+=("$value # Personal branch")
  printf 'Adding persistent personal branch %s.\n' "$value"
done

proposed_manifest=$(mktemp)
cleanup() {
  rm -f -- "$proposed_manifest"
}
trap cleanup EXIT

for line in "${output_lines[@]}"; do
  printf '%s\n' "$line"
done >"$proposed_manifest"

if cmp --silent "$manifest_path" "$proposed_manifest"; then
  printf '%s\n' 'rw-main branch manifest is already up to date.'
  exit 0
fi

diff --unified --label "$manifest_path" --label "$manifest_path (proposed)" \
  "$manifest_path" "$proposed_manifest" || true

if ((dry_run)); then
  printf '%s\n' 'Dry run complete; manifest was not changed.'
  exit 0
fi

chmod --reference="$manifest_path" "$proposed_manifest"
mv -- "$proposed_manifest" "$manifest_path"
trap - EXIT
printf 'Updated %s. Review and commit it before rebuilding rw-main.\n' "$manifest_path"
