import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  SharedSlashCommand,
} from "discord.js";
import type { HOUSE_COLORS } from "./utils/constants.ts";

export interface CommandOptions {
  opId: string;
}

export interface Command {
  data: SharedSlashCommand;
  execute: (interaction: ChatInputCommandInteraction, options: CommandOptions) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
  buttonHandler?: (
    interaction: ButtonInteraction,
    event: string,
    data: string | undefined,
    opId: string,
  ) => Promise<void>;
}

export type House = keyof typeof HOUSE_COLORS;

export interface VoiceSession {
  username: string;
  discordId: string;
  channelId: string | null;
  channelName: string | null;
}
