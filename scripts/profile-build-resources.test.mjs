import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "dwyanewang", "profile-build-resources.sh");
const fixture = mkdtempSync(path.join(tmpdir(), "paseo-profile-build-resources-"));

function run(...args) {
  return spawnSync("bash", [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, PROFILE_TEST_TOKEN: "preserved" },
    timeout: 20_000,
  });
}

function readSummary(label) {
  const entries = readFileSync(path.join(fixture, `${label}.summary`), "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    });
  return new Map(entries);
}

try {
  let result = run("--label", "INVALID", "--output-dir", fixture, "--", "true");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--label must match/);

  result = run("--label", "missing-command", "--output-dir", fixture, "--");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /a command is required/);

  const systemdReady = spawnSync("systemctl", ["--user", "show-environment"], {
    stdio: "ignore",
  });
  if (systemdReady.status !== 0) {
    console.log("profile-build-resources: systemd integration skipped; user manager unavailable");
    process.exit(0);
  }

  result = run(
    "--label",
    "successful",
    "--output-dir",
    fixture,
    "--interval",
    "0.05",
    "--",
    "bash",
    "-c",
    'test "$PROFILE_TEST_TOKEN" = preserved && test "$PWD" = "$1" && sleep 0.2',
    "profile-test",
    repoRoot,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Resource profile:/);

  const successful = readSummary("successful");
  assert.equal(successful.get("exit_status"), "0");
  assert.ok(Number(successful.get("command_runtime_microseconds")) > 0);
  assert.ok(Number(successful.get("cgroup_cpu_time_microseconds")) >= 0);
  assert.ok(Number(successful.get("memory_peak_bytes")) > 0);
  assert.ok(Number(successful.get("sample_count")) > 0);
  assert.match(successful.get("average_cpu_cores"), /^\d+[.]\d{3}$/);
  assert.match(successful.get("host_cpu_percent"), /^\d+[.]\d{3}$/);
  assert.match(successful.get("peak_sampled_cpu_cores"), /^\d+[.]\d{3}$/);
  assert.match(
    readFileSync(path.join(fixture, "successful.samples.tsv"), "utf8"),
    /^timestamp\telapsed_seconds\tcpu_cores\thost_cpu_percent\t/,
  );

  result = run(
    "--label",
    "failed",
    "--output-dir",
    fixture,
    "--interval",
    "0.05",
    "--",
    "bash",
    "-c",
    "exit 7",
  );
  assert.equal(result.status, 7, result.stderr);
  assert.equal(readSummary("failed").get("exit_status"), "7");

  result = run("--label", "successful", "--output-dir", fixture, "--", "true");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to overwrite an existing profile/);

  console.log("profile-build-resources: 8 checks passed");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
