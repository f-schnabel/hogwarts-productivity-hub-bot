import { describe, expect, it, vi } from "vitest";
import {
  buildExplanationPrompt,
  buildYearAnnouncementPrompt,
  DEFAULT_OPENROUTER_MODEL,
  generateExplanation,
  generateYearAnnouncement,
  getOpenRouterModel,
  OpenRouterError,
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

  it("builds direct explanation prompts", () => {
    const prompt = buildExplanationPrompt({
      question: "What is spaced repetition?",
      username: "Hermione",
    });

    expect(prompt).toContain("Question: What is spaced repetition?");
    expect(prompt).toContain("direct, helpful tone without roleplay or themed flavor");
    expect(prompt).toContain("Do not use tables");
    expect(prompt).toContain("Do not repeat the question in the response");
  });

  it("sanitizes explanation content while preserving paragraph breaks", () => {
    const content = sanitizeExplanationContent("  First   paragraph.\n\n\nSecond\tparagraph. ");

    expect(content).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it("marks overlong explanation content as shortened instead of silently cutting off", () => {
    const longContent = `First sentence. Second sentence. ${"x".repeat(5000)}`;
    const content = sanitizeExplanationContent(longContent);

    expect(content).toHaveLength(4000);
    expect(content).toContain("response shortened to fit Discord");
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
            model: "test/free-model",
            choices: [
              {
                message: {
                  content: "  Review the idea once, then revisit it later.\n\nSpace reviews out over time. ",
                },
              },
            ],
          }),
      }),
    );

    await expect(
      generateExplanation({ question: "What is spaced repetition?", username: "Luna" }),
    ).resolves.toEqual({
      content: "Review the idea once, then revisit it later.\n\nSpace reviews out over time.",
      model: "test/free-model",
    });
  });

  it("falls back to the requested model when the response omits a model", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("OPENROUTER_MODEL", "custom/requested-model");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: "Fallback model label.",
                },
              },
            ],
          }),
      }),
    );

    await expect(
      generateExplanation({ question: "What is spaced repetition?", username: "Luna" }),
    ).resolves.toEqual({
      content: "Fallback model label.",
      model: "custom/requested-model",
    });
  });

  it("throws OpenRouterError with status for failed OpenRouter responses", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: () =>
          Promise.resolve({
            error: { message: "Rate limit exceeded" },
          }),
      }),
    );

    await expect(
      generateExplanation({ question: "What is spaced repetition?", username: "Luna" }),
    ).rejects.toMatchObject({
      name: "OpenRouterError",
      message: "Rate limit exceeded",
      status: 429,
    } satisfies Partial<OpenRouterError>);
  });
});
