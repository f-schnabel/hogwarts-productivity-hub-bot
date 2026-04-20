import { createLogger } from "@/common/logging/logger.ts";
import { db } from "@/db/db.ts";
import { journalEntryTable } from "@/db/schema.ts";
import { errorReply } from "@/discord/utils/interactionUtils.ts";
import { parseJournalCsv, serializeJournalCsv, validateJournalDate } from "@/services/journalCsv.ts";
import { buildJournalMessage, getJournalDate } from "@/services/journalService.ts";
import { AttachmentBuilder, type ChatInputCommandInteraction } from "discord.js";
import { asc } from "drizzle-orm";
import { eq, gte } from "drizzle-orm/sql/expressions/conditions";

const log = createLogger("Admin");

export async function journalSet(interaction: ChatInputCommandInteraction<"cached">) {
  const rawDate = interaction.options.getString("date", true);
  const prompt = interaction.options.getString("prompt", true);
  const date = validateJournalDate(rawDate);

  if (!date) {
    await errorReply(interaction, "Invalid Date", "Please use the YYYY-MM-DD format for the journal date.", {
      deferred: true,
    });
    return;
  }

  const [existing] = await db.select().from(journalEntryTable).where(eq(journalEntryTable.date, date)).limit(1);

  await db.insert(journalEntryTable).values({ date, prompt }).onConflictDoUpdate({
    target: journalEntryTable.date,
    set: {
      prompt,
    },
  });

  log.info("Journal entry upserted", { date, updated: Boolean(existing), userId: interaction.user.id });
  await interaction.editReply(`${existing ? "Updated" : "Created"} journal entry for ${date}.`);
}

export async function journalDelete(interaction: ChatInputCommandInteraction<"cached">) {
  const rawDate = interaction.options.getString("date", true);
  const date = validateJournalDate(rawDate);

  if (!date) {
    await errorReply(interaction, "Invalid Date", "Please use the YYYY-MM-DD format for the journal date.", {
      deferred: true,
    });
    return;
  }

  const deletedRows = await db.delete(journalEntryTable).where(eq(journalEntryTable.date, date)).returning({
    id: journalEntryTable.id,
  });

  if (deletedRows.length === 0) {
    await interaction.editReply(`No journal entry exists for ${date}.`);
    return;
  }

  log.info("Journal entry deleted", { date, userId: interaction.user.id });
  await interaction.editReply(`Deleted journal entry for ${date}.`);
}

export async function journalList(interaction: ChatInputCommandInteraction<"cached">) {
  const today = getJournalDate();
  const entries = await db
    .select({
      date: journalEntryTable.date,
      prompt: journalEntryTable.prompt,
    })
    .from(journalEntryTable)
    .where(gte(journalEntryTable.date, today))
    .orderBy(asc(journalEntryTable.date));

  if (entries.length === 0) {
    await interaction.editReply("No upcoming journal entries are configured.");
    return;
  }

  const lines = entries.map((entry) => {
    return `${entry.date} ${truncatePrompt(entry.prompt)}`;
  });

  await interaction.editReply(`Upcoming journal entries:\n${lines.join("\n")}`);
}

export async function journalExport(interaction: ChatInputCommandInteraction<"cached">) {
  const entries = await db
    .select({
      date: journalEntryTable.date,
      prompt: journalEntryTable.prompt,
    })
    .from(journalEntryTable)
    .orderBy(asc(journalEntryTable.date));

  const csv = serializeJournalCsv(entries);
  const attachment = new AttachmentBuilder(Buffer.from(csv, "utf8"), { name: "journal-entries.csv" });

  await interaction.editReply({
    content: `Exported ${entries.length} journal entr${entries.length === 1 ? "y" : "ies"}.`,
    files: [attachment],
  });
}

export async function journalImport(interaction: ChatInputCommandInteraction<"cached">) {
  try {
    const file = interaction.options.getAttachment("file", true);
    const response = await fetch(file.url);

    if (!response.ok) {
      throw new Error(`Failed to fetch journal CSV attachment: ${response.status} ${response.statusText}`);
    }

    const rows = parseJournalCsv(await response.text());
    await db.transaction(async (tx) => {
      for (const row of rows) {
        await tx
          .insert(journalEntryTable)
          .values(row)
          .onConflictDoUpdate({
            target: journalEntryTable.date,
            set: {
              prompt: row.prompt,
              updatedAt: new Date(),
            },
          });
      }
    });

    log.info("Journal CSV imported", { count: rows.length, userId: interaction.user.id });
    await interaction.editReply(`Imported ${rows.length} journal entr${rows.length === 1 ? "y" : "ies"}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown import error.";
    await errorReply(interaction, "Journal Import Failed", message, { deferred: true });
  }
}

export async function journalShow(interaction: ChatInputCommandInteraction<"cached">) {
  const rawDate = interaction.options.getString("date");
  const date = rawDate ? validateJournalDate(rawDate) : getJournalDate();

  if (!date) {
    await errorReply(interaction, "Invalid Date", "Please use the YYYY-MM-DD format for the journal date.", {
      deferred: true,
    });
    return;
  }

  const [entry] = await db.select().from(journalEntryTable).where(eq(journalEntryTable.date, date)).limit(1);

  if (!entry) {
    await interaction.editReply(`No journal entry configured for ${date}.`);
    return;
  }

  log.info("Journal entry previewed", { date, userId: interaction.user.id });
  await interaction.editReply(buildJournalMessage(entry.prompt));
}

function truncatePrompt(prompt: string, maxLength = 80): string {
  return prompt.length <= maxLength ? prompt : `${prompt.slice(0, maxLength - 3)}...`;
}
