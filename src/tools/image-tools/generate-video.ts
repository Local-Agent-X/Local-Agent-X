import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getLaxDir } from "../../lax-data-dir.js";
import type { ToolDefinition, ToolResult } from "../../types.js";
import { createLogger } from "../../logger.js";
import { getRuntimeConfig } from "../../config.js";
import { ok, err, getActiveProvider, findRecentLocalImage, PROMPT_REFS_EARLIER_IMAGE } from "./shared.js";

const xaiLogger = createLogger("image-tools.xai");

/** Video generation server URL — configurable via config.videoServerUrl */
function getVideoServerUrl(): string { return getRuntimeConfig().videoServerUrl; }

/** Generate video via xAI Grok Imagine (text-to-video, async polling).
 *  POST /v1/videos/generations returns { request_id }, then we poll
 *  GET /v1/videos/{request_id} until status=done. Final body has the
 *  video URL, which we fetch and save as MP4. */
async function generateViaXaiVideo(
  prompt: string,
  apiKey: string,
  duration: number,
  referenceImageUrls?: string[],
): Promise<ToolResult> {
  const headers = { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` };

  // Resolve a single reference-image string into an absolute filesystem
  // path if it matches any known local shape. xAI's backend can't reach
  // 127.0.0.1 loopback URLs, so anything local gets inlined as base64.
  // Accepted shapes:
  //   /images/foo.png            (chat tool-result URL)
  //   /uploads/foo.png           (user-attached upload URL)
  //   workspace/images/foo.png   (generated path Grok sometimes echoes)
  //   workspace/uploads/foo.png  (rare but seen)
  //   bare filename in workspace/images/  (Grok hallucinates these)
  const resolveLocal = (u: string): string | null => {
    const m =
      u.match(/(?:^\/images\/|^workspace\/images\/)([A-Za-z0-9._-]+)/) ||
      u.match(/(?:^\/uploads\/|^workspace\/uploads\/)([A-Za-z0-9._-]+)/);
    if (m) {
      const fname = m[1];
      const fromImages = join("workspace", "images", fname);
      if (existsSync(fromImages)) return fromImages;
      const fromUploads = join(getLaxDir(), "uploads", fname);
      if (existsSync(fromUploads)) return fromUploads;
    }
    return null;
  };
  const fileToBase64Ref = (filePath: string) => {
    const ext = (filePath.split(/[.]/).pop() || "png").toLowerCase();
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
    const b64 = readFileSync(filePath).toString("base64");
    return { url: `data:${mime};base64,${b64}`, source: filePath };
  };

  // Normalize. Grok's tool-call sometimes serializes an array as a
  // JSON-encoded string ("[\"foo.png\"]") instead of a real array —
  // unwrap already happened in the caller; here we just iterate.
  const refs: Array<{ url: string }> = [];
  const refSources: string[] = []; // for telemetry in the result
  for (const raw of referenceImageUrls || []) {
    const u = (raw || "").trim();
    if (!u) continue;
    const local = resolveLocal(u);
    if (local) {
      const { url, source } = fileToBase64Ref(local);
      refs.push({ url });
      refSources.push(source);
      continue;
    }
    // External http(s) URL or unknown shape — pass through and let xAI decide.
    refs.push({ url: u });
    refSources.push(u);
  }

  // Layer 3: if Grok passed no refs but the prompt references "this photo /
  // the image / her" etc., fall back to the most recent local image. This
  // is the safety net for Grok-4's unreliable tool-use — when it forgets
  // to thread the attached image into a follow-up generate_video call.
  let usedFallback = false;
  if (refs.length === 0 && PROMPT_REFS_EARLIER_IMAGE.test(prompt)) {
    const recent = findRecentLocalImage();
    if (recent) {
      const { url, source } = fileToBase64Ref(recent);
      refs.push({ url });
      refSources.push(source);
      usedFallback = true;
      xaiLogger.info(`[xai-video] auto-using recent local image as ref: ${recent}`);
    }
  }
  // Reference-image path caps at 10s per xAI's docs.
  const clamped = Math.max(1, Math.min(refs.length > 0 ? 10 : 15, Math.floor(duration)));

  const body: Record<string, unknown> = {
    model: "grok-imagine-video",
    prompt,
    duration: clamped,
  };
  if (refs.length > 0) body.reference_images = refs;

  xaiLogger.info(`[xai-video] submitting prompt="${prompt.slice(0, 80)}" duration=${clamped} refs=${refs.length}`);
  const submit = await fetch("https://api.x.ai/v1/videos/generations", {
    method: "POST",
    headers: { ...headers, "x-idempotency-key": randomUUID() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!submit.ok) {
    const errText = await submit.text();
    xaiLogger.error(`[xai-video] SUBMIT FAILED (${submit.status}): ${errText.slice(0, 500)}`);
    return err(`xAI video submit failed (${submit.status}): ${errText.slice(0, 300)}`);
  }
  const submitted = await submit.json() as { request_id?: string };
  const requestId = submitted.request_id;
  if (!requestId) return err("xAI video response missing request_id");

  // Poll for completion — Grok Imagine videos run ~60-240s.
  const deadline = Date.now() + 6 * 60 * 1000;
  let videoUrl: string | null = null;
  let lastStatus = "queued";
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    const poll = await fetch(`https://api.x.ai/v1/videos/${requestId}`, {
      headers, signal: AbortSignal.timeout(30_000),
    });
    if (!poll.ok) {
      const errText = await poll.text();
      return err(`xAI video poll failed (${poll.status}): ${errText.slice(0, 300)}`);
    }
    const pollBody = await poll.json() as {
      status?: string;
      video?: { url?: string };
      url?: string;
      error?: string | { message?: string };
      failure_reason?: string;
      message?: string;
    };
    lastStatus = (pollBody.status || "").toLowerCase();
    if (lastStatus === "done") { videoUrl = pollBody.video?.url || pollBody.url || null; break; }
    if (["failed", "error", "expired", "cancelled"].includes(lastStatus)) {
      const reason =
        (typeof pollBody.error === "string" ? pollBody.error : pollBody.error?.message) ||
        pollBody.failure_reason ||
        pollBody.message ||
        "no reason returned by xAI";
      xaiLogger.error(`[xai-video] STATUS=${lastStatus} reason=${reason} request=${requestId} full=${JSON.stringify(pollBody).slice(0, 800)}`);
      return err(`xAI video generation ${lastStatus} (${reason}). request=${requestId}`);
    }
  }
  if (!videoUrl) return err(`xAI video generation timed out (last status: ${lastStatus})`);

  const vidRes = await fetch(videoUrl, { signal: AbortSignal.timeout(60_000) });
  if (!vidRes.ok) return ok(`Video generated!\nPrompt: ${prompt}\nView: ${videoUrl}\n(Could not save locally)`);
  const buffer = Buffer.from(await vidRes.arrayBuffer());
  const videosDir = join("workspace", "videos");
  if (!existsSync(videosDir)) mkdirSync(videosDir, { recursive: true });
  const filename = `grok_${Date.now()}.mp4`;
  const savePath = join(videosDir, filename);
  writeFileSync(savePath, buffer);

  // Telemetry: always say whether a reference image was used, where it
  // came from, and whether it was the auto-fallback. Grok needs to see
  // this so it can correctly report to the user (and if the wrong image
  // got auto-picked, the user can correct on the next turn).
  const refLine = refSources.length > 0
    ? `Reference image used: ${refSources.join(", ")}${usedFallback ? " (auto-selected from chat — Grok did not pass it explicitly)" : ""}`
    : `Reference image used: none (text-to-video only)`;

  return ok(
    `Video generated via Grok Imagine!\n` +
    `Prompt: ${prompt}\n` +
    `Duration: ${clamped}s\n` +
    `${refLine}\n` +
    `Saved: ${savePath}\n` +
    `View: /videos/${filename}`
  );
}

export const generateVideoTool: ToolDefinition = {
  name: "generate_video",
  description:
    "Generate a short video from a text prompt. When provider=xai with credentials, uses xAI Grok Imagine " +
    "(text-to-video, ~60-240s, up to 15s duration, optional reference images). Otherwise falls back to local CogVideoX " +
    "(must be running on port 7861, ~6 second outputs). Videos saved as MP4.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Detailed text description of the video to generate",
      },
      num_frames: {
        type: "number",
        description: "Number of frames (default 49 = ~6 seconds at 8fps, max 81) — local CogVideoX only",
      },
      steps: {
        type: "number",
        description: "Inference steps (default 50, more = higher quality but slower) — local CogVideoX only",
      },
      duration: {
        type: "number",
        description: "Seconds (1-15, capped at 10 if reference_images supplied). xAI Grok Imagine only. Default 8.",
      },
      reference_images: {
        type: "array",
        items: { type: "string" },
        description: "Up to 7 reference image URLs for style/character guidance. xAI Grok Imagine only.",
      },
    },
    required: ["prompt"],
  },
  async execute(args) {
    const prompt = String(args.prompt || "");
    if (!prompt.trim()) return err("Prompt is required.");

    // Try xAI Grok Imagine first when provider=xai and creds are configured.
    const { provider, apiKey } = await getActiveProvider();
    if (provider === "xai" && apiKey) {
      try {
        // Grok-4 sometimes sends reference_images as a JSON-encoded string
        // instead of a real array ("[\"foo.png\"]"). Parse both shapes so
        // either survives. Single string → treat as one ref. Anything
        // unparseable → no refs.
        let refs: string[] | undefined;
        const rawRefs = args.reference_images;
        if (Array.isArray(rawRefs)) {
          refs = rawRefs.map(String);
        } else if (typeof rawRefs === "string" && rawRefs.trim()) {
          const t = rawRefs.trim();
          if (t.startsWith("[")) {
            try {
              const parsed = JSON.parse(t);
              if (Array.isArray(parsed)) refs = parsed.map(String);
            } catch { /* fall through */ }
          }
          if (!refs) refs = [t];
        }
        const dur = Number(args.duration) || 8;
        return await generateViaXaiVideo(prompt, apiKey, dur, refs);
      } catch (e) {
        // Fall through to local CogVideoX on xAI failure — gives the user
        // a working fallback if SuperGrok hits the 403 allowlist gate.
        const msg = (e as Error).message;
        if (!/timeout|aborted/i.test(msg)) {
          return err(`xAI video generation failed: ${msg}`);
        }
      }
    }

    const numFrames = Math.min(81, Math.max(17, Number(args.num_frames) || 49));
    const steps = Math.min(80, Math.max(20, Number(args.steps) || 50));

    // Check if video server is running
    try {
      const healthRes = await fetch(`${getVideoServerUrl()}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!healthRes.ok) throw new Error("not ok");
    } catch {
      return err(
        "Video server is not running.\n" +
        "Start it with bash: python workspace/sd-server/video-server.py\n" +
        "(First run downloads CogVideoX model ~4GB, takes a few minutes)"
      );
    }

    try {
      const res = await fetch(`${getVideoServerUrl()}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, num_frames: numFrames, steps }),
        signal: AbortSignal.timeout(300_000), // 5 min timeout — video gen is slow
      });

      if (!res.ok) {
        const errBody = await res.text();
        return err(`Video generation failed: ${errBody.slice(0, 300)}`);
      }

      const data = (await res.json()) as {
        filename: string;
        path: string;
        size: number;
        frames: number;
        prompt: string;
      };

      const localUrl = `http://127.0.0.1:${getRuntimeConfig().port}/videos/${data.filename}`;

      return ok(
        `Video generated!\n` +
        `Prompt: ${prompt}\n` +
        `Frames: ${data.frames} (~${Math.round(data.frames / 8)}s at 8fps)\n` +
        `Size: ${Math.round(data.size / 1024)}KB\n` +
        `View: ${localUrl}\n` +
        `Saved: workspace/videos/${data.filename}`
      );
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("timeout")) {
        return err("Video generation timed out (>5 min). Try fewer frames or steps.");
      }
      return err(`Video generation failed: ${msg}`);
    }
  },
};
