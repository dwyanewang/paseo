import { describe, expect, it, vi } from "vitest";
import type { ForgeSpecificStatusFacts } from "./forge-service.js";
import {
  AliyunAuthenticationError,
  AliyunCliMissingError,
  AliyunCommandError,
  createCodeupService,
  parseCodeupRemoteIdentity,
  type CodeupCommandRunner,
  type CreateCodeupServiceOptions,
} from "./codeup-service.js";

type Responder = (action: string, args: string[]) => unknown;

const repository = {
  id: 42,
  name: "repo",
  pathWithNamespace: "org/team/repo",
  defaultBranch: "main",
  sshUrlToRepository: "git@codeup.aliyun.com:org/team/repo.git",
  httpUrlToRepository: "https://codeup.aliyun.com/org/team/repo.git",
  webUrl: "https://codeup.aliyun.com/org/team/repo",
};

const listMr = {
  localId: 7,
  projectId: 42,
  sourceProjectId: 42,
  targetProjectId: 42,
  sourceBranch: "feature/codeup",
  targetBranch: "main",
  title: "Add Codeup",
  description: "MR body",
  state: "opened",
  workInProgress: false,
  labels: [{ id: "label-1", name: "feature" }],
  updatedAt: "2026-07-20T01:00:00Z",
  detailUrl: "https://codeup.aliyun.com/org/team/repo/merge_request/7",
  nameWithNamespace: "team/repo",
};

const detailMr = {
  localId: 7,
  projectId: 42,
  sourceProjectId: 42,
  targetProjectId: 42,
  sourceBranch: "feature/codeup",
  targetBranch: "main",
  title: "Add Codeup",
  description: "MR body",
  status: "TO_BE_MERGED",
  updateTime: "2026-07-20T01:00:00Z",
  detailUrl: "https://codeup.aliyun.com/org/team/repo/merge_request/7",
  reviewers: [
    {
      id: 9,
      username: "reviewer",
      avatarUrl: "https://example.test/avatar.png",
      hasReviewed: true,
      reviewOpinionStatus: "PASS",
      reviewTime: "2026-07-20T00:30:00Z",
    },
  ],
  allRequirementsPass: true,
  todoList: {
    requirementCheckItems: [
      { itemType: "MERGE_CONFLICT_CHECK", pass: true },
      { itemType: "CI_CHECK", pass: true },
      { itemType: "REVIEWER_APPROVED_CHECK", pass: true },
    ],
  },
};

function actionOf(args: string[]): string {
  const productIndex = args.indexOf("devops");
  if (productIndex >= 0) return args[productIndex + 1] ?? "";
  const stsIndex = args.indexOf("sts");
  return stsIndex >= 0 ? `sts:${args[stsIndex + 1] ?? ""}` : "";
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function defaultResponder(action: string): unknown {
  switch (action) {
    case "sts:GetCallerIdentity":
      return { AccountId: "123" };
    case "GetRepository":
      return { success: true, repository };
    case "ListMergeRequests":
      return { success: true, result: [listMr], total: 1 };
    case "GetMergeRequest":
      return { success: true, result: detailMr };
    case "ListMergeRequestPatchSets":
      return {
        success: true,
        result: [
          {
            patchSetNo: 2,
            relatedMergeItemType: "MERGE_SOURCE",
            commitId: "head-sha",
          },
          {
            patchSetNo: 1,
            relatedMergeItemType: "MERGE_SOURCE",
            commitId: "old-sha",
          },
        ],
      };
    case "ListCheckRuns":
      return {
        success: true,
        total: 1,
        result: [
          {
            id: 501,
            name: "unit",
            status: "completed",
            conclusion: "success",
            detailsUrl: "https://ci.example.test/unit",
            startedAt: "2026-07-20T00:00:00Z",
            completedAt: "2026-07-20T00:01:05Z",
          },
        ],
      };
    case "ListCommitStatuses":
      return {
        success: true,
        total: 1,
        result: [
          {
            id: 601,
            context: "security",
            state: "failure",
            targetUrl: "https://ci.example.test/security",
          },
        ],
      };
    case "ListMergeRequestComments":
      return { success: true, result: [] };
    case "GetCheckRun":
      return {
        success: true,
        result: {
          id: 501,
          name: "unit",
          status: "completed",
          conclusion: "failure",
          detailsUrl: "https://ci.example.test/unit",
          output: { title: "Unit tests", summary: "One failed", text: "details" },
          annotations: [
            {
              path: "src/index.ts",
              startLine: 3,
              endLine: 4,
              annotationLevel: "failure",
              message: "Expected true",
            },
          ],
        },
      };
    case "CreateMergeRequest":
      return { success: true, result: { ...detailMr, sourceProjectId: undefined } };
    case "MergeMergeRequest":
      return { success: true, result: { result: true, localId: 7 } };
    default:
      throw new Error(`Unexpected Codeup action: ${action}`);
  }
}

function makeService(
  responder: Responder = defaultResponder,
  overrides: Partial<CreateCodeupServiceOptions> = {},
) {
  const runner = vi.fn<CodeupCommandRunner>(async (args) => ({
    stdout: JSON.stringify(responder(actionOf(args), args)),
    stderr: "",
  }));
  const service = createCodeupService({
    runner,
    resolveAliyunPath: async () => "/usr/bin/aliyun",
    resolveRemoteUrl: async () => "git@codeup.aliyun.com:org/team/repo.git",
    ...overrides,
  });
  return { service, runner };
}

function mergeFacts(overrides: Partial<Record<string, unknown>> = {}): ForgeSpecificStatusFacts {
  return {
    forge: "codeup",
    status: "TO_BE_MERGED",
    allRequirementsPass: true,
    requirementChecks: {
      mergeConflict: true,
      comments: true,
      ci: true,
      reviewerApproved: true,
    },
    ...overrides,
  };
}

function mergeRequestPage(count: number, offset: number) {
  return Array.from({ length: count }, (_, index) => ({
    ...listMr,
    localId: offset + index + 1,
  }));
}

function nonmatchingMergeRequestPage(page: number) {
  const offset = (page - 1) * 100;
  return Array.from({ length: 100 }, (_, index) => ({
    ...listMr,
    localId: offset + index + 1,
    sourceBranch: `other/${offset + index + 1}`,
  }));
}

describe("parseCodeupRemoteIdentity", () => {
  it("parses SSH and HTTPS remotes into organization and repository identity", () => {
    expect(parseCodeupRemoteIdentity("git@codeup.aliyun.com:org/group/sub/repo.git")).toEqual({
      organizationId: "org",
      repositoryIdentity: "org/group/sub/repo",
    });
    expect(parseCodeupRemoteIdentity("https://codeup.aliyun.com/org/group/repo.git")).toEqual({
      organizationId: "org",
      repositoryIdentity: "org/group/repo",
    });
  });

  it("rejects remotes without both organization and repository path", () => {
    expect(parseCodeupRemoteIdentity("https://codeup.aliyun.com/org.git")).toBeNull();
    expect(parseCodeupRemoteIdentity("not a remote")).toBeNull();
  });
});

describe("createCodeupService", () => {
  it("classifies a missing CLI and invalid Alibaba Cloud credentials", async () => {
    const missing = createCodeupService({
      resolveAliyunPath: async () => null,
      resolveRemoteUrl: async () => "git@codeup.aliyun.com:org/team/repo.git",
    });
    await expect(missing.isAuthenticated({ cwd: "/repo" })).rejects.toBeInstanceOf(
      AliyunCliMissingError,
    );

    const invalid = createCodeupService({
      runner: async () => {
        throw { code: 1, stderr: "InvalidAccessKeyId.NotFound" };
      },
      resolveAliyunPath: async () => "/usr/bin/aliyun",
      resolveRemoteUrl: async () => "git@codeup.aliyun.com:org/team/repo.git",
    });
    await expect(invalid.isAuthenticated({ cwd: "/repo" })).rejects.toBeInstanceOf(
      AliyunAuthenticationError,
    );

    const unconfigured = createCodeupService({
      runner: async () => {
        throw {
          code: 3,
          stderr: "profile default is not configure yet; Configuration failed",
        };
      },
      resolveAliyunPath: async () => "/usr/bin/aliyun",
      resolveRemoteUrl: async () => "git@codeup.aliyun.com:org/team/repo.git",
    });
    await expect(unconfigured.isAuthenticated({ cwd: "/repo" })).rejects.toBeInstanceOf(
      AliyunAuthenticationError,
    );
  });

  it("uses STS identity for the throwing auth probe", async () => {
    const { service, runner } = makeService();
    await expect(service.isAuthenticated({ cwd: "/repo" })).resolves.toBe(true);
    expect(actionOf(runner.mock.calls[0]?.[0] ?? [])).toBe("sts:GetCallerIdentity");
    expect(service.authProbeCanThrow).toBe(true);
  });

  it("uses the complete remote path with the CLI's built-in DevOps API version", async () => {
    const { service, runner } = makeService();
    await service.getPullRequest({ cwd: "/repo", number: 7 });
    const args = runner.mock.calls.find(
      ([callArgs]) => actionOf(callArgs) === "GetRepository",
    )?.[0];
    expect(argValue(args ?? [], "identity")).toBe("org/team/repo");
    expect(args).not.toContain("--version");
  });

  it("maps an open Codeup MR, requirements, reviews, checks, and commit statuses", async () => {
    const { service } = makeService();
    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feature/codeup",
      headSha: "local-ahead-sha",
    });
    expect(status).toEqual(
      expect.objectContaining({
        number: 7,
        projectPath: "org/team/repo",
        state: "open",
        mergeable: "MERGEABLE",
        reviewDecision: "approved",
        checksStatus: "failure",
        forgeSpecific: {
          forge: "codeup",
          status: "TO_BE_MERGED",
          allRequirementsPass: true,
          requirementChecks: {
            mergeConflict: true,
            comments: null,
            ci: true,
            reviewerApproved: true,
          },
        },
      }),
    );
    expect(status?.checks).toEqual([
      {
        name: "unit",
        status: "success",
        url: "https://ci.example.test/unit",
        checkRunId: 501,
        duration: "1m 5s",
      },
      {
        name: "security",
        status: "failure",
        url: "https://ci.example.test/security",
      },
    ]);
  });

  it("preserves cancelled and skipped check-run outcomes", async () => {
    const { service } = makeService((action, args) => {
      if (action === "ListCheckRuns") {
        return {
          success: true,
          total: 2,
          result: [
            { id: 1, name: "cancelled", status: "completed", conclusion: "cancelled" },
            { id: 2, name: "skipped", status: "completed", conclusion: "skipped" },
          ],
        };
      }
      if (action === "ListCommitStatuses") {
        return { success: true, total: 0, result: [] };
      }
      return defaultResponder(action, args);
    });
    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feature/codeup",
    });
    expect(status?.checks).toEqual([
      { name: "cancelled", status: "cancelled", url: null, checkRunId: 1 },
      { name: "skipped", status: "skipped", url: null, checkRunId: 2 },
    ]);
  });

  it("paginates checks and commit statuses when total is omitted", async () => {
    const firstCheckPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `check-${index + 1}`,
      status: "completed",
      conclusion: "success",
    }));
    const firstStatusPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      context: `status-${index + 1}`,
      state: "success",
    }));
    const { service, runner } = makeService((action, args) => {
      const page = argValue(args, "page");
      if (action === "ListCheckRuns") {
        return {
          success: true,
          result:
            page === "1"
              ? firstCheckPage
              : [{ id: 101, name: "check-101", status: "completed", conclusion: "success" }],
        };
      }
      if (action === "ListCommitStatuses") {
        return {
          success: true,
          result:
            page === "1" ? firstStatusPage : [{ id: 101, context: "status-101", state: "success" }],
        };
      }
      return defaultResponder(action, args);
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feature/codeup",
    });
    expect(status?.checks).toHaveLength(202);
    expect(status?.checks[100]).toMatchObject({ name: "check-101", checkRunId: 101 });
    expect(status?.checks[201]).toMatchObject({ name: "status-101" });
    for (const action of ["ListCheckRuns", "ListCommitStatuses"]) {
      const calls = runner.mock.calls.filter(([args]) => actionOf(args) === action);
      expect(calls.map(([args]) => argValue(args, "page"))).toEqual(["1", "2"]);
    }
  });

  it("maps draft, conflict, and rejected-review status", async () => {
    const { service } = makeService((action, args) => {
      if (action === "GetMergeRequest") {
        return {
          success: true,
          result: {
            ...detailMr,
            status: "UNDER_DEV",
            allRequirementsPass: false,
            reviewers: [
              {
                id: 10,
                username: "reviewer",
                hasReviewed: true,
                reviewOpinionStatus: "NOT_PASS",
                reviewTime: "2026-07-20T00:40:00Z",
              },
            ],
            todoList: {
              requirementCheckItems: [
                { itemType: "MERGE_CONFLICT_CHECK", pass: false },
                { itemType: "REVIEWER_APPROVED_CHECK", pass: false },
              ],
            },
          },
        };
      }
      return defaultResponder(action, args);
    });
    await expect(
      service.getCurrentPullRequestStatus({ cwd: "/repo", headRef: "feature/codeup" }),
    ).resolves.toMatchObject({
      isDraft: true,
      mergeable: "CONFLICTING",
      reviewDecision: "changes_requested",
      forgeSpecific: {
        forge: "codeup",
        status: "UNDER_DEV",
        allRequirementsPass: false,
        requirementChecks: {
          mergeConflict: false,
          reviewerApproved: false,
        },
      },
    });
    await expect(
      service.getPullRequestTimeline({
        cwd: "/repo",
        prNumber: 7,
        repoOwner: "team",
        repoName: "repo",
      }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ kind: "review", reviewState: "changes_requested" })],
    });
  });

  it("does not attach a terminal MR until its latest source patch matches HEAD", async () => {
    const stale = { ...listMr, localId: 6, state: "merged", updatedAt: "2026-07-20T02:00:00Z" };
    const matching = { ...listMr, localId: 5, state: "closed" };
    const { service } = makeService((action, args) => {
      if (action === "ListMergeRequests") {
        return { success: true, result: [stale, matching], total: 2 };
      }
      if (action === "ListMergeRequestPatchSets") {
        return {
          success: true,
          result: [
            {
              commentBizId: "system",
              commentTime: "2026-07-20T00:05:00Z",
              commentType: "SYSTEM_COMMENT",
              content: "System event",
            },
            {
              patchSetNo: 1,
              relatedMergeItemType: "MERGE_SOURCE",
              commitId: argValue(args, "localId") === "5" ? "current-head" : "stale-head",
            },
          ],
        };
      }
      if (action === "GetMergeRequest") {
        return {
          success: true,
          result: { ...detailMr, localId: Number(argValue(args, "localId")), status: "CLOSED" },
        };
      }
      return defaultResponder(action, args);
    });

    await expect(
      service.getCurrentPullRequestStatus({
        cwd: "/repo",
        headRef: "feature/codeup",
        headSha: "current-head",
      }),
    ).resolves.toMatchObject({ number: 5, state: "closed" });
  });

  it("finds the current MR beyond the first page of recently updated requests", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      ...listMr,
      localId: index + 1,
      sourceBranch: `other/${index + 1}`,
    }));
    const target = { ...listMr, localId: 101 };
    const { service, runner } = makeService((action, args) => {
      if (action === "ListMergeRequests") {
        return {
          success: true,
          result: argValue(args, "page") === "1" ? firstPage : [target],
        };
      }
      if (action === "GetMergeRequest") {
        return { success: true, result: { ...detailMr, localId: target.localId } };
      }
      return defaultResponder(action, args);
    });

    await expect(
      service.getCurrentPullRequestStatus({ cwd: "/repo", headRef: target.sourceBranch }),
    ).resolves.toMatchObject({ number: target.localId, state: "open" });
    const listCalls = runner.mock.calls.filter(
      ([callArgs]) => actionOf(callArgs) === "ListMergeRequests",
    );
    expect(listCalls.map(([args]) => argValue(args, "page"))).toEqual(["1", "2"]);
    expect(listCalls.map(([args]) => argValue(args, "pageSize"))).toEqual(["100", "100"]);
  });

  it("fails when current-MR pagination repeats a full page without total", async () => {
    const repeatedPage = nonmatchingMergeRequestPage(1);
    const { service, runner } = makeService((action, args) => {
      if (action === "ListMergeRequests") {
        const page = Number(argValue(args, "page"));
        if (page > 2) throw new Error("pagination continued past the repeated page");
        return { success: true, result: repeatedPage };
      }
      return defaultResponder(action, args);
    });

    await expect(
      service.getCurrentPullRequestStatus({ cwd: "/repo", headRef: "feature/codeup" }),
    ).rejects.toThrow("repeated a full page");
    const listCalls = runner.mock.calls.filter(
      ([callArgs]) => actionOf(callArgs) === "ListMergeRequests",
    );
    expect(listCalls.map(([args]) => argValue(args, "page"))).toEqual(["1", "2"]);
  });

  it("returns a current MR from the final page allowed without total", async () => {
    const target = { ...listMr, localId: 10_001 };
    const { service, runner } = makeService((action, args) => {
      if (action === "ListMergeRequests") {
        const page = Number(argValue(args, "page"));
        if (page > 101) throw new Error("pagination continued past the safety cap");
        const result = nonmatchingMergeRequestPage(page);
        if (page === 101) result[0] = target;
        return { success: true, result };
      }
      if (action === "GetMergeRequest") {
        return { success: true, result: { ...detailMr, localId: target.localId } };
      }
      return defaultResponder(action, args);
    });

    await expect(
      service.getCurrentPullRequestStatus({ cwd: "/repo", headRef: target.sourceBranch }),
    ).resolves.toMatchObject({ number: target.localId, state: "open" });
    const listCalls = runner.mock.calls.filter(
      ([callArgs]) => actionOf(callArgs) === "ListMergeRequests",
    );
    expect(argValue(listCalls.at(-1)?.[0] ?? [], "page")).toBe("101");
  });

  it("caps current-MR pagination when full pages omit total", async () => {
    const { service, runner } = makeService((action, args) => {
      if (action === "ListMergeRequests") {
        const page = Number(argValue(args, "page"));
        if (page > 101) throw new Error("pagination continued past the safety cap");
        return { success: true, result: nonmatchingMergeRequestPage(page) };
      }
      return defaultResponder(action, args);
    });

    await expect(
      service.getCurrentPullRequestStatus({ cwd: "/repo", headRef: "feature/codeup" }),
    ).rejects.toThrow("exceeded 100 continuations");
    const listCalls = runner.mock.calls.filter(
      ([callArgs]) => actionOf(callArgs) === "ListMergeRequests",
    );
    expect(argValue(listCalls.at(-1)?.[0] ?? [], "page")).toBe("101");
  });

  it("requires the source repository identity when the worktree came from a fork", async () => {
    const forkMr = { ...listMr, sourceProjectId: 99 };
    const { service } = makeService((action, args) => {
      if (action === "GetRepository" && argValue(args, "identity") === "99") {
        return {
          success: true,
          repository: {
            ...repository,
            id: 99,
            pathWithNamespace: "org/contributor/repo",
            sshUrlToRepository: "git@codeup.aliyun.com:org/contributor/repo.git",
            httpUrlToRepository: "https://codeup.aliyun.com/org/contributor/repo.git",
          },
        };
      }
      if (action === "ListMergeRequests") {
        return { success: true, result: [forkMr], total: 1 };
      }
      return defaultResponder(action, args);
    });

    await expect(
      service.getCurrentPullRequestStatus({
        cwd: "/repo",
        headRef: "feature/codeup",
        headRepositoryOwner: "someone-else/repo",
      }),
    ).resolves.toBeNull();
    await expect(
      service.getCurrentPullRequestStatus({
        cwd: "/repo",
        headRef: "feature/codeup",
        headRepositoryOwner: "org/contributor/repo",
      }),
    ).resolves.toMatchObject({ number: 7 });
  });

  it("fetches cross-repository checkout heads directly from the source repository URL", async () => {
    const { service } = makeService((action, args) => {
      if (action === "GetMergeRequest") {
        return { success: true, result: { ...detailMr, sourceProjectId: 99 } };
      }
      if (action === "GetRepository" && argValue(args, "identity") === "99") {
        return {
          success: true,
          repository: {
            ...repository,
            id: 99,
            pathWithNamespace: "org/contributor/repo",
            sshUrlToRepository: "git@codeup.aliyun.com:org/contributor/repo.git",
            httpUrlToRepository: "https://codeup.aliyun.com/org/contributor/repo.git",
          },
        };
      }
      return defaultResponder(action, args);
    });
    await expect(
      service.getPullRequestCheckoutTarget({ cwd: "/repo", number: 7 }),
    ).resolves.toEqual({
      number: 7,
      baseRefName: "main",
      headRefName: "feature/codeup",
      checkoutRefs: [
        {
          remoteName: "origin",
          remoteUrl: "git@codeup.aliyun.com:org/contributor/repo.git",
          remoteRef: "refs/heads/feature/codeup",
        },
      ],
      headOwnerLogin: "org/contributor/repo",
      headRepositorySshUrl: "git@codeup.aliyun.com:org/contributor/repo.git",
      headRepositoryUrl: "https://codeup.aliyun.com/org/contributor/repo.git",
      isCrossRepository: true,
    });
  });

  it("rejects a cross-repository checkout without a source clone URL", async () => {
    const { service } = makeService((action, args) => {
      if (action === "GetMergeRequest") {
        return { success: true, result: { ...detailMr, sourceProjectId: 99 } };
      }
      if (action === "GetRepository" && argValue(args, "identity") === "99") {
        return {
          success: true,
          repository: {
            ...repository,
            id: 99,
            pathWithNamespace: "org/contributor/repo",
            sshUrlToRepository: null,
            httpUrlToRepository: null,
          },
        };
      }
      return defaultResponder(action, args);
    });
    await expect(service.getPullRequestCheckoutTarget({ cwd: "/repo", number: 7 })).rejects.toThrow(
      "did not return a clone URL",
    );
  });

  it("maps reviewer opinions and a three-level comment thread into the neutral timeline", async () => {
    const { service } = makeService((action, args) => {
      if (action === "ListMergeRequestComments") {
        return {
          success: true,
          result: [
            {
              commentBizId: "root",
              commentTime: "2026-07-20T00:10:00Z",
              commentType: "INLINE_COMMENT",
              content: "Root comment",
              filePath: "src/index.ts",
              lineNumber: "12",
              resolved: true,
              author: { username: "author" },
              childComments: [
                {
                  commentBizId: "reply",
                  rootCommentBizId: "root",
                  commentTime: "2026-07-20T00:20:00Z",
                  commentType: "GLOBAL_COMMENT",
                  content: "Reply",
                  author: { username: "reviewer" },
                  finalChildComments: [
                    {
                      commentBizId: "deleted",
                      rootCommentBizId: "root",
                      commentTime: "2026-07-20T00:25:00Z",
                      deleted: true,
                      content: "deleted",
                    },
                  ],
                },
              ],
            },
          ],
        };
      }
      return defaultResponder(action, args);
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 7,
      repoOwner: "team",
      repoName: "repo",
    });
    expect(timeline.error).toBeNull();
    expect(timeline.items.map((item) => item.id)).toEqual([
      "root",
      "reply",
      "review:9:2026-07-20T00:30:00Z",
    ]);
    expect(timeline.items[0]).toMatchObject({
      kind: "comment",
      threadId: "root",
      location: { path: "src/index.ts", line: 12, threadId: "root", isResolved: true },
    });
    expect(timeline.items[2]).toMatchObject({ kind: "review", reviewState: "approved" });
  });

  it("returns review activity together with an actionable comment API error", async () => {
    const { service } = makeService((action, args) => {
      if (action === "ListMergeRequestComments") {
        throw { code: 1, stderr: "403 Forbidden" };
      }
      return defaultResponder(action, args);
    });
    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 7,
      repoOwner: "team",
      repoName: "repo",
    });
    expect(timeline.items).toHaveLength(1);
    expect(timeline.error).toEqual({ kind: "forbidden", message: "403 Forbidden" });
  });

  it("returns check-run output and annotations for chat attachment", async () => {
    const { service } = makeService();
    await expect(service.getCheckDetails({ cwd: "/repo", checkRunId: 501 })).resolves.toMatchObject(
      {
        checkRunId: 501,
        conclusion: "failure",
        output: { title: "Unit tests", summary: "One failed", text: "details" },
        annotations: [
          {
            path: "src/index.ts",
            startLine: 3,
            endLine: 4,
            annotationLevel: "failure",
            message: "Expected true",
          },
        ],
      },
    );
  });

  it("lists and searches only Codeup merge requests, while issue-only search stays empty", async () => {
    const { service } = makeService();
    await expect(
      service.listPullRequests({ cwd: "/repo", query: "Codeup", limit: 5 }),
    ).resolves.toEqual([
      {
        number: 7,
        title: "Add Codeup",
        url: "https://codeup.aliyun.com/org/team/repo/merge_request/7",
        state: "open",
        body: "MR body",
        projectPath: "team/repo",
        baseRefName: "main",
        headRefName: "feature/codeup",
        labels: ["feature"],
        updatedAt: "2026-07-20T01:00:00Z",
      },
    ]);
    await expect(
      service.searchIssuesAndPrs({ cwd: "/repo", query: "", kinds: ["issue"] }),
    ).resolves.toMatchObject({ items: [], featuresEnabled: true, authState: "authenticated" });
    await expect(service.listIssues({ cwd: "/repo" })).resolves.toEqual([]);
  });

  it("paginates merge-request lists up to the requested limit when total is omitted", async () => {
    const { service, runner } = makeService((action, args) => {
      if (action === "ListMergeRequests") {
        const page = Number(argValue(args, "page"));
        const count = page === 1 ? 100 : 50;
        const offset = page === 1 ? 0 : 100;
        return {
          success: true,
          result: mergeRequestPage(count, offset),
        };
      }
      return defaultResponder(action, args);
    });
    await expect(service.listPullRequests({ cwd: "/repo", limit: 150 })).resolves.toHaveLength(150);
    const listCalls = runner.mock.calls.filter(
      ([callArgs]) => actionOf(callArgs) === "ListMergeRequests",
    );
    expect(listCalls.map(([args]) => argValue(args, "page"))).toEqual(["1", "2"]);
    expect(listCalls.map(([args]) => argValue(args, "pageSize"))).toEqual(["100", "50"]);
  });

  it.each(["reopened", "accepted", "locked"])(
    "keeps the Codeup %s list state open",
    async (state) => {
      const { service } = makeService((action, args) => {
        if (action === "ListMergeRequests") {
          return { success: true, result: [{ ...listMr, state }], total: 1 };
        }
        return defaultResponder(action, args);
      });
      await expect(service.listPullRequests({ cwd: "/repo" })).resolves.toEqual([
        expect.objectContaining({ state: "open" }),
      ]);
    },
  );

  it("creates an MR with the current repository as source and target", async () => {
    const { service, runner } = makeService();
    await expect(
      service.createPullRequest({
        cwd: "/repo",
        title: "Create MR",
        body: "body",
        head: "feature/codeup",
        base: "main",
      }),
    ).resolves.toEqual({
      number: 7,
      url: "https://codeup.aliyun.com/org/team/repo/merge_request/7",
    });
    const args = runner.mock.calls.find(
      ([callArgs]) => actionOf(callArgs) === "CreateMergeRequest",
    )?.[0];
    expect(args).toEqual(
      expect.arrayContaining([
        "--endpoint",
        "devops.cn-hangzhou.aliyuncs.com",
        "--organizationId",
        "org",
        "--repositoryId",
        "42",
      ]),
    );
    expect(JSON.parse(argValue(args ?? [], "body") ?? "null")).toEqual({
      sourceProjectId: 42,
      sourceBranch: "feature/codeup",
      targetProjectId: 42,
      targetBranch: "main",
      title: "Create MR",
      createFrom: "WEB",
      description: "body",
    });
  });

  it.each([
    ["merge", "no-fast-forward"],
    ["squash", "squash"],
    ["rebase", "rebase"],
  ] as const)("maps the %s merge method to Codeup %s", async (method, expectedType) => {
    const { service, runner } = makeService();
    await expect(
      service.mergePullRequest({
        cwd: "/repo",
        prNumber: 7,
        mergeMethod: method,
        status: { forgeSpecific: mergeFacts() },
      }),
    ).resolves.toEqual({ success: true });
    const args = runner.mock.calls.find(
      ([callArgs]) => actionOf(callArgs) === "MergeMergeRequest",
    )?.[0];
    expect(JSON.parse(argValue(args ?? [], "body") ?? "null")).toMatchObject({
      mergeType: expectedType,
      removeSourceBranch: false,
    });
    expect(argValue(args ?? [], "localId")).toBe("7");
  });

  it("refuses merge without ready Codeup facts and never exposes auto-merge", async () => {
    const { service } = makeService();
    await expect(
      service.mergePullRequest({
        cwd: "/repo",
        prNumber: 7,
        mergeMethod: "merge",
        status: {
          forgeSpecific: mergeFacts({ status: "UNDER_REVIEW", allRequirementsPass: false }),
        },
      }),
    ).rejects.toThrow("Codeup does not report this merge request as ready");
    expect(() =>
      service.enablePullRequestAutoMerge({ cwd: "/repo", prNumber: 7, mergeMethod: "merge" }),
    ).toThrow("not supported on Codeup");
    expect(() => service.disablePullRequestAutoMerge({ cwd: "/repo", prNumber: 7 })).toThrow(
      "not supported on Codeup",
    );
  });

  it("treats success=false as a command error and retries repository resolution after invalidate", async () => {
    let repositoryCalls = 0;
    const { service } = makeService((action, args) => {
      if (action === "GetRepository") {
        repositoryCalls += 1;
        if (repositoryCalls === 1) {
          return { success: false, errorCode: "Openapi.RequestError", errorMessage: "denied" };
        }
      }
      return defaultResponder(action, args);
    });
    await expect(service.getPullRequest({ cwd: "/repo", number: 7 })).rejects.toBeInstanceOf(
      AliyunCommandError,
    );
    await expect(service.getPullRequest({ cwd: "/repo", number: 7 })).resolves.toMatchObject({
      number: 7,
    });
    service.invalidate({ cwd: "/repo" });
    await service.getPullRequest({ cwd: "/repo", number: 7 });
    expect(repositoryCalls).toBe(3);
  });

  it("classifies credential failures returned with success=false", async () => {
    const { service } = makeService((action, args) => {
      if (action === "GetRepository") {
        return {
          success: false,
          errorCode: "InvalidAccessKeyId.NotFound",
          errorMessage: "The AccessKey ID does not exist",
        };
      }
      return defaultResponder(action, args);
    });
    await expect(service.getPullRequest({ cwd: "/repo", number: 7 })).rejects.toBeInstanceOf(
      AliyunAuthenticationError,
    );
  });
});
