import { type VoiceState } from "discord.js";
import { db, ensureUserExists } from "../db/db.ts";
import { endVoiceSession, startVoiceSession } from "../utils/voiceUtils.ts";
import { wrapWithAlerting } from "../utils/alerting.ts";
import { voiceSessionExecutionTimer } from "../monitoring.ts";
import { createLogger, OpId } from "../utils/logger.ts";
import { getNicknameWithVCEmoji, getNicknameWithoutVCEmoji } from "../utils/nicknameUtils.ts";
import { getVCRoleToAdd, getVCRoleToRemove } from "../utils/roleUtils.ts";
import { applyMemberUpdates } from "../utils/memberUpdateUtils.ts";

const log = createLogger("VoiceEvent");

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

          // Batch nickname and role updates into a single member.edit() call
          const nickname = await getNicknameWithVCEmoji(opId, member);
          const roleToAdd = await getVCRoleToAdd(opId, member);
          await applyMemberUpdates(
            member,
            {
              nickname,
              rolesToAdd: roleToAdd ? [roleToAdd] : [],
              rolesToRemove: [],
            },
            "User joined voice channel",
            opId,
          );
        } else if (oldChannel && !newChannel) {
          event = "leave";
          const yearRoleChanges = await endVoiceSession(oldVoiceSession, db, opId, true, member);

          // Batch nickname and role updates into a single member.edit() call
          const nickname = await getNicknameWithoutVCEmoji(opId, member);
          const roleToRemove = await getVCRoleToRemove(opId, member);
          await applyMemberUpdates(
            member,
            {
              nickname,
              rolesToAdd: yearRoleChanges?.rolesToAdd ?? [],
              rolesToRemove: [...(roleToRemove ? [roleToRemove] : []), ...(yearRoleChanges?.rolesToRemove ?? [])],
            },
            "User left voice channel",
            opId,
          );

          // Announce year promotion if needed
          if (yearRoleChanges?.shouldAnnounce && yearRoleChanges.year !== null) {
            const user = await db.query.userTable.findFirst({
              where: (users, { eq }) => eq(users.discordId, discordId),
            });
            if (user?.house) {
              const { announceYearPromotion } = await import("../utils/yearRoleUtils.ts");
              await announceYearPromotion(member, user.house, yearRoleChanges.year, {
                opId,
                userId: discordId,
                username,
              });
            }
          }
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
