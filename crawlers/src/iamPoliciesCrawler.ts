import {
  GetPolicyCommand,
  GetPolicyVersionCommand,
  IAMClient,
  ListPoliciesCommand,
  type Policy,
} from '@aws-sdk/client-iam';
import { BaseCrawler } from './crawlerBase.js';


export type StoredIamPolicy = {
  PolicyArn: string;
  PolicyName?: string | undefined;
  Document: Record<string, unknown>;
  lastSyncedAt: string;
  updated_at?: string;
};

type PendingPolicy = { arn: string; name?: string | undefined };

async function fetchPolicyDocument(
  iam: IAMClient,
  policyArn: string,
  call: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<Record<string, unknown> | undefined> {
  if (policyArn === 'arn:aws:iam::aws:policy/AdministratorAccess') {
    return {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }],
    };
  }

  try {
    const pol = await call(() => iam.send(new GetPolicyCommand({ PolicyArn: policyArn })));
    const versionId = pol.Policy?.DefaultVersionId;
    if (!versionId) return undefined;

    const ver = await call(() =>
      iam.send(new GetPolicyVersionCommand({ PolicyArn: policyArn, VersionId: versionId })),
    );

    const doc = ver.PolicyVersion?.Document;
    if (typeof doc === 'string') {
      return JSON.parse(decodeURIComponent(doc)) as Record<string, unknown>;
    }
    return doc as Record<string, unknown> | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Skipping policy ${policyArn}: ${message}`);
    return undefined;
  }
}

export class IAMPoliciesCrawler extends BaseCrawler {
  public intervalMs = 5000;
  protected iamClient = new IAMClient({ region: this.region, credentials: this.credentials });

  private async listPolicies(scope: 'Local' | 'AWS', onlyAttached: boolean): Promise<Policy[]> {
    const policies: Policy[] = [];
    let marker: string | undefined;

    do {
      const response = await this.callAndHandleThrotteling(() =>
        this.iamClient.send(
          new ListPoliciesCommand({
            Scope: scope,
            OnlyAttached: onlyAttached,
            Marker: marker,
          }),
        ),
      );
      policies.push(...(response.Policies ?? []));
      marker = response.Marker;
    } while (marker);

    return policies;
  }

  private async enrichPolicy(pending: PendingPolicy): Promise<StoredIamPolicy | null> {
    const document = await fetchPolicyDocument(
      this.iamClient,
      pending.arn,
      (fn) => this.callAndHandleThrotteling(fn),
    );
    if (!document) return null;

    return {
      PolicyArn: pending.arn,
      ...(pending.name ? { PolicyName: pending.name } : {}),
      Document: document,
      lastSyncedAt: new Date().toISOString(),
    };
  }

  async crawl(): Promise<StoredIamPolicy[]> {
    // ListPolicies Scope applies to the whole request — AWS has no "all Local + attached AWS only" mode.
    // Local + OnlyAttached:false  → full customer-managed catalog (shared in aura:iam:policies).
    // AWS  + OnlyAttached:true    → in-use AWS managed only (e.g. AmazonS3FullAccess), not every AWS policy.
    // Omitting Scope (All) would either list thousands of unused AWS managed policies (OnlyAttached:false)
    // or drop unattached customer-managed policies (OnlyAttached:true).
    // Known limitation (Single-account assumption): Scope: 'AWS', OnlyAttached: true only returns
    // AWS-managed policies attached to an IAM entity in the credential account. In multi-account AWS orgs,
    // permission-set managed policies provisioned onto AWSReservedSSO_* roles in member accounts will not be listed here.
    const listed = [
      ...(await this.listPolicies('Local', false)),
      ...(await this.listPolicies('AWS', true)),
    ];
    const seenArns = new Set<string>();
    const policies: StoredIamPolicy[] = [];

    for (const policy of listed) {
      if (!policy.Arn || seenArns.has(policy.Arn)) continue;
      seenArns.add(policy.Arn);
      const stored = await this.enrichPolicy({
        arn: policy.Arn,
        ...(policy.PolicyName ? { name: policy.PolicyName } : {}),
      });
      if (stored) policies.push(stored);
    }

    return policies;
  }

  async save(redis: any, data: StoredIamPolicy[]) {
    const updatedAt = new Date().toISOString();
    for (const policy of data) {
      await redis.hSet('aura:iam:policies', policy.PolicyArn, JSON.stringify({ ...policy, updated_at: updatedAt }));
    }
  }
}
