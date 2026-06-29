import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { LAXConfig } from "../types.js";
import { setRuntimeConfig, uploadsDir } from "../config.js";
import { resolveAgentPath } from "../workspace/paths.js";
import { evaluateFileAccess } from "../security/file-access.js";
import { processAttachments } from "./attachments.js";

// ── END-TO-END CONTRACT (the guardrail that crosses the seam) ──
//
// An uploaded file of ANY type must survive the whole journey:
//   processAttachments → "/uploads/<f>" ref → resolveAgentPath → real on-disk
//   file, AND be ALLOWED by the SecurityLayer gate in workspace + common mode.
//
// This is the test that was missing. Each module (attachments, paths, security)
// had green unit tests while the SEAM between them broke twice — non-images
// dropped in prepare-request, then the gate's resolver drifting from the tool's.
// A per-module test can't catch a seam bug; this one goes red if ANY layer
// drifts. Types the user cares about are enumerated on purpose.
const FILE_TYPES = [
  { label: "pdf",  name: "invoice.pdf", isImage: false },
  { label: "docx", name: "report.docx", isImage: false },
  { label: "txt",  name: "notes.txt",   isImage: false },
  { label: "png",  name: "photo.png",   isImage: true  },
];

let laxDir: string;
let workspace: string;
let savedLaxDir: string | undefined;

beforeAll(() => {
  savedLaxDir = process.env.LAX_DATA_DIR;
  // realpath the temp roots so the gate's realpath'd target compares like-with-
  // like (macOS /tmp → /private/tmp would otherwise break containment).
  laxDir = realpathSync(mkdtempSync(join(tmpdir(), "attach-lax-")));
  process.env.LAX_DATA_DIR = laxDir;
  const wsRoot = realpathSync(mkdtempSync(join(tmpdir(), "attach-ws-")));
  workspace = join(wsRoot, "workspace");
  mkdirSync(workspace, { recursive: true });
  setRuntimeConfig({ workspace } as Partial<LAXConfig> as LAXConfig);
  mkdirSync(uploadsDir(), { recursive: true });
});

afterAll(() => {
  if (savedLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = savedLaxDir;
  rmSync(laxDir, { recursive: true, force: true });
});

describe("attachment read contract (upload → resolve → gate, every file type)", () => {
  for (const t of FILE_TYPES) {
    it(`${t.label}: an uploaded file is referenced, resolvable, and gate-readable`, () => {
      // 1. The upload route stored bytes at uploads/<name> and returned a
      //    "/uploads/<name>" url. Simulate the stored file.
      const onDisk = join(uploadsDir(), t.name);
      writeFileSync(onDisk, `${t.label}-bytes`);
      const attachment = { isImage: t.isImage, name: t.name, url: `/uploads/${t.name}`, dataUrl: null };

      // 2. prepare-request turns it into a model-facing reference.
      const { images, fileAttachments, fileAttachmentNote } = processAttachments([attachment], uploadsDir());
      const ref = t.isImage
        ? images.find((i) => i.name === t.name)!.url
        : fileAttachments.find((f) => f.name === t.name)!.ref;
      expect(ref).toBe(`/uploads/${t.name}`);
      if (!t.isImage) {
        // The PATH is handed to the model — the part that silently regressed.
        expect(fileAttachmentNote).toContain(`/uploads/${t.name}`);
        expect(fileAttachmentNote).toContain("Pass the PATH");
      }

      // 3. The file tool resolves that ref to the real, existing file.
      const resolved = resolveAgentPath(ref);
      expect(resolved).toBe(onDisk);
      expect(existsSync(resolved)).toBe(true);

      // 4. The SecurityLayer gate ALLOWS reading it — in the strictest modes.
      for (const mode of ["workspace", "common"] as const) {
        const d = evaluateFileAccess(workspace, mode, () => false, "read", ref);
        expect(d.allowed, `${t.label} read denied in ${mode} mode`).toBe(true);
      }
    });
  }

  it("a forged ../ ref cannot escape the uploads dir to the real data-dir auth.json", () => {
    // resolveAgentPath basename-confines the ref → uploads/auth.json (a file IN
    // uploads), never <LAX_DATA_DIR>/auth.json. The real secret stays unreachable.
    expect(resolveAgentPath("/uploads/../auth.json")).toBe(join(uploadsDir(), "auth.json"));
  });
});
