import cron from "node-cron";
import dayjs from "dayjs";
import { eq } from "drizzle-orm";
import { createLogger, OpId } from "@/common/logger.ts";
import { runWithOpContext } from "@/common/opContext.ts";
import { db } from "@/db/db.ts";
import { journalEntryTable } from "@/db/schema.ts";
import { client } from "@/discord/client.ts";
import { wrapWithAlerting } from "@/discord/utils/alerting.ts";

const log = createLogger("Journal");

const JOURNAL_STATIC_LINES = [
  "Sleep Rating: 0 (couldn't sleep) - 5 (good refreshing sleep)",
  "Mood rating: 😢 bad mood / 🫤  meh day / 😮‍💨  could have been better / 😊  happy mood",
  "Emotions: happy, excited, grateful, relaxed, content, tired, unsure, bored, anxious, sad, stressed (can be multiple)",
];

export type JournalDispatchResult = "sent" | "missing" | "already-sent";

interface JournalEntryRecord {
  id: number;
  prompt: string;
  messageId: string | null;
}

export interface JournalDispatchDeps {
  fetchEntryByDate: (date: string) => Promise<JournalEntryRecord | undefined>;
  saveMessageId: (id: number, messageId: string) => Promise<void>;
  fetchChannel: (channelId: string) => Promise<JournalChannel | null>;
}

interface JournalChannel {
  isTextBased: () => boolean;
  send: (payload: ReturnType<typeof buildJournalMessage>) => Promise<{ id: string }>;
}

const defaultDeps: JournalDispatchDeps = {
  async fetchEntryByDate(date: string) {
    const [entry] = await db.select().from(journalEntryTable).where(eq(journalEntryTable.date, date)).limit(1);
    return entry;
  },
  async saveMessageId(id: number, messageId: string) {
    await db.update(journalEntryTable).set({ messageId }).where(eq(journalEntryTable.id, id));
  },
  async fetchChannel(channelId: string) {
    const channel = await client.channels.fetch(channelId);
    if (!channel) return null;
    if (!channel.isTextBased()) return null;
    return channel as JournalChannel;
  },
};

export function start() {
  cron.schedule(
    "30 15 * * *",
    () => {
      void runWithOpContext(OpId.jrnl(), async () => {
        const result = await processTodayJournalEntry();
        log.info("Journal dispatch complete", { result, date: getJournalDate() });
      });
    },
    { timezone: "UTC" },
  );

  log.debug("JournalService started");
}

export async function processTodayJournalEntry(
  now: dayjs.Dayjs = dayjs.utc(),
  deps: JournalDispatchDeps = defaultDeps,
): Promise<JournalDispatchResult> {
  return await wrapWithAlerting(async () => {
    const date = getJournalDate(now);
    const entry = await deps.fetchEntryByDate(date);

    if (!entry) {
      log.debug("No journal entry configured", { date });
      return "missing";
    }

    if (entry.messageId) {
      log.debug("Journal entry already sent", { date, messageId: entry.messageId });
      return "already-sent";
    }

    const channelId = process.env["JOURNAL_CHANNEL_ID"];
    if (!channelId) {
      throw new Error("JOURNAL_CHANNEL_ID is not configured.");
    }

    const channel = await deps.fetchChannel(channelId);
    if (!channel?.isTextBased()) {
      throw new Error(`Journal channel ${channelId} was not found or is not text based.`);
    }

    const message = await channel.send(buildJournalMessage(entry.prompt));
    await deps.saveMessageId(entry.id, message.id);

    log.info("Journal entry sent", { date, messageId: message.id });
    return "sent";
  }, "Journal prompt dispatch");
}

export function getJournalDate(now: dayjs.Dayjs = dayjs.utc()): string {
  return now.utc().format("YYYY-MM-DD");
}

export function buildJournalMessage(prompt: string) {
  const body = [...JOURNAL_STATIC_LINES, `Prompt: ${prompt}`].join("\n");
  return {
    content: `**Daily Journal Check-In**\n\`\`\`\n${body}\n\`\`\``,
  };
}
