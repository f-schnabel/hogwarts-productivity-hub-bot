import { drizzle, type NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import * as schema from "./schema.ts";
import type { GuildMember } from "discord.js";
import { eq, and, isNull, inArray, DefaultLogger, type LogWriter } from "drizzle-orm";
import { getHouseFromMember } from "../utils/utils.ts";
import type { PgTransaction } from "drizzle-orm/pg-core";

export type Schema = typeof schema;

class MyLogWriter implements LogWriter {
  write(message: string): void {
    console.debug(message);
  }
}

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
  logger: new DefaultLogger({ writer: new MyLogWriter() }),
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

export async function fetchOpenVoiceSessions(
  db: PgTransaction<NodePgQueryResultHKT, Schema>,
  usersNeedingReset: string[] | null = null,
) {
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
