import { client } from "@/discord/client.ts";
import { createLogger } from "../../common/logger.ts";

const log = createLogger("Alert");

export async function alertOwner(message: string, opId: string): Promise<void> {
  const user = await client.users.fetch(process.env.OWNER_ID);
  await user.send(message);
  log.info("Alerted owner", { opId, message });
}

export async function wrapWithAlerting<T>(fn: () => Promise<T>, alertMessage: string, opId: string): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await alertOwner(
      `An error occurred: ${error instanceof Error ? error : "Unknown Error"}\n\nDetails: ${alertMessage}`,
      opId,
    );

    log.error("Error in wrapped function", { opId, context: alertMessage }, error);
    throw error;
  }
}
