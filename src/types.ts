import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  SharedSlashCommand,
} from "discord.js";

export interface Command {
  data: SharedSlashCommand;
  execute: (
    interaction: ChatInputCommandInteraction,
    options: { activeVoiceTimers: Map<string, VoiceTimer> },
  ) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
  buttonHandler?: (interaction: ButtonInteraction, event: string, data: string | undefined) => Promise<void>;
}

export type House = "Gryffindor" | "Hufflepuff" | "Ravenclaw" | "Slytherin";

export interface VoiceSession {
  username: string;
  discordId: string;
  channelId: string | null;
  channelName: string | null;
}

export interface VoiceTimer {
  endTime: Date;
  phase: "work" | "break";
  startTime: number;
  workTimeout?: NodeJS.Timeout;
  breakTimeout?: NodeJS.Timeout;
}
