import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import { describe, expect, it, vi } from "vitest";
import { buildJournalMessage, processTodayJournalEntry } from "../src/services/journalService.ts";

dayjs.extend(utc);

describe("buildJournalMessage", () => {
  it("includes the fixed journal template and prompt", () => {
    const message = buildJournalMessage("Write about a comforting song.");

    expect(message.embeds[0]?.title).toBe("Daily Journal Check-In");
    expect(message.embeds[0]?.description).toContain("Sleep Rating: 0 (couldn't sleep) - 5 (good refreshing sleep)");
    expect(message.embeds[0]?.description).toContain("Mood rating:");
    expect(message.embeds[0]?.description).toContain("Emotions:");
    expect(message.embeds[0]?.description).toContain("Prompt: Write about a comforting song.");
  });
});

describe("processTodayJournalEntry", () => {
  it("skips when no entry exists for today", async () => {
    const result = await processTodayJournalEntry(dayjs.utc("2026-04-01T15:30:00Z"), {
      fetchEntryByDate: vi.fn().mockResolvedValue(undefined),
      saveMessageId: vi.fn(),
      fetchChannel: vi.fn(),
    });

    expect(result).toBe("missing");
  });

  it("skips when today's entry was already sent", async () => {
    const fetchChannel = vi.fn();

    const result = await processTodayJournalEntry(dayjs.utc("2026-04-01T15:30:00Z"), {
      fetchEntryByDate: vi.fn().mockResolvedValue({
        id: 1,
        prompt: "Prompt",
        messageId: "already-sent",
      }),
      saveMessageId: vi.fn(),
      fetchChannel,
    });

    expect(result).toBe("already-sent");
    expect(fetchChannel).not.toHaveBeenCalled();
  });

  it("sends today's entry and stores the message id", async () => {
    const send = vi.fn().mockResolvedValue({ id: "discord-message-id" });
    const saveMessageId = vi.fn();

    const result = await processTodayJournalEntry(dayjs.utc("2026-04-01T15:30:00Z"), {
      fetchEntryByDate: vi.fn().mockResolvedValue({
        id: 42,
        prompt: "Be kind to yourself today.",
        messageId: null,
      }),
      saveMessageId,
      fetchChannel: vi.fn().mockResolvedValue({
        isTextBased: () => true,
        send,
      }),
    });

    expect(result).toBe("sent");
    expect(send).toHaveBeenCalledOnce();
    expect(saveMessageId).toHaveBeenCalledWith(42, "discord-message-id");
  });
});
