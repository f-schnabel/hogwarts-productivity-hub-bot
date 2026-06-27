import { describe, expect, it, vi } from "vitest";
import {
  buildExplanationPrompt,
  buildYearAnnouncementPrompt,
  DEFAULT_OPENROUTER_MODEL,
  generateExplanation,
  generateYearAnnouncement,
  getOpenRouterModel,
  sanitizeAnnouncementContent,
  sanitizeExplanationContent,
} from "@/services/openRouterService.ts";

const request = {
  house: "Ravenclaw" as const,
  roleMention: "<@&year3>",
  hours: "20 hours",
  year: 3,
  username: "Luna",
};

describe("openRouterService", () => {
  it("builds house-specific year announcement prompts", () => {
    const prompt = buildYearAnnouncementPrompt(request);

    expect(prompt).toContain("House: Ravenclaw");
    expect(prompt).toContain("New activity rank: <@&year3>");
    expect(prompt).toContain("Monthly voice-study milestone: 20 hours");
    expect(prompt).toContain("warm Ravenclaw style");
  });

  it("builds Hogwarts-style explanation prompts", () => {
    const prompt = buildExplanationPrompt({
      question: "What is spaced repetition?",
      username: "Hermione",
    });

    expect(prompt).toContain("Question: What is spaced repetition?");
    expect(prompt).toContain("light Hogwarts classroom flavor");
    expect(prompt).toContain("Do not pretend to be a Harry Potter character");
  });

  it("sanitizes explanation content while preserving paragraph breaks", () => {
    const content = sanitizeExplanationContent(
      `  First   paragraph.\n\n\nSecond\tparagraph. ${"x".repeat(2000)}`,
    );

    expect(content).toContain("First paragraph.\n\nSecond paragraph.");
    expect(content).toHaveLength(1900);
  });

  it("sanitizes long, whitespace-heavy announcement content", () => {
    const content = sanitizeAnnouncementContent(
      `  Great\n\twork   ${"x".repeat(1000)}`,
    );

    expect(content.startsWith("Great work")).toBe(true);
    expect(content).toHaveLength(900);
  });

  it("defaults to a free OpenRouter model", () => {
    vi.stubEnv("OPENROUTER_MODEL", "");

    expect(getOpenRouterModel()).toBe(DEFAULT_OPENROUTER_MODEL);
  });

  it("returns sanitized year announcement content from OpenRouter", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: "  Well done, Ravenclaw!\nYou earned it. ",
                },
              },
            ],
          }),
      }),
    );

    await expect(generateYearAnnouncement(request)).resolves.toBe(
      "Well done, Ravenclaw! You earned it.",
    );
  });

  it("returns sanitized explanation content from OpenRouter", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: "  Think of it like a study spell.\n\nReview it again later. ",
                },
              },
            ],
          }),
      }),
    );

    await expect(
      generateExplanation({ question: "What is spaced repetition?", username: "Luna" }),
    ).resolves.toBe("Think of it like a study spell.\n\nReview it again later.");
  });
});
