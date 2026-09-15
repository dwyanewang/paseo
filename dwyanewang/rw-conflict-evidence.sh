#!/usr/bin/env bash

# Shared, side-effect-free conflict evidence helpers for rebuild and rw-base
# lifecycle operations. Callers own operation state and user-facing errors.

paseo_blob_is_supported_text() {
  local root=$1 blob=$2 temp status=0
  temp=$(mktemp "${TMPDIR:-/tmp}/paseo-conflict-blob.XXXXXX")
  if ! git -C "$root" cat-file blob "$blob" >"$temp"; then
    rm -f -- "$temp"
    return 1
  fi
  if [[ -s "$temp" ]] && ! LC_ALL=C grep -Iq . "$temp"; then
    status=1
  fi
  rm -f -- "$temp"
  return "$status"
}

paseo_conflict_upstream_commits() {
  local root=$1 range_start=$2 range_end=$3 path=$4
  git -C "$root" log --follow --format=%H "$range_start..$range_end" -- "$path"
}

paseo_patch_targets_from_blob() {
  local root=$1 blob=$2
  git -C "$root" cat-file blob "$blob" |
    sed -n 's|^diff --git a/.* b/||p' |
    LC_ALL=C sort -u
}

paseo_patch_changes_from_blob_target() {
  local root=$1 blob=$2 target=$3
  git -C "$root" cat-file blob "$blob" |
    awk -v wanted="$target" '
      /^diff --git / {
        suffix = " b/" wanted
        in_target = length($0) >= length(suffix) && \
          substr($0, length($0) - length(suffix) + 1) == suffix
        in_hunk = 0
        next
      }
      in_target && /^@@/ { in_hunk = 1; next }
      in_target && in_hunk && !/^\+\+\+ / && !/^--- / && /^[+-]/ { print }
    '
}

paseo_validate_add_add_patch_resolution() {
  local root=$1 index_file=$2 resolved_tree=$3 metadata path mode blob stage extra
  local resolved_entry resolved_blob side target change
  local -a paths=() required_targets=() resolved_targets=() required_changes=() resolved_changes=()
  local -A seen_paths=() stage1_blobs=() stage2_blobs=() stage3_blobs=()
  local -A resolved_target_set=() resolved_change_set=()

  while IFS=$'\t' read -r metadata path || [[ -n "$metadata$path" ]]; do
    [[ -n "$metadata" ]] || continue
    read -r mode blob stage extra <<<"$metadata"
    [[ -z "${extra:-}" ]] || return 1
    if [[ -z "${seen_paths[$path]+present}" ]]; then
      paths+=("$path")
      seen_paths[$path]=1
    fi
    case "$stage" in
      1) stage1_blobs[$path]=$blob ;;
      2) stage2_blobs[$path]=$blob ;;
      3) stage3_blobs[$path]=$blob ;;
      *) return 1 ;;
    esac
  done <"$index_file"

  for path in "${paths[@]}"; do
    [[ "$path" == *.patch && -z "${stage1_blobs[$path]:-}" &&
      -n "${stage2_blobs[$path]:-}" && -n "${stage3_blobs[$path]:-}" ]] || continue
    resolved_entry=$(git -C "$root" ls-tree "$resolved_tree" -- "$path")
    [[ -n "$resolved_entry" ]] || {
      printf 'resolved conflict drops add/add patch file: %s\n' "$path" >&2
      return 1
    }
    resolved_blob=${resolved_entry#* blob }
    resolved_blob=${resolved_blob%%$'\t'*}
    mapfile -t resolved_targets < <(paseo_patch_targets_from_blob "$root" "$resolved_blob")
    resolved_target_set=()
    for target in "${resolved_targets[@]}"; do resolved_target_set["$target"]=1; done
    for side in 2 3; do
      if [[ "$side" == 2 ]]; then blob=${stage2_blobs[$path]}; else blob=${stage3_blobs[$path]}; fi
      mapfile -t required_targets < <(paseo_patch_targets_from_blob "$root" "$blob")
      ((${#required_targets[@]} > 0)) || {
        printf 'cannot identify diff targets in conflict stage %s for %s\n' "$side" "$path" >&2
        return 1
      }
      for target in "${required_targets[@]}"; do
        [[ -n "${resolved_target_set[$target]+present}" ]] || {
          printf 'conflict resolution for %s drops patch target from stage %s: %s\n' "$path" "$side" "$target" >&2
          return 1
        }
        mapfile -t required_changes < <(paseo_patch_changes_from_blob_target "$root" "$blob" "$target")
        mapfile -t resolved_changes < <(paseo_patch_changes_from_blob_target "$root" "$resolved_blob" "$target")
        resolved_change_set=()
        for change in "${resolved_changes[@]}"; do resolved_change_set["$change"]=1; done
        for change in "${required_changes[@]}"; do
          [[ -n "${resolved_change_set[$change]+present}" ]] || {
            printf 'conflict resolution for %s drops patch change from stage %s target %s: %s\n' \
              "$path" "$side" "$target" "$change" >&2
            return 1
          }
        done
      done
    done
  done
}
