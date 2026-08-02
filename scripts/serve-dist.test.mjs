import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "dwyanewang", "serve-dist.sh");
const root = mkdtempSync(path.join(tmpdir(), "paseo-serve-dist-"));
const version = "1.2.3-beta.4";
const apk = path.join(root, "packages/app/android/app/build/outputs/apk/release/app-release.apk");
const zip = path.join(root, `packages/desktop/release/Paseo-Setup-${version}-x64.zip`);
const state = path.join(root, ".dev/serve-dist/server.state");
const env = { ...process.env, PASEO_BUILD_ROOT: root, PASEO_SKIP_TAILSCALE: "1" };

function run(args) {
  return spawnSync("bash", [script, ...args], { encoding: "utf8", env });
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

mkdirSync(path.dirname(apk), { recursive: true });
mkdirSync(path.dirname(zip), { recursive: true });
writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
writeFileSync(apk, "old-apk");
writeFileSync(zip, "old-zip");

try {
  let result = run(["6767", "60"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /主 daemon/);

  const injectionMarker = path.join(root, "injected");
  result = run([`8800;touch ${injectionMarker}`, "60"]);
  assert.equal(result.status, 1);
  assert.equal(existsSync(injectionMarker), false);

  result = run(["prepare-build"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(apk), false);
  assert.equal(existsSync(zip), false);

  writeFileSync(apk, "new-apk");
  writeFileSync(path.join(path.dirname(zip), "Paseo-Setup-9.9.9-x64.zip"), "wrong-zip");
  result = run(["8800", "60"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /找不到本轮 Windows zip/);

  writeFileSync(zip, "stale-zip");
  const staleTime = new Date(0);
  utimesSync(apk, staleTime, staleTime);
  utimesSync(zip, staleTime, staleTime);
  result = run(["8800", "60"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /早于本轮构建标记/);

  await new Promise((resolve) => setTimeout(resolve, 20));
  writeFileSync(apk, "new-apk");
  writeFileSync(zip, "new-zip");

  const unrelated = createServer();
  const occupiedPort = await listen(unrelated);
  result = run([String(occupiedPort), "60"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /其他进程占用/);
  assert.equal(unrelated.listening, true);
  assert.equal(existsSync(state), false);

  result = run(["stop"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(unrelated.listening, true);
  await close(unrelated);

  const reservation = createServer();
  const managedPort = await listen(reservation);
  await close(reservation);

  result = run([String(managedPort), "60"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /已启动并确认监听/);
  const firstPid = readFileSync(state, "utf8").split(" ")[0];

  writeFileSync(apk, "refreshed-apk");
  result = run(["keep", String(managedPort), "60"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(readFileSync(state, "utf8").split(" ")[0], firstPid);
  const response = await fetch(`http://127.0.0.1:${managedPort}/paseo-android-${version}.apk`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "refreshed-apk");

  result = run(["stop"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(state), false);

  console.log("serve-dist: 10 checks passed");
} finally {
  run(["stop"]);
  rmSync(root, { recursive: true, force: true });
}
