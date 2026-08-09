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
  --accept-review-request PATH
                            Accept one frozen review request after semantic review.
  --accept-main-review SHA  Confirm pending reviews at this exact main SHA.
  --accept-branch-head BRANCH SHA
                            Freeze one reviewed branch at this exact current head.
  --dry-run                 Print the proposed manifest diff without changing it.
  --help                    Show this help.

Options may be repeated and are appended in the order provided.
EOF
}

dry_run=0
accept_main_review=
accept_review_request=
declare -a addition_kinds=()
declare -a addition_values=()
declare -a removal_branches=()
declare -A requested_removals=()
declare -A expected_branch_heads=()

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
    --accept-branch-head)
      (($# >= 3)) || {
        printf '%s\n' 'Missing BRANCH or SHA for --accept-branch-head.' >&2
        exit 2
      }
      [[ -n "$2" ]] || {
        printf '%s\n' 'Empty BRANCH for --accept-branch-head.' >&2
        exit 2
      }
      [[ -z "${expected_branch_heads[$2]+present}" ]] || {
        printf 'Duplicate --accept-branch-head branch: %s\n' "$2" >&2
        exit 2
      }
      expected_branch_heads[$2]=$3
      shift 3
      ;;
    --accept-review-request)
      (($# >= 2)) || {
        printf '%s\n' 'Missing value for --accept-review-request.' >&2
        exit 2
      }
      [[ -z "$accept_review_request" ]] || {
        printf '%s\n' '--accept-review-request may only be specified once.' >&2
        exit 2
      }
      accept_review_request=$2
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
upstream_owner=${upstream_repo%%/*}
upstream_name=${upstream_repo#*/}

fail() {
  printf 'sync-rw-main-branches: %s\n' "$1" >&2
  exit 1
}

declare -A request_branch_main_starts=()
declare -A request_branch_head_starts=()
load_review_request() {
  local request_path=$1
  local request_name request_token actual_token
  local record field1 field2 field3 field4 field5 extra
  local version_seen=0 main_seen=0 branch_count=0

  [[ -f "$request_path" ]] || fail "review request is not a file: $request_path"
  request_path=$(realpath -e -- "$request_path")
  request_name=$(basename -- "$request_path")
  [[ "$request_name" =~ ^([0-9a-f]{40})\.tsv$ ]] ||
    fail "review request filename is not a content token: $request_name"
  request_token=${BASH_REMATCH[1]}
  actual_token=$(git hash-object -- "$request_path")
  [[ "$actual_token" == "$request_token" ]] ||
    fail "review request content does not match its token: $request_path"

  while IFS=$'\t' read -r record field1 field2 field3 field4 field5 extra ||
    [[ -n "$record$field1$field2$field3$field4$field5$extra" ]]; do
    case "$record" in
      paseo-rw-main-review-request)
        ((version_seen == 0)) || fail "duplicate review request version record"
        ((main_seen == 0 && branch_count == 0)) ||
          fail "review request version record must be first"
        [[ "$field1" == 1 && -z "$field2$field3$field4$field5$extra" ]] ||
          fail "unsupported review request version record"
        version_seen=1
        ;;
      main)
        ((main_seen == 0)) || fail "duplicate review request main record"
        ((version_seen == 1 && branch_count == 0)) ||
          fail "review request main record must follow its version"
        [[ "$field1" =~ ^[0-9a-f]{40}$ && -z "$field2$field3$field4$field5$extra" ]] ||
          fail "malformed review request main record"
        accept_main_review=$field1
        main_seen=1
        ;;
      branch)
        ((version_seen == 1 && main_seen == 1)) ||
          fail "review request branch record must follow its main"
        [[ -n "$field1" && "$field2" =~ ^[0-9a-f]{40}$ &&
          "$field3" =~ ^[0-9a-f]{40}$ && "$field4" =~ ^[0-9a-f]{40}$ &&
          "$field5" =~ ^[0-9a-f]{40}$ && -z "$extra" ]] ||
          fail "malformed review request branch record"
        git check-ref-format --branch "$field1" >/dev/null ||
          fail "invalid branch in review request: $field1"
        [[ -z "${expected_branch_heads[$field1]+present}" ]] ||
          fail "duplicate branch in review request: $field1"
        request_branch_main_starts[$field1]=$field2
        request_branch_head_starts[$field1]=$field4
        expected_branch_heads[$field1]=$field5
        [[ "$field3" == "$accept_main_review" ]] ||
          fail "review request branch main does not match its main record: $field1"
        ((branch_count += 1))
        ;;
      *)
        fail "unknown review request record: ${record:-<empty>}"
        ;;
    esac
  done <"$request_path"

  ((version_seen == 1)) || fail "review request is missing its version record"
  ((main_seen == 1)) || fail "review request is missing its main record"
  ((branch_count > 0)) || fail "review request contains no branch ranges"
  accept_review_request=$request_path
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

if [[ -n "$accept_review_request" ]]; then
  [[ -z "$accept_main_review" && ${#expected_branch_heads[@]} -eq 0 ]] ||
    fail "--accept-review-request cannot be combined with explicit review coordinates"
  load_review_request "$accept_review_request"
fi

if [[ -n "$accept_main_review" ]]; then
  [[ "$accept_main_review" =~ ^[0-9a-f]{40}$ ]] ||
    fail "--accept-main-review must be a full lowercase commit SHA"
  [[ "$accept_main_review" == "$base_head" ]] ||
    fail "--accept-main-review must equal current $base_branch: $base_head"
fi

if ((${#expected_branch_heads[@]} > 0)) && [[ -z "$accept_main_review" ]]; then
  fail "--accept-branch-head requires --accept-main-review"
fi
for branch_name in "${!expected_branch_heads[@]}"; do
  git check-ref-format --branch "$branch_name" >/dev/null ||
    fail "invalid --accept-branch-head branch: $branch_name"
  [[ "${expected_branch_heads[$branch_name]}" =~ ^[0-9a-f]{40}$ ]] ||
    fail "expected head for $branch_name must be a full lowercase commit SHA"
done

verify_accepted_ref_tips() {
  local branch_name current_head current_main
  [[ -n "$accept_main_review" ]] || return 0

  current_main=$(git rev-parse --verify "refs/heads/$base_branch" 2>/dev/null) ||
    fail "$base_branch disappeared during semantic review"
  [[ "$current_main" == "$accept_main_review" ]] ||
    fail "$base_branch moved during semantic review: expected $accept_main_review, current $current_main"
  for branch_name in "${!expected_branch_heads[@]}"; do
    current_head=$(git rev-parse --verify "refs/heads/$branch_name" 2>/dev/null) ||
      fail "$branch_name disappeared during semantic review"
    [[ "$current_head" == "${expected_branch_heads[$branch_name]}" ]] ||
      fail "$branch_name moved during semantic review: expected ${expected_branch_heads[$branch_name]}, current $current_head"
  done
}

verify_accepted_ref_tips

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
declare -A queried_pr_states=()
declare -A queried_pr_head_branches=()
declare -A queried_pr_head_owners=()
declare -A queried_pr_merge_commits=()
declare -A queried_pr_titles=()
declare -A queried_pr_urls=()
declare -A requested_pr_queries=()
declare -a requested_pr_numbers=()

request_pr_query() {
  local requested_number=$1
  if [[ -z "${requested_pr_queries[$requested_number]+present}" ]]; then
    requested_pr_queries[$requested_number]=1
    requested_pr_numbers+=("$requested_number")
  fi
}

while IFS= read -r manifest_line || [[ -n "$manifest_line" ]]; do
  if [[ "$manifest_line" =~ \#[[:space:]]*PR[[:space:]]*\#([1-9][0-9]*)([[:space:]]|$) ]]; then
    request_pr_query "${BASH_REMATCH[1]}"
  fi
done <"$manifest_path"

for index in "${!addition_kinds[@]}"; do
  if [[ "${addition_kinds[$index]}" == pr ]]; then
    request_pr_query "${addition_values[$index]}"
  fi
done

batch_query_prs() {
  ((${#requested_pr_numbers[@]} > 0)) || return 0

  local query='query BatchPaseoPullRequests($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {'
  local requested_number rows row_number row_state row_head_branch row_head_owner
  local row_merge_commit row_title row_url
  for requested_number in "${requested_pr_numbers[@]}"; do
    printf -v query '%s\npr_%s: pullRequest(number: %s) { number state headRefName headRepositoryOwner { login } mergeCommit { oid } title url }' \
      "$query" "$requested_number" "$requested_number"
  done
  query+=$'\n} }'

  if ! rows=$(
    gh api graphql \
      -f "query=$query" \
      -f "owner=$upstream_owner" \
      -f "name=$upstream_name" \
      --jq '.data.repository | to_entries[] | .value | select(. != null) | [.number,.state,.headRefName,(.headRepositoryOwner.login // ""),(.mergeCommit.oid // ""),.title,.url] | join("\u001f")'
  ); then
    fail "could not query $upstream_repo PRs: ${requested_pr_numbers[*]}"
  fi

  while IFS=$'\x1f' read -r row_number row_state row_head_branch row_head_owner \
    row_merge_commit row_title row_url; do
    [[ -n "$row_number" ]] || continue
    [[ "$row_number" =~ ^[1-9][0-9]*$ ]] || fail "invalid PR number returned by GitHub: $row_number"
    [[ -n "${requested_pr_queries[$row_number]+present}" ]] ||
      fail "GitHub returned unexpected PR #$row_number"
    [[ -z "${queried_pr_states[$row_number]+present}" ]] ||
      fail "GitHub returned duplicate metadata for PR #$row_number"
    [[ -n "$row_state" && -n "$row_head_branch" ]] ||
      fail "invalid metadata returned for $upstream_repo PR #$row_number"
    queried_pr_states[$row_number]=$row_state
    queried_pr_head_branches[$row_number]=$row_head_branch
    queried_pr_head_owners[$row_number]=$row_head_owner
    queried_pr_merge_commits[$row_number]=$row_merge_commit
    queried_pr_titles[$row_number]=$row_title
    queried_pr_urls[$row_number]=$row_url
  done <<<"$rows"

  for requested_number in "${requested_pr_numbers[@]}"; do
    [[ -n "${queried_pr_states[$requested_number]+present}" ]] ||
      fail "GitHub returned no metadata for $upstream_repo PR #$requested_number"
  done
}

load_pr() {
  local requested_number=$1
  [[ -n "${queried_pr_states[$requested_number]+present}" ]] ||
    fail "PR #$requested_number was not included in the batch query"

  pr_number=$requested_number
  pr_state=${queried_pr_states[$requested_number]}
  pr_head_branch=${queried_pr_head_branches[$requested_number]}
  pr_head_owner=${queried_pr_head_owners[$requested_number]}
  pr_merge_commit=${queried_pr_merge_commits[$requested_number]}
  pr_title=${queried_pr_titles[$requested_number]}
  pr_url=${queried_pr_urls[$requested_number]}
}

batch_query_prs

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

    load_pr "$entry_pr"
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
    load_pr "$value"
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
declare -a pending_review_branches=()
declare -A current_branch_heads=()
declare -A review_main_starts=()
for branch_name in "${!branch_indexes[@]}"; do
  line_index=${branch_indexes[$branch_name]}
  current_branch_heads[$branch_name]=$(git rev-parse "$branch_name")
  if [[ -n "${newly_added_branches[$branch_name]+present}" ]] ||
    [[ "${branch_reviewed_mains[$branch_name]}" != "$base_head" ]] ||
    [[ "${branch_reviewed_heads[$branch_name]}" != "${current_branch_heads[$branch_name]}" ]]; then
    branch_base=$(git merge-base "$base_branch" "$branch_name")
    review_main_starts[$branch_name]=${branch_reviewed_mains[$branch_name]}
    if [[ -n "${newly_added_branches[$branch_name]+present}" ]]; then
      review_main_starts[$branch_name]=$branch_base
    fi
    pending_review_branches+=("$branch_name")
    if [[ -z "${dropped_line_indexes[$line_index]+present}" ]]; then
      review_branches+=("$branch_name")
    fi
  fi
done
if ((${#pending_review_branches[@]} > 0)); then
  mapfile -t pending_review_branches < <(printf '%s\n' "${pending_review_branches[@]}" | sort)
fi
if ((${#review_branches[@]} > 0)); then
  mapfile -t review_branches < <(printf '%s\n' "${review_branches[@]}" | sort)
fi

if [[ -n "$accept_main_review" ]]; then
  declare -A required_expected_heads=()
  for branch_name in "${pending_review_branches[@]}" "${removal_branches[@]}"; do
    [[ -n "$branch_name" ]] || continue
    required_expected_heads[$branch_name]=1
  done
  for branch_name in "${!required_expected_heads[@]}"; do
    [[ -n "${expected_branch_heads[$branch_name]+present}" ]] ||
      fail "accepted review is missing the expected current head for $branch_name"
    [[ -n "${current_branch_heads[$branch_name]+present}" ]] ||
      fail "accepted review branch is no longer in the manifest: $branch_name"
    [[ "${current_branch_heads[$branch_name]}" == "${expected_branch_heads[$branch_name]}" ]] ||
      fail "$branch_name moved during semantic review: expected ${expected_branch_heads[$branch_name]}, current ${current_branch_heads[$branch_name]}"
  done
  for branch_name in "${!expected_branch_heads[@]}"; do
    [[ -n "${required_expected_heads[$branch_name]+present}" ]] ||
      fail "accepted review includes a branch that is no longer pending: $branch_name"
  done

  if [[ -n "$accept_review_request" ]]; then
    for branch_name in "${pending_review_branches[@]}"; do
      [[ "${request_branch_main_starts[$branch_name]:-}" == "${review_main_starts[$branch_name]}" ]] ||
        fail "main review range for $branch_name changed after the request was created"
      [[ "${request_branch_head_starts[$branch_name]:-}" == "${branch_reviewed_heads[$branch_name]}" ]] ||
        fail "branch review range for $branch_name changed after the request was created"
    done
  fi
fi

write_review_request() {
  local request_dir request_temp request_token request_path branch_name
  request_dir=$(git rev-parse --git-path paseo-review-requests)
  if [[ "$request_dir" != /* ]]; then
    request_dir="$repo_root/$request_dir"
  fi
  request_dir=$(realpath -m -- "$request_dir")
  mkdir -p -- "$request_dir"

  request_temp=$(mktemp "$request_dir/.request.XXXXXX")
  (
    trap 'rm -f -- "$request_temp"' EXIT
    {
      printf 'paseo-rw-main-review-request\t1\n'
      printf 'main\t%s\n' "$base_head"
      for branch_name in "${review_branches[@]}"; do
        printf 'branch\t%s\t%s\t%s\t%s\t%s\n' \
          "$branch_name" "${review_main_starts[$branch_name]}" "$base_head" \
          "${branch_reviewed_heads[$branch_name]}" "${current_branch_heads[$branch_name]}"
      done
    } >"$request_temp"
    request_token=$(git hash-object -- "$request_temp")
    request_path="$request_dir/$request_token.tsv"
    chmod 400 "$request_temp"
    if [[ -e "$request_path" ]]; then
      cmp --silent "$request_temp" "$request_path" ||
        fail "review request token collision: $request_path"
      rm -f -- "$request_temp"
    else
      mv -- "$request_temp" "$request_path"
    fi
    trap - EXIT
    printf '%s\n' "$request_path"
  )
}

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
    upstream_start=${review_main_starts[$branch_name]}

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
  printf 'After review, accept only the frozen request printed below, plus any --remove-branch decisions.\n'
}

if ((${#review_branches[@]} > 0)) && [[ -z "$accept_main_review" ]]; then
  review_request_path=$(write_review_request)
  print_review_report
  printf 'PASEO_REVIEW_REQUEST_FILE=%s\n' "$review_request_path"
  printf 'Accept the frozen coordinates with --accept-review-request %q.\n' "$review_request_path"
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

# Recheck immediately before any manifest result is accepted. This catches refs
# that moved while PR metadata and semantic ranges were being evaluated.
verify_accepted_ref_tips

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
# Keep the final ref check adjacent to the atomic manifest replacement. The
# earlier check protects comparison/reporting; this one closes that reporting
# window before accepted coordinates are persisted.
verify_accepted_ref_tips
mv -- "$proposed_manifest" "$manifest_path"
trap - EXIT
printf 'Updated %s. Review and commit it before rebuilding rw-main.\n' "$manifest_path"
