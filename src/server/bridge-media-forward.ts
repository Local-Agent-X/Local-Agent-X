import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { scanForSecrets } from "../security/secret-scanner.js";
import { checkCanariesInPayload } from "../threat/canaries.js";
import { imageIsTextBearing } from "../tools/shared/image-binary-meta.js";
import { checkAttachmentPaths } from "../tools/http-egress-guard.js";
import { drainBridgeMedia } from "../bridge-media-queue.js";
import type { WhatsAppBridge } from "../whatsapp-bridge/index.js";
import type { TelegramBridge } from "../telegram-bridge/index.js";
import type { ChannelType } from "../session/router.js";
import { createLogger } from "../logger.js";

const logger = createLogger("server.bridge-media-forward");

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * When outbound media is blocked (egress/secret/canary) or rejected (oversize),
 * the turn has already ended and the model's "here's your video!" text has
 * shipped — but the media hasn't. Send a one-line text notice over the SAME
 * bridge so the user isn't left waiting on media that will never arrive. Best
 * effort: a failed notice must not mask the original block.
 */
async function notifyMediaBlocked(opts: {
  channelType: ChannelType;
  from: string;
  reason: string;
  getWhatsappBridge: () => WhatsAppBridge;
  getTelegramBridge: () => TelegramBridge;
}): Promise<void> {
  const text = `Couldn't send the attached media: ${opts.reason}`;
  try {
    if (opts.channelType === "whatsapp") {
      await opts.getWhatsappBridge().sendMessage(opts.from, text);
    } else if (opts.channelType === "telegram") {
      await opts.getTelegramBridge().sendMessage(opts.from, text);
    }
  } catch (e) {
    logger.warn(`[bridge] block-notice send failed: ${(e as Error).message}`);
  }
}

/**
 * Forward a turn's tool-emitted media to the bridge user. The dispatcher hands
 * media to the bridge-media-queue at dispatch time (keyed by op id); we drain it
 * here. This does NOT re-read op_messages — bridge turns don't persist fresh
 * tool results with their media envelope, so that re-read found nothing and
 * silently dropped every photo/video. Images (inline vision bytes + send_image
 * file paths) merge into one buffer list through the same secret-scan/canary/
 * send; videos forward by path with a per-channel size guard.
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
  const pending = drainBridgeMedia(canonicalOpId);
  if (!pending) return;
  try {
    const images: Buffer[] = [...pending.images];
    const { imagePaths, videoPaths } = pending;
    // send_image (and any _media:{kind:"image"}) rides a file PATH like video.
    // Re-gate + read each into the SAME image buffer list the inline vision
    // bytes use, so it flows through the identical secret-scan/canary + send
    // path below — one image-forward, not a parallel one.
    const sentImagePaths = new Set<string>();
    for (const p of imagePaths) {
      const abs = resolve(p);
      if (sentImagePaths.has(abs)) continue;
      sentImagePaths.add(abs);
      const att = checkAttachmentPaths(`bridge:${platform} image forward`, [abs]);
      if (att) {
        logger.error(`[bridge:${platform}] BLOCKED image forward to ${from}: ${att.message}`);
        await notifyMediaBlocked({ channelType, from, reason: "it was blocked by the outbound security gate", getWhatsappBridge, getTelegramBridge });
        continue;
      }
      try {
        const buf = readFileSync(abs);
        if (buf.length > IMAGE_MAX_BYTES) {
          logger.warn(`[bridge:${platform}] image ${p} is ${Math.round(buf.length / 1048576)}MB, over the 10MB limit — not sending`);
          await notifyMediaBlocked({ channelType, from, reason: `the image is ${Math.round(buf.length / 1048576)}MB, over the 10MB limit`, getWhatsappBridge, getTelegramBridge });
          continue;
        }
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
          await notifyMediaBlocked({ channelType, from, reason: "the outbound bytes contained a secret-shaped value", getWhatsappBridge, getTelegramBridge });
          continue;
        }
        if (checkCanariesInPayload(sessionKey, view)) {
          logger.error(`[bridge:${platform}] BLOCKED image forward to ${from}: a session canary token was detected in the outbound image bytes (context exfiltration)`);
          await notifyMediaBlocked({ channelType, from, reason: "a security tripwire flagged possible context exfiltration", getWhatsappBridge, getTelegramBridge });
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
        await notifyMediaBlocked({ channelType, from, reason: "it was blocked by the outbound security gate", getWhatsappBridge, getTelegramBridge });
        continue;
      }
      try {
        const buf = readFileSync(abs);
        if (buf.length > maxBytes) {
          logger.warn(`[bridge:${platform}] video ${path} is ${Math.round(buf.length / 1048576)}MB, over the ${Math.round(maxBytes / 1048576)}MB limit — not sending`);
          await notifyMediaBlocked({ channelType, from, reason: `the video is ${Math.round(buf.length / 1048576)}MB, over the ${Math.round(maxBytes / 1048576)}MB limit`, getWhatsappBridge, getTelegramBridge });
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
