/**
 * YouTube Tool — fetch metadata + transcript from any YouTube URL.
 * Uses yt-dlp for reliable transcript extraction, with direct fetch fallback.
 * No API key required.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolDefinition, ToolResult } from "../types.js";
import { htmlToText } from "../app-renderer/sanitize.js";
import { wrapExternalContent } from "../sanitize.js";
import { BROWSER_ACCEPT_LANGUAGE, BROWSER_USER_AGENT, canonicalFetch, EgressRedirectBlocked, egressBlockedResult } from "./web-egress.js";

const execFileAsync = promisify(execFile);

const YT_DLP_INSTALL = "python -m pip install yt-dlp";

function ok(content: string, metadata?: Record<string, unknown>): ToolResult { return { content, metadata }; }
function err(content: string): ToolResult { return { content, isError: true }; }

/** Extract video ID from various YouTube URL formats */
function extractVideoId(input: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = input.match(p);
    if (m) return m[1];
  }
  return null;
}

/** Decode HTML entities and strip tags in caption text */
function decodeEntities(text: string): string {
  return htmlToText(text);
}

/** Format seconds as mm:ss or h:mm:ss */
function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
    : `${m}:${s.toString().padStart(2, "0")}`;
}

/** Parse XML transcript (srv1 format from yt-dlp or direct fetch) */
function parseTranscriptXml(xml: string): string | null {
  const segments: string[] = [];
  const regex = /<text\s+start="([^"]*)"[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const text = decodeEntities(match[2]);
    if (!text) continue;
    segments.push(`[${formatTimestamp(parseFloat(match[1]))}] ${text}`);
  }
  return segments.length > 0 ? segments.join("\n") : null;
}

let _ytDlpReady: boolean | null = null;

/** Whether yt-dlp is importable — checked once per process, never installed:
 *  a tool call must not run pip on the user's machine behind their back. */
async function ytDlpAvailable(): Promise<boolean> {
  if (_ytDlpReady !== null) return _ytDlpReady;
  try {
    await execFileAsync("python", ["-c", "import yt_dlp"], { timeout: 5_000, windowsHide: true });
    _ytDlpReady = true;
  } catch {
    _ytDlpReady = false;
  }
  return _ytDlpReady;
}

/** Fetch transcript via yt-dlp (most reliable); null when yt-dlp is absent. */
async function fetchTranscriptYtDlp(videoId: string): Promise<string | null> {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return null;
  if (!(await ytDlpAvailable())) return null;

  const outPath = join(tmpdir(), `oax_yt_${videoId}`);
  const subFile = `${outPath}.en.srv1`;
  try {
    if (existsSync(subFile)) unlinkSync(subFile);

    await execFileAsync("python", [
      "-m", "yt_dlp",
      "--write-auto-sub", "--sub-lang", "en",
      "--skip-download", "--sub-format", "srv1",
      "-o", outPath,
      `https://www.youtube.com/watch?v=${videoId}`,
    ], { timeout: 30_000, windowsHide: true, shell: process.platform === "win32" });

    if (existsSync(subFile)) {
      const xml = readFileSync(subFile, "utf-8");
      unlinkSync(subFile);
      return parseTranscriptXml(xml);
    }
  } catch { /* fall through */ }
  try { if (existsSync(subFile)) unlinkSync(subFile); } catch {}
  return null;
}

// Every fetch below goes through canonicalFetch: the web-access policy on the
// first hop (strict mode's allowlist), DNS pinning and the private-address
// block at connect, and every redirect re-checked. The caption URL comes out of
// the watch page's own JSON, so it is not trusted to name a YouTube host.

/** Fetch transcript via direct caption URL (fallback) */
async function fetchTranscriptDirect(captionUrl: string): Promise<string | null> {
  try {
    const res = await canonicalFetch(captionUrl, { timeoutMs: 15_000 });
    if (!res.ok) return null;
    const xml = await res.text();
    return xml.length > 0 ? parseTranscriptXml(xml) : null;
  } catch {
    return null;
  }
}

/** Fetch basic metadata via oEmbed */
async function fetchOEmbed(videoId: string) {
  const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
  const res = await canonicalFetch(url, { timeoutMs: 10_000 });
  if (!res.ok) return null;
  return await res.json() as { title: string; author_name: string; author_url: string };
}

/** Fetch full metadata from the watch page */
async function fetchPageData(videoId: string) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const res = await canonicalFetch(url, {
    headers: { "User-Agent": BROWSER_USER_AGENT, "Accept-Language": BROWSER_ACCEPT_LANGUAGE },
    timeoutMs: 15_000,
  });
  if (!res.ok) return null;
  const html = await res.text();

  const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return null;

  try {
    const pr = JSON.parse(m[1]);
    const vd = pr.videoDetails || {};
    const captions = pr.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

    return {
      title: vd.title || "",
      author: vd.author || "",
      lengthSeconds: vd.lengthSeconds || "",
      viewCount: vd.viewCount || "",
      description: vd.shortDescription || "",
      keywords: vd.keywords || [],
      captionTracks: captions.map((t: any) => ({
        baseUrl: t.baseUrl,
        lang: t.languageCode,
        kind: t.kind || "",
      })),
    };
  } catch {
    return null;
  }
}

export const youtubeAnalyzeTool: ToolDefinition = {
  name: "youtube_analyze",
  description:
    "ALWAYS use this for any YouTube URL or video ID — never web_fetch the watch page. " +
    "Returns title, channel, duration, view count, description, and the ENGLISH timestamped transcript " +
    "(manual or auto-generated captions; other languages are not fetched). A result too long for the context " +
    "is cut to fit, with the whole of it saved to a file the result names (grep it, or read it with offset/limit). " +
    "Accepts youtube.com/watch?v=, youtu.be/, youtube.com/shorts/, embeds, or a bare 11-char video ID. " +
    `Transcripts come from yt-dlp when it is installed (${YT_DLP_INSTALL} — this tool never installs it), ` +
    "else from the watch page's own caption URL.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "YouTube URL or video ID",
      },
    },
    required: ["url"],
  },
  async execute(args) {
    const input = String(args.url).trim();
    const videoId = extractVideoId(input);
    if (!videoId) {
      return err(`Could not extract a YouTube video ID from: ${input}`);
    }

    // Fetch metadata + transcript in parallel. A refusal by web access is kept,
    // so the user is offered the host to allow instead of "unavailable".
    let blocked = null as EgressRedirectBlocked | null;
    const keepBlock = (e: unknown): null => {
      if (!blocked && e instanceof EgressRedirectBlocked && e.action) blocked = e;
      return null;
    };
    const [pageData, oembed, ytdlpTranscript] = await Promise.all([
      fetchPageData(videoId).catch(keepBlock),
      fetchOEmbed(videoId).catch(keepBlock),
      fetchTranscriptYtDlp(videoId).catch(() => null),
    ]);

    if (!pageData && !oembed) {
      if (blocked) return egressBlockedResult(blocked, "Ask the user for the video's details");
      return err(`Failed to fetch video data for ${videoId}. The video may be private, age-restricted, or unavailable.`);
    }

    const title = pageData?.title || oembed?.title || "Unknown";
    const author = pageData?.author || oembed?.author_name || "Unknown";
    const description = pageData?.description || "";
    const viewCount = pageData?.viewCount || "";
    const lengthSeconds = pageData?.lengthSeconds || "";
    const keywords = pageData?.keywords || [];

    // Use yt-dlp transcript, or try direct fetch as fallback
    let transcript = ytdlpTranscript;
    if (!transcript && pageData?.captionTracks?.length) {
      const tracks = pageData.captionTracks;
      const pick =
        tracks.find((t: any) => t.lang === "en" && t.kind !== "asr") ||
        tracks.find((t: any) => t.lang?.startsWith("en")) ||
        tracks[0];
      if (pick?.baseUrl) {
        transcript = await fetchTranscriptDirect(pick.baseUrl);
      }
    }

    // Build output
    const parts: string[] = [`# ${title}`, `**Channel:** ${author}`];
    if (lengthSeconds) parts.push(`**Duration:** ${formatTimestamp(parseInt(lengthSeconds))}`);
    if (viewCount) parts.push(`**Views:** ${parseInt(viewCount).toLocaleString()}`);
    if (keywords.length) parts.push(`**Keywords:** ${keywords.slice(0, 15).join(", ")}`);
    parts.push("", `## Description`, description);

    if (transcript) {
      parts.push("", `## Transcript`, transcript);
    } else {
      parts.push("", `_No English transcript/captions available for this video._`);
    }

    // Title, description and transcript are the uploader's words: wrapped, so a
    // video that reads out instructions is quoted, not obeyed. The note is this
    // tool's own, and leads: the audit phase's cap (the one result limit,
    // result-spill.ts) cuts a long transcript from the end.
    const wrapped = wrapExternalContent(parts.join("\n"), "youtube_analyze", { url: `https://www.youtube.com/watch?v=${videoId}` });
    const note = !ytdlpTranscript && _ytDlpReady === false
      ? `yt-dlp is not installed, so only the watch page's caption URL was tried. For reliable transcripts install it: ${YT_DLP_INSTALL}\n\n`
      : "";
    return ok(note + wrapped, {
      videoId, transcript: transcript ? (ytdlpTranscript ? "yt-dlp" : "caption-url") : "none",
    });
  },
};
