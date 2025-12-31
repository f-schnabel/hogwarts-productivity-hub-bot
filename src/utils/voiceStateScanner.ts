/**
 * Voice State Scanner
 * Scans Discord voice states on bot startup and automatically starts tracking
 * for users already in voice channels
 */

import { client } from "../client.ts";
import { BaseGuildVoiceChannel, ChannelType, Collection, type Guild } from "discord.js";
import { startVoiceSession } from "./voiceUtils.ts";
import { db, ensureUserExists } from "../db/db.ts";
import { voiceSessionTable } from "../db/schema.ts";
import { isNull } from "drizzle-orm";

let isScanning = false;
let scanResults = {
  totalUsersFound: 0,
  trackingStarted: 0,
  errors: 0,
  channels: [] as { id: string; name: string; userCount: number }[],
};

/**
 * Scan all voice channels and start tracking for users already in voice
 */
export async function scanAndStartTracking() {
  if (isScanning) {
    console.warn("🔄 Voice state scan already in progress, skipping...");
    return scanResults;
  }

  isScanning = true;
  scanResults = {
    totalUsersFound: 0,
    trackingStarted: 0,
    errors: 0,
    channels: [],
  };

  const activeVoiceSessions = await db
    .select({
      discordId: voiceSessionTable.discordId,
    })
    .from(voiceSessionTable)
    .where(isNull(voiceSessionTable.leftAt))
    .then((s) => s.map((r) => r.discordId));

  try {
    // Get all guilds (should be only one for this bot)
    const guilds = client.guilds.cache;

    if (guilds.size === 0) {
      console.warn("No guilds found for voice state scanning");
      return scanResults;
    }

    for (const [, guild] of guilds) {
      await scanGuildVoiceStates(guild, activeVoiceSessions);
    }

    console.log("VOICE SCAN SUMMARY:");
    if (scanResults.channels.length > 0) {
      console.log("   Voice Channels with Users:");
      scanResults.channels.forEach((channel) => {
        console.log(`    • ${channel.name}: ${channel.userCount} users`);
      });
    }

    if (scanResults.trackingStarted > 0) {
      console.log(`   Successfully started automatic tracking for ${scanResults.trackingStarted} users`);
    } else if (scanResults.totalUsersFound > 0) {
      console.log("   All found users were already being tracked");
    } else {
      console.log("   No users currently in voice channels");
    }

    return scanResults;
  } catch (error) {
    console.error("❌ Error during voice state scan:", error);
    scanResults.errors++;
    return scanResults;
  } finally {
    isScanning = false;
  }
}

/**
 * Scan voice states for a specific guild
 * @param {Guild} guild - Discord guild
 */
async function scanGuildVoiceStates(guild: Guild, activeVoiceSessions: string[]) {
  try {
    // Get all voice channels in the guild
    const voiceChannels = guild.channels.cache.filter(
      (channel) =>
        channel.type === ChannelType.GuildVoice && // Voice channel type
        channel.members.size > 0, // Has members
    ) as Collection<string, BaseGuildVoiceChannel>;

    for (const [, channel] of voiceChannels) {
      await scanVoiceChannel(channel, activeVoiceSessions);
    }
  } catch (error) {
    console.error(`❌ Error scanning guild ${guild.name}:`, error);
    scanResults.errors++;
  }
}

/**
 * Scan a specific voice channel and start tracking for users
 * @param {BaseGuildVoiceChannel} channel - Discord voice channel
 */
async function scanVoiceChannel(channel: BaseGuildVoiceChannel, activeVoiceSessions: string[]) {
  try {
    const members = channel.members;

    // Add to scan results
    scanResults.channels.push({
      id: channel.id,
      name: channel.name,
      userCount: members.size,
    });

    const usersStarted = [];

    for (const [discordId, member] of members) {
      const username = member.user.username;
      try {
        // Skip bots
        if (member.user.bot) {
          continue;
        }

        scanResults.totalUsersFound++;

        // Check if user already has an active session
        if (activeVoiceSessions.includes(discordId)) {
          continue;
        }

        await ensureUserExists(member, discordId, username);
        // Start voice session for this user
        await startVoiceSession(
          {
            discordId,
            username,
            channelId: channel.id,
            channelName: channel.name,
          },
          db,
        );

        scanResults.trackingStarted++;
        usersStarted.push(username);
      } catch (userError) {
        console.error(`Error starting tracking for user ${username}:`, userError);
        scanResults.errors++;
      }
    }

    if (usersStarted.length > 0) {
      console.log(`Started tracking for ${usersStarted.length} users in ${channel.name}:`, usersStarted.join(", "));
    }
  } catch (error) {
    console.error(`Error scanning voice channel ${channel.name}:`, error);
    scanResults.errors++;
  }
}
