import { BaseCrawler } from "./crawlerBase.js";
import extend from "extend";
import { DescribeInstancesCommand, EC2Client, type Instance } from "@aws-sdk/client-ec2";
import { SSMClient, DescribeInstanceInformationCommand, type InstanceInformation } from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
interface EnrichedInstance extends Instance {
        accountId: string;
        region: string;
        hasIamProfile: boolean;
        iamInstanceProfileArn?: string;
        isSsmManaged: boolean;
        ssmPingStatus?: string;
        arn: string;
    }
export class EC2Crawler extends BaseCrawler {
    

    private ec2ClientsCache = new Map<string, EC2Client>();
    private ssmClientsCache = new Map<string, SSMClient>();

    private getRegionalEc2Client(region: string): EC2Client {
        let client = this.ec2ClientsCache.get(region);
        if (!client) {
            client = new EC2Client({ region, credentials: this.credentials });
            this.ec2ClientsCache.set(region, client);
        }
        return client;
    }

    private getRegionalSsmClient(region: string): SSMClient {
        let client = this.ssmClientsCache.get(region);
        if (!client) {
            client = new SSMClient({ region, credentials: this.credentials });
            this.ssmClientsCache.set(region, client);
        }
        return client;
    }

    private async getSsmStatus(ssmClient: SSMClient, instanceId: string): Promise<InstanceInformation | null> {
        try {
            const ssmInfo = await this.callAwsAndExtract(() => 
                ssmClient.send(new DescribeInstanceInformationCommand({
                    Filters: [{ Key: "InstanceIds", Values: [instanceId] }]
                }))
            , "InstanceInformationList");
            
            return ssmInfo && ssmInfo.length > 0 ? ssmInfo[0] || null : null;
        } catch {
            return null;
        }
    }

    private getAccountAndCallerArn(){
        return this.callAndHandleThrotteling(() =>
            this.stsClient.send(new GetCallerIdentityCommand({}))
        );
    }

    private async crawlRegion(region: string, accountId: string, partition: string): Promise<EnrichedInstance[]> {
        const ec2Client = this.getRegionalEc2Client(region);
        const ssmClient = this.getRegionalSsmClient(region);
        const instances: Instance[] = [];
        let nextToken: string | undefined = undefined;

        try {
            do {
                const response = await this.callAndHandleThrotteling(() => 
                    ec2Client.send(new DescribeInstancesCommand({ NextToken: nextToken }))
                );
                
                if (response.Reservations) {
                    for (const reservation of response.Reservations) {
                        if (reservation.Instances) {
                            instances.push(...reservation.Instances);
                        }
                    }
                }
                nextToken = response.NextToken;
            } while (nextToken);
        } catch (err: any) {
            console.error(`[EC2 CRAWLER] Error fetching instances in region ${region}:`, err.message || err);
            return [];
        }

        for (const instance of instances) {
            const iamProfile = instance.IamInstanceProfile;
            const ssmStatus = await this.getSsmStatus(ssmClient, instance.InstanceId!);
            
            extend(instance, { 
                accountId,
                region,
                hasIamProfile: !!iamProfile,
                iamInstanceProfileArn: iamProfile?.Arn,
                isSsmManaged: !!ssmStatus,
                ssmPingStatus: ssmStatus?.PingStatus,
                arn: `arn:${partition}:ec2:${region}:${accountId}:instance/${instance.InstanceId}`
            });
        }

        return instances as EnrichedInstance[];
    }

    async crawl() {
        const { Account: accountId, Arn: callerArn } = await this.getAccountAndCallerArn();
        const partitionFromArn = callerArn?.split(":")[1];

        const regions = await this.getRegions();
        const allInstances: any[] = [];

        for (const region of regions) {
            const regionalInstances = await this.crawlRegion(region, accountId!, partitionFromArn!);
            allInstances.push(...regionalInstances);
        }

        return allInstances;
    }
    
    async save(redis: any, data: EnrichedInstance[]) {
        const updatedAt = new Date().toISOString();
        for (const instance of data) {
            await redis.hSet("aura:resource:ec2instances", instance.arn, JSON.stringify({ ...instance, updated_at: updatedAt }));
        }
    }
}
