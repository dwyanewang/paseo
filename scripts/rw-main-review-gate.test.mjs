import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

function createFixture({
  advanceFeature = false,
  advanceMain = true,
  conflictingOverlay = false,
  patchEquivalent = false,
  prState,
  prIdentity = { branch: "feature/one", owner: "dwyanewang" },
  secondBranch = false,
  secondPending = false,
  secondPr = false,
  replacementPr,
} = {}) {
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
  for (const workspace of ["highlight", "relay", "protocol", "client", "server", "cli"]) {
    const workspaceRoot = path.join(root, "packages", workspace);
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(path.join(workspaceRoot, "package.json"), `{"name":"${workspace}"}\n`);
  }
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "seed");
  const reviewedMain = git(root, "rev-parse", "main");

  git(root, "switch", "-c", "feature/one");
  const featureChange = fixtureChange({ patchEquivalent, conflictingOverlay, upstream: false });
  writeFileSync(path.join(root, featureChange.path), featureChange.content);
  git(root, "add", featureChange.path);
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
    const upstreamChange = fixtureChange({ patchEquivalent, conflictingOverlay, upstream: true });
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
  writeFileSync(
    npmPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$NPM_CALL_LOG"
if [[ "$*" == --version ]]; then
  printf '%s\\n' '10.9.0'
  exit 0
fi
if [[ "$*" == 'run typecheck --workspace=@getpaseo/app' && -n "\${PASEO_TEST_APP_TYPECHECK_EXIT:-}" ]]; then
  exit "$PASEO_TEST_APP_TYPECHECK_EXIT"
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
    currentMain,
    env: {
      GH_CALL_LOG: ghCallLog,
      NPM_CALL_LOG: npmCallLog,
      PASEO_EXPO_ROUTER_TYPES_HELPER: expoRouterTypesHelper,
      PASEO_TEST_BUILD_ROOT: root,
      PASEO_PATCHED_DEPENDENCIES_HELPER: path.join(binDir, "prepare-patched-dependencies.mjs"),
      PATH: `${binDir}:${process.env.PATH}`,
    },
    featureHead,
    ghCallLog,
    manifestPath,
    npmCallLog,
    reviewedMain,
    reviewedFeatureHead,
    root,
    secondFeatureHead,
  };
}

function runSync(fixture, ...args) {
  return run(fixture.root, "bash", ["dwyanewang/sync-rw-main-branches.sh", ...args], fixture.env);
}

function reviewRequestPath(result) {
  const match = result.stdout.match(/^PASEO_REVIEW_REQUEST_FILE=(.+)$/m);
  assert.notEqual(match, null, result.stdout);
  return match[1];
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

test("checks overlay mergeability before reporting semantic review", () => {
  withFixture({ conflictingOverlay: true }, (fixture) => {
    const result = runSync(fixture, "--check-mergeability");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /mergeability preflight failed while merging overlay feature\/one/);
    assert.match(result.stderr, /shared\.txt/);
    assert.doesNotMatch(result.stdout, /Semantic review required/);
    assert.doesNotMatch(result.stdout, /PASEO_REVIEW_REQUEST_FILE=/);
    assert.equal(git(fixture.root, "rev-parse", "rw-base"), fixture.currentMain);
    assert.doesNotMatch(git(fixture.root, "worktree", "list", "--porcelain"), /mergeability/);
  });
});

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
      /Merge branch 'feature\/one' into rw-main-rebuild-/,
    );
    assert.match(
      git(fixture.root, "log", "-1", "--format=%s", `${candidate}^1`),
      /Merge branch 'main' into rw-base-sync-/,
    );
    assert.equal(git(fixture.root, "rev-parse", `${candidate}^2`), fixture.featureHead);
    assert.equal(git(fixture.root, "rev-parse", `${candidate}^1^2`), fixture.currentMain);
    assert.equal(git(fixture.root, "rev-parse", "rw-base"), base);
  });
}, 30_000);

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
});

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
