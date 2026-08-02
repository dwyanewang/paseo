#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash dwyanewang/sync-rw-main-branches.sh [options]

Remove manifest entries whose upstream PRs are already merged into main, and
optionally append or remove explicitly requested branches. When main or a
listed branch advances, the script prints per-branch semantic-review ranges
and exits 3 until that review is explicitly accepted.

  --add-pr NUMBER           Add an open getpaseo/paseo PR owned by dwyanewang.
  --add-branch BRANCH       Add a pushed origin branch as a persistent personal branch.
  --remove-branch BRANCH    Remove a branch confirmed to be absorbed upstream.
  --accept-main-review SHA  Confirm all pending branch reviews at current main.
  --dry-run                 Print the proposed manifest diff without changing it.
  --help                    Show this help.

Options may be repeated and are appended in the order provided.
EOF
}

dry_run=0
accept_main_review=
declare -a addition_kinds=()
declare -a addition_values=()
declare -a removal_branches=()
declare -A requested_removals=()

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
    --remove-branch)
      (($# >= 2)) || {
        printf '%s\n' 'Missing value for --remove-branch.' >&2
        exit 2
      }
      [[ -z "${requested_removals[$2]+present}" ]] || {
        printf 'Duplicate --remove-branch value: %s\n' "$2" >&2
        exit 2
      }
      requested_removals[$2]=1
      removal_branches+=("$2")
      shift 2
      ;;
    --accept-main-review)
      (($# >= 2)) || {
        printf '%s\n' 'Missing value for --accept-main-review.' >&2
        exit 2
      }
      [[ -z "$accept_main_review" ]] || {
        printf '%s\n' '--accept-main-review may only be specified once.' >&2
        exit 2
      }
      accept_main_review=$2
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

parsed_reviewed_main=
parsed_reviewed_head=
parse_review_metadata() {
  local branch_name=$1
  local line=$2
  local matched remainder

  if [[ "$line" =~ \#[[:space:]]*reviewed-main:([0-9a-f]{40})([[:space:]]|$) ]]; then
    parsed_reviewed_main=${BASH_REMATCH[1]}
    matched=${BASH_REMATCH[0]}
    remainder=${line#*"$matched"}
    [[ ! "$remainder" =~ \#[[:space:]]*reviewed-main: ]] ||
      fail "duplicate reviewed-main metadata for $branch_name"
  elif [[ "$line" == *"reviewed-main:"* ]]; then
    fail "malformed reviewed-main metadata for $branch_name"
  else
    fail "missing reviewed-main metadata for $branch_name"
  fi

  if [[ "$line" =~ \#[[:space:]]*reviewed-head:([0-9a-f]{40})([[:space:]]|$) ]]; then
    parsed_reviewed_head=${BASH_REMATCH[1]}
    matched=${BASH_REMATCH[0]}
    remainder=${line#*"$matched"}
    [[ ! "$remainder" =~ \#[[:space:]]*reviewed-head: ]] ||
      fail "duplicate reviewed-head metadata for $branch_name"
  elif [[ "$line" == *"reviewed-head:"* ]]; then
    fail "malformed reviewed-head metadata for $branch_name"
  else
    fail "missing reviewed-head metadata for $branch_name"
  fi
}

[[ -f "$manifest_path" ]] || fail "missing manifest: $manifest_path"
git show-ref --verify --quiet "refs/heads/$base_branch" || fail "missing local branch: $base_branch"
base_head=$(git rev-parse "$base_branch")

if [[ -n "$accept_main_review" ]]; then
  [[ "$accept_main_review" =~ ^[0-9a-f]{40}$ ]] ||
    fail "--accept-main-review must be a full lowercase commit SHA"
  [[ "$accept_main_review" == "$base_head" ]] ||
    fail "--accept-main-review must equal current $base_branch: $base_head"
fi

if ((${#removal_branches[@]} > 0)) && [[ -z "$accept_main_review" ]]; then
  fail "--remove-branch requires --accept-main-review $base_head"
fi

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
pr_title=
pr_url=
query_pr() {
  local requested_number=$1
  local row
  if ! row=$(
    gh pr view "$requested_number" \
      --repo "$upstream_repo" \
      --json number,state,headRefName,headRepositoryOwner,mergeCommit,title,url \
      --jq '[.number,.state,.headRefName,(.headRepositoryOwner.login // ""),(.mergeCommit.oid // ""),.title,.url] | join("\u001f")'
  ); then
    fail "could not query $upstream_repo PR #$requested_number"
  fi

  IFS=$'\x1f' read -r pr_number pr_state pr_head_branch pr_head_owner pr_merge_commit pr_title pr_url <<<"$row"
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
declare -A branch_pr_states=()
declare -A branch_pr_titles=()
declare -A branch_pr_urls=()
declare -A branch_reviewed_mains=()
declare -A branch_reviewed_heads=()
declare -A newly_added_branches=()
declare -A manifest_pr_branches=()
declare -A seen_manifest_prs=()
declare -A dropped_line_indexes=()
declare -A automatically_removed_branches=()

while IFS= read -r line || [[ -n "$line" ]]; do
  entry=${line%%#*}
  entry=$(trim "$entry")
  if [[ -z "$entry" ]]; then
    output_lines+=("$line")
    continue
  fi

  git check-ref-format --branch "$entry" >/dev/null || fail "invalid branch in manifest: $entry"
  [[ -z "${branch_indexes[$entry]+present}" ]] || fail "duplicate branch in manifest: $entry"
  parse_review_metadata "$entry" "$line"
  git cat-file -e "$parsed_reviewed_main^{commit}" 2>/dev/null ||
    fail "reviewed-main commit for $entry does not exist: $parsed_reviewed_main"
  git merge-base --is-ancestor "$parsed_reviewed_main" "$base_branch" ||
    fail "reviewed-main $parsed_reviewed_main for $entry is not an ancestor of $base_branch"
  branch_reviewed_mains[$entry]=$parsed_reviewed_main
  branch_reviewed_heads[$entry]=$parsed_reviewed_head

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
      automatically_removed_branches[$entry]=1
      continue
    fi
  fi

  branch_indexes[$entry]=${#output_lines[@]}
  branch_prs[$entry]=$entry_pr
  if [[ -n "$entry_pr" ]]; then
    manifest_pr_branches[$entry_pr]=$entry
    branch_pr_states[$entry]=$pr_state
    branch_pr_titles[$entry]=$pr_title
    branch_pr_urls[$entry]=$pr_url
  fi
  output_lines+=("$line")
done <"$manifest_path"

for branch_name in "${removal_branches[@]}"; do
  if [[ -n "${automatically_removed_branches[$branch_name]+present}" ]]; then
    printf 'Keeping automatic removal for %s: its upstream PR is merged.\n' "$branch_name"
    continue
  fi
  [[ -n "${branch_indexes[$branch_name]+present}" ]] ||
    fail "cannot remove branch not present in manifest: $branch_name"
  dropped_line_indexes[${branch_indexes[$branch_name]}]=1
  printf 'Removing %s: semantic review found the feature absorbed upstream.\n' "$branch_name"
done

for index in "${!addition_kinds[@]}"; do
  kind=${addition_kinds[$index]}
  value=${addition_values[$index]}

  if [[ "$kind" == "pr" ]]; then
    query_pr "$value"
    [[ "$pr_state" == "OPEN" ]] || fail "PR #$value is $pr_state; only open PRs can be added"
    [[ "$pr_head_owner" == "$expected_pr_owner" ]] ||
      fail "PR #$value is owned by $pr_head_owner, expected $expected_pr_owner"
    validate_source_branch "$pr_head_branch"
    [[ -z "${requested_removals[$pr_head_branch]+present}" ]] ||
      fail "$pr_head_branch cannot be added and removed in the same invocation"

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
      output_lines[$line_index]="$pr_head_branch # PR #$value # reviewed-main:${branch_reviewed_mains[$pr_head_branch]} # reviewed-head:${branch_reviewed_heads[$pr_head_branch]}"
      branch_prs[$pr_head_branch]=$value
      branch_pr_states[$pr_head_branch]=$pr_state
      branch_pr_titles[$pr_head_branch]=$pr_title
      branch_pr_urls[$pr_head_branch]=$pr_url
      manifest_pr_branches[$value]=$pr_head_branch
      printf 'Annotating %s with upstream PR #%s.\n' "$pr_head_branch" "$value"
      continue
    fi

    branch_indexes[$pr_head_branch]=${#output_lines[@]}
    branch_prs[$pr_head_branch]=$value
    branch_pr_states[$pr_head_branch]=$pr_state
    branch_pr_titles[$pr_head_branch]=$pr_title
    branch_pr_urls[$pr_head_branch]=$pr_url
    manifest_pr_branches[$value]=$pr_head_branch
    branch_reviewed_mains[$pr_head_branch]=$(git merge-base "$base_branch" "$pr_head_branch")
    branch_reviewed_heads[$pr_head_branch]=$(git rev-parse "$pr_head_branch")
    newly_added_branches[$pr_head_branch]=1
    output_lines+=("$pr_head_branch # PR #$value # reviewed-main:${branch_reviewed_mains[$pr_head_branch]} # reviewed-head:${branch_reviewed_heads[$pr_head_branch]}")
    printf 'Adding %s from upstream PR #%s.\n' "$pr_head_branch" "$value"
    continue
  fi

  validate_source_branch "$value"
  [[ -z "${requested_removals[$value]+present}" ]] ||
    fail "$value cannot be added and removed in the same invocation"
  if [[ -n "${branch_indexes[$value]+present}" ]]; then
    printf 'Keeping %s: branch is already listed.\n' "$value"
    continue
  fi
  branch_indexes[$value]=${#output_lines[@]}
  branch_prs[$value]=
  branch_reviewed_mains[$value]=$(git merge-base "$base_branch" "$value")
  branch_reviewed_heads[$value]=$(git rev-parse "$value")
  newly_added_branches[$value]=1
  output_lines+=("$value # Personal branch # reviewed-main:${branch_reviewed_mains[$value]} # reviewed-head:${branch_reviewed_heads[$value]}")
  printf 'Adding persistent personal branch %s.\n' "$value"
done

declare -a review_branches=()
declare -A current_branch_heads=()
for branch_name in "${!branch_indexes[@]}"; do
  line_index=${branch_indexes[$branch_name]}
  [[ -z "${dropped_line_indexes[$line_index]+present}" ]] || continue
  current_branch_heads[$branch_name]=$(git rev-parse "$branch_name")
  if [[ -n "${newly_added_branches[$branch_name]+present}" ]] ||
    [[ "${branch_reviewed_mains[$branch_name]}" != "$base_head" ]] ||
    [[ "${branch_reviewed_heads[$branch_name]}" != "${current_branch_heads[$branch_name]}" ]]; then
    review_branches+=("$branch_name")
  fi
done
if ((${#review_branches[@]} > 0)); then
  mapfile -t review_branches < <(printf '%s\n' "${review_branches[@]}" | sort)
fi

print_review_report() {
  local branch_name branch_base cherry_output current_head equivalent_count
  local feature_path reviewed_head reviewed_main unique_count upstream_start
  local -a feature_paths overlap_paths

  printf '\nSemantic review required before rebuilding rw-main.\n'
  for branch_name in "${review_branches[@]}"; do
    branch_base=$(git merge-base "$base_branch" "$branch_name")
    reviewed_main=${branch_reviewed_mains[$branch_name]}
    reviewed_head=${branch_reviewed_heads[$branch_name]}
    current_head=${current_branch_heads[$branch_name]}
    upstream_start=$reviewed_main
    if [[ -n "${newly_added_branches[$branch_name]+present}" ]]; then
      upstream_start=$branch_base
    fi

    printf '\n%s\n' "$branch_name"
    printf '  Main review:   %s..%s\n' "$upstream_start" "$base_head"
    printf '  Branch review: %s..%s\n' "$reviewed_head" "$current_head"
    if [[ -n "${branch_prs[$branch_name]:-}" ]]; then
      printf '  PR #%s [%s] %s\n  %s\n' \
        "${branch_prs[$branch_name]}" "${branch_pr_states[$branch_name]}" \
        "${branch_pr_titles[$branch_name]}" "${branch_pr_urls[$branch_name]}"
    fi

    printf '  Upstream commits to review:\n'
    if [[ "$upstream_start" == "$base_head" ]]; then
      printf '%s\n' '    (none; compare the branch feature directly with current main)'
    else
      git log --reverse --format='    %H %s' --name-only "$upstream_start..$base_branch"
    fi

    if [[ "$reviewed_head" != "$current_head" ]]; then
      printf '  Branch changes since its last reviewed head:\n'
      if git cat-file -e "$reviewed_head^{commit}" 2>/dev/null; then
        git log --left-right --format='    %m %H %s' "$reviewed_head...$current_head"
        git diff --stat "$reviewed_head..$current_head" | sed 's/^/    /'
      else
        printf '    Previous head is unavailable locally; inspect the full feature diff below.\n'
      fi
    fi

    cherry_output=$(git cherry "$base_branch" "$branch_name")
    unique_count=$(awk '$1 == "+" { count++ } END { print count + 0 }' <<<"$cherry_output")
    equivalent_count=$(awk '$1 == "-" { count++ } END { print count + 0 }' <<<"$cherry_output")
    mapfile -t overlap_paths < <(
      comm -12 \
        <(git diff --name-only "$upstream_start..$base_branch" | sort -u) \
        <(git diff --name-only "$branch_base..$branch_name" | sort -u)
    )
    mapfile -t feature_paths < <(git diff --name-only "$branch_base..$branch_name" | sort -u)

    printf '  Feature evidence: unique commits=%s, patch-equivalent commits=%s, overlapping paths=%s\n' \
      "$unique_count" "$equivalent_count" "${#overlap_paths[@]}"
    git log --reverse --format='    %h %s' "$base_branch..$branch_name"
    printf '  Feature paths:\n'
    for feature_path in "${feature_paths[@]}"; do
      printf '    %s\n' "$feature_path"
    done
    if ((${#overlap_paths[@]} > 0)); then
      printf '  Overlapping paths:\n'
      printf '    %s\n' "${overlap_paths[@]}"
    fi
  done

  printf '\nReview every per-branch main/head range above. Path and patch matches only prioritize inspection.\n'
  printf 'After review, rerun with --accept-main-review %s and any --remove-branch decisions.\n' \
    "$base_head"
}

if ((${#review_branches[@]} > 0)) && [[ -z "$accept_main_review" ]]; then
  print_review_report
  exit 3
fi

if [[ -n "$accept_main_review" ]]; then
  for branch_name in "${!branch_indexes[@]}"; do
    line_index=${branch_indexes[$branch_name]}
    [[ -z "${dropped_line_indexes[$line_index]+present}" ]] || continue
    line_without_review=${output_lines[$line_index]%%# reviewed-main:*}
    line_without_review=$(trim "$line_without_review")
    output_lines[$line_index]="$line_without_review # reviewed-main:$base_head # reviewed-head:${current_branch_heads[$branch_name]}"
  done
fi

proposed_manifest=$(mktemp)
cleanup() {
  rm -f -- "$proposed_manifest"
}
trap cleanup EXIT

for ((index = 0; index < ${#output_lines[@]}; index++)); do
  [[ -z "${dropped_line_indexes[$index]+present}" ]] || continue
  printf '%s\n' "${output_lines[$index]}"
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
