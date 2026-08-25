import { describe, expect, test } from "vitest";
import { BasicIamCrawler } from "./basicIamCrawler.js";
import { EC2Crawler } from "./ec2Crawler.js";
import { IAMPoliciesCrawler } from "./iamPoliciesCrawler.js";
import { PermissionSetsCrawler } from "./permissionSetsCrawler.js";
import { S3Crawler } from "./s3Crawler.js";
import { SsoCrawler } from "./ssoCrawler.js";

function createMockRedis() {
  const stored: Record<string, Record<string, string>> = {};
  return {
    stored,
    client: {
      hSet: async (key: string, field: string, value: string) => {
        stored[key] ??= {};
        stored[key][field] = value;
      },
    },
  };
}

const mockCreds = { accessKeyId: "mock-key", secretAccessKey: "mock-secret" };

describe("crawlers save with updated_at", () => {
  test("BasicIamCrawler saves users, roles, and groups with updated_at", async () => {
    const crawler = new BasicIamCrawler(mockCreds);
    const { stored, client } = createMockRedis();

    await crawler.save(client, {
      users: [{ UserId: "AIDA123", UserName: "alice" }],
      roles: [{ RoleName: "AppRole", RoleId: "AROA123" }],
      groups: [{ GroupName: "Devs", GroupId: "AGPA123" }],
    });

    const userRaw = stored["aura:iam:users"]?.["AIDA123"];
    expect(userRaw).toBeDefined();
    const user = JSON.parse(userRaw!);
    expect(user.updated_at).toBeDefined();
    expect(new Date(user.updated_at).toString()).not.toBe("Invalid Date");

    const roleRaw = stored["aura:iam:roles"]?.["AppRole"];
    expect(roleRaw).toBeDefined();
    const role = JSON.parse(roleRaw!);
    expect(role.updated_at).toBeDefined();

    const groupRaw = stored["aura:iam:groups"]?.["Devs"];
    expect(groupRaw).toBeDefined();
    const group = JSON.parse(groupRaw!);
    expect(group.updated_at).toBeDefined();
  });

  test("EC2Crawler saves instances with updated_at", async () => {
    const crawler = new EC2Crawler(mockCreds);
    const { stored, client } = createMockRedis();

    const arn = "arn:aws:ec2:eu-central-1:123456789012:instance/i-12345678";
    await crawler.save(client, [
      {
        arn,
        InstanceId: "i-12345678",
        accountId: "123456789012",
        region: "eu-central-1",
        hasIamProfile: true,
        isSsmManaged: false,
      },
    ]);

    const instanceRaw = stored["aura:resource:ec2instances"]?.[arn];
    expect(instanceRaw).toBeDefined();
    const instance = JSON.parse(instanceRaw!);
    expect(instance.updated_at).toBeDefined();
    expect(new Date(instance.updated_at).toString()).not.toBe("Invalid Date");
  });

  test("IAMPoliciesCrawler saves policies with updated_at", async () => {
    const crawler = new IAMPoliciesCrawler(mockCreds);
    const { stored, client } = createMockRedis();

    const arn = "arn:aws:iam::123456789012:policy/CustomPolicy";
    await crawler.save(client, [
      {
        PolicyArn: arn,
        PolicyName: "CustomPolicy",
        Document: { Version: "2012-10-17", Statement: [] },
        lastSyncedAt: new Date().toISOString(),
      },
    ]);

    const policyRaw = stored["aura:iam:policies"]?.[arn];
    expect(policyRaw).toBeDefined();
    const policy = JSON.parse(policyRaw!);
    expect(policy.updated_at).toBeDefined();
    expect(new Date(policy.updated_at).toString()).not.toBe("Invalid Date");
  });

  test("PermissionSetsCrawler saves permission sets with updated_at", async () => {
    const crawler = new PermissionSetsCrawler(mockCreds);
    const { stored, client } = createMockRedis();

    const arn = "arn:aws:sso:::permissionSet/ssoins-123/ps-456";
    await crawler.save(client, [
      {
        PermissionSetArn: arn,
        Name: "AdminPS",
      },
    ]);

    const psRaw = stored["aura:sso:permission-sets"]?.[arn];
    expect(psRaw).toBeDefined();
    const ps = JSON.parse(psRaw!);
    expect(ps.updated_at).toBeDefined();
    expect(new Date(ps.updated_at).toString()).not.toBe("Invalid Date");
  });

  test("S3Crawler saves buckets with updated_at", async () => {
    const crawler = new S3Crawler(mockCreds);
    const { stored, client } = createMockRedis();

    const arn = "arn:aws:s3:::my-test-bucket";
    await crawler.save(client, [
      {
        BucketArn: arn,
        Name: "my-test-bucket",
      },
    ]);

    const bucketRaw = stored["aura:resource:s3buckets"]?.[arn];
    expect(bucketRaw).toBeDefined();
    const bucket = JSON.parse(bucketRaw!);
    expect(bucket.updated_at).toBeDefined();
    expect(new Date(bucket.updated_at).toString()).not.toBe("Invalid Date");
  });

  test("SsoCrawler saves users and groups with updated_at", async () => {
    const crawler = new SsoCrawler(mockCreds);
    const { stored, client } = createMockRedis();

    await crawler.save(client, {
      users: [{ UserId: "sso-user-1", UserName: "bob" }],
      groups: [{ GroupId: "sso-group-1", DisplayName: "Engineering" }],
    });

    const userRaw = stored["aura:sso:users"]?.["sso-user-1"];
    expect(userRaw).toBeDefined();
    const user = JSON.parse(userRaw!);
    expect(user.updated_at).toBeDefined();
    expect(new Date(user.updated_at).toString()).not.toBe("Invalid Date");

    const groupRaw = stored["aura:sso:groups"]?.["sso-group-1"];
    expect(groupRaw).toBeDefined();
    const group = JSON.parse(groupRaw!);
    expect(group.updated_at).toBeDefined();
    expect(new Date(group.updated_at).toString()).not.toBe("Invalid Date");
  });
});
