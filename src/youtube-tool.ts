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
import type { ToolDefinition, ToolResult } from "./types.js";

const execFileAsync = promisify(execFile);

function ok(content: string): ToolResult { return { content }; }
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

/** Decode HTML entities in caption text */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, "")
    .trim();
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

/** Ensure yt-dlp is importable; install once per process if missing. */
async function ensureYtDlp(): Promise<boolean> {
  if (_ytDlpReady !== null) return _ytDlpReady;
  try {
    await execFileAsync("python", ["-c", "import yt_dlp"], { timeout: 5_000, windowsHide: true });
    _ytDlpReady = true;
    return true;
  } catch {
    try {
      await execFileAsync("python", ["-m", "pip", "install", "--quiet", "--upgrade", "yt-dlp"], {
        timeout: 60_000, windowsHide: true,
      });
      await execFileAsync("python", ["-c", "import yt_dlp"], { timeout: 5_000, windowsHide: true });
      _ytDlpReady = true;
      return true;
    } catch {
      _ytDlpReady = false;
      return false;
    }
  }
}

/** Fetch transcript via yt-dlp (most reliable) */
async function fetchTranscriptYtDlp(videoId: string): Promise<string | null> {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return null;
  if (!(await ensureYtDlp())) return null;

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

/** Fetch transcript via direct caption URL (fallback) */
async function fetchTranscriptDirect(captionUrl: string): Promise<string | null> {
  try {
    const res = await fetch(captionUrl, { signal: AbortSignal.timeout(15_000) });
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
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  return await res.json() as { title: string; author_name: string; author_url: string };
}

/** Fetch full metadata from the watch page */
async function fetchPageData(videoId: string) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(15_000),
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
    "Returns title, channel, duration, view count, description, and full timestamped transcript. " +
    "Accepts youtube.com/watch?v=, youtu.be/, youtube.com/shorts/, embeds, or a bare 11-char video ID. " +
    "Uses yt-dlp (auto-installed via python -m yt_dlp) with a direct caption-URL fallback.",
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

    // Fetch metadata + transcript in parallel
    const [pageData, oembed, ytdlpTranscript] = await Promise.all([
      fetchPageData(videoId).catch(() => null),
      fetchOEmbed(videoId).catch(() => null),
      fetchTranscriptYtDlp(videoId).catch(() => null),
    ]);

    if (!pageData && !oembed) {
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
      parts.push("", `_No transcript/captions available for this video._`);
    }

    const output = parts.join("\n");
    const MAX = 80_000;
    if (output.length > MAX) {
      return ok(output.slice(0, MAX) + "\n\n[Transcript truncated]");
    }
    return ok(output);
  },
};
