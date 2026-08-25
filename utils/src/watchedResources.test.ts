import { beforeEach, describe, expect, it, vi } from "vitest";

const watchlistFindOne = vi.fn();
const permissionFindOne = vi.fn();
const catalogueFind = vi.fn();

vi.mock("./index.js", () => ({
  UserResourceWatchlistModel: { findOne: watchlistFindOne },
  UserPermissionModel: { findOne: permissionFindOne },
  AwsResourceModel: { find: catalogueFind },
}));

const { getWatchedResources } = await import("./watchedResources.js");

const WATCHED = "arn:aws:s3:::watched-bucket";
const NEVER_REPORTED = "arn:aws:s3:::never-reported";

const leanExec = (value: unknown) => ({ lean: () => ({ exec: async () => value }) });
const fresh = () => new Date().toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  watchlistFindOne.mockReturnValue(
    leanExec({
      _id: "watchlist-id",
      name: "default",
      userId: "AIDAEXAMPLE",
      resources: [
        { arn: WATCHED, actions: ["s3:GetObject"] },
        { arn: NEVER_REPORTED, actions: [] },
      ],
    }),
  );
  permissionFindOne.mockReturnValue(
    leanExec({
      name: "dev",
      userId: "AIDAEXAMPLE",
      permissionsData: { [WATCHED]: { "s3:GetObject": { status: "valid", evaluatedAt: fresh(), timestamp: fresh() } } },
    }),
  );
  catalogueFind.mockReturnValue(leanExec([{ arn: WATCHED, name: "watched-bucket-display" }]));
});

describe("getWatchedResources", () => {
  it("returns every watched resource, resolving one the Brain never reported", async () => {
    const { resources } = await getWatchedResources("AIDAEXAMPLE");

    expect(resources.map(({ arn, status }) => ({ arn, status }))).toEqual([
      { arn: WATCHED, status: "healthy" },
      { arn: NEVER_REPORTED, status: "unscanned" },
    ]);
  });

  it("attaches the catalogue name, and omits it when the catalogue has none", async () => {
    const { resources } = await getWatchedResources("AIDAEXAMPLE");

    expect(resources[0]?.name).toBe("watched-bucket-display");
    expect(resources[1]).not.toHaveProperty("name");
  });

  it("ignores Brain output for ARNs that are no longer watched", async () => {
    permissionFindOne.mockReturnValue(
      leanExec({
        name: "dev",
        userId: "AIDAEXAMPLE",
        permissionsData: {
          "arn:aws:s3:::unwatched": { "s3:GetObject": { status: "error", evaluatedAt: fresh(), timestamp: fresh() } },
        },
      }),
    );

    const { resources } = await getWatchedResources("AIDAEXAMPLE");

    expect(resources.every(({ status }) => status === "unscanned")).toBe(true);
  });

  it("answers with no resources when nothing is watched", async () => {
    watchlistFindOne.mockReturnValue(leanExec(null));

    const { watchlist, resources } = await getWatchedResources("AIDAEXAMPLE");

    expect(watchlist).toBeNull();
    expect(resources).toEqual([]);
    expect(catalogueFind).not.toHaveBeenCalled();
  });
});
