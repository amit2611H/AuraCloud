import { GetBucketAclCommand, GetBucketCorsCommand, GetBucketLocationCommand, GetBucketPolicyCommand, ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { BaseCrawler } from "./crawlerBase.js";
import { AwsResourceModel, ResourceActionModel } from "utils";
import { extractActionsFromPolicyDocument } from "./utils.js";
import extend from "extend";
import { ConfigServiceClient, GetResourceConfigHistoryCommand } from "@aws-sdk/client-config-service";

const GLOBAL_S3_REGION = "us-east-1";

export class S3Crawler extends BaseCrawler {
    protected s3Client = new S3Client({ region: this.region, credentials: this.credentials });
    public intervalMs = 1000;
    private regionalClientsCache = new Map<string, S3Client>();

    private getRegionalClient(region: string): S3Client {
        if (region === this.region) {
            return this.s3Client;
        }
        let client = this.regionalClientsCache.get(region);
        if (!client) {
            client = new S3Client({ region, credentials: this.credentials });
            this.regionalClientsCache.set(region, client);
        }
        return client;
    }

    private async getPermissionsFromAwsConfigFallback(bucketName: string, region: string): Promise<string | undefined> {
        try {
            const configClient = new ConfigServiceClient({ region, credentials: this.credentials });
            const configRes = await this.callAndHandleThrotteling(() =>
                configClient.send(new GetResourceConfigHistoryCommand({
                    resourceType: "AWS::S3::Bucket", resourceId: bucketName, limit: 1
                }))
            );
            const latestItem = configRes.configurationItems?.[0];
            if (latestItem) {
                const supplementaryConfig = latestItem.supplementaryConfiguration || {};
                const bucketPolicy = supplementaryConfig.BucketPolicy;
                if (bucketPolicy) {
                    console.log(`[S3 CRAWLER] Successfully retrieved policy for ${bucketName} from AWS Config history fallback!`);
                    return bucketPolicy;
                } else {
                    console.log(`[S3 CRAWLER] AWS Config fallback succeeded but found no policy for ${bucketName}`);
                }
            } else {
                console.log(`[S3 CRAWLER] AWS Config history returned no configuration items for ${bucketName}`);
            }
        } catch (configErr: any) {
            console.error(`[S3 CRAWLER] AWS Config fallback failed for ${bucketName}:`, configErr.message || configErr);
        }
    }

    async getBucketPolicies(regionalClient: S3Client, bucketName: string, region: string): Promise<string | null | undefined> {
        try {
            return await this.callAwsAndExtract(() =>
                regionalClient.send(new GetBucketPolicyCommand({ Bucket: bucketName })), "Policy"
            );
        } catch (err: any) {
            const errMsg = err.message || '';
            const isAccessDenied = err.name === "AccessDenied" || errMsg.includes("Access Denied") || errMsg.includes("not authorized");
            
            if (isAccessDenied) {
                return await this.getPermissionsFromAwsConfigFallback(bucketName, region) || null;
            } else if (err.name === "NoSuchBucketPolicy" || errMsg.includes("The bucket policy does not exist")) {
                return null;
            } else {
                console.error(`[S3 CRAWLER] GetBucketPolicy error for ${bucketName} in region ${region}:`, errMsg);
                return null;
            }
        }
    }

    private async enrichBucket(bucket: any) {
        const locationClient = this.getRegionalClient(GLOBAL_S3_REGION);
        const bucketLocation = await this.callAwsAndExtract(
            () => locationClient.send(new GetBucketLocationCommand({ Bucket: bucket.Name! })), "LocationConstraint"
        ).catch((err) => {
            console.error(`[S3 CRAWLER] GetBucketLocation error for ${bucket.Name}:`, err.message || err);
            return null;
        });

        const region = bucketLocation || GLOBAL_S3_REGION;
        const regionalClient = this.getRegionalClient(region);

        const [
            bucketPolicies,
            bucketAcl,
            bucketCors
        ] = await Promise.all([
            this.getBucketPolicies(regionalClient, bucket.Name!, region),
            this.callAwsAndExtract(() => regionalClient.send(new GetBucketAclCommand({ Bucket: bucket.Name! })), "Grants").catch((err) => {
                console.error(`[S3 CRAWLER] GetBucketAcl error for ${bucket.Name}:`, err.message || err);
                return null;
            }),
            this.callAwsAndExtract(() => regionalClient.send(new GetBucketCorsCommand({ Bucket: bucket.Name! })), "CORSRules").catch((err) => {
                if (err.name !== "NoSuchCORSConfiguration" && !(err.message || "").includes("The CORS configuration does not exist")) {
                    console.error(`[S3 CRAWLER] GetBucketCors error for ${bucket.Name}:`, err.message || err);
                }
                return null;
            })
        ]);

        extend(bucket, { bucketPolicies, bucketLocation: region, bucketAcl, bucketCors });
    }

    async crawl() {
        const bucketsResponse = await this.callAndHandleThrotteling(() => this.s3Client.send(new ListBucketsCommand({})));
        const buckets = bucketsResponse.Buckets || [];
        const { Account } = await this.callAndHandleThrotteling(() =>
          this.stsClient.send(new GetCallerIdentityCommand({}))
        );
        for (const bucket of buckets) {
            await this.enrichBucket(bucket);
            extend(bucket, { accountId: Account ?? undefined });
        }
        return buckets
    }
    
    async save(redis: any, data: any) {
        const updatedAt = new Date().toISOString();
        for (const bucket of data) {
            const key = bucket.BucketArn || bucket.arn || `arn:aws:s3:::${bucket.Name}`;
            await redis.hSet("aura:resource:s3buckets", key, JSON.stringify({ ...bucket, updated_at: updatedAt }));
        }
    }
}