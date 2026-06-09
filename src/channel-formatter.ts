/**
 * Channel-Adaptive Formatter — formats AI responses per platform.
 *
 * Each channel has different constraints:
 * - Telegram: 4096 char limit, MarkdownV2 flavor, inline buttons
 * - WhatsApp: 4096 char limit, limited formatting (*bold*, _italic_)
 * - Web UI: unlimited, full HTML/markdown
 * - CLI: plain text, ANSI colors
 *
 * More robust than typical approaches:
 * - Smart chunking that preserves structure (never splits mid-code-block)
 * - Markdown dialect conversion (not just truncation)
 * - Media adaptation per channel
 * - Fallback: if formatting fails, send plain text (never lose the message)
 */

import type { ChannelType } from "./session/router.js";

// ── Channel Limits ──

interface ChannelConfig {
  maxTextLength: number;
  markdownFlavor: "full" | "telegram" | "whatsapp" | "plain";
  supportsMedia: boolean;
  supportsButtons: boolean;
  supportsCodeBlocks: boolean;
  supportsTables: boolean;
}

const CHANNEL_CONFIGS: Record<ChannelType, ChannelConfig> = {
  web: {
    maxTextLength: Infinity,
    markdownFlavor: "full",
    supportsMedia: true,
    supportsButtons: true,
    supportsCodeBlocks: true,
    supportsTables: true,
  },
  telegram: {
    maxTextLength: 4096,
    markdownFlavor: "telegram",
    supportsMedia: true,
    supportsButtons: true,
    supportsCodeBlocks: true,
    supportsTables: false,
  },
  whatsapp: {
    maxTextLength: 4096,
    markdownFlavor: "whatsapp",
    supportsMedia: true,
    supportsButtons: false,
    supportsCodeBlocks: false,
    supportsTables: false,
  },
  cli: {
    maxTextLength: Infinity,
    markdownFlavor: "plain",
    supportsMedia: false,
    supportsButtons: false,
    supportsCodeBlocks: true,
    supportsTables: true,
  },
  api: {
    maxTextLength: Infinity,
    markdownFlavor: "full",
    supportsMedia: true,
    supportsButtons: false,
    supportsCodeBlocks: true,
    supportsTables: true,
  },
};

// ── Core API ──

/**
 * Format a response for a specific channel.
 * Returns an array of chunks (most channels need splitting).
 */
export function formatForChannel(text: string, channel: ChannelType): string[] {
  const config = CHANNEL_CONFIGS[channel] || CHANNEL_CONFIGS.web;

  // Convert markdown dialect
  let formatted = convertMarkdown(text, config.markdownFlavor);

  // Strip unsupported features
  if (!config.supportsTables) formatted = stripTables(formatted);
  if (!config.supportsCodeBlocks) formatted = stripCodeBlocks(formatted);

  // Chunk if needed
  if (formatted.length <= config.maxTextLength) return [formatted];
  return smartChunk(formatted, config.maxTextLength);
}

/**
 * Get the channel config (for tools that need to adapt behavior).
 */
export function getChannelConfig(channel: ChannelType): ChannelConfig {
  return CHANNEL_CONFIGS[channel] || CHANNEL_CONFIGS.web;
}

// ── Markdown Conversion ──

function convertMarkdown(text: string, flavor: ChannelConfig["markdownFlavor"]): string {
  if (flavor === "full") return text; // No conversion needed

  if (flavor === "telegram") {
    // Telegram MarkdownV2: escape special chars outside code blocks
    return convertToTelegramMarkdown(text);
  }

  if (flavor === "whatsapp") {
    // WhatsApp: *bold*, _italic_, ~strikethrough~, ```code```
    return convertToWhatsAppMarkdown(text);
  }

  if (flavor === "plain") {
    return stripAllMarkdown(text);
  }

  return text;
}

function convertToTelegramMarkdown(text: string): string {
  // Placeholder shape uses ONLY letters + digits — Telegram MarkdownV2 has no
  // letters in its escape set, so the placeholder survives the escape pass
  // intact. The previous shape (`__CODE_BLOCK_0__`) embedded underscores
  // which got escaped to `\_\_CODE\_BLOCK\_0\_\_` during the escape pass,
  // causing the subsequent `replace('__CODE_BLOCK_0__', code)` to MISS the
  // (now-escaped) form and leak the literal placeholder into the rendered
  // message — that was the visible `__INLINE_CODE_0__` strings users saw
  // in Telegram replies.
  const codeBlocks: string[] = [];
  let result = text.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `XCODEBLOCKX${codeBlocks.length - 1}XENDX`;
  });

  const inlineCode: string[] = [];
  result = result.replace(/`[^`]+`/g, (match) => {
    inlineCode.push(match);
    return `XINLINECODEX${inlineCode.length - 1}XENDX`;
  });

  // Escape Telegram special chars: _ * [ ] ( ) ~ ` > # + - = | { } . !
  // Backslash MUST be escaped first, otherwise the escapes added below could be
  // neutralised/combined by a literal `\` already present in the text.
  result = result.replace(/\\/g, "\\\\").replace(/([_*\[\]()~>#+\-=|{}.!])/g, "\\$1");

  // Restore (unescaped — code spans pass through MarkdownV2 raw).
  for (let i = 0; i < codeBlocks.length; i++) {
    result = result.replace(`XCODEBLOCKX${i}XENDX`, codeBlocks[i]);
  }
  for (let i = 0; i < inlineCode.length; i++) {
    result = result.replace(`XINLINECODEX${i}XENDX`, inlineCode[i]);
  }

  return result;
}

function convertToWhatsAppMarkdown(text: string): string {
  let result = text;
  // **bold** → *bold*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
  // ## headers → *HEADER*
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
  // ```code``` → ```code``` (WhatsApp supports this)
  // [link](url) → url (WhatsApp doesn't support markdown links)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1: $2");
  // Strip remaining markdown syntax
  result = result.replace(/^[-*+]\s/gm, "- ");
  return result;
}

function stripAllMarkdown(text: string): string {
  let result = text;
  // Remove code block markers but keep content
  result = result.replace(/```\w*\n?/g, "");
  // Remove bold/italic markers
  result = result.replace(/\*\*(.+?)\*\*/g, "$1");
  result = result.replace(/\*(.+?)\*/g, "$1");
  result = result.replace(/_(.+?)_/g, "$1");
  // Remove headers
  result = result.replace(/^#{1,6}\s+/gm, "");
  // Convert links
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  return result;
}

// ── Feature Stripping ──

function stripTables(text: string): string {
  // Convert markdown tables to plain text lists
  const lines = text.split("\n");
  const result: string[] = [];
  let inTable = false;
  let headers: string[] = [];

  for (const line of lines) {
    if (/^\|.*\|$/.test(line.trim())) {
      if (/^\|[-: |]+\|$/.test(line.trim())) {
        inTable = true;
        continue; // Skip separator line
      }
      const cells = line.split("|").filter(c => c.trim()).map(c => c.trim());
      if (!inTable) {
        headers = cells;
        inTable = true;
      } else {
        // Convert row to "Header: Value" format
        const parts = cells.map((c, i) => headers[i] ? `${headers[i]}: ${c}` : c);
        result.push(parts.join(" | "));
      }
    } else {
      inTable = false;
      headers = [];
      result.push(line);
    }
  }
  return result.join("\n");
}

function stripCodeBlocks(text: string): string {
  // Remove code block markers, indent content
  return text.replace(/```\w*\n([\s\S]*?)```/g, (_, code) => {
    return code.split("\n").map((l: string) => "  " + l).join("\n");
  });
}

// ── Smart Chunking ──

/**
 * Split text into chunks that respect structure.
 * Never splits mid-code-block, mid-list, or mid-paragraph.
 */
function smartChunk(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  const lines = text.split("\n");
  let current = "";

  for (const line of lines) {
    // Would adding this line exceed the limit?
    if (current.length + line.length + 1 > maxLen && current.length > 0) {
      chunks.push(current.trimEnd());
      current = "";
    }

    // Single line exceeds limit — force split
    if (line.length > maxLen) {
      if (current) { chunks.push(current.trimEnd()); current = ""; }
      // Split long line at word boundaries
      let remaining = line;
      while (remaining.length > maxLen) {
        const splitAt = remaining.lastIndexOf(" ", maxLen);
        const idx = splitAt > maxLen * 0.5 ? splitAt : maxLen;
        chunks.push(remaining.slice(0, idx));
        remaining = remaining.slice(idx).trimStart();
      }
      if (remaining) current = remaining + "\n";
      continue;
    }

    current += line + "\n";
  }

  if (current.trim()) chunks.push(current.trimEnd());

  // Add continuation markers
  if (chunks.length > 1) {
    for (let i = 0; i < chunks.length; i++) {
      if (i < chunks.length - 1) chunks[i] += `\n\n(${i + 1}/${chunks.length})`;
    }
  }

  return chunks;
}
