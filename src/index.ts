import "dotenv/config";
import "@/common/console.ts";

// Extend dayjs BEFORE any imports that use it
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import relativeTime from "dayjs/plugin/relativeTime.js";
import advancedFormat from "dayjs/plugin/advancedFormat.js";
dayjs.extend(advancedFormat);
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(relativeTime);
dayjs.tz.setDefault("UTC");

import { startServers } from "@/common/monitoring.ts";
import * as CentralResetService from "@/services/centralResetService.ts";
import { client } from "@/discord/client.ts";
import { Events, SlashCommandSubcommandBuilder, type Client } from "discord.js";
import * as VoiceStateUpdate from "@/discord/events/voiceStateUpdate.ts";
import * as ClientReady from "@/discord/events/clientReady.ts";
import * as InteractionCreate from "@/discord/events/interactionCreate.ts";
import * as MessageCreate from "@/discord/events/messageCreate.ts";
import { alertOwner } from "@/discord/utils/alerting.ts";
import { interactionExecutionTimer, resetExecutionTimer, voiceSessionExecutionTimer } from "@/common/monitoring.ts";
import { commands } from "@/discord/commands.ts";
import { promisify } from "node:util";
import { createLogger, OpId } from "@/common/logger.ts";

const log = createLogger("Main");

// Start the bot
const { server, analyticsServer } = startServers();
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
    await promisify(server.close).bind(server)();
    server.closeAllConnections();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    await promisify(analyticsServer.close).bind(analyticsServer)();
    analyticsServer.closeAllConnections();

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
