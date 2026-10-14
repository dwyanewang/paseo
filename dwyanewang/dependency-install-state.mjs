import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const stateVersion = 1;
const benchmark = "node scripts/benchmark-validation-hermes.mjs";
// These self-contained patch installers do not read package scripts. Any new
// installer needs an audit before metadata-only installation reuse is allowed.
const reviewedPatchInstallers = new Set([
  "b2ea9b438c1dc8f303d04a16b5025edf01897467d4f41d236402b2a8b9380f08",
  "36755ff14172c1e02c443cb6e9b6a7d63418ce470f801f62e56d12efdda69c92",
]);
const lifecycleNames = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
  "dependencies",
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.keys(value)
    .sort()
    .map((key) => [key, canonical(value[key])]);
  return Object.fromEntries(entries);
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function fileDigest(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function json(file) {
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected a JSON object: ${file}`);
  }
  return value;
}

function command(root, executable, args) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) {
    // npm config output can contain private configuration: never echo it.
    throw new Error(`${executable} ${args[0]} failed while checking installation state`);
  }
  return result.stdout;
}

function safePath(root, relative) {
  const target = path.resolve(root, relative);
  if (!relative || target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`invalid package path: ${relative}`);
  }
  return target;
}

function localTarget(root, relative) {
  const target = realpathSync(safePath(root, relative));
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`local dependency leaves checkout: ${relative}`);
  }
  return target;
}

function normalizeManifest(relative, manifest, auditedHooks) {
  const copy = structuredClone(manifest);
  const isProtocol = relative === "packages/protocol/package.json";
  if (auditedHooks && isProtocol && copy.scripts?.["benchmark:hermes"] === benchmark) {
    delete copy.scripts["benchmark:hermes"];
    if (Object.keys(copy.scripts).length === 0) delete copy.scripts;
  }
  return copy;
}

function hooksAreAudited(root, manifests) {
  for (const [relative, manifest] of manifests) {
    for (const [name, script] of Object.entries(manifest.scripts ?? {})) {
      if (!lifecycleNames.has(name)) continue;
      if (relative !== "package.json") return false;
      if (name === "prepare" && script === "lefthook install --force") continue;
      if (name !== "postinstall" || script !== "node scripts/postinstall-patches.mjs") return false;
      const installer = path.join(root, "scripts/postinstall-patches.mjs");
      if (!existsSync(installer) || !reviewedPatchInstallers.has(fileDigest(installer)))
        return false;
    }
  }
  return true;
}

function inputState(root) {
  const files = command(root, "git", ["ls-files", "-z"]).split("\0").filter(Boolean).sort();
  const manifests = new Map();
  for (const relative of files) {
    if (path.basename(relative) === "package.json") {
      manifests.set(relative, json(safePath(root, relative)));
    }
  }
  if (!manifests.has("package.json")) throw new Error("root package.json is not tracked");
  const auditedHooks = hooksAreAudited(root, manifests);
  const inputs = {};
  for (const relative of files) {
    const basename = path.basename(relative);
    if (manifests.has(relative)) {
      inputs[relative] = normalizeManifest(relative, manifests.get(relative), auditedHooks);
    } else if (basename === "package-lock.json" || basename === "npm-shrinkwrap.json") {
      inputs[relative] = json(safePath(root, relative));
    } else if (
      !auditedHooks ||
      basename === ".npmrc" ||
      relative.startsWith("patches/") ||
      ["scripts/postinstall-patches.mjs", ".mise.toml", ".tool-versions", "lefthook.yml"].includes(
        relative,
      )
    ) {
      inputs[relative] = fileDigest(safePath(root, relative));
    }
  }
  // Local tarball contents can change without changing their manifest specifier.
  // Links are checked separately; archives outside this checkout cannot reuse.
  const localArchives = {};
  const lock = json(path.join(root, "package-lock.json"));
  for (const entry of Object.values(lock.packages ?? {})) {
    if (!entry.link && entry.resolved?.startsWith("file:")) {
      const relative = decodeURIComponent(entry.resolved.slice(5));
      localArchives[relative] = fileDigest(localTarget(root, relative));
    }
  }
  // Includes user/environment npm options without persisting or printing secrets.
  const npmConfig = JSON.parse(command(root, "npm", ["config", "list", "--json"]));
  const environment = {
    node: process.version,
    npm: command(root, "npm", ["--version"]).trim(),
    platform: process.platform,
    arch: process.arch,
    config: npmConfig,
  };
  return { hash: digest({ inputs, localArchives, environment }), auditedHooks };
}

function validateInstalledEntry({ root, relative, expected, auditedHooks }) {
  const directory = safePath(root, relative);
  const stat = lstatSync(directory);
  if (expected.link) {
    const target = localTarget(root, expected.resolved);
    if (!stat.isSymbolicLink() || realpathSync(directory) !== target) {
      throw new Error(`workspace link differs: ${relative}`);
    }
    const manifestPath = `${expected.resolved}/package.json`;
    const manifest = normalizeManifest(
      manifestPath,
      json(path.join(target, "package.json")),
      auditedHooks,
    );
    return { target: expected.resolved, manifest };
  }
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`package is not a directory: ${relative}`);
  const manifest = json(path.join(directory, "package.json"));
  if (expected.version && manifest.version !== expected.version)
    throw new Error(`installed version differs: ${relative}`);
  const bin = manifest.bin;
  const binFiles = typeof bin === "string" ? [bin] : Object.values(bin ?? {});
  for (const binFile of binFiles) {
    if (!existsSync(safePath(directory, binFile)))
      throw new Error(`installed executable is missing: ${relative}`);
  }
  return manifest;
}

function installedState(root, auditedHooks) {
  const lock = json(path.join(root, "package-lock.json"));
  const hidden = json(path.join(root, "node_modules/.package-lock.json"));
  if (lock.lockfileVersion < 2 || !lock.packages || !hidden.packages)
    throw new Error("installation lock inventory is missing");
  const installed = {};
  const executables = {};
  for (const [relative, expected] of Object.entries(lock.packages)) {
    if (!relative.includes("node_modules/")) continue;
    if (!hidden.packages[relative] && expected.optional) continue;
    const actual = hidden.packages[relative];
    if (!actual) throw new Error(`installed lock entry is missing: ${relative}`);
    for (const key of ["version", "resolved", "integrity", "link"]) {
      if (expected[key] !== actual[key])
        throw new Error(`installed lock entry differs: ${relative} (${key})`);
    }
    installed[relative] = validateInstalledEntry({ root, relative, expected, auditedHooks });
    const packageRoot = safePath(root, relative);
    const manifest = json(path.join(packageRoot, "package.json"));
    const bins =
      typeof manifest.bin === "string"
        ? { [manifest.name.split("/").at(-1)]: manifest.bin }
        : (manifest.bin ?? {});
    const modulesRoot = relative.slice(
      0,
      relative.lastIndexOf("node_modules/") + "node_modules".length,
    );
    for (const name of Object.keys(bins)) {
      const link = safePath(root, `${modulesRoot}/.bin/${name}`);
      const target = realpathSync(link);
      if (!target.startsWith(`${root}${path.sep}`))
        throw new Error(`installed executable leaves checkout: ${name}`);
      executables[path.relative(root, link)] = path.relative(root, target);
    }
  }
  const extras = Object.keys(hidden.packages).filter((relative) => !lock.packages[relative]);
  if (extras.length) throw new Error(`installed lock contains unexpected package: ${extras[0]}`);
  return digest({ hidden, installed, executables });
}

function stateFile(root) {
  const directory = path.join(root, ".dev");
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink())
    throw new Error("installation state directory is a symlink");
  return path.join(directory, "build-paseo-install.json");
}

function invalidate(root) {
  rmSync(stateFile(root), { force: true });
}

function record(root) {
  const file = stateFile(root);
  // Call only after npm succeeded, installed patches were verified, and the
  // checkout passed the install clean-tree check. Failed installs invalidate first.
  invalidate(root);
  const inputs = inputState(root);
  const installed = installedState(root, inputs.auditedHooks);
  const receipt = { version: stateVersion, root, inputs: inputs.hash, installed };
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  console.log("dependency-install: recorded verified installation");
}

function check(root) {
  const file = stateFile(root);
  if (!existsSync(file)) throw new Error("installation receipt is missing");
  if (lstatSync(file).isSymbolicLink()) throw new Error("installation receipt is a symlink");
  const receipt = json(file);
  if (receipt.version !== stateVersion || receipt.root !== root)
    throw new Error("installation receipt identity differs");
  const inputs = inputState(root);
  if (receipt.inputs !== inputs.hash) throw new Error("installation inputs changed");
  if (receipt.installed !== installedState(root, inputs.auditedHooks))
    throw new Error("installed package inventory changed");
  console.log("dependency-install: reuse verified installation");
}

const { values, positionals } = parseArgs({
  options: { root: { type: "string" } },
  allowPositionals: true,
});
const [action] = positionals;
if (
  !values.root ||
  positionals.length !== 1 ||
  !["check", "record", "invalidate"].includes(action)
) {
  console.error("Usage: node dependency-install-state.mjs check|record|invalidate --root PATH");
  process.exit(2);
}
try {
  const root = realpathSync(values.root);
  if (action === "check") check(root);
  else if (action === "record") record(root);
  else invalidate(root);
} catch (error) {
  console.error(`dependency-install: ${error.message}`);
  process.exit(action === "check" ? 3 : 1);
}
