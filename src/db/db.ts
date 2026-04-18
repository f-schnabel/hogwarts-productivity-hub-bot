import { drizzle, type NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import * as schema from "./schema.ts";
import type { GuildMember } from "discord.js";
import {
  eq,
  and,
  gt,
  gte,
  lt,
  desc,
  count,
  sum,
  asc,
  type ExtractTablesWithRelations,
  isNull,
  inArray,
  type Logger,
  not,
} from "drizzle-orm";
import { sql } from "drizzle-orm/sql/sql";
import type { PgTransaction } from "drizzle-orm/pg-core";
import dayjs from "dayjs";
import { MIN_MONTHLY_POINTS_FOR_WEIGHTED, SETTINGS_KEYS } from "../common/constants.ts";
import assert from "node:assert/strict";
import type { CountingState, House, HousePoints } from "@/common/types.ts";
import { createLogger } from "@/common/logger.ts";

type Schema = typeof schema;

export type Tx = PgTransaction<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
export type DbOrTx = Tx | typeof db;

class MyLogger implements Logger {
  dbLogger = createLogger("DB");

  private formatParam(param: unknown): string {
    if (param === null) return "null";
    if (param === undefined) return "undefined";
    if (param instanceof Date) return `'${param.toISOString()}'`;
    if (typeof param === "string") return `'${param.replaceAll("'", "''")}'`;
    if (typeof param === "number" || typeof param === "bigint") return String(param);
    if (typeof param === "boolean") return param ? "true" : "false";
    if (Array.isArray(param)) return `ARRAY[${param.map((value) => this.formatParam(value)).join(", ")}]`;

    try {
      return `'${JSON.stringify(param).replaceAll("'", "''")}'`;
    } catch {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      return `'${String(param).replaceAll("'", "''")}'`;
    }
  }

  private renderQuery(query: string, params: unknown[]): string {
    return query.replace(/\$(\d+)/g, (match, index: string) => {
      const param = params[Number(index) - 1];
      return param === undefined ? match : this.formatParam(param);
    });
  }

  logQuery(query: string, params: unknown[]): void {
    query = query.replaceAll('"', "");
    if (query.includes("insert into user")) {
      return;
    }
    if (query.includes("update user set updated_at = $1, daily_messages = user.daily_messages + 1")) {
      return;
    }
    if (query.includes("commit")) {
      this.dbLogger.debug("Committing transaction");
      return;
    }
    if (query.includes("rollback")) {
      this.dbLogger.debug("Rolling back transaction");
      return;
    }
    if (query.includes("begin")) {
      this.dbLogger.debug("Beginning transaction");
      return;
    }

    this.dbLogger.debug("Performing query", { query: this.renderQuery(query, params) });
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
  logger: new MyLogger(),
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

export async function getUserTimezone(discordId: string) {
  return await db
    .select({ timezone: schema.userTable.timezone })
    .from(schema.userTable)
    .where(eq(schema.userTable.discordId, discordId))
    .then((rows) => rows[0]?.timezone ?? "UTC");
}

export async function getOpenVoiceSessions(db: Tx, usersNeedingReset: string[] | null = null) {
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

export async function setMonthStartDate(date: Date, db: DbOrTx) {
  await db.insert(schema.settingsTable).values({ key: SETTINGS_KEYS.LAST_MONTHLY_RESET, value: date.toISOString() }).onConflictDoUpdate({
    target: schema.settingsTable.key,
    set: { value: date.toISOString() },
  });
}

export async function getVCEmoji(): Promise<string> {
  const setting = await getSetting(SETTINGS_KEYS.VC_EMOJI);
  return setting ?? "🎆";
}

export async function setVCEmoji(emoji: string) {
  await setSetting(SETTINGS_KEYS.VC_EMOJI, emoji);
}

export async function getCountingState(tx: Tx): Promise<CountingState> {
  const [count, discordId] = await Promise.all([
    tx.select().from(schema.settingsTable).where(eq(schema.settingsTable.key, SETTINGS_KEYS.COUNTING_COUNT)).for("no key update").then((rows) => rows[0]?.value ?? ""),
    tx.select().from(schema.settingsTable).where(eq(schema.settingsTable.key, SETTINGS_KEYS.COUNTING_DISCORD_ID)).for("no key update").then((rows) => rows[0]?.value),
  ]);

  return {
    count: parseInt(count) || 0,
    discordId,
  };
}

export async function setCountingState(state: CountingState, tx: Tx) {
  await Promise.all([
    tx.insert(schema.settingsTable).values({ key: SETTINGS_KEYS.COUNTING_COUNT, value: String(state.count) }).onConflictDoUpdate({
      target: schema.settingsTable.key,
      set: { value: String(state.count) },
    }),
    tx.insert(schema.settingsTable).values({ key: SETTINGS_KEYS.COUNTING_DISCORD_ID, value: state.discordId ?? "" }).onConflictDoUpdate({
      target: schema.settingsTable.key,
      set: { value: state.discordId ?? "" },
    }),
  ]);
}

const HOUSE_ROLES = [
  [process.env.GRYFFINDOR_ROLE_ID, "Gryffindor"],
  [process.env.SLYTHERIN_ROLE_ID, "Slytherin"],
  [process.env.HUFFLEPUFF_ROLE_ID, "Hufflepuff"],
  [process.env.RAVENCLAW_ROLE_ID, "Ravenclaw"],
] as const;

/** Weighted house points: SUM(monthlyPoints) / COUNT(*) for users above threshold */
export async function getWeightedHousePoints(db: DbOrTx): Promise<HousePoints[]> {
  const totalPoints = sql<number>`${sum(schema.userTable.monthlyPoints)} / ${count()}`.as("total_points");
  return await db
    .select({
      house: schema.userTable.house,
      totalPoints,
      memberCount: count().as("member_count"),
    })
    .from(schema.userTable)
    .where(
      and(not(isNull(schema.userTable.house)), gt(schema.userTable.monthlyPoints, MIN_MONTHLY_POINTS_FOR_WEIGHTED)),
    )
    .groupBy(schema.userTable.house)
    .orderBy(desc(totalPoints))
    .then((rows) => rows.filter((r): r is HousePoints => r.house !== null));
}

/**
 * Daily point events per user since `monthStart`, aggregated from the timestamps
 * when points actually affect monthly standings: tracked voice session end,
 * submission approval, and admin adjustment creation. Day string is YYYY-MM-DD in UTC.
 * House is taken from userTable (current house) so weighted calcs stay consistent.
 */
export async function getDailyUserPointEvents(
  db: DbOrTx,
  monthStart: Date,
): Promise<{ discordId: string; house: House | null; day: string; points: number }[]> {
  const effectiveMonthEnd = dayjs(monthStart).add(1, "day").endOf("month").toDate();

  const voiceEvents = db
    .select({
      discordId: schema.voiceSessionTable.discordId,
      house: schema.userTable.house,
      day: sql<string>`to_char(${schema.voiceSessionTable.leftAt}, 'YYYY-MM-DD')`.as("day"),
      points: sql<number>`coalesce(${schema.voiceSessionTable.points}, 0)`.as("points"),
    })
    .from(schema.voiceSessionTable)
    .innerJoin(schema.userTable, eq(schema.voiceSessionTable.discordId, schema.userTable.discordId))
    .where(
      and(
        not(isNull(schema.voiceSessionTable.leftAt)),
        gte(schema.voiceSessionTable.leftAt, monthStart),
        lt(schema.voiceSessionTable.leftAt, effectiveMonthEnd),
        eq(schema.voiceSessionTable.isTracked, true),
        not(isNull(schema.userTable.house)),
      ),
    );

  const submissionEvents = db
    .select({
      discordId: schema.submissionTable.discordId,
      house: schema.userTable.house,
      day: sql<string>`to_char(${schema.submissionTable.reviewedAt}, 'YYYY-MM-DD')`.as("day"),
      points: schema.submissionTable.points,
    })
    .from(schema.submissionTable)
    .innerJoin(schema.userTable, eq(schema.submissionTable.discordId, schema.userTable.discordId))
    .where(
      and(
        eq(schema.submissionTable.status, "APPROVED"),
        not(isNull(schema.submissionTable.reviewedAt)),
        gte(schema.submissionTable.reviewedAt, monthStart),
        lt(schema.submissionTable.reviewedAt, effectiveMonthEnd),
        not(isNull(schema.userTable.house)),
      ),
    );

  const adjustmentEvents = db
    .select({
      discordId: schema.pointAdjustmentTable.discordId,
      house: schema.userTable.house,
      day: sql<string>`to_char(${schema.pointAdjustmentTable.createdAt}, 'YYYY-MM-DD')`.as("day"),
      points: schema.pointAdjustmentTable.amount,
    })
    .from(schema.pointAdjustmentTable)
    .innerJoin(schema.userTable, eq(schema.pointAdjustmentTable.discordId, schema.userTable.discordId))
    .where(
      and(
        gte(schema.pointAdjustmentTable.createdAt, monthStart),
        lt(schema.pointAdjustmentTable.createdAt, effectiveMonthEnd),
        not(isNull(schema.userTable.house)),
      ),
    );

  const pointEvents = voiceEvents.unionAll(submissionEvents).unionAll(adjustmentEvents).as("point_events");

  return await db
    .select({
      discordId: pointEvents.discordId,
      house: pointEvents.house,
      day: pointEvents.day,
      points: sql<number>`coalesce(sum(${pointEvents.points}), 0)::int`.as("points"),
    })
    .from(pointEvents)
    .groupBy(pointEvents.discordId, pointEvents.house, pointEvents.day)
    .orderBy(asc(pointEvents.day), asc(pointEvents.discordId));
}

/** Unweighted house points: SUM(monthlyPoints) for users with any points */
export async function getUnweightedHousePoints(db: DbOrTx): Promise<HousePoints[]> {
  const totalPoints = sql<number>`${sum(schema.userTable.monthlyPoints)}`.as("total_points");
  return await db
    .select({
      house: schema.userTable.house,
      totalPoints,
      memberCount: count().as("member_count"),
    })
    .from(schema.userTable)
    .where(and(not(isNull(schema.userTable.house)), gt(schema.userTable.monthlyPoints, 0)))
    .groupBy(schema.userTable.house)
    .orderBy(desc(totalPoints))
    .then((rows) => rows.filter((r): r is HousePoints => r.house !== null));
}

export function getHouseFromMember(member: GuildMember | null): House | undefined {
  if (!member) return undefined;
  const roles = member.roles.cache;

  const houses = HOUSE_ROLES.filter(([roleId]) => roles.has(roleId));
  assert(
    houses.length <= 1,
    `Member ${member.user.tag} has multiple house roles: ${houses.map(([, name]) => name).join(", ")}`,
  );
  return houses[0]?.[1];
}
