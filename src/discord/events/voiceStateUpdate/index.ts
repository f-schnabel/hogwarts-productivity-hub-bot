import { ChannelType, GuildMember, type VoiceState } from "discord.js";
import { db, ensureUserExists } from "@/db/db.ts";
import { endVoiceSession, startVoiceSession } from "./voiceSession.ts";
import { wrapWithAlerting } from "@/discord/utils/alerting.ts";
import { voiceSessionExecutionTimer } from "@/common/logging/monitoring.ts";
import { createLogger } from "@/common/logging/logger.ts";
import type { VoiceSession } from "@/common/types.ts";
import { announceYearPromotion, calculateYearRoles } from "./yearRole.ts";
import { updateMember } from "@/discord/utils/updateMember.ts";
import { VCEmojiNeedsAdding, VCEmojiNeedsRemoval } from "../../core/nicknameVC.ts";
import { VCRoleNeedsAdding, VCRoleNeedsRemoval } from "@/discord/core/roleVC.ts";

const log = createLogger("Voice");

const EXCLUDE_VOICE_CHANNEL_IDS = process.env.EXCLUDE_VOICE_CHANNEL_IDS?.split(",") ?? [];

export async function execute(oldState: VoiceState, newState: VoiceState) {
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) return; // Ignore bots

  const end = voiceSessionExecutionTimer.startTimer();
  const start = Date.now();
  const discordId = member.id;
  const username = member.user.username;
  const oldChannel = oldState.channel;
  const newChannel = newState.channel;

  // Check if channels should be excluded (excluded IDs + stage channels)
  const isExcluded = (ch: typeof oldChannel) =>
    ch === null || EXCLUDE_VOICE_CHANNEL_IDS.includes(ch.id) || ch.type === ChannelType.GuildStageVoice;
  const oldChannelExcluded = isExcluded(oldChannel);
  const newChannelExcluded = isExcluded(newChannel);

  // Ignore updates that don't involve tracked channels
  if (oldChannelExcluded && newChannelExcluded) {
    log.debug("Ignored excluded channel update", {
      userId: discordId,
      user: username,
      from: oldChannel?.name ?? "none",
      to: newChannel?.name ?? "none",
    });
    return;
  }

  const ctx = {
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
  await wrapWithAlerting(async () => {
    // User joined a tracked voice channel (from excluded/none)
    if (oldChannelExcluded && !newChannelExcluded) {
      event = "join";
      await join(newVoiceSession, member);
    } else if (!oldChannelExcluded && newChannelExcluded) {
      // User left a tracked voice channel (to excluded/none)
      event = "leave";
      await leave(oldVoiceSession, member);
    } else if (!oldChannelExcluded && !newChannelExcluded && oldVoiceSession.channelId !== newVoiceSession.channelId) {
      // User switched between tracked voice channels
      event = "switch";
      await vcSwitch(oldVoiceSession, newVoiceSession, member);
    }
  }, `Voice state update for ${username} (${discordId})`);

  log.info("Completed", { ...ctx, event, ms: Date.now() - start });
  end({ event });
}

export async function join(newVoiceSession: VoiceSession, member: GuildMember) {
  const [, nickname, vcRole] = await Promise.all([
    startVoiceSession(newVoiceSession, db),
    VCEmojiNeedsAdding(member),
    VCRoleNeedsAdding(member),
  ]);
  await updateMember({
    member,
    nickname,
    reason: "User joined voice channel",
    roleUpdates: {
      rolesToAdd: vcRole,
    },
  });
}

async function leave(oldVoiceSession: VoiceSession, member: GuildMember) {
  const [user, nickname, vcRole] = await Promise.all([
    endVoiceSession(oldVoiceSession, db),
    VCEmojiNeedsRemoval(member),
    VCRoleNeedsRemoval(member),
  ]);

  const { rolesToRemove = [], rolesToAdd } = calculateYearRoles(member, user) ?? {};

  await Promise.all([
    updateMember({
      member,
      reason: "User left voice channel",
      nickname,
      roleUpdates: {
        rolesToAdd,
        rolesToRemove: rolesToRemove.concat(vcRole),
      },
    }),
    announceYearPromotion(member, user),
  ]);
}

async function vcSwitch(oldVoiceSession: VoiceSession, newVoiceSession: VoiceSession, member: GuildMember) {
  const user = await endVoiceSession(oldVoiceSession, db);

  await Promise.all([
    updateMember({
      member,
      reason: "User switched voice channel",
      roleUpdates: calculateYearRoles(member, user),
    }),
    startVoiceSession(newVoiceSession, db),
    announceYearPromotion(member, user),
  ]);
}
