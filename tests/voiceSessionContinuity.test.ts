import { describe, expect, it, vi } from "vitest";
import type { DbOrTx } from "@/db/db.ts";
import {
  endVoiceSession,
  getMonthlyVoiceTimeWithOpenSession,
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
    const boundary = new Date("2026-06-21T18:30:00.000Z");
    const firstReturning = vi.fn().mockResolvedValue([{ id: 42, duration: 0 }]);
    const secondReturning = vi.fn().mockResolvedValue([
      { dailyVoiceTime: 0, monthlyVoiceTime: 0, house: null, announcedYear: 0, lastDailyReset: boundary },
    ]);
    const set = vi.fn()
      .mockReturnValueOnce({ where: vi.fn().mockReturnValue({ returning: firstReturning }) })
      .mockReturnValueOnce({ where: vi.fn().mockReturnValue({ returning: secondReturning }) })
      .mockReturnValueOnce({ where: vi.fn().mockResolvedValue(undefined) });
    const transactionDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          // Open session lookup (`.for(...)`), or the month start setting (awaited directly)
          where: vi.fn().mockReturnValue(
            Object.assign(Promise.resolve([]), { for: vi.fn().mockResolvedValue([{ id: 42 }]) }),
          ),
        }),
      }),
      update: vi.fn().mockReturnValue({ set }),
    };
    const db = {
      transaction: vi.fn(async (callback: (tx: typeof transactionDb) => Promise<unknown>) => callback(transactionDb)),
    } as unknown as DbOrTx;

    await endVoiceSession(session, db, boundary);

    expect(set).toHaveBeenNthCalledWith(1, { leftAt: boundary, isTracked: true });
  });
});

describe("getMonthlyVoiceTimeWithOpenSession", () => {
  const mockDb = (rows: unknown[]) =>
    ({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
            }),
          }),
        }),
      }),
    }) as unknown as DbOrTx;

  it("adds the open session's time to the monthly voice time", async () => {
    const now = new Date("2026-10-01T10:00:00.000Z");
    const db = mockDb([
      {
        monthlyVoiceTime: 1800,
        house: "Gryffindor",
        announcedYear: 0,
        openSessionJoinedAt: new Date("2026-10-01T09:30:00.000Z"),
      },
    ]);

    await expect(getMonthlyVoiceTimeWithOpenSession(db, "user-1", now)).resolves.toEqual({
      monthlyVoiceTime: 3600,
      house: "Gryffindor",
      announcedYear: 0,
    });
  });

  it("returns the stored monthly voice time without an open session", async () => {
    const db = mockDb([{ monthlyVoiceTime: 1800, house: null, announcedYear: 0, openSessionJoinedAt: null }]);

    await expect(getMonthlyVoiceTimeWithOpenSession(db, "user-1")).resolves.toEqual({
      monthlyVoiceTime: 1800,
      house: null,
      announcedYear: 0,
    });
  });
});
