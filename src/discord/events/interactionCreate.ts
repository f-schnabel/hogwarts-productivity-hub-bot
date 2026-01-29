import {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  GuildMember,
  MessageFlags,
  type Interaction,
} from "discord.js";
import { commands } from "@/discord/commands.ts";
import assert from "node:assert/strict";
import { ensureUserExists } from "@/db/db.ts";
import { alertOwner } from "@/discord/utils/alerting.ts";
import { interactionExecutionTimer } from "@/common/monitoring.ts";
import { createLogger, OpId, type Ctx } from "@/common/logger.ts";

const log = createLogger("Command");

export async function execute(interaction: Interaction): Promise<void> {
  const start = Date.now();
  const end = interactionExecutionTimer.startTimer();
  const opId = OpId.cmd();

  if (interaction.isButton()) {
    await handleButton(interaction, start, end, opId);
    return;
  }

  if (!interaction.isChatInputCommand() && !interaction.isAutocomplete()) return;

  const channelName = getChannelName(interaction);
  const subcommand = interaction.options.getSubcommand(false) ?? undefined;
  const ctx = {
    opId,
    userId: interaction.user.id,
    user: interaction.user.tag,
    cmd: interaction.commandName,
    sub: subcommand,
    channel: channelName,
  };

  if (interaction.isAutocomplete()) {
    log.debug("Autocomplete", { ...ctx, focused: interaction.options.getFocused() });
  } else {
    log.debug("Received", ctx);
  }

  await ensureUserExists(interaction.member as GuildMember, interaction.user.id, interaction.user.username);

  const command = commands.get(interaction.commandName);
  if (!command) {
    log.warn("Unknown command", ctx);
    return;
  }

  try {
    if (interaction.isAutocomplete()) {
      assert(command.autocomplete, `Command /${interaction.commandName} does not support autocomplete`);
      await command.autocomplete(interaction);
    } else {
      await command.execute(interaction, { opId });
    }
  } catch (error) {
    log.error("Execution failed", ctx, error);
    await alertOwner(
      `💥 Command execution failed: /${interaction.commandName} isAutocomplete=${interaction.isAutocomplete()}\n${error instanceof Error ? error : "Unknown error"}`,
      opId,
    );
    if (interaction.isAutocomplete()) return;

    await handleException(error, interaction, ctx);
  }

  log.info("Completed", { ...ctx, ms: Date.now() - start });
  end({
    command: interaction.commandName,
    subcommand: subcommand ?? "",
    is_autocomplete: interaction.isAutocomplete() ? "autocomplete" : "",
  });
}

function getChannelName(interaction: ChatInputCommandInteraction | AutocompleteInteraction): string {
  const channel = interaction.channel;
  if (channel !== null && !channel.isDMBased()) {
    return `#${channel.name}`;
  }
  return "DM";
}

async function handleButton(
  interaction: ButtonInteraction,
  start: number,
  end: ReturnType<typeof interactionExecutionTimer.startTimer>,
  opId: string,
) {
  const [commandName, event, data] = interaction.customId.split("|", 3);
  assert(commandName, "Button command name missing");
  assert(typeof event === "string", "Button event missing");

  const ctx = { opId, userId: interaction.user.id, user: interaction.user.tag, cmd: commandName, event };
  log.debug("Button received", ctx);

  const command = commands.get(commandName);
  if (!command) {
    log.warn("Unknown button command", ctx);
    return;
  }

  assert(command.buttonHandler, `Command /${commandName} does not have a button handler`);

  await command.buttonHandler(interaction, event, data, opId);
  log.info("Button completed", { ...ctx, ms: Date.now() - start });
  end({
    command: commandName + "_button",
    subcommand: "",
    is_autocomplete: "",
  });
}

async function handleException(error: unknown, interaction: ChatInputCommandInteraction, ctx: Ctx) {
  // Improved error response handling with interaction state checks
  try {
    const errorMessage =
      error instanceof Error && error.message === "Command execution timeout"
        ? "⏱️ Command timed out. Please try again - the bot may be under heavy load."
        : "❌ An error occurred. Please try again later.";

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: errorMessage,
        flags: [MessageFlags.Ephemeral],
      });
    } else if (interaction.deferred && !interaction.replied) {
      await interaction.editReply({
        content: errorMessage,
      });
    }
    // If interaction is already replied, we can't send another response
  } catch (replyError) {
    log.error("Failed to send error response", ctx, replyError);
  }
}
