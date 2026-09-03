// One-shot CLI: send the daily watchlist summary now (npm run send-daily-summary).
import "../bootstrap.js";

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { connectMongo, disconnectMongo } from "utils";
import { sendDailySummaries } from "./summaries.js";

dotenv.config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });
dotenv.config({ path: fileURLToPath(new URL("../../../api-server/.env", import.meta.url)), quiet: true });

const main = async (): Promise<void> => {
  await connectMongo();
  const { sent, failed } = await sendDailySummaries();
  console.error(`Daily watchlist summaries: ${sent} sent, ${failed} failed`);
  await disconnectMongo();
  process.exit(failed > 0 ? 1 : 0);
};

main().catch((err: unknown) => {
  console.error("Fatal:", err);
  process.exit(1);
});
