import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

function readProfileUnitName(label) {
  const transcript = readFileSync(path.join(fixture, `${label}.transcript.log`), "utf8");
  const match = transcript.match(/^Running as unit: ([^;\s]+)(?:;|$)/m);
  assert.ok(match, `missing transient unit name in ${label} transcript`);
  return match[1];
}

function unitIsUnloaded(unitName) {
  const result = spawnSync(
    "systemctl",
    ["--user", "show", unitName, "--property=LoadState", "--value"],
    { encoding: "utf8" },
  );
  return result.status === 0 && result.stdout.trim() === "not-found";
}

function waitUntil(predicate, timeoutMs, message) {
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    Atomics.wait(waitBuffer, 0, 0, 20);
  }
  assert.equal(predicate(), true, message);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function killProcessGroupIfAlive(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
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
  assert.match(successful.get("systemd_run_exit_status"), /^\d+$/);
  assert.match(successful.get("systemd_cleanup_degraded"), /^[01]$/);
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
  const failedUnitName = readProfileUnitName("failed");
  waitUntil(
    () => unitIsUnloaded(failedUnitName),
    10_000,
    `failed transient unit ${failedUnitName} was not collected`,
  );

  const cleanupStartedAt = Date.now();
  result = run(
    "--label",
    "lingering-child",
    "--output-dir",
    fixture,
    "--interval",
    "0.05",
    "--",
    "bash",
    "-c",
    "sleep 30 </dev/null >/dev/null 2>&1 & exit 0",
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - cleanupStartedAt < 10_000, "cgroup cleanup exceeded 10 seconds");
  assert.equal(readSummary("lingering-child").get("exit_status"), "0");

  const failedCleanupStartedAt = Date.now();
  result = run(
    "--label",
    "failed-lingering-child",
    "--output-dir",
    fixture,
    "--interval",
    "0.05",
    "--",
    "bash",
    "-c",
    "sleep 30 </dev/null >/dev/null 2>&1 & exit 7",
  );
  assert.equal(result.status, 7, result.stderr);
  assert.ok(
    Date.now() - failedCleanupStartedAt < 10_000,
    "failed cgroup cleanup exceeded 10 seconds",
  );
  assert.equal(readSummary("failed-lingering-child").get("exit_status"), "7");

  const externalStopReady = path.join(fixture, "external-stop.ready");
  const externalStopChildPid = path.join(fixture, "external-stop-child.pid");
  const externallyStopped = spawn(
    "setsid",
    [
      "bash",
      script,
      "--label",
      "externally-stopped",
      "--output-dir",
      fixture,
      "--interval",
      "0.05",
      "--",
      "bash",
      "-c",
      'sleep 30 & child=$!; printf "%s\\n" "$child" >"$1"; : >"$2"; wait "$child"',
      "profile-external-stop",
      externalStopChildPid,
      externalStopReady,
    ],
    {
      cwd: repoRoot,
      detached: false,
      env: { ...process.env, PROFILE_TEST_TOKEN: "preserved" },
      stdio: "ignore",
    },
  );
  try {
    waitUntil(() => existsSync(externalStopReady), 10_000, "profile command did not start");
    const descendantPid = Number(readFileSync(externalStopChildPid, "utf8").trim());
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 1);
    externallyStopped.kill("SIGTERM");
    waitUntil(
      () => !processIsAlive(descendantPid),
      10_000,
      `profile descendant ${descendantPid} survived external termination`,
    );
    const externallyStoppedUnitName = readProfileUnitName("externally-stopped");
    waitUntil(
      () => unitIsUnloaded(externallyStoppedUnitName),
      10_000,
      `externally stopped transient unit ${externallyStoppedUnitName} was not collected`,
    );
  } finally {
    killProcessGroupIfAlive(externallyStopped.pid);
  }

  result = run("--label", "successful", "--output-dir", fixture, "--", "true");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to overwrite an existing profile/);

  console.log("profile-build-resources: 19 checks passed");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
