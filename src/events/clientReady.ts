import type { Client } from "discord.js";
import { commands } from "../commands.ts";
import * as VoiceStateScanner from "../utils/voiceStateScanner.ts";
import { alertOwner } from "../utils/alerting.ts";
import { db } from "../db/db.ts";
import { userTable } from "../db/schema.ts";
import { gt } from "drizzle-orm";
import { updateMessageStreakInNickname } from "../utils/utils.ts";

export async function execute(c: Client<true>): Promise<void> {
  console.log(`Bot User: ${c.user.tag}`);
  console.log(`Client ID: ${c.user.id}`);
  console.log(`Commands Loaded: ${commands.size}`);

  try {
    await VoiceStateScanner.scanAndStartTracking();
    await resetNicknameStreaks(c);
    await logDbUserRetention(c);
  } catch (error) {
    console.error("❌ Bot Initialization Failed");
    console.error("error:", error);
    process.exit(1);
  }
  await alertOwner("Bot deployed successfully.");
}

async function logDbUserRetention(client: Client) {
  const dbUserIds = await db
    .select({ discordId: userTable.discordId })
    .from(userTable)
    .then((rows) => new Set(rows.map((r) => r.discordId)));

  // Use cache since resetNicknameStreaks already fetched all members
  const guildMemberIds = new Set<string>();
  for (const guild of client.guilds.cache.values()) {
    for (const memberId of guild.members.cache.keys()) {
      guildMemberIds.add(memberId);
    }
  }

  const foundCount = [...dbUserIds].filter((id) => guildMemberIds.has(id)).length;
  const percentage = dbUserIds.size > 0 ? ((foundCount / dbUserIds.size) * 100).toFixed(1) : "0";

  console.log(`DB User Retention: ${foundCount}/${dbUserIds.size} (${percentage}%) users in db found on servers`);
}

async function resetNicknameStreaks(client: Client) {
  console.log("Guilds Cache Size:", client.guilds.cache.size);
  const discordIdsToStreak = await db
    .select({
      discordId: userTable.discordId,
      messageStreak: userTable.messageStreak,
    })
    .from(userTable)
    .where(gt(userTable.messageStreak, 0))
    .then((rows) =>
      rows.reduce<Record<string, number>>((acc, r) => {
        acc[r.discordId] = r.messageStreak;
        return acc;
      }, {}),
    );
  const discordIds = new Set(Object.keys(discordIdsToStreak));

  for (const guild of client.guilds.cache.values()) {
    const membersToReset = await guild.members
      .fetch()
      .then((members) =>
        members.filter(
          (member) =>
            !discordIds.has(member.id) && member.guild.ownerId !== member.user.id && member.nickname?.match(/⚡\d+$/),
        ),
      );
    const membersToUpdate = guild.members.cache.filter(
      (member) =>
        discordIds.has(member.id) &&
        (!member.nickname?.endsWith(`⚡${String(discordIdsToStreak[member.id])}`) ||
          member.nickname.endsWith(` ⚡${String(discordIdsToStreak[member.id])}`)),
    );

    console.log(
      `Processing guild: ${guild.name} (${guild.id}), Members Cache Size: ${guild.members.cache.size}, toReset ${membersToReset.size} toUpdate ${membersToUpdate.size}`,
    );
    await Promise.all([
      ...membersToReset.values().map(async (m) => {
        await updateMessageStreakInNickname(m, 0);
      }),
      ...membersToUpdate.values().map(async (m) => {
        const streak = discordIdsToStreak[m.id];
        if (typeof streak === "undefined") {
          throw new Error(`unreachable: Streak for member ${m.id} does not exist`);
        }
        await updateMessageStreakInNickname(m, streak);
      }),
    ]);
  }
}
