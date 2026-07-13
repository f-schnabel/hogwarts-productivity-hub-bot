import { describe, expect, it, vi } from "vitest";
import type { DbOrTx } from "@/db/db.ts";
import {
  endVoiceSession,
  startVoiceSession,
  updateVoiceSessionChannel,
} from "@/discord/events/voiceStateUpdate/voiceSession.ts";

const session = {
  discordId: "user-1",
  username: "Hermione",
  channelId: "study",
  channelName: "Study Room",
};

describe("voice session continuity", () => {
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

  it("starts a reset session at the supplied boundary", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const transactionDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
      insert: vi.fn().mockReturnValue({ values }),
    };
    const db = {
      transaction: vi.fn(async (callback: (tx: typeof transactionDb) => Promise<void>) => callback(transactionDb)),
    } as unknown as DbOrTx;
    const boundary = new Date("2026-06-21T18:30:00.000Z");

    await startVoiceSession(session, db, "new", boundary);

    expect(values).toHaveBeenCalledWith({
      discordId: "user-1",
      channelId: "study",
      channelName: "Study Room",
      joinedAt: boundary,
    });
  });

  it("ends a reset session at the supplied boundary", async () => {
    const firstReturning = vi.fn().mockResolvedValue([{ id: 42, duration: 0 }]);
    const secondReturning = vi.fn().mockResolvedValue([
      { dailyVoiceTime: 0, monthlyVoiceTime: 0, house: null, announcedYear: 0 },
    ]);
    const set = vi.fn()
      .mockReturnValueOnce({ where: vi.fn().mockReturnValue({ returning: firstReturning }) })
      .mockReturnValueOnce({ where: vi.fn().mockReturnValue({ returning: secondReturning }) })
      .mockReturnValueOnce({ where: vi.fn().mockResolvedValue(undefined) });
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
      transaction: vi.fn(async (callback: (tx: typeof transactionDb) => Promise<unknown>) => callback(transactionDb)),
    } as unknown as DbOrTx;
    const boundary = new Date("2026-06-21T18:30:00.000Z");

    await endVoiceSession(session, db, boundary);

    expect(set).toHaveBeenNthCalledWith(1, { leftAt: boundary, isTracked: true });
  });
});
