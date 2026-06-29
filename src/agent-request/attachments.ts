import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

// ── Attachment → model-readable reference resolution ──
//
// Extracted from prepareAgentRequest so the rule "an uploaded file must end up
// readable by a file tool" is a tested unit, not inline logic that silently
// regressed (non-images were once dropped here, 404'ing every PDF/doc).
//
// Two upload shapes converge on the same on-disk `/uploads/<f>` form:
//   • Web: uploads first, sends a `/uploads/<f>` path in `url`.
//   • Mobile: no upload step — sends the bytes inline as a base64 `dataUrl`
//     (url:null); we decode that to a file so both land in the uploads dir.
//
// Images go to `images` (rendered into the message as image blocks). Non-image
// files go to `fileAttachments` + a system-prompt note that hands the model the
// `/uploads/<f>` PATH, because the user message shows only the friendly display
// name — and a file tool called with the display name resolves against the
// project root and 404s. resolveAgentPath maps `/uploads/<f>` back to the
// uploads dir, and the SecurityLayer gate resolves it the SAME way.

export interface RawAttachment {
  isImage: boolean;
  name: string;
  url?: string | null;
  dataUrl?: string | null;
}

export interface ProcessedAttachments {
  images: Array<{ url: string; filePath?: string; name: string }>;
  fileAttachments: Array<{ name: string; ref: string }>;
  /** Appended to the system prompt; "" when there are no non-image files. */
  fileAttachmentNote: string;
}

export function processAttachments(
  attachments: RawAttachment[] | undefined,
  uploadsDir: string | undefined,
): ProcessedAttachments {
  const images: ProcessedAttachments["images"] = [];
  const fileAttachments: ProcessedAttachments["fileAttachments"] = [];

  if (attachments && uploadsDir) {
    for (const a of attachments) {
      const inline = a.dataUrl ?? null;
      const src = (a.url as string | null) || inline;
      if (!src) continue;
      const dataMatch = /^data:([^;]+);base64,(.+)$/.exec(src);
      let ref: string;
      let filePath: string;
      if (dataMatch) {
        const ext = (dataMatch[1].split("/")[1] || "bin").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "bin";
        const fname = `att-${randomBytes(6).toString("hex")}.${ext}`;
        filePath = join(uploadsDir, fname);
        try {
          writeFileSync(filePath, Buffer.from(dataMatch[2], "base64"));
        } catch {
          continue; // unwritable upload dir — skip rather than fail the turn
        }
        ref = `/uploads/${fname}`;
      } else {
        const fname = src.replace(/^\/uploads\//, "");
        ref = `/uploads/${fname}`;
        filePath = join(uploadsDir, fname);
      }
      if (a.isImage) images.push({ name: a.name, url: ref, filePath });
      else fileAttachments.push({ name: a.name, ref });
    }
  }

  const fileAttachmentNote = fileAttachments.length
    ? `\n\nThe user attached non-image file(s), saved and readable by your file tools. ` +
      `Pass the PATH (not the display name) to a tool such as \`pdf\` (read) or \`read\`:\n` +
      fileAttachments.map((f) => `- "${f.name}" → ${f.ref}`).join("\n")
    : "";

  return { images, fileAttachments, fileAttachmentNote };
}
