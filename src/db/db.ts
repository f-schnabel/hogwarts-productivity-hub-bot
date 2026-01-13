import { drizzle, type NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import * as schema from "./schema.ts";
import type { GuildMember } from "discord.js";
import { eq, and, type ExtractTablesWithRelations, isNull, inArray, DefaultLogger } from "drizzle-orm";
import { getHouseFromMember } from "../utils/houseUtils.ts";
import type { PgTransaction } from "drizzle-orm/pg-core";
import dayjs from "dayjs";
import { SETTINGS_KEYS } from "../utils/constants.ts";

type Schema = typeof schema;

export type Tx = PgTransaction<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
export type DbOrTx = Tx | typeof db;

export const db = drizzle({
  connection: {
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    ssl: false,
  },
  schema,
  casing: "snake_case",
  logger: new DefaultLogger({
    writer: {
      write: (msg) => {
        console.debug(msg);
      },
    },
  }),
});

export async function ensureUserExists(member: GuildMember | null, discordId: string, username: string) {
  const house = getHouseFromMember(member);

  await db.insert(schema.userTable).values({ discordId, username, house }).onConflictDoUpdate({
    target: schema.userTable.discordId,
    set: {
      username,
      house,
    },
  });
}

export async function fetchUserTimezone(discordId: string) {
  return await db
    .select({ timezone: schema.userTable.timezone })
    .from(schema.userTable)
    .where(eq(schema.userTable.discordId, discordId))
    .then((rows) => rows[0]?.timezone ?? "UTC");
}

export async function fetchOpenVoiceSessions(db: Tx, usersNeedingReset: string[] | null = null) {
  return await db
    .select({
      discordId: schema.voiceSessionTable.discordId,
      username: schema.userTable.username,
      channelId: schema.voiceSessionTable.channelId,
      channelName: schema.voiceSessionTable.channelName,
    })
    .from(schema.voiceSessionTable)
    .where(
      and(
        usersNeedingReset === null ? undefined : inArray(schema.voiceSessionTable.discordId, usersNeedingReset),
        isNull(schema.voiceSessionTable.leftAt),
      ),
    )
    .innerJoin(schema.userTable, eq(schema.voiceSessionTable.discordId, schema.userTable.discordId));
}

type SettingKey = (typeof SETTINGS_KEYS)[keyof typeof SETTINGS_KEYS];

async function setSetting(key: SettingKey, value: string) {
  await db.insert(schema.settingsTable).values({ key, value }).onConflictDoUpdate({
    target: schema.settingsTable.key,
    set: { value },
  });
}

async function getSetting(key: SettingKey): Promise<string | null> {
  const [setting] = await db.select().from(schema.settingsTable).where(eq(schema.settingsTable.key, key));
  return setting ? setting.value : null;
}

export async function getMonthStartDate(): Promise<Date> {
  const setting = await getSetting(SETTINGS_KEYS.LAST_MONTHLY_RESET);
  return setting ? new Date(setting) : dayjs().startOf("month").toDate();
}

export async function setMonthStartDate(date: Date) {
  await setSetting(SETTINGS_KEYS.LAST_MONTHLY_RESET, date.toISOString());
}

export async function getVCEmoji(): Promise<string> {
  const setting = await getSetting(SETTINGS_KEYS.VC_EMOJI);
  return setting ?? "🎆";
}

export async function setVCEmoji(emoji: string) {
  await setSetting(SETTINGS_KEYS.VC_EMOJI, emoji);
}
