import { describe, expect, it, vi } from "vitest";

vi.unmock("discord.js");
vi.mock("@/db/db.ts", () => ({
  getUserTimezone: vi.fn().mockResolvedValue("UTC"),
}));

import { submissionMessage } from "@/discord/events/interactionCreate/submit/submissionMessage.ts";

const pendingNewSubmission = {
  id: 42,
  discordId: "user-id",
  submittedAt: new Date("2026-06-12T09:00:00Z"),
  reviewedAt: null,
  reviewedBy: null,
  reminderAt: null,
  messageId: "message-id",
  channelId: "channel-id",
  house: "Gryffindor" as const,
  houseId: 1,
  screenshotUrl: "https://example.com/screenshot.png",
  points: 5,
  submissionType: "NEW" as const,
  status: "PENDING" as const,
  linkedSubmissionId: null,
};

describe("submission reminder button", () => {
  it("shows reminder with pending review controls", async () => {
    const message = await submissionMessage({ submission: pendingNewSubmission, userTimezone: "UTC" });

    expect(getButtonIds(message.components)).toEqual([
      "submit|approve|42",
      "submit|reject|42",
      "submit|cancel|42",
      "submit|reminder|42",
    ]);
  });

  it("hides reminder after one is scheduled", async () => {
    const message = await submissionMessage({
      submission: { ...pendingNewSubmission, reminderAt: new Date("2026-06-12T12:00:00Z") },
      userTimezone: "UTC",
    });

    expect(getButtonIds(message.components)).toEqual([
      "submit|approve|42",
      "submit|reject|42",
      "submit|cancel|42",
    ]);
  });
});

function getButtonIds(components: unknown): string[] {
  const rows = components as { components: { toJSON(): { custom_id: string } }[] }[];
  return rows[0]?.components.map((button) => button.toJSON().custom_id) ?? [];
}
