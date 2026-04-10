/**
 * Universal Conversation Parsers
 *
 * Auto-detects and parses chat export formats from any AI platform.
 * Supported: ChatGPT, Claude.ai, Claude Code, OpenAI Codex CLI, Slack, generic JSON, plain text.
 */

// ── Types ──

export interface ParsedMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: number;
}

export interface ParsedConversation {
  id: string;
  title: string;
  messages: ParsedMessage[];
  createTime?: number;
  source: string; // format name
}

export type ConversationFormat =
  | "chatgpt" | "claude-ai" | "claude-code" | "codex-cli"
  | "slack" | "generic-json" | "plain-text" | "unknown";

// ── Format Detection ──

export function detectFormat(content: string, ext: string): ConversationFormat {
  const trimmed = content.trim();
  if (ext === ".jsonl" || (trimmed.startsWith("{") && trimmed.includes("\n{"))) {
    // JSONL — check for Claude Code or Codex patterns
    const firstLine = trimmed.split("\n")[0];
    try {
      const obj = JSON.parse(firstLine);
      if (obj.type === "session_meta") return "codex-cli";
      if (obj.type === "human" || obj.type === "assistant" || obj.type === "user") return "claude-code";
      if (obj.type === "event_msg") return "codex-cli";
    } catch {}
    return "unknown";
  }

  if (ext === ".json" || trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const data = JSON.parse(trimmed);
      if (Array.isArray(data)) {
        if (data[0]?.mapping) return "chatgpt";
        if (data[0]?.chat_messages) return "claude-ai";
        if (data[0]?.type === "message" && data[0]?.user) return "slack";
        if (data[0]?.role && data[0]?.content !== undefined) return "generic-json";
      } else if (data.mapping) return "chatgpt";
      else if (data.messages || data.chat_messages) return "claude-ai";
    } catch {}
  }

  // Plain text with > markers
  const lines = content.split("\n");
  if (lines.filter(l => l.trim().startsWith(">")).length >= 3) return "plain-text";

  return "unknown";
}

// ── Main Parser ──

export function parseExportFile(content: string, ext: string): ParsedConversation[] {
  const format = detectFormat(content, ext);
  switch (format) {
    case "chatgpt": return parseChatGPT(JSON.parse(content));
    case "claude-ai": return parseClaudeAI(JSON.parse(content));
    case "claude-code": return parseClaudeCode(content);
    case "codex-cli": return parseCodexCLI(content);
    case "slack": return parseSlack(JSON.parse(content));
    case "generic-json": return parseGenericJSON(JSON.parse(content));
    case "plain-text": return parsePlainText(content);
    default: return [];
  }
}

// ── ChatGPT Parser ──
// Export format: array of conversations, each with a `mapping` tree

function parseChatGPT(data: unknown): ParsedConversation[] {
  const convos = Array.isArray(data) ? data : [data];
  const results: ParsedConversation[] = [];

  for (const convo of convos) {
    if (!convo?.mapping) continue;
    const messages = walkMappingTree(convo.mapping);
    if (messages.length < 2) continue;
    results.push({
      id: convo.id || convo.conversation_id || `chatgpt-${Date.now()}-${results.length}`,
      title: convo.title || "Untitled",
      messages,
      createTime: convo.create_time ? convo.create_time * 1000 : undefined,
      source: "chatgpt",
    });
  }
  return results;
}

function walkMappingTree(mapping: Record<string, Record<string, unknown>>): ParsedMessage[] {
  // Find root: prefer node with parent=null AND no message (synthetic root)
  let rootId: string | null = null;
  let fallbackRoot: string | null = null;
  for (const [nodeId, node] of Object.entries(mapping)) {
    if (node.parent === null || node.parent === undefined) {
      if (!node.message) { rootId = nodeId; break; }
      else if (!fallbackRoot) fallbackRoot = nodeId;
    }
  }
  if (!rootId) rootId = fallbackRoot;
  if (!rootId) return [];

  const messages: ParsedMessage[] = [];
  let currentId: string | null = rootId;
  const visited = new Set<string>();

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const node: Record<string, unknown> = mapping[currentId];
    if (!node) break;

    const msg = node.message as Record<string, unknown> | null | undefined;
    if (msg) {
      const author = msg.author as Record<string, unknown> | undefined;
      const role = author?.role as string | undefined;
      const contentObj = msg.content as Record<string, unknown> | string | undefined;
      const parts = typeof contentObj === "object" && contentObj !== null ? (contentObj as Record<string, unknown>).parts as unknown[] : undefined;
      const text = Array.isArray(parts)
        ? parts.filter((p: unknown) => typeof p === "string" && p).join(" ").trim()
        : typeof contentObj === "string" ? contentObj.trim() : "";

      if (text && (role === "user" || role === "assistant")) {
        const createTime = msg.create_time as number | undefined;
        messages.push({ role, content: text, timestamp: createTime ? createTime * 1000 : undefined });
      }
    }

    const children = node.children as string[] | undefined;
    currentId = Array.isArray(children) && children.length > 0 ? children[0] : null;
  }

  return messages;
}

// ── Claude.ai Parser ──
// Flat messages list or privacy export with chat_messages

function parseClaudeAI(data: unknown): ParsedConversation[] {
  if (!Array.isArray(data) && typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    const msgs = obj.messages || obj.chat_messages;
    if (Array.isArray(msgs)) return [parseClaudeAIMessages(msgs, "claude-ai-single")];
    return [];
  }
  if (!Array.isArray(data)) return [];

  // Privacy export: array of conversation objects with chat_messages
  if (data[0]?.chat_messages) {
    return data.map((convo: any, i: number) => {
      const msgs = convo.chat_messages || [];
      return parseClaudeAIMessages(msgs, convo.uuid || `claude-ai-${i}`, convo.name);
    }).filter(c => c.messages.length >= 2);
  }

  // Flat messages list
  return [parseClaudeAIMessages(data, "claude-ai-flat")];
}

function parseClaudeAIMessages(msgs: any[], id: string, title?: string): ParsedConversation {
  const messages: ParsedMessage[] = [];
  for (const item of msgs) {
    if (!item || typeof item !== "object") continue;
    const role = item.role;
    const text = extractContent(item.content);
    if (!text) continue;
    if (role === "user" || role === "human") messages.push({ role: "user", content: text });
    else if (role === "assistant" || role === "ai") messages.push({ role: "assistant", content: text });
  }
  return { id, title: title || "Claude.ai conversation", messages, source: "claude-ai" };
}

// ── Claude Code Parser (JSONL) ──

function parseClaudeCode(content: string): ParsedConversation[] {
  const lines = content.trim().split("\n").filter(l => l.trim());
  const messages: ParsedMessage[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (!entry || typeof entry !== "object") continue;
      const type = entry.type;
      const text = extractContent(entry.message?.content || entry.content);
      if (!text) continue;
      if (type === "human" || type === "user") messages.push({ role: "user", content: text });
      else if (type === "assistant") messages.push({ role: "assistant", content: text });
    } catch { /* skip malformed lines */ }
  }

  if (messages.length < 2) return [];
  return [{ id: `claude-code-${Date.now()}`, title: "Claude Code session", messages, source: "claude-code" }];
}

// ── OpenAI Codex CLI Parser (JSONL) ──

function parseCodexCLI(content: string): ParsedConversation[] {
  const lines = content.trim().split("\n").filter(l => l.trim());
  const messages: ParsedMessage[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry?.type !== "event_msg") continue;
      const payload = entry.payload;
      if (!payload || typeof payload.message !== "string") continue;
      const text = payload.message.trim();
      if (!text) continue;
      if (payload.type === "user_message") messages.push({ role: "user", content: text });
      else if (payload.type === "agent_message") messages.push({ role: "assistant", content: text });
    } catch { /* skip */ }
  }

  if (messages.length < 2) return [];
  return [{ id: `codex-${Date.now()}`, title: "Codex CLI session", messages, source: "codex-cli" }];
}

// ── Slack Parser ──

function parseSlack(data: unknown): ParsedConversation[] {
  if (!Array.isArray(data)) return [];
  const messages: ParsedMessage[] = [];
  const speakers: Record<string, "user" | "assistant"> = {};
  let lastRole: "user" | "assistant" = "user";

  for (const item of data) {
    if (item?.type !== "message" || !item.text) continue;
    const userId = item.user || item.username || "";
    if (!userId) continue;
    const text = (item.text as string).trim();
    if (!text) continue;

    if (!speakers[userId]) {
      speakers[userId] = Object.keys(speakers).length === 0 ? "user" : lastRole === "user" ? "assistant" : "user";
    }
    lastRole = speakers[userId];
    messages.push({ role: speakers[userId], content: text, timestamp: item.ts ? parseFloat(item.ts) * 1000 : undefined });
  }

  if (messages.length < 2) return [];
  return [{ id: `slack-${Date.now()}`, title: "Slack conversation", messages, source: "slack" }];
}

// ── Generic JSON Parser ──
// Array of {role, content} objects (OpenAI format, custom exports)

function parseGenericJSON(data: unknown): ParsedConversation[] {
  if (!Array.isArray(data)) return [];
  const messages: ParsedMessage[] = [];

  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const role = (item as any).role;
    const text = extractContent((item as any).content);
    if (!text) continue;
    if (role === "user" || role === "human") messages.push({ role: "user", content: text });
    else if (role === "assistant" || role === "ai" || role === "bot") messages.push({ role: "assistant", content: text });
  }

  if (messages.length < 2) return [];
  return [{ id: `generic-${Date.now()}`, title: "Imported conversation", messages, source: "generic-json" }];
}

// ── Plain Text Parser ──
// Text with > markers for user turns

function parsePlainText(content: string): ParsedConversation[] {
  const lines = content.split("\n");
  const messages: ParsedMessage[] = [];
  let currentRole: "user" | "assistant" | null = null;
  let buffer = "";

  for (const line of lines) {
    if (line.trim().startsWith(">")) {
      if (currentRole && buffer.trim()) messages.push({ role: currentRole, content: buffer.trim() });
      currentRole = "user";
      buffer = line.trim().slice(1).trim();
    } else if (currentRole === "user" && !line.trim().startsWith(">") && line.trim()) {
      if (buffer.trim()) messages.push({ role: "user", content: buffer.trim() });
      currentRole = "assistant";
      buffer = line;
    } else if (currentRole) {
      buffer += "\n" + line;
    }
  }
  if (currentRole && buffer.trim()) messages.push({ role: currentRole, content: buffer.trim() });

  if (messages.length < 2) return [];
  return [{ id: `text-${Date.now()}`, title: "Text conversation", messages, source: "plain-text" }];
}

// ── Helpers ──

function extractContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map(item => typeof item === "string" ? item : typeof item === "object" && item?.type === "text" ? item.text || "" : "")
      .join(" ").trim();
  }
  if (typeof content === "object" && content !== null) return (content as any).text?.trim() || "";
  return "";
}
