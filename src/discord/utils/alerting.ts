import { client } from "@/discord/client.ts";
import { createLogger } from "../../common/logging/logger.ts";

const log = createLogger("Alert");

export async function alertOwner(message: string): Promise<void> {
  const user = await client.users.fetch(process.env.OWNER_ID);
  await user.send(message);
  log.info("Alerted owner", { message });
}

export async function wrapWithAlerting<T>(fn: () => Promise<T>, alertMessage: string): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await alertOwner(
      `An error occurred: ${error instanceof Error ? error : "Unknown Error"}\n\nDetails: ${alertMessage}`,
    );

    log.error("Error in wrapped function", { context: alertMessage }, error);
    throw error;
  }
}
