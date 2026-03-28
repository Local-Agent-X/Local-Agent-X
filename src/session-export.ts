import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

export type ExportFormat = "json" | "markdown";

interface SessionMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  timestamp?: number;
}

interface SessionData {
  id: string;
  title: string;
  messages: SessionMessage[];
  createdAt: number;
  updatedAt: number;
  attachments?: Array<{ name: string; path: string; mimeType: string }>;
}

interface ExportedSession {
  version: 1;
  exportedAt: number;
  format: ExportFormat;
  session: SessionData;
  attachments?: Array<{ name: string; mimeType: string; base64: string }>;
}

function loadSession(sessionDir: string, sessionId: string): SessionData {
  // Sanitize sessionId to prevent path traversal
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const sessionFile = join(sessionDir, `${safeId}.json`);
  if (!existsSync(sessionFile)) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return JSON.parse(readFileSync(sessionFile, "utf-8"));
}

function encodeAttachment(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath).toString("base64");
}

function messageToText(msg: SessionMessage): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .map((part) => {
      if (part.type === "text" && part.text) return part.text;
      if (part.type === "image_url") return "[image]";
      return "";
    })
    .join("");
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

export function exportSession(
  sessionDir: string,
  sessionId: string,
  format: ExportFormat,
): string {
  const session = loadSession(sessionDir, sessionId);

  if (format === "json") {
    const exported: ExportedSession = {
      version: 1,
      exportedAt: Date.now(),
      format: "json",
      session,
    };

    // Encode attachments as base64
    if (session.attachments && session.attachments.length > 0) {
      exported.attachments = session.attachments
        .map((att) => {
          const b64 = encodeAttachment(att.path);
          if (!b64) return null;
          return { name: att.name, mimeType: att.mimeType, base64: b64 };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null);
    }

    return JSON.stringify(exported, null, 2);
  }

  // Markdown format
  const lines: string[] = [];
  lines.push(`# ${session.title || "Untitled Session"}`);
  lines.push("");
  lines.push(`**Session ID:** ${session.id}`);
  lines.push(`**Created:** ${formatTimestamp(session.createdAt)}`);
  lines.push(`**Updated:** ${formatTimestamp(session.updatedAt)}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const msg of session.messages) {
    const role = msg.role === "assistant" ? "Agent" : msg.role === "user" ? "User" : msg.role;
    const text = messageToText(msg);
    if (!text.trim()) continue;

    lines.push(`### ${role}`);
    if (msg.timestamp) {
      lines.push(`*${formatTimestamp(msg.timestamp)}*`);
    }
    lines.push("");
    lines.push(text);
    lines.push("");
  }

  if (session.attachments && session.attachments.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("### Attachments");
    lines.push("");
    for (const att of session.attachments) {
      lines.push(`- [${att.name}](${att.path})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function importSession(data: string): SessionData {
  let parsed: ExportedSession;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error("Invalid session data: not valid JSON");
  }

  if (!parsed.version || !parsed.session) {
    throw new Error("Invalid session export format");
  }

  if (!parsed.session.id || !Array.isArray(parsed.session.messages)) {
    throw new Error("Session data missing required fields (id, messages)");
  }

  return parsed.session;
}
