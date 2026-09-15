import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(cwd, command, args, env = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function git(cwd, ...args) {
  const result = run(cwd, "git", args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function createSecondFeature(root, enabled) {
  if (!enabled) return undefined;
  git(root, "switch", "-c", "feature/two");
  writeFileSync(path.join(root, "feature-two.txt"), "feature two\n");
  git(root, "add", "feature-two.txt");
  git(root, "commit", "-m", "feat: feature two");
  const secondFeatureHead = git(root, "rev-parse", "HEAD");
  git(root, "switch", "main");
  return secondFeatureHead;
}

function formatSecondManifestEntry({
  currentMain,
  enabled,
  pending,
  pr,
  reviewedMain,
  secondFeatureHead,
}) {
  if (!enabled) return "";
  const branchKind = pr ? "PR #2" : "Personal branch";
  const reviewedMainCoordinate = pending ? reviewedMain : currentMain;
  return `feature/two # ${branchKind} # reviewed-main:${reviewedMainCoordinate} # reviewed-head:${secondFeatureHead}\n`;
}

function fixtureChange({ patchEquivalent, conflictingOverlay, upstream }) {
  if (patchEquivalent) return { content: "same\n", path: "shared.txt" };
  if (conflictingOverlay) {
    return {
      content: upstream ? "upstream implementation\n" : "feature implementation\n",
      path: "shared.txt",
    };
  }
  return {
    content: upstream ? "upstream\n" : "feature\n",
    path: upstream ? "upstream.txt" : "feature.txt",
  };
}

function fixtureVariantChange(options, upstream) {
  if (options.largeConflictingOverlay) {
    return {
      content: `${upstream ? "upstream" : "feature"} text line\n`.repeat(45_000),
      path: options.conflictPath,
    };
  }
  if (options.emptyConflictingOverlay) {
    return { content: upstream ? "upstream non-empty text\n" : "", path: options.conflictPath };
  }
  if (options.binaryConflictingOverlay) {
    return {
      content: Buffer.from(upstream ? [0, 9, 8, 7] : [0, 1, 2, 3]),
      path: "shared.bin",
    };
  }
  if (options.patchConflictingOverlay) {
    const source = upstream ? "upstream" : "feature";
    return {
      content:
        `diff --git a/node_modules/example/src/${source}.ts b/node_modules/example/src/${source}.ts\n` +
        `--- a/node_modules/example/src/${source}.ts\n` +
        `+++ b/node_modules/example/src/${source}.ts\n` +
        `@@ -1 +1 @@\n-old\n+${source}\n`,
      path: "patches/example+1.0.0.patch",
    };
  }
  const change = fixtureChange({
    conflictingOverlay: options.conflictingOverlay,
    patchEquivalent: options.patchEquivalent,
    upstream,
  });
  if (options.conflictingOverlay) change.path = options.conflictPath;
  return change;
}

function writeRelatedTestFixtures(root, options) {
  const conflictDirectory = path.dirname(options.conflictPath);
  const conflictStem = path.basename(options.conflictPath).replace(/\.[^.]+$/, "");
  mkdirSync(path.join(root, conflictDirectory), { recursive: true });
  if (!options.withoutRelatedTest) {
    writeFileSync(
      path.join(root, conflictDirectory, `${conflictStem}.test.ts`),
      "// targeted conflict regression\n",
    );
  }
  if (options.platformRelatedTests) {
    writeFileSync(
      path.join(root, conflictDirectory, `${conflictStem}.posix.test.ts`),
      "// POSIX regression\n",
    );
    writeFileSync(
      path.join(root, conflictDirectory, `${conflictStem}.windows-shell.test.ts`),
      "// Windows regression\n",
    );
  }
  for (let index = 0; index < options.extraRelatedTests; index += 1) {
    writeFileSync(
      path.join(root, conflictDirectory, `${conflictStem}.variant-${index}.test.ts`),
      `// regression ${index}\n`,
    );
  }
  if (options.excludedRelatedTests) {
    for (const suffix of [
      "e2e.test.ts",
      "browser.test.ts",
      "real.e2e.test.ts",
      "local.e2e.test.ts",
    ]) {
      writeFileSync(
        path.join(root, conflictDirectory, `${conflictStem}.${suffix}`),
        `// excluded ${suffix}\n`,
      );
    }
  }
  if (options.emptyConflictingOverlay) {
    writeFileSync(path.join(root, "shared.txt"), "shared base text\n");
  }
}

function createFixture(options = {}) {
  const {
    advanceFeature,
    advanceMain,
    binaryConflictingOverlay,
    conflictPath,
    conflictingOverlay,
    emptyConflictingOverlay,
    excludedRelatedTests,
    extraRelatedTests,
    largeConflictingOverlay,
    modifyExtraRelatedTests,
    patchConflictingOverlay,
    patchEquivalent,
    platformRelatedTests,
    prState,
    prIdentity,
    secondBranch,
    secondPending,
    secondPr,
    unrelatedTests,
    withoutRelatedTest,
    replacementPr,
  } = {
    advanceFeature: false,
    advanceMain: true,
    binaryConflictingOverlay: false,
    conflictPath: "shared.txt",
    conflictingOverlay: false,
    emptyConflictingOverlay: false,
    excludedRelatedTests: false,
    extraRelatedTests: 0,
    largeConflictingOverlay: false,
    modifyExtraRelatedTests: false,
    patchConflictingOverlay: false,
    patchEquivalent: false,
    platformRelatedTests: false,
    prIdentity: { branch: "feature/one", owner: "dwyanewang" },
    secondBranch: false,
    secondPending: false,
    secondPr: false,
    unrelatedTests: 0,
    withoutRelatedTest: false,
    ...options,
  };
  const fixtureOptions = {
    binaryConflictingOverlay,
    conflictPath,
    conflictingOverlay,
    emptyConflictingOverlay,
    excludedRelatedTests,
    extraRelatedTests,
    largeConflictingOverlay,
    modifyExtraRelatedTests,
    patchConflictingOverlay,
    patchEquivalent,
    platformRelatedTests,
    withoutRelatedTest,
  };
  const root = mkdtempSync(path.join(tmpdir(), "paseo-rw-main-review-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.com");

  writeFileSync(path.join(root, ".gitignore"), ".dev/\npackages/**/dist/\n");
  writeFileSync(path.join(root, ".tool-versions"), "nodejs 22.20.0\n");
  writeFileSync(path.join(root, ".mise.toml"), '[tools]\nnodejs = "22.20.0"\n');
  writeFileSync(path.join(root, "package.json"), '{"version":"1.2.3"}\n');
  writeFileSync(path.join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  mkdirSync(path.join(root, "scripts"));
  writeFileSync(
    path.join(root, "scripts", "postinstall-patches.mjs"),
    "const patchedPackages = [];\n",
  );
  for (const workspace of ["app", "highlight", "relay", "protocol", "client", "server", "cli"]) {
    const workspaceRoot = path.join(root, "packages", workspace);
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(path.join(workspaceRoot, "package.json"), `{"name":"${workspace}"}\n`);
  }
  writeFileSync(path.join(root, "packages", "app", "vitest.config.ts"), "export default {};\n");
  writeFileSync(path.join(root, "packages", "server", "vitest.config.ts"), "export default {};\n");
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  writeRelatedTestFixtures(root, fixtureOptions);
  git(root, "add", ".");
  git(root, "commit", "-m", "seed");
  const reviewedMain = git(root, "rev-parse", "main");

  git(root, "switch", "-c", "feature/one");
  const featureChange = fixtureVariantChange(fixtureOptions, false);
  mkdirSync(path.dirname(path.join(root, featureChange.path)), { recursive: true });
  writeFileSync(path.join(root, featureChange.path), featureChange.content);
  git(root, "add", featureChange.path);
  if (modifyExtraRelatedTests) {
    const conflictDirectory = path.dirname(conflictPath);
    const conflictStem = path.basename(conflictPath).replace(/\.[^.]+$/, "");
    for (let index = 0; index < extraRelatedTests; index += 1) {
      const testPath = path.join(conflictDirectory, `${conflictStem}.variant-${index}.test.ts`);
      writeFileSync(path.join(root, testPath), `// feature regression ${index}\n`);
      git(root, "add", testPath);
    }
  }
  if (unrelatedTests > 0) {
    mkdirSync(path.join(root, "unrelated"), { recursive: true });
    for (let index = 0; index < unrelatedTests; index += 1) {
      const testPath = `unrelated/widget-${index}.test.ts`;
      writeFileSync(path.join(root, testPath), `// unrelated regression ${index}\n`);
      git(root, "add", testPath);
    }
  }
  git(root, "commit", "-m", "feat: feature one");
  const reviewedFeatureHead = git(root, "rev-parse", "HEAD");
  if (advanceFeature) {
    writeFileSync(path.join(root, "feature-update.txt"), "updated feature\n");
    git(root, "add", "feature-update.txt");
    git(root, "commit", "-m", "feat: update feature one");
  }
  const featureHead = git(root, "rev-parse", "HEAD");

  git(root, "switch", "main");
  if (advanceMain) {
    const upstreamChange = fixtureVariantChange(fixtureOptions, true);
    mkdirSync(path.dirname(path.join(root, upstreamChange.path)), { recursive: true });
    writeFileSync(path.join(root, upstreamChange.path), upstreamChange.content);
    git(root, "add", upstreamChange.path);
    git(root, "commit", "-m", "feat: upstream implementation (#99)");
  }
  const currentMain = git(root, "rev-parse", "main");

  const secondFeatureHead = createSecondFeature(root, secondBranch);

  git(root, "branch", "rw-base", "main");
  git(root, "switch", "-c", "chore/build-paseo");
  const controlDir = path.join(root, "dwyanewang");
  const binDir = path.join(root, ".git", "test-bin");
  mkdirSync(controlDir);
  mkdirSync(binDir);
  copyFileSync(
    path.join(repoRoot, "dwyanewang", "sync-rw-main-branches.sh"),
    path.join(controlDir, "sync-rw-main-branches.sh"),
  );
  copyFileSync(
    path.join(repoRoot, "dwyanewang", "rebuild-rw-main.sh"),
    path.join(controlDir, "rebuild-rw-main.sh"),
  );
  copyFileSync(
    path.join(repoRoot, "dwyanewang", "refresh-expo-router-types.mjs"),
    path.join(controlDir, "refresh-expo-router-types.mjs"),
  );
  const expoRouterTypesHelper = path.join(binDir, "refresh-expo-router-types.mjs");
  copyFileSync(
    path.join(repoRoot, "dwyanewang", "refresh-expo-router-types.mjs"),
    expoRouterTypesHelper,
  );
  copyFileSync(
    path.join(repoRoot, "dwyanewang", "build-paseo-state.sh"),
    path.join(controlDir, "build-paseo-state.sh"),
  );
  copyFileSync(
    path.join(repoRoot, "dwyanewang", "rw-conflict-evidence.sh"),
    path.join(controlDir, "rw-conflict-evidence.sh"),
  );
  copyFileSync(
    path.join(repoRoot, "dwyanewang", "prepare-patched-dependencies.mjs"),
    path.join(binDir, "prepare-patched-dependencies.mjs"),
  );

  const manifestEntry = prState ? "feature/one # PR #1" : "feature/one # Personal branch";
  const secondManifestEntry = formatSecondManifestEntry({
    currentMain,
    enabled: secondBranch,
    pending: secondPending,
    pr: secondPr,
    reviewedMain,
    secondFeatureHead,
  });
  const manifestPath = path.join(controlDir, "rw-main-branches.txt");
  writeFileSync(
    manifestPath,
    `# Test manifest\n\n${manifestEntry} # reviewed-main:${reviewedMain} # reviewed-head:${reviewedFeatureHead}\n${secondManifestEntry}`,
  );

  const mergeCommit = prState === "MERGED" ? currentMain : "";
  const ghPath = path.join(binDir, "gh");
  const ghCallLog = path.join(root, ".git", "gh-calls.log");
  const ghRows = [
    [
      "1",
      prState ?? "OPEN",
      prIdentity.branch,
      prIdentity.owner,
      mergeCommit,
      "Feature one",
      "https://example.test/pr/1",
    ],
  ];
  if (secondPr) {
    ghRows.push([
      "2",
      "OPEN",
      "feature/two",
      "dwyanewang",
      "",
      "Feature two",
      "https://example.test/pr/2",
    ]);
  }
  if (replacementPr) {
    ghRows.push([
      "3",
      "OPEN",
      replacementPr.branch ?? "feature/one",
      replacementPr.owner ?? "dwyanewang",
      "",
      "Replacement",
      "https://example.test/pr/3",
    ]);
  }
  const ghOutput = ghRows
    .map(
      (fields) =>
        `printf '%s\\037%s\\037%s\\037%s\\037%s\\037%s\\037%s\\n' ${fields.map((field) => `'${field}'`).join(" ")}`,
    )
    .join("\n");
  writeFileSync(ghPath, `#!/usr/bin/env bash\nprintf 'call\\n' >> "$GH_CALL_LOG"\n${ghOutput}\n`);
  chmodSync(ghPath, 0o755);
  const misePath = path.join(binDir, "mise");
  writeFileSync(
    misePath,
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  install) : ;;
  activate) : ;;
  *) exit 2 ;;
esac
`,
  );
  chmodSync(misePath, 0o755);
  const npmPath = path.join(binDir, "npm");
  const npmCallLog = path.join(root, ".git", "npm-calls.log");
  const npmCwdCallLog = path.join(root, ".git", "npm-cwd-calls.log");
  writeFileSync(
    npmPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$NPM_CALL_LOG"
printf '%s|%s\\n' "$PWD" "$*" >> "$NPM_CWD_CALL_LOG"
if [[ "$*" == --version ]]; then
  printf '%s\\n' "\${PASEO_TEST_NPM_VERSION:-10.9.0}"
  exit 0
fi
if [[ "$*" == 'run typecheck --workspace=@getpaseo/app' && -n "\${PASEO_TEST_APP_TYPECHECK_EXIT:-}" ]]; then
  exit "$PASEO_TEST_APP_TYPECHECK_EXIT"
fi
if [[ "\${1:-}" == exec && -n "\${PASEO_TEST_CAPABILITY_EXIT:-}" ]]; then
  exit "$PASEO_TEST_CAPABILITY_EXIT"
fi
if [[ "\${1:-}" == exec && "\${PASEO_TEST_CAPABILITY_DIRTY:-0}" == 1 ]]; then
  printf '%s\\n' 'test changed a tracked file' >> "$PASEO_TEST_BUILD_ROOT/seed.txt"
fi
if [[ "$*" == 'run build:server-deps' ]]; then
  root=$PASEO_TEST_BUILD_ROOT
  for workspace in highlight relay protocol client; do
    mkdir -p "$root/packages/$workspace/dist"
    printf '%s\\n' "$workspace" >"$root/packages/$workspace/dist/index.js"
  done
elif [[ "$*" == 'run build --workspace=@getpaseo/expo-two-way-audio' ]]; then
  :
elif [[ "$*" == 'run build --workspace=@getpaseo/server' ]]; then
  root=$PASEO_TEST_BUILD_ROOT
  mkdir -p "$root/packages/server/dist/server/server"
  printf '%s\\n' server >"$root/packages/server/dist/index.js"
  printf '%s\\n' server >"$root/packages/server/dist/server/server/exports.js"
elif [[ "$*" == 'run build --workspace=@getpaseo/cli' ]]; then
  root=$PASEO_TEST_BUILD_ROOT
  mkdir -p "$root/packages/cli/dist"
  printf '%s\\n' cli >"$root/packages/cli/dist/index.js"
fi
`,
  );
  chmodSync(npmPath, 0o755);
  const diffPath = path.join(binDir, "diff");
  writeFileSync(
    diffPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${PASEO_TEST_MOVE_REF_ON_DIFF:-}" ]]; then
  git update-ref "$PASEO_TEST_MOVE_REF_ON_DIFF" "$PASEO_TEST_MOVE_REF_TO"
fi
exec /usr/bin/diff "$@"
`,
  );
  chmodSync(diffPath, 0o755);

  git(root, "add", "dwyanewang");
  git(root, "commit", "-m", "chore: add rw-main controls");

  return {
    conflictPath,
    currentMain,
    env: {
      GH_CALL_LOG: ghCallLog,
      NPM_CALL_LOG: npmCallLog,
      NPM_CWD_CALL_LOG: npmCwdCallLog,
      PASEO_EXPO_ROUTER_TYPES_HELPER: expoRouterTypesHelper,
      PASEO_TEST_BUILD_ROOT: root,
      PASEO_PATCHED_DEPENDENCIES_HELPER: path.join(binDir, "prepare-patched-dependencies.mjs"),
      PATH: `${binDir}:${process.env.PATH}`,
    },
    featureHead,
    ghCallLog,
    manifestPath,
    npmCallLog,
    npmCwdCallLog,
    reviewedMain,
    reviewedFeatureHead,
    root,
    secondFeatureHead,
  };
}

function completeReviewedConflict(fixture, explanation = "preserved both sides") {
  writeFileSync(
    fixture.manifestPath,
    readFileSync(fixture.manifestPath, "utf8").replace(
      `reviewed-main:${fixture.reviewedMain}`,
      `reviewed-main:${fixture.currentMain}`,
    ),
  );
  git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
  git(fixture.root, "commit", "-m", "accept fixture conflict");
  const first = run(
    fixture.root,
    "bash",
    ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
    fixture.env,
  );
  assert.equal(first.status, 6, `${first.stdout}\n${first.stderr}`);
  const operationDir = path.dirname(rwMainOperationPath(first));
  const operationWorktree = path.join(operationDir, "worktree");
  writeFileSync(
    path.join(operationWorktree, fixture.conflictPath),
    "upstream implementation\nfeature implementation\n",
  );
  git(operationWorktree, "add", fixture.conflictPath);
  completeConflictReview(operationDir, operationWorktree, explanation);
  const completed = run(
    fixture.root,
    "bash",
    ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
    fixture.env,
  );
  return { completed, operationDir };
}

function runSync(fixture, ...args) {
  return run(fixture.root, "bash", ["dwyanewang/sync-rw-main-branches.sh", ...args], fixture.env);
}

function reviewRequestPath(result) {
  const match = result.stdout.match(/^PASEO_REVIEW_REQUEST_FILE=(.+)$/m);
  assert.notEqual(match, null, result.stdout);
  return match[1];
}

function rwMainOperationPath(result) {
  const match = result.stdout.match(/^PASEO_RW_MAIN_OPERATION=(.+)$/m);
  assert.notEqual(match, null, `${result.stdout}\n${result.stderr}`);
  return match[1];
}

function completeConflictReview(operationDir, operationWorktree, explanation) {
  const reviewPath = path.join(operationDir, "conflict-review.tsv");
  const stagedTree = git(operationWorktree, "write-tree");
  const completed = readFileSync(reviewPath, "utf8")
    .replace("resolution-tree\tTODO\tTODO", `resolution-tree\t${stagedTree}\t${explanation}`)
    .replaceAll("\tTODO", `\t${explanation}`);
  writeFileSync(reviewPath, completed);
  return reviewPath;
}

function withFixture(options, callback) {
  const fixture = createFixture(options);
  try {
    callback(fixture);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
}

test("explicit PR remapping and semantic acceptance update the manifest once", () => {
  withFixture({ prState: "MERGED", replacementPr: {} }, (fixture) => {
    git(fixture.root, "update-ref", "refs/remotes/origin/feature/one", fixture.featureHead);
    const before = readFileSync(fixture.manifestPath, "utf8");
    const proposed = runSync(fixture, "--update-pr", "feature/one", "3");
    assert.equal(proposed.status, 3, proposed.stderr);
    assert.equal(readFileSync(fixture.manifestPath, "utf8"), before);
    const accepted = runSync(
      fixture,
      "--update-pr",
      "feature/one",
      "3",
      "--accept-review-request",
      reviewRequestPath(proposed),
    );
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(
      readFileSync(fixture.manifestPath, "utf8"),
      new RegExp(
        `feature/one # PR #3 # reviewed-main:${fixture.currentMain} # reviewed-head:${fixture.featureHead}`,
      ),
    );
    assert.equal(readFileSync(fixture.ghCallLog, "utf8").trim().split("\n").length, 2);
  });
});

test("manifest rewrites preserve depends-on metadata", () => {
  withFixture({ prState: "CLOSED", replacementPr: {}, secondBranch: true }, (fixture) => {
    writeFileSync(
      fixture.manifestPath,
      readFileSync(fixture.manifestPath, "utf8").replace(
        "feature/two # Personal branch",
        "feature/two # Personal branch # depends-on:feature/one",
      ),
    );
    git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
    git(fixture.root, "commit", "-m", "declare overlay dependency");
    git(fixture.root, "update-ref", "refs/remotes/origin/feature/one", fixture.featureHead);
    const proposed = runSync(fixture, "--update-pr", "feature/one", "3");
    assert.equal(proposed.status, 3, proposed.stderr);
    const accepted = runSync(
      fixture,
      "--update-pr",
      "feature/one",
      "3",
      "--accept-review-request",
      reviewRequestPath(proposed),
    );
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(readFileSync(fixture.manifestPath, "utf8"), /depends-on:feature\/one/);
  });
});

test.each([
  { dependency: "feature/missing", message: /depends on missing manifest branch/ },
  { dependency: "feature/two", message: /must appear before dependent branch feature\/one/ },
])("rejects invalid declared overlay dependency: $dependency", ({ dependency, message }) => {
  withFixture({ advanceMain: false, secondBranch: true }, (fixture) => {
    writeFileSync(
      fixture.manifestPath,
      readFileSync(fixture.manifestPath, "utf8").replace(
        "feature/one # Personal branch",
        `feature/one # Personal branch # depends-on:${dependency}`,
      ),
    );
    const result = runSync(fixture, "--dry-run");
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  });
});

test("removing a dependency forces its retained dependent into review and clears the accepted reference", () => {
  withFixture({ advanceMain: false, secondBranch: true }, (fixture) => {
    writeFileSync(
      fixture.manifestPath,
      readFileSync(fixture.manifestPath, "utf8").replace(
        "feature/two # Personal branch",
        "feature/two # Personal branch # depends-on:feature/one",
      ),
    );
    git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
    git(fixture.root, "commit", "-m", "declare dependency");

    const review = runSync(fixture, "--remove-branch", "feature/one");
    assert.equal(review.status, 3, `${review.stdout}\n${review.stderr}`);
    const request = readFileSync(reviewRequestPath(review), "utf8");
    assert.match(request, /branch\tfeature\/one\t/);
    assert.match(request, /branch\tfeature\/two\t/);

    const accepted = runSync(
      fixture,
      "--remove-branch",
      "feature/one",
      "--accept-review-request",
      reviewRequestPath(review),
    );
    assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
    const manifest = readFileSync(fixture.manifestPath, "utf8");
    assert.doesNotMatch(manifest, /feature\/one/);
    assert.doesNotMatch(manifest, /depends-on:/);
    assert.match(manifest, /feature\/two/);
  });
});

test("dependency replacement review is never exempted by an exact cached branch result", () => {
  withFixture({ advanceMain: false, secondBranch: true }, (fixture) => {
    fixture.env.PASEO_REVIEW_CACHE_DIR = path.join(fixture.root, ".git/review-cache");
    writeFileSync(
      fixture.manifestPath,
      readFileSync(fixture.manifestPath, "utf8").replace(
        "feature/two # Personal branch",
        "feature/two # Personal branch # depends-on:feature/one",
      ),
    );
    git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
    git(fixture.root, "commit", "-m", "declare dependency for forced review cache test");

    const first = runSync(fixture, "--remove-branch", "feature/one");
    assert.equal(first.status, 3, `${first.stdout}\n${first.stderr}`);
    const evidence = path.join(fixture.root, ".git/feature-two-review.txt");
    writeFileSync(evidence, "keep feature/two after reviewing dependency replacement\n");
    const recorded = runSync(
      fixture,
      "--remove-branch",
      "feature/one",
      "--record-review-result",
      reviewRequestPath(first),
      "feature/two",
      "keep",
      evidence,
    );
    assert.equal(recorded.status, 0, `${recorded.stdout}\n${recorded.stderr}`);

    const repeated = runSync(fixture, "--remove-branch", "feature/one");
    assert.equal(repeated.status, 3, `${repeated.stdout}\n${repeated.stderr}`);
    assert.match(repeated.stdout, /\nfeature\/two\n/);
    assert.doesNotMatch(repeated.stdout, /All pending branch conclusions were reused/);
  });
});

test("PR remapping rejects a different head branch without changing the manifest", () => {
  withFixture(
    { prState: "CLOSED", replacementPr: { branch: "feature/someone-else" } },
    (fixture) => {
      const before = readFileSync(fixture.manifestPath, "utf8");
      const result = runSync(fixture, "--update-pr", "feature/one", "3");
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /replacement PR #3 must be open and belong to dwyanewang\/feature\/one/,
      );
      assert.equal(readFileSync(fixture.manifestPath, "utf8"), before);
    },
  );
});

test.each([
  { branch: "feature/renamed", owner: "dwyanewang" },
  { branch: "feature/one", owner: "another-owner" },
])(
  "existing manifest PR identity mismatch is rejected without changing the manifest: %j",
  (identity) => {
    withFixture({ advanceMain: false, prState: "CLOSED", prIdentity: identity }, (fixture) => {
      const before = readFileSync(fixture.manifestPath, "utf8");
      const result = runSync(fixture, "--dry-run");
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.match(
        result.stderr,
        /PR #1 does not belong to dwyanewang\/feature\/one; use --update-pr explicitly/,
      );
      assert.equal(readFileSync(fixture.manifestPath, "utf8"), before);
    });
  },
);

test("a closed existing PR with matching owner and head remains a valid overlay", () => {
  withFixture({ advanceMain: false, prState: "CLOSED" }, (fixture) => {
    const before = readFileSync(fixture.manifestPath, "utf8");
    const result = runSync(fixture, "--dry-run");
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(fixture.manifestPath, "utf8"), before);
  });
});

test("a PR merged after the frozen snapshot stays in this run's manifest", () => {
  withFixture({ prState: "MERGED", advanceMain: false }, (fixture) => {
    const laterTree = git(fixture.root, "rev-parse", "main^{tree}");
    const later = git(
      fixture.root,
      "commit-tree",
      laterTree,
      "-p",
      fixture.currentMain,
      "-m",
      "later upstream merge",
    );
    git(fixture.root, "update-ref", "refs/remotes/upstream/main", later);
    const gh = path.join(fixture.root, ".git/test-bin/gh");
    writeFileSync(gh, readFileSync(gh, "utf8").replace(fixture.currentMain, later));
    const before = readFileSync(fixture.manifestPath, "utf8");
    const result = runSync(fixture, "--frozen-main", fixture.currentMain);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /merged after this run snapshot/);
    assert.equal(readFileSync(fixture.manifestPath, "utf8"), before);
  });
});

test("a fully reviewed manifest does not repeat the temporary mergeability build", () => {
  withFixture({ advanceMain: false }, (fixture) => {
    git(fixture.root, "update-ref", "refs/heads/rw-base", fixture.featureHead);
    const result = runSync(fixture, "--check-mergeability");
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Mergeability preflight/);
    assert.equal(git(fixture.root, "rev-parse", "rw-base"), fixture.featureHead);
  });
});

test("keeps existing behavior when main has already been reviewed", () => {
  withFixture({ advanceMain: false }, (fixture) => {
    const before = readFileSync(fixture.manifestPath, "utf8");
    const result = runSync(fixture, "--dry-run");

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /manifest is already up to date/);
    assert.equal(readFileSync(fixture.manifestPath, "utf8"), before);
  });
});

test("queries all manifest PR metadata in one GitHub request", () => {
  withFixture(
    { advanceMain: false, prState: "OPEN", secondBranch: true, secondPr: true },
    (fixture) => {
      const result = runSync(fixture, "--dry-run");

      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(fixture.ghCallLog, "utf8"), "call\n");
      assert.match(result.stdout, /manifest is already up to date/);
    },
  );
});

test("blocks on every new upstream commit even without overlapping paths", () => {
  withFixture({}, (fixture) => {
    const before = readFileSync(fixture.manifestPath, "utf8");
    const result = runSync(fixture);

    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stdout, new RegExp(fixture.currentMain));
    assert.match(result.stdout, /upstream\.txt/);
    assert.match(result.stdout, /feature\/one/);
    assert.match(result.stdout, /Feature evidence: .*overlapping paths=0/);
    const requestPath = reviewRequestPath(result);
    assert.match(path.basename(requestPath), /^[0-9a-f]{40}\.tsv$/);
    assert.equal(
      readFileSync(requestPath, "utf8"),
      `paseo-rw-main-review-request\t1\nmain\t${fixture.currentMain}\nbranch\tfeature/one\t${fixture.reviewedMain}\t${fixture.currentMain}\t${fixture.reviewedFeatureHead}\t${fixture.featureHead}\n`,
    );
    assert.equal(readFileSync(fixture.manifestPath, "utf8"), before);
  });
});

test("diagnoses supported overlay conflicts without blocking semantic review", () => {
  withFixture({ conflictingOverlay: true }, (fixture) => {
    const result = runSync(fixture, "--check-mergeability");

    assert.equal(result.status, 3);
    assert.match(result.stderr, /mergeability preflight failed while merging overlay feature\/one/);
    assert.match(result.stderr, /shared\.txt/);
    assert.match(result.stderr, /Supported text conflict diagnosed/);
    assert.match(result.stdout, /Semantic review required/);
    assert.match(result.stdout, /PASEO_REVIEW_REQUEST_FILE=/);
    assert.equal(git(fixture.root, "rev-parse", "rw-base"), fixture.currentMain);
    assert.doesNotMatch(git(fixture.root, "worktree", "list", "--porcelain"), /mergeability/);
  });
});

test("classifies large and empty text conflicts as supported while rejecting binary conflicts", () => {
  withFixture({ largeConflictingOverlay: true }, (fixture) => {
    const result = runSync(fixture, "--check-mergeability");
    assert.equal(result.status, 3, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Supported text conflict diagnosed/);
  });
  withFixture({ emptyConflictingOverlay: true }, (fixture) => {
    const result = runSync(fixture, "--check-mergeability");
    assert.equal(result.status, 3, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Supported text conflict diagnosed/);
  });
  withFixture({ binaryConflictingOverlay: true }, (fixture) => {
    const result = runSync(fixture, "--check-mergeability");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unsupported conflict/);
  });
}, 30_000);

test("reviews each branch from its own recorded main baseline", () => {
  withFixture({ secondBranch: true }, (fixture) => {
    const result = runSync(fixture);

    assert.equal(result.status, 3, result.stderr);
    assert.match(
      result.stdout,
      new RegExp(
        `feature/one[\\s\\S]*Main review:   ${fixture.reviewedMain}..${fixture.currentMain}`,
      ),
    );
    assert.doesNotMatch(result.stdout, /\nfeature\/two\n/);
  });
});

test("rebuild rejects the same unsupported binary conflict on every retry", () => {
  withFixture({ binaryConflictingOverlay: true }, (fixture) => {
    writeFileSync(
      fixture.manifestPath,
      readFileSync(fixture.manifestPath, "utf8").replace(
        `reviewed-main:${fixture.reviewedMain}`,
        `reviewed-main:${fixture.currentMain}`,
      ),
    );
    git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
    git(fixture.root, "commit", "-m", "accept binary-conflicting overlay for rebuild retry");

    const first = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(first.status, 1, `${first.stdout}\n${first.stderr}`);
    assert.match(first.stderr, /unsupported or non-text conflict/);
    const operationRequest = readFileSync(
      path.join(fixture.root, ".dev/rw-main-operation"),
      "utf8",
    ).trim();
    const operationDir = path.dirname(operationRequest);
    assert.equal(existsSync(path.join(operationDir, "conflict-review.tsv")), false);

    const second = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(second.status, 1, `${second.stdout}\n${second.stderr}`);
    assert.match(second.stderr, /unsupported or non-text conflict/);
    assert.equal(existsSync(path.join(operationDir, "conflict-review.tsv")), false);
    assert.equal(existsSync(path.join(operationDir, "worktree")), true);

    const aborted = run(
      fixture.root,
      "bash",
      [
        "dwyanewang/rebuild-rw-main.sh",
        "--build-root",
        fixture.root,
        "--abort-operation",
        operationRequest,
      ],
      fixture.env,
    );
    assert.equal(aborted.status, 0, `${aborted.stdout}\n${aborted.stderr}`);
    assert.equal(existsSync(path.join(fixture.root, ".dev/rw-main-operation")), false);
  });
}, 30_000);

test("freezes the exact sorted set and ranges for multiple pending branches", () => {
  withFixture({ secondBranch: true, secondPending: true }, (fixture) => {
    const result = runSync(fixture);

    assert.equal(result.status, 3, result.stderr);
    assert.equal(
      readFileSync(reviewRequestPath(result), "utf8"),
      [
        "paseo-rw-main-review-request\t1",
        `main\t${fixture.currentMain}`,
        `branch\tfeature/one\t${fixture.reviewedMain}\t${fixture.currentMain}\t${fixture.reviewedFeatureHead}\t${fixture.featureHead}`,
        `branch\tfeature/two\t${fixture.reviewedMain}\t${fixture.currentMain}\t${fixture.secondFeatureHead}\t${fixture.secondFeatureHead}`,
        "",
      ].join("\n"),
    );
  });
});

test("reuses one exact per-branch review result while another branch remains pending", () => {
  withFixture({ secondBranch: true, secondPending: true }, (fixture) => {
    fixture.env.PASEO_REVIEW_CACHE_DIR = path.join(fixture.root, ".git/review-cache");
    const first = runSync(fixture);
    assert.equal(first.status, 3, first.stderr);
    const firstRequest = reviewRequestPath(first);
    const evidence = path.join(fixture.root, ".git/feature-one-review.txt");
    writeFileSync(evidence, "keep: feature remains required after full semantic review\n");
    const recorded = runSync(
      fixture,
      "--record-review-result",
      firstRequest,
      "feature/one",
      "keep",
      evidence,
    );
    assert.equal(recorded.status, 0, `${recorded.stdout}\n${recorded.stderr}`);

    const second = runSync(fixture);
    assert.equal(second.status, 3, second.stderr);
    const secondRequest = readFileSync(reviewRequestPath(second), "utf8");
    assert.match(secondRequest, /branch\tfeature\/one\t/);
    assert.match(secondRequest, /branch\tfeature\/two\t/);
    assert.doesNotMatch(second.stdout, /\nfeature\/one\n/);
    assert.match(second.stdout, /\nfeature\/two\n/);
  });
});

test("invalidates a cached review when the branch head advances before full-request acceptance", () => {
  withFixture({ secondBranch: true, secondPending: true }, (fixture) => {
    fixture.env.PASEO_REVIEW_CACHE_DIR = path.join(fixture.root, ".git/review-cache");
    const first = runSync(fixture);
    assert.equal(first.status, 3, first.stderr);
    const evidence = path.join(fixture.root, ".git/feature-one-review.txt");
    writeFileSync(evidence, "keep: reviewed the exact frozen feature head\n");
    const recorded = runSync(
      fixture,
      "--record-review-result",
      reviewRequestPath(first),
      "feature/one",
      "keep",
      evidence,
    );
    assert.equal(recorded.status, 0, `${recorded.stdout}\n${recorded.stderr}`);

    git(fixture.root, "switch", "feature/one");
    writeFileSync(path.join(fixture.root, "unreviewed.txt"), "new unreviewed behavior\n");
    git(fixture.root, "add", "unreviewed.txt");
    git(fixture.root, "commit", "-m", "feat: advance after cached review");
    const advancedHead = git(fixture.root, "rev-parse", "HEAD");
    git(fixture.root, "switch", "chore/build-paseo");

    const next = runSync(fixture);
    assert.equal(next.status, 3, next.stderr);
    const nextRequest = readFileSync(reviewRequestPath(next), "utf8");
    assert.match(
      nextRequest,
      new RegExp(
        `branch\\tfeature/one\\t${fixture.reviewedMain}\\t${fixture.currentMain}\\t${fixture.reviewedFeatureHead}\\t${advancedHead}`,
      ),
    );
    assert.match(next.stdout, /\nfeature\/one\n/);

    const accepted = runSync(fixture, "--accept-review-request", reviewRequestPath(next));
    assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
    assert.match(
      readFileSync(fixture.manifestPath, "utf8"),
      new RegExp(`reviewed-head:${advancedHead}`),
    );
  });
});

test("accepts a complete request when every branch review is cached and re-reviews missing evidence", () => {
  withFixture({ secondBranch: true, secondPending: true }, (fixture) => {
    const cacheDir = path.join(fixture.root, ".git/review-cache");
    fixture.env.PASEO_REVIEW_CACHE_DIR = cacheDir;
    const first = runSync(fixture);
    assert.equal(first.status, 3, first.stderr);
    const request = reviewRequestPath(first);
    for (const branch of ["feature/one", "feature/two"]) {
      const evidence = path.join(fixture.root, `.git/${branch.replace("/", "-")}.txt`);
      writeFileSync(evidence, `keep ${branch}: exact ranges reviewed\n`);
      const recorded = runSync(
        fixture,
        "--record-review-result",
        request,
        branch,
        "keep",
        evidence,
      );
      assert.equal(recorded.status, 0, `${recorded.stdout}\n${recorded.stderr}`);
    }

    const cached = runSync(fixture);
    assert.equal(cached.status, 3, cached.stderr);
    assert.match(cached.stdout, /All pending branch conclusions were reused/);
    const completeRequest = reviewRequestPath(cached);
    assert.equal((readFileSync(completeRequest, "utf8").match(/^branch\t/gm) ?? []).length, 2);
    const accepted = runSync(fixture, "--accept-review-request", completeRequest);
    assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
    assert.match(
      readFileSync(fixture.manifestPath, "utf8"),
      new RegExp(`reviewed-main:${fixture.currentMain}`, "g"),
    );
    git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
    git(fixture.root, "commit", "-m", "accept cached review request");

    writeFileSync(
      fixture.manifestPath,
      readFileSync(fixture.manifestPath, "utf8").replaceAll(
        `reviewed-main:${fixture.currentMain}`,
        `reviewed-main:${fixture.reviewedMain}`,
      ),
    );
    git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
    git(fixture.root, "commit", "-m", "test: require the same review ranges again");
    const evidenceFiles = readdirSync(cacheDir).filter((entry) => entry.endsWith(".evidence"));
    assert.equal(evidenceFiles.length, 2);
    rmSync(path.join(cacheDir, evidenceFiles[0]));
    const missingEvidence = runSync(fixture);
    assert.equal(missingEvidence.status, 3, missingEvidence.stderr);
    assert.match(missingEvidence.stdout, /Semantic review required/);
  });
}, 15_000);

test("blocks when a branch head changes even if main does not", () => {
  withFixture({ advanceFeature: true, advanceMain: false }, (fixture) => {
    const result = runSync(fixture);

    assert.equal(result.status, 3, result.stderr);
    assert.match(
      result.stdout,
      new RegExp(`Branch review: ${fixture.reviewedFeatureHead}..${fixture.featureHead}`),
    );
    assert.match(result.stdout, /Range-diff against the previously reviewed feature/);
    assert.match(result.stdout, /feature-update\.txt/);
  });
});

test("accepts the exact current main and removes an absorbed branch atomically", () => {
  withFixture({}, (fixture) => {
    const review = runSync(fixture);
    assert.equal(review.status, 3, review.stderr);
    const result = runSync(
      fixture,
      "--accept-review-request",
      reviewRequestPath(review),
      "--remove-branch",
      "feature/one",
    );

    assert.equal(result.status, 0, result.stderr);
    const manifest = readFileSync(fixture.manifestPath, "utf8");
    assert.doesNotMatch(manifest, /feature\/one/);
  });
});

test("dry-run shows an accepted review without changing the manifest", () => {
  withFixture({}, (fixture) => {
    const before = readFileSync(fixture.manifestPath, "utf8");
    const review = runSync(fixture);
    assert.equal(review.status, 3, review.stderr);
    const result = runSync(
      fixture,
      "--dry-run",
      "--accept-review-request",
      reviewRequestPath(review),
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`reviewed-main:${fixture.currentMain}`));
    assert.match(result.stdout, new RegExp(`reviewed-head:${fixture.featureHead}`));
    assert.match(result.stdout, /Dry run complete/);
    assert.equal(readFileSync(fixture.manifestPath, "utf8"), before);
  });
});

test("requires and verifies every expected branch head in explicit coordinate mode", () => {
  withFixture({}, (fixture) => {
    const missingHead = runSync(fixture, "--dry-run", "--accept-main-review", fixture.currentMain);
    assert.equal(missingHead.status, 1);
    assert.match(missingHead.stderr, /missing the expected current head for feature\/one/);

    const accepted = runSync(
      fixture,
      "--dry-run",
      "--accept-main-review",
      fixture.currentMain,
      "--accept-branch-head",
      "feature/one",
      fixture.featureHead,
    );
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /Dry run complete/);
  });
});

test("rejects an accepted request if a reviewed branch ref moved", () => {
  withFixture({}, (fixture) => {
    const before = readFileSync(fixture.manifestPath, "utf8");
    const review = runSync(fixture);
    assert.equal(review.status, 3, review.stderr);
    const requestPath = reviewRequestPath(review);

    git(fixture.root, "update-ref", "refs/heads/feature/one", fixture.reviewedMain);
    const result = runSync(fixture, "--accept-review-request", requestPath);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /feature\/one moved during semantic review/);
    assert.equal(readFileSync(fixture.manifestPath, "utf8"), before);
  });
});

test("rejects an accepted request if main moved", () => {
  withFixture({}, (fixture) => {
    const review = runSync(fixture);
    assert.equal(review.status, 3, review.stderr);
    git(fixture.root, "update-ref", "refs/heads/main", fixture.reviewedMain);

    const result = runSync(
      fixture,
      "--dry-run",
      "--accept-review-request",
      reviewRequestPath(review),
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /must equal current main/);
  });
});

test("rejects accepted requests when a recorded review-range start changes", () => {
  for (const coordinate of ["reviewed-main", "reviewed-head"]) {
    withFixture({ advanceFeature: true }, (fixture) => {
      const review = runSync(fixture);
      assert.equal(review.status, 3, review.stderr);
      const before = readFileSync(fixture.manifestPath, "utf8");
      const from =
        coordinate === "reviewed-main" ? fixture.reviewedMain : fixture.reviewedFeatureHead;
      const to = coordinate === "reviewed-main" ? fixture.currentMain : fixture.featureHead;
      writeFileSync(
        fixture.manifestPath,
        before.replace(`${coordinate}:${from}`, `${coordinate}:${to}`),
      );

      const result = runSync(
        fixture,
        "--dry-run",
        "--accept-review-request",
        reviewRequestPath(review),
      );

      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        new RegExp(
          `${coordinate === "reviewed-main" ? "main" : "branch"} review range for feature/one changed`,
        ),
      );
    });
  }
}, 15_000);

test("rejects an accepted request when the pending manifest set changes", () => {
  withFixture({ secondBranch: true, secondPending: true }, (fixture) => {
    const review = runSync(fixture);
    assert.equal(review.status, 3, review.stderr);
    const manifest = readFileSync(fixture.manifestPath, "utf8")
      .split("\n")
      .filter((line) => !line.startsWith("feature/two "))
      .join("\n");
    writeFileSync(fixture.manifestPath, manifest);

    const result = runSync(
      fixture,
      "--dry-run",
      "--accept-review-request",
      reviewRequestPath(review),
    );

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /accepted review includes a branch that is no longer pending: feature\/two/,
    );
  });
});

test("rechecks reviewed refs immediately before replacing the manifest", () => {
  withFixture({}, (fixture) => {
    const before = readFileSync(fixture.manifestPath, "utf8");
    const review = runSync(fixture);
    assert.equal(review.status, 3, review.stderr);
    const result = run(
      fixture.root,
      "bash",
      ["dwyanewang/sync-rw-main-branches.sh", "--accept-review-request", reviewRequestPath(review)],
      {
        ...fixture.env,
        PASEO_TEST_MOVE_REF_ON_DIFF: "refs/heads/feature/one",
        PASEO_TEST_MOVE_REF_TO: fixture.reviewedMain,
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /feature\/one moved during semantic review/);
    assert.equal(readFileSync(fixture.manifestPath, "utf8"), before);
  });
});

test("rejects a modified content-addressed review request", () => {
  withFixture({}, (fixture) => {
    const review = runSync(fixture);
    assert.equal(review.status, 3, review.stderr);
    const requestPath = reviewRequestPath(review);
    chmodSync(requestPath, 0o600);
    writeFileSync(requestPath, `${readFileSync(requestPath, "utf8")}tampered\n`);

    const result = runSync(fixture, "--accept-review-request", requestPath);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /review request content does not match its token/);
  });
});

test("validates per-branch review metadata and accepted review SHAs", () => {
  for (const mutate of [
    () => "# Test manifest\n\nfeature/one # Personal branch\n",
    (fixture) =>
      `feature/one # Personal branch # reviewed-main:${fixture.reviewedMain} # reviewed-main:${fixture.reviewedMain} # reviewed-head:${fixture.reviewedFeatureHead}\n`,
    (fixture) =>
      `feature/one # Personal branch # reviewed-main:not-a-sha # reviewed-head:${fixture.reviewedFeatureHead}\n`,
    (fixture) =>
      `feature/one # Personal branch # reviewed-main:${fixture.featureHead} # reviewed-head:${fixture.reviewedFeatureHead}\n`,
    (fixture) => `feature/one # Personal branch # reviewed-main:${fixture.reviewedMain}\n`,
    (fixture) =>
      `feature/one # Personal branch # reviewed-main:${fixture.reviewedMain} # reviewed-head:not-a-sha\n`,
    (fixture) =>
      `feature/one # Personal branch # reviewed-main:${fixture.reviewedMain} # reviewed-head:${fixture.reviewedFeatureHead} # reviewed-head:${fixture.reviewedFeatureHead}\n`,
  ]) {
    withFixture({}, (fixture) => {
      writeFileSync(fixture.manifestPath, mutate(fixture));
      const result = runSync(fixture, "--dry-run");
      assert.equal(result.status, 1);
    });
  }

  withFixture({}, (fixture) => {
    const result = runSync(fixture, "--dry-run", "--accept-main-review", fixture.reviewedMain);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must equal current main/);
  });
}, 15_000);

test("keeps patch equivalence as review evidence instead of auto-removing", () => {
  withFixture({ patchEquivalent: true, prState: "OPEN" }, (fixture) => {
    const result = runSync(fixture);

    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stdout, /patch-equivalent commits=1/);
    assert.match(readFileSync(fixture.manifestPath, "utf8"), /feature\/one/);
  });
});

test("still auto-removes a PR whose merge commit is in main", () => {
  withFixture({ prState: "MERGED" }, (fixture) => {
    const result = runSync(fixture);

    assert.equal(result.status, 0, result.stderr);
    const manifest = readFileSync(fixture.manifestPath, "utf8");
    assert.doesNotMatch(manifest, /reviewed-main:/);
    assert.doesNotMatch(manifest, /feature\/one/);
  });
});

test("rebuild rejects an unreviewed main before merging or running npm", () => {
  withFixture({}, (fixture) => {
    const result = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /has not been reviewed against/);
    assert.doesNotMatch(result.stdout, /Merging|Refreshing|npm/);
  });
});

test("rebuild rejects a changed branch head before merging or running npm", () => {
  withFixture({ advanceFeature: true, advanceMain: false }, (fixture) => {
    const result = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /head .* has not completed semantic review/);
    assert.doesNotMatch(result.stdout, /Merging|Refreshing|npm/);
  });
});

test("SHA-pinned rebuild merges retain main and overlay names in product history", () => {
  withFixture({}, (fixture) => {
    const base = git(
      fixture.root,
      "commit-tree",
      `${fixture.reviewedMain}^{tree}`,
      "-p",
      fixture.reviewedMain,
      "-m",
      "persistent base feature",
    );
    git(fixture.root, "update-ref", "refs/heads/rw-base", base);
    writeFileSync(
      fixture.manifestPath,
      readFileSync(fixture.manifestPath, "utf8").replace(
        `reviewed-main:${fixture.reviewedMain}`,
        `reviewed-main:${fixture.currentMain}`,
      ),
    );
    git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
    git(fixture.root, "commit", "-m", "accept current main");
    const result = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    // Dry-run cleanup removes candidate refs, but the reported commit remains readable.
    const candidate = result.stdout.match(/^Final candidate: ([0-9a-f]{40})$/m)?.[1];
    assert.notEqual(candidate, undefined, result.stdout);
    assert.match(
      git(fixture.root, "log", "-1", "--format=%s", candidate),
      /Merge branch 'feature\/one' into rw-main-operation-/,
    );
    assert.match(
      git(fixture.root, "log", "-1", "--format=%s", `${candidate}^1`),
      /Merge branch 'main' into rw-main-operation-/,
    );
    assert.equal(git(fixture.root, "rev-parse", `${candidate}^2`), fixture.featureHead);
    assert.equal(git(fixture.root, "rev-parse", `${candidate}^1^2`), fixture.currentMain);
    assert.equal(git(fixture.root, "rev-parse", "rw-base"), base);
  });
}, 30_000);

test("rebuild preserves a supported overlay conflict and resumes the same operation", () => {
  withFixture({ conflictingOverlay: true }, (fixture) => {
    writeFileSync(
      fixture.manifestPath,
      readFileSync(fixture.manifestPath, "utf8").replace(
        `reviewed-main:${fixture.reviewedMain}`,
        `reviewed-main:${fixture.currentMain}`,
      ),
    );
    git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
    git(fixture.root, "commit", "-m", "accept conflicting overlay");
    const hookLog = path.join(fixture.root, ".git/pre-commit-called");
    const preCommitHook = path.join(fixture.root, ".git/hooks/pre-commit");
    writeFileSync(preCommitHook, `#!/usr/bin/env bash\ntouch '${hookLog}'\nexit 97\n`);
    chmodSync(preCommitHook, 0o755);

    const first = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(first.status, 6, `${first.stdout}\n${first.stderr}`);
    const requestPath = rwMainOperationPath(first);
    const operationDir = path.dirname(requestPath);
    const operationWorktree = path.join(operationDir, "worktree");
    assert.equal(existsSync(path.join(operationDir, "conflict.env")), true);
    assert.match(
      readFileSync(path.join(operationDir, "conflict-review.tsv"), "utf8"),
      new RegExp(`upstream\\tshared\\.txt\\t${fixture.currentMain}\\tTODO`),
    );
    assert.equal(
      readFileSync(path.join(operationWorktree, "shared.txt"), "utf8").includes("<<<<<<<"),
      true,
    );
    assert.equal(git(fixture.root, "branch", "--show-current"), "chore/build-paseo");
    assert.equal(git(fixture.root, "rev-parse", "rw-base"), fixture.currentMain);

    writeFileSync(
      path.join(operationWorktree, "shared.txt"),
      "upstream implementation\nfeature implementation\n",
    );
    git(operationWorktree, "add", "shared.txt");
    completeConflictReview(operationDir, operationWorktree, "kept both behaviors");

    const continued = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(continued.status, 0, `${continued.stdout}\n${continued.stderr}`);
    assert.match(continued.stdout, /Dry run passed/);
    assert.match(
      readFileSync(fixture.npmCallLog, "utf8"),
      /exec -- vitest run (?:\.\/)?shared\.test\.ts --bail=1/,
    );
    assert.equal(existsSync(path.join(fixture.root, ".dev/rw-main-operation")), false);
    assert.equal(existsSync(hookLog), false);
    assert.equal(
      readFileSync(path.join(operationDir, "result"), "utf8").startsWith("completed "),
      true,
    );
    assert.equal(git(fixture.root, "rev-parse", "feature/one"), fixture.featureHead);
    assert.equal(git(fixture.root, "config", "--local", "--get", "rerere.enabled"), "false");

    const unmanagedWorktree = path.join(fixture.root, ".dev/unmanaged-rerere-worktree");
    git(fixture.root, "worktree", "add", "--detach", unmanagedWorktree, fixture.currentMain);
    const unmanagedMerge = run(
      unmanagedWorktree,
      "git",
      ["-c", "core.hooksPath=/dev/null", "merge", "--no-ff", fixture.featureHead],
      fixture.env,
    );
    assert.equal(unmanagedMerge.status, 1, `${unmanagedMerge.stdout}\n${unmanagedMerge.stderr}`);
    assert.match(readFileSync(path.join(unmanagedWorktree, "shared.txt"), "utf8"), /<<<<<<< HEAD/);
    git(unmanagedWorktree, "merge", "--abort");
    git(fixture.root, "worktree", "remove", "--force", unmanagedWorktree);

    git(fixture.root, "gc", "--prune=now");
    const repeated = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(repeated.status, 6, `${repeated.stdout}\n${repeated.stderr}`);
    assert.match(repeated.stdout, /rerere restored file contents/);
    assert.match(repeated.stderr, /Maintenance suggestion: conflict for feature\/one/);
    const historyPath = path.resolve(
      fixture.root,
      git(fixture.root, "rev-parse", "--git-path", "paseo-conflict-history"),
    );
    assert.match(readFileSync(path.join(historyPath, "events.tsv"), "utf8"), /\t2\t1\n$/);
    const repeatedRequest = rwMainOperationPath(repeated);
    const repeatedDir = path.dirname(repeatedRequest);
    const repeatedWorktree = path.join(repeatedDir, "worktree");
    assert.equal(
      readFileSync(path.join(repeatedWorktree, "shared.txt"), "utf8"),
      "upstream implementation\nfeature implementation\n",
    );
    writeFileSync(
      path.join(repeatedWorktree, "shared.txt"),
      "upstream implementation\nfeature implementation\ncorrected cached resolution\n",
    );
    git(repeatedWorktree, "add", "shared.txt");
    completeConflictReview(repeatedDir, repeatedWorktree, "confirmed cached resolution");
    const repeatedContinue = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(
      repeatedContinue.status,
      0,
      `${repeatedContinue.stdout}\n${repeatedContinue.stderr}`,
    );

    const corrected = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(corrected.status, 6, `${corrected.stdout}\n${corrected.stderr}`);
    const correctedRequest = rwMainOperationPath(corrected);
    assert.equal(
      readFileSync(path.join(path.dirname(correctedRequest), "worktree/shared.txt"), "utf8"),
      "upstream implementation\nfeature implementation\ncorrected cached resolution\n",
    );
    const abortCorrected = run(
      fixture.root,
      "bash",
      [
        "dwyanewang/rebuild-rw-main.sh",
        "--build-root",
        fixture.root,
        "--abort-operation",
        correctedRequest,
      ],
      fixture.env,
    );
    assert.equal(abortCorrected.status, 0, abortCorrected.stderr);
    const rrCache = path.resolve(
      fixture.root,
      git(fixture.root, "rev-parse", "--git-path", "rr-cache"),
    );
    rmSync(rrCache, { force: true, recursive: true });
    const missingCache = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(missingCache.status, 6, `${missingCache.stdout}\n${missingCache.stderr}`);
    assert.doesNotMatch(missingCache.stdout, /rerere restored file contents/);
    assert.match(
      readFileSync(
        path.join(path.dirname(rwMainOperationPath(missingCache)), "worktree/shared.txt"),
        "utf8",
      ),
      /<<<<<<< HEAD/,
    );
  });
}, 60_000);

test("managed conflicts preserve an explicitly enabled repository rerere setting", () => {
  withFixture({ conflictingOverlay: true }, (fixture) => {
    writeFileSync(
      fixture.manifestPath,
      readFileSync(fixture.manifestPath, "utf8").replace(
        `reviewed-main:${fixture.reviewedMain}`,
        `reviewed-main:${fixture.currentMain}`,
      ),
    );
    git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
    git(fixture.root, "commit", "-m", "accept conflict with user rerere setting");
    git(fixture.root, "config", "--local", "rerere.enabled", "true");

    const conflict = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(conflict.status, 6, `${conflict.stdout}\n${conflict.stderr}`);
    assert.match(
      conflict.stderr,
      /preserving it while managed merges use command-scoped isolation/,
    );
    assert.equal(git(fixture.root, "config", "--local", "--get", "rerere.enabled"), "true");
    const request = rwMainOperationPath(conflict);
    assert.match(
      readFileSync(path.join(path.dirname(request), "worktree/shared.txt"), "utf8"),
      /<<<<<<< HEAD/,
    );
  });
});

test("reuses an unchanged published rw-main without opening a new conflict operation", () => {
  withFixture({ conflictingOverlay: true }, (fixture) => {
    writeFileSync(
      fixture.manifestPath,
      readFileSync(fixture.manifestPath, "utf8").replace(
        `reviewed-main:${fixture.reviewedMain}`,
        `reviewed-main:${fixture.currentMain}`,
      ),
    );
    git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
    git(fixture.root, "commit", "-m", "accept conflicting overlay");
    const productRoot = `${fixture.root}-product`;
    git(fixture.root, "worktree", "add", "-b", "rw-main", productRoot, "rw-base");
    try {
      const first = run(
        fixture.root,
        "bash",
        [path.join(fixture.root, "dwyanewang/rebuild-rw-main.sh"), "--build-root", productRoot],
        { ...fixture.env, PASEO_TEST_BUILD_ROOT: productRoot },
      );
      assert.equal(first.status, 6, `${first.stdout}\n${first.stderr}`);
      const requestPath = rwMainOperationPath(first);
      const operationDir = path.dirname(requestPath);
      const operationWorktree = path.join(operationDir, "worktree");
      writeFileSync(
        path.join(operationWorktree, "shared.txt"),
        "upstream implementation\nfeature implementation\n",
      );
      git(operationWorktree, "add", "shared.txt");
      completeConflictReview(operationDir, operationWorktree, "preserved both sides");
      const completed = run(
        fixture.root,
        "bash",
        [path.join(fixture.root, "dwyanewang/rebuild-rw-main.sh"), "--build-root", productRoot],
        { ...fixture.env, PASEO_TEST_BUILD_ROOT: productRoot },
      );
      assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);

      const repeated = run(
        fixture.root,
        "bash",
        [path.join(fixture.root, "dwyanewang/rebuild-rw-main.sh"), "--build-root", productRoot],
        { ...fixture.env, PASEO_TEST_BUILD_ROOT: productRoot },
      );
      assert.equal(repeated.status, 0, `${repeated.stdout}\n${repeated.stderr}`);
      assert.match(repeated.stdout, /No-op: rw-base and rw-main already match every input/);
      assert.doesNotMatch(repeated.stdout, /PASEO_RW_MAIN_OPERATION=/);
      assert.equal(existsSync(path.join(productRoot, ".dev/rw-main-operation")), false);
    } finally {
      git(fixture.root, "worktree", "remove", "--force", productRoot);
    }
  });
}, 45_000);

test("records a later overlay already contained by the legal prefix and reuses the published result", () => {
  withFixture({ advanceMain: false }, (fixture) => {
    git(fixture.root, "switch", "main");
    git(fixture.root, "switch", "-c", "feature/two");
    writeFileSync(path.join(fixture.root, "feature-two.txt"), "feature two\n");
    git(fixture.root, "add", "feature-two.txt");
    git(fixture.root, "commit", "-m", "feat: feature two");
    const secondHead = git(fixture.root, "rev-parse", "HEAD");
    git(fixture.root, "switch", "feature/one");
    git(fixture.root, "merge", "--no-ff", "--no-edit", "-m", "merge feature two", "feature/two");
    const firstHead = git(fixture.root, "rev-parse", "HEAD");
    git(fixture.root, "switch", "chore/build-paseo");
    writeFileSync(
      fixture.manifestPath,
      [
        `feature/one # Personal branch # reviewed-main:${fixture.currentMain} # reviewed-head:${firstHead}`,
        `feature/two # Personal branch # reviewed-main:${fixture.currentMain} # reviewed-head:${secondHead}`,
        "",
      ].join("\n"),
    );
    git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
    git(fixture.root, "commit", "-m", "accept contained overlay order");
    const productRoot = `${fixture.root}-contained-product`;
    git(fixture.root, "worktree", "add", "-b", "rw-main", productRoot, "rw-base");
    try {
      const first = run(
        fixture.root,
        "bash",
        [path.join(fixture.root, "dwyanewang/rebuild-rw-main.sh"), "--build-root", productRoot],
        { ...fixture.env, PASEO_TEST_BUILD_ROOT: productRoot },
      );
      assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
      const published = git(fixture.root, "rev-parse", "rw-main");
      assert.equal(git(fixture.root, "rev-parse", `${published}^2`), firstHead);
      assert.equal(
        run(fixture.root, "git", ["merge-base", "--is-ancestor", secondHead, published]).status,
        0,
      );

      const repeated = run(
        fixture.root,
        "bash",
        [path.join(fixture.root, "dwyanewang/rebuild-rw-main.sh"), "--build-root", productRoot],
        { ...fixture.env, PASEO_TEST_BUILD_ROOT: productRoot },
      );
      assert.equal(repeated.status, 0, `${repeated.stdout}\n${repeated.stderr}`);
      assert.match(repeated.stdout, /No-op: rw-base and rw-main already match every input/);
      assert.equal(git(fixture.root, "rev-parse", "rw-main"), published);
      assert.equal(existsSync(path.join(productRoot, ".dev/rw-main-operation")), false);
    } finally {
      git(fixture.root, "worktree", "remove", "--force", productRoot);
    }
  });
}, 45_000);

test("reuses a published base merge that already contains an overlay without peeling base history", () => {
  withFixture({ advanceMain: false }, (fixture) => {
    git(fixture.root, "switch", "rw-base");
    git(
      fixture.root,
      "merge",
      "--no-ff",
      "--no-edit",
      "-m",
      "base includes overlay",
      "feature/one",
    );
    const baseHead = git(fixture.root, "rev-parse", "HEAD");
    assert.equal(git(fixture.root, "rev-parse", `${baseHead}^2`), fixture.featureHead);
    git(fixture.root, "switch", "chore/build-paseo");
    const productRoot = `${fixture.root}-base-product`;
    git(fixture.root, "worktree", "add", "-b", "rw-main", productRoot, "main");
    try {
      const args = [
        path.join(fixture.root, "dwyanewang/rebuild-rw-main.sh"),
        "--build-root",
        productRoot,
      ];
      const env = { ...fixture.env, PASEO_TEST_BUILD_ROOT: productRoot };
      const first = run(fixture.root, "bash", args, env);
      assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
      assert.equal(git(fixture.root, "rev-parse", "rw-main"), baseHead);

      const repeated = run(fixture.root, "bash", args, env);
      assert.equal(repeated.status, 0, `${repeated.stdout}\n${repeated.stderr}`);
      assert.match(repeated.stdout, /No-op: rw-base and rw-main already match every input/);
      assert.doesNotMatch(repeated.stdout, /integration:operation-created/);
      assert.match(repeated.stdout, /^PASEO_RW_MAIN_REBUILT=0$/m);
      assert.equal(git(fixture.root, "rev-parse", "rw-main"), baseHead);
      assert.equal(git(fixture.root, "rev-parse", "rw-base"), baseHead);
      assert.equal(existsSync(path.join(productRoot, ".dev/rw-main-operation")), false);
    } finally {
      git(fixture.root, "worktree", "remove", "--force", productRoot);
    }
  });
}, 30_000);

test("baseline preflight permits review and rebuild resumes sync before the overlay", () => {
  withFixture({ conflictingOverlay: true }, (fixture) => {
    git(fixture.root, "switch", "rw-base");
    git(fixture.root, "reset", "--hard", fixture.reviewedMain);
    writeFileSync(path.join(fixture.root, "shared.txt"), "baseline implementation\n");
    git(fixture.root, "add", "shared.txt");
    git(fixture.root, "commit", "-m", "feat: baseline implementation");
    const baseBefore = git(fixture.root, "rev-parse", "HEAD");
    git(fixture.root, "switch", "chore/build-paseo");
    const review = runSync(fixture, "--check-mergeability");
    assert.equal(review.status, 3, `${review.stdout}\n${review.stderr}`);
    assert.match(readFileSync(reviewRequestPath(review), "utf8"), /feature\/one/);
    assert.equal(git(fixture.root, "rev-parse", "rw-base"), baseBefore);
    assert.equal(git(fixture.root, "rev-parse", "main"), fixture.currentMain);
    const accepted = runSync(fixture, "--accept-review-request", reviewRequestPath(review));
    assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
    git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
    git(fixture.root, "commit", "-m", "accept review despite baseline conflict");
    const args = ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"];
    const sync = run(fixture.root, "bash", args, fixture.env);
    assert.equal(sync.status, 6, `${sync.stdout}\n${sync.stderr}`);
    assert.match(sync.stdout, /PASEO_RW_MAIN_CONFLICT_PHASE=sync/);
    const request = rwMainOperationPath(sync);
    const operationDir = path.dirname(request);
    const worktree = path.join(operationDir, "worktree");
    const combinedBase = "baseline implementation\nupstream implementation\n";
    writeFileSync(path.join(worktree, "shared.txt"), combinedBase);
    git(worktree, "add", "shared.txt");
    completeConflictReview(operationDir, worktree, "preserved baseline and upstream");
    const overlay = run(fixture.root, "bash", args, fixture.env);
    assert.equal(overlay.status, 6, `${overlay.stdout}\n${overlay.stderr}`);
    assert.match(overlay.stdout, /PASEO_RW_MAIN_CONFLICT_PHASE=overlay/);
    assert.equal(rwMainOperationPath(overlay), request);
    const syncedHead = git(worktree, "rev-parse", "HEAD");
    assert.equal(
      git(worktree, "show", "-s", "--format=%P", syncedHead),
      `${baseBefore} ${fixture.currentMain}`,
    );
    assert.equal(existsSync(path.join(operationDir, "conflict-sync-0.env")), true);
    const finalContents = `${combinedBase}feature implementation\n`;
    writeFileSync(path.join(worktree, "shared.txt"), finalContents);
    git(worktree, "add", "shared.txt");
    completeConflictReview(operationDir, worktree, "preserved synced baseline and overlay");
    const completed = run(fixture.root, "bash", args, fixture.env);
    assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
    const candidate = completed.stdout.match(/^Final candidate: ([0-9a-f]{40})$/m)?.[1];
    assert.equal(git(fixture.root, "rev-parse", `${candidate}^1`), syncedHead);
    assert.equal(git(fixture.root, "show", `${candidate}:shared.txt`), finalContents.trim());
    assert.equal(git(fixture.root, "rev-parse", "rw-base"), baseBefore);
    assert.equal(
      (readFileSync(fixture.npmCallLog, "utf8").match(/run build:server-deps/g) ?? []).length,
      1,
    );
  });
}, 45_000);

test("continues through multiple overlay conflicts without rebuilding the completed prefix", () => {
  withFixture({ conflictingOverlay: true }, (fixture) => {
    git(fixture.root, "switch", "main");
    git(fixture.root, "switch", "-c", "feature/two");
    writeFileSync(path.join(fixture.root, "chain.txt"), "feature two\n");
    git(fixture.root, "add", "chain.txt");
    git(fixture.root, "commit", "-m", "feat: second overlay");
    const secondHead = git(fixture.root, "rev-parse", "HEAD");
    git(fixture.root, "switch", "main");
    git(fixture.root, "switch", "-c", "feature/three");
    writeFileSync(path.join(fixture.root, "chain.txt"), "feature three\n");
    git(fixture.root, "add", "chain.txt");
    git(fixture.root, "commit", "-m", "feat: third overlay");
    const thirdHead = git(fixture.root, "rev-parse", "HEAD");
    git(fixture.root, "switch", "chore/build-paseo");
    writeFileSync(
      fixture.manifestPath,
      [
        `feature/one # Personal branch # reviewed-main:${fixture.currentMain} # reviewed-head:${fixture.featureHead}`,
        `feature/two # Personal branch # reviewed-main:${fixture.currentMain} # reviewed-head:${secondHead}`,
        `feature/three # Personal branch # reviewed-main:${fixture.currentMain} # reviewed-head:${thirdHead}`,
        "",
      ].join("\n"),
    );
    git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
    git(fixture.root, "commit", "-m", "accept three overlays");

    const first = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(first.status, 6, `${first.stdout}\n${first.stderr}`);
    const request = rwMainOperationPath(first);
    const operationDir = path.dirname(request);
    const operationWorktree = path.join(operationDir, "worktree");
    writeFileSync(
      path.join(operationWorktree, "shared.txt"),
      "upstream implementation\nfeature implementation\n",
    );
    git(operationWorktree, "add", "shared.txt");
    completeConflictReview(operationDir, operationWorktree, "preserved first overlay and upstream");

    const second = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(second.status, 6, `${second.stdout}\n${second.stderr}`);
    assert.equal(rwMainOperationPath(second), request);
    assert.match(second.stdout, /PASEO_RW_MAIN_CONFLICT_PHASE=overlay/);
    const firstMergeCount = Number(
      git(operationWorktree, "log", "--format=%s")
        .split("\n")
        .filter((line) => line.includes("feature/one")).length,
    );
    assert.equal(firstMergeCount, 1);
    writeFileSync(path.join(operationWorktree, "chain.txt"), "feature two\nfeature three\n");
    git(operationWorktree, "add", "chain.txt");
    completeConflictReview(operationDir, operationWorktree, "preserved both later overlays");
    const completed = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
    assert.equal(
      git(
        fixture.root,
        "show",
        `${completed.stdout.match(/^Final candidate: ([0-9a-f]{40})$/m)?.[1]}:chain.txt`,
      ),
      "feature two\nfeature three",
    );
  });
}, 45_000);

test("rebuild rejects unstaged, untracked, and non-conflict edits while preserving the operation", () => {
  withFixture({ conflictingOverlay: true }, (fixture) => {
    writeFileSync(
      fixture.manifestPath,
      readFileSync(fixture.manifestPath, "utf8").replace(
        `reviewed-main:${fixture.reviewedMain}`,
        `reviewed-main:${fixture.currentMain}`,
      ),
    );
    git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
    git(fixture.root, "commit", "-m", "accept conflicting overlay");
    const first = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(first.status, 6, `${first.stdout}\n${first.stderr}`);
    const requestPath = rwMainOperationPath(first);
    const operationDir = path.dirname(requestPath);
    const operationWorktree = path.join(operationDir, "worktree");
    writeFileSync(path.join(operationWorktree, "shared.txt"), "resolved\n");
    git(operationWorktree, "add", "shared.txt");
    writeFileSync(path.join(operationWorktree, "unrelated.txt"), "not allowed\n");
    completeConflictReview(operationDir, operationWorktree, "reviewed");

    const rejected = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /untracked files/);
    assert.equal(existsSync(requestPath), true);

    rmSync(path.join(operationWorktree, "unrelated.txt"));
    const status = run(
      fixture.root,
      "bash",
      [
        "dwyanewang/rebuild-rw-main.sh",
        "--build-root",
        fixture.root,
        "--operation-status",
        requestPath,
      ],
      fixture.env,
    );
    assert.equal(status.status, 0, `${status.stdout}\n${status.stderr}`);
    assert.match(status.stdout, /PASEO_RW_MAIN_OPERATION_PHASE=conflict/);
    const aborted = run(
      fixture.root,
      "bash",
      [
        "dwyanewang/rebuild-rw-main.sh",
        "--build-root",
        fixture.root,
        "--abort-operation",
        requestPath,
      ],
      fixture.env,
    );
    assert.equal(aborted.status, 0, `${aborted.stdout}\n${aborted.stderr}`);
    assert.equal(existsSync(path.join(fixture.root, ".dev/rw-main-operation")), false);
  });
}, 30_000);

test("rebuild rejects empty conflict explanations and review records for an older staged tree", () => {
  withFixture({ conflictingOverlay: true }, (fixture) => {
    writeFileSync(
      fixture.manifestPath,
      readFileSync(fixture.manifestPath, "utf8").replace(
        `reviewed-main:${fixture.reviewedMain}`,
        `reviewed-main:${fixture.currentMain}`,
      ),
    );
    git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
    git(fixture.root, "commit", "-m", "accept conflicting overlay");
    const first = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(first.status, 6, `${first.stdout}\n${first.stderr}`);
    const operationDir = path.dirname(rwMainOperationPath(first));
    const operationWorktree = path.join(operationDir, "worktree");
    writeFileSync(path.join(operationWorktree, "shared.txt"), "first reviewed resolution\n");
    git(operationWorktree, "add", "shared.txt");
    const stagedTree = git(operationWorktree, "write-tree");
    const reviewPath = path.join(operationDir, "conflict-review.tsv");
    writeFileSync(
      reviewPath,
      readFileSync(reviewPath, "utf8")
        .replace("resolution-tree\tTODO\tTODO", `resolution-tree\t${stagedTree}\treviewed tree`)
        .replaceAll("\tTODO", "\t"),
    );
    const emptyExplanation = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(emptyExplanation.status, 1);
    assert.match(emptyExplanation.stderr, /requires a non-empty explanation/);

    writeFileSync(
      reviewPath,
      readFileSync(reviewPath, "utf8").replace(/\t$/gm, "\tpreserved both parents"),
    );
    writeFileSync(path.join(operationWorktree, "shared.txt"), "changed after review\n");
    git(operationWorktree, "add", "shared.txt");
    const staleTree = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(staleTree.status, 1);
    assert.match(staleTree.stderr, /recorded for staged tree .* current tree is/);
  });
}, 30_000);

test("rebuild rejects an add/add patch resolution that drops either parent's targets", () => {
  withFixture({ patchConflictingOverlay: true }, (fixture) => {
    writeFileSync(
      fixture.manifestPath,
      readFileSync(fixture.manifestPath, "utf8").replace(
        `reviewed-main:${fixture.reviewedMain}`,
        `reviewed-main:${fixture.currentMain}`,
      ),
    );
    git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
    git(fixture.root, "commit", "-m", "accept patch-conflicting overlay");
    const first = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(first.status, 6, `${first.stdout}\n${first.stderr}`);
    const operationDir = path.dirname(rwMainOperationPath(first));
    const operationWorktree = path.join(operationDir, "worktree");
    writeFileSync(
      path.join(operationWorktree, "patches/example+1.0.0.patch"),
      git(fixture.root, "show", "main:patches/example+1.0.0.patch") + "\n",
    );
    git(operationWorktree, "add", "patches/example+1.0.0.patch");
    completeConflictReview(operationDir, operationWorktree, "claimed both patches were preserved");
    const rejected = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /drops patch target from stage 3/);
    assert.match(rejected.stderr, /node_modules\/example\/src\/feature\.ts/);
  });
}, 30_000);

test("candidate test selection runs the complete affected set in audited batches of eight", () => {
  withFixture(
    { conflictingOverlay: true, extraRelatedTests: 8, modifyExtraRelatedTests: true },
    (fixture) => {
      writeFileSync(
        fixture.manifestPath,
        readFileSync(fixture.manifestPath, "utf8").replace(
          `reviewed-main:${fixture.reviewedMain}`,
          `reviewed-main:${fixture.currentMain}`,
        ),
      );
      git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
      git(fixture.root, "commit", "-m", "accept conflicting overlay");
      const first = run(
        fixture.root,
        "bash",
        ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
        fixture.env,
      );
      assert.equal(first.status, 6, `${first.stdout}\n${first.stderr}`);
      const operationDir = path.dirname(rwMainOperationPath(first));
      const operationWorktree = path.join(operationDir, "worktree");
      writeFileSync(
        path.join(operationWorktree, "shared.txt"),
        "upstream implementation\nfeature implementation\n",
      );
      git(operationWorktree, "add", "shared.txt");
      completeConflictReview(operationDir, operationWorktree, "preserved both sides");
      const completed = run(
        fixture.root,
        "bash",
        ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
        fixture.env,
      );
      assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
      const audit = readFileSync(path.join(operationDir, "capability-tests.tsv"), "utf8");
      assert.equal((audit.match(/^candidate-test\t/gm) ?? []).length, 9);
      assert.match(audit, /^batch-size\t8$/m);
      assert.match(audit, /^selected-tests\t9$/m);
      assert.equal((audit.match(/^batch-test\t/gm) ?? []).length, 9);
      assert.match(audit, /toolchain\t[0-9a-f]{64}/);
      assert.match(audit, /dependencies\t[0-9a-f]{64}/);
      assert.match(audit, /executor\t[0-9a-f]{64}/);
      const capabilityCalls = readFileSync(fixture.npmCallLog, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("exec -- vitest run "));
      assert.equal(capabilityCalls.length, 2);
      for (let index = 0; index < 8; index += 1) {
        assert.match(
          capabilityCalls.join("\n"),
          new RegExp(`shared\\.variant-${index}\\.test\\.ts`),
        );
      }
      assert.match(capabilityCalls.join("\n"), /shared\.test\.ts/);
    },
  );
}, 30_000);

test("candidate test selection keeps an audited in-operation path above the total bound", () => {
  withFixture(
    { conflictingOverlay: true, extraRelatedTests: 32, modifyExtraRelatedTests: true },
    (fixture) => {
      writeFileSync(
        fixture.manifestPath,
        readFileSync(fixture.manifestPath, "utf8").replace(
          `reviewed-main:${fixture.reviewedMain}`,
          `reviewed-main:${fixture.currentMain}`,
        ),
      );
      git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
      git(fixture.root, "commit", "-m", "accept oversized related test set");
      const first = run(
        fixture.root,
        "bash",
        ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
        fixture.env,
      );
      assert.equal(first.status, 6, `${first.stdout}\n${first.stderr}`);
      const operationDir = path.dirname(rwMainOperationPath(first));
      const operationWorktree = path.join(operationDir, "worktree");
      writeFileSync(
        path.join(operationWorktree, "shared.txt"),
        "upstream implementation\nfeature implementation\n",
      );
      git(operationWorktree, "add", "shared.txt");
      completeConflictReview(operationDir, operationWorktree, "preserved all related behavior");

      const selectionRequired = run(
        fixture.root,
        "bash",
        ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
        fixture.env,
      );
      assert.equal(
        selectionRequired.status,
        1,
        `${selectionRequired.stdout}\n${selectionRequired.stderr}`,
      );
      assert.match(
        selectionRequired.stderr,
        /33 applicable candidate tests exceed the automatic selection limit 32/,
      );
      assert.match(selectionRequired.stderr, /capability-test-selection\.tsv/);
      assert.match(selectionRequired.stderr, /retry the same request/);
      const selectionPath = path.join(operationDir, "capability-test-selection.tsv");
      const selectionTemplate = readFileSync(selectionPath, "utf8");
      assert.match(selectionTemplate, /^candidate-tree\t[0-9a-f]{40}$/m);
      assert.match(selectionTemplate, /^applicable-set\t[0-9a-f]{64}$/m);
      assert.equal((selectionTemplate.match(/^test\t/gm) ?? []).length, 33);
      writeFileSync(
        selectionPath,
        selectionTemplate.replace(/^test\t([^\t]+)\tTODO\tTODO$/gm, (_line, testPath) =>
          testPath === "shared.variant-31.test.ts"
            ? `test\t${testPath}\tskip\tredundant extended variant reviewed against the direct regression`
            : `test\t${testPath}\trun\trequired candidate regression`,
        ),
      );

      const completed = run(
        fixture.root,
        "bash",
        ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
        fixture.env,
      );
      assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
      const audit = readFileSync(path.join(operationDir, "capability-tests.tsv"), "utf8");
      assert.equal((audit.match(/^candidate-test\t/gm) ?? []).length, 33);
      assert.match(audit, /^applicable-tests\t33$/m);
      assert.match(audit, /^selected-tests\t32$/m);
      assert.equal((audit.match(/^batch-test\t/gm) ?? []).length, 32);
      assert.match(
        audit,
        /coverage-gap\tshared\.variant-31\.test\.ts\treviewed-skip:redundant extended variant/,
      );
      const calls = readFileSync(fixture.npmCallLog, "utf8");
      assert.doesNotMatch(calls, /exec -- vitest run .*shared\.variant-31\.test\.ts/);
      assert.equal((calls.match(/exec -- vitest run/g) ?? []).length, 4);
    },
  );
}, 30_000);

test("unmodified same-prefix and unsafe neighboring tests do not overflow the candidate set", () => {
  withFixture(
    {
      conflictingOverlay: true,
      excludedRelatedTests: true,
      extraRelatedTests: 33,
    },
    (fixture) => {
      writeFileSync(
        fixture.manifestPath,
        readFileSync(fixture.manifestPath, "utf8").replace(
          `reviewed-main:${fixture.reviewedMain}`,
          `reviewed-main:${fixture.currentMain}`,
        ),
      );
      git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
      git(fixture.root, "commit", "-m", "accept dense neighboring test directory");
      const first = run(
        fixture.root,
        "bash",
        ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
        fixture.env,
      );
      assert.equal(first.status, 6, `${first.stdout}\n${first.stderr}`);
      const operationDir = path.dirname(rwMainOperationPath(first));
      const operationWorktree = path.join(operationDir, "worktree");
      writeFileSync(
        path.join(operationWorktree, "shared.txt"),
        "upstream implementation\nfeature implementation\n",
      );
      git(operationWorktree, "add", "shared.txt");
      completeConflictReview(operationDir, operationWorktree, "preserved both sides");

      const completed = run(
        fixture.root,
        "bash",
        ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
        fixture.env,
      );
      assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
      const audit = readFileSync(path.join(operationDir, "capability-tests.tsv"), "utf8");
      assert.equal((audit.match(/^candidate-test\t/gm) ?? []).length, 1);
      assert.match(audit, /^candidate-test\tshared\.test\.ts\t1\tdirect:shared\.txt/m);
      assert.doesNotMatch(audit, /candidate-test\tshared\.variant-/);
      assert.equal((audit.match(/^excluded-test\tshared\./gm) ?? []).length, 4);
      assert.match(audit, /excluded-test\tshared\.e2e\.test\.ts\te2e-daemon:/);
      assert.match(audit, /excluded-test\tshared\.browser\.test\.ts\tbrowser:/);
      assert.match(audit, /excluded-test\tshared\.real\.e2e\.test\.ts\treal-provider:/);
      assert.match(audit, /excluded-test\tshared\.local\.e2e\.test\.ts\tlocal-resource:/);
      const calls = readFileSync(fixture.npmCallLog, "utf8");
      assert.match(calls, /exec -- vitest run shared\.test\.ts --bail=1/);
      assert.doesNotMatch(calls, /variant-|e2e|browser|real|local/);
    },
  );
}, 30_000);

test("candidate test selection excludes unrelated tests from conflict source ranges", () => {
  withFixture({ conflictingOverlay: true, unrelatedTests: 9 }, (fixture) => {
    writeFileSync(
      fixture.manifestPath,
      readFileSync(fixture.manifestPath, "utf8").replace(
        `reviewed-main:${fixture.reviewedMain}`,
        `reviewed-main:${fixture.currentMain}`,
      ),
    );
    git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
    git(fixture.root, "commit", "-m", "accept conflict with unrelated overlay tests");
    const first = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(first.status, 6, `${first.stdout}\n${first.stderr}`);
    const operationDir = path.dirname(rwMainOperationPath(first));
    const operationWorktree = path.join(operationDir, "worktree");
    writeFileSync(
      path.join(operationWorktree, "shared.txt"),
      "upstream implementation\nfeature implementation\n",
    );
    git(operationWorktree, "add", "shared.txt");
    completeConflictReview(operationDir, operationWorktree, "preserved both sides");

    const completed = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
    const audit = readFileSync(path.join(operationDir, "capability-tests.tsv"), "utf8");
    assert.equal((audit.match(/^candidate-test\t/gm) ?? []).length, 1);
    assert.match(audit, /^candidate-test\tshared\.test\.ts\t1\t/m);
    assert.doesNotMatch(audit, /unrelated\/widget-/);
    assert.equal((audit.match(/direct:shared\.txt/g) ?? []).length, 1);
    assert.doesNotMatch(audit, /^candidate-test\t\.\//m);
    const calls = readFileSync(fixture.npmCallLog, "utf8");
    assert.match(calls, /exec -- vitest run shared\.test\.ts --bail=1/);
    assert.doesNotMatch(calls, /unrelated\/widget-/);
  });
}, 30_000);

test("candidate test selection records platform applicability and runs only applicable variants", () => {
  withFixture({ conflictingOverlay: true, platformRelatedTests: true }, (fixture) => {
    writeFileSync(
      fixture.manifestPath,
      readFileSync(fixture.manifestPath, "utf8").replace(
        `reviewed-main:${fixture.reviewedMain}`,
        `reviewed-main:${fixture.currentMain}`,
      ),
    );
    git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
    git(fixture.root, "commit", "-m", "accept platform-specific conflict coverage");
    const first = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(first.status, 6, `${first.stdout}\n${first.stderr}`);
    const operationDir = path.dirname(rwMainOperationPath(first));
    const operationWorktree = path.join(operationDir, "worktree");
    writeFileSync(
      path.join(operationWorktree, "shared.txt"),
      "upstream implementation\nfeature implementation\n",
    );
    git(operationWorktree, "add", "shared.txt");
    completeConflictReview(operationDir, operationWorktree, "preserved both platforms");
    fixture.env.PASEO_TEST_PLATFORM = "Linux";
    const completed = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
    const audit = readFileSync(path.join(operationDir, "capability-tests.tsv"), "utf8");
    assert.match(audit, /candidate-test\t(?:\.\/)?shared\.posix\.test\.ts\t1\t/);
    assert.match(audit, /candidate-test\t(?:\.\/)?shared\.windows-shell\.test\.ts\t0\t/);
    const calls = readFileSync(fixture.npmCallLog, "utf8");
    assert.match(calls, /shared\.posix\.test\.ts/);
    assert.doesNotMatch(calls, /shared\.windows-shell\.test\.ts/);
  });
}, 30_000);

test("candidate tests use each workspace's actual Vitest configuration", () => {
  const cases = [
    {
      conflictPath: "packages/app/src/command-center/registry.ts",
      expectedAudit: /packages\/app\?project=unit\tsrc\/command-center\/registry\.test\.ts/,
      expectedCall:
        /\/packages\/app\|exec -- vitest run --project unit src\/command-center\/registry\.test\.ts --bail=1/,
    },
    {
      conflictPath: "packages/server/src/runtime/session.ts",
      expectedAudit: /packages\/server\tsrc\/runtime\/session\.test\.ts/,
      expectedCall:
        /\/packages\/server\|exec -- vitest run src\/runtime\/session\.test\.ts --bail=1/,
    },
    {
      conflictPath: "packages/protocol/src/messages.ts",
      expectedAudit: /\.\tpackages\/protocol\/src\/messages\.test\.ts/,
      expectedCall:
        /paseo-rw-main-review-[^|]+\|exec -- vitest run packages\/protocol\/src\/messages\.test\.ts --bail=1/,
    },
  ];
  for (const testCase of cases) {
    withFixture({ conflictingOverlay: true, conflictPath: testCase.conflictPath }, (fixture) => {
      const { completed, operationDir } = completeReviewedConflict(fixture);
      assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
      const audit = readFileSync(path.join(operationDir, "capability-tests.tsv"), "utf8");
      assert.match(audit, testCase.expectedAudit);
      const cwdCalls = readFileSync(fixture.npmCwdCallLog, "utf8");
      assert.match(cwdCalls, testCase.expectedCall);
      assert.doesNotMatch(cwdCalls, /browser|e2e|real|local/);
    });
  }
}, 45_000);

test("candidate capability checks record a coverage gap when no related test exists", () => {
  withFixture({ conflictingOverlay: true, withoutRelatedTest: true }, (fixture) => {
    writeFileSync(
      fixture.manifestPath,
      readFileSync(fixture.manifestPath, "utf8").replace(
        `reviewed-main:${fixture.reviewedMain}`,
        `reviewed-main:${fixture.currentMain}`,
      ),
    );
    git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
    git(fixture.root, "commit", "-m", "accept conflict without adjacent test");
    const first = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(first.status, 6, `${first.stdout}\n${first.stderr}`);
    const operationDir = path.dirname(rwMainOperationPath(first));
    const operationWorktree = path.join(operationDir, "worktree");
    writeFileSync(
      path.join(operationWorktree, "shared.txt"),
      "upstream implementation\nfeature implementation\n",
    );
    git(operationWorktree, "add", "shared.txt");
    completeConflictReview(operationDir, operationWorktree, "reviewed without a nearby test");
    const completed = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
    assert.match(
      completed.stdout,
      /No related candidate tests were found; recording the coverage gap/,
    );
    assert.doesNotMatch(readFileSync(fixture.npmCallLog, "utf8"), /exec -- vitest run/);
  });
}, 30_000);

test("changed declared dependencies trigger candidate tests and block on a regression", () => {
  withFixture({ advanceMain: false, extraRelatedTests: 33, secondBranch: true }, (fixture) => {
    git(fixture.root, "switch", "feature/two");
    writeFileSync(
      path.join(fixture.root, "feature-two.test.ts"),
      "// dependent regression changed\n",
    );
    git(fixture.root, "add", "feature-two.test.ts");
    git(fixture.root, "commit", "-m", "test: change dependent regression");
    const dependentHead = git(fixture.root, "rev-parse", "HEAD");
    git(fixture.root, "switch", "chore/build-paseo");
    writeFileSync(
      fixture.manifestPath,
      readFileSync(fixture.manifestPath, "utf8").replace(
        `feature/two # Personal branch # reviewed-main:${fixture.currentMain} # reviewed-head:${fixture.secondFeatureHead}`,
        `feature/two # Personal branch # depends-on:feature/one # reviewed-main:${fixture.currentMain} # reviewed-head:${dependentHead}`,
      ),
    );
    git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
    git(fixture.root, "commit", "-m", "accept changed dependent inputs");
    fixture.env.PASEO_TEST_CAPABILITY_EXIT = "23";

    const rejected = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(rejected.status, 1, `${rejected.stdout}\n${rejected.stderr}`);
    assert.match(rejected.stderr, /candidate capability tests failed with exit 23/);
    assert.match(
      readFileSync(fixture.npmCallLog, "utf8"),
      /exec -- vitest run .*feature-two\.test\.ts/,
    );
    assert.doesNotMatch(readFileSync(fixture.npmCallLog, "utf8"), /shared\.test\.ts/);
    assert.doesNotMatch(readFileSync(fixture.npmCallLog, "utf8"), /shared\.variant-/);
    assert.equal(existsSync(path.join(fixture.root, ".dev/rw-main-operation")), true);
  });
}, 30_000);

test("reviewed selection can retain more than 32 mandatory direct tests without aborting", () => {
  withFixture({ advanceMain: false, secondBranch: true }, (fixture) => {
    git(fixture.root, "switch", "feature/two");
    for (let index = 0; index < 33; index += 1) {
      writeFileSync(path.join(fixture.root, `dependency-${index}.ts`), `// source ${index}\n`);
      writeFileSync(
        path.join(fixture.root, `dependency-${index}.test.ts`),
        `// regression ${index}\n`,
      );
    }
    git(fixture.root, "add", ".");
    git(fixture.root, "commit", "-m", "feat: change dependency sources and tests");
    const head = git(fixture.root, "rev-parse", "HEAD");
    git(fixture.root, "switch", "chore/build-paseo");
    writeFileSync(
      fixture.manifestPath,
      readFileSync(fixture.manifestPath, "utf8").replace(
        `feature/two # Personal branch # reviewed-main:${fixture.currentMain} # reviewed-head:${fixture.secondFeatureHead}`,
        `feature/two # Personal branch # depends-on:feature/one # reviewed-main:${fixture.currentMain} # reviewed-head:${head}`,
      ),
    );
    git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
    git(fixture.root, "commit", "-m", "accept changed dependency");
    const args = ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"];
    const first = run(fixture.root, "bash", args, fixture.env);
    assert.equal(first.status, 1, `${first.stdout}\n${first.stderr}`);
    assert.match(first.stderr, /33 applicable candidate tests exceed/);
    const request = readFileSync(path.join(fixture.root, ".dev/rw-main-operation"), "utf8").trim();
    const operationDir = path.dirname(request);
    const selectionPath = path.join(operationDir, "capability-test-selection.tsv");
    const template = readFileSync(selectionPath, "utf8");
    writeFileSync(
      selectionPath,
      template.replace(
        /^test\t([^\t]+)\tTODO\tTODO$/gm,
        "test\t$1\tskip\tclaimed redundant direct coverage",
      ),
    );
    const rejected = run(fixture.root, "bash", args, fixture.env);
    assert.equal(rejected.status, 1, `${rejected.stdout}\n${rejected.stderr}`);
    assert.match(rejected.stderr, /direct capability test cannot be skipped/);
    writeFileSync(
      selectionPath,
      template.replace(
        /^test\t([^\t]+)\tTODO\tTODO$/gm,
        "test\t$1\trun\tnecessary direct regression; reviewed extra runtime",
      ),
    );
    const completed = run(fixture.root, "bash", args, fixture.env);
    assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
    const audit = readFileSync(path.join(operationDir, "capability-tests.tsv"), "utf8");
    assert.match(audit, /^selected-tests\t33$/m);
    const calls = readFileSync(fixture.npmCallLog, "utf8");
    assert.equal((calls.match(/exec -- vitest run/g) ?? []).length, 5);
    assert.equal((calls.match(/run build:server-deps/g) ?? []).length, 1);
  });
}, 90_000);

test("capability tests cannot publish a dirty candidate or cache it as passing", () => {
  withFixture({ conflictingOverlay: true }, (fixture) => {
    fixture.env.PASEO_TEST_CAPABILITY_DIRTY = "1";
    const { completed, operationDir } = completeReviewedConflict(fixture);
    assert.equal(completed.status, 1, `${completed.stdout}\n${completed.stderr}`);
    assert.match(completed.stderr, /candidate capability tests left tracked or untracked changes/);
    assert.equal(existsSync(path.join(operationDir, "capability-tests.pass")), false);
    assert.equal(git(fixture.root, "rev-parse", "rw-base"), fixture.currentMain);
    assert.equal(
      run(fixture.root, "git", ["show-ref", "--verify", "refs/heads/rw-main"]).status,
      128,
    );
    assert.match(
      readFileSync(path.join(fixture.root, "seed.txt"), "utf8"),
      /test changed a tracked file/,
    );
  });
}, 30_000);

for (const extraRelatedTests of [0, 7]) {
  test(`publishing capability failure preserves abort protection with ${extraRelatedTests + 1} tests`, () => {
    withFixture(
      { conflictingOverlay: true, extraRelatedTests, modifyExtraRelatedTests: true },
      (fixture) => {
        const origin = path.join(fixture.root, ".git", "origin.git");
        git(fixture.root, "init", "--bare", origin);
        git(fixture.root, "remote", "add", "origin", origin);
        git(fixture.root, "branch", "rw-main", "rw-base");
        git(fixture.root, "push", "origin", "main", "rw-base", "rw-main");
        writeFileSync(
          fixture.manifestPath,
          readFileSync(fixture.manifestPath, "utf8").replace(
            `reviewed-main:${fixture.reviewedMain}`,
            `reviewed-main:${fixture.currentMain}`,
          ),
        );
        git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
        git(fixture.root, "commit", "-m", "accept conflict for publication recovery");
        const args = ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--push"];
        const first = run(fixture.root, "bash", args, fixture.env);
        assert.equal(first.status, 6, `${first.stdout}\n${first.stderr}`);
        const request = rwMainOperationPath(first);
        const operationDir = path.dirname(request);
        const worktree = path.join(operationDir, "worktree");
        writeFileSync(
          path.join(worktree, "shared.txt"),
          "upstream implementation\nfeature implementation\n",
        );
        git(worktree, "add", "shared.txt");
        completeConflictReview(operationDir, worktree, "preserved upstream and feature");
        fixture.env.PASEO_TEST_INTERRUPT_AFTER_PUSH = "1";
        const pushed = run(fixture.root, "bash", args, fixture.env);
        assert.equal(pushed.status, 92, `${pushed.stdout}\n${pushed.stderr}`);
        const remoteHead = git(origin, "rev-parse", "rw-main");
        assert.notEqual(remoteHead, fixture.currentMain);
        const progressPath = path.join(operationDir, "progress.env");
        const publishedProgress = readFileSync(progressPath, "utf8");
        assert.match(publishedProgress, /rw_main_operation_remote_published=1/);
        delete fixture.env.PASEO_TEST_INTERRUPT_AFTER_PUSH;
        fixture.env.PASEO_TEST_PLATFORM = "Darwin";
        fixture.env.PASEO_TEST_CAPABILITY_EXIT = "23";
        const failed = run(fixture.root, "bash", args, fixture.env);
        assert.equal(failed.status, 1, `${failed.stdout}\n${failed.stderr}`);
        assert.match(failed.stderr, /candidate capability tests failed with exit 23/);
        assert.equal(readFileSync(progressPath, "utf8"), publishedProgress);
        assert.equal(git(fixture.root, "rev-parse", "rw-main"), fixture.currentMain);
        const aborted = run(
          fixture.root,
          "bash",
          [
            "dwyanewang/rebuild-rw-main.sh",
            "--build-root",
            fixture.root,
            "--abort-operation",
            request,
          ],
          fixture.env,
        );
        assert.equal(aborted.status, 1, `${aborted.stdout}\n${aborted.stderr}`);
        assert.match(aborted.stderr, /publication may have started/);
        assert.equal(existsSync(worktree), true);
        assert.equal(git(origin, "rev-parse", "rw-main"), remoteHead);
        delete fixture.env.PASEO_TEST_CAPABILITY_EXIT;
        const resumed = run(fixture.root, "bash", args, fixture.env);
        assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
        assert.match(resumed.stdout, /Remote publication already completed/);
        assert.equal(git(fixture.root, "rev-parse", "rw-main"), remoteHead);
        assert.equal(git(origin, "rev-parse", "rw-main"), remoteHead);
      },
    );
  }, 60_000);
}

for (const [conflictPath, excludedReason] of [
  ["packages/cli/tests/command.ts", "cli-script-runner"],
  ["packages/app/plugins/with-paste-input.ts", "outside-app-unit-include"],
  ["packages/app/e2e/support/helpers/stream-smoothness.ts", "outside-app-unit-include"],
]) {
  test(`candidate selection excludes non-unit runner paths: ${conflictPath}`, () => {
    withFixture({ conflictingOverlay: true, conflictPath }, (fixture) => {
      const { completed, operationDir } = completeReviewedConflict(fixture);
      assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
      const audit = readFileSync(path.join(operationDir, "capability-tests.tsv"), "utf8");
      assert.match(audit, new RegExp(`coverage-gap\\t.*excluded:${excludedReason}:`));
      assert.match(audit, /^selected-tests\t0$/m);
      assert.doesNotMatch(readFileSync(fixture.npmCallLog, "utf8"), /exec -- vitest run/);
    });
  }, 30_000);
}

test("candidate selection excludes Node test runner files and retains related Vitest tests", () => {
  withFixture(
    { conflictingOverlay: true, conflictPath: "scripts/release-version-utils.mjs" },
    (fixture) => {
      const nodeTests = [
        ["scripts/release-version-utils.test.mjs", 'import test from "node:test";\n'],
        [
          "scripts/release-version-utils.posix.test.mjs",
          'import {\n  test,\n} from "node:test";\n',
        ],
        [
          "scripts/release-version-utils.commonjs.test.cjs",
          "const { test } = require('node:test');\n",
        ],
      ];
      git(fixture.root, "switch", "feature/one");
      for (const [testPath, content] of nodeTests) {
        writeFileSync(path.join(fixture.root, testPath), content);
        git(fixture.root, "add", testPath);
      }
      const vitestPath = "scripts/release-version-utils.test.ts";
      writeFileSync(
        path.join(fixture.root, vitestPath),
        'import { test, expect } from "vitest";\ntest("runner label", () => expect("node:test").toBeTruthy());\n',
      );
      git(fixture.root, "add", vitestPath);
      git(fixture.root, "commit", "-m", "test: separate Node and Vitest regression files");
      const head = git(fixture.root, "rev-parse", "HEAD");
      git(fixture.root, "switch", "chore/build-paseo");
      writeFileSync(
        fixture.manifestPath,
        readFileSync(fixture.manifestPath, "utf8").replace(
          `reviewed-head:${fixture.featureHead}`,
          `reviewed-head:${head}`,
        ),
      );
      const { completed, operationDir } = completeReviewedConflict(fixture);
      assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
      const audit = readFileSync(path.join(operationDir, "capability-tests.tsv"), "utf8");
      const calls = readFileSync(fixture.npmCallLog, "utf8");
      for (const [testPath] of nodeTests) {
        assert.ok(audit.includes(`excluded-test\t${testPath}\tnode-test-runner:`), audit);
        assert.ok(audit.includes(`coverage-gap\t${testPath}\texcluded:node-test-runner:`), audit);
        assert.equal(calls.includes(testPath), false, calls);
      }
      assert.match(audit, /^selected-tests\t1$/m);
      assert.match(calls, /exec -- vitest run scripts\/release-version-utils\.test\.ts --bail=1/);
    },
  );
}, 30_000);

test("candidate selection retains the app native release version unit include", () => {
  withFixture(
    { conflictingOverlay: true, conflictPath: "packages/app/native-release-version.ts" },
    (fixture) => {
      git(fixture.root, "switch", "feature/one");
      writeFileSync(
        path.join(fixture.root, "packages/app/vitest.config.ts"),
        'export default { test: { projects: [{ test: { name: "unit", include: ["src/**/*.{test,spec}.{ts,tsx}", "native-release-version.test.ts"] } }] } };\n',
      );
      git(fixture.root, "add", "packages/app/vitest.config.ts");
      git(fixture.root, "commit", "-m", "test: include native release version in app unit tests");
      const head = git(fixture.root, "rev-parse", "HEAD");
      git(fixture.root, "switch", "chore/build-paseo");
      writeFileSync(
        fixture.manifestPath,
        readFileSync(fixture.manifestPath, "utf8").replace(
          `reviewed-head:${fixture.featureHead}`,
          `reviewed-head:${head}`,
        ),
      );
      const { completed, operationDir } = completeReviewedConflict(fixture);
      assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
      const audit = readFileSync(path.join(operationDir, "capability-tests.tsv"), "utf8");
      assert.match(audit, /^selected-tests\t1$/m);
      assert.match(
        audit,
        /^candidate-test\tpackages\/app\/native-release-version\.test\.ts\t1\t[^\t]+\t1\tpackages\/app\?project=unit\tnative-release-version\.test\.ts$/m,
      );
      assert.doesNotMatch(audit, /outside-app-unit-include/);
      assert.match(
        readFileSync(fixture.npmCwdCallLog, "utf8"),
        /\/packages\/app\|exec -- vitest run --project unit native-release-version\.test\.ts --bail=1/,
      );
    },
  );
}, 30_000);

test("candidate selection excludes a same-name non-Vitest test asset", () => {
  withFixture(
    { conflictingOverlay: true, conflictPath: "pkg/source.ts", withoutRelatedTest: true },
    (fixture) => {
      git(fixture.root, "switch", "feature/one");
      writeFileSync(path.join(fixture.root, "pkg/source.test.json"), '{"fixture":true}\n');
      git(fixture.root, "add", "pkg/source.test.json");
      git(fixture.root, "commit", "-m", "test: add a data fixture beside the source");
      const head = git(fixture.root, "rev-parse", "HEAD");
      git(fixture.root, "switch", "chore/build-paseo");
      writeFileSync(
        fixture.manifestPath,
        readFileSync(fixture.manifestPath, "utf8").replace(
          `reviewed-head:${fixture.featureHead}`,
          `reviewed-head:${head}`,
        ),
      );
      const { completed, operationDir } = completeReviewedConflict(fixture);
      assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
      const audit = readFileSync(path.join(operationDir, "capability-tests.tsv"), "utf8");
      assert.match(audit, /excluded-test\tpkg\/source\.test\.json\tunsupported-vitest-extension:/);
      assert.match(audit, /^selected-tests\t0$/m);
      assert.doesNotMatch(readFileSync(fixture.npmCallLog, "utf8"), /exec -- vitest run/);
    },
  );
}, 30_000);

test("capability failure reuses completed readiness and PASS invalidates on platform input", () => {
  withFixture({ conflictingOverlay: true }, (fixture) => {
    writeFileSync(
      fixture.manifestPath,
      readFileSync(fixture.manifestPath, "utf8").replace(
        `reviewed-main:${fixture.reviewedMain}`,
        `reviewed-main:${fixture.currentMain}`,
      ),
    );
    git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
    git(fixture.root, "commit", "-m", "accept conflicting overlay");
    const first = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(first.status, 6, `${first.stdout}\n${first.stderr}`);
    const operationDir = path.dirname(rwMainOperationPath(first));
    const operationWorktree = path.join(operationDir, "worktree");
    writeFileSync(
      path.join(operationWorktree, "shared.txt"),
      "upstream implementation\nfeature implementation\n",
    );
    git(operationWorktree, "add", "shared.txt");
    completeConflictReview(operationDir, operationWorktree, "preserved both sides");
    fixture.env.PASEO_TEST_CAPABILITY_EXIT = "23";
    const failed = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(failed.status, 1, `${failed.stdout}\n${failed.stderr}`);
    assert.match(failed.stderr, /candidate capability tests failed with exit 23/);
    const firstCalls = readFileSync(fixture.npmCallLog, "utf8");
    assert.equal((firstCalls.match(/exec -- vitest run/g) ?? []).length, 1);
    assert.ok(
      firstCalls.indexOf("run build --workspace=@getpaseo/cli") <
        firstCalls.indexOf("exec -- vitest run"),
    );
    const readinessBuilds = (firstCalls.match(/run build:server-deps/g) ?? []).length;

    delete fixture.env.PASEO_TEST_CAPABILITY_EXIT;
    fixture.env.PASEO_TEST_INTERRUPT_AFTER_CAPABILITY_CHECKS = "1";
    const resumed = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(resumed.status, 97, `${resumed.stdout}\n${resumed.stderr}`);
    assert.match(resumed.stdout, /Reusing trusted readiness validation/);
    const afterPassCalls = readFileSync(fixture.npmCallLog, "utf8");
    assert.equal((afterPassCalls.match(/run build:server-deps/g) ?? []).length, readinessBuilds);
    assert.equal((afterPassCalls.match(/exec -- vitest run/g) ?? []).length, 2);

    delete fixture.env.PASEO_TEST_INTERRUPT_AFTER_CAPABILITY_CHECKS;
    fixture.env.PASEO_TEST_PLATFORM = "MINGW64_NT";
    const platformChanged = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(platformChanged.status, 0, `${platformChanged.stdout}\n${platformChanged.stderr}`);
    assert.match(platformChanged.stdout, /Reusing trusted readiness validation/);
    const allCalls = readFileSync(fixture.npmCallLog, "utf8");
    assert.equal((allCalls.match(/run build:server-deps/g) ?? []).length, readinessBuilds);
    assert.equal((allCalls.match(/exec -- vitest run/g) ?? []).length, 3);
    assert.doesNotMatch(platformChanged.stdout, /Reusing candidate capability tests/);
  });
}, 30_000);

test("operation status and abort remain available after an overlay source head advances", () => {
  withFixture({ conflictingOverlay: true }, (fixture) => {
    writeFileSync(
      fixture.manifestPath,
      readFileSync(fixture.manifestPath, "utf8").replace(
        `reviewed-main:${fixture.reviewedMain}`,
        `reviewed-main:${fixture.currentMain}`,
      ),
    );
    git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
    git(fixture.root, "commit", "-m", "accept conflicting overlay");
    const first = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(first.status, 6, `${first.stdout}\n${first.stderr}`);
    const requestPath = rwMainOperationPath(first);
    git(fixture.root, "switch", "feature/one");
    writeFileSync(path.join(fixture.root, "advanced.txt"), "source advanced during pause\n");
    git(fixture.root, "add", "advanced.txt");
    git(fixture.root, "commit", "-m", "feat: advance paused source");
    git(fixture.root, "switch", "chore/build-paseo");

    const status = run(
      fixture.root,
      "bash",
      [
        "dwyanewang/rebuild-rw-main.sh",
        "--build-root",
        fixture.root,
        "--operation-status",
        requestPath,
      ],
      fixture.env,
    );
    assert.equal(status.status, 0, `${status.stdout}\n${status.stderr}`);
    assert.match(status.stdout, /PASEO_RW_MAIN_OPERATION_ACTIVE=1/);
    const aborted = run(
      fixture.root,
      "bash",
      [
        "dwyanewang/rebuild-rw-main.sh",
        "--build-root",
        fixture.root,
        "--abort-operation",
        requestPath,
      ],
      fixture.env,
    );
    assert.equal(aborted.status, 0, `${aborted.stdout}\n${aborted.stderr}`);
    assert.equal(existsSync(path.join(fixture.root, ".dev/rw-main-operation")), false);
  });
}, 30_000);

test("aborting a completed old request cannot remove a newer active operation index", () => {
  withFixture({ conflictingOverlay: true }, (fixture) => {
    writeFileSync(
      fixture.manifestPath,
      readFileSync(fixture.manifestPath, "utf8").replace(
        `reviewed-main:${fixture.reviewedMain}`,
        `reviewed-main:${fixture.currentMain}`,
      ),
    );
    git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
    git(fixture.root, "commit", "-m", "accept conflicting overlay");
    const first = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(first.status, 6, `${first.stdout}\n${first.stderr}`);
    const oldRequest = rwMainOperationPath(first);
    const oldDir = path.dirname(oldRequest);
    const oldWorktree = path.join(oldDir, "worktree");
    writeFileSync(
      path.join(oldWorktree, "shared.txt"),
      "upstream implementation\nfeature implementation\n",
    );
    git(oldWorktree, "add", "shared.txt");
    completeConflictReview(oldDir, oldWorktree, "preserved both sides");
    const completed = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
    const second = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(second.status, 6, `${second.stdout}\n${second.stderr}`);
    const activeRequest = rwMainOperationPath(second);
    const abortedOld = run(
      fixture.root,
      "bash",
      [
        "dwyanewang/rebuild-rw-main.sh",
        "--build-root",
        fixture.root,
        "--abort-operation",
        oldRequest,
      ],
      fixture.env,
    );
    assert.equal(abortedOld.status, 1);
    assert.match(abortedOld.stderr, /completed operation cannot be aborted/);
    assert.equal(
      readFileSync(path.join(fixture.root, ".dev/rw-main-operation"), "utf8").trim(),
      activeRequest,
    );
    assert.equal(existsSync(path.join(path.dirname(activeRequest), "worktree")), true);
  });
}, 45_000);

test("rebuild recovers a completed overlay merge when interrupted before progress is written", () => {
  withFixture({ advanceMain: false }, (fixture) => {
    fixture.env.PASEO_TEST_INTERRUPT_AFTER_MERGE_COMMIT_BEFORE_RECORD = "overlay:0";
    const interrupted = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(interrupted.status, 91, `${interrupted.stdout}\n${interrupted.stderr}`);
    assert.equal(existsSync(fixture.npmCallLog), false);
    const requestPath = readFileSync(
      path.join(fixture.root, ".dev/rw-main-operation"),
      "utf8",
    ).trim();
    const operationDir = path.dirname(requestPath);
    const operationWorktree = path.join(operationDir, "worktree");
    const committed = git(operationWorktree, "rev-parse", "HEAD");
    const commitCount = git(operationWorktree, "rev-list", "--count", "HEAD");
    assert.equal(existsSync(path.join(operationDir, "merge-intent-overlay-0.env")), true);
    assert.equal(existsSync(path.join(operationDir, "merge-completed-overlay-0.env")), false);
    delete fixture.env.PASEO_TEST_INTERRUPT_AFTER_MERGE_COMMIT_BEFORE_RECORD;
    const resumed = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
    const candidate = resumed.stdout.match(/^Final candidate: ([0-9a-f]{40})$/m)?.[1];
    assert.notEqual(candidate, undefined, resumed.stdout);
    assert.equal(candidate, committed);
    assert.equal(git(fixture.root, "rev-list", "--count", candidate), commitCount);
    assert.equal(existsSync(path.join(operationDir, "merge-completed-overlay-0.env")), true);
    assert.equal(git(fixture.root, "rev-parse", `${candidate}^2`), fixture.featureHead);
  });
}, 30_000);

test("rebuild recovers a clean overlay merge interrupted before its expected tree is journaled", () => {
  withFixture({ advanceMain: false }, (fixture) => {
    fixture.env.PASEO_TEST_INTERRUPT_AFTER_MERGE_BEFORE_TREE_INTENT = "overlay:0";
    const interrupted = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(interrupted.status, 90, `${interrupted.stdout}\n${interrupted.stderr}`);
    const operationDir = path.dirname(
      readFileSync(path.join(fixture.root, ".dev/rw-main-operation"), "utf8").trim(),
    );
    const operationWorktree = path.join(operationDir, "worktree");
    const before = git(operationWorktree, "rev-parse", "HEAD");
    const stagedTree = git(operationWorktree, "write-tree");
    assert.equal(git(operationWorktree, "rev-parse", "MERGE_HEAD"), fixture.featureHead);
    assert.match(
      readFileSync(path.join(operationDir, "merge-intent-overlay-0.env"), "utf8"),
      /merge_intent_tree=''$/m,
    );
    assert.equal(existsSync(path.join(operationDir, "merge-completed-overlay-0.env")), false);
    delete fixture.env.PASEO_TEST_INTERRUPT_AFTER_MERGE_BEFORE_TREE_INTENT;

    const resumed = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
    const candidate = resumed.stdout.match(/^Final candidate: ([0-9a-f]{40})$/m)?.[1];
    assert.notEqual(candidate, undefined, resumed.stdout);
    assert.equal(git(fixture.root, "rev-parse", `${candidate}^{tree}`), stagedTree);
    assert.equal(git(fixture.root, "rev-parse", `${candidate}^1`), before);
    assert.equal(git(fixture.root, "rev-parse", `${candidate}^2`), fixture.featureHead);
  });
}, 30_000);

test("rebuild rejects staged changes made before a clean merge tree is journaled", () => {
  withFixture({ advanceMain: false }, (fixture) => {
    fixture.env.PASEO_TEST_INTERRUPT_AFTER_MERGE_BEFORE_TREE_INTENT = "overlay:0";
    const interrupted = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(interrupted.status, 90, `${interrupted.stdout}\n${interrupted.stderr}`);
    delete fixture.env.PASEO_TEST_INTERRUPT_AFTER_MERGE_BEFORE_TREE_INTENT;
    const operationDir = path.dirname(
      readFileSync(path.join(fixture.root, ".dev/rw-main-operation"), "utf8").trim(),
    );
    const operationWorktree = path.join(operationDir, "worktree");
    writeFileSync(path.join(operationWorktree, "feature.txt"), "tampered after automatic merge\n");
    git(operationWorktree, "add", "feature.txt");

    const rejected = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(rejected.status, 1, `${rejected.stdout}\n${rejected.stderr}`);
    assert.match(rejected.stderr, /merge intent tree mismatch/);
    assert.equal(git(operationWorktree, "rev-parse", "HEAD"), fixture.currentMain);
    assert.equal(git(operationWorktree, "rev-parse", "MERGE_HEAD"), fixture.featureHead);
  });
}, 30_000);

test.each([
  { corruption: "parents", expected: /merge intent parent mismatch/ },
  { corruption: "tree", expected: /merge intent tree mismatch/ },
])(
  "rebuild rejects a completed clean merge with unexpected $corruption",
  ({ corruption, expected }) => {
    withFixture({ advanceMain: false }, (fixture) => {
      fixture.env.PASEO_TEST_INTERRUPT_AFTER_MERGE_COMMIT_BEFORE_RECORD = "overlay:0";
      const interrupted = run(
        fixture.root,
        "bash",
        ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
        fixture.env,
      );
      assert.equal(interrupted.status, 91, `${interrupted.stdout}\n${interrupted.stderr}`);
      delete fixture.env.PASEO_TEST_INTERRUPT_AFTER_MERGE_COMMIT_BEFORE_RECORD;
      const operationDir = path.dirname(
        readFileSync(path.join(fixture.root, ".dev/rw-main-operation"), "utf8").trim(),
      );
      const operationWorktree = path.join(operationDir, "worktree");
      const committed = git(operationWorktree, "rev-parse", "HEAD");
      const parents = git(operationWorktree, "rev-list", "--parents", "-n", "1", committed).split(
        " ",
      );
      const replacement =
        corruption === "parents"
          ? git(
              operationWorktree,
              "commit-tree",
              `${committed}^{tree}`,
              "-p",
              parents[1],
              "-p",
              git(fixture.root, "rev-parse", "chore/build-paseo"),
              "-m",
              "unexpected parents",
            )
          : git(
              operationWorktree,
              "commit-tree",
              git(fixture.root, "rev-parse", "chore/build-paseo^{tree}"),
              "-p",
              parents[1],
              "-p",
              parents[2],
              "-m",
              "unexpected tree",
            );
      git(operationWorktree, "reset", "--hard", replacement);

      const rejected = run(
        fixture.root,
        "bash",
        ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
        fixture.env,
      );
      assert.equal(rejected.status, 1, `${rejected.stdout}\n${rejected.stderr}`);
      assert.match(rejected.stderr, expected);
      assert.equal(existsSync(path.join(operationDir, "worktree")), true);
    });
  },
  30_000,
);

test("rebuild recovers a reviewed conflict commit interrupted before progress is written", () => {
  withFixture({ conflictingOverlay: true }, (fixture) => {
    writeFileSync(
      fixture.manifestPath,
      readFileSync(fixture.manifestPath, "utf8").replace(
        `reviewed-main:${fixture.reviewedMain}`,
        `reviewed-main:${fixture.currentMain}`,
      ),
    );
    git(fixture.root, "add", "dwyanewang/rw-main-branches.txt");
    git(fixture.root, "commit", "-m", "accept conflicting overlay");
    const first = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(first.status, 6, `${first.stdout}\n${first.stderr}`);
    const requestPath = rwMainOperationPath(first);
    const operationDir = path.dirname(requestPath);
    const operationWorktree = path.join(operationDir, "worktree");
    writeFileSync(
      path.join(operationWorktree, "shared.txt"),
      "upstream implementation\nfeature implementation\n",
    );
    git(operationWorktree, "add", "shared.txt");
    completeConflictReview(operationDir, operationWorktree, "preserved both sides");
    fixture.env.PASEO_TEST_INTERRUPT_AFTER_CONFLICT_COMMIT = "overlay:0";
    const interrupted = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(interrupted.status, 93, `${interrupted.stdout}\n${interrupted.stderr}`);
    const committed = git(operationWorktree, "rev-parse", "HEAD");
    delete fixture.env.PASEO_TEST_INTERRUPT_AFTER_CONFLICT_COMMIT;

    const resumed = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
    const candidate = resumed.stdout.match(/^Final candidate: ([0-9a-f]{40})$/m)?.[1];
    assert.equal(candidate, committed);
  });
}, 30_000);

for (const [interruption, exitCode] of [
  ["PASEO_TEST_INTERRUPT_DURING_CONFLICT_ARCHIVE", 98],
  ["PASEO_TEST_INTERRUPT_AFTER_CONFLICT_PROGRESS", 99],
]) {
  test(`conflict evidence survives ${interruption} before a later overlay conflict`, () => {
    withFixture({ conflictingOverlay: true }, (fixture) => {
      git(fixture.root, "switch", "-c", "feature/two", fixture.reviewedMain);
      writeFileSync(path.join(fixture.root, "shared.txt"), "second feature\n");
      git(fixture.root, "add", "shared.txt");
      git(fixture.root, "commit", "-m", "feat: another conflicting overlay");
      const secondHead = git(fixture.root, "rev-parse", "HEAD");
      git(fixture.root, "switch", "chore/build-paseo");
      writeFileSync(
        fixture.manifestPath,
        readFileSync(fixture.manifestPath, "utf8") +
          `feature/two # Personal branch # reviewed-main:${fixture.currentMain} # reviewed-head:${secondHead}\n`,
      );
      fixture.env[interruption] = "overlay:0";
      const { completed: interrupted, operationDir } = completeReviewedConflict(fixture);
      assert.equal(interrupted.status, exitCode, `${interrupted.stdout}\n${interrupted.stderr}`);
      const worktree = path.join(operationDir, "worktree");
      const firstCommit = git(worktree, "rev-parse", "HEAD");
      const firstReview = readFileSync(
        path.join(operationDir, "conflict-review-overlay-0.tsv"),
        "utf8",
      );
      delete fixture.env[interruption];
      const args = ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"];
      const second = run(fixture.root, "bash", args, fixture.env);
      assert.equal(second.status, 6, `${second.stdout}\n${second.stderr}`);
      assert.equal(git(worktree, "rev-parse", "HEAD"), firstCommit);
      assert.equal(
        readFileSync(path.join(operationDir, "conflict-review-overlay-0.tsv"), "utf8"),
        firstReview,
      );
      assert.equal(existsSync(path.join(operationDir, "conflict-overlay-0.env")), true);
      writeFileSync(
        path.join(worktree, "shared.txt"),
        "upstream implementation\nfeature implementation\nsecond feature\n",
      );
      git(worktree, "add", "shared.txt");
      completeConflictReview(operationDir, worktree, "preserved both overlays and upstream");
      const resumed = run(fixture.root, "bash", args, fixture.env);
      assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
      assert.equal(existsSync(path.join(operationDir, "conflict-overlay-1.env")), true);
      assert.equal(
        readFileSync(path.join(operationDir, "conflict-review-overlay-0.tsv"), "utf8"),
        firstReview,
      );
      assert.match(
        readFileSync(path.join(operationDir, "capability-tests.tsv"), "utf8"),
        /candidate-test\tshared\.test\.ts\t1/,
      );
      assert.match(
        readFileSync(fixture.npmCallLog, "utf8"),
        /exec -- vitest run shared\.test\.ts --bail=1/,
      );
      const candidate = resumed.stdout.match(/^Final candidate: ([0-9a-f]{40})$/m)?.[1];
      assert.equal(git(fixture.root, "rev-parse", `${candidate}^1`), firstCommit);
    });
  }, 60_000);
}

test("rebuild refreshes workspace declarations before repository checks", () => {
  withFixture({ advanceMain: false }, (fixture) => {
    const result = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(readFileSync(fixture.npmCallLog, "utf8").trim().split("\n"), [
      "install",
      "run build:server-deps",
      "run build --workspace=@getpaseo/expo-two-way-audio",
      "run typecheck --workspace=@getpaseo/app",
      "run build --workspace=@getpaseo/server",
      "run build --workspace=@getpaseo/cli",
      "run format:check",
      "run typecheck",
      "run lint",
      "--version",
    ]);
  });
}, 15_000);

test("rebuild fails app typecheck before starting the server and CLI builds", () => {
  withFixture({ advanceMain: false }, (fixture) => {
    fixture.env.PASEO_TEST_APP_TYPECHECK_EXIT = "7";
    const result = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );

    assert.equal(result.status, 7, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(readFileSync(fixture.npmCallLog, "utf8").trim().split("\n"), [
      "install",
      "run build:server-deps",
      "run build --workspace=@getpaseo/expo-two-way-audio",
      "run typecheck --workspace=@getpaseo/app",
    ]);
    assert.match(result.stdout, /readiness:typecheck-app-early:end exit=7/);
    assert.doesNotMatch(result.stdout, /readiness:build-server:start/);
    assert.doesNotMatch(result.stdout, /readiness:build-cli:start/);
  });
});

test("rebuild reuses readiness checks when a later candidate has the same tree", () => {
  withFixture({ advanceMain: false }, (fixture) => {
    const first = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    assert.match(first.stdout, /PASEO_RW_MAIN_VALIDATION_MODE=full/);

    writeFileSync(fixture.npmCallLog, "");
    const second = run(
      fixture.root,
      "bash",
      ["dwyanewang/rebuild-rw-main.sh", "--build-root", fixture.root, "--dry-run"],
      fixture.env,
    );

    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.match(second.stdout, /Reusing trusted readiness validation for candidate tree/);
    assert.match(second.stdout, /PASEO_RW_MAIN_VALIDATION_MODE=trusted-tree-reuse/);
    const secondCalls = readFileSync(fixture.npmCallLog, "utf8");
    assert.doesNotMatch(secondCalls, /run build:server/);
    assert.doesNotMatch(secondCalls, /run format:check/);
    assert.doesNotMatch(secondCalls, /run typecheck/);
    assert.doesNotMatch(secondCalls, /run lint/);
  });
}, 15_000);
