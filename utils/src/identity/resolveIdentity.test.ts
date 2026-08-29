import { describe, expect, test, beforeEach } from "vitest";
import {
  buildEvaluationSubject,
  clearPolicyCache,
  resolveIdentity,
  toEvalUser,
  type RedisClientType,
} from "utils";

function mockRedis(hashes: Record<string, Record<string, string>>): RedisClientType {
  return {
    hGet: async (hash: string, field: string) => hashes[hash]?.[field] ?? null,
    hGetAll: async (hash: string) => hashes[hash] ?? {},
  } as unknown as RedisClientType;
}

describe("buildEvaluationSubject", () => {
  beforeEach(() => {
    clearPolicyCache();
  });

  test("SSO subject resolves attachedPolicyArns from the catalog", async () => {
    const redis = mockRedis({
      "aura:sso:users": {
        "sso-1": JSON.stringify({
          UserName: "ada",
          PermissionSets: [{ PermissionSetArn: "ps-1", AccountId: "111" }],
        }),
      },
      "aura:sso:permission-sets": {
        "ps-1": JSON.stringify({
          Name: "Dev",
          inlinePolicyDocument: {
            Statement: [{ Effect: "Allow", Action: "s3:GetObject" }],
          },
          attachedPolicyArns: ["arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess"],
        }),
      },
      "aura:iam:policies": {
        "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess": JSON.stringify({
          Document: { Statement: [{ Effect: "Allow", Action: "s3:Get*" }] },
        }),
      },
      "aura:iam:roles": {},
    });

    const subject = await buildEvaluationSubject(redis, "sso-1", [
      "arn:aws:ec2:us-east-1:999:instance/i-x",
    ]);
    expect(subject?.identityType).toBe("SSO");
    expect(subject?.accountId).toBe("111");
    expect(subject?.policies).toEqual([
      {
        PolicyName: "InlinePolicy",
        Statement: [{ Effect: "Allow", Action: "s3:GetObject" }],
        origin: {
          sourceType: "role",
          permissionSetName: "Dev",
          policyName: "InlinePolicy",
        },
      },
      {
        PolicyName: "AmazonS3ReadOnlyAccess",
        Statement: [{ Effect: "Allow", Action: "s3:Get*" }],
        origin: {
          sourceType: "role",
          permissionSetName: "Dev",
          policyArn: "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
          policyName: "AmazonS3ReadOnlyAccess",
        },
      },
    ]);
  });

  test("falls back to IAM and resolves attached policies from the catalog", async () => {
    const redis = mockRedis({
      "aura:sso:users": {},
      "aura:iam:users": {
        AIDAIAM1: JSON.stringify({
          UserName: "bob",
          UserId: "AIDAIAM1",
          Arn: "arn:aws:iam::222:user/bob",
          Groups: ["Developers"],
          AttachedPolicies: [{ PolicyArn: "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess" }],
          InlinePolicies: [{ Statement: [{ Effect: "Allow", Action: "s3:ListBucket" }] }],
        }),
      },
      "aura:iam:groups": {
        Developers: JSON.stringify({
          GroupName: "Developers",
          AttachedPolicies: [{ PolicyArn: "arn:aws:iam::222:policy/TeamPolicy" }],
        }),
      },
      "aura:iam:policies": {
        "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess": JSON.stringify({
          Document: { Statement: [{ Effect: "Allow", Action: "s3:Get*" }] },
        }),
        "arn:aws:iam::222:policy/TeamPolicy": JSON.stringify({
          Document: { Statement: [{ Effect: "Allow", Action: "ec2:Describe*" }] },
        }),
      },
    });

    const subject = await buildEvaluationSubject(redis, "AIDAIAM1", []);
    expect(subject?.identityType).toBe("IAM");
    expect(subject?.awsUserId).toBe("AIDAIAM1");
    expect(subject?.policies).toEqual([
      {
        PolicyName: "InlinePolicy",
        Statement: [{ Effect: "Allow", Action: "s3:ListBucket" }],
        origin: {
          sourceType: "identity",
          policyName: "InlinePolicy",
        },
      },
      {
        PolicyName: "AmazonS3ReadOnlyAccess",
        Statement: [{ Effect: "Allow", Action: "s3:Get*" }],
        origin: {
          sourceType: "identity",
          policyArn: "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
          policyName: "AmazonS3ReadOnlyAccess",
        },
      },
      {
        PolicyName: "TeamPolicy",
        Statement: [{ Effect: "Allow", Action: "ec2:Describe*" }],
        origin: {
          sourceType: "group",
          groupName: "Developers",
          policyArn: "arn:aws:iam::222:policy/TeamPolicy",
          policyName: "TeamPolicy",
        },
      },
    ]);
  });

  test("returns null when neither SSO nor IAM has crawled the user", async () => {
    const redis = mockRedis({
      "aura:sso:users": {},
      "aura:iam:users": {},
    });
    expect(await buildEvaluationSubject(redis, "missing", [])).toBeNull();
  });
});

describe("resolveIdentity", () => {
  beforeEach(() => {
    clearPolicyCache();
  });

  test("normalizes IAM into ResolvedIdentity, then toEvalUser flattens it", async () => {
    const redis = mockRedis({
      "aura:sso:users": {},
      "aura:iam:users": {
        AIDAIAM1: JSON.stringify({
          UserName: "bob",
          UserId: "AIDAIAM1",
          Arn: "arn:aws:iam::222:user/bob",
        }),
      },
      "aura:iam:groups": {},
      "aura:iam:policies": {},
    });

    const identity = await resolveIdentity(redis, "AIDAIAM1", []);
    expect(identity).not.toBeNull();
    if (!identity) return;

    expect(identity.source).toBe("iam");
    const evalUser = toEvalUser(identity);
    expect(evalUser.identityType).toBe("IAM");
    expect(evalUser.arn).toBe(identity.arn);
  });
});
