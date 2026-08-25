import {
  DescribePermissionSetCommand,
  GetInlinePolicyForPermissionSetCommand,
  ListCustomerManagedPolicyReferencesInPermissionSetCommand,
  ListInstancesCommand,
  ListManagedPoliciesInPermissionSetCommand,
  ListPermissionSetsCommand,
  SSOAdminClient,
  type AttachedManagedPolicy,
  type CustomerManagedPolicyReference,
} from '@aws-sdk/client-sso-admin';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { BaseCrawler } from './crawlerBase.js';

function parseInlinePolicy(policyText: string | undefined): Record<string, unknown> | undefined {
  if (!policyText?.trim()) return undefined;
  try {
    return JSON.parse(policyText) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function customerManagedPolicyArn(accountId: string, ref: CustomerManagedPolicyReference): string {
  const rawPath = ref.Path ?? "/";
  const segments = rawPath.split("/").filter(Boolean);
  const pathPrefix = segments.length ? `${segments.join("/")}/` : "";
  return `arn:aws:iam::${accountId}:policy/${pathPrefix}${ref.Name}`;
}

export class PermissionSetsCrawler extends BaseCrawler {
  protected region = "eu-central-1";
  public intervalMs = 5000;
  protected ssoAdmin = new SSOAdminClient({ region: this.region, credentials: this.credentials });
  protected sts = new STSClient({ region: this.region, credentials: this.credentials });

  private async listAllManagedAttachments(
    instanceArn: string,
    permissionSetArn: string,
  ): Promise<AttachedManagedPolicy[]> {
    const out: AttachedManagedPolicy[] = [];
    let nextToken: string | undefined;
    do {
      const res = await this.callAndHandleThrotteling(() =>
        this.ssoAdmin.send(
          new ListManagedPoliciesInPermissionSetCommand({
            InstanceArn: instanceArn,
            PermissionSetArn: permissionSetArn,
            NextToken: nextToken,
          }),
        ),
      );
      out.push(...(res.AttachedManagedPolicies ?? []));
      nextToken = res.NextToken;
    } while (nextToken);
    return out;
  }

  private async listAllCustomerManagedRefs(
    instanceArn: string,
    permissionSetArn: string,
  ): Promise<CustomerManagedPolicyReference[]> {
    const out: CustomerManagedPolicyReference[] = [];
    let nextToken: string | undefined;
    do {
      const res = await this.callAndHandleThrotteling(() =>
        this.ssoAdmin.send(
          new ListCustomerManagedPolicyReferencesInPermissionSetCommand({
            InstanceArn: instanceArn,
            PermissionSetArn: permissionSetArn,
            NextToken: nextToken,
          }),
        ),
      );
      out.push(...(res.CustomerManagedPolicyReferences ?? []));
      nextToken = res.NextToken;
    } while (nextToken);
    return out;
  }

  async crawlPermissionSet(instanceArn: string, permissionSetArn: string, accountId: string): Promise<any> {

    const [described, rawInline] = await Promise.all([
      this.callAndHandleThrotteling(() =>
        this.ssoAdmin.send(
          new DescribePermissionSetCommand({ InstanceArn: instanceArn, PermissionSetArn: permissionSetArn }),
        ),
      ).then((r) => r.PermissionSet),
      this.callAndHandleThrotteling(() =>
        this.ssoAdmin.send(
          new GetInlinePolicyForPermissionSetCommand({ InstanceArn: instanceArn,PermissionSetArn: permissionSetArn }),
        ),
      ).then((r) => r.InlinePolicy),
    ]);

    const [managedAttachments, customerRefs] = await Promise.all([
      this.listAllManagedAttachments(instanceArn, permissionSetArn),
      this.listAllCustomerManagedRefs(instanceArn, permissionSetArn),
    ]);

    const inlinePolicyDocument = parseInlinePolicy(rawInline);
    const attachedPolicyArns: string[] = [];
    const seenArn = new Set<string>();

    for (const managedPolicy of managedAttachments) {
      const arn = managedPolicy.Arn;
      if (!arn || seenArn.has(arn)) continue;
      seenArn.add(arn);
      attachedPolicyArns.push(arn);
    }

    if (accountId) {
      for (const ref of customerRefs) {
        if (!ref.Name) continue;
        const arn = customerManagedPolicyArn(accountId, ref);
        if (seenArn.has(arn)) continue;
        seenArn.add(arn);
        attachedPolicyArns.push(arn);
      }
    }

    return {
      ...(described ?? {}),
      inlinePolicyDocument,
      attachedPolicyArns,
      awsManagedAttachments: managedAttachments.map((m) => ({ Name: m.Name, Arn: m.Arn })),
      customerManagedReferences: customerRefs,
    };
  }

  async crawl() {
    const { Account } = await this.callAndHandleThrotteling(() =>
      this.sts.send(new GetCallerIdentityCommand({})),
    );

    const { Instances } = await this.callAndHandleThrotteling(() =>
      this.ssoAdmin.send(new ListInstancesCommand({})),
    );

    const enriched: unknown[] = [];

    for (const instance of Instances ?? []) {
      const instanceArn = instance.InstanceArn;
      if (!instanceArn) continue;

      let nextToken: string | undefined;
      do {
        const response = await this.callAndHandleThrotteling(() =>
          this.ssoAdmin.send(
            new ListPermissionSetsCommand({ InstanceArn: instanceArn, NextToken: nextToken }),
          ),
        );
        const arns = response.PermissionSets ?? [];
        for (const psArn of arns) {
          enriched.push(await this.crawlPermissionSet(instanceArn, psArn, Account ?? ''));
        }
        nextToken = response.NextToken;
      } while (nextToken);
    }

    return enriched;
  }

  async save(redis: any, data: any[]) {
    const updatedAt = new Date().toISOString();
    for (const ps of data) {
      const arn = ps?.PermissionSetArn;
      if (!arn) continue;
      await redis.hSet("aura:sso:permission-sets", arn, JSON.stringify({ ...ps, updated_at: updatedAt }));
    }
  }
}