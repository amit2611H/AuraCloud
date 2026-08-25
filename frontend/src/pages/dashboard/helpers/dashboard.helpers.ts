import { HEALTH_SCORE_FAIR, HEALTH_SCORE_GOOD } from "@/pages/dashboard/constants";
import type { StatusTagVariant } from "@/components/statusTag/types/statusTag.types";
import type { FilterTabValue } from "@/pages/dashboard/types/dashboard.types";
import type { ResourceCardAction } from "@/components/resourceCard/types/resourceCard.types";
import type {
  ActionData,
  ArnPermissionData,
  PermissionStatus,
  ResourceStatus,
} from "@/services/types/resources.types";

export { inferServiceFromArn, inferTitleFromArn } from "@/helpers/arn.helpers";
export { formatTimestamp } from "@/helpers/time.helpers";

interface HasStatus {
  status: unknown;
}

export const isTopLevelArnData = (
  data: ArnPermissionData,
): data is ActionData => typeof (data as HasStatus).status === "string";

/** Returns the ISO timestamp from the first available entry in the ARN data. */
export const getTimestampFromArnData = (data: ArnPermissionData): string => {
  if (isTopLevelArnData(data)) return data.evaluatedAt ?? "";
  const firstAction = Object.values(data as Record<string, ActionData>)[0];
  return firstAction?.evaluatedAt ?? "";
};


export const countFilterTabs = (
  watchedResources: Array<{ arn: string }>,
  resourceStatuses: Record<string, ResourceStatus>,
): Record<FilterTabValue, number> => {
  const counts: Record<FilterTabValue, number> = {
    all: watchedResources.length,
    blocked: 0,
    stale: 0,
    unscanned: 0,
    healthy: 0,
  };

  for (const { arn } of watchedResources) {
    counts[resourceStatuses[arn] ?? "unscanned"]++;
  }

  return counts;
};

export const filterResourcesByTab = <ResourceWithArn extends { arn: string }>(
  watchedResources: ResourceWithArn[],
  resourceStatuses: Record<string, ResourceStatus>,
  activeFilter: FilterTabValue,
): ResourceWithArn[] => {
  if (activeFilter === "all") return watchedResources;

  return watchedResources.filter(
    ({ arn }) => (resourceStatuses[arn] ?? "unscanned") === activeFilter,
  );
};

const STATUS_SEVERITY: ResourceStatus[] = ["blocked", "stale", "unscanned", "healthy"];

/** Sort is stable, so resources keep their watchlist order within a status. */
export const sortResourcesByStatus = <ResourceWithArn extends { arn: string }>(
  watchedResources: ResourceWithArn[],
  resourceStatuses: Record<string, ResourceStatus>,
): ResourceWithArn[] =>
  [...watchedResources].sort(
    (first, second) =>
      STATUS_SEVERITY.indexOf(resourceStatuses[first.arn] ?? "unscanned") -
      STATUS_SEVERITY.indexOf(resourceStatuses[second.arn] ?? "unscanned"),
  );

/** Mirrors the resource order: denied first, then unreported, then allowed. */
const actionSeverity = (status?: PermissionStatus): number => {
  if (status === "error") return 0;
  if (status === undefined) return 1;

  return 2;
};

/** Keyed by the watched action names, so the Brain's camelCase aliases never double up. */
export const resolveWatchedActions = (
  actionNames: string[],
  data: ArnPermissionData | undefined,
): ResourceCardAction[] => {
  const resolved: ResourceCardAction[] = actionNames.map((name) => {
    if (!data) return { name };

    if (isTopLevelArnData(data)) {
      return { name, status: data.status, ...(data.reason ? { reason: data.reason } : {}) };
    }

    const result = (data as Record<string, ActionData>)[name];
    if (!result) return { name };

    return { name, status: result.status, ...(result.reason ? { reason: result.reason } : {}) };
  });

  // Sorted so the blocked actions are the ones shown before "+N more".
  return resolved.sort(
    (first, second) => actionSeverity(first.status) - actionSeverity(second.status),
  );
};

export type HealthScoreBand = "good" | "fair" | "poor";

export const getHealthScoreBand = (score: number): HealthScoreBand => {
  if (score >= HEALTH_SCORE_GOOD) return "good";
  if (score >= HEALTH_SCORE_FAIR) return "fair";

  return "poor";
};

export type ResourceStatusCounts = Record<ResourceStatus, number>;

/** Keyed by the watchlist, so an ARN the server did not resolve still counts as unscanned. */
export const countResourceStatuses = (
  watchedArns: string[],
  resourceStatuses: Record<string, ResourceStatus>,
): ResourceStatusCounts => {
  const counts: ResourceStatusCounts = { healthy: 0, blocked: 0, stale: 0, unscanned: 0 };

  for (const arn of watchedArns) {
    counts[resourceStatuses[arn] ?? "unscanned"]++;
  }

  return counts;
};

export interface SystemStatus {
  variant: StatusTagVariant;
  labelKey?: string;
}

export const deriveSystemStatus = (
  isLoading: boolean,
  isError: boolean,
  monitoredCount: number,
  staleCount: number,
): SystemStatus => {
  if (isLoading) return { variant: "stale", labelKey: "dashboard.systemStatus.checking" };

  if (isError) return { variant: "stale", labelKey: "dashboard.systemStatus.degraded" };

  // Every watched resource going stale means the Brain stopped writing, which the
  // API answering successfully does not reveal.
  if (monitoredCount > 0 && staleCount === monitoredCount) {
    return { variant: "stale", labelKey: "dashboard.systemStatus.degraded" };
  }

  return { variant: "online" };
};

export interface StatusMessage {
  headingKey: string;
  headingValues?: Record<string, number>;
  adviceKey: string;
}

export interface StatusMessageInput {
  isLoading: boolean;
  monitoredCount: number;
  blockedCount: number;
  staleCount: number;
  unscannedCount: number;
}

// Unmeasurable states first: their zero counts would otherwise read as healthy.
export const deriveStatusMessage = ({
  isLoading,
  monitoredCount,
  blockedCount,
  staleCount,
  unscannedCount,
}: StatusMessageInput): StatusMessage => {
  if (isLoading) {
    return {
      headingKey: "dashboard.healthHeading.awaitingScan",
      adviceKey: "dashboard.statusAdvice.loading",
    };
  }

  if (monitoredCount === 0) {
    return {
      headingKey: "dashboard.healthHeading.nothingMonitored",
      adviceKey: "dashboard.statusAdvice.nothingMonitored",
    };
  }

  if (unscannedCount === monitoredCount) {
    return {
      headingKey: "dashboard.healthHeading.awaitingScan",
      adviceKey: "dashboard.statusAdvice.awaitingScan",
    };
  }

  // Unscanned folds into stale here: both mean there is no verdict worth trusting.
  const unverifiedCount = staleCount + unscannedCount;

  if (blockedCount > 0 && unverifiedCount > 0) {
    return {
      headingKey: "dashboard.healthHeading.mixed",
      headingValues: { blockers: blockedCount, stale: unverifiedCount },
      adviceKey: "dashboard.statusAdvice.mixed",
    };
  }

  if (blockedCount > 0) {
    return {
      headingKey: "dashboard.healthHeading.degraded",
      headingValues: { count: blockedCount },
      adviceKey: "dashboard.statusAdvice.degraded",
    };
  }

  if (unverifiedCount > 0) {
    return {
      headingKey: "dashboard.healthHeading.stale",
      headingValues: { count: unverifiedCount },
      adviceKey: "dashboard.statusAdvice.stale",
    };
  }

  return {
    headingKey: "dashboard.healthHeading.healthy",
    adviceKey: "dashboard.statusAdvice.healthy",
  };
};
