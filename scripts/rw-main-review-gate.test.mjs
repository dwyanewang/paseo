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

function createFixture({
  advanceFeature = false,
  advanceMain = true,
  patchEquivalent = false,
  prState,
  secondBranch = false,
  secondPr = false,
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-rw-main-review-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.com");

  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  git(root, "add", "seed.txt");
  git(root, "commit", "-m", "seed");
  const reviewedMain = git(root, "rev-parse", "main");

  git(root, "switch", "-c", "feature/one");
  const featurePath = patchEquivalent ? "shared.txt" : "feature.txt";
  writeFileSync(path.join(root, featurePath), patchEquivalent ? "same\n" : "feature\n");
  git(root, "add", featurePath);
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
    const upstreamPath = patchEquivalent ? "shared.txt" : "upstream.txt";
    writeFileSync(path.join(root, upstreamPath), patchEquivalent ? "same\n" : "upstream\n");
    git(root, "add", upstreamPath);
    git(root, "commit", "-m", "feat: upstream implementation (#99)");
  }
  const currentMain = git(root, "rev-parse", "main");

  let secondFeatureHead;
  if (secondBranch) {
    git(root, "switch", "-c", "feature/two");
    writeFileSync(path.join(root, "feature-two.txt"), "feature two\n");
    git(root, "add", "feature-two.txt");
    git(root, "commit", "-m", "feat: feature two");
    secondFeatureHead = git(root, "rev-parse", "HEAD");
    git(root, "switch", "main");
  }

  git(root, "switch", "-c", "chore/build-paseo");
  const controlDir = path.join(root, "dwyanewang");
  const binDir = path.join(root, "test-bin");
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

  const manifestEntry = prState ? "feature/one # PR #1" : "feature/one # Personal branch";
  const secondManifestEntry = secondBranch
    ? `feature/two # ${secondPr ? "PR #2" : "Personal branch"} # reviewed-main:${currentMain} # reviewed-head:${secondFeatureHead}\n`
    : "";
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
      "feature/one",
      "dwyanewang",
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
  const ghOutput = ghRows
    .map(
      (fields) =>
        `printf '%s\\037%s\\037%s\\037%s\\037%s\\037%s\\037%s\\n' ${fields.map((field) => `'${field}'`).join(" ")}`,
    )
    .join("\n");
  writeFileSync(ghPath, `#!/usr/bin/env bash\nprintf 'call\\n' >> "$GH_CALL_LOG"\n${ghOutput}\n`);
  chmodSync(ghPath, 0o755);

  git(root, "add", "dwyanewang", "test-bin");
  git(root, "commit", "-m", "chore: add rw-main controls");

  return {
    currentMain,
    env: { GH_CALL_LOG: ghCallLog, PATH: `${binDir}:${process.env.PATH}` },
    featureHead,
    ghCallLog,
    manifestPath,
    reviewedMain,
    reviewedFeatureHead,
    root,
    secondFeatureHead,
  };
}

function runSync(fixture, ...args) {
  return run(fixture.root, "bash", ["dwyanewang/sync-rw-main-branches.sh", ...args], fixture.env);
}

function withFixture(options, callback) {
  const fixture = createFixture(options);
  try {
    callback(fixture);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
}

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
    assert.equal(readFileSync(fixture.manifestPath, "utf8"), before);
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

test("blocks when a branch head changes even if main does not", () => {
  withFixture({ advanceFeature: true, advanceMain: false }, (fixture) => {
    const result = runSync(fixture);

    assert.equal(result.status, 3, result.stderr);
    assert.match(
      result.stdout,
      new RegExp(`Branch review: ${fixture.reviewedFeatureHead}..${fixture.featureHead}`),
    );
    assert.match(result.stdout, /feature-update\.txt/);
  });
});

test("accepts the exact current main and removes an absorbed branch atomically", () => {
  withFixture({}, (fixture) => {
    const result = runSync(
      fixture,
      "--accept-main-review",
      fixture.currentMain,
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
    const result = runSync(fixture, "--dry-run", "--accept-main-review", fixture.currentMain);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`reviewed-main:${fixture.currentMain}`));
    assert.match(result.stdout, new RegExp(`reviewed-head:${fixture.featureHead}`));
    assert.match(result.stdout, /Dry run complete/);
    assert.equal(readFileSync(fixture.manifestPath, "utf8"), before);
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
});

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
