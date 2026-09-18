#!/usr/bin/env bash

# Shared state primitives for the build-paseo control scripts. Source this file;
# it intentionally does not change the caller's shell options.

paseo_build_stage() {
  local message
  printf -v message '[%s] attempt=%s %s' "$(date '+%Y-%m-%d %H:%M:%S %z')" \
    "${PASEO_BUILD_ATTEMPT:-$$}" "$*"
  printf '%s\n' "$message"
  if [[ -n "${PASEO_BUILD_REQUEST_STAGE_LOG:-}" ]]; then
    printf '%s\n' "$message" >>"$PASEO_BUILD_REQUEST_STAGE_LOG"
  fi
}

paseo_build_timed() (
  local label=$1 started=$SECONDS
  shift
  paseo_build_stage "$label:start"
  trap 'code=$?; paseo_build_stage "$label:end exit=$code elapsed=$((SECONDS - started))s"; exit "$code"' EXIT
  "$@"
)

paseo_assert_frozen_main() {
  local root=$1 frozen=$2 mirror tip
  [[ "$frozen" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ "$(git -C "$root" rev-parse refs/heads/main)" == "$frozen" ]] || {
    printf 'Frozen main moved: expected %s; start an explicit refresh.\n' "$frozen" >&2
    return 1
  }
  git -C "$root" show-ref --verify --quiet refs/remotes/upstream/main || return 1
  for mirror in refs/remotes/upstream/main refs/remotes/origin/main; do
    if tip=$(git -C "$root" rev-parse --verify "$mirror" 2>/dev/null); then
      git -C "$root" merge-base --is-ancestor "$frozen" "$tip" || {
        printf 'Frozen main %s is not an ancestor of %s.\n' "$frozen" "$mirror" >&2
        return 1
      }
    fi
  done
}

paseo_assert_frozen_ancestry() {
  local root=$1 frozen=$2 head=$3 label=$4 bases base
  bases=$(git -C "$root" merge-base --all refs/remotes/upstream/main "$head") || return 1
  [[ -n "$bases" ]] || return 1
  while IFS= read -r base; do
    git -C "$root" merge-base --is-ancestor "$base" "$frozen" || {
      printf '%s introduces upstream %s beyond frozen main %s; rebase onto the snapshot or refresh the request.\n' \
        "$label" "$base" "$frozen" >&2
      return 1
    }
  done <<<"$bases"
}

paseo_atomic_write_state_file() {
  (($# >= 1)) || return 2
  local destination=$1
  shift
  (($# % 2 == 0)) || return 2

  local index key value destination_dir temp_file
  local -a fields=("$@")
  for ((index = 0; index < ${#fields[@]}; index += 2)); do
    key=${fields[$index]}
    [[ "$key" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || return 2
  done

  destination_dir=$(dirname -- "$destination") || return 1
  mkdir -p -- "$destination_dir" || return 1
  temp_file=$(mktemp "${destination}.tmp.XXXXXX") || return 1

  if ! {
    for ((index = 0; index < ${#fields[@]}; index += 2)); do
      key=${fields[$index]}
      value=${fields[$((index + 1))]}
      printf '%s=%q\n' "$key" "$value"
    done
  } >"$temp_file"; then
    rm -f -- "$temp_file"
    return 1
  fi
  if ! chmod 600 "$temp_file"; then
    rm -f -- "$temp_file"
    return 1
  fi
  if ! mv -- "$temp_file" "$destination"; then
    rm -f -- "$temp_file"
    return 1
  fi
}

# Expo's autolinker enumerates packages/app/modules by directory shape, not by
# whether a module has native files or an expo-module.config.json.  Keep this
# check close to the shared build state helpers so the artifact orchestrator and
# its focused tests use exactly the same rules.
paseo_check_expo_modules() {
  (($# == 1)) || return 2
  local root=$1 modules_dir candidate relative package_file package_info tracked ignored
  local failed=0
  local -a candidates=()

  modules_dir="$root/packages/app/modules"
  [[ -d "$modules_dir" || -L "$modules_dir" ]] || return 0

  # nativeModulesDir changes Expo's search root.  Do not silently apply the
  # default rules to a different resolver; make the configuration change
  # explicit instead.
  if command -v rg >/dev/null && rg -n --no-messages 'nativeModulesDir' \
    "$root/packages/app/app.json" "$root/packages/app/app.config.js" \
    "$root/packages/app/app.config.cjs" "$root/packages/app/app.config.ts" \
    "$root/packages/app/package.json" >/dev/null 2>&1; then
    printf '%s\n' 'Expo module preflight: nativeModulesDir is configured; update the preflight rules before building.' >&2
    return 1
  fi

  # Expo scans visible direct module directories and one level below a scoped
  # namespace (for example @scope/name).  Shell globs intentionally exclude
  # hidden entries; symlinks are retained as candidates even when their target
  # is missing so a useful diagnostic is emitted.
  local entry child base
  for entry in "$modules_dir"/*; do
    [[ -e "$entry" || -L "$entry" ]] || continue
    base=${entry##*/}
    [[ "$base" != .* ]] || continue
    if [[ "$base" == @* && -d "$entry" ]]; then
      for child in "$entry"/*; do
        [[ -e "$child" || -L "$child" ]] || continue
        base=${child##*/}
        [[ "$base" != .* ]] || continue
        candidates+=("$child")
      done
    else
      candidates+=("$entry")
    fi
  done

  for candidate in "${candidates[@]}"; do
    [[ -d "$candidate" || -L "$candidate" ]] || continue
    relative=${candidate#"$root/"}
    package_file="$candidate/package.json"
    tracked=$(git -C "$root" ls-files -- "$relative" "$relative/" 2>/dev/null || true)
    ignored=$(git -C "$root" check-ignore -v -- "$relative" "$package_file" 2>/dev/null || true)
    if [[ ! -f "$package_file" ]]; then
      printf 'Expo module preflight: invalid module %s: package.json is missing\n' "$relative" >&2
      printf '  git-tracked: %s\n  git-ignored: %s\n' \
        "${tracked:-no}" "${ignored:-no}" >&2
      printf '%s\n' '  isolate the stale directory manually; the preflight never deletes or moves modules.' >&2
      failed=1
      continue
    fi
    if ! package_info=$(node -e '
      const fs = require("node:fs");
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (!value || typeof value !== "object") throw new Error("package.json is not an object");
      process.stdout.write(`name=${typeof value.name === "string" ? value.name : "<unnamed>"} version=${typeof value.version === "string" ? value.version : "<unknown>"}`);
    ' "$package_file" 2>&1); then
      printf 'Expo module preflight: invalid module %s: package.json cannot be parsed (%s)\n' \
        "$relative" "$package_info" >&2
      printf '  git-tracked: %s\n  git-ignored: %s\n' \
        "${tracked:-no}" "${ignored:-no}" >&2
      failed=1
      continue
    fi
    if [[ -z "$tracked" ]]; then
      printf 'Expo module preflight: rejected untracked/ignored module %s (%s)\n' \
        "$relative" "$package_info" >&2
      printf '  git-tracked: no\n  git-ignored: %s\n' "${ignored:-no}" >&2
      printf '%s\n' '  isolate the stale directory manually; the preflight never deletes or moves modules.' >&2
      failed=1
    else
      printf 'Expo module preflight: OK %s (%s)\n' "$relative" "$package_info"
    fi
  done
  return "$failed"
}

paseo_pid_start_ticks() {
  (($# == 1)) || return 2
  local pid=$1 stat_line
  [[ "$pid" =~ ^[0-9]+$ && -r "/proc/$pid/stat" ]] || return 1
  stat_line=$(<"/proc/$pid/stat") || return 1
  # The comm field is parenthesized and may contain spaces; the build script's
  # comm is stable, so the final fields are safe to read after the last ')'.
  printf '%s\n' "${stat_line##*) }" | awk '{print $20}'
}

paseo_prepare_artifact_run_dir() {
  (($# == 1 || $# == 2)) || return 2
  local run_dir=$1 start_timeout=${2:-${PASEO_WAIT_START_TIMEOUT_SECONDS:-30}}
  local prepared_at
  [[ "$run_dir" == /* ]] || {
    printf '%s\n' 'build-paseo launch: run directory must be absolute.' >&2
    return 2
  }
  [[ "$start_timeout" =~ ^[0-9]+$ && "$start_timeout" -ge 1 ]] || return 2
  [[ ! -e "$run_dir" ]] || {
    printf 'build-paseo launch: run directory already exists: %s\n' "$run_dir" >&2
    return 1
  }
  mkdir -p -- "$(dirname -- "$run_dir")" || return 1
  mkdir -- "$run_dir" || return 1
  prepared_at=$(date +%s)
  paseo_atomic_write_state_file "$run_dir/launch.env" \
    paseo_artifact_launch_status starting \
    paseo_artifact_launch_prepared_at "$prepared_at" \
    paseo_artifact_launch_timeout_seconds "$start_timeout"
}

paseo_artifact_run_state() {
  (($# == 1)) || return 2
  local run_dir=$1 status result_status result_run pid pid_ticks current_ticks command
  local launch_status launch_prepared_at launch_timeout now
  if [[ -f "$run_dir/exit-status" ]]; then
    status=$(<"$run_dir/exit-status")
    if [[ -f "$run_dir/result.env" ]]; then
      result_status=$(sed -n 's/^paseo_artifact_build_status=\(.*\)$/\1/p' "$run_dir/result.env")
      result_run=$(sed -n 's/^paseo_artifact_build_run_dir=\(.*\)$/\1/p' "$run_dir/result.env")
      if [[ "$result_status" == ready && "$result_run" == "$run_dir" && "$status" == 0 ]]; then
        printf '%s\n' ready
        return 0
      fi
    fi
    if [[ "$status" =~ ^[0-9]+$ && "$status" != 0 ]]; then
      printf '%s\n' failed
      return 1
    fi
  fi
  if [[ -f "$run_dir/pid.env" ]]; then
    pid=$(sed -n 's/^paseo_artifact_pid=\(.*\)$/\1/p' "$run_dir/pid.env")
    pid_ticks=$(sed -n 's/^paseo_artifact_pid_start_ticks=\(.*\)$/\1/p' "$run_dir/pid.env")
    command=$(sed -n 's/^paseo_artifact_pid_command=\(.*\)$/\1/p' "$run_dir/pid.env")
    current_ticks=$(paseo_pid_start_ticks "$pid" 2>/dev/null || true)
    if [[ -n "$current_ticks" && "$current_ticks" == "$pid_ticks" && -r "/proc/$pid/cmdline" ]] &&
      tr '\0' ' ' <"/proc/$pid/cmdline" | grep -F -- "$command" >/dev/null 2>&1; then
      printf '%s\n' running
      return 3
    fi
  fi
  if [[ -f "$run_dir/launch.env" ]]; then
    launch_status=$(sed -n 's/^paseo_artifact_launch_status=\(.*\)$/\1/p' "$run_dir/launch.env")
    launch_prepared_at=$(sed -n 's/^paseo_artifact_launch_prepared_at=\(.*\)$/\1/p' "$run_dir/launch.env")
    launch_timeout=$(sed -n 's/^paseo_artifact_launch_timeout_seconds=\(.*\)$/\1/p' "$run_dir/launch.env")
    if [[ ("$launch_status" == starting || "$launch_status" == running) &&
      "$launch_prepared_at" =~ ^[0-9]+$ &&
      "$launch_timeout" =~ ^[0-9]+$ ]]; then
      now=$(date +%s)
      if ((now <= launch_prepared_at + launch_timeout)); then
        printf '%s\n' starting
        return 4
      fi
    fi
  fi
  printf '%s\n' abandoned
  return 2
}

paseo_wait_for_artifact_run() {
  (($# >= 1 && $# <= 3)) || return 2
  local run_dir=$1 interval=${2:-${PASEO_WAIT_INTERVAL_SECONDS:-20}}
  local start_timeout=${3:-${PASEO_WAIT_START_TIMEOUT_SECONDS:-30}}
  local previous= now last_report wait_started state
  [[ "$run_dir" == /* ]] || return 2
  [[ "$interval" =~ ^[0-9]+$ && "$interval" -ge 1 ]] || return 2
  [[ "$start_timeout" =~ ^[0-9]+$ && "$start_timeout" -ge 1 ]] || return 2
  wait_started=$(date +%s)
  last_report=$wait_started
  while :; do
    now=$(date +%s)
    if [[ ! -e "$run_dir" ]]; then
      if ((now <= wait_started + start_timeout)); then
        state=starting
      else
        state=abandoned
      fi
    else
      state=$(paseo_artifact_run_state "$run_dir") || true
      if [[ "$state" == abandoned && ! -e "$run_dir/pid.env" &&
        ! -e "$run_dir/exit-status" && $now -le $((wait_started + start_timeout)) ]]; then
        state=starting
      fi
    fi
    if [[ "$state" != "$previous" ]]; then
      printf 'build-paseo wait: %s (%s)\n' "$state" "$run_dir"
      previous=$state
      last_report=$now
    elif ((now - last_report >= 600)); then
      printf 'build-paseo wait: still %s (%s)\n' "$state" "$run_dir"
      last_report=$now
    fi
    case "$state" in
      ready) return 0 ;;
      failed) return 1 ;;
      abandoned) return 2 ;;
    esac
    sleep "$interval"
  done
}

paseo_mark_artifact_heartbeat_cleaned() {
  (($# == 1)) || return 2
  local run_dir=$1 heartbeat_file="$1/heartbeat.env"
  local heartbeat_id heartbeat_status cleaned_at
  [[ -f "$heartbeat_file" && ! -L "$heartbeat_file" ]] || return 0
  heartbeat_id=$(sed -n 's/^paseo_artifact_heartbeat_id=\(.*\)$/\1/p' "$heartbeat_file")
  heartbeat_status=$(sed -n 's/^paseo_artifact_heartbeat_status=\(.*\)$/\1/p' "$heartbeat_file")
  [[ -n "$heartbeat_id" && "$heartbeat_status" == created ]] || return 0
  cleaned_at=$(date +%s)
  paseo_atomic_write_state_file "$heartbeat_file" \
    paseo_artifact_heartbeat_id "$heartbeat_id" \
    paseo_artifact_heartbeat_status cleaned \
    paseo_artifact_heartbeat_cleaned 1 \
    paseo_artifact_heartbeat_cleaned_at "$cleaned_at"
}

# The heartbeat is created and deleted through the owning agent's MCP tools.
# This helper only records the deletion confirmation after that MCP call; it
# deliberately never invokes the shell CLI, which may require a daemon password.
paseo_cleanup_artifact_heartbeat() {
  (($# == 1)) || return 2
  [[ "${PASEO_ARTIFACT_HEARTBEAT_DELETE_CONFIRMED:-}" == 1 ]] || {
    printf '%s\n' 'build-paseo heartbeat cleanup: first delete the heartbeat through the owning agent MCP tool, then set PASEO_ARTIFACT_HEARTBEAT_DELETE_CONFIRMED=1.' >&2
    return 2
  }
  paseo_mark_artifact_heartbeat_cleaned "$1"
}

_paseo_build_stamp_hash_inventory() {
  (($# >= 2)) || return 1
  local root=$1 output
  shift
  # One process, bounded file-content streaming, and the same ordered NUL-delimited
  # records as stamp v1 (including modes and link identity, not link contents).
  # fd 3 carries the path inventory so its size is not constrained by ARG_MAX;
  # stdin remains the program heredoc. Preserve a failing inventory producer.
  output=$(
    set -o pipefail
    printf '%s\0' "$@" | node --input-type=module - "$root" 3<&0 <<'JS'
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
const paths = readFileSync(3, 'utf8');
if (!paths.endsWith('\0')) throw new Error('Unterminated inventory path list');
const files = paths.slice(0, -1).split('\0');
const inventory = createHash('sha256');
for (const relative of files) {
  const absolute = path.join(root, relative);
  const stat = lstatSync(absolute);
  const entry = createHash('sha256');
  let type;
  if (stat.isSymbolicLink()) {
    type = 'symlink';
    // Shell command substitution in v1 strips trailing LF from readlink.
    let target = readlinkSync(absolute, { encoding: 'buffer' });
    while (target.at(-1) === 10) target = target.subarray(0, -1);
    entry.update(target);
  } else if (stat.isFile()) {
    type = 'file';
    for await (const chunk of createReadStream(absolute)) entry.update(chunk);
  } else {
    throw new Error(`Not a file or symlink: ${relative}`);
  }
  inventory.update(`${relative}\0${type}\0${(stat.mode & 0o7777).toString(8)}\0${entry.digest('hex')}\0`);
}
console.log(inventory.digest('hex'));
JS
  ) || return 1
  [[ "$output" =~ ^[0-9a-f]{64}$ ]] || {
    printf '%s\n' 'build-paseo-state: invalid inventory digest from node.' >&2
    return 1
  }
  printf '%s\n' "$output"
}

_paseo_build_stamp_runtime_version() {
  (($# == 1)) || return 1
  local version
  version=$("$1" --version) || return 1
  [[ "$version" =~ ^[0-9A-Za-z][0-9A-Za-z.+_-]*$ ]] || return 1
  printf '%s\n' "$version"
}

_paseo_build_stamp_toolchain_hash() {
  (($# == 3)) || return 1
  local root=$1 node_version=$2 npm_version=$3 pinned_inputs_hash output
  [[ -f "$root/.tool-versions" && -f "$root/.mise.toml" ]] || return 1
  pinned_inputs_hash=$(
    _paseo_build_stamp_hash_inventory "$root" .mise.toml .tool-versions
  ) || return 1
  output=$(
    printf 'pinned-inputs\0%s\0node\0%s\0npm\0%s\0' \
      "$pinned_inputs_hash" "$node_version" "$npm_version" | sha256sum
  ) || return 1
  output=${output%% *}
  [[ "$output" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s\n' "$output"
}

_paseo_build_stamp_dependency_hash() {
  local root=$1 relative_path
  local -a dependency_files=()
  for relative_path in package.json package-lock.json scripts/postinstall-patches.mjs; do
    [[ -f "$root/$relative_path" ]] || return 1
  done
  while IFS= read -r -d '' relative_path; do
    dependency_files+=("$relative_path")
  done < <(
    git -C "$root" ls-files -z -- \
      package.json package-lock.json \
      ':(glob)**/package.json' ':(glob)**/package-lock.json' \
      ':(glob)patches/**' scripts/postinstall-patches.mjs
  )
  ((${#dependency_files[@]} > 0)) || return 1
  _paseo_build_stamp_hash_inventory "$root" "${dependency_files[@]}"
}

_paseo_build_stamp_output_hash() {
  local root=$1 output_dir absolute_path relative_path protocol_output_found=0
  local before_count
  local -a output_dirs=(
    packages/highlight/dist
    packages/relay/dist
    packages/protocol/dist
    packages/client/dist
    packages/server/dist
    packages/cli/dist
  )
  local -a output_files=()

  [[ -s "$root/packages/server/dist/server/server/exports.js" ]] || return 1
  [[ -s "$root/packages/cli/dist/index.js" ]] || return 1
  while IFS= read -r -d '' absolute_path; do
    if [[ -s "$absolute_path" ]]; then
      protocol_output_found=1
      break
    fi
  done < <(find "$root/packages/protocol/dist" -maxdepth 1 -type f -name '*.js' -print0 2>/dev/null)
  ((protocol_output_found)) || return 1

  for output_dir in "${output_dirs[@]}"; do
    [[ -d "$root/$output_dir" ]] || return 1
    before_count=${#output_files[@]}
    while IFS= read -r -d '' absolute_path; do
      relative_path=${absolute_path#"$root/"}
      output_files+=("$relative_path")
    done < <(
      find "$root/$output_dir" \( -type f -o -type l \) -print0 | LC_ALL=C sort -z
    )
    ((${#output_files[@]} > before_count)) || return 1
  done

  _paseo_build_stamp_hash_inventory "$root" "${output_files[@]}"
}

_paseo_build_stamp_level_satisfies() {
  local actual=$1 required=$2
  case "$required:$actual" in
    server-build:server-build | server-build:readiness | readiness:readiness) return 0 ;;
    *) return 1 ;;
  esac
}

paseo_write_build_stamp() {
  (($# >= 3 && $# <= 4)) || return 2
  local root=$1 stamp_file=$2 validation_level=$3 build_ref=${4:-HEAD}
  local build_head build_tree node_version npm_version toolchain_hash dependency_hash output_hash

  [[ "$validation_level" == server-build || "$validation_level" == readiness ]] || return 2
  build_head=$(git -C "$root" rev-parse --verify "${build_ref}^{commit}") || return 1
  build_tree=$(git -C "$root" rev-parse --verify "${build_ref}^{tree}") || return 1
  [[ "$build_head" =~ ^[0-9a-f]{40}$ && "$build_tree" =~ ^[0-9a-f]{40}$ ]] || return 1
  node_version=$(_paseo_build_stamp_runtime_version node) || return 1
  npm_version=$(_paseo_build_stamp_runtime_version npm) || return 1
  toolchain_hash=$(
    _paseo_build_stamp_toolchain_hash "$root" "$node_version" "$npm_version"
  ) || return 1
  dependency_hash=$(_paseo_build_stamp_dependency_hash "$root") || return 1
  output_hash=$(_paseo_build_stamp_output_hash "$root") || return 1

  paseo_atomic_write_state_file "$stamp_file" \
    paseo_build_stamp_version 1 \
    paseo_build_stamp_validation_level "$validation_level" \
    paseo_build_stamp_head "$build_head" \
    paseo_build_stamp_tree "$build_tree" \
    paseo_build_stamp_node_version "$node_version" \
    paseo_build_stamp_npm_version "$npm_version" \
    paseo_build_stamp_toolchain_sha256 "$toolchain_hash" \
    paseo_build_stamp_dependencies_sha256 "$dependency_hash" \
    paseo_build_stamp_outputs_sha256 "$output_hash"
}

paseo_verify_build_stamp() {
  (($# >= 4 && $# <= 5)) || return 2
  local root=$1 stamp_file=$2 identity_mode=$3 required_level=$4 build_ref=${5:-HEAD}
  local line key value
  local stamp_version= stamp_level= stamp_head= stamp_tree=
  local stamp_node_version= stamp_npm_version=
  local stamp_toolchain_hash= stamp_dependency_hash= stamp_output_hash=
  local current_head current_tree current_node_version current_npm_version
  local current_toolchain_hash current_dependency_hash current_output_hash
  local -A seen_fields=()

  PASEO_BUILD_STAMP_MISS_REASON=
  [[ "$identity_mode" == exact-head || "$identity_mode" == tree ]] || return 2
  [[ "$required_level" == server-build || "$required_level" == readiness ]] || return 2
  if [[ ! -f "$stamp_file" || -L "$stamp_file" ]]; then
    PASEO_BUILD_STAMP_MISS_REASON=missing
    return 1
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" != *=* ]]; then
      PASEO_BUILD_STAMP_MISS_REASON=malformed
      return 1
    fi
    key=${line%%=*}
    value=${line#*=}
    if [[ -n "${seen_fields[$key]:-}" ]]; then
      PASEO_BUILD_STAMP_MISS_REASON=malformed
      return 1
    fi
    seen_fields[$key]=1
    case "$key" in
      paseo_build_stamp_version) stamp_version=$value ;;
      paseo_build_stamp_validation_level) stamp_level=$value ;;
      paseo_build_stamp_head) stamp_head=$value ;;
      paseo_build_stamp_tree) stamp_tree=$value ;;
      paseo_build_stamp_node_version) stamp_node_version=$value ;;
      paseo_build_stamp_npm_version) stamp_npm_version=$value ;;
      paseo_build_stamp_toolchain_sha256) stamp_toolchain_hash=$value ;;
      paseo_build_stamp_dependencies_sha256) stamp_dependency_hash=$value ;;
      paseo_build_stamp_outputs_sha256) stamp_output_hash=$value ;;
      *)
        PASEO_BUILD_STAMP_MISS_REASON=malformed
        return 1
        ;;
    esac
  done <"$stamp_file"

  if [[ "$stamp_version" != 1 ]] ||
    [[ "$stamp_level" != server-build && "$stamp_level" != readiness ]] ||
    [[ ! "$stamp_head" =~ ^[0-9a-f]{40}$ ]] ||
    [[ ! "$stamp_tree" =~ ^[0-9a-f]{40}$ ]] ||
    [[ ! "$stamp_node_version" =~ ^[0-9A-Za-z][0-9A-Za-z.+_-]*$ ]] ||
    [[ ! "$stamp_npm_version" =~ ^[0-9A-Za-z][0-9A-Za-z.+_-]*$ ]] ||
    [[ ! "$stamp_toolchain_hash" =~ ^[0-9a-f]{64}$ ]] ||
    [[ ! "$stamp_dependency_hash" =~ ^[0-9a-f]{64}$ ]] ||
    [[ ! "$stamp_output_hash" =~ ^[0-9a-f]{64}$ ]]; then
    PASEO_BUILD_STAMP_MISS_REASON=malformed
    return 1
  fi
  if ! _paseo_build_stamp_level_satisfies "$stamp_level" "$required_level"; then
    PASEO_BUILD_STAMP_MISS_REASON=validation-level
    return 1
  fi

  current_head=$(git -C "$root" rev-parse --verify "${build_ref}^{commit}") || {
    PASEO_BUILD_STAMP_MISS_REASON=identity
    return 1
  }
  current_tree=$(git -C "$root" rev-parse --verify "${build_ref}^{tree}") || {
    PASEO_BUILD_STAMP_MISS_REASON=identity
    return 1
  }
  if [[ "$identity_mode" == exact-head && "$stamp_head" != "$current_head" ]]; then
    PASEO_BUILD_STAMP_MISS_REASON=head
    return 1
  fi
  if [[ "$stamp_tree" != "$current_tree" ]]; then
    PASEO_BUILD_STAMP_MISS_REASON=tree
    return 1
  fi

  current_node_version=$(_paseo_build_stamp_runtime_version node) || {
    PASEO_BUILD_STAMP_MISS_REASON=toolchain-runtime
    return 1
  }
  current_npm_version=$(_paseo_build_stamp_runtime_version npm) || {
    PASEO_BUILD_STAMP_MISS_REASON=toolchain-runtime
    return 1
  }
  if [[ "$stamp_node_version" != "$current_node_version" ]] ||
    [[ "$stamp_npm_version" != "$current_npm_version" ]]; then
    PASEO_BUILD_STAMP_MISS_REASON=toolchain-runtime
    return 1
  fi
  current_toolchain_hash=$(
    _paseo_build_stamp_toolchain_hash "$root" "$current_node_version" "$current_npm_version"
  ) || {
    PASEO_BUILD_STAMP_MISS_REASON=toolchain-inputs
    return 1
  }
  if [[ "$stamp_toolchain_hash" != "$current_toolchain_hash" ]]; then
    PASEO_BUILD_STAMP_MISS_REASON=toolchain-inputs
    return 1
  fi
  current_dependency_hash=$(_paseo_build_stamp_dependency_hash "$root") || {
    PASEO_BUILD_STAMP_MISS_REASON=dependency-inputs
    return 1
  }
  if [[ "$stamp_dependency_hash" != "$current_dependency_hash" ]]; then
    PASEO_BUILD_STAMP_MISS_REASON=dependency-inputs
    return 1
  fi
  current_output_hash=$(_paseo_build_stamp_output_hash "$root") || {
    PASEO_BUILD_STAMP_MISS_REASON=dist-outputs
    return 1
  }
  if [[ "$stamp_output_hash" != "$current_output_hash" ]]; then
    PASEO_BUILD_STAMP_MISS_REASON=dist-outputs
    return 1
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  printf '%s\n' 'build-paseo-state.sh is a shell library and must be sourced.' >&2
  exit 2
fi
