import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    bundle: { type: "string" },
    out: { type: "string" },
    hermes: { type: "string" },
    runs: { type: "string", default: "3" },
    "cache-note": { type: "string" },
  },
});
if (!values.bundle || !values.out || !values["cache-note"]) {
  throw new Error(
    "Usage: npm run benchmark:hermes -- --bundle /path/android.js --out /new/results --cache-note 'Metro cold, compiler input fixed' [--runs 3] [--hermes /path/hermesc]",
  );
}
if (process.platform !== "linux")
  throw new Error("This compiler RSS benchmark requires Linux and GNU /usr/bin/time");
const count = Number(values.runs);
if (!Number.isInteger(count) || count < 1 || count > 10)
  throw new Error("--runs must be an integer from 1 to 10");
const require = createRequire(import.meta.url);
const compiler = values.hermes
  ? resolve(values.hermes)
  : resolve(
      dirname(require.resolve("react-native/package.json")),
      "sdks/hermesc/linux64-bin/hermesc",
    );
const bundle = resolve(values.bundle);
const output = resolve(values.out);

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

const version = await run(compiler, ["-version"]);
if (version.code !== 0) throw new Error(`Hermes version failed: ${version.stderr}`);
const revision = await run("git", ["rev-parse", "HEAD"]);
const npmVersion = await run("npm", ["--version"]);
await mkdir(output); // Refuse to overwrite an earlier cohort or its bytecode.
const report = {
  startedAt: new Date().toISOString(),
  scope:
    "Hermes compiler process maximum RSS; not the full Metro/Gradle cgroup peak or runtime performance",
  nodeVersion: process.version,
  npmVersion: npmVersion.stdout.trim(),
  sourceHead: revision.stdout.trim(),
  compiler: { path: compiler, version: version.stdout.trim(), sha256: await sha256(compiler) },
  input: { path: bundle, bytes: (await stat(bundle)).size, sha256: await sha256(bundle) },
  flags: ["-O", "-emit-binary"],
  cacheNote: values["cache-note"],
  runs: [],
};
for (let index = 1; index <= count; index++) {
  const bytecode = resolve(output, `run-${index}.hbc`);
  const metrics = resolve(output, `run-${index}.time`);
  const result = await run("/usr/bin/time", [
    "-f",
    "%M\n%e\n%x",
    "-o",
    metrics,
    compiler,
    "-O",
    "-emit-binary",
    "-out",
    bytecode,
    bundle,
  ]);
  await writeFile(resolve(output, `run-${index}.log`), result.stdout + result.stderr);
  const lines = (await readFile(metrics, "utf8")).trim().split("\n").slice(-3);
  const record = {
    index,
    exitCode: result.code,
    signal: result.signal,
    maximumRssKiB: Number(lines[0]),
    elapsedSeconds: Number(lines[1]),
    bytecodeBytes: result.code === 0 ? (await stat(bytecode)).size : null,
  };
  report.runs.push(record);
  await writeFile(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.info(JSON.stringify(record));
  if (result.code !== 0) throw new Error(`Hermes failed; see ${output}/run-${index}.log`);
}
