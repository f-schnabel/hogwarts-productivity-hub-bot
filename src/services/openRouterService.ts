import type { House } from "@/common/types.ts";

export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-oss-120b:free";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_ANNOUNCEMENT_LENGTH = 900;
const MAX_EXPLANATION_LENGTH = 1900;

export interface YearAnnouncementRequest {
  house: House;
  roleMention: string;
  hours: string;
  year: number;
  username: string;
}

export interface ExplanationRequest {
  question: string;
  username: string;
}

export interface OpenRouterMessage {
  role: "system" | "user" | "assistant";
  content: string;
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

export function buildExplanationPrompt({ question, username }: ExplanationRequest): string {
  return [
    "Explain a concept or answer a question for a member of a Hogwarts-themed productivity Discord server.",
    `Member: ${username}`,
    `Question: ${question}`,
    "Requirements:",
    "- Be accurate, practical, and easy to understand.",
    "- Use a light Hogwarts classroom flavor, such as lessons, libraries, spells, or houses, without heavy roleplay.",
    "- Do not pretend to be a Harry Potter character or include roleplay dialogue.",
    "- If the question is ambiguous, state the most likely interpretation and give a useful answer.",
    "- If you are not sure, say so and suggest how the member can verify it.",
    "- Keep the response under 350 words.",
    "- Use Discord-friendly Markdown with short paragraphs or bullets when helpful.",
  ].join("\n");
}

export function sanitizeAnnouncementContent(content: string): string {
  return content
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ANNOUNCEMENT_LENGTH);
}

export function sanitizeExplanationContent(content: string): string {
  return sanitizeOpenRouterContent(content, MAX_EXPLANATION_LENGTH);
}

function sanitizeOpenRouterContent(content: string, maxLength: number): string {
  return content
    .replaceAll(/[ \t]+/g, " ")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

async function generateOpenRouterContent({
  messages,
  maxTokens,
  temperature,
  emptyResponseMessage,
  sanitizer,
}: {
  messages: OpenRouterMessage[];
  maxTokens: number;
  temperature: number;
  emptyResponseMessage: string;
  sanitizer: (content: string) => string;
}): Promise<string> {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) {
    throw new Error("OpenRouter is not configured. Set OPENROUTER_API_KEY to enable AI responses.");
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
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
  });

  const payload = (await response.json()) as OpenRouterChatResponse;
  if (!response.ok) {
    const errorMessage =
      payload.error?.message ??
      `OpenRouter request failed with status ${response.status}`;
    throw new Error(errorMessage);
  }

  const content = sanitizer(payload.choices?.[0]?.message?.content ?? "");
  if (!content) {
    throw new Error(emptyResponseMessage);
  }

  return content;
}

export async function generateYearAnnouncement(
  request: YearAnnouncementRequest,
): Promise<string> {
  return generateOpenRouterContent({
    messages: [
      {
        role: "system",
        content:
          "You write concise, celebratory Discord announcements for a Hogwarts-themed productivity community.",
      },
      { role: "user", content: buildYearAnnouncementPrompt(request) },
    ],
    temperature: 0.8,
    maxTokens: 140,
    emptyResponseMessage: "OpenRouter returned an empty year announcement.",
    sanitizer: sanitizeAnnouncementContent,
  });
}

export async function generateExplanation(request: ExplanationRequest): Promise<string> {
  return generateOpenRouterContent({
    messages: [
      {
        role: "system",
        content:
          "You are a helpful tutor for a Hogwarts-themed productivity community. Explain clearly with a light magical-school style, but do not roleplay.",
      },
      { role: "user", content: buildExplanationPrompt(request) },
    ],
    temperature: 0.6,
    maxTokens: 600,
    emptyResponseMessage: "OpenRouter returned an empty explanation.",
    sanitizer: sanitizeExplanationContent,
  });
}
