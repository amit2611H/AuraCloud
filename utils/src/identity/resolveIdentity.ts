import type { RedisClientType } from 'redis';
import { getIAMUser, getSsoUser } from './loadUser.js';
import { policyRefsFromIamEntities, policyRefsFromPermissionSets, resolvePolicies } from './policyBindings.js';
import type { ResolvedIdentity } from './types.js';

function accountIdFromResourceArns(resourceArns: string[]): string {
  return resourceArns.map((arn) => arn.split(':')[4]).find(Boolean) ?? '';
}

export function collectAccessibleAwsAccountIds(userData: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const addAccountId = (value: unknown) => {
    if (typeof value === 'string' && value) ids.add(value);
  };

  const permissionSets = userData.PermissionSets;
  if (Array.isArray(permissionSets)) {
    for (const assignment of permissionSets) {
      if (assignment && typeof assignment === 'object') {
        addAccountId((assignment as { AccountId?: unknown }).AccountId);
      }
    }
  }

  const groups = userData.resolvedGroups;
  if (Array.isArray(groups)) {
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue;
      const groupSets = (group as { PermissionSets?: unknown }).PermissionSets;
      if (!Array.isArray(groupSets)) continue;
      for (const assignment of groupSets) {
        if (assignment && typeof assignment === 'object') {
          addAccountId((assignment as { AccountId?: unknown }).AccountId);
        }
      }
    }
  }

  return [...ids];
}

async function getAssumedRoleIdForPermissionSets(
  permissionSets: Record<string, unknown>[],
  redis: RedisClientType,
): Promise<string | undefined> {
  const first = permissionSets[0];
  const psName = first && typeof first.Name === 'string' ? first.Name : undefined;
  if (!psName) return undefined;

  const allRoles = await redis.hGetAll('aura:iam:roles');
  for (const [roleName, roleDataStr] of Object.entries(allRoles)) {
    if (!roleName.startsWith(`AWSReservedSSO_${psName}_`)) continue;
    try {
      const roleObj = JSON.parse(roleDataStr) as { RoleId?: unknown };
      if (typeof roleObj.RoleId === 'string' && roleObj.RoleId) return roleObj.RoleId;
    } catch {
      /* skip malformed role entry */
    }
  }
  return undefined;
}

async function resolveSsoIdentity(
  redis: RedisClientType,
  userId: string,
  resourceArns: string[],
): Promise<ResolvedIdentity | null> {
  const ssoUserData = await getSsoUser(redis, userId);
  if (!ssoUserData) return null;

  const resolvedPermissionSets = (ssoUserData.resolvedPermissionSets ?? []) as Record<string, unknown>[];
  const resolvedGroups = (ssoUserData.resolvedGroups ?? []) as Record<string, unknown>[];
  const policies = await resolvePolicies(
    redis,
    policyRefsFromPermissionSets(resolvedPermissionSets, resolvedGroups),
  );
  const accessibleAwsAccountIds = collectAccessibleAwsAccountIds(ssoUserData);

  const primaryEvaluationAccountId = accessibleAwsAccountIds[0] ?? '';
  const accountIdField = typeof ssoUserData.accountId === 'string' ? ssoUserData.accountId.trim() : '';
  const accountId = accountIdField || primaryEvaluationAccountId || accountIdFromResourceArns(resourceArns) || '';

  const assumedRoleId = await getAssumedRoleIdForPermissionSets(resolvedPermissionSets, redis);
  const userName = typeof ssoUserData.UserName === 'string' ? ssoUserData.UserName : undefined;

  const identity: ResolvedIdentity = {
    source: 'sso',
    raw: ssoUserData,
    policies,
    accessibleAwsAccountIds,
    accountId,
    arn: (typeof ssoUserData.arn === 'string' ? ssoUserData.arn : undefined) ?? userName ?? `auracloud:sso:${userId}`,
  };

  if (assumedRoleId && userName) {
    identity.awsUserId = `${assumedRoleId}:${userName}`;
  }

  return identity;
}

async function resolveIamIdentity(
  redis: RedisClientType,
  userId: string,
  resourceArns: string[],
): Promise<ResolvedIdentity | null> {
  const iamUserData = await getIAMUser(redis, userId);
  if (!iamUserData) return null;

  const resolvedGroups = (iamUserData.resolvedGroups ?? []) as Record<string, unknown>[];
  const policies = await resolvePolicies(redis, policyRefsFromIamEntities(iamUserData, resolvedGroups));

  const arn = typeof iamUserData.Arn === 'string' ? iamUserData.Arn : undefined;
  const accountFromArn = arn?.split(':')[4];
  const accountId = accountFromArn || accountIdFromResourceArns(resourceArns) || '';
  const userName = typeof iamUserData.UserName === 'string' ? iamUserData.UserName : '';

  const identity: ResolvedIdentity = {
    source: 'iam',
    raw: iamUserData,
    policies,
    accessibleAwsAccountIds: accountId ? [accountId] : [],
    accountId,
    arn: arn ?? `arn:aws:iam::${accountId}:user/${userName}`,
  };

  const iamUserId = iamUserData.UserId;
  if (typeof iamUserId === 'string' && iamUserId) {
    identity.awsUserId = iamUserId;
  }

  return identity;
}

export async function resolveIdentity(
  redis: RedisClientType,
  userId: string,
  resourceArns: string[],
): Promise<ResolvedIdentity | null> {
  const ssoIdentity = await resolveSsoIdentity(redis, userId, resourceArns);
  if (ssoIdentity) return ssoIdentity;
  return resolveIamIdentity(redis, userId, resourceArns);
}

export function toEvalUser(identity: ResolvedIdentity): Record<string, unknown> {
  return {
    ...identity.raw,
    identityType: identity.source === 'sso' ? 'SSO' : 'IAM',
    policies: identity.policies,
    accessibleAwsAccountIds: identity.accessibleAwsAccountIds,
    accountId: identity.accountId,
    arn: identity.arn,
    ...(identity.awsUserId !== undefined ? { awsUserId: identity.awsUserId } : {}),
  };
}

/** SSO then IAM, then flatten for `evaluateResourceActions`. */
export async function buildEvaluationSubject(
  redis: RedisClientType,
  awsUserId: string,
  resourceArns: string[],
): Promise<Record<string, unknown> | null> {
  const identity = await resolveIdentity(redis, awsUserId, resourceArns);
  return identity ? toEvalUser(identity) : null;
}
