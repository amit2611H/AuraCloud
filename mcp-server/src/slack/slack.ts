import type { ResourceStatus, WatchedResource } from "utils";

const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const MAX_SUMMARY_LINES = 30;

export type SlackBlock = Record<string, unknown>;

export type Verdict = "valid" | "error";

export interface ActionTransition {
  action: string;
  oldStatus: Verdict;
  newStatus: Verdict;
  reason?: string | null;
}

/** All the changes of ONE resource — rendered as a single Slack message. */
export interface ResourceChangeAlert {
  arn: string;
  name?: string;
  changes: ActionTransition[];
  at: Date;
}

const MAX_ALERT_LINES = 20;

const verdictLabel = (verdict: Verdict): string => (verdict === "valid" ? "ALLOWED" : "DENIED");

/**
 * Send a Slack DM. Never throws — Slack/network failures must not interrupt
 * the caller (worker loop, CLI, or anything else that notifies).
 */
export const sendSlackDM = async (
  slackUserId: string,
  text: string,
  blocks?: SlackBlock[],
): Promise<boolean> => {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error("SLACK_BOT_TOKEN is not set — skipping Slack message");
    return false;
  }
  try {
    const response = await fetch(SLACK_POST_MESSAGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel: slackUserId, text, ...(blocks ? { blocks } : {}) }),
    });
    const result = (await response.json()) as { ok: boolean; error?: string };
    if (!result.ok) {
      console.error(`Slack API error for ${slackUserId}: ${result.error ?? "unknown"}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Slack send failed:", err instanceof Error ? err.message : err);
    return false;
  }
};

export const sendPermissionChangeAlert = async (
  slackUserId: string,
  recipientName: string,
  alert: ResourceChangeAlert,
): Promise<boolean> => {
  const resourceLabel = alert.name ? `*${alert.name}*\n\`${alert.arn}\`` : `\`${alert.arn}\``;
  const deniedCount = alert.changes.filter((change) => change.newStatus === "error").length;
  const allowedCount = alert.changes.length - deniedCount;

  const changeLines = alert.changes.slice(0, MAX_ALERT_LINES).map((change) => {
    const emoji = change.newStatus === "error" ? "⛔" : "✅";
    const line = `${emoji} \`${change.action}\`  ${verdictLabel(change.oldStatus)} ➡️ ${verdictLabel(change.newStatus)}`;
    return change.reason ? `${line}\n        ↳ _${change.reason}_` : line;
  });
  if (alert.changes.length > MAX_ALERT_LINES) {
    changeLines.push(`…and ${alert.changes.length - MAX_ALERT_LINES} more`);
  }

  const text = `AuraCloud alert: ${alert.changes.length} permission change(s) on ${alert.name ?? alert.arn}`;

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `🔔 AuraCloud Security Alert for ${recipientName}`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${resourceLabel}\n*${alert.changes.length}* action${alert.changes.length === 1 ? "" : "s"} changed — ${deniedCount} now denied, ${allowedCount} now allowed`,
      },
    },
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: changeLines.join("\n") },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${alert.at.toISOString()} — alerts cover watchlist resources only — AuraCloud`,
        },
      ],
    },
  ];

  return sendSlackDM(slackUserId, text, blocks);
};

const STATUS_EMOJI: Record<ResourceStatus, string> = {
  healthy: "✅",
  blocked: "⛔",
  stale: "⌛",
  unscanned: "❔",
};

export const sendDailyWatchlistSummary = async (
  slackUserId: string,
  recipientName: string,
  resources: WatchedResource[],
): Promise<boolean> => {
  const counts: Record<ResourceStatus, number> = { healthy: 0, blocked: 0, stale: 0, unscanned: 0 };
  for (const resource of resources) counts[resource.status]++;
  const unknown = counts.stale + counts.unscanned;

  const lines = resources
    .slice(0, MAX_SUMMARY_LINES)
    .map((resource) => `${STATUS_EMOJI[resource.status]} ${resource.name ?? resource.arn} — ${resource.status}`);
  if (resources.length > MAX_SUMMARY_LINES) {
    lines.push(`…and ${resources.length - MAX_SUMMARY_LINES} more`);
  }

  const text = `AuraCloud morning summary: ${resources.length} watched, ${counts.healthy} allowed, ${counts.blocked} denied/risky`;

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `☀️ Good morning ${recipientName} — AuraCloud Watchlist`,
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Total Watched:*\n${resources.length}` },
        { type: "mrkdwn", text: `*Allowed:*\n${counts.healthy} ✅` },
        { type: "mrkdwn", text: `*Denied / Risky:*\n${counts.blocked} ⛔` },
        { type: "mrkdwn", text: `*Unknown (stale/unscanned):*\n${unknown}` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: lines.length > 0 ? lines.join("\n") : "_Your watchlist is empty — add resources in AuraCloud to start monitoring._",
      },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `Generated ${new Date().toISOString()} — AuraCloud` }],
    },
  ];

  return sendSlackDM(slackUserId, text, blocks);
};
