import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { scanForSecrets } from "../security/secret-scanner.js";
import { checkCanariesInPayload } from "../threat/canaries.js";
import { imageIsTextBearing } from "../tools/shared/image-binary-meta.js";
import { checkAttachmentPaths } from "../tools/http-egress-guard.js";
import type { WhatsAppBridge } from "../whatsapp-bridge/index.js";
import type { TelegramBridge } from "../telegram-bridge/index.js";
import type { ChannelType } from "../session/router.js";
import { createLogger } from "../logger.js";

const logger = createLogger("server.bridge-media-forward");

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Forward a turn's EXPLICITLY-delivered media to the bridge user. Delivery is
 * envelope-gated: only `_media:{kind,path}` is forwarded (send_image,
 * send_video, generate_image, generate_video). The `_image` bytes that vision/
 * "look" tools emit (screen_capture, view_image, camera_capture) feed the model
 * but are NOT delivered — otherwise every internal screen-peek would be pushed
 * to the user. Images forward by reading the file (secret-scan/canary/send);
 * videos by path with a per-channel size guard. Extracted from bootstrap-bridges
 * to keep that file under the size limit.
 */
export async function forwardBridgeMedia(opts: {
  canonicalOpId: string;
  channelType: ChannelType;
  platform: string;
  from: string;
  sessionKey: string;
  getWhatsappBridge: () => WhatsAppBridge;
  getTelegramBridge: () => TelegramBridge;
}): Promise<void> {
  const { canonicalOpId, channelType, platform, from, sessionKey, getWhatsappBridge, getTelegramBridge } = opts;
  try {
    const { readOpMessages } = await import("../canonical-loop/store.js");
    const images: Buffer[] = [];
    const imagePaths: string[] = [];
    const videoPaths: string[] = [];
    for (const row of readOpMessages(canonicalOpId)) {
      if (row.role !== "tool_result") continue;
      const r = (row.content as { result?: unknown })?.result;
      if (!r || typeof r !== "object") continue;
      const media = (r as { media?: { kind?: string; path?: string } }).media;
      if (media && typeof media.path === "string") {
        if (media.kind === "video") videoPaths.push(media.path);
        else if (media.kind === "image") imagePaths.push(media.path);
      }
    }
    // _media:{kind:"image"} rides a file PATH (like video). Re-gate + read each
    // into the image buffer list so it flows through the secret-scan/canary +
    // send path below.
    const sentImagePaths = new Set<string>();
    for (const p of imagePaths) {
      const abs = resolve(p);
      if (sentImagePaths.has(abs)) continue;
      sentImagePaths.add(abs);
      const att = checkAttachmentPaths(`bridge:${platform} image forward`, [abs]);
      if (att) { logger.error(`[bridge:${platform}] BLOCKED image forward to ${from}: ${att.message}`); continue; }
      try {
        const buf = readFileSync(abs);
        if (buf.length > IMAGE_MAX_BYTES) { logger.warn(`[bridge:${platform}] image ${p} is ${Math.round(buf.length / 1048576)}MB, over the 10MB limit — not sending`); continue; }
        images.push(buf);
      } catch (e) { logger.warn(`[bridge:${platform}] image read failed for ${p}: ${(e as Error).message}`); }
    }
    if (images.length > 0) {
      logger.info(`[bridge:${platform}] sending ${images.length} image(s) to ${from}`);
      for (const img of images) {
        // Re-gate the BYTES about to leave the box (egress output-bytes, R4-12b).
        // Only the text secret-scan when text-bearing: a genuine raster image
        // (PNG/JPEG/GIF/WebP) is not text, so credential/entropy scans over its
        // bytes only false-positive. The renamed-text / SVG-with-token threat
        // stays scanned (detectMime → svg/null); the canary tripwire runs always.
        const view = img.toString("utf-8");
        if (imageIsTextBearing(img) && !scanForSecrets(view).clean) {
          logger.error(`[bridge:${platform}] BLOCKED image forward to ${from}: outbound bytes contain a secret-shaped value`);
          continue;
        }
        if (checkCanariesInPayload(sessionKey, view)) {
          logger.error(`[bridge:${platform}] BLOCKED image forward to ${from}: a session canary token was detected in the outbound image bytes (context exfiltration)`);
          continue;
        }
        if (channelType === "whatsapp") {
          await getWhatsappBridge().sendImage(from, img).catch((e: Error) => logger.error(`[whatsapp] image send failed: ${e.message}`));
        } else if (channelType === "telegram") {
          await getTelegramBridge().sendPhoto(from, img).catch((e: Error) => logger.error(`[telegram] photo send failed: ${e.message}`));
        }
      }
    }
    // Videos forward by PATH — read off disk, size-guard, send. Dedupe on the
    // resolved path: the model commonly calls generate_video (auto-forwards) AND
    // send_video on the same file, emitted in different forms (relative/absolute).
    const maxBytes = channelType === "whatsapp" ? 16 * 1024 * 1024 : 50 * 1024 * 1024;
    const sentVideos = new Set<string>();
    for (const path of videoPaths) {
      const abs = resolve(path);
      if (sentVideos.has(abs)) continue;
      sentVideos.add(abs);
      // Re-gate the exact path about to ship off-box (egress output-bytes,
      // R4-12b) — closes the path TOCTOU vs the pre-dispatch INPUT-arg gate.
      const att = checkAttachmentPaths(`bridge:${platform} video forward`, [abs]);
      if (att) {
        logger.error(`[bridge:${platform}] BLOCKED video forward to ${from}: ${att.message}`);
        continue;
      }
      try {
        const buf = readFileSync(abs);
        if (buf.length > maxBytes) {
          logger.warn(`[bridge:${platform}] video ${path} is ${Math.round(buf.length / 1048576)}MB, over the ${Math.round(maxBytes / 1048576)}MB limit — not sending`);
          continue;
        }
        logger.info(`[bridge:${platform}] sending video (${Math.round(buf.length / 1048576)}MB) to ${from}`);
        if (channelType === "whatsapp") {
          await getWhatsappBridge().sendVideo(from, buf).catch((e: Error) => logger.error(`[whatsapp] video send failed: ${e.message}`));
        } else if (channelType === "telegram") {
          await getTelegramBridge().sendVideo(from, buf).catch((e: Error) => logger.error(`[telegram] video send failed: ${e.message}`));
        }
      } catch (e) {
        logger.warn(`[bridge:${platform}] video read/send failed for ${path}: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    logger.warn(`[bridge:${platform}] media scan failed: ${(e as Error).message}`);
  }
}
