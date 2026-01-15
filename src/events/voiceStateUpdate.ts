import { GuildMember, type GuildMemberEditOptions, type VoiceState } from "discord.js";
import { db, ensureUserExists } from "../db/db.ts";
import { endVoiceSession, startVoiceSession } from "../utils/voiceUtils.ts";
import { wrapWithAlerting } from "../utils/alerting.ts";
import { voiceSessionExecutionTimer } from "../monitoring.ts";
import { createLogger, OpId } from "../utils/logger.ts";
import { VCEmojiNeedsAdding, VCEmojiNeedsRemoval } from "../utils/nicknameUtils.ts";
import { VCRoleNeedsAdding, VCRoleNeedsRemoval } from "../utils/roleUtils.ts";
import type { VoiceSession } from "../types.ts";
import { announceYearPromotion, calculateYearRoles } from "../utils/yearRoleUtils.ts";

const log = createLogger("VoiceEvent");

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
      // User joined a voice channel
      if (!oldChannel && newChannel) {
        event = "join";
        await join(newVoiceSession, member, opId);
      } else if (oldChannel && !newChannel) {
        event = "leave";
        await leave(oldVoiceSession, member, opId);
      } else if (oldChannel && newChannel && oldChannel.id !== newChannel.id) {
        event = "switch";
        await vcSwitch(oldVoiceSession, newVoiceSession, member, opId);
      }
    },
    `Voice state update for ${username} (${discordId})`,
    opId,
  );

  log.info("Completed", { ...ctx, event, ms: Date.now() - start });
  end({ event });
}

export async function join(newVoiceSession: VoiceSession, member: GuildMember, opId: string) {
  const ctx = { opId, userId: member.id, username: member.user.username };

  const [, nickname, vcRole] = await Promise.all([
    startVoiceSession(newVoiceSession, db, opId),
    VCEmojiNeedsAdding(ctx, member),
    VCRoleNeedsAdding(ctx, member),
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

export async function leave(oldVoiceSession: VoiceSession, member: GuildMember, opId: string) {
  const ctx = { opId, userId: member.id, username: member.user.username };

  const [user, nickname, vcRole] = await Promise.all([
    endVoiceSession(oldVoiceSession, db, opId),
    VCEmojiNeedsRemoval(ctx, member),
    VCRoleNeedsRemoval(ctx, member),
  ]);

  const { rolesToRemove = [], rolesToAdd: yearRolesToAdd } = calculateYearRoles(member, user) ?? {};

  await updateMember({
    member,
    reason: "User left voice channel",
    nickname,
    roleUpdates: {
      rolesToAdd: yearRolesToAdd,
      rolesToRemove: rolesToRemove.concat(vcRole),
    },
  });
  if (yearRolesToAdd && yearRolesToAdd.length > 0) {
    await announceYearPromotion(member, user, ctx);
  }
}

export async function vcSwitch(
  oldVoiceSession: VoiceSession,
  newVoiceSession: VoiceSession,
  member: GuildMember,
  opId: string,
) {
  const user = await endVoiceSession(oldVoiceSession, db, opId);
  await Promise.all([
    updateMember({
      member,
      reason: "User switched voice channel",
      roleUpdates: calculateYearRoles(member, user),
    }),
    startVoiceSession(newVoiceSession, db, opId),
  ]);
}

export interface UpdateMemberParams {
  member: GuildMember;
  reason?: string;
  nickname?: string | null;
  roleUpdates?: {
    rolesToAdd?: string[];
    rolesToRemove?: string[];
  } | null;
}

export async function updateMember({ member, reason, nickname, roleUpdates }: UpdateMemberParams) {
  const update: GuildMemberEditOptions = {};
  if (nickname !== null) update.nick = nickname;

  const rolesToAdd = roleUpdates?.rolesToAdd ?? [];
  const rolesToRemove = roleUpdates?.rolesToRemove ?? [];

  if (rolesToAdd.length > 0 || rolesToRemove.length > 0) {
    update.roles = [...member.roles.cache.keys().filter((r) => !rolesToRemove.includes(r)), ...rolesToAdd];
  }
  if (Object.keys(update).length === 0) return;

  if (reason) update.reason = reason;

  return member.edit(update);
}
