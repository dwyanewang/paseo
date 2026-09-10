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
