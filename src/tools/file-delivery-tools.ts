// send_file — deliver a document from this PC to the user's device.
//
// The mobile app can only fetch what the agent explicitly STAGES: the tool
// copies the validated file into ~/.lax/uploads (served at /uploads/, the only
// file prefix on the phone tunnel's allowlist — device-paths.ts) and returns
// the /uploads ref in its result text, which the phone renders as a tappable
// file card. The workspace-wide /files/ route stays OFF the phone allowlist by
// design; this tool is the narrow, per-file grant in between.
//
// Sibling of send_image/send_video (vision-tools.ts) and registered in the
// same egress capability class: policy + registry + ARI map + local-only +
// refutation pack (build-enforced, capability-class-gates.test.ts).

import { closeSync, copyFileSync, existsSync, fstatSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import type { ToolDefinition } from "../types.js";
import { createLogger } from "../logger.js";
import { openValidatedRead, readValidatedFile } from "../security/layer/index.js";
import { getLaxDir } from "../lax-data-dir.js";
import { resolveMediaPath } from "./vision-tools.js";

const logger = createLogger("tools.file-delivery");

// Document types the phone can hand to a native viewer. Images/videos have
// their own tools (send_image/send_video); archives stay out — an opaque
// container is a poor egress surface and nothing on the phone opens it.
export const DOC_MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  pdf: "application/pdf",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  rtf: "application/rtf",
  json: "application/json",
};

/** The phone tunnel caps a response body at 8MB (http-tunnel-bridge MAX_BODY —
 *  oversize now 413s instead of truncating). Staging still succeeds above it so
 *  the web client can fetch, but the result warns the phone can't. */
const PHONE_LIMIT_MB = 8;
/** Hard cap — same ceiling as send_video's Telegram limit. */
const MAX_SIZE_MB = 50;

/** Staged name: short content hash + the sanitized original name. Keeps the
 *  extension (the phone's viewer routing needs it), stays unique per content,
 *  and passes /uploads' strict filename regex. */
export function stagedName(originalName: string, contentSha256Hex: string): string {
  const safe = originalName.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^[._-]+/, "");
  return `${contentSha256Hex.slice(0, 8)}-${safe || "file"}`;
}

export const sendFileTool: ToolDefinition = {
  name: "send_file",
  effect: { class: "non-idempotent" },
  description:
    "Send a document from this computer to the user's device — Word, Excel, PowerPoint, PDF, CSV, text. " +
    "Use when the user asks for a file that lives on this PC, especially from the AgentX mobile app: the file " +
    "is staged for secure pickup and appears in their chat as a tappable file card. " +
    `Supports ${Object.keys(DOC_MIME).join(", ")}. Files over ${PHONE_LIMIT_MB}MB can't be delivered to the phone.`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the document (absolute or relative)" },
      name: { type: "string", description: "Optional display name shown to the user (defaults to the file's name)" },
    },
    required: ["path"],
  },
  async execute(args) {
    const filePath = resolveMediaPath(String(args.path || ""));
    if (!existsSync(filePath)) return { content: `File not found: ${filePath}`, isError: true };

    const ext = filePath.split(".").pop()?.toLowerCase() || "";
    if (!(ext in DOC_MIME)) {
      return { content: `Unsupported document type: .${ext}. Supported: ${Object.keys(DOC_MIME).join(", ")}. For images use send_image; for videos use send_video.`, isError: true };
    }

    // Bind to the VALIDATED canonical inode (realpath + O_NOFOLLOW leaf), same
    // as send_video — a symlink swapped in after the gate is rejected here.
    let canonicalPath: string;
    let sizeBytes: number;
    try {
      const opened = openValidatedRead(filePath);
      try {
        sizeBytes = fstatSync(opened.fd).size;
      } finally {
        closeSync(opened.fd);
      }
      canonicalPath = opened.canonicalPath;
    } catch (e) {
      return { content: `Failed to send ${filePath}: ${(e as Error).message}`, isError: true };
    }
    const sizeMb = sizeBytes / 1048576;
    if (sizeMb > MAX_SIZE_MB) {
      return { content: `File is ${sizeMb.toFixed(1)}MB — over the ${MAX_SIZE_MB}MB delivery limit, can't send.`, isError: true };
    }

    // Stage a copy into the served uploads dir under a content-hashed name.
    // Hash the VALIDATED bytes (not the caller path) so the staged name binds
    // to the content the gate approved; identical content dedupes naturally.
    let servedRef: string;
    let stagedPath: string;
    const displayName = String(args.name || "").trim() || basename(canonicalPath);
    try {
      const bytes = readValidatedFile(canonicalPath);
      const sha = createHash("sha256").update(bytes).digest("hex");
      const staged = stagedName(basename(canonicalPath), sha);
      const uploadsDir = join(getLaxDir(), "uploads");
      mkdirSync(uploadsDir, { recursive: true });
      stagedPath = join(uploadsDir, staged);
      if (!existsSync(stagedPath)) copyFileSync(canonicalPath, stagedPath);
      servedRef = `/uploads/${staged}`;
    } catch (e) {
      return { content: `Failed to stage ${canonicalPath}: ${(e as Error).message}`, isError: true };
    }

    const sizeLabel = sizeMb >= 1 ? `${sizeMb.toFixed(1)}MB` : `${Math.max(1, Math.round(sizeBytes / 1024))}KB`;
    const phoneNote = sizeMb > PHONE_LIMIT_MB
      ? ` NOTE: over the ${PHONE_LIMIT_MB}MB phone-delivery limit — the mobile app can't download it; it's available on the desktop.`
      : "";
    logger.info(`[send_file] staged ${canonicalPath} → ${servedRef} (${sizeLabel})`);
    // The /uploads ref leads this text: the phone extracts it from the tool
    // result, and history projection truncates results to 500 chars.
    return {
      content: `Sent "${displayName}" (${sizeLabel}): ${servedRef} — it appears as a file card in the user's chat. Source: ${canonicalPath}.${phoneNote}`,
      _media: { kind: "file", path: stagedPath, mime: DOC_MIME[ext] as string, name: displayName },
    };
  },
};
