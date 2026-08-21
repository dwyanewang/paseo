#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash dwyanewang/manage-rw-base.sh --build-root PATH [--push] COMMAND [options]

Manage traceable local features on the persistent rw-base branch.

Commands:
  status
      Print active and retired feature state reconstructed from rw-base history.

  promote --feature ID --branch BRANCH [--feature ID --branch BRANCH ...]
      Merge one or more synchronized source branches into rw-base as new features.

  maintain --feature ID --branch BRANCH
      Merge a synchronized maintenance branch for one active feature.

  retire --feature ID --replacement REF
      Rebuild the desired base tree from current main and every other active
      feature, then record an append-only retirement commit.

  continue --operation REQUEST
      Continue an operation after resolving conflicts in its isolated worktree.

  abort --operation REQUEST
      Remove an unfinished operation and its isolated worktree.

Global options:
  --build-root PATH  Dedicated rw-main product worktree (required).
  --push             Atomically push rw-base and rw-main after validation.
  --help             Show this help.
EOF
}

build_root_arg=
push_target=0
command_name=
operation_arg=
replacement=
declare -a requested_features=()
declare -a requested_branches=()

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
    --feature)
      (($# >= 2)) || {
        printf '%s\n' 'Missing value for --feature.' >&2
        exit 2
      }
      requested_features+=("$2")
      shift 2
      ;;
    --branch)
      (($# >= 2)) || {
        printf '%s\n' 'Missing value for --branch.' >&2
        exit 2
      }
      requested_branches+=("$2")
      shift 2
      ;;
    --replacement)
      (($# >= 2)) || {
        printf '%s\n' 'Missing value for --replacement.' >&2
        exit 2
      }
      [[ -z "$replacement" ]] || {
        printf '%s\n' '--replacement may only be specified once.' >&2
        exit 2
      }
      replacement=$2
      shift 2
      ;;
    --operation)
      (($# >= 2)) || {
        printf '%s\n' 'Missing value for --operation.' >&2
        exit 2
      }
      [[ -z "$operation_arg" ]] || {
        printf '%s\n' '--operation may only be specified once.' >&2
        exit 2
      }
      operation_arg=$2
      shift 2
      ;;
    status | promote | maintain | retire | continue | abort)
      [[ -z "$command_name" ]] || {
        printf 'Multiple commands specified: %s and %s.\n' "$command_name" "$1" >&2
        exit 2
      }
      command_name=$1
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

[[ -n "$build_root_arg" && -n "$command_name" ]] || {
  usage >&2
  exit 2
}

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
control_root=$(git -C "$script_dir/.." rev-parse --show-toplevel)
build_root=$(realpath -e -- "$build_root_arg" 2>/dev/null) || {
  printf 'manage-rw-base: build root does not exist: %s\n' "$build_root_arg" >&2
  exit 1
}
upstream_branch=main
base_branch=rw-base
target_branch=rw-main
control_branch=chore/build-paseo

fail() {
  printf 'manage-rw-base: %s\n' "$1" >&2
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
  if [[ -n "$worktree_path" && -n "$(git -C "$worktree_path" status --porcelain)" ]]; then
    fail "worktree for $branch_name is dirty: $worktree_path"
  fi
}

[[ "$(git -C "$build_root" rev-parse --show-toplevel 2>/dev/null)" == "$build_root" ]] ||
  fail "--build-root must name a Git worktree root"
[[ "$(canonical_common_dir "$control_root")" == "$(canonical_common_dir "$build_root")" ]] ||
  fail "control and build worktrees do not belong to the same repository"
[[ "$(git -C "$control_root" branch --show-current)" == "$control_branch" ]] ||
  fail "control worktree must be on $control_branch"

declare -A feature_status=()
declare -A feature_source_branch=()
declare -A feature_source_head=()
declare -A feature_replacement=()
declare -A feature_integrations=()
declare -a feature_order=()
declare -a event_commits=()
declare -A event_features=()
declare -A event_actions=()

load_feature_state() {
  local commit feature action source_branch source_head replacement_value record_terminator
  feature_status=()
  feature_source_branch=()
  feature_source_head=()
  feature_replacement=()
  feature_integrations=()
  feature_order=()
  event_commits=()
  event_features=()
  event_actions=()
  git -C "$control_root" show-ref --verify --quiet "refs/heads/$base_branch" || return 0

  while IFS= read -r -d '' commit &&
    IFS= read -r -d '' feature &&
    IFS= read -r -d '' action &&
    IFS= read -r -d '' source_branch &&
    IFS= read -r -d '' source_head &&
    IFS= read -r -d '' replacement_value &&
    IFS= read -r -d '' record_terminator; do
    [[ -z "$record_terminator" ]] || fail "malformed rw-base history record for $commit"
    [[ -n "$feature" || -n "$action" ]] || continue
    [[ "$feature" =~ ^[a-z0-9][a-z0-9-]*$ ]] ||
      fail "invalid Paseo-Base-Feature trailer on $commit: $feature"
    [[ "$action" == promote || "$action" == maintain || "$action" == retire ]] ||
      fail "invalid Paseo-Base-Action trailer on $commit: $action"
    if [[ -z "${feature_status[$feature]+present}" ]]; then
      feature_order+=("$feature")
    fi
    event_commits+=("$commit")
    event_features[$commit]=$feature
    event_actions[$commit]=$action
    case "$action" in
      promote)
        [[ "${feature_status[$feature]:-retired}" != active ]] ||
          fail "feature $feature was promoted twice without retirement"
        [[ -n "$source_branch" && "$source_head" =~ ^[0-9a-f]{40}$ ]] ||
          fail "promotion $commit is missing valid source trailers"
        feature_status[$feature]=active
        feature_source_branch[$feature]=$source_branch
        feature_source_head[$feature]=$source_head
        feature_replacement[$feature]=
        feature_integrations[$feature]=$commit
        ;;
      maintain)
        [[ "${feature_status[$feature]:-}" == active ]] ||
          fail "maintenance $commit targets inactive feature $feature"
        [[ -n "$source_branch" && "$source_head" =~ ^[0-9a-f]{40}$ ]] ||
          fail "maintenance $commit is missing valid source trailers"
        feature_source_branch[$feature]=$source_branch
        feature_source_head[$feature]=$source_head
        feature_integrations[$feature]+=" $commit"
        ;;
      retire)
        [[ "${feature_status[$feature]:-}" == active ]] ||
          fail "retirement $commit targets inactive feature $feature"
        [[ -n "$replacement_value" ]] ||
          fail "retirement $commit is missing Paseo-Upstream-Replacement"
        feature_status[$feature]=retired
        feature_replacement[$feature]=$replacement_value
        feature_integrations[$feature]=
        ;;
    esac
  done < <(
    git -C "$control_root" log -z --first-parent --reverse --extended-regexp \
      --grep='^Paseo-Base-(Feature|Action):' \
      --format='%H%x00%(trailers:key=Paseo-Base-Feature,valueonly,separator=%x0A)%x00%(trailers:key=Paseo-Base-Action,valueonly,separator=%x0A)%x00%(trailers:key=Paseo-Source-Branch,valueonly,separator=%x0A)%x00%(trailers:key=Paseo-Source-Head,valueonly,separator=%x0A)%x00%(trailers:key=Paseo-Upstream-Replacement,valueonly,separator=%x0A)%x00' \
      "$base_branch"
  )
}

print_status() {
  load_feature_state
  if ((${#feature_order[@]} == 0)); then
    printf '%s\n' 'No tracked rw-base features.'
    return
  fi
  local feature integrations integration_count
  for feature in "${feature_order[@]}"; do
    integrations=${feature_integrations[$feature]:-}
    if [[ -n "$integrations" ]]; then
      read -r -a integration_array <<<"$integrations"
      integration_count=${#integration_array[@]}
    else
      integration_count=0
    fi
    printf '%s\t%s\tsource=%s@%s\tintegrations=%s' \
      "$feature" "${feature_status[$feature]}" \
      "${feature_source_branch[$feature]:--}" "${feature_source_head[$feature]:--}" \
      "$integration_count"
    if [[ "${feature_status[$feature]}" == retired ]]; then
      printf '\treplacement=%s' "${feature_replacement[$feature]}"
    fi
    printf '\n'
  done
}

if [[ "$command_name" == status ]]; then
  ((${#requested_features[@]} == 0 && ${#requested_branches[@]} == 0)) ||
    fail "status does not accept feature or branch options"
  print_status
  exit 0
fi

command -v flock >/dev/null || fail "flock is required"
mkdir -p -- "$build_root/.dev"
lock_file="$build_root/.dev/build-paseo-artifacts.lock"
exec {lock_fd}>"$lock_file"
flock -n "$lock_fd" || fail "another build-paseo workflow owns $build_root"

operation_parent="$(dirname -- "$build_root")/.paseo-rw-base-operations"
mkdir -p -- "$operation_parent"

write_progress() {
  local operation_dir=$1
  local phase=$2
  local index=$3
  local temp
  temp=$(mktemp "$operation_dir/progress.env.tmp.XXXXXX")
  {
    printf 'operation_phase=%q\n' "$phase"
    printf 'operation_index=%q\n' "$index"
  } >"$temp"
  chmod 600 "$temp"
  mv -- "$temp" "$operation_dir/progress.env"
}

load_request() {
  local request_path=$1
  local request_name request_token actual_token
  [[ -f "$request_path" ]] || fail "operation request is not a file: $request_path"
  request_path=$(realpath -e -- "$request_path")
  request_name=$(basename -- "$request_path")
  [[ "$request_name" =~ ^([0-9a-f]{40})\.env$ ]] ||
    fail "operation request filename is not a content token: $request_name"
  request_token=${BASH_REMATCH[1]}
  actual_token=$(git -C "$control_root" hash-object -- "$request_path")
  [[ "$actual_token" == "$request_token" ]] ||
    fail "operation request content does not match its token"
  operation_dir=$(dirname -- "$request_path")
  unset operation_action operation_base_before operation_main operation_control
  unset operation_replacement operation_branch_name operation_worktree
  unset operation_feature_count operation_replay_count
  unset operation_features operation_branches operation_heads operation_replay_commits
  # shellcheck disable=SC1090
  source "$request_path"
  [[ "${operation_version:-}" == 1 ]] || fail "unsupported operation request version"
  operation_request=$request_path
}

verify_frozen_request() {
  [[ "$(git -C "$control_root" rev-parse HEAD)" == "$operation_control" ]] ||
    fail "control HEAD moved since the operation was created"
  [[ "$(git -C "$control_root" rev-parse "$upstream_branch")" == "$operation_main" ]] ||
    fail "main moved since the operation was created"
  current_base=$(git -C "$control_root" rev-parse --verify "$base_branch" 2>/dev/null || true)
  [[ "$current_base" == "$operation_base_before" ]] ||
    fail "rw-base moved since the operation was created"
  local index
  for ((index = 0; index < ${#operation_branches[@]}; index++)); do
    current_source_head=$(git -C "$control_root" rev-parse "${operation_branches[$index]}")
    [[ "$current_source_head" == "${operation_heads[$index]}" ]] ||
      fail "source branch ${operation_branches[$index]} moved since the operation was created"
  done
}

cleanup_operation() {
  local request_path=$1
  load_request_with_meta "$request_path"
  if [[ -d "$operation_worktree" ]]; then
    git -C "$control_root" worktree remove --force "$operation_worktree"
  fi
  if git -C "$control_root" show-ref --verify --quiet "refs/heads/$operation_branch_name"; then
    git -C "$control_root" branch -D "$operation_branch_name" >/dev/null
  fi
  rm -f -- "$operation_dir"/merge-message-* "$operation_dir/progress.env"
  rm -f -- "$operation_request.meta" "$operation_request"
  rmdir -- "$operation_dir" 2>/dev/null || true
}

create_request() {
  local action=$1
  local temp token index
  temp=$(mktemp "$operation_parent/.request.XXXXXX")
  {
    printf '%s\n' 'operation_version=1'
    printf 'operation_action=%q\n' "$action"
    printf 'operation_base_before=%q\n' "$base_before"
    printf 'operation_main=%q\n' "$main_head"
    printf 'operation_control=%q\n' "$control_head"
    printf 'operation_replacement=%q\n' "$replacement"
    printf 'operation_feature_count=%q\n' "${#requested_features[@]}"
    printf 'operation_replay_count=%q\n' "${#replay_commits[@]}"
    printf 'operation_features=('
    for index in "${!requested_features[@]}"; do printf ' %q' "${requested_features[$index]}"; done
    printf ' )\noperation_branches=('
    for index in "${!requested_branches[@]}"; do printf ' %q' "${requested_branches[$index]}"; done
    printf ' )\noperation_heads=('
    for index in "${!source_heads[@]}"; do printf ' %q' "${source_heads[$index]}"; done
    printf ' )\noperation_replay_commits=('
    for index in "${!replay_commits[@]}"; do printf ' %q' "${replay_commits[$index]}"; done
    printf ' )\n'
  } >"$temp"
  token=$(git -C "$control_root" hash-object -- "$temp")
  operation_dir="$operation_parent/$token"
  [[ ! -e "$operation_dir" ]] || fail "operation token already exists: $token"
  mkdir -- "$operation_dir"
  operation_request="$operation_dir/$token.env"
  mv -- "$temp" "$operation_request"
  chmod 400 "$operation_request"
  operation_branch_name="rw-base-operation-$token"
  operation_worktree="$operation_dir/worktree"
  {
    printf 'operation_branch_name=%q\n' "$operation_branch_name"
    printf 'operation_worktree=%q\n' "$operation_worktree"
  } >>"$operation_request.meta"
  chmod 400 "$operation_request.meta"
  # Meta is outside the content-addressed request so paths do not affect its token.
  # shellcheck disable=SC1090
  source "$operation_request.meta"
  load_request_with_meta "$operation_request"
}

load_request_with_meta() {
  load_request "$1"
  [[ -f "$operation_request.meta" ]] || fail "operation metadata is missing"
  # shellcheck disable=SC1090
  source "$operation_request.meta"
}

if [[ "$command_name" == abort ]]; then
  [[ -n "$operation_arg" ]] || fail "abort requires --operation REQUEST"
  cleanup_operation "$operation_arg"
  printf '%s\n' 'Aborted rw-base operation.'
  exit 0
fi

operation_message() {
  local action=$1 feature=$2 branch=$3 source_head=$4
  local title
  if [[ "$action" == promote ]]; then
    title="chore(rw-base): promote $feature"
  else
    title="chore(rw-base): maintain $feature"
  fi
  printf '%s\n\n' "$title"
  printf 'Paseo-Base-Feature: %s\n' "$feature"
  printf 'Paseo-Base-Action: %s\n' "$action"
  printf 'Paseo-Source-Branch: %s\n' "$branch"
  printf 'Paseo-Source-Head: %s\n' "$source_head"
  printf 'Paseo-Main-Head: %s\n' "$operation_main"
}

finish_retirement_candidate() {
  local tree retirement_commit
  local -a commit_args
  tree=$(git -C "$operation_worktree" rev-parse HEAD^{tree})
  commit_args=(-p "$operation_base_before")
  if ! git -C "$control_root" merge-base --is-ancestor "$operation_main" "$operation_base_before"; then
    commit_args+=(-p "$operation_main")
  fi
  retirement_commit=$(
    {
      printf 'chore(rw-base): retire %s\n\n' "${operation_features[0]}"
      printf 'Paseo-Base-Feature: %s\n' "${operation_features[0]}"
      printf '%s\n' 'Paseo-Base-Action: retire'
      printf 'Paseo-Main-Head: %s\n' "$operation_main"
      printf 'Paseo-Upstream-Replacement: %s\n' "$operation_replacement"
    } | git -C "$operation_worktree" commit-tree "$tree" "${commit_args[@]}"
  )
  git -C "$operation_worktree" reset --hard "$retirement_commit" >/dev/null
  write_progress "$operation_dir" ready "$operation_replay_count"
}

replay_retained_features() {
  local start_index=$1 index commit
  for ((index = start_index; index < operation_replay_count; index++)); do
    commit=${operation_replay_commits[$index]}
    write_progress "$operation_dir" replay "$index"
    if ! git -C "$operation_worktree" cherry-pick -m 1 "$commit"; then
      printf 'PASEO_RW_BASE_OPERATION=%s\n' "$operation_request"
      printf 'Resolve the cherry-pick in %s, then run continue.\n' "$operation_worktree"
      exit 5
    fi
  done
  finish_retirement_candidate
}

merge_requested_features() {
  local start_index=$1 index message_file before_merge after_merge
  for ((index = start_index; index < operation_feature_count; index++)); do
    write_progress "$operation_dir" feature "$index"
    message_file="$operation_dir/merge-message-$index"
    operation_message "$operation_action" "${operation_features[$index]}" \
      "${operation_branches[$index]}" "${operation_heads[$index]}" >"$message_file"
    before_merge=$(git -C "$operation_worktree" rev-parse HEAD)
    if ! GIT_MERGE_AUTOEDIT=no git -C "$operation_worktree" merge --no-ff --no-edit \
      -F "$message_file" "${operation_heads[$index]}"; then
      printf 'PASEO_RW_BASE_OPERATION=%s\n' "$operation_request"
      printf 'Resolve the merge in %s, then run continue.\n' "$operation_worktree"
      exit 5
    fi
    after_merge=$(git -C "$operation_worktree" rev-parse HEAD)
    [[ "$after_merge" != "$before_merge" ]] ||
      fail "${operation_branches[$index]} adds no new change to rw-base"
  done
  write_progress "$operation_dir" ready "$operation_feature_count"
}

finalize_operation() {
  local rebuild_args=(--build-root "$build_root" --base-candidate "$operation_branch_name")
  if ((push_target)); then rebuild_args+=(--push); fi
  if ! bash "$control_root/dwyanewang/rebuild-rw-main.sh" "${rebuild_args[@]}"; then
    printf 'PASEO_RW_BASE_OPERATION=%s\n' "$operation_request"
    printf '%s\n' 'Candidate validation failed; fix the source or abort this operation.'
    exit 1
  fi
  cleanup_operation "$operation_request"
  printf '%s\n' 'rw-base lifecycle operation completed.'
}

if [[ "$command_name" == continue ]]; then
  [[ -n "$operation_arg" ]] || fail "continue requires --operation REQUEST"
  load_request_with_meta "$operation_arg"
  verify_frozen_request
  [[ -f "$operation_dir/progress.env" ]] || fail "operation progress is missing"
  # shellcheck disable=SC1090
  source "$operation_dir/progress.env"
  case "$operation_phase" in
    sync)
      [[ -z "$(git -C "$operation_worktree" diff --name-only --diff-filter=U)" ]] ||
        fail "the sync merge still has unresolved files"
      git -C "$operation_worktree" commit --no-edit
      if [[ "$operation_action" == retire ]]; then
        replay_retained_features 0
      else
        merge_requested_features 0
      fi
      ;;
    feature)
      [[ -z "$(git -C "$operation_worktree" diff --name-only --diff-filter=U)" ]] ||
        fail "the feature merge still has unresolved files"
      git -C "$operation_worktree" commit --no-edit
      merge_requested_features "$((operation_index + 1))"
      ;;
    replay)
      [[ -z "$(git -C "$operation_worktree" diff --name-only --diff-filter=U)" ]] ||
        fail "the retained-feature replay still has unresolved files"
      git -C "$operation_worktree" cherry-pick --continue
      replay_retained_features "$((operation_index + 1))"
      ;;
    ready) ;;
    *) fail "invalid operation phase: $operation_phase" ;;
  esac
  finalize_operation
  exit 0
fi

[[ -z "$operation_arg" ]] || fail "$command_name does not accept --operation"
[[ -z "$(git -C "$control_root" status --porcelain)" ]] ||
  fail "control worktree is not clean: $control_root"
[[ -z "$(git -C "$build_root" status --porcelain)" ]] ||
  fail "build worktree is not clean: $build_root"
require_clean_worktree "$target_branch"

main_head=$(git -C "$control_root" rev-parse "$upstream_branch")
for mirror_ref in refs/remotes/upstream/main refs/remotes/origin/main; do
  if git -C "$control_root" show-ref --verify --quiet "$mirror_ref"; then
    [[ "$(git -C "$control_root" rev-parse "$mirror_ref")" == "$main_head" ]] ||
      fail "main differs from $mirror_ref; run the normal preflight first"
  fi
done
base_before=$(git -C "$control_root" rev-parse --verify "$base_branch" 2>/dev/null || true)
control_head=$(git -C "$control_root" rev-parse HEAD)
load_feature_state

declare -a source_heads=()
declare -a replay_commits=()

case "$command_name" in
  promote | maintain)
    ((${#requested_features[@]} > 0)) || fail "$command_name requires --feature"
    ((${#requested_features[@]} == ${#requested_branches[@]})) ||
      fail "each --feature must have one matching --branch"
    [[ -z "$replacement" ]] || fail "$command_name does not accept --replacement"
    if [[ "$command_name" == maintain && ${#requested_features[@]} -ne 1 ]]; then
      fail "maintain accepts exactly one feature/branch pair"
    fi
    declare -A request_seen=()
    for index in "${!requested_features[@]}"; do
      feature=${requested_features[$index]}
      branch=${requested_branches[$index]}
      [[ "$feature" =~ ^[a-z0-9][a-z0-9-]*$ ]] || fail "invalid feature ID: $feature"
      [[ -z "${request_seen[$feature]+present}" ]] || fail "duplicate requested feature: $feature"
      request_seen[$feature]=1
      if [[ "$command_name" == promote ]]; then
        [[ "${feature_status[$feature]:-retired}" != active ]] ||
          fail "feature is already active: $feature"
      else
        [[ "${feature_status[$feature]:-}" == active ]] ||
          fail "feature is not active: $feature"
      fi
      git -C "$control_root" check-ref-format --branch "$branch" >/dev/null ||
        fail "invalid source branch: $branch"
      git -C "$control_root" show-ref --verify --quiet "refs/heads/$branch" ||
        fail "missing local source branch: $branch"
      git -C "$control_root" show-ref --verify --quiet "refs/remotes/origin/$branch" ||
        fail "missing origin source branch: $branch"
      source_head=$(git -C "$control_root" rev-parse "$branch")
      [[ "$source_head" == "$(git -C "$control_root" rev-parse "origin/$branch")" ]] ||
        fail "$branch differs from origin/$branch; synchronize it first"
      require_clean_worktree "$branch"
      source_heads+=("$source_head")
    done
    [[ -n "$base_before" || "$command_name" == promote ]] ||
      fail "cannot maintain a feature before rw-base exists"
    create_request "$command_name"
    start_ref=${base_before:-$main_head}
    git -C "$control_root" worktree add --quiet -b "$operation_branch_name" \
      "$operation_worktree" "$start_ref"
    if ! git -C "$control_root" merge-base --is-ancestor "$main_head" "$operation_branch_name"; then
      write_progress "$operation_dir" sync 0
      if ! GIT_MERGE_AUTOEDIT=no git -C "$operation_worktree" merge --no-ff --no-edit "$main_head"; then
        printf 'PASEO_RW_BASE_OPERATION=%s\n' "$operation_request"
        printf 'Resolve the main merge in %s, then run continue.\n' "$operation_worktree"
        exit 5
      fi
    fi
    merge_requested_features 0
    ;;
  retire)
    ((${#requested_features[@]} == 1 && ${#requested_branches[@]} == 0)) ||
      fail "retire requires exactly one --feature and no --branch"
    [[ -n "$replacement" ]] || fail "retire requires --replacement"
    feature=${requested_features[0]}
    [[ "${feature_status[$feature]:-}" == active ]] || fail "feature is not active: $feature"
    [[ -n "$base_before" ]] || fail "rw-base does not exist"
    declare -A selected_replays=()
    for active_feature in "${feature_order[@]}"; do
      [[ "$active_feature" != "$feature" ]] || continue
      [[ "${feature_status[$active_feature]}" == active ]] || continue
      read -r -a active_commits <<<"${feature_integrations[$active_feature]}"
      for commit in "${active_commits[@]}"; do selected_replays[$commit]=1; done
    done
    for commit in "${event_commits[@]}"; do
      [[ -n "${selected_replays[$commit]+present}" ]] && replay_commits+=("$commit")
    done
    create_request retire
    git -C "$control_root" worktree add --quiet -b "$operation_branch_name" \
      "$operation_worktree" "$main_head"
    replay_retained_features 0
    ;;
  *) fail "unsupported command: $command_name" ;;
esac

finalize_operation
