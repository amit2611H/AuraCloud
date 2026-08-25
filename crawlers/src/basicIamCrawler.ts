import {
  IAMClient, ListUsersCommand, ListRolesCommand, ListGroupsCommand,
  ListGroupsForUserCommand, ListAttachedUserPoliciesCommand,
  ListAttachedGroupPoliciesCommand, ListGroupPoliciesCommand,
  ListUserPoliciesCommand, GetUserPolicyCommand, GetGroupPolicyCommand,
  type User, type Role, type Group
} from "@aws-sdk/client-iam";
import { BaseCrawler } from "./crawlerBase.js";

function parseInlinePolicyDocument(policyText: string | undefined): Record<string, unknown> | undefined {
  if (!policyText?.trim()) return undefined;
  try {
    return JSON.parse(decodeURIComponent(policyText)) as Record<string, unknown>;
  } catch {
    try {
      return JSON.parse(policyText) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
}

export class BasicIamCrawler extends BaseCrawler {
    public intervalMs = 1000;
    protected iamClient = new IAMClient({ region: this.region, credentials: this.credentials });

    private async fetchUsers(): Promise<User[]> {
        const res: User[] = [];
        let marker: string | undefined;
        do {
            const response = await this.callAndHandleThrotteling(() => this.iamClient.send(new ListUsersCommand({ Marker: marker })));
            res.push(...(response.Users || []));
            marker = response.Marker;
        } while (marker);
        return res;
    }

    private async fetchRoles(): Promise<Role[]> {
        const res: Role[] = [];
        let marker: string | undefined;
        do {
            const response = await this.callAndHandleThrotteling(() => this.iamClient.send(new ListRolesCommand({ Marker: marker })));
            res.push(...(response.Roles || []));
            marker = response.Marker;
        } while (marker);
        return res;
    }

    private async fetchGroups(): Promise<Group[]> {
        const res: Group[] = [];
        let marker: string | undefined;
        do {
            const response = await this.callAndHandleThrotteling(() => this.iamClient.send(new ListGroupsCommand({ Marker: marker })));
            res.push(...(response.Groups || []));
            marker = response.Marker;
        } while (marker);
        return res;
    }

    private async fetchUserInlinePolicies(userName: string): Promise<Record<string, unknown>[]> {
        const listed = await this.callAndHandleThrotteling(() =>
            this.iamClient.send(new ListUserPoliciesCommand({ UserName: userName })),
        );
        const policies: Record<string, unknown>[] = [];

        for (const policyName of listed.PolicyNames ?? []) {
            const response = await this.callAndHandleThrotteling(() =>
                this.iamClient.send(new GetUserPolicyCommand({ UserName: userName, PolicyName: policyName })),
            );
            const document = parseInlinePolicyDocument(response.PolicyDocument);
            if (document) policies.push(document);
        }

        return policies;
    }

    private async fetchGroupInlinePolicies(groupName: string): Promise<Record<string, unknown>[]> {
        const listed = await this.callAndHandleThrotteling(() =>
            this.iamClient.send(new ListGroupPoliciesCommand({ GroupName: groupName })),
        );
        const policies: Record<string, unknown>[] = [];

        for (const policyName of listed.PolicyNames ?? []) {
            const response = await this.callAndHandleThrotteling(() =>
                this.iamClient.send(new GetGroupPolicyCommand({ GroupName: groupName, PolicyName: policyName })),
            );
            const document = parseInlinePolicyDocument(response.PolicyDocument);
            if (document) policies.push(document);
        }

        return policies;
    }

    async crawl() {
        const [users, roles, groups] = await Promise.all([
            this.fetchUsers(), 
            this.fetchRoles(),
            this.fetchGroups()
        ]);

        // 1. Enrich Users (Who are they and what groups do they belong to?)
        const enrichedUsers = [];
        for (const user of users) {
            const [g, p, inlinePolicies] = await Promise.all([
                this.callAndHandleThrotteling(() =>
                    this.iamClient.send(new ListGroupsForUserCommand({ UserName: user.UserName })),
                ),
                this.callAndHandleThrotteling(() =>
                    this.iamClient.send(new ListAttachedUserPoliciesCommand({ UserName: user.UserName })),
                ),
                this.fetchUserInlinePolicies(user.UserName!),
            ]);
            const groupNames = g.Groups
                ?.map((x) => x.GroupName)
                .filter((name): name is string => typeof name === 'string');
            enrichedUsers.push({
                ...user,
                ...(groupNames?.length ? { Groups: groupNames } : {}),
                ...(p.AttachedPolicies?.length ? { AttachedPolicies: p.AttachedPolicies } : {}),
                ...(inlinePolicies.length ? { InlinePolicies: inlinePolicies } : {}),
            });
        }

        // 2. Enrich Groups (What permissions does each group actually have?)
        const enrichedGroups = [];
        for (const group of groups) {
            const [attached, inlinePolicies] = await Promise.all([
                this.callAndHandleThrotteling(() =>
                    this.iamClient.send(new ListAttachedGroupPoliciesCommand({ GroupName: group.GroupName })),
                ),
                this.fetchGroupInlinePolicies(group.GroupName!),
            ]);
            enrichedGroups.push({
                ...group,
                ...(attached.AttachedPolicies?.length ? { AttachedPolicies: attached.AttachedPolicies } : {}),
                ...(inlinePolicies.length ? { InlinePolicies: inlinePolicies } : {}),
            });
        }

        return { users: enrichedUsers, roles, groups: enrichedGroups };
    }

    async save(redis: any, data: any) {
        const updatedAt = new Date().toISOString();
        for (const user of data.users) await redis.hSet("aura:iam:users", user.UserId, JSON.stringify({ ...user, updated_at: updatedAt }));
        for (const role of data.roles) await redis.hSet("aura:iam:roles", role.RoleName, JSON.stringify({ ...role, updated_at: updatedAt }));
        for (const group of data.groups) await redis.hSet("aura:iam:groups", group.GroupName, JSON.stringify({ ...group, updated_at: updatedAt }));
    }
}