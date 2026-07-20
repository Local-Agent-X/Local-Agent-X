import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkpointBridgeMedia, readBridgeMedia } from "../bridge-media-queue.js";
import { imageIsTextBearing } from "../tools/shared/image-binary-meta.js";
import { scanForSecrets } from "../security/secrets/secret-scanner.js";
import { checkCanariesInPayload } from "../threat/canaries.js";
import { checkAttachmentPaths } from "../tools/http-egress-guard.js";
import type { WhatsAppBridge } from "../whatsapp-bridge/index.js";
import type { TelegramBridge } from "../telegram-bridge/index.js";
import type { ChannelType } from "../session/router.js";
import { createLogger } from "../logger.js";

const logger = createLogger("server.bridge-media-forward");
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

interface ForwardOptions {
  canonicalOpId: string;
  channelType: ChannelType;
  platform: string;
  from: string;
  deliveryTarget?: string;
  sessionKey: string;
  getWhatsappBridge: () => WhatsAppBridge;
  getTelegramBridge: () => TelegramBridge;
}

async function notifyMediaBlocked(opts: ForwardOptions, reason: string): Promise<void> {
  const text = `Couldn't send the attached media: ${reason}`;
  const target = opts.deliveryTarget ?? opts.from;
  try {
    if (opts.channelType === "whatsapp") await opts.getWhatsappBridge().sendMessage(target, text);
    else if (opts.channelType === "telegram") await opts.getTelegramBridge().sendMessage(opts.from, text);
  } catch (error) {
    logger.warn(`[bridge] block-notice send failed: ${(error as Error).message}`);
  }
}

async function sendImage(image: Buffer, opts: ForwardOptions): Promise<boolean> {
  const view = image.toString("utf8");
  if (imageIsTextBearing(image) && !scanForSecrets(view).clean) {
    await notifyMediaBlocked(opts, "the outbound bytes contained a secret-shaped value");
    return true;
  }
  if (checkCanariesInPayload(opts.sessionKey, view)) {
    await notifyMediaBlocked(opts, "a security tripwire flagged possible context exfiltration");
    return true;
  }
  return opts.channelType === "whatsapp"
    ? opts.getWhatsappBridge().sendImage(opts.deliveryTarget ?? opts.from, image)
    : opts.getTelegramBridge().sendPhoto(opts.from, image);
}

export async function forwardBridgeMedia(opts: ForwardOptions): Promise<boolean> {
  const pending = readBridgeMedia(opts.canonicalOpId);
  if (!pending) return true;
  try {
    while (pending.images.length > 0) {
      if (!(await sendImage(pending.images[0], opts))) return false;
      pending.images.shift();
      checkpointBridgeMedia(opts.canonicalOpId, pending);
    }

    const seenImages = new Set<string>();
    while (pending.imagePaths.length > 0) {
      const path = pending.imagePaths[0];
      const absolute = resolve(path);
      if (!seenImages.has(absolute)) {
        seenImages.add(absolute);
        const blocked = checkAttachmentPaths(`bridge:${opts.platform} image forward`, [absolute]);
        if (blocked) {
          await notifyMediaBlocked(opts, "it was blocked by the outbound security gate");
        } else {
          let image: Buffer | null = null;
          try { image = readFileSync(absolute); }
          catch (error) { logger.warn(`[bridge:${opts.platform}] image read failed for ${path}: ${(error as Error).message}`); }
          if (image && image.length > IMAGE_MAX_BYTES) {
            await notifyMediaBlocked(opts, `the image is ${Math.round(image.length / 1048576)}MB, over the 10MB limit`);
          } else if (image && !(await sendImage(image, opts))) {
            return false;
          }
        }
      }
      pending.imagePaths.shift();
      checkpointBridgeMedia(opts.canonicalOpId, pending);
    }

    const maxBytes = opts.channelType === "whatsapp" ? 16 * 1024 * 1024 : 50 * 1024 * 1024;
    const seenVideos = new Set<string>();
    while (pending.videoPaths.length > 0) {
      const path = pending.videoPaths[0];
      const absolute = resolve(path);
      if (!seenVideos.has(absolute)) {
        seenVideos.add(absolute);
        const blocked = checkAttachmentPaths(`bridge:${opts.platform} video forward`, [absolute]);
        if (blocked) {
          await notifyMediaBlocked(opts, "it was blocked by the outbound security gate");
        } else {
          let video: Buffer | null = null;
          try { video = readFileSync(absolute); }
          catch (error) { logger.warn(`[bridge:${opts.platform}] video read failed for ${path}: ${(error as Error).message}`); }
          if (video && video.length > maxBytes) {
            await notifyMediaBlocked(opts, `the video is ${Math.round(video.length / 1048576)}MB, over the ${Math.round(maxBytes / 1048576)}MB limit`);
          } else if (video) {
            const sent = opts.channelType === "whatsapp"
              ? await opts.getWhatsappBridge().sendVideo(opts.deliveryTarget ?? opts.from, video)
              : await opts.getTelegramBridge().sendVideo(opts.from, video);
            if (!sent) return false;
          }
        }
      }
      pending.videoPaths.shift();
      checkpointBridgeMedia(opts.canonicalOpId, pending);
    }
    return true;
  } catch (error) {
    logger.warn(`[bridge:${opts.platform}] media forward failed: ${(error as Error).message}`);
    return false;
  }
}
