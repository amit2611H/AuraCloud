// Node 22+/24 defaults to IPv6 DNS (link-local) which causes querySrv ECONNREFUSED
// on residential routers. Force IPv4 DNS servers before any network call is made.
import dns from 'dns';
dns.setServers(['8.8.8.8', '1.1.1.1']);

import 'dotenv/config';
import { connectMongo, disconnectMongo, disconnectRedis, getRedisClient, print, UserPermissionModel } from 'utils';
import { getUsersFromMongo } from './dataAccess.js';
import { evaluateUser } from './userEvaluation.js';
import { startUserSyncWorker } from './userSync/worker.js';
import { startResourceSyncWorker } from './resourceSync/worker.js';


async function main() {
  const [, redis] = await Promise.all([connectMongo(), getRedisClient()]);
  startUserSyncWorker(redis);
  startResourceSyncWorker(redis);

  const intervalMs = 10000; // Run every 10 seconds

  while (true) {
    const start = Date.now();
    console.log(`[${new Date().toLocaleTimeString()}] 🚀 Initiating logic evaluation cycle...`);

    try {
      const users = await getUsersFromMongo();
      for (const user of users) {
        const findings = await evaluateUser(user, redis as any);
        const permissionsData: Record<string, any> = {};
        const timestamp = new Date().toISOString();
        if (!findings) continue

        for (const resEntry of findings.resources) {
          const { arn, actionResults, evaluatedAt: resourceEvaluatedAt } = resEntry;
          if (!arn || !actionResults) continue;

          permissionsData[arn] = {};
          for (const actionObj of actionResults) {
            const actionName = Object.keys(actionObj)[0];
            if (!actionName) continue;
            const evalRes = actionObj[actionName] as any;

            const actionStatus = {
              status: evalRes.allowed ? 'valid' : 'error',
              reason: evalRes.allowed ? null : evalRes.reason,
              origin: evalRes.origin ?? null,
              timestamp,
              evaluatedAt: resourceEvaluatedAt,
              details: {
                context: evalRes.context,
                steps: evalRes.steps,
                origin: evalRes.origin ?? null,
              }
            };

            permissionsData[arn][actionName] = actionStatus;

            // Strip the service prefix and camelCase (e.g. s3:GetObject -> getObject) for frontend compatibility.
            // NOTE: mcp-server/src/permissions.ts reverse-engineers this exact alias formula to dedupe
            // reads — keep them in sync (or remove this alias write; no frontend lookup depends on it).
            const camelCaseAction = actionName.split(':').pop()!;
            const camelCaseName = camelCaseAction.charAt(0).toLowerCase() + camelCaseAction.slice(1);
            if (camelCaseName !== actionName) {
              permissionsData[arn][camelCaseName] = actionStatus;
            }
          }
        }

        await UserPermissionModel.findOneAndUpdate(
          { userId: user.userId },
          {
            $set: {
              name: user.name,
              userId: user.userId,
              permissionsData,
            },
          },
          { upsert: true, returnDocument: 'after' }
        );
        console.log(`Saved evaluation results for user: ${user.name} (${user.userId})`);
      }
      console.log(`[${new Date().toLocaleTimeString()}] ✅ Logic Evaluation Cycle Complete`);
    } catch (err: any) {
      console.error(`❌ Logic evaluation cycle error:`, err.message || err);
    }

    const sleep = Math.max(intervalMs - (Date.now() - start), 0);
    await new Promise(r => setTimeout(r, sleep));
  }
}

async function shutdown(code = 0) {
  try {
    await disconnectRedis();
    await disconnectMongo();
  } catch (err) {
    console.error('Error during shutdown:', err);
  } finally {
    process.exit(code);
  }
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

main()
  .then(() => shutdown(0))
  .catch((err) => {
    console.error('Logic module failed to start:', err);
    void shutdown(1);
  });
