import type { House } from "@/common/types.ts";

export const DEFAULT_OPENROUTER_MODEL = "google/gemma-3n-e4b-it:free";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_ANNOUNCEMENT_LENGTH = 900;

export interface YearAnnouncementRequest {
  house: House;
  roleMention: string;
  hours: string;
  year: number;
  username: string;
}

export interface OpenRouterChatResponse {
  choices?: {
    message?: {
      content?: string | null;
    };
  }[];
  error?: {
    message?: string;
  };
}

export function isOpenRouterConfigured(): boolean {
  return Boolean(process.env["OPENROUTER_API_KEY"]);
}

export function getOpenRouterModel(): string {
  const model = process.env["OPENROUTER_MODEL"]?.trim();
  return model === undefined || model.length === 0
    ? DEFAULT_OPENROUTER_MODEL
    : model;
}

export function buildYearAnnouncementPrompt({
  house,
  roleMention,
  hours,
  year,
  username,
}: YearAnnouncementRequest): string {
  return [
    "Write one short Discord embed description for a Hogwarts-themed productivity server.",
    `Member: ${username}`,
    `House: ${house}`,
    `New activity rank: ${roleMention}`,
    `Year level: ${year}`,
    `Monthly voice-study milestone: ${hours}`,
    "Requirements:",
    `- Congratulate the member in a warm ${house} style without being sarcastic.`,
    "- Mention the role and the milestone exactly once each.",
    "- Keep it under 70 words.",
    "- Do not include a title, heading, markdown table, hashtags, or roleplay dialogue.",
  ].join("\n");
}

export function sanitizeAnnouncementContent(content: string): string {
  return content
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ANNOUNCEMENT_LENGTH);
}

export async function generateYearAnnouncement(
  request: YearAnnouncementRequest,
): Promise<string> {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "OpenRouter is not configured. Set OPENROUTER_API_KEY to enable AI year announcements.",
    );
  }

  const referer = process.env["OPENROUTER_SITE_URL"] ?? "https://schnabel.dev";
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${apiKey}`);
  headers.set("Content-Type", "application/json");
  headers.set("HTTP-Referer", referer);
  headers.set("X-Title", "Hogwarts Productivity Hub Bot");

  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: getOpenRouterModel(),
      messages: [
        {
          role: "system",
          content:
            "You write concise, celebratory Discord announcements for a Hogwarts-themed productivity community.",
        },
        { role: "user", content: buildYearAnnouncementPrompt(request) },
      ],
      temperature: 0.8,
      max_tokens: 140,
    }),
  });

  const payload = (await response.json()) as OpenRouterChatResponse;
  if (!response.ok) {
    const errorMessage =
      payload.error?.message ??
      `OpenRouter request failed with status ${response.status}`;
    throw new Error(errorMessage);
  }

  const content = sanitizeAnnouncementContent(
    payload.choices?.[0]?.message?.content ?? "",
  );
  if (!content) {
    throw new Error("OpenRouter returned an empty year announcement.");
  }

  return content;
}
