import "dotenv/config";
import "./monitoring.ts";
import "./console.ts";

import * as CentralResetService from "./scheduler/centralResetService.ts";
import { client } from "./client.ts";
import { Events, SlashCommandSubcommandBuilder, type Client } from "discord.js";
import * as VoiceStateUpdate from "./events/voiceStateUpdate.ts";
import * as ClientReady from "./events/clientReady.ts";
import * as InteractionCreate from "./events/interactionCreate.ts";
import * as MessageCreate from "./events/messageCreate.ts";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import relativeTime from "dayjs/plugin/relativeTime.js";
import advancedFormat from "dayjs/plugin/advancedFormat.js";
import { alertOwner } from "./utils/alerting.ts";
import { interactionExecutionTimer, resetExecutionTimer, server, voiceSessionExecutionTimer } from "./monitoring.ts";
import { commands } from "./commands.ts";
import { promisify } from "node:util";
import { createLogger, OpId } from "./utils/logger.ts";

const log = createLogger("Main");

dayjs.extend(advancedFormat);
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(relativeTime);
dayjs.tz.setDefault("UTC");

// Start the bot
try {
  registerEvents(client);
  registerShutdownHandlers();
  registerMonitoringEvents();

  CentralResetService.start();
  await client.login(process.env.DISCORD_TOKEN);
} catch (error) {
  log.error("Error initializing bot", { opId: "init" }, error);
  process.exit(1);
}

function registerEvents(client: Client) {
  client.on(Events.ClientReady, (i) => void ClientReady.execute(i));
  client.on(Events.InteractionCreate, (i) => void InteractionCreate.execute(i));
  client.on(Events.VoiceStateUpdate, (a, b) => void VoiceStateUpdate.execute(a, b));
  client.on(Events.MessageCreate, (m) => void MessageCreate.execute(m));
  client.on(Events.Debug, (info) => {
    log.debug(info);
  });
  client.on(Events.Warn, (info) => {
    log.warn(info);
  });
  client.on(Events.Error, (error) => {
    log.error("Client error event", undefined, error);
    void alertOwner(`Client error event: ${error}`, "discord-error-event");
  });
}

function registerShutdownHandlers() {
  async function shutdown(signal: string) {
    const opId = OpId.shtdwn();
    const ctx = { opId, signal };
    log.info("Shutdown initiated", ctx);

    // Voice sessions are intentionally left open on shutdown.
    // They will be resumed on next startup if still valid (< 24h old).

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const closeServer = promisify(server.close).bind(server);
    await closeServer();
    server.closeAllConnections();

    log.info("Shutdown complete", ctx);
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  process.on("uncaughtException", (error) => {
    void alertOwner(`Uncaught Exception: ${error}`, "exception");
  });
  process.on("unhandledRejection", (reason) => {
    void alertOwner(`Unhandled Rejection, reason: ${reason instanceof Error ? reason : "Unknown Error"}`, "rejection");
  });
}

function registerMonitoringEvents() {
  commands.forEach((command) => {
    const subcommands = command.data.options.filter((option) => option instanceof SlashCommandSubcommandBuilder);
    if (subcommands.length > 0) {
      subcommands.forEach((subcommand) => {
        interactionExecutionTimer.zero({
          command: command.data.name,
          subcommand: subcommand.name,
          is_autocomplete: "",
        });
      });
    } else {
      interactionExecutionTimer.zero({
        command: command.data.name,
        subcommand: "",
        is_autocomplete: "",
      });
    }
  });

  voiceSessionExecutionTimer.zero({ event: "join" });
  voiceSessionExecutionTimer.zero({ event: "leave" });
  voiceSessionExecutionTimer.zero({ event: "switch" });

  resetExecutionTimer.zero({ action: "daily" });
  resetExecutionTimer.zero({ action: "monthly" });
}
