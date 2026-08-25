import { getWatchedResources, type ResourceStatus } from "utils";
import type { UserContext } from "./identity.js";

interface StoredActionResult {
  status?: string;
  reason?: string | null;
  timestamp?: string;
  evaluatedAt?: string | null;
  details?: unknown;
}

export interface PermissionStatusFilters {
  arn?: string;
  action?: string;
  status?: "valid" | "error";
  includeDetails?: boolean;
}

export interface ActionStatusView {
  action: string;
  status: string;
  reason: string | null;
  evaluatedAt?: string;
  details?: unknown;
}

export interface ResourceStatusView {
  arn: string;
  /** The name shown on the dashboard, absent once a resource leaves AWS. */
  name?: string;
  /** Resolved the same way the dashboard resolves it. */
  status: ResourceStatus;
  actions: ActionStatusView[];
}

export interface PermissionStatusResult {
  exists: boolean;
  userId: string;
  name?: string;
  lastEvaluatedAt?: string;
  /** Always reflects the full watchlist, regardless of filters. */
  summary?: {
    resources: number;
    actions: number;
    valid: number;
    blocked: number;
    resourceStatus: Record<ResourceStatus, number>;
  };
  resources?: ResourceStatusView[];
  message?: string;
}

// logic/src/index.ts stores each action under its canonical name (e.g. "s3:GetObject")
// AND a camelCase alias ("getObject") kept for frontend compatibility. Reproduce the
// alias formula so the duplicates can be dropped and only canonical entries returned.
// Known trade-off: a watched action whose literal name equals another action's alias
// (e.g. "getObject" watched next to "s3:GetObject") is indistinguishable from that
// alias — the writer already collides on the key — so it is dropped here too. The
// root fix is removing the alias write in logic/src/index.ts.
const camelCaseAliasOf = (actionName: string): string => {
  const tail = actionName.split(":").pop() ?? actionName;
  return tail.charAt(0).toLowerCase() + tail.slice(1);
};

const canonicalActionNames = (actionMap: Record<string, unknown>): string[] => {
  const keys = Object.keys(actionMap);
  const aliases = new Set<string>();
  for (const key of keys) {
    const alias = camelCaseAliasOf(key);
    if (alias !== key) aliases.add(alias);
  }
  return keys.filter((key) => !aliases.has(key));
};

// Forgiving action match in both directions: filter "GetObject" hits stored
// "s3:GetObject", and filter "s3:GetObject" hits a stored bare "GetObject".
// Two different service prefixes never match each other.
const actionMatches = (actionName: string, filter: string): boolean => {
  const name = actionName.toLowerCase();
  const wanted = filter.toLowerCase();
  return (
    name === wanted ||
    name.split(":").pop() === wanted ||
    name === wanted.split(":").pop()
  );
};

const unscannedMessage = (watchedCount: number): string =>
  `No evaluation results yet for the ${watchedCount} watched resource(s) — the AuraCloud logic service may not be running or hasn't completed an evaluation cycle.`;

export const getPermissionStatus = async (
  ctx: UserContext,
  filters: PermissionStatusFilters,
): Promise<PermissionStatusResult> => {
  const { permission, resources: watchedResources, permissionsData } = await getWatchedResources(
    ctx.linkedAwsUserId,
  );

  if (watchedResources.length === 0) {
    return {
      exists: false,
      userId: ctx.linkedAwsUserId,
      message:
        "No evaluation results: the watchlist is empty. Add resources with add_watchlist_resource first.",
    };
  }

  const actionsByArn = permissionsData as Record<string, Record<string, StoredActionResult>>;

  const summary = {
    resources: watchedResources.length,
    actions: 0,
    valid: 0,
    blocked: 0,
    resourceStatus: { healthy: 0, blocked: 0, stale: 0, unscanned: 0 } as Record<
      ResourceStatus,
      number
    >,
  };
  const resources: ResourceStatusView[] = [];

  // Driven by the watchlist, so a resource the logic service never evaluated is
  // reported as unscanned rather than omitted.
  for (const { arn, name, status: resourceStatus } of watchedResources) {
    const actionMap = actionsByArn[arn];
    summary.resourceStatus[resourceStatus]++;

    // ARNs are case-sensitive — exact match only (get_watchlist returns exact ARNs).
    const arnMatch = !filters.arn || arn === filters.arn;

    const views: ActionStatusView[] = [];
    for (const actionName of actionMap ? canonicalActionNames(actionMap) : []) {
      const result = actionMap[actionName];
      if (!result) continue;
      const status = result.status ?? "unknown";
      // The summary always covers the full watchlist, so count before filtering.
      summary.actions++;
      if (status === "valid") summary.valid++;
      if (status === "error") summary.blocked++;

      if (!arnMatch) continue;
      if (filters.status && status !== filters.status) continue;
      if (filters.action && !actionMatches(actionName, filters.action)) continue;

      views.push({
        action: actionName,
        status,
        reason: result.reason ?? null,
        ...(filters.includeDetails
          ? {
              ...(result.evaluatedAt ? { evaluatedAt: result.evaluatedAt } : {}),
              details: result.details,
            }
          : {}),
      });
    }

    if (!arnMatch) continue;
    // Keep a resource with zero matching actions only when nothing filtered it out
    // (a watched resource with no monitored actions is itself useful information).
    if (views.length > 0 || (!filters.action && !filters.status)) {
      resources.push({ arn, ...(name ? { name } : {}), status: resourceStatus, actions: views });
    }
  }

  const filtered = Boolean(filters.arn || filters.action || filters.status);
  const nothingScanned = summary.resourceStatus.unscanned === watchedResources.length;

  return {
    exists: true,
    userId: ctx.linkedAwsUserId,
    ...(permission?.name ? { name: permission.name } : {}),
    lastEvaluatedAt: permission?.updatedAt?.toISOString(),
    summary,
    resources,
    ...(nothingScanned ? { message: unscannedMessage(watchedResources.length) } : {}),
    ...(resources.length === 0 && filtered
      ? { message: "No watched actions match the given filters." }
      : {}),
  };
};
