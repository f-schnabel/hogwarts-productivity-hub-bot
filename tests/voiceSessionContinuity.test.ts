import { describe, expect, it, vi } from "vitest";
import type { DbOrTx } from "@/db/db.ts";
import { updateVoiceSessionChannel } from "@/discord/events/voiceStateUpdate/voiceSession.ts";

describe("updateVoiceSessionChannel", () => {
  it("updates the only open session instead of closing it", async () => {
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockReturnValue({ where: updateWhere });
    const transactionDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            for: vi.fn().mockResolvedValue([{ id: 42 }]),
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({ set }),
    };
    const db = {
      transaction: vi.fn(async (callback: (tx: typeof transactionDb) => Promise<boolean>) => callback(transactionDb)),
    } as unknown as DbOrTx;

    const updated = await updateVoiceSessionChannel(
      { discordId: "user-1", username: "Hermione", channelId: "create", channelName: "Create A Channel" },
      { discordId: "user-1", username: "Hermione", channelId: "study", channelName: "Study Room" },
      db,
    );

    expect(updated).toBe(true);
    expect(set).toHaveBeenCalledWith({ channelId: "study", channelName: "Study Room" });
    expect(transactionDb.update).toHaveBeenCalledTimes(1);
  });
});
