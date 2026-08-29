import type { RedisClientType } from 'redis';
import { getPolicyDocuments, getPolicyDocument } from '../policyCache.js';
import type { PolicyOrigin, PolicyRefEntry, PolicyRefs } from './types.js';

function emptyPolicyRefs(): PolicyRefs {
  return { inlineDocuments: [], attachedArns: [], entries: [] };
}

export function policyRefsFromPermissionSets(
  resolved: Record<string, unknown>[],
  groups?: Record<string, unknown>[] | null,
): PolicyRefs {
  const refs = emptyPolicyRefs();
  const groupMap = new Map<string, string>();

  if (Array.isArray(groups)) {
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue;
      const groupName = (group.DisplayName || group.GroupName || group.GroupId || 'SSOGroup') as string;
      const assignments = group.PermissionSets;
      if (Array.isArray(assignments)) {
        for (const assignment of assignments) {
          if (assignment && typeof assignment === 'object') {
            const arn = (assignment as { PermissionSetArn?: unknown }).PermissionSetArn;
            if (typeof arn === 'string' && arn) {
              groupMap.set(arn, groupName);
            }
          }
        }
      }
    }
  }

  for (const permissionSet of resolved) {
    if (!permissionSet || typeof permissionSet !== 'object') continue;
    const psArn = (permissionSet.PermissionSetArn || permissionSet.Arn) as string | undefined;
    const psName = (permissionSet.Name || psArn?.split('/').pop() || 'PermissionSet') as string;
    const matchedGroupName = psArn ? groupMap.get(psArn) : undefined;

    const baseOrigin: PolicyOrigin = matchedGroupName
      ? { sourceType: 'group', groupName: matchedGroupName, permissionSetName: psName }
      : { sourceType: 'role', permissionSetName: psName };

    const inline = permissionSet.inlinePolicyDocument;
    if (inline && typeof inline === 'object') {
      const doc = inline as Record<string, unknown>;
      refs.inlineDocuments.push(doc);
      refs.entries!.push({
        document: doc,
        origin: { ...baseOrigin, policyName: 'InlinePolicy' },
      });
    }

    for (const arn of (permissionSet.attachedPolicyArns as unknown[]) ?? []) {
      if (typeof arn === 'string' && arn) {
        refs.attachedArns.push(arn);
        refs.entries!.push({
          policyArn: arn,
          origin: { ...baseOrigin, policyArn: arn, policyName: arn.split('/').pop() },
        });
      }
    }
  }

  return refs;
}

export function policyRefsFromIamEntities(
  userData: Record<string, unknown>,
  groups: Record<string, unknown>[],
): PolicyRefs {
  const refs = emptyPolicyRefs();

  for (const doc of (userData.InlinePolicies as unknown[]) ?? []) {
    if (doc && typeof doc === 'object') {
      const d = doc as Record<string, unknown>;
      const policyName = (d.PolicyName || d.Name || 'InlinePolicy') as string;
      refs.inlineDocuments.push(d);
      refs.entries!.push({
        document: d,
        origin: { sourceType: 'identity', policyName },
      });
    }
  }

  for (const pol of (userData.AttachedPolicies as Array<{ PolicyArn?: string; PolicyName?: string }>) ?? []) {
    if (typeof pol.PolicyArn === 'string' && pol.PolicyArn) {
      const policyName = pol.PolicyName || pol.PolicyArn.split('/').pop() || 'AttachedPolicy';
      refs.attachedArns.push(pol.PolicyArn);
      refs.entries!.push({
        policyArn: pol.PolicyArn,
        origin: { sourceType: 'identity', policyArn: pol.PolicyArn, policyName },
      });
    }
  }

  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;
    const groupName = (group.GroupName || group.Name || group.GroupId || 'Group') as string;

    for (const doc of (group.InlinePolicies as unknown[]) ?? []) {
      if (doc && typeof doc === 'object') {
        const d = doc as Record<string, unknown>;
        const policyName = (d.PolicyName || d.Name || 'InlinePolicy') as string;
        refs.inlineDocuments.push(d);
        refs.entries!.push({
          document: d,
          origin: { sourceType: 'group', groupName, policyName },
        });
      }
    }

    for (const pol of (group.AttachedPolicies as Array<{ PolicyArn?: string; PolicyName?: string }>) ?? []) {
      if (typeof pol.PolicyArn === 'string' && pol.PolicyArn) {
        const policyName = pol.PolicyName || pol.PolicyArn.split('/').pop() || 'AttachedPolicy';
        refs.attachedArns.push(pol.PolicyArn);
        refs.entries!.push({
          policyArn: pol.PolicyArn,
          origin: { sourceType: 'group', groupName, policyArn: pol.PolicyArn, policyName },
        });
      }
    }
  }

  return refs;
}

export async function resolvePolicies(redis: RedisClientType, refs: PolicyRefs): Promise<unknown[]> {
  if (refs.entries && refs.entries.length > 0) {
    const resolved: unknown[] = [];
    for (const entry of refs.entries) {
      if (entry.document) {
        resolved.push({
          ...entry.document,
          PolicyName: entry.origin.policyName ?? (entry.document as { PolicyName?: string }).PolicyName,
          origin: entry.origin,
        });
      } else if (entry.policyArn) {
        const doc = await getPolicyDocument(redis, entry.policyArn);
        if (doc) {
          resolved.push({
            ...doc,
            PolicyName: entry.origin.policyName ?? entry.policyArn.split('/').pop(),
            origin: entry.origin,
          });
        }
      }
    }
    return resolved;
  }

  return [...refs.inlineDocuments, ...(await getPolicyDocuments(redis, refs.attachedArns))];
}

