import { createLogger } from "@/common/logging/logger.ts";
import type { House } from "@/common/types.ts";
import { OpenRouter } from "@openrouter/sdk";
import type { ChatRequest } from "@openrouter/sdk/models";
import assert from "node:assert";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  throw new Error("OpenRouter is not configured. Set OPENROUTER_API_KEY to enable AI responses.");
}
const client = new OpenRouter({ apiKey });
const log = createLogger("OpenRouter");


export const OPENROUTER_MODELS = [
  // Default: strongest free model for concise explanations.
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  // Strong free Google fallback.
  "google/gemma-4-31b-it:free",
  // Capable free open-weight fallback from a different provider.
  "openai/gpt-oss-120b:free",
];

export const OPENROUTER_YEAR_ANNOUNCEMENT_MODELS = OPENROUTER_MODELS;
// [
//   // Prefer a non-reasoning model for short public announcements so the response budget is not spent on thinking.
//   "google/gemma-4-31b-it:free",
//   // Keep the site-wide default available as a fallback, but explicitly disable/exclude reasoning for this call.
//   "nvidia/nemotron-3-ultra-550b-a55b:free",
//   "openai/gpt-oss-120b:free",
// ];


async function generateOpenRouterContent(
  chatRequest: ChatRequest & { stream?: false | undefined },
): Promise<{
  content: string;
  model: string;
} | null> {
  assert(!chatRequest.stream, "Streaming is not supported for OpenRouter content generation.");

  const payload = await client.chat.send({ chatRequest, httpReferer: "https://schnabel.dev", appTitle: "Hogwarts Productivity Hub Bot" });
  log.debug("OpenRouter response", { payload });
  const choice = payload.choices[0];
  if (!choice) {
    log.warn("OpenRouter returned no choices", { payload });
    return null;
  }
  if (typeof choice.message.content !== "string" || !choice.message.content.trim()) {
    log.warn("OpenRouter returned empty content", { payload });
    return null;
  }

  return {
    content: choice.message.content.trim(),
    model: payload.model,
  };
}

export async function generateYearAnnouncement(
  request: {
    house: House;
    roleMention: string;
    hours: string;
    year: number;
    username: string;
  }) {
  return await generateOpenRouterContent({
    messages: [
      {
        role: "system",
        content:
          "You write concise, celebratory Discord announcements for a Hogwarts-themed productivity community.",
      },
      { role: "user", content: [
        "Write one short Discord embed description for a Hogwarts-themed productivity server.",
        `Member: ${request.username}`,
        `House: ${request.house}`,
        `New Role: ${request.roleMention}`,
        `Year (1-7): ${request.year}`,
        `Voice Time Hours: ${request.hours}`,
        "Requirements:",
        `- Congratulate the member in a warm ${request.house} style.`,
        "- Mention the role and hours exactly once.",
        "- Keep it under 70 words.",
        "- Do not include title, markdown table.",
      ].join("\n") },
    ],
    temperature: 0.8,
    maxCompletionTokens: 260,
    models: OPENROUTER_YEAR_ANNOUNCEMENT_MODELS,
  });
}

export async function generateExplanation(question: string) {
  return generateOpenRouterContent({
    messages: [
      {
        role: "system",
        content: "You are a careful, concise tutor. Answer only the user's question and avoid inventing context.",
      },
      { role: "user", content: [
        "Explain a concept or answer a question for a Discord community member.",
        `Question: ${question}`,
        "Requirements:",
        "- Answer the question as written; do not infer hidden context from user names or unrelated terms.",
        "- If the question is a short phrase or topic, define it directly and explain the core idea.",
        "- If the wording is ambiguous, state the most likely interpretation and briefly mention other common meanings.",
        "- Do not invent named entities, backstories, or examples that are not implied by the question.",
        "- Be accurate, practical, and easy to understand.",
        "- Use a direct, helpful tone without roleplay or themed flavor.",
        "- Do not use tables.",
        "- Do not repeat the question in the response.",
        "- If you are not sure, say so and suggest how the member can verify it.",
        "- Keep the response under 250 words.",
        "- Use Discord-friendly Markdown with short paragraphs or bullets when helpful.",
      ].join("\n") },
    ],
    temperature: 0.6,
    maxCompletionTokens: 1000,
    models: OPENROUTER_MODELS,
  });
}
