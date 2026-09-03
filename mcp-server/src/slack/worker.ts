// Bootstrap first: IPv4 DNS fix + stdout-to-stderr console redirect.
import "../bootstrap.js";

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import cron from "node-cron";
import { connectMongo, getWatchedResources } from "utils";
import { createShutdown } from "../shutdown.js";
import { sendPermissionChangeAlert } from "./slack.js";
import { sendDailySummaries, usersWithSlack } from "./summaries.js";
import { diffWatchedStatuses, groupByResource, type StatusSnapshot } from "./statusDiff.js";

// Same env resolution chain as the other entries.
dotenv.config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });
dotenv.config({ path: fileURLToPath(new URL("../../../api-server/.env", import.meta.url)), quiet: true });

// The Brain re-evaluates every ~10s; polling a bit slower catches every write
// without hammering Mongo. Restarts reseed silently — no alert replay.
const POLL_MS = Number(process.env.SLACK_ALERT_POLL_MS) || 15_000;
const DAILY_CRON = process.env.SLACK_DAILY_CRON ?? "0 8 * * *";

const snapshots = new Map<string, StatusSnapshot>();

const pollOnce = async (): Promise<void> => {
  const users = await usersWithSlack();
  for (const user of users) {
    if (!user.slackUserId) continue;
    try {
      const view = await getWatchedResources(user.externalId);
      const { changes, snapshot } = diffWatchedStatuses(
        snapshots.get(user.externalId) ?? null,
        view.resources,
        view.permissionsData,
      );
      snapshots.set(user.externalId, snapshot);

      // One message per resource — a burst of action changes must not spam the DM.
      for (const group of groupByResource(changes)) {
        console.error(
          `Permission changes for ${user.name}: ${group.changes.length} action(s) on ${group.arn}`,
        );
        await sendPermissionChangeAlert(user.slackUserId, user.name, {
          ...group,
          at: new Date(),
        });
      }
    } catch (err) {
      console.error(
        `Alert poll for ${user.name} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
};

const main = async (): Promise<void> => {
  if (!process.env.SLACK_BOT_TOKEN) {
    throw new Error("SLACK_BOT_TOKEN is not set — the Slack worker cannot send messages without it");
  }
  if (!cron.validate(DAILY_CRON)) {
    throw new Error(`SLACK_DAILY_CRON "${DAILY_CRON}" is not a valid cron expression`);
  }

  await connectMongo();
  await pollOnce(); // seed the snapshots — transitions are alerted from the next cycle on

  const pollTimer = setInterval(() => {
    void pollOnce();
  }, POLL_MS);

  const dailyTask = cron.schedule(DAILY_CRON, () => {
    void sendDailySummaries()
      .then(({ sent, failed }) =>
        console.error(`Daily watchlist summaries: ${sent} sent, ${failed} failed`),
      )
      .catch((err) => console.error("Daily summary run failed:", err));
  });

  console.error(
    `AuraCloud Slack worker running (alert poll ${POLL_MS}ms, daily summary cron "${DAILY_CRON}")`,
  );

  const shutdown = createShutdown(() => {
    clearInterval(pollTimer);
    void dailyTask.stop();
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

main().catch((err: unknown) => {
  console.error("Fatal:", err);
  process.exit(1);
});
