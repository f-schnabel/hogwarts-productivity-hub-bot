import { describe, expect, it, vi } from "vitest";
import type { ChatRequest, ChatResult } from "@openrouter/sdk/models";
import type { OpenRouterError } from "@openrouter/sdk/models/errors";

const chatSendMock = vi.hoisted(() => vi.fn());

vi.mock("@openrouter/sdk", () => ({
  OpenRouter: class MockOpenRouter {
    chat = {
      send: chatSendMock,
    };
  },
}));

import {
  generateExplanation,
  OPENROUTER_MODELS,
  OPENROUTER_YEAR_ANNOUNCEMENT_MODELS,
  generateYearAnnouncement,
} from "@/services/openRouterService.ts";

const request = {
  house: "Ravenclaw" as const,
  roleMention: "<@&year3>",
  hours: "20 hours",
  year: 3,
  username: "Luna",
};

describe("openRouterService", () => {
  function mockChatResult(content: string, model = "test/free-model"): ChatResult {
    return {
      id: "chatcmpl-test",
      created: 1,
      model,
      object: "chat.completion",
      systemFingerprint: null,
      choices: [
        {
          finishReason: "stop",
          index: 0,
          message: {
            role: "assistant",
            content,
          },
        },
      ],
    };
  }

  it("sends the inline explanation model fallbacks to OpenRouter", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    chatSendMock.mockResolvedValue(
      mockChatResult("Inline model answer.", OPENROUTER_MODELS[0]),
    );

    await expect(
      generateExplanation("What is spaced repetition?"),
    ).resolves.toEqual({
      content: "Inline model answer.",
      model: OPENROUTER_MODELS[0],
    });

    const openRouterRequest = chatSendMock.mock.calls[0]?.[0] as {
      chatRequest: ChatRequest;
    };

    expect(openRouterRequest.chatRequest.model).toBeUndefined();
    expect(openRouterRequest.chatRequest.models).toEqual(OPENROUTER_MODELS);
    expect(openRouterRequest.chatRequest.models).toHaveLength(3);
    expect(openRouterRequest.chatRequest.models?.[0]).toBe("nvidia/nemotron-3-ultra-550b-a55b:free");
    expect(openRouterRequest.chatRequest.models).not.toContain("openrouter/free");
  });

  it("sends non-reasoning year announcement fallbacks to OpenRouter", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    chatSendMock.mockResolvedValue(mockChatResult("  Well done, Ravenclaw!\nYou earned it. "));

    await expect(generateYearAnnouncement(request)).resolves.toEqual({
      content: "Well done, Ravenclaw!\nYou earned it.",
      model: "test/free-model",
    });

    const openRouterRequest = chatSendMock.mock.calls[0]?.[0] as {
      chatRequest: ChatRequest;
    };

    expect(openRouterRequest.chatRequest.models).toEqual(OPENROUTER_YEAR_ANNOUNCEMENT_MODELS);
    expect(openRouterRequest.chatRequest.models?.[0]).toBe("google/gemma-4-31b-it:free");
    expect(openRouterRequest.chatRequest.models).toContain("nvidia/nemotron-3-ultra-550b-a55b:free");
    expect(openRouterRequest.chatRequest.maxCompletionTokens).toBe(260);
    expect(openRouterRequest.chatRequest.reasoning).toEqual({ effort: "none" });
  });

  it("returns sanitized explanation content from OpenRouter", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    chatSendMock.mockResolvedValue(
      mockChatResult("  Review the idea once, then revisit it later.\n\nSpace reviews out over time. "),
    );

    await expect(
      generateExplanation("What is spaced repetition?"),
    ).resolves.toEqual({
      content: "Review the idea once, then revisit it later.\n\nSpace reviews out over time.",
      model: "test/free-model",
    });
  });

  it("returns the explanation model label from OpenRouter", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    chatSendMock.mockResolvedValue({
      ...mockChatResult("Fallback model label."),
      model: OPENROUTER_MODELS[0],
    });

    await expect(
      generateExplanation("What is spaced repetition?"),
    ).resolves.toEqual({
      content: "Fallback model label.",
      model: OPENROUTER_MODELS[0],
    });
  });

  it("throws OpenRouterError with status for failed OpenRouter responses", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const error = {
      name: "OpenRouterError",
      message: "Rate limit exceeded",
      statusCode: 429,
    } satisfies Partial<OpenRouterError>;
    chatSendMock.mockRejectedValue(error);

    await expect(
      generateExplanation("What is spaced repetition?"),
    ).rejects.toMatchObject(error);
  });

  it("returns null when OpenRouter omits choices", async () => {
    chatSendMock.mockResolvedValue({
      ...mockChatResult("Ignored."),
      choices: [],
    } satisfies ChatResult);

    await expect(
      generateExplanation("What is spaced repetition?"),
    ).resolves.toBeNull();
  });

  it("returns null when OpenRouter returns empty content", async () => {
    chatSendMock.mockResolvedValue(mockChatResult("   "));

    await expect(
      generateExplanation("What is spaced repetition?"),
    ).resolves.toBeNull();
  });
});
