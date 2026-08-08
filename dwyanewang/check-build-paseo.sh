#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: bash dwyanewang/check-build-paseo.sh

Run the fast build-paseo control-plane checks: validate every dwyanewang Shell
script, then run the focused orchestration test files. This does not build
real server, Android, or Windows artifacts and does not touch the main daemon.
EOF
}

if (($# > 0)); then
  case "$1" in
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
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null) || {
  printf '%s\n' 'check-build-paseo: script is not inside a Git worktree' >&2
  exit 1
}
repo_root=$(realpath -e -- "$repo_root")

vitest_files=(
  scripts/build-paseo-artifacts.test.mjs
  scripts/prepare-rw-main-for-build.test.mjs
  scripts/rw-main-review-gate.test.mjs
)
node_test_files=(
  scripts/configure-android-build.test.mjs
  scripts/profile-build-resources.test.mjs
  scripts/serve-dist.test.mjs
)

mapfile -t shell_scripts < <(find "$script_dir" -maxdepth 1 -type f -name '*.sh' -print | sort)
((${#shell_scripts[@]} > 0)) || {
  printf '%s\n' 'check-build-paseo: no control-plane Shell scripts found' >&2
  exit 1
}

paseo_check_started=$(date +%s)
printf 'build-paseo self-check: validating %d Shell scripts\n' "${#shell_scripts[@]}"
for shell_script in "${shell_scripts[@]}"; do
  bash -n "$shell_script"
done

command -v node >/dev/null && command -v npx >/dev/null || {
  printf '%s\n' 'check-build-paseo: node and npx are required to run focused tests' >&2
  exit 1
}

test_file_count=$((${#vitest_files[@]} + ${#node_test_files[@]}))
printf 'build-paseo self-check: running %d focused test files\n' "$test_file_count"
for test_file in "${vitest_files[@]}"; do
  [[ -f "$repo_root/$test_file" ]] || {
    printf 'check-build-paseo: missing test file: %s\n' "$test_file" >&2
    exit 1
  }
  printf '\n[%s]\n' "$test_file"
  (cd "$repo_root" && npx vitest run "$test_file" --bail=1 --testTimeout=15000)
done
for test_file in "${node_test_files[@]}"; do
  [[ -f "$repo_root/$test_file" ]] || {
    printf 'check-build-paseo: missing test file: %s\n' "$test_file" >&2
    exit 1
  }
  printf '\n[%s]\n' "$test_file"
  node "$repo_root/$test_file"
done

paseo_check_elapsed=$(($(date +%s) - paseo_check_started))
printf '\nbuild-paseo self-check: PASS (%d Shell scripts, %d test files, %ds)\n' \
  "${#shell_scripts[@]}" "$test_file_count" "$paseo_check_elapsed"
