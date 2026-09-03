#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

function fail(message) {
  console.error(`prepare-patched-dependencies: ${message}`);
  process.exit(1);
}

function usage() {
  console.log(`Usage:
  node dwyanewang/prepare-patched-dependencies.mjs validate --root PATH
  node dwyanewang/prepare-patched-dependencies.mjs prepare --root PATH \\
    --old-ref REF --new-ref REF --state-file PATH
  node dwyanewang/prepare-patched-dependencies.mjs verify --root PATH \\
    [--state-file PATH]
  node dwyanewang/prepare-patched-dependencies.mjs check-install-log --log PATH`);
}

class LiteralParser {
  constructor(source, start) {
    this.source = source;
    this.offset = start;
  }

  error(message) {
    throw new Error(`${message} at byte ${this.offset}`);
  }

  skipTrivia() {
    while (this.offset < this.source.length) {
      if (/\s/.test(this.source[this.offset])) {
        this.offset += 1;
        continue;
      }
      if (this.source.startsWith("//", this.offset)) {
        const newline = this.source.indexOf("\n", this.offset + 2);
        this.offset = newline === -1 ? this.source.length : newline + 1;
        continue;
      }
      if (this.source.startsWith("/*", this.offset)) {
        const end = this.source.indexOf("*/", this.offset + 2);
        if (end === -1) this.error("unterminated block comment");
        this.offset = end + 2;
        continue;
      }
      break;
    }
  }

  consume(character) {
    this.skipTrivia();
    if (this.source[this.offset] !== character) {
      this.error(`expected ${JSON.stringify(character)}`);
    }
    this.offset += 1;
  }

  maybeConsume(character) {
    this.skipTrivia();
    if (this.source[this.offset] !== character) return false;
    this.offset += 1;
    return true;
  }

  parseString() {
    this.skipTrivia();
    const quote = this.source[this.offset];
    if (quote !== '"') this.error("expected a JSON-style double-quoted string literal");
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.source.length) {
      const character = this.source[this.offset];
      if (character === "\\") {
        this.offset += 2;
        continue;
      }
      this.offset += 1;
      if (character === quote) {
        const literal = this.source.slice(start, this.offset);
        return JSON.parse(literal);
      }
      if (character === "\n" || character === "\r") {
        this.error("newline in string literal");
      }
    }
    this.error("unterminated string literal");
  }

  parseKey() {
    this.skipTrivia();
    if (this.source[this.offset] === '"') {
      return this.parseString();
    }
    const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.source.slice(this.offset));
    if (!match) this.error("expected an object key");
    this.offset += match[0].length;
    return match[0];
  }

  parseObject() {
    this.consume("{");
    const value = {};
    if (this.maybeConsume("}")) return value;
    while (true) {
      const key = this.parseKey();
      if (Object.hasOwn(value, key)) this.error(`duplicate object key ${key}`);
      this.consume(":");
      value[key] = this.parseString();
      if (this.maybeConsume("}")) return value;
      this.consume(",");
      if (this.maybeConsume("}")) return value;
    }
  }

  parseArray() {
    this.consume("[");
    const value = [];
    if (this.maybeConsume("]")) return value;
    while (true) {
      value.push(this.parseObject());
      if (this.maybeConsume("]")) return value;
      this.consume(",");
      if (this.maybeConsume("]")) return value;
    }
  }
}

function parseRegistry(source) {
  const declaration = /\b(?:const|let|var)\s+patchedPackages\s*=\s*/g;
  const matches = [...source.matchAll(declaration)];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one patchedPackages declaration, found ${matches.length}`);
  }
  const parser = new LiteralParser(source, matches[0].index + matches[0][0].length);
  return parser.parseArray();
}

function normalizeRelative(value, label, { allowDot = false } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")) {
    throw new Error(`${label} must be a non-empty POSIX relative path`);
  }
  const normalized = path.posix.normalize(value);
  if (path.posix.isAbsolute(value) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} escapes the product root: ${value}`);
  }
  if (!allowDot && normalized === ".") throw new Error(`${label} may not be .`);
  return normalized;
}

function normalizeRegistry(parsed, { allowDuplicateRegistrations = false } = {}) {
  const registrations = parsed.map((entry, index) => {
    const extraKeys = Object.keys(entry).filter(
      (key) => !["cwd", "nodeModulesPath", "patchPrefix"].includes(key),
    );
    if (extraKeys.length > 0) {
      throw new Error(`registration ${index + 1} has unsupported keys: ${extraKeys.join(", ")}`);
    }
    const cwd = normalizeRelative(entry.cwd ?? ".", `registration ${index + 1} cwd`, {
      allowDot: true,
    });
    const nodeModulesPath = normalizeRelative(
      entry.nodeModulesPath,
      `registration ${index + 1} nodeModulesPath`,
    );
    if (
      typeof entry.patchPrefix !== "string" ||
      entry.patchPrefix.length === 0 ||
      entry.patchPrefix.includes("/") ||
      entry.patchPrefix.includes("\\")
    ) {
      throw new Error(`registration ${index + 1} patchPrefix must be a non-empty filename prefix`);
    }
    const relativeTarget = path.posix.relative(cwd, nodeModulesPath);
    if (!relativeTarget.startsWith("node_modules/")) {
      throw new Error(
        `registration ${index + 1} nodeModulesPath must be inside ${cwd}/node_modules`,
      );
    }
    const packageSegments = relativeTarget.slice("node_modules/".length).split("/");
    const isPackageRoot =
      packageSegments.length === 1 ||
      (packageSegments.length === 2 && packageSegments[0].startsWith("@"));
    if (!isPackageRoot || packageSegments.some((segment) => segment.length === 0)) {
      throw new Error(`registration ${index + 1} nodeModulesPath must name one package root`);
    }
    return { cwd, nodeModulesPath, patchPrefix: entry.patchPrefix };
  });

  const seen = new Set();
  const uniqueRegistrations = [];
  for (const registration of registrations) {
    const key = `${registration.cwd}\0${registration.nodeModulesPath}\0${registration.patchPrefix}`;
    if (seen.has(key)) {
      if (!allowDuplicateRegistrations) {
        throw new Error(
          `duplicate patch registration: cwd=${registration.cwd}, nodeModulesPath=${registration.nodeModulesPath}, patchPrefix=${registration.patchPrefix}`,
        );
      }
    }
    seen.add(key);
    uniqueRegistrations.push(registration);
  }
  return uniqueRegistrations;
}

function readRegistry(root) {
  const registryPath = path.join(root, "scripts", "postinstall-patches.mjs");
  if (!existsSync(registryPath)) {
    throw new Error("missing scripts/postinstall-patches.mjs");
  }
  return normalizeRegistry(parseRegistry(readFileSync(registryPath, "utf8")));
}

function resolveCommit(root, ref) {
  const result = spawnSync(
    "git",
    ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  if (result.status !== 0) throw new Error(`not a commit: ${ref}`);
  return result.stdout.trim();
}

function readRegistryAtCommit(root, commit) {
  const registryPath = "scripts/postinstall-patches.mjs";
  const fileCheck = spawnSync("git", ["cat-file", "-e", `${commit}:${registryPath}`], {
    cwd: root,
    encoding: "utf8",
  });
  if (fileCheck.status !== 0) return [];
  const result = spawnSync("git", ["show", `${commit}:${registryPath}`], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`could not read ${registryPath} from ${commit}: ${result.stderr.trim()}`);
  }
  return normalizeRegistry(parseRegistry(result.stdout), { allowDuplicateRegistrations: true });
}

function registrationKey(registration) {
  return `${registration.cwd}\0${registration.nodeModulesPath}\0${registration.patchPrefix}`;
}

function registrationCounts(registrations) {
  const counts = new Map();
  for (const registration of registrations) {
    const key = registrationKey(registration);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function changedRegistrationKeys(oldRegistrations, newRegistrations) {
  const oldCounts = registrationCounts(oldRegistrations);
  const newCounts = registrationCounts(newRegistrations);
  const keys = new Set([...oldCounts.keys(), ...newCounts.keys()]);
  return new Set([...keys].filter((key) => oldCounts.get(key) !== newCounts.get(key)));
}

function patchTargets(source, patchFile) {
  const targets = [];
  for (const line of source.split(/\r?\n/)) {
    const match = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
    if (match) targets.push([match[1], match[2]]);
  }
  if (targets.length === 0) throw new Error(`${patchFile} has no diff --git targets`);
  return targets;
}

function targetBelongsToPackage(target, relativePackagePath) {
  return target === relativePackagePath || target.startsWith(`${relativePackagePath}/`);
}

function listPatchFiles(root) {
  const patchesPath = path.join(root, "patches");
  if (!existsSync(patchesPath)) return [];
  return readdirSync(patchesPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".patch"))
    .map((entry) => entry.name)
    .sort();
}

function matchingRegistrations(registrations, patchFile) {
  return registrations.filter(({ patchPrefix }) => patchFile.startsWith(patchPrefix));
}

function buildInventory(root) {
  const registrations = readRegistry(root);
  const assignments = [];
  const scheduled = new Set();
  for (const patchFile of listPatchFiles(root)) {
    const matches = matchingRegistrations(registrations, patchFile);
    if (matches.length === 0) {
      throw new Error(
        `patches/${patchFile} has no registration in scripts/postinstall-patches.mjs`,
      );
    }
    for (const registration of matches) {
      const scheduleKey = `${registration.cwd}\0${patchFile}`;
      if (scheduled.has(scheduleKey)) {
        throw new Error(
          `would apply patches/${patchFile} more than once from cwd ${registration.cwd}`,
        );
      }
      scheduled.add(scheduleKey);
      assignments.push({ patchFile, ...registration });
    }
  }

  for (const assignment of assignments) {
    const patchPath = path.join(root, "patches", assignment.patchFile);
    const relativePackagePath = path.posix.relative(assignment.cwd, assignment.nodeModulesPath);
    for (const [beforeTarget, afterTarget] of patchTargets(
      readFileSync(patchPath, "utf8"),
      `patches/${assignment.patchFile}`,
    )) {
      if (
        !targetBelongsToPackage(beforeTarget, relativePackagePath) ||
        !targetBelongsToPackage(afterTarget, relativePackagePath)
      ) {
        throw new Error(
          `patches/${assignment.patchFile} target is outside ${assignment.nodeModulesPath}: ${beforeTarget} -> ${afterTarget}`,
        );
      }
    }
  }
  return { assignments, registrations };
}

function changedPatchFiles(root, oldRef, newRef) {
  const result = spawnSync(
    "git",
    ["diff", "--name-only", "-z", "--no-renames", oldRef, newRef, "--", "patches"],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`git diff failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((file) => normalizeRelative(file, "changed patch path"))
    .map((file) => {
      if (!/^patches\/[^/]+\.patch$/.test(file)) {
        throw new Error(`unsupported changed path under patches/: ${file}`);
      }
      return file;
    });
}

function safeInstalledPackagePath(root, nodeModulesPath) {
  const normalized = normalizeRelative(nodeModulesPath, "installed package path");
  if (normalized !== nodeModulesPath) {
    throw new Error(`refusing to remove non-normalized path: ${nodeModulesPath}`);
  }
  const segments = normalized.split("/");
  const nodeModulesIndexes = segments
    .map((segment, index) => (segment === "node_modules" ? index : -1))
    .filter((index) => index !== -1);
  if (nodeModulesIndexes.length !== 1) {
    throw new Error(`refusing to remove non-package path: ${nodeModulesPath}`);
  }
  const packageSegments = segments.slice(nodeModulesIndexes[0] + 1);
  const isPackageRoot =
    packageSegments.length === 1 ||
    (packageSegments.length === 2 && packageSegments[0].startsWith("@"));
  if (!isPackageRoot || packageSegments.some((segment) => segment.length === 0)) {
    throw new Error(`refusing to remove non-package path: ${nodeModulesPath}`);
  }

  const absolute = path.resolve(root, normalized);
  const relative = path.relative(root, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`refusing to remove path outside product root: ${nodeModulesPath}`);
  }
  if (existsSync(absolute)) {
    const real = realpathSync(absolute);
    const realRelative = path.relative(root, real);
    if (realRelative === "" || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw new Error(`refusing to remove symlinked path outside product root: ${nodeModulesPath}`);
    }
  }
  return absolute;
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, file);
}

function prepare(root, oldRef, newRef, stateFile) {
  const { registrations } = buildInventory(root);
  const oldCommit = resolveCommit(root, oldRef);
  const newCommit = resolveCommit(root, newRef);
  const oldRegistrations = readRegistryAtCommit(root, oldCommit);
  const newRegistrations = readRegistryAtCommit(root, newCommit);
  if (changedRegistrationKeys(registrations, newRegistrations).size > 0) {
    throw new Error("working tree patch registry does not match --new-ref");
  }
  const changedKeys = changedRegistrationKeys(oldRegistrations, newRegistrations);
  const changedOldRegistrations = oldRegistrations.filter((registration) =>
    changedKeys.has(registrationKey(registration)),
  );
  const changedNewRegistrations = newRegistrations.filter((registration) =>
    changedKeys.has(registrationKey(registration)),
  );
  const newPackagePaths = new Set(
    newRegistrations.map((registration) => registration.nodeModulesPath),
  );
  const changed = changedPatchFiles(root, oldCommit, newCommit);
  const removals = new Set(newPackagePaths);
  const requiredPackages = new Set(newPackagePaths);

  for (const registration of changedOldRegistrations) {
    if (!newPackagePaths.has(registration.nodeModulesPath)) {
      removals.add(registration.nodeModulesPath);
    }
  }

  for (const changedPath of changed) {
    const patchFile = path.posix.basename(changedPath);
    const matchesByKey = new Map();
    for (const registration of [
      ...matchingRegistrations(oldRegistrations, patchFile),
      ...matchingRegistrations(newRegistrations, patchFile),
    ]) {
      matchesByKey.set(registrationKey(registration), registration);
    }
    const matches = [...matchesByKey.values()];
    if (matches.length === 0) {
      throw new Error(
        `${changedPath} has no registration in either old or candidate scripts/postinstall-patches.mjs`,
      );
    }
    const scheduled = new Set();
    for (const registration of matches) {
      const scheduleKey = `${registration.cwd}\0${patchFile}`;
      if (scheduled.has(scheduleKey)) {
        throw new Error(`cannot map ${changedPath} uniquely for cwd ${registration.cwd}`);
      }
      scheduled.add(scheduleKey);
      if (!newPackagePaths.has(registration.nodeModulesPath)) {
        removals.add(registration.nodeModulesPath);
      }
    }
  }

  for (const nodeModulesPath of [...removals].sort()) {
    const absolute = safeInstalledPackagePath(root, nodeModulesPath);
    if (!existsSync(absolute)) {
      console.log(
        `Patch refresh: ${nodeModulesPath} is not currently installed; no removal needed.`,
      );
      continue;
    }
    rmSync(absolute, { recursive: true, force: true });
    console.log(`Patch refresh: removed ${nodeModulesPath}.`);
  }

  writeJsonAtomic(stateFile, {
    changedPatchFiles: changed,
    changedRegistryRegistrationCount:
      changedOldRegistrations.length + changedNewRegistrations.length,
    refreshedPackagePaths: [...removals].sort(),
    requiredPackagePaths: [...requiredPackages].sort(),
  });
}

function verify(root, stateFile) {
  const { assignments } = buildInventory(root);
  let requiredPackages = new Set();
  if (stateFile) {
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    if (!Array.isArray(state.requiredPackagePaths)) {
      throw new Error("refresh state is missing requiredPackagePaths");
    }
    requiredPackages = new Set(state.requiredPackagePaths);
  }

  for (const requiredPackage of requiredPackages) {
    const absolute = safeInstalledPackagePath(root, requiredPackage);
    if (!existsSync(absolute)) {
      throw new Error(`npm install did not restore refreshed package ${requiredPackage}`);
    }
  }

  let verified = 0;
  for (const assignment of assignments) {
    const packagePath = safeInstalledPackagePath(root, assignment.nodeModulesPath);
    if (!existsSync(packagePath)) {
      throw new Error(
        `installed package for patches/${assignment.patchFile} is missing: ${assignment.nodeModulesPath}`,
      );
    }
    const patchPath = path.join(root, "patches", assignment.patchFile);
    const cwd = path.join(root, assignment.cwd);
    const gitResult = spawnSync("git", ["apply", "--reverse", "--check", patchPath], {
      cwd,
      encoding: "utf8",
    });
    if (gitResult.status !== 0) {
      const patchResult = spawnSync(
        "patch",
        ["--dry-run", "--reverse", "--batch", "-p1", "--input", patchPath],
        { cwd, encoding: "utf8" },
      );
      const patchOutput = `${patchResult.stdout ?? ""}\n${patchResult.stderr ?? ""}`;
      const patchRejectedReverse =
        /unreversed patch detected|ignoring -r|skipping patch|hunk .* failed|can't find file to patch|malformed patch/i.test(
          patchOutput,
        );
      if (patchResult.status !== 0 || patchRejectedReverse) {
        const gitDetail = gitResult.error
          ? `could not run git apply: ${gitResult.error.message}`
          : `${gitResult.stdout}\n${gitResult.stderr}`.trim() || `exit ${gitResult.status}`;
        const patchDetail = patchResult.error
          ? `could not run patch: ${patchResult.error.message}`
          : `${patchResult.stdout}\n${patchResult.stderr}`.trim() || `exit ${patchResult.status}`;
        throw new Error(
          `patches/${assignment.patchFile} is not applied to the installed dependency tree; git apply reverse-check failed: ${gitDetail}; patch reverse dry-run failed: ${patchDetail}`,
        );
      }
    }
    verified += 1;
  }
  console.log(`Patch verification passed for ${verified} installed patch application(s).`);
}

function checkInstallLog(logPath) {
  const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
  const log = readFileSync(logPath, "utf8").replace(ansiEscape, "");
  const failurePatterns = [
    /postinstall-patches:\s*patch-package failed/i,
    /\*\*ERROR\*\*\s*Failed to apply patch for package/i,
    /patch-package[^\n]*failed to apply patch/i,
    /Failed to apply patch file/i,
  ];
  if (failurePatterns.some((pattern) => pattern.test(log))) {
    throw new Error("npm install reported a patch application failure despite its final status");
  }
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    usage();
    process.exit(command ? 0 : 2);
  }
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      fail(`invalid arguments for ${command}`);
    }
    if (Object.hasOwn(values, flag)) fail(`${flag} may only be specified once`);
    values[flag] = value;
  }
  return { command, values };
}

try {
  const { command, values } = parseArguments(process.argv.slice(2));
  if (command === "check-install-log") {
    if (!values["--log"] || Object.keys(values).length !== 1) {
      fail("check-install-log requires only --log PATH");
    }
    checkInstallLog(values["--log"]);
    process.exit(0);
  }

  if (!values["--root"]) fail(`${command} requires --root PATH`);
  const root = realpathSync(values["--root"]);
  if (command === "validate") {
    if (Object.keys(values).length !== 1) fail("validate requires only --root PATH");
    const { assignments, registrations } = buildInventory(root);
    console.log(
      `Patch registry valid: ${registrations.length} registration(s), ${assignments.length} application(s).`,
    );
  } else if (command === "prepare") {
    for (const flag of ["--old-ref", "--new-ref", "--state-file"]) {
      if (!values[flag]) fail(`prepare requires ${flag}`);
    }
    if (Object.keys(values).length !== 4) fail("prepare received unknown arguments");
    prepare(root, values["--old-ref"], values["--new-ref"], values["--state-file"]);
  } else if (command === "verify") {
    if (Object.keys(values).some((flag) => !["--root", "--state-file"].includes(flag))) {
      fail("verify received unknown arguments");
    }
    verify(root, values["--state-file"]);
  } else {
    fail(`unknown command: ${command}`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
