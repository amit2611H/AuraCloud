import { UserModel, getWatchedResources } from "utils";
import { sendDailyWatchlistSummary } from "./slack.js";

/** AWS identities that opted into Slack notifications. */
export const usersWithSlack = () =>
  UserModel.find({ slackUserId: { $nin: [null, ""] } })
    .lean()
    .exec();

export const sendDailySummaries = async (): Promise<{ sent: number; failed: number }> => {
  const users = await usersWithSlack();
  let sent = 0;
  let failed = 0;

  for (const user of users) {
    if (!user.slackUserId) continue;
    try {
      const view = await getWatchedResources(user.externalId);
      const delivered = await sendDailyWatchlistSummary(user.slackUserId, user.name, view.resources);
      delivered ? sent++ : failed++;
    } catch (err) {
      failed++;
      console.error(
        `Daily summary for ${user.name} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { sent, failed };
};
