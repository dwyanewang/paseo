#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash dwyanewang/profile-build-resources.sh \
  --label NAME --output-dir PATH [--interval SECONDS] -- COMMAND [ARG...]

Run one build phase in its own transient systemd cgroup. The command keeps the
caller's working directory and exported environment. Its output remains live,
while cgroup-wide CPU, memory, swap, and process counts are sampled to a TSV.
The command's exit status is preserved.

  --label NAME         File/unit label: lowercase letters, numbers, and hyphens.
  --output-dir PATH    New profile files are written below this directory.
  --interval SECONDS   Sampling interval (default: 1; decimals are accepted).
EOF
}

fail() {
  printf 'profile-build-resources: %s\n' "$1" >&2
  exit "${2:-1}"
}

label=
output_dir_arg=
sample_interval=1
while (($# > 0)); do
  case "$1" in
    --label)
      (($# >= 2)) || fail "missing value for --label" 2
      [[ -z "$label" ]] || fail "--label may only be specified once" 2
      label=$2
      shift 2
      ;;
    --output-dir)
      (($# >= 2)) || fail "missing value for --output-dir" 2
      [[ -z "$output_dir_arg" ]] || fail "--output-dir may only be specified once" 2
      output_dir_arg=$2
      shift 2
      ;;
    --interval)
      (($# >= 2)) || fail "missing value for --interval" 2
      sample_interval=$2
      shift 2
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ "$label" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] ||
  fail "--label must match [a-z0-9][a-z0-9-]{0,39}: $label" 2
[[ -n "$output_dir_arg" ]] || fail "--output-dir is required" 2
(($# > 0)) || fail "a command is required after --" 2
[[ "$sample_interval" =~ ^([0-9]+([.][0-9]*)?|[.][0-9]+)$ ]] ||
  fail "--interval must be a positive number: $sample_interval" 2
awk -v interval="$sample_interval" 'BEGIN { exit !(interval > 0) }' ||
  fail "--interval must be greater than zero: $sample_interval" 2

for required_command in systemd-run systemctl systemd-analyze numfmt nproc realpath tee; do
  command -v "$required_command" >/dev/null || fail "required command is missing: $required_command"
done
[[ "$(stat -fc '%T' /sys/fs/cgroup 2>/dev/null)" == cgroup2fs ]] ||
  fail "cgroup v2 is required at /sys/fs/cgroup"
[[ -r /sys/fs/cgroup/cgroup.controllers ]] || fail "cannot read cgroup v2 controllers"
for controller in cpu memory pids; do
  grep -qw "$controller" /sys/fs/cgroup/cgroup.controllers ||
    fail "required cgroup controller is unavailable: $controller"
done
systemctl --user show-environment >/dev/null 2>&1 || fail "the user systemd manager is unavailable"

mkdir -p -- "$output_dir_arg"
output_dir=$(realpath -e -- "$output_dir_arg")
samples_file="$output_dir/$label.samples.tsv"
summary_file="$output_dir/$label.summary"
transcript_file="$output_dir/$label.transcript.log"
command_result_file="$output_dir/$label.command-result"
for output_file in "$samples_file" "$summary_file" "$transcript_file" "$command_result_file"; do
  [[ ! -e "$output_file" ]] || fail "refusing to overwrite an existing profile: $output_file"
done

run_stamp=$(date +%Y%m%d-%H%M%S)
unit_base="paseo-profile-$label-$run_stamp-$$"
unit_name="$unit_base.service"
core_count=$(nproc)
started_at=$(date --iso-8601=seconds)
start_ns=$(date +%s%N)
command_display=$(printf '%q ' "$@")
command_display=${command_display% }
sampling_grace_seconds=$(awk -v interval="$sample_interval" 'BEGIN { printf "%.3f", interval + 0.25 }')

printf '%s\n' \
  $'timestamp\telapsed_seconds\tcpu_cores\thost_cpu_percent\tmemory_current_bytes\tmemory_peak_bytes\tswap_current_bytes\tswap_peak_bytes\tpids_current\thost_mem_available_bytes' \
  >"$samples_file"

environment_args=()
while IFS= read -r environment_name; do
  [[ "$environment_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
  environment_args+=(--setenv="$environment_name")
done < <(compgen -e)

profile_wrapper=$(printf '%s\n' \
  'result_file=$1' \
  'grace_seconds=$2' \
  'shift 2' \
  'cgroup_path=$(/usr/bin/awk -F: "\$1 == \"0\" { print \$3; exit }" /proc/self/cgroup)' \
  'cgroup_dir=/sys/fs/cgroup$cgroup_path' \
  'cpu_started_usec=$(/usr/bin/awk "\$1 == \"usage_usec\" { print \$2; exit }" "$cgroup_dir/cpu.stat")' \
  'command_started_ns=$(/usr/bin/date +%s%N)' \
  'set +e' \
  '"$@"' \
  'command_status=$?' \
  'set -e' \
  'command_finished_ns=$(/usr/bin/date +%s%N)' \
  'cpu_finished_usec=$(/usr/bin/awk "\$1 == \"usage_usec\" { print \$2; exit }" "$cgroup_dir/cpu.stat")' \
  'IFS= read -r memory_peak_bytes <"$cgroup_dir/memory.peak"' \
  'IFS= read -r swap_peak_bytes <"$cgroup_dir/memory.swap.peak"' \
  '/usr/bin/printf "started_ns=%s\nfinished_ns=%s\nexit_status=%s\ncpu_started_usec=%s\ncpu_finished_usec=%s\nmemory_peak_bytes=%s\nswap_peak_bytes=%s\n" "$command_started_ns" "$command_finished_ns" "$command_status" "$cpu_started_usec" "$cpu_finished_usec" "$memory_peak_bytes" "$swap_peak_bytes" >"$result_file"' \
  '/usr/bin/sleep "$grace_seconds"' \
  'exit "$command_status"')

set +e
LC_ALL=C systemd-run \
  --user \
  --wait \
  --pipe \
  --same-dir \
  --expand-environment=no \
  --unit="$unit_base" \
  --property=CPUAccounting=yes \
  --property=MemoryAccounting=yes \
  --property=TasksAccounting=yes \
  "${environment_args[@]}" \
  -- /usr/bin/bash -c "$profile_wrapper" paseo-profile-command \
  "$command_result_file" "$sampling_grace_seconds" "$@" 2>&1 | tee "$transcript_file" &
profile_pipeline_pid=$!
set -e

control_group=
for ((attempt = 0; attempt < 200; attempt += 1)); do
  control_group=$(systemctl --user show "$unit_name" --property=ControlGroup --value 2>/dev/null || true)
  if [[ -n "$control_group" && -d "/sys/fs/cgroup$control_group" ]]; then
    break
  fi
  kill -0 "$profile_pipeline_pid" 2>/dev/null || break
  sleep 0.05
done

if [[ -z "$control_group" || ! -d "/sys/fs/cgroup$control_group" ]]; then
  if kill -0 "$profile_pipeline_pid" 2>/dev/null; then
    systemctl --user stop "$unit_name" >/dev/null 2>&1 || true
  fi
  profile_status=0
  wait "$profile_pipeline_pid" || profile_status=$?
  fail "could not locate the transient cgroup for $unit_name (command status $profile_status)"
fi

cgroup_dir="/sys/fs/cgroup$control_group"
profile_active=1
cleanup_profile() {
  if ((profile_active)); then
    profile_active=0
    systemctl --user stop "$unit_name" >/dev/null 2>&1 || true
    wait "$profile_pipeline_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup_profile EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

previous_time_ns=
previous_cpu_usage_usec=
sample_count=0
minimum_host_mem_available_bytes=
peak_sampled_cpu_cores=0.000
peak_sampled_host_cpu_percent=0.000

read_cgroup_value() {
  local path=$1
  local fallback=${2:-0}
  if [[ -r "$path" ]]; then
    read -r value <"$path"
    printf '%s\n' "$value"
  else
    printf '%s\n' "$fallback"
  fi
}

read_cpu_usage_usec() {
  if [[ -r "$cgroup_dir/cpu.stat" ]]; then
    awk '$1 == "usage_usec" { print $2; found = 1; exit } END { if (!found) print 0 }' \
      "$cgroup_dir/cpu.stat" 2>/dev/null || printf '0\n'
  else
    printf '0\n'
  fi
}

record_sample() {
  local now_ns elapsed_seconds cpu_usage_usec cpu_cores host_cpu_percent
  local memory_current_bytes memory_peak_bytes swap_current_bytes swap_peak_bytes
  local pids_current host_mem_available_bytes

  now_ns=$(date +%s%N)
  elapsed_seconds=$(awk -v now="$now_ns" -v start="$start_ns" 'BEGIN { printf "%.3f", (now - start) / 1000000000 }')
  cpu_usage_usec=$(read_cpu_usage_usec)
  cpu_cores=0.000
  host_cpu_percent=0.000
  if [[ -n "$previous_time_ns" && -n "$previous_cpu_usage_usec" ]]; then
    read -r cpu_cores host_cpu_percent < <(
      awk \
        -v current="$cpu_usage_usec" \
        -v previous="$previous_cpu_usage_usec" \
        -v now="$now_ns" \
        -v before="$previous_time_ns" \
        -v cores="$core_count" \
        'BEGIN {
          elapsed_usec = (now - before) / 1000
          used_cores = elapsed_usec > 0 ? (current - previous) / elapsed_usec : 0
          if (used_cores < 0) used_cores = 0
          printf "%.3f %.3f\n", used_cores, used_cores * 100 / cores
        }'
    )
  fi

  memory_current_bytes=$(read_cgroup_value "$cgroup_dir/memory.current")
  memory_peak_bytes=$(read_cgroup_value "$cgroup_dir/memory.peak")
  swap_current_bytes=$(read_cgroup_value "$cgroup_dir/memory.swap.current")
  swap_peak_bytes=$(read_cgroup_value "$cgroup_dir/memory.swap.peak")
  pids_current=$(read_cgroup_value "$cgroup_dir/pids.current")
  host_mem_available_bytes=$(awk '$1 == "MemAvailable:" { printf "%.0f\n", $2 * 1024; exit }' /proc/meminfo)

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$(date --iso-8601=seconds)" \
    "$elapsed_seconds" \
    "$cpu_cores" \
    "$host_cpu_percent" \
    "$memory_current_bytes" \
    "$memory_peak_bytes" \
    "$swap_current_bytes" \
    "$swap_peak_bytes" \
    "$pids_current" \
    "$host_mem_available_bytes" \
    >>"$samples_file"

  previous_time_ns=$now_ns
  previous_cpu_usage_usec=$cpu_usage_usec
  sample_count=$((sample_count + 1))
  if awk -v current="$cpu_cores" -v peak="$peak_sampled_cpu_cores" \
    'BEGIN { exit !(current > peak) }'; then
    peak_sampled_cpu_cores=$cpu_cores
    peak_sampled_host_cpu_percent=$host_cpu_percent
  fi
  if [[ -z "$minimum_host_mem_available_bytes" ]] ||
    ((host_mem_available_bytes < minimum_host_mem_available_bytes)); then
    minimum_host_mem_available_bytes=$host_mem_available_bytes
  fi
}

while [[ -r "$cgroup_dir/cpu.stat" ]]; do
  record_sample
  kill -0 "$profile_pipeline_pid" 2>/dev/null || break
  sleep "$sample_interval"
done

command_status=0
wait "$profile_pipeline_pid" || command_status=$?
profile_active=0
trap - EXIT INT TERM
finished_at=$(date --iso-8601=seconds)
finish_ns=$(date +%s%N)
wall_seconds=$(awk -v finish="$finish_ns" -v start="$start_ns" 'BEGIN { printf "%.3f", (finish - start) / 1000000000 }')

runtime_text=$(sed -n 's/^Service runtime: //p' "$transcript_file" | tail -n 1)
cpu_time_text=$(sed -n 's/^CPU time consumed: //p' "$transcript_file" | tail -n 1)
memory_peak_text=$(sed -n 's/^Memory peak: //p' "$transcript_file" | tail -n 1)
swap_peak_text=$(sed -n 's/^Memory swap peak: //p' "$transcript_file" | tail -n 1)

timespan_to_microseconds() {
  local timespan=$1
  systemd-analyze timespan "$timespan" | sed -n '2{s/.*:[[:space:]]*//;p;}'
}

size_to_bytes() {
  local size=$1
  if [[ "$size" == 0B ]]; then
    printf '0\n'
  else
    numfmt --from=iec "$size"
  fi
}

profile_status=0
for metric in "$runtime_text" "$cpu_time_text" "$memory_peak_text" "$swap_peak_text"; do
  [[ -n "$metric" ]] || profile_status=1
done

runtime_usec=
systemd_cpu_time_usec=
command_started_ns=
command_finished_ns=
recorded_command_status=
command_cpu_started_usec=
command_cpu_finished_usec=
command_cpu_time_usec=
recorded_memory_peak_bytes=
recorded_swap_peak_bytes=
command_runtime_usec=
command_wall_seconds=
average_cores=
host_cpu_percent=
if ((profile_status == 0)); then
  runtime_usec=$(timespan_to_microseconds "$runtime_text") || profile_status=1
  systemd_cpu_time_usec=$(timespan_to_microseconds "$cpu_time_text") || profile_status=1
  size_to_bytes "$memory_peak_text" >/dev/null || profile_status=1
  size_to_bytes "$swap_peak_text" >/dev/null || profile_status=1
fi

if [[ -f "$command_result_file" ]]; then
  command_started_ns=$(sed -n 's/^started_ns=//p' "$command_result_file")
  command_finished_ns=$(sed -n 's/^finished_ns=//p' "$command_result_file")
  recorded_command_status=$(sed -n 's/^exit_status=//p' "$command_result_file")
  command_cpu_started_usec=$(sed -n 's/^cpu_started_usec=//p' "$command_result_file")
  command_cpu_finished_usec=$(sed -n 's/^cpu_finished_usec=//p' "$command_result_file")
  recorded_memory_peak_bytes=$(sed -n 's/^memory_peak_bytes=//p' "$command_result_file")
  recorded_swap_peak_bytes=$(sed -n 's/^swap_peak_bytes=//p' "$command_result_file")
else
  profile_status=1
fi
if [[ "$command_started_ns" =~ ^[0-9]+$ && "$command_finished_ns" =~ ^[0-9]+$ ]] &&
  ((command_finished_ns >= command_started_ns)); then
  command_runtime_usec=$(((command_finished_ns - command_started_ns) / 1000))
  command_wall_seconds=$(awk -v runtime="$command_runtime_usec" 'BEGIN { printf "%.3f", runtime / 1000000 }')
else
  profile_status=1
fi
[[ "$recorded_command_status" == "$command_status" ]] || profile_status=1
if [[ "$command_cpu_started_usec" =~ ^[0-9]+$ && "$command_cpu_finished_usec" =~ ^[0-9]+$ ]] &&
  ((command_cpu_finished_usec >= command_cpu_started_usec)); then
  command_cpu_time_usec=$((command_cpu_finished_usec - command_cpu_started_usec))
else
  profile_status=1
fi
[[ "$recorded_memory_peak_bytes" =~ ^[0-9]+$ ]] || profile_status=1
[[ "$recorded_swap_peak_bytes" =~ ^[0-9]+$ ]] || profile_status=1

if ((profile_status == 0)) && ((command_runtime_usec > 0)) && ((sample_count > 0)); then
  read -r average_cores host_cpu_percent < <(
    awk -v cpu="$command_cpu_time_usec" -v runtime="$command_runtime_usec" -v cores="$core_count" \
      'BEGIN {
        average = cpu / runtime
        printf "%.3f %.3f\n", average, average * 100 / cores
      }'
  )
else
  profile_status=1
fi

minimum_host_mem_available_bytes=${minimum_host_mem_available_bytes:-unknown}
{
  printf 'label=%s\n' "$label"
  printf 'unit=%s\n' "$unit_name"
  printf 'started_at=%s\n' "$started_at"
  printf 'finished_at=%s\n' "$finished_at"
  printf 'exit_status=%s\n' "$command_status"
  printf 'wall_seconds=%s\n' "$wall_seconds"
  printf 'command_wall_seconds=%s\n' "${command_wall_seconds:-unknown}"
  printf 'command_runtime_microseconds=%s\n' "${command_runtime_usec:-unknown}"
  printf 'service_runtime=%s\n' "${runtime_text:-unknown}"
  printf 'service_runtime_microseconds=%s\n' "${runtime_usec:-unknown}"
  printf 'systemd_cpu_time=%s\n' "${cpu_time_text:-unknown}"
  printf 'systemd_cpu_time_microseconds=%s\n' "${systemd_cpu_time_usec:-unknown}"
  printf 'cgroup_cpu_time_microseconds=%s\n' "${command_cpu_time_usec:-unknown}"
  printf 'average_cpu_cores=%s\n' "${average_cores:-unknown}"
  printf 'host_cpu_percent=%s\n' "${host_cpu_percent:-unknown}"
  printf 'peak_sampled_cpu_cores=%s\n' "$peak_sampled_cpu_cores"
  printf 'peak_sampled_host_cpu_percent=%s\n' "$peak_sampled_host_cpu_percent"
  printf 'logical_cpu_count=%s\n' "$core_count"
  printf 'memory_peak=%s\n' "${memory_peak_text:-unknown}"
  printf 'memory_peak_bytes=%s\n' "${recorded_memory_peak_bytes:-unknown}"
  printf 'swap_peak=%s\n' "${swap_peak_text:-unknown}"
  printf 'swap_peak_bytes=%s\n' "${recorded_swap_peak_bytes:-unknown}"
  printf 'minimum_host_mem_available_bytes=%s\n' "$minimum_host_mem_available_bytes"
  printf 'sample_count=%s\n' "$sample_count"
  printf 'samples_file=%s\n' "$samples_file"
  printf 'transcript_file=%s\n' "$transcript_file"
  printf 'command=%s\n' "$command_display"
} >"$summary_file"

printf 'Resource profile: %s\n' "$summary_file"
if ((command_status != 0)); then
  exit "$command_status"
fi
((profile_status == 0)) || fail "command succeeded, but the systemd resource summary was incomplete"
