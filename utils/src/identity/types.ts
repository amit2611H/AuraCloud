export type IdentitySource = 'sso' | 'iam';

export type PolicySourceType = 'identity' | 'group' | 'role' | 'resource' | 'scp';

export interface PolicyOrigin {
  sourceType: PolicySourceType;
  policyName?: string | undefined;
  policyArn?: string | undefined;
  sid?: string | undefined;
  groupName?: string | undefined;
  permissionSetName?: string | undefined;
  roleName?: string | undefined;
}

export interface PolicyRefEntry {
  document?: Record<string, unknown> | undefined;
  policyArn?: string | undefined;
  origin: PolicyOrigin;
}

export interface PolicyRefs {
  inlineDocuments: Record<string, unknown>[];
  attachedArns: string[];
  entries?: PolicyRefEntry[] | undefined;
}

export interface ResolvedIdentity {
  source: IdentitySource;
  raw: Record<string, unknown>;
  policies: unknown[];
  accessibleAwsAccountIds: string[];
  accountId: string;
  arn: string;
  awsUserId?: string;
}

