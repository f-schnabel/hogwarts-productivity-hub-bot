import { GuildMember, type VoiceState } from "discord.js";
import { db, ensureUserExists, getVCEmoji } from "../db/db.ts";
import { endVoiceSession, startVoiceSession } from "../utils/voiceUtils.ts";
import { alertOwner, wrapWithAlerting } from "../utils/alerting.ts";
import { voiceSessionExecutionTimer } from "../monitoring.ts";
import { createLogger, OpId } from "../utils/logger.ts";
import { hasAnyRole } from "../utils/roleUtils.ts";
import { Role } from "../utils/constants.ts";

const log = createLogger("VoiceEvent");
const VC_ROLE_ID = process.env.VC_ROLE_ID;

// Per-user locks to serialize voice events and prevent race conditions on fast channel switches
const userLocks = new Map<string, Promise<void>>();

async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const existingLock = userLocks.get(userId) ?? Promise.resolve();
  let resolve: (() => void) | undefined;
  const newLock = new Promise<void>((r) => (resolve = r));
  userLocks.set(userId, newLock);

  try {
    await existingLock;
    return await fn();
  } finally {
    if (resolve) resolve();
    // Clean up if this is still the current lock
    if (userLocks.get(userId) === newLock) {
      userLocks.delete(userId);
    }
  }
}

export async function execute(oldState: VoiceState, newState: VoiceState) {
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) return; // Ignore bots

  const end = voiceSessionExecutionTimer.startTimer();
  const start = Date.now();
  const opId = OpId.vc();

  const discordId = member.id;
  const username = member.user.username;
  const oldChannel = oldState.channel;
  const newChannel = newState.channel;

  const ctx = {
    opId,
    userId: discordId,
    user: username,
    ...(oldChannel && { from: oldChannel.name }),
    ...(newChannel && { to: newChannel.name }),
  };

  const oldVoiceSession = {
    discordId,
    username,
    channelId: oldChannel?.id ?? null,
    channelName: oldChannel?.name ?? null,
  };
  const newVoiceSession = {
    discordId,
    username,
    channelId: newChannel?.id ?? null,
    channelName: newChannel?.name ?? null,
  };

  log.debug("Received", ctx);
  await ensureUserExists(member, discordId, username);
  let event = "unknown";

  // Serialize voice events per user to prevent race conditions on fast channel switches
  await wrapWithAlerting(
    async () => {
      await withUserLock(discordId, async () => {
        // User joined a voice channel
        if (!oldChannel && newChannel) {
          event = "join";
          await startVoiceSession(newVoiceSession, db, opId);
          await addVCEmoji(opId, member);
          await addVCRole(opId, member);
        } else if (oldChannel && !newChannel) {
          event = "leave";
          await endVoiceSession(oldVoiceSession, db, opId, true, member);
          await removeVCEmoji(opId, member);
          await removeVCRole(opId, member);
        } else if (oldChannel && newChannel && oldChannel.id !== newChannel.id) {
          event = "switch";
          // For channel switches, end the old session and start new one immediately
          await endVoiceSession(oldVoiceSession, db, opId, true, member);
          await startVoiceSession(newVoiceSession, db, opId);
        }
      });
    },
    `Voice state update for ${username} (${discordId})`,
    opId,
  );

  log.info("Completed", { ...ctx, event, ms: Date.now() - start });
  end({ event });
}

async function addVCEmoji(opId: string, member: GuildMember) {
  if (hasAnyRole(member, Role.PROFESSOR)) return;
  const emoji = await getVCEmoji();
  try {
    const newNickname = member.displayName + " " + emoji;
    if (newNickname.length > 32) return;
    await member.setNickname(newNickname);
  } catch (error) {
    log.warn("Failed to add VC emoji", { opId, userId: member.id, error });
    await alertOwner(
      "Failed to add VC emoji for " + member.id + ": " + (error instanceof Error ? error.message : String(error)),
      opId,
    );
  }
}

async function removeVCEmoji(opId: string, member: GuildMember) {
  if (hasAnyRole(member, Role.PROFESSOR)) return;
  try {
    const emoji = await getVCEmoji();
    if (!member.nickname?.includes(" " + emoji)) return;

    const newNickname = member.nickname.replaceAll(" " + emoji, "");
    if (newNickname.length === 0) return;
    await member.setNickname(newNickname);
  } catch (error) {
    log.warn("Failed to remove VC emoji", { opId, userId: member.id, error });
    await alertOwner(
      "Failed to remove VC emoji for " + member.id + ": " + (error instanceof Error ? error.message : String(error)),
      opId,
    );
  }
}

async function addVCRole(opId: string, member: GuildMember) {
  try {
    const role = await member.guild.roles.fetch(VC_ROLE_ID);
    if (!role) {
      await alertOwner("VC role not found: " + VC_ROLE_ID, opId);
      return;
    }

    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role, "User joined voice channel");
    }
  } catch (error) {
    log.warn("Failed to add VC role", { opId, userId: member.id, error });
    await alertOwner(
      "Failed to add VC role for " + member.id + ": " + (error instanceof Error ? error.message : String(error)),
      opId,
    );
  }
}

async function removeVCRole(opId: string, member: GuildMember) {
  try {
    const role = await member.guild.roles.fetch(VC_ROLE_ID);
    if (!role) {
      await alertOwner("VC role not found: " + VC_ROLE_ID, opId);
      return;
    }

    if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role, "User left voice channel");
    }
  } catch (error) {
    // Log but do not alert owner on role removal failures
    log.warn("Failed to remove VC role", { opId, userId: member.id, error });
    await alertOwner(
      "Failed to remove VC role for " + member.id + ": " + (error instanceof Error ? error.message : String(error)),
      opId,
    );
  }
}
