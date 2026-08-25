import {
  attemptDeepParse,
  buildEvaluationSubject,
  evaluateResourceActions,
  getResourceField,
  getResourceTypeFromArn,
  type RedisClientType,
  type UserResourceWatchlist,
} from 'utils';

export async function evaluateUser(user: UserResourceWatchlist, redis: RedisClientType) {
  const resourceArns = user.resources.map((resource) => resource.arn);
  const evalUser = await buildEvaluationSubject(redis, user.userId, resourceArns);

  if (!evalUser) {
    console.warn(
      `User data not found in Redis for user ${user.userId} (checked SSO & IAM). Actions will be marked as 'stale'.`,
    );
    return;
  }

  const resources = user.resources.map(async (resource) => {
    const resourceType = getResourceTypeFromArn(resource.arn);
    const resourceData = await getResourceField(redis, resourceType, resource.arn);
    const parsedData = resourceData ? attemptDeepParse(resourceData) : null;
    const results = await evaluateResourceActions(resource.arn, resource.actions, evalUser, parsedData);
    const actionResults = resource.actions.map((action) => ({ [action]: results[action] }));
    const evaluatedAt = parsedData?.updated_at ?? parsedData?.updatedAt ?? null;
    return { arn: resource.arn, actionResults, evaluatedAt };
  });

  return { userId: user.userId, resources: await Promise.all(resources) };
}
