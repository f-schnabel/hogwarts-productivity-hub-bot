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
import { createLogger, OpId } from "./logger.ts";

const log = createLogger("VoiceScan");

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
export async function scanAndStartTracking(parentOpId?: string) {
  const opId = parentOpId ?? OpId.vcscan();
  const ctx = { opId };

  if (isScanning) {
    log.warn("Scan already in progress, skipping", ctx);
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
      log.warn("No guilds found", ctx);
      return scanResults;
    }

    for (const [, guild] of guilds) {
      await scanGuildVoiceStates(guild, activeVoiceSessions, opId);
    }

    log.info("Scan complete", {
      ...ctx,
      usersFound: scanResults.totalUsersFound,
      trackingStarted: scanResults.trackingStarted,
      errors: scanResults.errors,
      channels: scanResults.channels.map((c) => `${c.name}:${c.userCount}`).join(", ") || "none",
    });

    return scanResults;
  } catch (error) {
    log.error("Scan failed", ctx, error);
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
async function scanGuildVoiceStates(guild: Guild, activeVoiceSessions: string[], opId: string) {
  const ctx = { opId, guild: guild.name };
  try {
    // Get all voice channels in the guild
    const voiceChannels = guild.channels.cache.filter(
      (channel) =>
        channel.type === ChannelType.GuildVoice && // Voice channel type
        channel.members.size > 0, // Has members
    ) as Collection<string, BaseGuildVoiceChannel>;

    for (const [, channel] of voiceChannels) {
      await scanVoiceChannel(channel, activeVoiceSessions, opId);
    }
  } catch (error) {
    log.error("Guild scan failed", ctx, error);
    scanResults.errors++;
  }
}

/**
 * Scan a specific voice channel and start tracking for users
 * @param {BaseGuildVoiceChannel} channel - Discord voice channel
 */
async function scanVoiceChannel(channel: BaseGuildVoiceChannel, activeVoiceSessions: string[], opId: string) {
  const ctx = { opId, channel: channel.name };
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
          opId,
        );

        scanResults.trackingStarted++;
        usersStarted.push(username);
      } catch (userError) {
        log.error("Failed to start tracking for user", { ...ctx, user: username }, userError);
        scanResults.errors++;
      }
    }

    if (usersStarted.length > 0) {
      log.debug("Started tracking users", { ...ctx, users: usersStarted.join(", ") });
    }
  } catch (error) {
    log.error("Channel scan failed", ctx, error);
    scanResults.errors++;
  }
}
