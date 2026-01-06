import { type VoiceState } from "discord.js";
import { db, ensureUserExists } from "../db/db.ts";
import { endVoiceSession, startVoiceSession } from "../utils/voiceUtils.ts";
import { wrapWithAlerting } from "../utils/alerting.ts";
import { voiceSessionExecutionTimer } from "../monitoring.ts";
import { createLogger, OpId } from "../utils/logger.ts";

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

  await wrapWithAlerting(
    async () => {
      // User joined a voice channel
      if (!oldChannel && newChannel) {
        event = "join";
        await startVoiceSession(newVoiceSession, db, opId);
      } else if (oldChannel && !newChannel) {
        event = "leave";
        await endVoiceSession(oldVoiceSession, db, opId, true, member);
      } else if (oldChannel && newChannel && oldChannel.id !== newChannel.id) {
        event = "switch";
        // For channel switches, end the old session and start new one immediately
        await endVoiceSession(oldVoiceSession, db, opId, true, member);
        await startVoiceSession(newVoiceSession, db, opId);
      }
    },
    `Voice state update for ${username} (${discordId})`,
    opId,
  );

  log.info("Completed", { ...ctx, event, ms: Date.now() - start });
  end({ event });
}
