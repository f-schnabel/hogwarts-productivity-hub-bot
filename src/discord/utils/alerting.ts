import { client } from "@/discord/client.ts";
import { createLogger } from "../../common/logging/logger.ts";

const log = createLogger("Alert");

export async function sendAlert(message: string): Promise<void> {
  const channel = await client.channels.fetch(process.env.ALERT_CHANNEL_ID);
  if (!channel?.isSendable()) {
    throw new Error(`Alert channel ${process.env.ALERT_CHANNEL_ID} was not found or cannot receive messages.`);
  }

  await channel.send(message);
  log.info("Alert sent", { channelId: process.env.ALERT_CHANNEL_ID, message });
}

export async function wrapWithAlerting<T>(fn: () => Promise<T>, alertMessage: string): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await sendAlert(`An error occurred: ${error instanceof Error ? error : "Unknown Error"}\n\nDetails: ${alertMessage}`);

    log.error("Error in wrapped function", { context: alertMessage }, error);
    throw error;
  }
}
