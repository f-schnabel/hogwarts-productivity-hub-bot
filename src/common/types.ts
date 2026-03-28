import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  GuildMember,
  SharedSlashCommand,
} from "discord.js";
import type { HOUSES, SUBMISSION_TYPES } from "./constants.ts";

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

export type House = (typeof HOUSES)[number];

export interface VoiceSession {
  username: string;
  discordId: string;
  channelId: string | null;
  channelName: string | null;
}

export interface YearProgress {
  badge: string;
  badgeColor: string;
  percent: number;
  barStart: string;
  barEnd: string;
  barGlow: string;
  text: string;
  leftLabel: string;
  rightLabel: string;
  isMax: boolean;
}

export interface BarColors {
  barStart: string;
  barEnd: string;
  barGlow: string;
}

export interface Sums {
  total: number;
  monthly: number;
  daily: number;
}

export interface HousePoints {
  house: House;
  totalPoints: number;
  memberCount: number;
}

export interface UpdateMemberParams {
  member: GuildMember;
  reason?: string;
  nickname?: string | null;
  roleUpdates?: {
    rolesToAdd?: string[];
    rolesToRemove?: string[];
  } | null;
}

export type SubmissionType = (typeof SUBMISSION_TYPES)[keyof typeof SUBMISSION_TYPES];
