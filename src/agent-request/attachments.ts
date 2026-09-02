import { basename, join } from "node:path";
import { accessSync, constants as fsConstants, writeFileSync } from "node:fs";
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

/** Non-empty stand-in for an attachment whose bytes could not be read.
 *
 *  THE single definition of the note string. Both surfacing sites emit it
 *  byte-identically so the model has one vocabulary for the failure:
 *    - prepare-time (this module): a dangling non-image "/uploads/<f>" ref,
 *      surfaced once in the file-attachments prompt note;
 *    - request-time (canonical-loop/adapters/images-to-openai-parts.ts, the
 *      canonical image-row converter every provider transport funnels
 *      through): an image whose file cannot be read when the request is built.
 *  It lives HERE because the interface seal (canonical-loop/interface-seal
 *  .test.ts) bans this module from importing canonical-loop internals, while
 *  adapters may import outward.
 *
 *  Names the file (display name, else path basename) plus the errno code when
 *  there is one; never leaks the absolute path. */
export function unreadableAttachmentNote(
  ref: { name?: string; filePath?: string },
  err?: unknown,
): string {
  const label = ref.name || (ref.filePath ? basename(ref.filePath) : "image");
  const code =
    typeof err === "object" && err !== null && "code" in err && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : undefined;
  return `[Attachment ${label} could not be read${code ? ` (${code})` : ""}]`;
}

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
  const unreadable: string[] = [];

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
      if (a.isImage) {
        // Dangling image refs are NOT filtered here on purpose: the canonical
        // image-row converter (canonical-loop/adapters/images-to-openai-parts
        // .ts) reads the file at request time and, on failure, emits the SAME
        // unreadableAttachmentNote in-order inside the user message — the
        // single surfacing point for images. Checking + dropping here too
        // would either surface the failure twice or turn an image-only send
        // into an empty user row (the exact empty-text 400 class).
        images.push({ name: a.name, url: ref, filePath });
        continue;
      }
      // Non-image refs have NO downstream read — the model is handed the PATH
      // and told it is readable. A dangling "/uploads/<f>" ref (pruned uploads
      // dir, stale client url) used to flow through silently and 404 the
      // model's first tool call. Verify readability HERE and surface the
      // standard note once instead of claiming a readable path. Files decoded
      // from a dataUrl were written a few lines up, so this only ever fires
      // for pre-uploaded refs.
      try {
        accessSync(filePath, fsConstants.R_OK);
        fileAttachments.push({ name: a.name, ref });
      } catch (err) {
        unreadable.push(unreadableAttachmentNote({ name: a.name, filePath }, err));
      }
    }
  }

  const noteParts: string[] = [];
  if (fileAttachments.length) {
    noteParts.push(
      `\n\nThe user attached non-image file(s), saved and readable by your file tools. ` +
        `Pass the PATH (not the display name) to a tool such as \`pdf\` (read) or \`read\`:\n` +
        fileAttachments.map((f) => `- "${f.name}" → ${f.ref}`).join("\n"),
    );
  }
  if (unreadable.length) {
    noteParts.push(
      `\n\nSome attached file(s) could not be read from the uploads store — tell the user rather than guessing at their contents:\n` +
        unreadable.map((n) => `- ${n}`).join("\n"),
    );
  }
  const fileAttachmentNote = noteParts.join("");

  return { images, fileAttachments, fileAttachmentNote };
}
