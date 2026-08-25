import {
  attemptDeepParse,
  buildEvaluationSubject,
  disconnectRedis,
  evaluateResourceActions,
  getRedisClient,
  getResourceField,
  getResourceTypeFromArn,
  isFresh,
  UserResourceWatchlistModel,
  type EvaluationResult,
  type RedisClientType,
} from "utils";
import type { UserContext } from "./identity.js";
import { DomainError, assertWatchableArn, unknownActionWarnings } from "./watchlist.js";

export interface TheoreticalPermissionResult {
  arn: string;
  action: string;
  /** Same vocabulary as get_permission_status: 'valid' = allowed, 'error' = blocked, 'stale' = stale. */
  status: "valid" | "error" | "stale";
  allowed: boolean;
  reason: string;
  /** Whether this resource is also on the user's watchlist (see get_permission_status). */
  watched: boolean;
  evaluatedAt: string;
  warnings?: string[];
  details?: { context: EvaluationResult["context"]; steps: EvaluationResult["steps"] };
}

const crawlerCache = async (): Promise<RedisClientType> => {
  try {
    // getRedisClient()'s concrete client type and the bare RedisClientType alias
    // disagree only on node-redis's RESP-version generic (the runtime object is
    // the same client; logic/src passes it the same way) — hence the cast.
    return (await getRedisClient()) as unknown as RedisClientType;
  } catch {
    // utils caches the rejected connection promise; clear it so the next call
    // can retry once Redis is back instead of failing forever.
    await disconnectRedis().catch(() => {});
    throw new DomainError(
      "The crawler cache (Redis) is unreachable — theoretical evaluation runs against live crawled data and needs it. Start the stack's Redis and retry.",
    );
  }
};

/** True if this ARN is on the acting user's watchlist. */
const isArnWatched = async (ctx: UserContext, arn: string): Promise<boolean> =>
  Boolean(
    await UserResourceWatchlistModel.exists({
      userId: ctx.linkedAwsUserId,
      "resources.arn": arn,
    }).exec(),
  );

/**
 * Live, read-only "would I be allowed?" evaluation for any discovered resource,
 * watched or not. Same `buildEvaluationSubject` + `evaluateResourceActions`
 * path as the logic service, so a theoretical verdict matches what the
 * dashboard would show if the resource were watched. Never writes anything.
 */
export const checkTheoreticalPermission = async (
  ctx: UserContext,
  arn: string,
  action: string,
  includeDetails: boolean,
): Promise<TheoreticalPermissionResult> => {
  try {
    await assertWatchableArn(arn);
  } catch (err) {
    // A watched ARN can be absent from the catalogue (deleted from AWS after
    // being watched, or garbage predating validation) — get_permission_status
    // still serves its stored verdict, so explain the asymmetry instead of
    // leaving the user with a bare rejection. The lookup itself must never
    // replace the informative validation error, hence the catch-to-false.
    if (err instanceof DomainError && (await isArnWatched(ctx, arn).catch(() => false))) {
      throw new DomainError(
        `${err.message} Note: this ARN is on your watchlist — it may have been deleted from AWS after being watched; get_permission_status still shows its last stored verdict.`,
      );
    }
    throw err;
  }
  const warnings = await unknownActionWarnings(arn, [action]);

  const redis = await crawlerCache();
  const subject = await buildEvaluationSubject(redis, ctx.linkedAwsUserId, [arn]);
  if (!subject) {
    throw new DomainError(
      `No crawled identity data for your linked AWS user (${ctx.linkedAwsUserId}). The evaluator covers SSO and IAM users the crawlers have synced — freshly linked users appear after the next crawl cycle.`,
    );
  }
  const resourceType = getResourceTypeFromArn(arn);
  const resourceData = await getResourceField(redis, resourceType, arn);
  const parsedData = resourceData ? attemptDeepParse(resourceData) : null;

  const results = await evaluateResourceActions(arn, [action], subject, parsedData);
  const result = results[action]!;

  const watched = await isArnWatched(ctx, arn);

  const rawEvaluatedAt = parsedData?.updated_at ?? parsedData?.updatedAt;
  const evaluatedAt = typeof rawEvaluatedAt === "string" ? rawEvaluatedAt : new Date().toISOString();
  const fresh = typeof rawEvaluatedAt === "string" && isFresh(rawEvaluatedAt);

  const status: "valid" | "error" | "stale" = fresh
    ? (result.allowed ? "valid" : "error")
    : "stale";

  const allWarnings = [...warnings];
  if (!fresh) {
    if (!rawEvaluatedAt) {
      allWarnings.push(
        "Resource data has not been synced by crawlers yet — evaluated without resource-specific policies.",
      );
    } else {
      allWarnings.push(
        `Crawled resource data is stale (last synced at ${rawEvaluatedAt}).`,
      );
    }
  }

  return {
    arn,
    action,
    status,
    allowed: result.allowed,
    reason: result.reason,
    watched,
    evaluatedAt,
    ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
    ...(includeDetails ? { details: { context: result.context, steps: result.steps } } : {}),
  };
};
