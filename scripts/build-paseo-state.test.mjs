import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
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
