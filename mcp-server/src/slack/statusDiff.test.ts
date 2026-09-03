import { describe, expect, it } from "vitest";
import { diffWatchedStatuses, groupByResource, snapshotKey, type StatusSnapshot } from "./statusDiff.js";

const WATCHED = [
  { arn: "arn:aws:s3:::bucket-a", actions: ["s3:GetObject", "s3:PutObject"], name: "bucket-a" },
];

const verdicts = (getObject: string, putObject?: string) => ({
  "arn:aws:s3:::bucket-a": {
    "s3:GetObject": { status: getObject, evaluatedAt: "2026-09-03T08:00:00Z" },
    ...(putObject ? { "s3:PutObject": { status: putObject, evaluatedAt: "2026-09-03T08:00:00Z" } } : {}),
  },
});

describe("diffWatchedStatuses", () => {
  it("seeds silently on the first cycle (null previous)", () => {
    const { changes, snapshot } = diffWatchedStatuses(null, WATCHED, verdicts("error"));
    expect(changes).toEqual([]);
    expect(snapshot.get(snapshotKey("arn:aws:s3:::bucket-a", "s3:GetObject"))).toBe("error");
  });

  it("alerts on valid -> error with the deny reason", () => {
    const { snapshot: previous } = diffWatchedStatuses(null, WATCHED, verdicts("valid"));
    const next = {
      "arn:aws:s3:::bucket-a": {
        "s3:GetObject": { status: "error", reason: "Explicit Deny in resource policy" },
      },
    };
    const { changes } = diffWatchedStatuses(previous, WATCHED, next);
    expect(changes).toEqual([
      {
        arn: "arn:aws:s3:::bucket-a",
        name: "bucket-a",
        action: "s3:GetObject",
        oldStatus: "valid",
        newStatus: "error",
        reason: "Explicit Deny in resource policy",
      },
    ]);
  });

  it("alerts on recovery (error -> valid)", () => {
    const { snapshot: previous } = diffWatchedStatuses(null, WATCHED, verdicts("error"));
    const { changes } = diffWatchedStatuses(previous, WATCHED, verdicts("valid"));
    expect(changes).toHaveLength(1);
    expect(changes[0].newStatus).toBe("valid");
  });

  it("never reads unwatched ARNs, even when their status flips", () => {
    const withUnwatched = (status: string) => ({
      ...verdicts("valid"),
      "arn:aws:s3:::unwatched": { "s3:GetObject": { status } },
    });
    const { snapshot: previous } = diffWatchedStatuses(null, WATCHED, withUnwatched("valid"));
    const { changes, snapshot } = diffWatchedStatuses(previous, WATCHED, withUnwatched("error"));
    expect(changes).toEqual([]);
    expect([...snapshot.keys()].some((key) => key.includes("unwatched"))).toBe(false);
  });

  it("never reads actions that are not on the watchlist entry", () => {
    const extraAction = (status: string) => ({
      "arn:aws:s3:::bucket-a": {
        "s3:GetObject": { status: "valid" },
        "s3:DeleteObject": { status },
      },
    });
    const { snapshot: previous } = diffWatchedStatuses(null, WATCHED, extraAction("valid"));
    const { changes } = diffWatchedStatuses(previous, WATCHED, extraAction("error"));
    expect(changes).toEqual([]);
  });

  it("snapshots a newly appearing verdict without alerting, then alerts on its next flip", () => {
    const { snapshot: first } = diffWatchedStatuses(null, WATCHED, verdicts("valid"));
    const { changes: onAppear, snapshot: second } = diffWatchedStatuses(
      first,
      WATCHED,
      verdicts("valid", "valid"),
    );
    expect(onAppear).toEqual([]);
    const { changes: onFlip } = diffWatchedStatuses(second, WATCHED, verdicts("valid", "error"));
    expect(onFlip).toHaveLength(1);
    expect(onFlip[0].action).toBe("s3:PutObject");
  });

  it("applies a single top-level verdict to every watched action", () => {
    const single = (status: string) => ({
      "arn:aws:s3:::bucket-a": { status, evaluatedAt: "2026-09-03T08:00:00Z" },
    });
    const { snapshot: previous } = diffWatchedStatuses(null, WATCHED, single("valid"));
    const { changes } = diffWatchedStatuses(previous, WATCHED, single("error"));
    expect(changes.map((change) => change.action).sort()).toEqual(["s3:GetObject", "s3:PutObject"]);
  });

  it("ignores entries with no usable verdict", () => {
    const previous: StatusSnapshot = new Map();
    const { changes, snapshot } = diffWatchedStatuses(previous, WATCHED, {});
    expect(changes).toEqual([]);
    expect(snapshot.size).toBe(0);
  });
});

describe("groupByResource", () => {
  const change = (arn: string, action: string, name?: string) => ({
    arn,
    ...(name ? { name } : {}),
    action,
    oldStatus: "valid" as const,
    newStatus: "error" as const,
    reason: null,
  });

  it("returns one group per resource, keeping all its action changes together", () => {
    const groups = groupByResource([
      change("arn:aws:s3:::a", "s3:GetObject", "a"),
      change("arn:aws:s3:::b", "s3:GetObject", "b"),
      change("arn:aws:s3:::b", "s3:PutObject", "b"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ arn: "arn:aws:s3:::a", name: "a" });
    expect(groups[0].changes).toHaveLength(1);
    expect(groups[1].changes.map((c) => c.action)).toEqual(["s3:GetObject", "s3:PutObject"]);
  });

  it("returns no groups for no changes", () => {
    expect(groupByResource([])).toEqual([]);
  });
});
