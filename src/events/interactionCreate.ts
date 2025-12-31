import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  GuildMember,
  MessageFlags,
  type Interaction,
} from "discord.js";
import { commands } from "../commands.ts";
import assert from "node:assert/strict";
import { ensureUserExists } from "../db/db.ts";
import { alertOwner } from "../utils/alerting.ts";
import { interactionExecutionTimer } from "../monitoring.ts";
import type { VoiceTimer } from "../types.ts";

const activeVoiceTimers = new Map<string, VoiceTimer>();

export async function execute(interaction: Interaction): Promise<void> {
  const end = interactionExecutionTimer.startTimer();
  if (interaction.isButton()) {
    // @eslint-disable-next-line prefer-const
    let [commandName, event, data] = interaction.customId.split("|", 3);
    assert(commandName, "Button command name missing");
    assert(typeof event === "string", "Button event missing");
    //TODO temporary fix
    if (commandName === 'testing') {
      commandName = 'submit';
    }

    const command = commands.get(commandName);
    if (!command) {
      console.warn(`⚠️ Unknown command attempted: /${commandName} by ${interaction.user.tag}`);
      return;
    }

    assert(command.buttonHandler, `Command /${commandName} does not have a button handler`);

    await command.buttonHandler(interaction, event, data);
    end({
      command: commandName,
      subcommand: "",
      is_autocomplete: "",
    });
    return;
  }

  if (!interaction.isChatInputCommand() && !interaction.isAutocomplete() && !interaction.isButton()) return;

  logCommandExecution(interaction);

  await ensureUserExists(interaction.member as GuildMember, interaction.user.id, interaction.user.username);

  const command = commands.get(interaction.commandName);
  if (!command) {
    console.warn(`⚠️ Unknown command attempted: /${interaction.commandName} by ${interaction.user.tag}`);
    return;
  }

  try {
    if (interaction.isAutocomplete()) {
      assert(command.autocomplete, `Command /${interaction.commandName} does not support autocomplete`);
      await command.autocomplete(interaction);
    } else {
      await command.execute(interaction, { activeVoiceTimers });
    }
  } catch (error) {
    await alertOwner(
      `💥 Command execution failed: /${interaction.commandName}\n${error instanceof Error ? error : "Unknown error"}`,
    );
    if (interaction.isAutocomplete()) return;

    await handleException(error, interaction);
  }
  console.debug("-".repeat(5));
  end({
    command: interaction.commandName,
    subcommand: interaction.options.getSubcommand(false) ?? "",
    is_autocomplete: interaction.isAutocomplete() ? "autocomplete" : "",
  });
}

function logCommandExecution(interaction: ChatInputCommandInteraction | AutocompleteInteraction) {
  const channel = interaction.channel;
  let channelName;
  if (channel !== null && !channel.isDMBased()) {
    channelName = `#${channel.name}`;
  } else {
    channelName = "DM";
  }

  let commandString =
    interaction.commandName +
    (interaction.options.getSubcommand(false) ? ` ${interaction.options.getSubcommand()}` : "");
  if (interaction.isAutocomplete()) {
    commandString += ` ${interaction.options.getFocused()}`;
  }
  console.debug("+".repeat(5) + ` /${commandString} by ${interaction.user.tag} in ${channelName}`);
}

async function handleException(error: unknown, interaction: ChatInputCommandInteraction) {
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
    console.error(`💥 Failed to send error response for /${interaction.commandName}:`, replyError);
  }
}
