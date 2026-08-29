export interface AwsResource {
  _id: string;
  arn: string;
  resourceType: string;
  name: string;
  accountId?: string;
  region?: string;
  lastSyncedAt: string;
}

export interface ResourceAction {
  _id: string;
  resourceArn: string;
  actionName: string;
  policySource?: string;
  policyArn?: string;
  lastSeenAt: string;
}

export interface ResourceWatchlistItem {
  _id: string;
  name: string;
  userId: string;
  resources: Array<{
    arn: string;
    actions: string[];
    _id: string;
    /** From the discovered resource catalogue; absent once a resource leaves AWS. */
    name?: string;
  }>;
}

/** What the Brain writes per action. Everything else is resolved server-side. */
export type PermissionStatus = 'valid' | 'error';

export type ResourceStatus = 'healthy' | 'blocked' | 'stale' | 'unscanned';

export type PolicySourceType = 'identity' | 'group' | 'role' | 'resource' | 'scp';

export interface PolicyOrigin {
  sourceType: PolicySourceType;
  policyName?: string;
  policyArn?: string;
  sid?: string;
  groupName?: string;
  permissionSetName?: string;
  roleName?: string;
}

export interface ActionData {
  status: PermissionStatus;
  reason: string | null;
  origin?: PolicyOrigin | null;
  timestamp: string;
  evaluatedAt?: string | null;
}

export type ArnPermissionData = ActionData | Record<string, ActionData>;

export interface UserPermission {
  _id: string;
  name: string;
  userId: string;
  permissionsData: Record<string, ArnPermissionData>;
  /** Resolved by api-server, keyed by watched ARN. */
  resourceStatuses: Record<string, ResourceStatus>;
}
