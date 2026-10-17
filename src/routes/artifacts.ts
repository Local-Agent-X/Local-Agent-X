/**
 * Artifacts route — GET /api/artifacts
 *
 * Scans persisted chat sessions and extracts the artifacts they produced or
 * touched: images, videos, files (paths the agent read/wrote), and links
 * (URLs fetched or cited). Powers the Artifacts tab in the right sidebar.
 *
 * Extraction is server-side (never ship whole transcripts to the browser)
 * and cached per session keyed on updatedAt, so repeat requests only re-scan
 * sessions that actually changed.
 */
import type { RouteHandler } from "../server-context.js";
import { jsonResponse } from "../server-utils.js";
import { isSyntheticSessionId } from "../memory/synthetic-sessions.js";
import { declaredPaths, pathSpecsForCall } from "../tool-registry.js";

export interface ArtifactItem {
  /** image | video | file | link */
  type: string;
  /** Display name (filename or link title) */
  name: string;
  /** Path or URL. Refs starting with /images|/videos|/uploads|/files are servable via static-assets. */
  ref: string;
  sessionId: string;
  sessionTitle: string;
  /** Session updatedAt (per-message timestamps are not persisted in the rich form) */
  ts: number;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|avi|mkv|m4v)$/i;

/** The files a call opened, from the paths its row declares; a search root
 *  (glob, grep) is a directory, not an artifact. */
function callFilePaths(name: string, args: Record<string, unknown>): string[] {
  return pathSpecsForCall(name, args).filter((spec) => !spec.searchRoot).flatMap((spec) => declaredPaths(args, spec) ?? []);
}

/** Served-media breadcrumbs embedded in tool-result text ("View: /images/x.png"). */
const SERVED_MEDIA_RE = /\/(?:images|videos|uploads)\/[A-Za-z0-9._%-]+/g;
/** Markdown links in assistant prose: [title](https://…) */
const MD_LINK_RE = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g;
/** Bare URLs in assistant prose. */
const BARE_URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

function classifyPath(p: string): string {
  if (IMAGE_EXT.test(p)) return "image";
  if (VIDEO_EXT.test(p)) return "video";
  return "file";
}

function baseName(p: string): string {
  const clean = p.replace(/[\\/]+$/, "");
  const idx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

function trimUrl(u: string): string {
  return u.replace(/[.,;:!?]+$/, "");
}

/** Flatten string-or-parts message content to text; collect /uploads image parts. */
function contentText(content: unknown, onUpload: (url: string) => void): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (typeof p.text === "string") out += p.text + "\n";
    const img = p.image_url as Record<string, unknown> | undefined;
    if (img && typeof img.url === "string" && img.url.startsWith("/uploads/")) onUpload(img.url);
  }
  return out;
}

interface ScanMessage {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
}

export function extractSessionArtifacts(
  messages: ScanMessage[],
  meta: { id: string; title: string; updatedAt: number },
): ArtifactItem[] {
  const seen = new Set<string>();
  const items: ArtifactItem[] = [];
  const add = (type: string, name: string, ref: string) => {
    const key = type + "\0" + ref;
    if (seen.has(key) || !ref) return;
    seen.add(key);
    items.push({ type, name, ref, sessionId: meta.id, sessionTitle: meta.title, ts: meta.updatedAt });
  };

  for (const m of messages) {
    for (const tc of m.tool_calls || []) {
      const name = tc.function?.name || "";
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { /* malformed args — skip */ }
      for (const p of callFilePaths(name, args)) add(classifyPath(p), baseName(p), p);
      if (name === "web_fetch" && typeof args.url === "string" && args.url.startsWith("http")) {
        add("link", args.url.replace(/^https?:\/\//, ""), trimUrl(args.url));
      }
    }

    const text = contentText(m.content, url => add("image", baseName(url), url));
    if (!text) continue;

    if (m.role === "tool") {
      // Media breadcrumbs only — tool dumps are too noisy for link harvesting.
      for (const match of text.match(SERVED_MEDIA_RE) || []) {
        add(classifyPath(match), baseName(match), match);
      }
      continue;
    }
    if (m.role === "assistant") {
      for (const match of text.match(SERVED_MEDIA_RE) || []) {
        add(classifyPath(match), baseName(match), match);
      }
      MD_LINK_RE.lastIndex = 0;
      let md: RegExpExecArray | null;
      const mdUrls = new Set<string>();
      while ((md = MD_LINK_RE.exec(text)) !== null) {
        const url = trimUrl(md[2]);
        mdUrls.add(url);
        add("link", md[1], url);
      }
      for (const raw of text.match(BARE_URL_RE) || []) {
        const url = trimUrl(raw);
        if (!mdUrls.has(url)) add("link", url.replace(/^https?:\/\//, ""), url);
      }
    }
  }
  return items;
}

// Per-session scan cache: only re-read sessions whose updatedAt moved.
const scanCache = new Map<string, { updatedAt: number; items: ArtifactItem[] }>();
const MAX_ITEMS = 1000;

export const handleArtifactRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  if (method !== "GET" || url.pathname !== "/api/artifacts") return false;
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  const metas = ctx.sessionStore.list().filter(s => !isSyntheticSessionId(s.id));
  const all: ArtifactItem[] = [];
  for (const meta of metas) {
    const cached = scanCache.get(meta.id);
    if (cached && cached.updatedAt === meta.updatedAt) {
      all.push(...cached.items);
      continue;
    }
    const session = ctx.sessionStore.load(meta.id);
    if (!session) continue;
    const items = extractSessionArtifacts(
      session.messages as ScanMessage[],
      { id: meta.id, title: meta.title, updatedAt: meta.updatedAt },
    );
    scanCache.set(meta.id, { updatedAt: meta.updatedAt, items });
    all.push(...items);
  }
  // Drop cache entries for deleted sessions so they can't leak stale rows.
  const live = new Set(metas.map(m => m.id));
  for (const id of scanCache.keys()) if (!live.has(id)) scanCache.delete(id);

  all.sort((a, b) => b.ts - a.ts);
  json(200, { artifacts: all.slice(0, MAX_ITEMS), total: all.length });
  return true;
};
