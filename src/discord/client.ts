import { Client, IntentsBitField } from "discord.js";

export const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent,
    IntentsBitField.Flags.GuildMembers,
    IntentsBitField.Flags.GuildVoiceStates, // Required for voice channel detection
    IntentsBitField.Flags.DirectMessages,
  ],
});
