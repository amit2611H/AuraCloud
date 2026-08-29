import type { RedisClientType } from 'redis';
import { attemptDeepParse, getResourceTypeFromArn } from './utils.js';
import type { PolicyOrigin } from './identity/types.js';

export type EvalResult = 'ALLOW' | 'DENY' | 'IMPLICIT_DENY';

function resolveResourceAwsAccountId(resource: Record<string, unknown> | null | undefined): string | undefined {
    if (!resource || typeof resource !== 'object') return undefined;
    const id = resource.accountId;
    if (typeof id === 'string' && id.length > 0) return id;

    const arn = (resource.Arn ?? resource.BucketArn ?? resource.arn) as string | undefined;
    if (typeof arn === 'string') {
        const parts = arn.split(':');
        if (parts.length >= 5 && parts[4]) return parts[4];
    }
    return undefined;
}

function resolveIdentityAwsAccountPool(user: Record<string, unknown>): string[] {
    const fromAssignments = user.accessibleAwsAccountIds;
    if (Array.isArray(fromAssignments)) {
        const filtered = fromAssignments.filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (filtered.length > 0) return filtered;
    }
    const legacy = user.accountId;
    if (typeof legacy === 'string' && legacy.length > 0) return [legacy];
    return [];
}

export interface PolicyCheckResult {
  status: EvalResult;
  matchedStatement?: any;
  reason?: string | undefined;
  origin?: PolicyOrigin | undefined;
}

export interface EvaluationResult {
  allowed: boolean;
  reason: string;
  origin?: PolicyOrigin | undefined;
  context: Record<string, unknown>;
  steps: {
    scp: PolicyCheckResult;
    identity: PolicyCheckResult;
    resource: PolicyCheckResult;
    accountCheck: { treatAsSameAccount: boolean; isSameAccount: boolean };
  };
}

export function evaluate(resource: unknown, action: string, user: Record<string, unknown>): EvaluationResult {
    const res = (resource && typeof resource === 'object' ? resource : {}) as Record<string, unknown>;
    const resourceAccountId = resolveResourceAwsAccountId(res); 
    const identityAccountPool = resolveIdentityAwsAccountPool(user);
    const hasResourceAccount = Boolean(resourceAccountId);
    const isSameAccount = hasResourceAccount && identityAccountPool.some((id) => id === resourceAccountId);
    const singleIdentityContext = !hasResourceAccount && identityAccountPool.length === 1;
    const treatAsSameAccount = isSameAccount || singleIdentityContext;  
    
    // Build context for policy condition matching
    const groupNames = (user.resolvedGroups as Array<{ DisplayName?: string }> || []).map(g => g.DisplayName).filter(Boolean);
    const context: Record<string, unknown> = {
      'aws:userid': user.awsUserId || user.UserId || user.externalId || '',
      'aws:username': user.UserName || user.name || '',
      'aws:principalaccount': resourceAccountId || identityAccountPool[0] || '',
      'aws:principaltag/department': groupNames[0] || '',
    };

    const scpResult: PolicyCheckResult = { status: 'ALLOW' }; // Fallback

    const resourceArn = (res.arn ?? res.Arn ?? res.BucketArn ?? '') as string;
    const policies = user.policies as unknown[] | undefined;
    const idResult = checkIdentityPolicy(policies, action, resourceArn, context);
    
    const userArn = typeof user.arn === 'string' ? user.arn : '';
    const resResult = checkResourcePolicy(res.bucketPolicies || res.policy, action, userArn, context);

    let allowed = false;
    let reason = '';
    let origin: PolicyOrigin | undefined = undefined;

    if (idResult.status === 'DENY') {
      allowed = false;
      reason = idResult.reason || 'Explicit Deny in Identity Policy';
      origin = idResult.origin;
    } else if (resResult.status === 'DENY') {
      allowed = false;
      reason = resResult.reason || 'Explicit Deny in Resource Policy';
      origin = resResult.origin;
    } else {
      const identityAllowed = idResult.status === 'ALLOW';
      const resourceAllowed = resResult.status === 'ALLOW';

      if (!treatAsSameAccount) {
        allowed = identityAllowed && resourceAllowed;
        if (allowed) {
          reason = 'Allowed by both Identity Policy and Resource Policy (Cross-Account)';
          origin = idResult.origin || resResult.origin;
        } else {
          reason = `Denied (Cross-Account): Identity (user/group/role) Allowed: ${identityAllowed}, Resource Policy Allowed: ${resourceAllowed}`;
        }
      } else {
        allowed = identityAllowed || resourceAllowed;
        if (allowed) {
          reason = `Allowed (Same-Account): Identity Allowed: ${identityAllowed}, Resource Allowed: ${resourceAllowed}`;
          origin = (identityAllowed ? idResult.origin : resResult.origin) || idResult.origin || resResult.origin;
        } else {
          reason = 'Denied: No matching Allow statement found in identity policies (user, group, or role) or resource policy';
        }
      }
    }

    return {
      allowed,
      reason,
      ...(origin ? { origin } : {}),
      context,
      steps: {
        scp: scpResult,
        identity: idResult,
        resource: resResult,
        accountCheck: { treatAsSameAccount, isSameAccount }
      }
    };
}

function evaluateScp(_scps: unknown[], _action: string, _resource: unknown): EvalResult {
  return 'ALLOW';
}

function isMatch(pattern: string, actual: string): boolean {
  const regex = new RegExp(
    '^' + pattern.split('*').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
  );
  return regex.test(actual);
}

function matchesAny(patterns: string | string[], actual: string): boolean {
  const arr = Array.isArray(patterns) ? patterns : [patterns];
  return arr.some((p) => isMatch(p, actual));
}

function matchesResource(patterns: unknown, resourceArn: string): boolean {
  if (!patterns || !resourceArn) return true;
  const arr = Array.isArray(patterns) ? patterns : [patterns];
  return arr.some((p) => {
    if (typeof p !== 'string') return false;
    return isMatch(p, resourceArn) || isMatch(p, `${resourceArn}/*`);
  });
}

export function matchesCondition(condition: unknown, context: Record<string, unknown>): boolean {
  if (!condition || typeof condition !== 'object') return true;

  const condObj = condition as Record<string, Record<string, string | string[]>>;

  for (const [operator, keyValues] of Object.entries(condObj)) {
    const opLower = operator.toLowerCase();
    const isStringLike = opLower === 'stringlike';
    const isStringEquals = opLower === 'stringequals';
    const isStringNotEquals = opLower === 'stringnotequals';
    const isStringNotLike = opLower === 'stringnotlike';
    const isArnEquals = opLower === 'arnequals';
    const isArnLike = opLower === 'arnlike';
    const isArnNotEquals = opLower === 'arnnotequals';
    const isArnNotLike = opLower === 'arnnotlike';
    const isNull = opLower === 'null';

    const isValidOperator = isStringLike || isStringEquals || isStringNotEquals || isStringNotLike ||
                            isArnEquals || isArnLike || isArnNotEquals || isArnNotLike || isNull;
    if (!isValidOperator) {
      continue;
    }

    for (const [key, expectedRaw] of Object.entries(keyValues)) {
      const actualVal = context[key.toLowerCase()];
      const expectedArray = Array.isArray(expectedRaw) ? expectedRaw : [expectedRaw];

      if (isNull) {
        const expectsNull = expectedArray.some(v => String(v).toLowerCase() === 'true');
        const isCurrentlyNull = actualVal === undefined || actualVal === null || actualVal === '';
        if (expectsNull !== isCurrentlyNull) return false;
        continue;
      }

      if (actualVal === undefined || actualVal === null) {
        if (isStringNotEquals || isStringNotLike || isArnNotEquals || isArnNotLike) continue;
        return false;
      }

      const actualStr = String(actualVal);

      if (isStringEquals || isArnEquals) {
        if (!expectedArray.some(expected => expected === actualStr)) return false;
      } else if (isStringLike || isArnLike) {
        if (!expectedArray.some(expected => isMatch(String(expected), actualStr))) return false;
      } else if (isStringNotEquals || isArnNotEquals) {
        if (expectedArray.some(expected => expected === actualStr)) return false;
      } else if (isStringNotLike || isArnNotLike) {
        if (expectedArray.some(expected => isMatch(String(expected), actualStr))) return false;
      }
    }
  }

  return true;
}

function checkIdentityPolicy(
  policies: unknown[] | undefined,
  action: string,
  resourceArn: string,
  context: Record<string, unknown>
): PolicyCheckResult {
    let hasAllow = false;
    let allowedStatement: any = null;
    let allowedOrigin: PolicyOrigin | undefined = undefined;

    if (!policies?.length) {
      return { status: 'IMPLICIT_DENY', reason: 'No identity policies attached' };
    }

    for (const policy of policies) {
        if (!policy || typeof policy !== 'object') continue;
        const p = policy as {
          Statement?: unknown;
          Name?: string;
          PolicyName?: string;
          origin?: PolicyOrigin;
          document?: { Statement?: unknown; Name?: string; PolicyName?: string };
        };
        const doc = (p.document && typeof p.document === 'object' ? p.document : p) as {
          Statement?: unknown;
          Name?: string;
          PolicyName?: string;
        };
        const baseOrigin: PolicyOrigin = p.origin ?? {
          sourceType: 'identity',
          policyName: doc.PolicyName || doc.Name || 'InlinePolicy',
        };
        const policyName = baseOrigin.policyName || doc.PolicyName || doc.Name || 'InlinePolicy';
        const statements = Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement];

        for (const stmt of statements) {
            if (!stmt || typeof stmt !== 'object') continue;
            const s = stmt as { Action?: unknown; Effect?: unknown; Condition?: unknown; Sid?: string; Resource?: unknown };
            if (matchesAny((s.Action as string | string[]) ?? '', action)) {
                if (s.Resource && !matchesResource(s.Resource, resourceArn)) continue;
                if (s.Condition && !matchesCondition(s.Condition, context)) continue;

                const stmtOrigin: PolicyOrigin = {
                  ...baseOrigin,
                  ...(s.Sid ? { sid: s.Sid } : {}),
                };

                if (s.Effect === 'Deny') {
                    let reason = '';
                    if (stmtOrigin.sourceType === 'group' && stmtOrigin.groupName) {
                      if (stmtOrigin.permissionSetName) {
                        reason = `Explicit Deny in SSO group "${stmtOrigin.groupName}" (Permission Set: "${stmtOrigin.permissionSetName}", Policy: "${policyName}", Sid: ${s.Sid || 'Unnamed'})`;
                      } else {
                        reason = `Explicit Deny in group "${stmtOrigin.groupName}" policy "${policyName}" (Sid: ${s.Sid || 'Unnamed'})`;
                      }
                    } else if (stmtOrigin.sourceType === 'role' && stmtOrigin.permissionSetName) {
                      reason = `Explicit Deny in SSO role/permission set "${stmtOrigin.permissionSetName}" policy "${policyName}" (Sid: ${s.Sid || 'Unnamed'})`;
                    } else {
                      reason = `Explicit Deny in user identity policy "${policyName}" (Sid: ${s.Sid || 'Unnamed'})`;
                    }

                    return { 
                      status: 'DENY', 
                      matchedStatement: s, 
                      origin: stmtOrigin,
                      reason,
                    };
                }
                if (s.Effect === 'Allow') {
                    hasAllow = true;
                    allowedStatement = s;
                    allowedOrigin = stmtOrigin;
                }
            }
        }
    }

    if (hasAllow) {
        return { status: 'ALLOW', matchedStatement: allowedStatement, origin: allowedOrigin };
    }
    return { status: 'IMPLICIT_DENY', reason: 'No matching Allow statement in identity policies' };
}

export function checkResourcePolicy(
  policy: unknown,
  action: string,
  userArn: string,
  context: Record<string, unknown>
): PolicyCheckResult {
  if (!policy) {
    return { status: 'IMPLICIT_DENY', reason: 'No resource policy (bucket policy) exists' };
  }

  let hasAllow = false;
  let allowedStatement: any = null;
  let allowedOrigin: PolicyOrigin | undefined = undefined;

  try {
    const parsed = typeof policy === 'string' ? JSON.parse(policy) : policy;
    if (!parsed || typeof parsed !== 'object') {
      return { status: 'IMPLICIT_DENY', reason: 'Failed to parse resource policy' };
    }
    const pObj = parsed as { Statement?: unknown };
    const statements = Array.isArray(pObj.Statement) ? pObj.Statement : [pObj.Statement];

    for (const stmt of statements) {
      if (!stmt || typeof stmt !== 'object') continue;
      const s = stmt as { Principal?: unknown; Action?: unknown; Effect?: unknown; Condition?: unknown; Sid?: string };
      if (!principalMatches(s.Principal, userArn)) continue;
      if (matchesAny((s.Action as string | string[]) ?? '', action)) {
        if (s.Condition && !matchesCondition(s.Condition, context)) continue;

        const stmtOrigin: PolicyOrigin = {
          sourceType: 'resource',
          ...(s.Sid ? { sid: s.Sid } : {}),
        };

        if (s.Effect === 'Deny') {
          return {
            status: 'DENY',
            matchedStatement: s,
            origin: stmtOrigin,
            reason: `Explicit Deny in resource policy (Sid: ${s.Sid || 'Unnamed'})`,
          };
        }
        if (s.Effect === 'Allow') {
          hasAllow = true;
          allowedStatement = s;
          allowedOrigin = stmtOrigin;
        }
      }
    }
  } catch {
    return { status: 'IMPLICIT_DENY', reason: 'Resource policy parsing threw an exception' };
  }

  if (hasAllow) {
    return { status: 'ALLOW', matchedStatement: allowedStatement, origin: allowedOrigin };
  }
  return { status: 'IMPLICIT_DENY', reason: 'No matching Allow statement in resource policy' };
}

function principalMatches(principal: unknown, userArn: string): boolean {
  if (!principal) return false;
  if (principal === '*') return true;

  const pObj = principal as { AWS?: unknown; Service?: unknown };
  const awsPrincipal = pObj.AWS ?? pObj.Service ?? principal;
  const principals = Array.isArray(awsPrincipal) ? awsPrincipal : [awsPrincipal];

  return principals.some((p: unknown) => p === '*' || p === userArn);
}

export function getResourceField(
  redis: RedisClientType,
  resourceType: string,
  arn: string,
): Promise<string | null> {
  return redis.hGet(`aura:resource:${resourceType}`, arn);
}

/**
 * Fetch one resource's crawled data and evaluate a set of actions against an
 * assembled subject. This is the single shared step behind both the logic
 * service's stored verdicts and mcp-server's theoretical checks — keeping the
 * fetch/parse/evaluate contract in one place so the two can never diverge.
 */
export async function evaluateResourceActions(
  arn: string,
  actions: string[],
  subject: Record<string, unknown>,
  parsedData: Record<string, unknown> | null,
): Promise<Record<string, EvaluationResult>> {
  const resourceObj = parsedData && typeof parsedData === 'object' ? { arn, ...parsedData } : { arn };
  return Object.fromEntries(
    actions.map((action) => [action, evaluate(resourceObj, action, subject)])
  );
}
