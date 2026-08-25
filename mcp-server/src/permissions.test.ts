import { beforeEach, describe, expect, it, vi } from "vitest";

const getWatchedResources = vi.fn();

vi.mock("utils", async (importActual) => {
  const actual = await importActual<typeof import("utils")>();
  return { ...actual, getWatchedResources };
});

const { getPermissionStatus } = await import("./permissions.js");

const ctx = { linkedAwsUserId: "AIDAEXAMPLE" } as Parameters<typeof getPermissionStatus>[0];

const WATCHED = "arn:aws:s3:::watched-bucket";
const NEVER_REPORTED = "arn:aws:s3:::never-reported";

const fresh = () => new Date().toISOString();

// The join itself is covered in utils/src/watchedResources.test.ts; these cover
// what MCP adds on top — filtering, the summary, and per-action views.
const givenWatched = (
  resources: unknown[],
  permissionsData: Record<string, unknown> = {},
) => {
  getWatchedResources.mockResolvedValue({
    watchlist: { name: "default" },
    permission: { name: "dev", updatedAt: new Date("2026-08-19T07:51:25Z") },
    permissionsData,
    resources,
  });
};

beforeEach(() => vi.clearAllMocks());

describe("getPermissionStatus", () => {
  it("reports every watched resource with its status and display name", async () => {
    givenWatched(
      [
        { arn: WATCHED, actions: [], name: "watched-bucket", status: "healthy" },
        { arn: NEVER_REPORTED, actions: [], status: "unscanned" },
      ],
      { [WATCHED]: { "s3:GetObject": { status: "valid", evaluatedAt: fresh(), timestamp: fresh() } } },
    );

    const result = await getPermissionStatus(ctx, {});

    expect(result.resources?.map(({ arn, status, name }) => ({ arn, status, name }))).toEqual([
      { arn: WATCHED, status: "healthy", name: "watched-bucket" },
      { arn: NEVER_REPORTED, status: "unscanned", name: undefined },
    ]);
    expect(result.summary?.resourceStatus).toEqual({
      healthy: 1,
      blocked: 0,
      stale: 0,
      unscanned: 1,
    });
  });

  it("keeps the summary across the whole watchlist while filtering the returned resources", async () => {
    givenWatched(
      [
        { arn: WATCHED, actions: [], status: "blocked" },
        { arn: NEVER_REPORTED, actions: [], status: "unscanned" },
      ],
      { [WATCHED]: { "s3:GetObject": { status: "error", reason: "denied", evaluatedAt: fresh(), timestamp: fresh() } } },
    );

    const result = await getPermissionStatus(ctx, { arn: WATCHED });

    expect(result.resources).toHaveLength(1);
    expect(result.summary?.resources).toBe(2);
    expect(result.summary?.resourceStatus.unscanned).toBe(1);
    expect(result.summary?.blocked).toBe(1);
  });

  it("drops the camelCase alias the Brain writes beside each canonical action", async () => {
    givenWatched([{ arn: WATCHED, actions: [], status: "healthy" }], {
      [WATCHED]: {
        "s3:GetObject": { status: "valid", evaluatedAt: fresh(), timestamp: fresh() },
        getObject: { status: "valid", evaluatedAt: fresh(), timestamp: fresh() },
      },
    });

    const result = await getPermissionStatus(ctx, {});

    expect(result.resources?.[0]?.actions.map(({ action }) => action)).toEqual(["s3:GetObject"]);
  });

  it("still answers when the logic service has produced nothing at all", async () => {
    givenWatched([
      { arn: WATCHED, actions: [], status: "unscanned" },
      { arn: NEVER_REPORTED, actions: [], status: "unscanned" },
    ]);

    const result = await getPermissionStatus(ctx, {});

    expect(result.exists).toBe(true);
    expect(result.summary?.resourceStatus.unscanned).toBe(2);
    expect(result.message).toContain("logic service");
  });

  it("reports an empty watchlist as nothing to evaluate", async () => {
    givenWatched([]);

    const result = await getPermissionStatus(ctx, {});

    expect(result.exists).toBe(false);
    expect(result.message).toContain("watchlist is empty");
  });
});
