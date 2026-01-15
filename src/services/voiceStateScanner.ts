/**
 * Voice State Scanner
 * Scans Discord voice states on bot startup and automatically starts tracking
 * for users already in voice channels. Resumes existing sessions if they're
 * less than 24 hours old, closes stale sessions for users no longer in voice.
 */

import { BaseGuildVoiceChannel, ChannelType, Collection, type Guild } from "discord.js";
import { closeVoiceSessionUntracked, endVoiceSession } from "../utils/voiceUtils.ts";
import { db, ensureUserExists } from "../db/db.ts";
import { voiceSessionTable } from "../db/schema.ts";
import { isNull } from "drizzle-orm";
import { createLogger, OpId } from "../utils/logger.ts";
import { getGuild } from "../events/clientReady.ts";
import { MAX_SESSION_AGE_MS } from "../utils/constants.ts";
import { join } from "../events/voiceStateUpdate.ts";

const log = createLogger("VoiceScan");

let isScanning = false;

interface OpenSession {
  discordId: string;
  channelId: string;
  channelName: string;
  joinedAt: Date;
}

interface ScanContext {
  opId: string;
  results: {
    totalUsersFound: number;
    trackingStarted: number;
    sessionsResumed: number;
    staleClosed: number;
    errors: number;
    channels: { id: string; name: string; userCount: number }[];
  };
}

function createScanContext(opId: string): ScanContext {
  return {
    opId,
    results: {
      totalUsersFound: 0,
      trackingStarted: 0,
      sessionsResumed: 0,
      staleClosed: 0,
      errors: 0,
      channels: [],
    },
  };
}

/**
 * Scan all voice channels and start tracking for users already in voice.
 * - Resumes existing sessions if user is still in voice and session < 24h old
 * - Closes stale sessions (user left or session > 24h old)
 * - Handles multiple open sessions per user (keeps newest valid, closes others)
 * - Starts new sessions for users without one
 */
export async function scanAndStartTracking(parentOpId?: string) {
  const opId = parentOpId ?? OpId.vcscan();

  if (isScanning) {
    log.warn("Scan already in progress, skipping", { opId });
    return;
  }

  isScanning = true;
  const ctx = createScanContext(opId);

  // Fetch all open sessions with their details
  const openSessions = await db
    .select({
      discordId: voiceSessionTable.discordId,
      channelId: voiceSessionTable.channelId,
      channelName: voiceSessionTable.channelName,
      joinedAt: voiceSessionTable.joinedAt,
    })
    .from(voiceSessionTable)
    .where(isNull(voiceSessionTable.leftAt));

  // Group sessions by user (there may be multiple due to crashes)
  const openSessionsByUser = new Map<string, OpenSession[]>();
  for (const s of openSessions) {
    const existing = openSessionsByUser.get(s.discordId) ?? [];
    existing.push(s);
    openSessionsByUser.set(s.discordId, existing);
  }

  try {
    // Collect all users currently in voice channels
    const usersInVoice = new Set<string>();

    const guild = getGuild();
    await scanGuildVoiceStates(ctx, guild, openSessionsByUser, usersInVoice);

    // Close stale sessions: users with open sessions who are not in voice
    await closeStaleSessionsForMissingUsers(ctx, openSessionsByUser, usersInVoice);

    log.info("Scan complete", {
      opId,
      usersFound: ctx.results.totalUsersFound,
      trackingStarted: ctx.results.trackingStarted,
      sessionsResumed: ctx.results.sessionsResumed,
      staleClosed: ctx.results.staleClosed,
      errors: ctx.results.errors,
      channels: ctx.results.channels.map((c) => `${c.name}:${c.userCount}`).join(", ") || "none",
    });
  } catch (error) {
    log.error("Scan failed", { opId }, error);
    ctx.results.errors++;
  } finally {
    isScanning = false;
  }
}

/**
 * Close sessions for users who have an open session but are no longer in voice.
 * All sessions for missing users are closed.
 */
async function closeStaleSessionsForMissingUsers(
  ctx: ScanContext,
  openSessionsByUser: Map<string, OpenSession[]>,
  usersInVoice: Set<string>,
) {
  const now = Date.now();

  for (const [discordId, sessions] of openSessionsByUser) {
    if (usersInVoice.has(discordId)) continue; // User is still in voice, handled elsewhere

    // Close all sessions for this user
    for (const session of sessions) {
      const sessionAge = now - session.joinedAt.getTime();
      const sessionToClose = {
        discordId,
        username: "unknown", // We don't have username here, but it's only for logging
        channelId: session.channelId,
        channelName: session.channelName,
      };

      try {
        if (sessionAge > MAX_SESSION_AGE_MS) {
          await closeVoiceSessionUntracked(sessionToClose, db, ctx.opId);
        } else {
          await endVoiceSession(sessionToClose, db, ctx.opId);
        }
        ctx.results.staleClosed++;
        log.debug("Closed stale session", {
          opId: ctx.opId,
          userId: discordId,
          channel: session.channelName,
          ageHours: Math.round(sessionAge / 1000 / 60 / 60),
          tracked: sessionAge <= MAX_SESSION_AGE_MS,
        });
      } catch (error) {
        log.error("Failed to close stale session", { opId: ctx.opId, userId: discordId }, error);
        ctx.results.errors++;
      }
    }
  }
}

/**
 * Scan voice states for a specific guild
 */
async function scanGuildVoiceStates(
  ctx: ScanContext,
  guild: Guild,
  openSessionsByUser: Map<string, OpenSession[]>,
  usersInVoice: Set<string>,
) {
  try {
    // Get all voice channels in the guild
    const voiceChannels = guild.channels.cache.filter(
      (channel) =>
        channel.type === ChannelType.GuildVoice && // Voice channel type
        channel.members.size > 0, // Has members
    ) as Collection<string, BaseGuildVoiceChannel>;

    for (const [, channel] of voiceChannels) {
      await scanVoiceChannel(ctx, channel, openSessionsByUser, usersInVoice);
    }
  } catch (error) {
    log.error("Guild scan failed", { opId: ctx.opId, guild: guild.name }, error);
    ctx.results.errors++;
  }
}

/**
 * Scan a specific voice channel and start tracking for users.
 * For users with multiple open sessions, keeps the newest valid one and closes others.
 */
async function scanVoiceChannel(
  ctx: ScanContext,
  channel: BaseGuildVoiceChannel,
  openSessionsByUser: Map<string, OpenSession[]>,
  usersInVoice: Set<string>,
) {
  const logCtx = { opId: ctx.opId, channel: channel.name };
  const now = Date.now();

  try {
    const members = channel.members;

    // Add to scan results
    ctx.results.channels.push({
      id: channel.id,
      name: channel.name,
      userCount: members.size,
    });

    const usersStarted = [];
    const usersResumed = [];

    for (const [discordId, member] of members) {
      const username = member.user.username;
      try {
        // Skip bots
        if (member.user.bot) {
          continue;
        }

        ctx.results.totalUsersFound++;
        usersInVoice.add(discordId);

        const existingSessions = openSessionsByUser.get(discordId) ?? [];

        if (existingSessions.length > 0) {
          // Sort by joinedAt descending (newest first)
          existingSessions.sort((a, b) => b.joinedAt.getTime() - a.joinedAt.getTime());

          // Find the newest valid session (< 24h old)
          let validSession: OpenSession | null = null;
          for (const session of existingSessions) {
            const sessionAge = now - session.joinedAt.getTime();
            if (sessionAge <= MAX_SESSION_AGE_MS) {
              validSession = session;
              break;
            }
          }

          // Close all sessions except the valid one (if found)
          for (const session of existingSessions) {
            if (session === validSession) continue; // Keep this one

            const sessionAge = now - session.joinedAt.getTime();
            const sessionToClose = {
              discordId,
              username,
              channelId: session.channelId,
              channelName: session.channelName,
            };
            if (sessionAge > MAX_SESSION_AGE_MS) {
              await closeVoiceSessionUntracked(sessionToClose, db, ctx.opId);
            } else {
              await endVoiceSession(sessionToClose, db, ctx.opId);
            }

            ctx.results.staleClosed++;
          }

          if (validSession !== null) {
            // Valid session found - resume it (keep it open)
            ctx.results.sessionsResumed++;
            usersResumed.push(username);
            continue;
          }
          // All sessions were stale, start fresh below
        }

        await ensureUserExists(member, discordId, username);

        // Start voice session for this user
        await join(
          {
            discordId,
            username,
            channelId: channel.id,
            channelName: channel.name,
          },
          member,
          ctx.opId,
        );

        ctx.results.trackingStarted++;
        usersStarted.push(username);
      } catch (userError) {
        log.error("Failed to start tracking for user", { ...logCtx, user: username }, userError);
        ctx.results.errors++;
      }
    }

    if (usersStarted.length > 0) {
      log.debug("Started tracking users", { ...logCtx, users: usersStarted.join(", ") });
    }
    if (usersResumed.length > 0) {
      log.debug("Resumed sessions for users", { ...logCtx, users: usersResumed.join(", ") });
    }
  } catch (error) {
    log.error("Channel scan failed", logCtx, error);
    ctx.results.errors++;
  }
}
