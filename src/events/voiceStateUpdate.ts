import { type VoiceState } from "discord.js";
import { db, ensureUserExists } from "../db/db.ts";
import { endVoiceSession, startVoiceSession } from "../utils/voiceUtils.ts";
import { wrapWithAlerting } from "../utils/alerting.ts";
import { voiceSessionExecutionTimer } from "../monitoring.ts";

export async function execute(oldState: VoiceState, newState: VoiceState) {
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) return; // Ignore bots

  const end = voiceSessionExecutionTimer.startTimer();

  const discordId = member.id;
  const username = member.user.username;
  const oldChannel = oldState.channel;
  const newChannel = newState.channel;

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

  console.debug(
    "+".repeat(5) + ` Voice state update for ${username} (${oldChannel?.name ?? ""} -> ${newChannel?.name ?? ""})`,
  );
  await ensureUserExists(member, discordId, username);
  let event = "unknown";

  await wrapWithAlerting(async () => {
    // User joined a voice channel
    if (!oldChannel && newChannel) {
      await startVoiceSession(newVoiceSession, db);
      event = "join";
    } else if (oldChannel && !newChannel) {
      await endVoiceSession(oldVoiceSession, db, true, member);
      event = "leave";
    } else if (oldChannel && newChannel && oldChannel.id !== newChannel.id) {
      // For channel switches, end the old session and start new one immediately
      await endVoiceSession(oldVoiceSession, db, true, member);
      await startVoiceSession(newVoiceSession, db);
      event = "switch";
    }
  }, `Voice state update for ${username} (${discordId})`);

  console.debug("-".repeat(5));
  end({ event });
}
