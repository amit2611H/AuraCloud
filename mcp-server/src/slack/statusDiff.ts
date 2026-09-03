import type { ActionResult, ArnPermissionEntry } from "utils";
import type { Verdict } from "./slack.js";

/** Keyed by snapshotKey(arn, action) — both parts come from the watchlist only. */
/** Snapshot keys join arn + action with a NUL separator no ARN or action can contain. */
export const snapshotKey = (arn: string, action: string): string => `${arn}\u0000${action}`;

export type StatusSnapshot = Map<string, Verdict>;

export interface WatchedActionChange {
  arn: string;
  name?: string;
  action: string;
  oldStatus: Verdict;
  newStatus: Verdict;
  reason?: string | null;
}

interface WatchedEntry {
  arn: string;
  actions: string[];
  name?: string;
}

type VerdictResult = ActionResult & { reason?: string | null };

const isVerdict = (status: string | undefined): status is Verdict =>
  status === "valid" || status === "error";

// permissionsData entries are either one top-level verdict for the whole ARN or
// a per-action map (same duality resolveResourceStatus handles).
const actionResult = (
  entry: ArnPermissionEntry | undefined,
  action: string,
): VerdictResult | undefined => {
  if (!entry) return undefined;
  if (typeof (entry as ActionResult).status === "string") return entry as VerdictResult;
  return (entry as Record<string, VerdictResult>)[action];
};

/**
 * Compare the current verdicts of WATCHED resources/actions against the previous
 * snapshot. Strictly watchlist-scoped: permissionsData entries for unwatched ARNs
 * or unwatched actions are never read. A null previous snapshot seeds silently
 * (first cycle / worker restart must not replay history as alerts), and a newly
 * appearing verdict is snapshotted without alerting — only transitions alert.
 */
export const diffWatchedStatuses = (
  previous: StatusSnapshot | null,
  watched: WatchedEntry[],
  permissionsData: Record<string, ArnPermissionEntry>,
): { changes: WatchedActionChange[]; snapshot: StatusSnapshot } => {
  const snapshot: StatusSnapshot = new Map();
  const changes: WatchedActionChange[] = [];

  for (const resource of watched) {
    for (const action of resource.actions) {
      const result = actionResult(permissionsData[resource.arn], action);
      if (!isVerdict(result?.status)) continue;

      const key = snapshotKey(resource.arn, action);
      snapshot.set(key, result.status);

      const prior = previous?.get(key);
      if (previous && prior !== undefined && prior !== result.status) {
        changes.push({
          arn: resource.arn,
          ...(resource.name ? { name: resource.name } : {}),
          action,
          oldStatus: prior,
          newStatus: result.status,
          reason: result.reason ?? null,
        });
      }
    }
  }

  return { changes, snapshot };
};

export interface ResourceChanges {
  arn: string;
  name?: string;
  changes: WatchedActionChange[];
}

/** One group per resource, in first-seen order — the worker sends one message each. */
export const groupByResource = (changes: WatchedActionChange[]): ResourceChanges[] => {
  const groups = new Map<string, ResourceChanges>();
  for (const change of changes) {
    let group = groups.get(change.arn);
    if (!group) {
      group = { arn: change.arn, ...(change.name ? { name: change.name } : {}), changes: [] };
      groups.set(change.arn, group);
    }
    group.changes.push(change);
  }
  return [...groups.values()];
};
