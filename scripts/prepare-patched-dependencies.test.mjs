import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helper = path.join(repoRoot, "dwyanewang", "prepare-patched-dependencies.mjs");
const fixtures = [];

function run(root, ...args) {
  return spawnSync("node", [helper, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function createFixture(registrations) {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-patched-dependencies-"));
  fixtures.push(root);
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "patches"), { recursive: true });
  writeFileSync(
    path.join(root, "scripts", "postinstall-patches.mjs"),
    `const patchedPackages = ${registrations};\n`,
  );
  return root;
}

function fixturePatch(before = "old", after = "new") {
  return `diff --git a/node_modules/example/value.txt b/node_modules/example/value.txt
--- a/node_modules/example/value.txt
+++ b/node_modules/example/value.txt
@@ -1 +1 @@
-${before}
+${after}
`;
}

try {
  const duplicateRegistration = createFixture(`[
    { nodeModulesPath: "node_modules/example", patchPrefix: "example+" },
    { nodeModulesPath: "node_modules/example", patchPrefix: "example+" },
  ]`);
  writeFileSync(path.join(duplicateRegistration, "patches", "example+1.0.0.patch"), fixturePatch());
  let result = run(duplicateRegistration, "validate", "--root", duplicateRegistration);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /duplicate patch registration/);

  const duplicateApplication = createFixture(`[
    { nodeModulesPath: "node_modules/example", patchPrefix: "example+" },
    { nodeModulesPath: "node_modules/example-copy", patchPrefix: "example+" },
  ]`);
  writeFileSync(path.join(duplicateApplication, "patches", "example+1.0.0.patch"), fixturePatch());
  result = run(duplicateApplication, "validate", "--root", duplicateApplication);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /would apply patches\/example\+1\.0\.0\.patch more than once from cwd/,
  );

  const repairedDuplicate = createFixture(`[
    { nodeModulesPath: "node_modules/example", patchPrefix: "example+" },
    { nodeModulesPath: "node_modules/example", patchPrefix: "example+" },
  ]`);
  git(repairedDuplicate, "init", "-b", "main");
  git(repairedDuplicate, "config", "user.name", "Test User");
  git(repairedDuplicate, "config", "user.email", "test@example.com");
  writeFileSync(path.join(repairedDuplicate, "patches", "example+1.0.0.patch"), fixturePatch());
  git(repairedDuplicate, "add", ".");
  git(repairedDuplicate, "commit", "-m", "duplicate registration");
  const repairedDuplicateOldRef = git(repairedDuplicate, "rev-parse", "HEAD");
  writeFileSync(
    path.join(repairedDuplicate, "scripts", "postinstall-patches.mjs"),
    `const patchedPackages = [
      { nodeModulesPath: "node_modules/example", patchPrefix: "example+" },
    ];\n`,
  );
  git(repairedDuplicate, "add", "scripts/postinstall-patches.mjs");
  git(repairedDuplicate, "commit", "-m", "deduplicate registration");
  mkdirSync(path.join(repairedDuplicate, "node_modules", "example"), { recursive: true });
  writeFileSync(path.join(repairedDuplicate, "node_modules", "example", "value.txt"), "new\n");
  const repairedDuplicateState = path.join(repairedDuplicate, "state.json");
  result = run(
    repairedDuplicate,
    "prepare",
    "--root",
    repairedDuplicate,
    "--old-ref",
    repairedDuplicateOldRef,
    "--new-ref",
    "HEAD",
    "--state-file",
    repairedDuplicateState,
  );
  assert.equal(result.status, 0, result.stderr);
  const repairedDuplicateResult = JSON.parse(readFileSync(repairedDuplicateState, "utf8"));
  assert.equal(repairedDuplicateResult.changedRegistryRegistrationCount, 3);
  assert.deepEqual(repairedDuplicateResult.refreshedPackagePaths, ["node_modules/example"]);
  assert.deepEqual(repairedDuplicateResult.requiredPackagePaths, ["node_modules/example"]);
  assert.equal(existsSync(path.join(repairedDuplicate, "node_modules", "example")), false);

  const refresh = createFixture(`[
    { nodeModulesPath: "node_modules/example", patchPrefix: "example+" },
  ]`);
  git(refresh, "init", "-b", "main");
  git(refresh, "config", "user.name", "Test User");
  git(refresh, "config", "user.email", "test@example.com");
  writeFileSync(path.join(refresh, "patches", "example+1.0.0.patch"), fixturePatch("old", "first"));
  git(refresh, "add", ".");
  git(refresh, "commit", "-m", "initial patch");
  const oldRef = git(refresh, "rev-parse", "HEAD");
  writeFileSync(path.join(refresh, "patches", "example+1.0.0.patch"), fixturePatch());
  git(refresh, "add", "patches/example+1.0.0.patch");
  git(refresh, "commit", "-m", "update patch");
  const newRef = git(refresh, "rev-parse", "HEAD");
  mkdirSync(path.join(refresh, "node_modules", "example"), { recursive: true });
  mkdirSync(path.join(refresh, "node_modules", "unrelated"), { recursive: true });
  writeFileSync(path.join(refresh, "node_modules", "example", "value.txt"), "first\n");
  writeFileSync(path.join(refresh, "node_modules", "unrelated", "keep.txt"), "keep\n");
  const stateFile = path.join(refresh, "refresh-state.json");
  result = run(
    refresh,
    "prepare",
    "--root",
    refresh,
    "--old-ref",
    oldRef,
    "--new-ref",
    newRef,
    "--state-file",
    stateFile,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /removed node_modules\/example/);
  assert.equal(
    readFileSync(path.join(refresh, "node_modules", "unrelated", "keep.txt"), "utf8"),
    "keep\n",
  );
  assert.equal(
    JSON.parse(readFileSync(stateFile, "utf8")).changedPatchFiles[0],
    "patches/example+1.0.0.patch",
  );
  assert.equal(existsSync(path.join(refresh, "node_modules", "example")), false);

  mkdirSync(path.join(refresh, "node_modules", "example"), { recursive: true });
  writeFileSync(path.join(refresh, "node_modules", "example", "value.txt"), "new\n");
  result = run(refresh, "verify", "--root", refresh, "--state-file", stateFile);
  assert.equal(result.status, 0, result.stderr);
  rmSync(path.join(refresh, "node_modules", "example"), { force: true, recursive: true });
  result = run(refresh, "verify", "--root", refresh);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /installed package .* is missing: node_modules\/example/);
  mkdirSync(path.join(refresh, "node_modules", "example"), { recursive: true });
  writeFileSync(path.join(refresh, "node_modules", "example", "value.txt"), "old\n");
  result = run(refresh, "verify", "--root", refresh, "--state-file", stateFile);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is not applied to the installed dependency tree/);

  const registryMove = createFixture(`[
    { nodeModulesPath: "node_modules/example", patchPrefix: "example+" },
  ]`);
  git(registryMove, "init", "-b", "main");
  git(registryMove, "config", "user.name", "Test User");
  git(registryMove, "config", "user.email", "test@example.com");
  writeFileSync(path.join(registryMove, "patches", "example+1.0.0.patch"), fixturePatch());
  git(registryMove, "add", ".");
  git(registryMove, "commit", "-m", "root patch registration");
  const registryMoveOldRef = git(registryMove, "rev-parse", "HEAD");
  writeFileSync(
    path.join(registryMove, "scripts", "postinstall-patches.mjs"),
    `const patchedPackages = [
      {
        nodeModulesPath: "packages/app/node_modules/example",
        patchPrefix: "example+",
        cwd: "packages/app",
      },
    ];\n`,
  );
  git(registryMove, "add", "scripts/postinstall-patches.mjs");
  git(registryMove, "commit", "-m", "move patch registration into app workspace");
  mkdirSync(path.join(registryMove, "node_modules", "example"), { recursive: true });
  mkdirSync(path.join(registryMove, "packages", "app", "node_modules", "example"), {
    recursive: true,
  });
  mkdirSync(path.join(registryMove, "node_modules", "unrelated"), { recursive: true });
  writeFileSync(path.join(registryMove, "node_modules", "example", "value.txt"), "new\n");
  writeFileSync(
    path.join(registryMove, "packages", "app", "node_modules", "example", "value.txt"),
    "new\n",
  );
  writeFileSync(path.join(registryMove, "node_modules", "unrelated", "keep.txt"), "keep\n");
  const registryMoveState = path.join(registryMove, "registry-move-state.json");
  result = run(
    registryMove,
    "prepare",
    "--root",
    registryMove,
    "--old-ref",
    registryMoveOldRef,
    "--new-ref",
    "HEAD",
    "--state-file",
    registryMoveState,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(path.join(registryMove, "node_modules", "example")), false);
  assert.equal(
    existsSync(path.join(registryMove, "packages", "app", "node_modules", "example")),
    false,
  );
  assert.equal(
    readFileSync(path.join(registryMove, "node_modules", "unrelated", "keep.txt"), "utf8"),
    "keep\n",
  );
  const registryMoveResult = JSON.parse(readFileSync(registryMoveState, "utf8"));
  assert.equal(registryMoveResult.changedRegistryRegistrationCount, 2);
  assert.deepEqual(registryMoveResult.refreshedPackagePaths, [
    "node_modules/example",
    "packages/app/node_modules/example",
  ]);
  assert.deepEqual(registryMoveResult.requiredPackagePaths, ["packages/app/node_modules/example"]);

  const removedDependency = createFixture(`[
    { nodeModulesPath: "node_modules/example", patchPrefix: "example+" },
  ]`);
  git(removedDependency, "init", "-b", "main");
  git(removedDependency, "config", "user.name", "Test User");
  git(removedDependency, "config", "user.email", "test@example.com");
  writeFileSync(path.join(removedDependency, "patches", "example+1.0.0.patch"), fixturePatch());
  git(removedDependency, "add", ".");
  git(removedDependency, "commit", "-m", "add patched dependency");
  const removedDependencyOldRef = git(removedDependency, "rev-parse", "HEAD");
  git(removedDependency, "rm", "patches/example+1.0.0.patch");
  writeFileSync(
    path.join(removedDependency, "scripts", "postinstall-patches.mjs"),
    "const patchedPackages = [];\n",
  );
  git(removedDependency, "add", "scripts/postinstall-patches.mjs");
  git(removedDependency, "commit", "-m", "remove patched dependency");
  mkdirSync(path.join(removedDependency, "node_modules", "example"), { recursive: true });
  writeFileSync(path.join(removedDependency, "node_modules", "example", "value.txt"), "new\n");
  const removedDependencyState = path.join(removedDependency, "state.json");
  result = run(
    removedDependency,
    "prepare",
    "--root",
    removedDependency,
    "--old-ref",
    removedDependencyOldRef,
    "--new-ref",
    "HEAD",
    "--state-file",
    removedDependencyState,
  );
  assert.equal(result.status, 0, result.stderr);
  const removedDependencyResult = JSON.parse(readFileSync(removedDependencyState, "utf8"));
  assert.deepEqual(removedDependencyResult.changedPatchFiles, ["patches/example+1.0.0.patch"]);
  assert.deepEqual(removedDependencyResult.refreshedPackagePaths, ["node_modules/example"]);
  assert.deepEqual(removedDependencyResult.requiredPackagePaths, []);
  assert.equal(existsSync(path.join(removedDependency, "node_modules", "example")), false);
  result = run(
    removedDependency,
    "verify",
    "--root",
    removedDependency,
    "--state-file",
    removedDependencyState,
  );
  assert.equal(result.status, 0, result.stderr);

  const deletedPatch = createFixture(`[
    { nodeModulesPath: "node_modules/example", patchPrefix: "example+" },
  ]`);
  git(deletedPatch, "init", "-b", "main");
  git(deletedPatch, "config", "user.name", "Test User");
  git(deletedPatch, "config", "user.email", "test@example.com");
  writeFileSync(path.join(deletedPatch, "patches", "example+1.0.0.patch"), fixturePatch());
  git(deletedPatch, "add", ".");
  git(deletedPatch, "commit", "-m", "add patch");
  const deletedPatchOldRef = git(deletedPatch, "rev-parse", "HEAD");
  git(deletedPatch, "rm", "patches/example+1.0.0.patch");
  git(deletedPatch, "commit", "-m", "remove patch");
  mkdirSync(path.join(deletedPatch, "node_modules", "example"), { recursive: true });
  writeFileSync(path.join(deletedPatch, "node_modules", "example", "value.txt"), "new\n");
  const deletedPatchState = path.join(deletedPatch, "state.json");
  result = run(
    deletedPatch,
    "prepare",
    "--root",
    deletedPatch,
    "--old-ref",
    deletedPatchOldRef,
    "--new-ref",
    "HEAD",
    "--state-file",
    deletedPatchState,
  );
  assert.equal(result.status, 0, result.stderr);
  const deletedPatchResult = JSON.parse(readFileSync(deletedPatchState, "utf8"));
  assert.deepEqual(deletedPatchResult.changedPatchFiles, ["patches/example+1.0.0.patch"]);
  assert.deepEqual(deletedPatchResult.refreshedPackagePaths, ["node_modules/example"]);
  assert.deepEqual(deletedPatchResult.requiredPackagePaths, ["node_modules/example"]);
  assert.equal(existsSync(path.join(deletedPatch, "node_modules", "example")), false);

  const renamedPatch = createFixture(`[
    { nodeModulesPath: "node_modules/example", patchPrefix: "example+" },
  ]`);
  git(renamedPatch, "init", "-b", "main");
  git(renamedPatch, "config", "user.name", "Test User");
  git(renamedPatch, "config", "user.email", "test@example.com");
  writeFileSync(path.join(renamedPatch, "patches", "example+1.0.0.patch"), fixturePatch());
  git(renamedPatch, "add", ".");
  git(renamedPatch, "commit", "-m", "add versioned patch");
  const renamedPatchOldRef = git(renamedPatch, "rev-parse", "HEAD");
  git(renamedPatch, "mv", "patches/example+1.0.0.patch", "patches/example+2.0.0.patch");
  git(renamedPatch, "commit", "-m", "rename versioned patch");
  mkdirSync(path.join(renamedPatch, "node_modules", "example"), { recursive: true });
  writeFileSync(path.join(renamedPatch, "node_modules", "example", "value.txt"), "new\n");
  const renamedPatchState = path.join(renamedPatch, "state.json");
  result = run(
    renamedPatch,
    "prepare",
    "--root",
    renamedPatch,
    "--old-ref",
    renamedPatchOldRef,
    "--new-ref",
    "HEAD",
    "--state-file",
    renamedPatchState,
  );
  assert.equal(result.status, 0, result.stderr);
  const renamedPatchResult = JSON.parse(readFileSync(renamedPatchState, "utf8"));
  assert.deepEqual(renamedPatchResult.changedPatchFiles, [
    "patches/example+1.0.0.patch",
    "patches/example+2.0.0.patch",
  ]);
  assert.deepEqual(renamedPatchResult.refreshedPackagePaths, ["node_modules/example"]);
  assert.equal(existsSync(path.join(renamedPatch, "node_modules", "example")), false);

  const escapedSymlink = createFixture(`[
    { nodeModulesPath: "node_modules/example", patchPrefix: "example+" },
  ]`);
  git(escapedSymlink, "init", "-b", "main");
  git(escapedSymlink, "config", "user.name", "Test User");
  git(escapedSymlink, "config", "user.email", "test@example.com");
  writeFileSync(
    path.join(escapedSymlink, "patches", "example+1.0.0.patch"),
    fixturePatch("old", "first"),
  );
  git(escapedSymlink, "add", ".");
  git(escapedSymlink, "commit", "-m", "add initial patch");
  const escapedSymlinkOldRef = git(escapedSymlink, "rev-parse", "HEAD");
  writeFileSync(path.join(escapedSymlink, "patches", "example+1.0.0.patch"), fixturePatch());
  git(escapedSymlink, "add", "patches/example+1.0.0.patch");
  git(escapedSymlink, "commit", "-m", "update patch");
  const outsideNodeModules = mkdtempSync(path.join(tmpdir(), "paseo-outside-node-modules-"));
  fixtures.push(outsideNodeModules);
  mkdirSync(path.join(outsideNodeModules, "example"), { recursive: true });
  writeFileSync(path.join(outsideNodeModules, "example", "keep.txt"), "keep\n");
  symlinkSync(outsideNodeModules, path.join(escapedSymlink, "node_modules"), "dir");
  result = run(
    escapedSymlink,
    "prepare",
    "--root",
    escapedSymlink,
    "--old-ref",
    escapedSymlinkOldRef,
    "--new-ref",
    "HEAD",
    "--state-file",
    path.join(escapedSymlink, "state.json"),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to remove symlinked path outside product root/);
  assert.equal(
    readFileSync(path.join(outsideNodeModules, "example", "keep.txt"), "utf8"),
    "keep\n",
  );

  const unmapped = createFixture("[]");
  git(unmapped, "init", "-b", "main");
  git(unmapped, "config", "user.name", "Test User");
  git(unmapped, "config", "user.email", "test@example.com");
  writeFileSync(path.join(unmapped, "patches", "orphan+1.0.0.patch"), fixturePatch());
  git(unmapped, "add", ".");
  git(unmapped, "commit", "-m", "initial patch");
  const unmappedOldRef = git(unmapped, "rev-parse", "HEAD");
  writeFileSync(path.join(unmapped, "patches", "orphan+1.0.0.patch"), fixturePatch("old", "later"));
  git(unmapped, "add", "patches/orphan+1.0.0.patch");
  git(unmapped, "commit", "-m", "update orphan patch");
  result = run(
    unmapped,
    "prepare",
    "--root",
    unmapped,
    "--old-ref",
    unmappedOldRef,
    "--new-ref",
    "HEAD",
    "--state-file",
    path.join(unmapped, "state.json"),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /has no registration in scripts\/postinstall-patches\.mjs/);

  const failedLog = path.join(refresh, "npm-install.log");
  writeFileSync(
    failedLog,
    "\u001b[31m**ERROR**\u001b[39m Failed to apply patch for package example\n",
  );
  result = run(refresh, "check-install-log", "--log", failedLog);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /npm install reported a patch application failure/);
  writeFileSync(failedLog, "added 1 package in 1s\n");
  result = run(refresh, "check-install-log", "--log", failedLog);
  assert.equal(result.status, 0, result.stderr);

  console.log("prepare-patched-dependencies: 14 checks passed");
} finally {
  for (const fixture of fixtures) {
    rmSync(fixture, { recursive: true, force: true });
  }
}
