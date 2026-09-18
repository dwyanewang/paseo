import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const helper = fileURLToPath(new URL("../dwyanewang/build-paseo-state.sh", import.meta.url));
const hash = (value) => createHash("sha256").update(value).digest("hex");

test("manual request events cannot be redirected by the artifact stage-log output variable", () => {
  withInventory((root) => {
    const requestLog = path.join(root, "request.log");
    const artifactLog = path.join(root, "artifact.log");
    writeFileSync(requestLog, "request start\n");
    writeFileSync(artifactLog, "artifact start\n");
    const result = spawnSync(
      "bash",
      ["-c", 'source "$1"; paseo_build_stage review:end', "stage", helper],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PASEO_BUILD_REQUEST_STAGE_LOG: requestLog,
          PASEO_BUILD_STAGE_LOG: artifactLog,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(requestLog, "utf8"), `request start\n${result.stdout}`);
    assert.equal(readFileSync(artifactLog, "utf8"), "artifact start\n");
  });
});

function withInventory(callback) {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-stamp-inventory-"));
  try {
    const entries = [];
    for (const workspace of ["highlight", "relay", "protocol", "client", "server", "cli"]) {
      const dir = `packages/${workspace}/dist`;
      mkdirSync(path.join(root, dir), { recursive: true });
      for (const name of ["git-remote.js", "git.js", "index.js"]) {
        const relative = `${dir}/${name}`;
        writeFileSync(path.join(root, relative), relative);
        chmodSync(path.join(root, relative), 0o644);
        entries.push([relative, "file", "644", hash(relative)]);
      }
      if (workspace === "server") {
        const relative = `${dir}/server/server/exports.js`;
        mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
        writeFileSync(path.join(root, relative), "server");
        chmodSync(path.join(root, relative), 0o755);
        entries.push([relative, "file", "755", hash("server")]);
      }
    }
    // Keep workspace order; within each workspace the inventory uses byte order.
    const expected = hash(entries.map((entry) => `${entry.join("\0")}\0`).join(""));
    callback(root, expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function outputHash(root, env) {
  const result = spawnSync(
    "bash",
    ["-c", 'source "$1"; _paseo_build_stamp_output_hash "$2"', "hash", helper, root],
    {
      env: { ...process.env, ...env },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("dist digests use byte ordering regardless of the caller's locale", () => {
  withInventory((root, expected) => {
    assert.equal(outputHash(root, { LC_ALL: "C" }), expected);
    assert.equal(outputHash(root, { LC_ALL: "zh_CN.UTF-8" }), expected);
  });
});

test("inventory hashes preserve file mode and symlink identity without following the link", () => {
  withInventory((root) => {
    const relative = "packages/cli/dist/link.js";
    symlinkSync("missing-target", path.join(root, relative));
    const result = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; _paseo_build_stamp_hash_inventory "$2" "$3"',
        "hash",
        helper,
        root,
        relative,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout.trim(),
      hash(`${relative}\0symlink\0${(0o777).toString(8)}\0${hash("missing-target")}\0`),
    );
    const before = outputHash(root, { LC_ALL: "C" });
    chmodSync(path.join(root, "packages/cli/dist/index.js"), 0o755);
    assert.notEqual(outputHash(root, { LC_ALL: "C" }), before);
  });
});

test("inventory rejects contaminated hash output without emitting a usable digest", () => {
  withInventory((root) => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
      source "$1"
      node() { command node "$@"; printf 'unexpected stdout\\n'; }
      _paseo_build_stamp_hash_inventory "$2" packages/cli/dist/index.js
    `,
        "hash",
        helper,
        root,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /invalid inventory digest/i);
  });
});

test.each([
  ["target\n", "target"],
  ["target\n\n", "target"],
  ["\n", ""],
])("symlink target %j retains the v1 trailing-LF digest", (target, legacyTarget) => {
  withInventory((root) => {
    const relative = "packages/cli/dist/link with\nnewline.js";
    symlinkSync(target, path.join(root, relative));
    const result = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; _paseo_build_stamp_hash_inventory "$2" "$3"',
        "hash",
        helper,
        root,
        relative,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const record = [relative, "symlink", "777", hash(legacyTarget), ""].join("\0");
    assert.equal(result.stdout.trim(), hash(record));
  });
});

test("inventory path lists larger than ARG_MAX do not travel through argv", () => {
  withInventory((root) => {
    const relative = `packages/cli/dist/${"x".repeat(230)}`;
    symlinkSync("target", path.join(root, relative));
    const count = 12000;
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
      ulimit -s 8192
      source "$1"
      files=()
      for ((i = 0; i < $4; i++)); do files+=("$3"); done
      _paseo_build_stamp_hash_inventory "$2" "\${files[@]}"
    `,
        "hash",
        helper,
        root,
        relative,
        String(count),
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const record = [relative, "symlink", "777", hash("target"), ""].join("\0");
    assert.equal(result.stdout.trim(), hash(record.repeat(count)));
  });
}, 30_000);

test("Expo module preflight accepts tracked iOS-only and scoped modules", () => {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-expo-modules-"));
  try {
    mkdirSync(path.join(root, "packages/app/modules/@scope/ios-only"), { recursive: true });
    writeFileSync(
      path.join(root, "packages/app/modules/@scope/ios-only/package.json"),
      '{"name":"@scope/ios-only","version":"1.0.0"}\n',
    );
    mkdirSync(path.join(root, "packages/app/modules/.stale"), { recursive: true });
    writeFileSync(path.join(root, "packages/app/modules/.stale/package.json"), "not json\n");
    symlinkSync("@scope/ios-only", path.join(root, "packages/app/modules/ios-only-link"));
    const init = spawnSync("git", ["init", "-b", "main", root], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    spawnSync("git", ["-C", root, "config", "user.name", "Test User"]);
    spawnSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
    spawnSync("git", ["-C", root, "add", "."]);
    const commit = spawnSync("git", ["-C", root, "commit", "-m", "module"], { encoding: "utf8" });
    assert.equal(commit.status, 0, commit.stderr);
    const result = spawnSync(
      "bash",
      ["-c", 'source "$1"; paseo_check_expo_modules "$2"', "modules", helper, root],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OK packages\/app\/modules\/@scope\/ios-only/);
    assert.match(result.stdout, /OK packages\/app\/modules\/ios-only-link/);
    assert.doesNotMatch(result.stderr, /\.stale/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Expo module preflight rejects ignored remnants and never removes them", () => {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-expo-stale-"));
  try {
    mkdirSync(path.join(root, "packages/app/modules/paseo-word-stream"), { recursive: true });
    writeFileSync(
      path.join(root, "packages/app/modules/paseo-word-stream/package.json"),
      '{"name":"paseo-word-stream","version":"0.0.0"}\n',
    );
    writeFileSync(path.join(root, ".gitignore"), "packages/app/modules/paseo-word-stream/\n");
    spawnSync("git", ["init", "-b", "main", root]);
    const result = spawnSync(
      "bash",
      ["-c", 'source "$1"; paseo_check_expo_modules "$2"', "modules", helper, root],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /rejected untracked\/ignored module/);
    assert.equal(
      existsSync(path.join(root, "packages/app/modules/paseo-word-stream/package.json")),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact run state distinguishes ready, failed, live, and abandoned attempts", () => {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-run-state-"));
  let child;
  try {
    writeFileSync(
      path.join(root, "result.env"),
      `paseo_artifact_build_status=ready\npaseo_artifact_build_run_dir=${root}\n`,
    );
    writeFileSync(path.join(root, "exit-status"), "0\n");
    let state = spawnSync(
      "bash",
      ["-c", 'source "$1"; paseo_artifact_run_state "$2"', "state", helper, root],
      { encoding: "utf8" },
    );
    assert.equal(state.status, 0);
    assert.equal(state.stdout.trim(), "ready");
    rmSync(path.join(root, "result.env"));
    writeFileSync(path.join(root, "exit-status"), "7\n");
    state = spawnSync(
      "bash",
      ["-c", 'source "$1"; paseo_artifact_run_state "$2"', "state", helper, root],
      { encoding: "utf8" },
    );
    assert.equal(state.stdout.trim(), "failed");
    rmSync(path.join(root, "exit-status"));
    child = spawn("bash", ["-c", "exec -a build-paseo-artifacts.sh sleep 5"], {
      stdio: "ignore",
    });
    const ticks = spawnSync(
      "bash",
      ["-c", 'source "$1"; paseo_pid_start_ticks "$2"', "state", helper, String(child.pid)],
      { encoding: "utf8" },
    ).stdout.trim();
    writeFileSync(
      path.join(root, "pid.env"),
      `paseo_artifact_pid=${child.pid}\npaseo_artifact_pid_start_ticks=${ticks}\npaseo_artifact_pid_command=build-paseo-artifacts.sh\n`,
    );
    state = spawnSync(
      "bash",
      ["-c", 'source "$1"; paseo_artifact_run_state "$2"', "state", helper, root],
      { encoding: "utf8" },
    );
    assert.equal(state.stdout.trim(), "running");
    child.kill("SIGTERM");
    child = undefined;
    state = spawnSync(
      "bash",
      ["-c", 'source "$1"; paseo_artifact_run_state "$2"', "state", helper, root],
      { encoding: "utf8" },
    );
    assert.equal(state.stdout.trim(), "abandoned");
  } finally {
    child?.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }
});

test("low-output wait helper reports a terminal state once", () => {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-wait-helper-"));
  try {
    writeFileSync(
      path.join(root, "result.env"),
      `paseo_artifact_build_status=ready\npaseo_artifact_build_run_dir=${root}\n`,
    );
    writeFileSync(path.join(root, "exit-status"), "0\n");
    const result = spawnSync(
      "bash",
      ["-c", 'source "$1"; paseo_wait_for_artifact_run "$2" 1', "wait", helper, root],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /wait: ready/);
    assert.equal(result.stdout.trim().split("\n").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wait helper tolerates a missing run directory during detached startup", () => {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-wait-starting-"));
  const runDir = path.join(root, "attempt");
  let creator;
  try {
    creator = spawn(
      "bash",
      [
        "-c",
        'sleep 1; mkdir -p "$1"; printf "paseo_artifact_build_status=ready\\npaseo_artifact_build_run_dir=%s\\n" "$1" >"$1/result.env"; printf "0\\n" >"$1/exit-status"',
        "creator",
        runDir,
      ],
      { stdio: "ignore" },
    );
    const result = spawnSync(
      "bash",
      ["-c", 'source "$1"; paseo_wait_for_artifact_run "$2" 1 3', "wait", helper, runDir],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal((result.stdout.match(/build-paseo wait: starting/g) ?? []).length, 1);
    assert.equal((result.stdout.match(/build-paseo wait: ready/g) ?? []).length, 1);
  } finally {
    creator?.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }
});

test("wait helper reports an invalid missing run directory abandoned once", () => {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-wait-abandoned-"));
  const runDir = path.join(root, "never-started");
  try {
    const result = spawnSync(
      "bash",
      ["-c", 'source "$1"; paseo_wait_for_artifact_run "$2" 1 1', "wait", helper, runDir],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.equal((result.stdout.match(/build-paseo wait: starting/g) ?? []).length, 1);
    assert.equal((result.stdout.match(/build-paseo wait: abandoned/g) ?? []).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("heartbeat cleanup only records MCP deletion confirmation", () => {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-heartbeat-cleanup-"));
  try {
    writeFileSync(
      path.join(root, "heartbeat.env"),
      "paseo_artifact_heartbeat_id=fixture-heartbeat\npaseo_artifact_heartbeat_status=created\npaseo_artifact_heartbeat_cleaned=0\n",
    );
    let result = spawnSync(
      "bash",
      ["-c", 'source "$1"; paseo_cleanup_artifact_heartbeat "$2"', "cleanup", helper, root],
      { encoding: "utf8", env: { ...process.env, PASEO_ARTIFACT_HEARTBEAT_DELETE_CONFIRMED: "" } },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /first delete the heartbeat through the owning agent MCP tool/);
    assert.match(readFileSync(path.join(root, "heartbeat.env"), "utf8"), /status=created/);

    result = spawnSync(
      "bash",
      ["-c", 'source "$1"; paseo_cleanup_artifact_heartbeat "$2"', "cleanup", helper, root],
      {
        encoding: "utf8",
        env: { ...process.env, PASEO_ARTIFACT_HEARTBEAT_DELETE_CONFIRMED: "1" },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(path.join(root, "heartbeat.env"), "utf8"), /status=cleaned/);
    assert.match(readFileSync(path.join(root, "heartbeat.env"), "utf8"), /cleaned=1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("heartbeat prompt contract does not require a PID before launch", () => {
  const skill = readFileSync(
    path.join(path.dirname(helper), "skills/build-paseo/SKILL.md"),
    "utf8",
  );
  const flow = readFileSync(path.join(path.dirname(helper), "打包流程.md"), "utf8");
  for (const document of [skill, flow]) {
    assert.match(document, /PID (?:会写入|will be written to) `?pid\.env/);
    assert.match(document, /尚不知道真实后台 PID|尚不知道后台编排 PID|does not require a real PID/);
  }
});
