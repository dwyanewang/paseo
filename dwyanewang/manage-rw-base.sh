#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash dwyanewang/manage-rw-base.sh --build-root PATH [--push] [--state-file PATH] COMMAND [options]

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
  --state-file PATH  Atomically write a prepare-compatible ready state on success.
  --help             Show this help.
EOF
}

build_root_arg=
push_target=0
state_file_arg=
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
started_at=$(date +%s)

fail() {
  printf 'manage-rw-base: %s\n' "$1" >&2
  exit 1
}

build_state_helper=${PASEO_BUILD_STATE_HELPER:-"$control_root/dwyanewang/build-paseo-state.sh"}
[[ -f "$build_state_helper" ]] || fail "missing build state helper: $build_state_helper"
# shellcheck disable=SC1090
source "$build_state_helper"

state_file=
if [[ -n "$state_file_arg" ]]; then
  state_file=$(realpath -m -- "$state_file_arg")
  [[ ! -d "$state_file" ]] || fail "state file path is a directory: $state_file"
fi

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

refresh_remote_refs() {
  git -C "$control_root" remote get-url upstream >/dev/null || fail "missing upstream remote"
  git -C "$control_root" remote get-url origin >/dev/null || fail "missing origin remote"
  git -C "$control_root" fetch upstream
  git -C "$control_root" fetch origin --prune
}

sync_main_with_upstream() {
  local main_worktree main_before main_after origin_main
  main_worktree=$(find_worktree_for_branch "$upstream_branch")
  if [[ -n "$main_worktree" && -n "$(git -C "$main_worktree" status --porcelain)" ]]; then
    fail "worktree for $upstream_branch is dirty: $main_worktree"
  fi

  main_before=$(git -C "$control_root" rev-parse "$upstream_branch")
  refresh_remote_refs
  if [[ -n "$main_worktree" ]]; then
    git -C "$main_worktree" merge --ff-only upstream/main
  else
    git -C "$control_root" merge-base --is-ancestor "$upstream_branch" upstream/main ||
      fail "$upstream_branch cannot be fast-forwarded to upstream/main"
    git -C "$control_root" branch -f "$upstream_branch" upstream/main
  fi

  main_after=$(git -C "$control_root" rev-parse "$upstream_branch")
  origin_main=$(
    git -C "$control_root" rev-parse --verify refs/remotes/origin/main 2>/dev/null || true
  )
  if [[ "$origin_main" == "$main_after" ]]; then
    printf '%s\n' 'origin/main already matches; remote unchanged.'
  else
    git -C "$control_root" push origin main:main
    printf '%s\n' 'Updated origin/main.'
  fi
  printf 'PASEO_MAIN_BEFORE=%s\nPASEO_MAIN_AFTER=%s\n' "$main_before" "$main_after"
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
declare -a unmanaged_commits=()
declare -a unmanaged_subjects=()

load_unmanaged_commits() {
  local commit subject parents record_terminator main_parent
  local -a commit_parents
  local -A main_first_parent_commits=()
  unmanaged_commits=()
  unmanaged_subjects=()
  git -C "$control_root" show-ref --verify --quiet "refs/heads/$base_branch" || return 0
  while IFS= read -r commit; do
    main_first_parent_commits["$commit"]=1
  done < <(git -C "$control_root" rev-list --first-parent "$upstream_branch")

  while IFS= read -r -d '' commit &&
    IFS= read -r -d '' subject &&
    IFS= read -r -d '' parents &&
    IFS= read -r -d '' record_terminator; do
    [[ -z "$record_terminator" ]] || fail "malformed rw-base audit record for $commit"
    [[ -z "${event_actions[$commit]+present}" ]] || continue
    read -r -a commit_parents <<<"$parents"
    main_parent=${commit_parents[1]:-}
    if ((${#commit_parents[@]} == 2)) &&
      [[ -n "${main_first_parent_commits[$main_parent]+present}" ]]; then
      continue
    fi
    unmanaged_commits+=("$commit")
    unmanaged_subjects+=("$subject")
  done < <(
    git -C "$control_root" log -z --first-parent \
      --format='%H%x00%s%x00%P%x00' "$upstream_branch..$base_branch"
  )
}

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
  load_unmanaged_commits
}

print_status() {
  load_feature_state
  if ((${#feature_order[@]} == 0)); then
    printf '%s\n' 'No tracked rw-base features.'
  else
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
  fi
  if ((${#unmanaged_commits[@]} > 0)); then
    printf '%s\n' 'Unmanaged rw-base first-parent commits:'
    local index
    for index in "${!unmanaged_commits[@]}"; do
      printf 'UNMANAGED\t%s\t%s\n' \
        "${unmanaged_commits[$index]}" "${unmanaged_subjects[$index]}"
    done
  fi
}

require_no_unmanaged_commits() {
  ((${#unmanaged_commits[@]} == 0)) && return 0
  printf '%s\n' \
    'manage-rw-base: unmanaged rw-base first-parent commits prevent lifecycle inference:' >&2
  local index
  for index in "${!unmanaged_commits[@]}"; do
    printf '  %s %s\n' "${unmanaged_commits[$index]}" "${unmanaged_subjects[$index]}" >&2
  done
  fail 'inspect and explicitly reconcile these commits before promote/maintain/retire'
}

if [[ "$command_name" == status ]]; then
  ((${#requested_features[@]} == 0 && ${#requested_branches[@]} == 0)) ||
    fail "status does not accept feature or branch options"
  [[ -z "$state_file" ]] || fail "status does not accept --state-file"
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

prepare_state_destination() {
  [[ -n "$state_file" ]] || return 0
  mkdir -p -- "$(dirname -- "$state_file")"
  rm -f -- "$state_file"
}

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
  unset operation_action operation_base_before operation_main operation_control operation_state_file
  unset operation_replacement operation_branch_name operation_worktree
  unset operation_feature_count operation_replay_count
  unset operation_features operation_branches operation_heads operation_replay_commits
  # shellcheck disable=SC1090
  source "$request_path"
  [[ "${operation_version:-}" == 1 ]] || fail "unsupported operation request version"
  operation_state_file=${operation_state_file:-}
  operation_request=$request_path
}

verify_frozen_request() {
  local current_base current_source_head current_remote_head index
  [[ "$(git -C "$control_root" rev-parse HEAD)" == "$operation_control" ]] ||
    fail "control HEAD moved since the operation was created"
  [[ "$(git -C "$control_root" rev-parse "$upstream_branch")" == "$operation_main" ]] ||
    fail "main moved since the operation was created"
  current_remote_head=$(
    git -C "$control_root" rev-parse --verify refs/remotes/upstream/main 2>/dev/null || true
  )
  [[ "$current_remote_head" == "$operation_main" ]] ||
    fail "upstream/main moved since the operation was created"
  current_remote_head=$(
    git -C "$control_root" rev-parse --verify refs/remotes/origin/main 2>/dev/null || true
  )
  [[ "$current_remote_head" == "$operation_main" ]] ||
    fail "origin/main moved since the operation was created"
  current_base=$(git -C "$control_root" rev-parse --verify "$base_branch" 2>/dev/null || true)
  [[ "$current_base" == "$operation_base_before" ]] ||
    fail "rw-base moved since the operation was created"
  for ((index = 0; index < ${#operation_branches[@]}; index++)); do
    current_source_head=$(git -C "$control_root" rev-parse "${operation_branches[$index]}")
    [[ "$current_source_head" == "${operation_heads[$index]}" ]] ||
      fail "source branch ${operation_branches[$index]} moved since the operation was created"
    current_remote_head=$(
      git -C "$control_root" rev-parse --verify \
        "refs/remotes/origin/${operation_branches[$index]}" 2>/dev/null || true
    )
    [[ "$current_remote_head" == "${operation_heads[$index]}" ]] ||
      fail "origin/${operation_branches[$index]} moved since the operation was created"
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
  rm -f -- "$operation_dir"/conflict.env "$operation_dir"/conflict-patch-targets.env
  rm -f -- "$operation_dir"/conflict-ls-files-u.txt
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
    printf 'operation_state_file=%q\n' "$state_file"
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

write_shell_array() {
  local name=$1
  shift
  local value
  printf '%s=(' "$name"
  for value in "$@"; do printf ' %q' "$value"; done
  printf ' )\n'
}

patch_targets_from_blob() {
  local blob=$1
  git -C "$operation_worktree" cat-file blob "$blob" |
    sed -n 's|^diff --git a/.* b/||p' |
    LC_ALL=C sort -u
}

patch_changes_from_blob_target() {
  local blob=$1 target=$2
  git -C "$operation_worktree" cat-file blob "$blob" |
    awk -v wanted="$target" '
      /^diff --git / {
        suffix = " b/" wanted
        in_target = length($0) >= length(suffix) && \
          substr($0, length($0) - length(suffix) + 1) == suffix
        in_hunk = 0
        next
      }
      in_target && /^@@/ {
        in_hunk = 1
        next
      }
      in_target && in_hunk && !/^\+\+\+ / && !/^--- / && /^[+-]/ { print }
    '
}

snapshot_conflict() {
  local phase=$1 ours theirs base record metadata path mode blob stage status
  local index target record_terminator temp
  local -a paths=() statuses=()
  local -a stage1_modes=() stage1_blobs=()
  local -a stage2_modes=() stage2_blobs=()
  local -a stage3_modes=() stage3_blobs=()
  local -a patch_target_records=()
  local -A path_indexes=() path_statuses=()

  ours=$(git -C "$operation_worktree" rev-parse HEAD)
  if theirs=$(git -C "$operation_worktree" rev-parse --verify CHERRY_PICK_HEAD 2>/dev/null); then
    base=$(git -C "$operation_worktree" rev-parse "$theirs^1")
  else
    theirs=$(git -C "$operation_worktree" rev-parse --verify MERGE_HEAD 2>/dev/null) ||
      fail "cannot identify the other side of the $phase conflict"
    base=$(git -C "$operation_worktree" merge-base "$ours" "$theirs" | head -n 1)
    [[ -n "$base" ]] || base=none
  fi

  temp=$(mktemp "$operation_dir/conflict-ls-files-u.txt.tmp.XXXXXX")
  git -C "$operation_worktree" ls-files -u >"$temp"
  chmod 600 "$temp"
  mv -- "$temp" "$operation_dir/conflict-ls-files-u.txt"

  while IFS= read -r -d '' record; do
    status=${record:0:2}
    path=${record:3}
    path_statuses["$path"]=$status
  done < <(git -C "$operation_worktree" status --porcelain=v1 -z --untracked-files=no)

  while IFS= read -r -d '' record; do
    metadata=${record%%$'\t'*}
    path=${record#*$'\t'}
    read -r mode blob stage record_terminator <<<"$metadata"
    [[ -z "${record_terminator:-}" ]] || fail "malformed conflict index entry for $path"
    if [[ -z "${path_indexes[$path]+present}" ]]; then
      index=${#paths[@]}
      path_indexes["$path"]=$index
      paths+=("$path")
      statuses+=("${path_statuses[$path]:-??}")
      stage1_modes+=("")
      stage1_blobs+=("")
      stage2_modes+=("")
      stage2_blobs+=("")
      stage3_modes+=("")
      stage3_blobs+=("")
    else
      index=${path_indexes[$path]}
    fi
    case "$stage" in
      1)
        stage1_modes[$index]=$mode
        stage1_blobs[$index]=$blob
        ;;
      2)
        stage2_modes[$index]=$mode
        stage2_blobs[$index]=$blob
        ;;
      3)
        stage3_modes[$index]=$mode
        stage3_blobs[$index]=$blob
        ;;
      *) fail "invalid conflict stage $stage for $path" ;;
    esac
  done < <(git -C "$operation_worktree" ls-files -u -z)

  temp=$(mktemp "$operation_dir/conflict.env.tmp.XXXXXX")
  {
    printf '%s\n' 'conflict_version=1'
    printf 'conflict_phase=%q\n' "$phase"
    printf 'conflict_ours=%q\n' "$ours"
    printf 'conflict_theirs=%q\n' "$theirs"
    printf 'conflict_base=%q\n' "$base"
    write_shell_array conflict_paths "${paths[@]}"
    write_shell_array conflict_statuses "${statuses[@]}"
    write_shell_array conflict_stage1_modes "${stage1_modes[@]}"
    write_shell_array conflict_stage1_blobs "${stage1_blobs[@]}"
    write_shell_array conflict_stage2_modes "${stage2_modes[@]}"
    write_shell_array conflict_stage2_blobs "${stage2_blobs[@]}"
    write_shell_array conflict_stage3_modes "${stage3_modes[@]}"
    write_shell_array conflict_stage3_blobs "${stage3_blobs[@]}"
  } >"$temp"
  chmod 600 "$temp"
  mv -- "$temp" "$operation_dir/conflict.env"

  for index in "${!paths[@]}"; do
    path=${paths[$index]}
    [[ "$path" == *.patch ]] || continue
    for stage in 1 2 3; do
      case "$stage" in
        1) blob=${stage1_blobs[$index]} ;;
        2) blob=${stage2_blobs[$index]} ;;
        3) blob=${stage3_blobs[$index]} ;;
      esac
      [[ -n "$blob" ]] || continue
      while IFS= read -r target; do
        [[ -n "$target" ]] || continue
        patch_target_records+=("$stage"$'\t'"$path"$'\t'"$target")
      done < <(patch_targets_from_blob "$blob")
    done
  done
  temp=$(mktemp "$operation_dir/conflict-patch-targets.env.tmp.XXXXXX")
  {
    printf '%s\n' 'conflict_patch_targets_version=1'
    write_shell_array conflict_patch_target_records "${patch_target_records[@]}"
  } >"$temp"
  chmod 600 "$temp"
  mv -- "$temp" "$operation_dir/conflict-patch-targets.env"
  printf 'Conflict snapshot saved in %s.\n' "$operation_dir"
}

auto_stage_disjoint_patch_unions() {
  [[ -f "$operation_dir/conflict.env" ]] || return 0
  # shellcheck disable=SC1090
  source "$operation_dir/conflict.env"
  local index path target overlap temp staged_blob
  local -a ours_targets theirs_targets resolved_targets
  local -A ours_target_set=()
  for index in "${!conflict_paths[@]}"; do
    path=${conflict_paths[$index]}
    [[ "${conflict_statuses[$index]}" == AA && "$path" == *.patch ]] || continue
    [[ -n "${conflict_stage2_blobs[$index]}" && -n "${conflict_stage3_blobs[$index]}" ]] ||
      continue
    [[ "${conflict_stage2_modes[$index]}" == "${conflict_stage3_modes[$index]}" ]] || continue
    mapfile -t ours_targets < <(patch_targets_from_blob "${conflict_stage2_blobs[$index]}")
    mapfile -t theirs_targets < <(patch_targets_from_blob "${conflict_stage3_blobs[$index]}")
    ((${#ours_targets[@]} > 0 && ${#theirs_targets[@]} > 0)) || continue
    ours_target_set=()
    for target in "${ours_targets[@]}"; do ours_target_set["$target"]=1; done
    overlap=0
    for target in "${theirs_targets[@]}"; do
      if [[ -n "${ours_target_set[$target]+present}" ]]; then
        overlap=1
        break
      fi
    done
    ((overlap == 0)) || continue

    temp=$(mktemp "$operation_dir/.patch-union.XXXXXX")
    {
      git -C "$operation_worktree" cat-file blob "${conflict_stage2_blobs[$index]}"
      printf '\n'
      git -C "$operation_worktree" cat-file blob "${conflict_stage3_blobs[$index]}"
    } >"$temp"
    mv -- "$temp" "$operation_worktree/$path"
    if [[ "${conflict_stage2_modes[$index]}" == 100755 ]]; then
      chmod +x "$operation_worktree/$path"
    else
      chmod -x "$operation_worktree/$path"
    fi
    git -C "$operation_worktree" add -- "$path"
    staged_blob=$(git -C "$operation_worktree" rev-parse ":$path")
    mapfile -t resolved_targets < <(patch_targets_from_blob "$staged_blob")
    printf 'Auto-staged disjoint add/add patch union: %s (%s targets).\n' \
      "$path" "${#resolved_targets[@]}"
  done
}

validate_conflict_resolution() {
  [[ -f "$operation_dir/conflict.env" ]] || return 0
  # shellcheck disable=SC1090
  source "$operation_dir/conflict.env"
  [[ "${conflict_version:-}" == 1 ]] || fail 'unsupported conflict snapshot version'
  [[ "$conflict_phase" == "$operation_phase" ]] ||
    fail "conflict snapshot phase $conflict_phase does not match $operation_phase"
  [[ "$(git -C "$operation_worktree" rev-parse HEAD)" == "$conflict_ours" ]] ||
    fail 'operation HEAD moved since the conflict snapshot was recorded'

  local current_theirs
  if [[ "$conflict_phase" == replay ]]; then
    current_theirs=$(
      git -C "$operation_worktree" rev-parse --verify CHERRY_PICK_HEAD 2>/dev/null
    ) || fail 'the cherry-pick state disappeared after the conflict snapshot was recorded'
  else
    current_theirs=$(
      git -C "$operation_worktree" rev-parse --verify MERGE_HEAD 2>/dev/null
    ) || fail 'the merge state disappeared after the conflict snapshot was recorded'
  fi
  [[ "$current_theirs" == "$conflict_theirs" ]] ||
    fail 'the other conflict parent moved since the conflict snapshot was recorded'

  local index path staged_blob resolved_blob side_blob target side change
  local -a ours_targets=() theirs_targets=() required_targets resolved_targets
  local -a required_changes=() resolved_changes=()
  local -A resolved_target_set=() resolved_change_set=()
  for index in "${!conflict_paths[@]}"; do
    path=${conflict_paths[$index]}
    [[ "${conflict_statuses[$index]}" == AA && "$path" == *.patch ]] || continue
    for side in 2 3; do
      if [[ "$side" == 2 ]]; then
        staged_blob=${conflict_stage2_blobs[$index]}
      else
        staged_blob=${conflict_stage3_blobs[$index]}
      fi
      mapfile -t required_targets < <(patch_targets_from_blob "$staged_blob")
      ((${#required_targets[@]} > 0)) ||
        fail "cannot identify diff --git targets in conflict stage $side for $path"
      if [[ "$side" == 2 ]]; then
        ours_targets=("${required_targets[@]}")
      else
        theirs_targets=("${required_targets[@]}")
      fi
    done
    resolved_blob=$(git -C "$operation_worktree" rev-parse --verify ":$path" 2>/dev/null) ||
      fail "resolved conflict is not staged: $path"
    mapfile -t resolved_targets < <(patch_targets_from_blob "$resolved_blob")
    resolved_target_set=()
    for target in "${resolved_targets[@]}"; do resolved_target_set["$target"]=1; done
    for side in ours theirs; do
      if [[ "$side" == ours ]]; then
        required_targets=("${ours_targets[@]}")
      else
        required_targets=("${theirs_targets[@]}")
      fi
      for target in "${required_targets[@]}"; do
        if [[ -z "${resolved_target_set[$target]+present}" ]]; then
          fail "conflict resolution for $path drops patch target from $side: $target"
        fi
        if [[ "$side" == ours ]]; then
          side_blob=${conflict_stage2_blobs[$index]}
        else
          side_blob=${conflict_stage3_blobs[$index]}
        fi
        mapfile -t required_changes < <(patch_changes_from_blob_target "$side_blob" "$target")
        mapfile -t resolved_changes < <(patch_changes_from_blob_target "$resolved_blob" "$target")
        resolved_change_set=()
        for change in "${resolved_changes[@]}"; do resolved_change_set["$change"]=1; done
        for change in "${required_changes[@]}"; do
          if [[ -z "${resolved_change_set[$change]+present}" ]]; then
            fail "conflict resolution for $path drops patch change from $side target $target: $change"
          fi
        done
      done
    done
  done
}

if [[ "$command_name" == abort ]]; then
  [[ -z "$state_file" ]] || fail "abort does not accept --state-file"
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
      snapshot_conflict replay
      auto_stage_disjoint_patch_unions
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
      snapshot_conflict feature
      auto_stage_disjoint_patch_unions
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

dependency_inputs_changed() {
  local old_ref=$1
  local new_ref=$2
  ! git -C "$build_root" diff --quiet "$old_ref..$new_ref" -- \
    package.json package-lock.json ':(glob)**/package.json' \
    ':(glob)patches/**' scripts/postinstall-patches.mjs
}

finalize_operation() {
  local rebuild_args=(--build-root "$build_root" --base-candidate "$operation_branch_name")
  local build_starting_branch rw_main_before rw_base_after rw_main_after main_after control_after
  local rw_base_rebuilt rw_main_rebuilt dependencies_reinstalled total_seconds
  build_starting_branch=$(git -C "$build_root" branch --show-current)
  rw_main_before=$(git -C "$control_root" rev-parse --verify "$target_branch" 2>/dev/null || true)
  if ((push_target)); then rebuild_args+=(--push); fi
  if ! bash "$control_root/dwyanewang/rebuild-rw-main.sh" "${rebuild_args[@]}"; then
    printf 'PASEO_RW_BASE_OPERATION=%s\n' "$operation_request"
    printf '%s\n' 'Candidate validation failed; fix the source or abort this operation.'
    exit 1
  fi
  rw_base_after=$(git -C "$control_root" rev-parse --verify "$base_branch")
  rw_main_after=$(git -C "$control_root" rev-parse --verify "$target_branch")
  main_after=$(git -C "$control_root" rev-parse --verify "$upstream_branch")
  control_after=$(git -C "$control_root" rev-parse HEAD)
  [[ "$operation_base_before" == "$rw_base_after" ]] && rw_base_rebuilt=0 || rw_base_rebuilt=1
  [[ "$rw_main_before" == "$rw_main_after" ]] && rw_main_rebuilt=0 || rw_main_rebuilt=1
  dependencies_reinstalled=0
  if [[ "$build_starting_branch" != "$target_branch" ]] ||
    [[ -z "$rw_main_before" ]] || dependency_inputs_changed "$rw_main_before" "$rw_main_after"; then
    dependencies_reinstalled=1
  fi
  total_seconds=$(( $(date +%s) - started_at ))
  cleanup_operation "$operation_request"
  if [[ -n "$state_file" ]]; then
    if paseo_atomic_write_state_file "$state_file" \
      build_starting_branch "$build_starting_branch" \
      rw_base_before "$operation_base_before" \
      rw_base_after "$rw_base_after" \
      rw_base_rebuilt "$rw_base_rebuilt" \
      rw_main_before "$rw_main_before" \
      rw_main_after "$rw_main_after" \
      rw_main_rebuilt "$rw_main_rebuilt" \
      dependencies_reinstalled "$dependencies_reinstalled" \
      control_head "$control_after" \
      main_before "$operation_main" \
      main_after "$main_after" \
      paseo_preflight_total_seconds "$total_seconds" \
      paseo_preflight_status ready; then
      printf 'PASEO_PREFLIGHT_STATE_FILE=%s\n' "$state_file"
    else
      rm -f -- "$state_file" || true
      printf '%s\n' \
        'manage-rw-base: could not write the optional ready state; run prepare-rw-main-for-build before artifact generation.' \
        >&2
    fi
  fi
  printf '%s\n' 'rw-base lifecycle operation completed.'
}

if [[ "$command_name" == continue ]]; then
  [[ -n "$operation_arg" ]] || fail "continue requires --operation REQUEST"
  requested_state_file=$state_file
  load_request_with_meta "$operation_arg"
  if [[ -n "$requested_state_file" && "$requested_state_file" != "$operation_state_file" ]]; then
    fail "--state-file does not match the frozen operation request"
  fi
  state_file=$operation_state_file
  refresh_remote_refs
  prepare_state_destination
  verify_frozen_request
  [[ -f "$operation_dir/progress.env" ]] || fail "operation progress is missing"
  # shellcheck disable=SC1090
  source "$operation_dir/progress.env"
  case "$operation_phase" in
    sync)
      [[ -z "$(git -C "$operation_worktree" diff --name-only --diff-filter=U)" ]] ||
        fail "the sync merge still has unresolved files"
      validate_conflict_resolution
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
      validate_conflict_resolution
      git -C "$operation_worktree" commit --no-edit
      merge_requested_features "$((operation_index + 1))"
      ;;
    replay)
      [[ -z "$(git -C "$operation_worktree" diff --name-only --diff-filter=U)" ]] ||
        fail "the retained-feature replay still has unresolved files"
      validate_conflict_resolution
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
prepare_state_destination
[[ -z "$(git -C "$control_root" status --porcelain)" ]] ||
  fail "control worktree is not clean: $control_root"
[[ -z "$(git -C "$build_root" status --porcelain)" ]] ||
  fail "build worktree is not clean: $build_root"
require_clean_worktree "$target_branch"

sync_main_with_upstream
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
require_no_unmanaged_commits

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
        snapshot_conflict sync
        auto_stage_disjoint_patch_unions
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
