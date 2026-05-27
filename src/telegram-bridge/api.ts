import { splitMessage } from "../whatsapp-bridge/text-utils.js";
import { logger } from "./types.js";

export async function apiCall(
  token: string,
  method: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<any> {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const opts: RequestInit = {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  };
  if (signal) opts.signal = signal;
  const res = await fetch(url, opts);
  return res.json();
}

export async function sendMessage(token: string, chatId: string, text: string): Promise<boolean> {
  const chunks = splitMessage(text, 4000);
  for (const chunk of chunks) {
    try {
      // The channel-formatter produces MarkdownV2-escaped text (escaping
      // ( ) . ! - + = | { } # > ~ etc.). Telegram's legacy "Markdown"
      // mode doesn't recognize those escapes and renders the literal
      // backslashes — so we MUST send with MarkdownV2 to match.
      let result = await apiCall(token, "sendMessage", {
        chat_id: chatId, text: chunk, parse_mode: "MarkdownV2",
      });
      // Parse failed — strip backslash escapes and send as plain text
      // so the user at least gets a readable message.
      if (!result.ok && result.description?.includes("parse")) {
        const plain = chunk.replace(/\\([_*\[\]()~>#+\-=|{}.!`])/g, "$1");
        result = await apiCall(token, "sendMessage", { chat_id: chatId, text: plain });
      }
      if (!result.ok) {
        logger.error(`[telegram] Send failed: ${result.description}`);
        return false;
      }
    } catch (e) {
      logger.error("[telegram] Send error:", (e as Error).message);
      return false;
    }
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 300));
  }
  return true;
}

export async function sendVoice(token: string, chatId: string, ogg: Buffer): Promise<boolean> {
  try {
    const form = new FormData();
    form.append("chat_id", chatId);
    const blob = new Blob([ogg], { type: "audio/ogg" });
    form.append("voice", blob, "reply.ogg");
    const res = await fetch(`https://api.telegram.org/bot${token}/sendVoice`, {
      method: "POST",
      body: form,
    });
    const result = await res.json() as { ok: boolean; description?: string };
    if (!result.ok) {
      logger.error(`[telegram] sendVoice failed: ${result.description}`);
      return false;
    }
    return true;
  } catch (e) {
    logger.error("[telegram] sendVoice error:", (e as Error).message);
    return false;
  }
}

export async function sendPhoto(token: string, chatId: string, image: Buffer, caption?: string): Promise<boolean> {
  try {
    const form = new FormData();
    form.append("chat_id", chatId);
    if (caption) form.append("caption", caption.slice(0, 1024));
    const blob = new Blob([image], { type: "image/jpeg" });
    form.append("photo", blob, "screenshot.jpg");

    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: "POST",
      body: form,
    });
    const result = await res.json() as { ok: boolean; description?: string };
    if (!result.ok) {
      logger.error(`[telegram] sendPhoto failed: ${result.description}`);
      return false;
    }
    return true;
  } catch (e) {
    logger.error("[telegram] sendPhoto error:", (e as Error).message);
    return false;
  }
}

/** Download a Telegram-hosted file to ~/.lax/uploads, return the absolute path. */
export async function downloadTelegramFile(token: string, fileId: string, kind: string): Promise<string> {
  const info = await apiCall(token, "getFile", { file_id: fileId });
  if (!info.ok || !info.result?.file_path) throw new Error(info.description || "getFile failed");
  const remotePath: string = info.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${token}/${remotePath}`;
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { getLaxDir } = await import("../lax-data-dir.js");
  const uploadsDir = join(getLaxDir(), "uploads");
  mkdirSync(uploadsDir, { recursive: true });
  const ext = (remotePath.split(".").pop() || "bin").toLowerCase();
  const fname = `tg-${kind}-${Date.now()}.${ext}`;
  const fullPath = join(uploadsDir, fname);
  writeFileSync(fullPath, buf);
  return fullPath;
}
