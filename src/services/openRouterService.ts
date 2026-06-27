import type { House } from "@/common/types.ts";

export const OPENROUTER_FREE_MODELS = [
  // Strong general-purpose explainer for concise, helpful answers.
  "meta-llama/llama-3.3-70b-instruct:free",
  // Balanced instruction-following fallback for educational explanations.
  "google/gemma-4-31b-it:free",
  // Small/simple fallback that should still answer when larger models are busy.
  "liquid/lfm-2.5-1.2b-instruct:free",
];
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_ANNOUNCEMENT_LENGTH = 900;
const MAX_EXPLANATION_LENGTH = 4000;
const TRUNCATION_NOTICE = "\n\n… (response shortened to fit Discord)";

export interface YearAnnouncementRequest {
  house: House;
  roleMention: string;
  hours: string;
  year: number;
  username: string;
}

export interface ExplanationRequest {
  question: string;
}

export interface OpenRouterMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

export interface OpenRouterChatResponse {
  model?: string;
  choices?: {
    message?: {
      content?: string | null;
    };
  }[];
  error?: {
    message?: string;
  };
}

export interface GeneratedOpenRouterContent {
  content: string;
  model: string;
}

export function isOpenRouterConfigured(): boolean {
  return Boolean(process.env["OPENROUTER_API_KEY"]);
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

export function buildExplanationPrompt({ question }: ExplanationRequest): string {
  return [
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
  const sanitized = content
    .replaceAll(/[ \t]+/g, " ")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();

  if (sanitized.length <= maxLength) {
    return sanitized;
  }

  return truncateContent(sanitized, maxLength);
}

function truncateContent(content: string, maxLength: number): string {
  const maxContentLength = maxLength - TRUNCATION_NOTICE.length;
  const truncated = content.slice(0, maxContentLength).trimEnd();
  const sentenceBreak = Math.max(
    truncated.lastIndexOf(". "),
    truncated.lastIndexOf("! "),
    truncated.lastIndexOf("? "),
    truncated.lastIndexOf(".\n"),
    truncated.lastIndexOf("!\n"),
    truncated.lastIndexOf("?\n"),
  );

  if (sentenceBreak > maxContentLength * 0.75) {
    return `${truncated.slice(0, sentenceBreak + 1).trimEnd()}${TRUNCATION_NOTICE}`;
  }

  return `${truncated}${TRUNCATION_NOTICE}`;
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
}): Promise<GeneratedOpenRouterContent> {
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
      models: OPENROUTER_FREE_MODELS,
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
  });

  const payload = (await response.json()) as OpenRouterChatResponse;
  if (!response.ok) {
    const errorMessage = payload.error?.message ?? `OpenRouter request failed with status ${response.status}`;
    throw new OpenRouterError(errorMessage, response.status);
  }

  const content = sanitizer(payload.choices?.[0]?.message?.content ?? "");
  if (!content) {
    throw new Error(emptyResponseMessage);
  }

  return {
    content,
    model: payload.model?.trim() ? payload.model.trim() : (OPENROUTER_FREE_MODELS[0] ?? "OpenRouter free model"),
  };
}

export async function generateYearAnnouncement(
  request: YearAnnouncementRequest,
): Promise<string> {
  const result = await generateOpenRouterContent({
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

  return result.content;
}

export async function generateExplanation(request: ExplanationRequest): Promise<GeneratedOpenRouterContent> {
  return generateOpenRouterContent({
    messages: [
      {
        role: "system",
        content: "You are a careful, concise tutor. Answer only the user's question and avoid inventing context.",
      },
      { role: "user", content: buildExplanationPrompt(request) },
    ],
    temperature: 0.6,
    maxTokens: 1000,
    emptyResponseMessage: "OpenRouter returned an empty explanation.",
    sanitizer: sanitizeExplanationContent,
  });
}
