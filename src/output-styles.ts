/**
 * Output Styles — adapts agent output format for different contexts.
 *
 * Web UI gets rich markdown. API consumers get structured JSON.
 * WhatsApp/Telegram bridges get plain text. Mobile gets condensed format.
 */

export type OutputStyle = "rich" | "plain" | "json" | "condensed";

interface OutputOptions {
  maxLength?: number;
  includeMetadata?: boolean;
  stripCodeBlocks?: boolean;
}

// ── Style Detection ──

export function detectStyle(sessionId: string, headers?: Record<string, string>): OutputStyle {
  // Bridge channels → plain text (WhatsApp, Telegram, SMS)
  if (sessionId.startsWith("wa-") || sessionId.startsWith("tg-") || sessionId.startsWith("sms-")) {
    return "plain";
  }
  // API calls requesting JSON
  if (headers?.accept?.includes("application/json")) return "json";
  // Compact channels
  if (sessionId.startsWith("mobile-")) return "condensed";
  // Default: rich markdown for web UI
  return "rich";
}

// ── Formatters ──

/** Strip markdown formatting to plain text */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => {
      const code = m.replace(/```\w*\n?/, "").replace(/```$/, "");
      return code.trim();
    })
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "- ")
    .replace(/^\s*\d+\.\s+/gm, (m) => m.trim() + " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "[Image: $1]")
    .replace(/^>\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Condense text — shorter paragraphs, no code blocks, truncated */
function condense(text: string, maxLength: number = 500): string {
  let plain = stripMarkdown(text);
  // Remove code blocks entirely for condensed
  plain = plain.replace(/```[\s\S]*?```/g, "[code omitted]");
  if (plain.length > maxLength) {
    plain = plain.slice(0, maxLength - 3) + "...";
  }
  return plain;
}

/** Wrap in structured JSON */
function toJson(text: string, meta?: Record<string, unknown>): string {
  return JSON.stringify({
    content: text,
    format: "markdown",
    ...(meta || {}),
  });
}

// ── Public API ──

export function formatOutput(text: string, style: OutputStyle, options?: OutputOptions): string {
  switch (style) {
    case "rich":
      // Pass through markdown as-is (UI renders it)
      if (options?.maxLength && text.length > options.maxLength) {
        return text.slice(0, options.maxLength - 3) + "...";
      }
      return text;

    case "plain":
      return stripMarkdown(text);

    case "json":
      return toJson(text, options?.includeMetadata ? { style: "json" } : undefined);

    case "condensed":
      return condense(text, options?.maxLength || 500);

    default:
      return text;
  }
}

/**
 * Format usage/cost data for display in different styles.
 */
export function formatUsage(
  usage: { promptTokens: number; completionTokens: number; totalTokens: number },
  costUsd?: number,
  style: OutputStyle = "rich",
): string {
  const cost = costUsd !== undefined ? ` | $${costUsd.toFixed(4)}` : "";

  switch (style) {
    case "rich":
      return `*${usage.totalTokens.toLocaleString()} tokens${cost}*`;
    case "plain":
      return `${usage.totalTokens} tokens${cost}`;
    case "json":
      return JSON.stringify({ ...usage, costUsd });
    case "condensed":
      return `${usage.totalTokens}t${cost}`;
    default:
      return `${usage.totalTokens} tokens${cost}`;
  }
}
